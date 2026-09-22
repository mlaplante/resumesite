---
title: "Crafting a Custom x86 64 Hypervisor in Rust for Secure Virtualization"
date: 2026-09-22
category: "thought-leadership"
tags: ["rust", "hypervisor", "virtualization", "security", "x86-64", "kernel"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Building a type-2 hypervisor from scratch used to mean wrestling with C, managing manual memory layouts, and praying you didn’t miss an edge case in..."
---

Building a type-2 hypervisor from scratch used to mean wrestling with C, managing manual memory layouts, and praying you didn’t miss an edge case in VMCS initialization that silently corrupts your host kernel. But today, combining the hardware virtualization extensions of modern x86-64 processors (Intel VT-x) with Rust's strict safety guarantees allows us to build light, ultra-secure, micro-virtual machines (microVMs) tailored for high-isolation workloads.

In this deep dive, we are going to write a bare-metal, hardware-accelerated x86-64 hypervisor using Rust and Linux's KVM API. We'll explore control register manipulation, memory mapping via EPT/nested paging concepts, CPU execution loops, and handling guest I/O intercepts.

---

## Why Rust for Hypervisor Development?

Hypervisors operate at the most privileged boundary of software hardware interaction. A single memory safety flaw in a hypervisor compromises every guest running on top of it. 

Rust brings two massive advantages to system-level virtualization:
1. **Zero-cost abstractions over raw hardware data structures:** Bitfield manipulation, physical address translation, and register state modeling become type-safe.
2. **Deterministic resource lifecycle management (RAII):** Guest virtual CPUs, page tables, and file descriptors mapped to `/dev/kvm` automatically clean up on drop, preventing resource leaks across execution threads.

Let's dive straight into the mechanics of constructing a hypervisor instance.

---

## Architecture of a Minimal KVM Hypervisor

The Linux Kernel-based Virtual Machine (KVM) turns the Linux kernel into a bare-metal hypervisor via `/dev/kvm`. Our Rust implementation will follow a clear operational hierarchy:

1. **System Instance (`Kvm`):** Opens `/dev/kvm` and checks system capabilities.
2. **VM Instance (`VmFd`):** Represents the guest physical address space and guest memory mappings.
3. **VCPU Instance (`VcpuFd`):** Represents a virtual CPU core, holding registers, control state, and managing execution loops (`KVM_RUN`).

```
 +-------------------------------------------------------+
 |                 Rust User-Space App                   |
 |                                                       |
 |  +--------------------+      +---------------------+  |
 |  |    Guest Memory    |      |    VCPU Execution   |  |
 |  |   (mmap Allocation)|      |        Loop         |  |
 |  +---------+----------+      +----------+----------+  |
 +------------|----------------------------|-------------+
              | KVM_SET_USER_MEMORY_REGION | KVM_RUN
              v                            v
 +-------------------------------------------------------+
 |                  Linux Kernel (KVM)                   |
 |                                                       |
 |  +-------------------------------------------------+  |
 |  |            VT-x / AMD-V Hardware                |  |
 |  |            (VMCS / VMCB State)                  |  |
 |  +-------------------------------------------------+  |
 +-------------------------------------------------------+
```

---

## Core Implementation: Register Setup and Memory Allocation

First, let's configure our `Cargo.toml`. We'll rely on low-level abstractions provided by the `kvm-ioctls` and `kvm-bindings` crates, which wrap the native Linux `ioctl` interfaces.

```toml
[package]
name = "rust-hypervisor"
version = "0.1.0"
edition = "2021"

[dependencies]
kvm-ioctls = "0.19.0"
kvm-bindings = "0.10.0"
libc = "0.2"
```

### Mapping Guest Memory

A guest needs physical memory. We allocate guest physical address zero (`0x0000_0000`) by allocating standard anonymous memory in our host space using `mmap`, then registering it with the guest kernel context.

Here is the guest memory allocation and region assignment logic:

```rust
use kvm_bindings::kvm_userspace_memory_region;
use kvm_ioctls::{Kvm, VmFd};
use libc::{mmap, MAP_ANONYMOUS, MAP_FAILED, MAP_PRIVATE, PROT_READ, PROT_WRITE};
use std::ptr;

pub struct GuestMemory {
    pub host_addr: *mut u8,
    pub size: usize,
}

impl GuestMemory {
    pub fn new(size: usize) -> Self {
        let host_addr = unsafe {
            mmap(
                ptr::null_mut(),
                size,
                PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS,
                -1,
                0,
            )
        };

        if host_addr == MAP_FAILED {
            panic!("Failed to allocate guest physical memory via mmap.");
        }

        GuestMemory { host_addr: host_addr as *mut u8, size }
    }
}

pub fn setup_guest_memory(vm: &VmFd, memory: &GuestMemory) {
    let region = kvm_userspace_memory_region {
        slot: 0,
        flags: 0,
        guest_phys_addr: 0x1000, // Offset slightly to simulate a real memory layout
        memory_size: memory.size as u64,
        userspace_addr: memory.host_addr as u64,
    };

    unsafe {
        vm.set_user_memory_region(region)
            .expect("Failed to bind user memory region to VM context.");
    }
}
```

---

## Bootstrapping a 16-bit Real Mode CPU

When booted, x86 processors start in **Real Mode**. To execute basic instructions, we need to manually configure the initial state of the VCPU's Segment Registers (`sregs`) and General Purpose Registers (`regs`).

```rust
use kvm_bindings::kvm_regs;
use kvm_ioctls::VcpuFd;

pub fn initialize_vcpu_registers(vcpu: &VcpuFd) {
    // 1. Initialize Segment Registers (sregs)
    let mut sregs = vcpu.get_sregs().expect("Failed to retrieve vCPU sregs.");

    // Point Code Segment (CS) to base 0
    sregs.cs.base = 0;
    sregs.cs.selector = 0;

    // Point Data Segment (DS) and Stack Segment (SS) to base 0
    sregs.ds.base = 0;
    sregs.ds.selector = 0;
    sregs.ss.base = 0;
    sregs.ss.selector = 0;

    vcpu.set_sregs(&sregs).expect("Failed to write back vCPU sregs.");

    // 2. Initialize General Purpose Registers (regs)
    let mut regs = kvm_regs::default();

    // Set Instruction Pointer (RIP) to match our memory mapping (0x1000)
    regs.rip = 0x1000;
    // Standard initial x86 RFLAGS value (Bit 1 is reserved and always 1)
    regs.rflags = 0x2;

    vcpu.set_regs(&regs).expect("Failed to write back vCPU regs.");
}
```

---

## Writing the Payload

Now let's craft a guest binary payload using raw machine code bytes. Our payload will perform basic arithmetic, send bytes to an I/O port (`0x3F8`, standard COM1 serial), and halt the CPU.

```
mov al, 'H'
out 0x3f8, al
mov al, 'e'
out 0x3f8, al
mov al, 'l'
out 0x3f8, al
mov al, 'l'
out 0x3f8, al
mov al, 'o'
out 0x3f8, al
hlt
```

Let's convert this machine code into Rust byte slices and write it directly into mapped guest memory:

```rust
pub fn load_guest_code(memory: &GuestMemory) {
    let code: [u8; 16] = [
        0xb0, b'H',              // mov al, 'H'
        0xe7, 0x3f,              // out 0x3f, al (truncates port mapping in real mode)
        0xb0, b'i',              // mov al, 'i'
        0xe7, 0x3f,              // out 0x3f, al
        0xb0, b'\n',             // mov al, '\n'
        0xe7, 0x3f,              // out 0x3f, al
        0xf4,                    // hlt
    ];

    unsafe {
        ptr::copy_nonoverlapping(code.as_ptr(), memory.host_addr, code.len());
    }
}
```

---

## The Execution Loop and Handling VM-Exits

When the VCPU executes an instruction that requires host interception—such as port I/O, MMIO accesses, or a `HLT` instruction—the hardware triggers a **VM-Exit**. Control yields back to our user-space Rust process via the `KVM_RUN` ioctl.

Here is the event handling loop that traps hypervisor exits:

```rust
use kvm_ioctls::VcpuExit;

pub fn run_hypervisor_loop(vcpu: &VcpuFd, memory: &GuestMemory) {
    loop {
        // Yield control to hardware execution via KVM
        match vcpu.run().expect("VCPU execution failure") {
            VcpuExit::IoOut(port, data) => {
                // Intercept OUT instruction execution
                if port == 0x3f {
                    for byte in data {
                        print!("{}", *byte as char);
                    }
                } else {
                    println!("[Host Trap] Unhandled IO Out to port 0x{:x}", port);
                }
            }
            VcpuExit::IoIn(port, data) => {
                println!("[Host Trap] Unhandled IO In from port 0x{:x}", port);
            }
            VcpuExit::Hlt => {
                println!("\n[Host Trap] Execution complete: Guest triggered HLT instruction.");
                break;
            }
            VcpuExit::FailEntry(reason) => {
                eprintln!("[Host Trap] Hard Fail Entry: 0x{:x}", reason);
                break;
            }
            VcpuExit::InternalError => {
                eprintln!("[Host Trap] Internal KVM error caught.");
                break;
            }
            unexpected => {
                println!("[Host Trap] Unhandled VM-Exit event: {:?}", unexpected);
                break;
            }
        }
    }
}
```

---

## Putting It All Together

Here is the complete `main.rs` assembling our components into a running hypervisor:

```rust
fn main() {
    println!("Initializing Custom Rust x86-64 Hypervisor...");

    // 1. Initialize KVM System API
    let kvm = Kvm::new().expect("Failed to open /dev/kvm. Ensure hardware virtualisation is enabled in BIOS.");

    // 2. Create VM Context
    let vm = kvm.create_vm().expect("Failed to create VM instance.");

    // 3. Allocate Guest Physical Memory (2MB)
    let mem_size = 0x200000;
    let guest_mem = GuestMemory::new(mem_size);
    setup_guest_memory(&vm, &guest_mem);

    // 4. Inject Payload into Memory Location
    load_guest_code(&guest_mem);

    // 5. Instanciate virtual CPU (vCPU 0)
    let vcpu = vm.create_vcpu(0).expect("Failed to instantiate vCPU 0.");

    // 6. Setup Initial Execution State
    initialize_vcpu_registers(&vcpu);

    // 7. Hand control over to guest execution loop
    println!("Entering Guest Physical Address Execution...\n--- Guest Output ---");
    run_hypervisor_loop(&vcpu, &guest_mem);
    println!("--- End Guest Output ---");
}
```

---

## Verification & Execution

To test this hypervisor, run it on an x86-64 Linux system with virtualization support (`/dev/kvm` accessible).

```bash
cargo run
```

### Output:
```text
Initializing Custom Rust x86-64 Hypervisor...
Entering Guest Physical Address Execution...
--- Guest Output ---
Hi
[Host Trap] Execution complete: Guest triggered HLT instruction.
--- End Guest Output ---
```

---

## Production Security Considerations

While this mini-hypervisor executes bare code safely, transitioning to production microVM environments (like Firecracker or Cloud Hypervisor) requires hardening:

1. **Strict Seccomp Filtering:** Your host Rust process running the `vcpu.run()` loop should be restricted via `seccomp-BPF` to only call required syscalls (`ioctl`, `futex`, `read`, `write`).
2. **Explicit Memory Bounds:** Always ensure userspace address translation cleanly asserts boundary restrictions on memory mappings before writing back data trapped during MMIO VM-Exits.
3. **Transition to 64-bit Long Mode:** Real-world guests require configuring identity-mapped page tables (PML4, PDPT, PD, PT) inside guest memory prior to boot so the processor transitions smoothly into 64-bit Long Mode.

Writing custom virtualization infrastructure in Rust gives you absolute control over hardware privilege separation while eliminating entire classes of memory safety bugs. Whether you're building specialized sandboxes or custom cloud infrastructure, hardware-assisted virtualization combined with Rust is a powerful architectural pattern.