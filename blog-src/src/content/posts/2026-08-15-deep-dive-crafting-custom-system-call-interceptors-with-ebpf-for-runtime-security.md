---
title: "Deep Dive: Crafting Custom System Call Interceptors with eBPF for Runtime Security"
date: 2026-08-15
category: "thought-leadership"
tags: ["ebpf", "linux", "security", "system-calls", "kernel", "runtime-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of Linux security, understanding and controlling system calls is paramount. System calls are the interface between user-space..."
---

In the realm of Linux security, understanding and controlling system calls is paramount. System calls are the interface between user-space applications and the kernel, enabling operations like file I/O, process creation, and network communication. Malicious activity often involves abusing or subverting these calls. While traditional methods like `ptrace` or kernel modules exist for interception, they come with significant overhead or stability concerns.

Enter eBPF (extended Berkeley Packet Filter). eBPF has revolutionized how we interact with the Linux kernel, providing a safe, programmable, and performant way to extend kernel functionality without modifying kernel source code or loading insecure modules. For runtime security, eBPF offers an unparalleled ability to observe, filter, and even *intercept* system calls with minimal impact.

This post will deep dive into crafting custom system call interceptors using eBPF, focusing on practical examples and the underlying mechanics. We'll build a simple program that monitors and optionally blocks specific `openat` calls, demonstrating the power of eBPF for fine-grained runtime security.

## The Mechanics: How eBPF Intercepts System Calls

eBPF programs don't run in a vacuum. They are attached to various *hook points* within the kernel. For system call interception, the most common and powerful hook points are `kprobes` (kernel probes) and `tracepoints`.

*   **`kprobes`**: These allow you to attach an eBPF program to virtually any instruction address in the kernel. For system calls, you can attach to the entry and exit points of a syscall function (e.g., `sys_openat`). This gives you full control and access to the syscall arguments.
*   **`tracepoints`**: These are predefined, stable hook points explicitly placed by kernel developers for tracing and monitoring. Many system calls have entry and exit tracepoints (e.g., `sys_enter_openat`, `sys_exit_openat`). While generally more stable across kernel versions than `kprobes`, they might expose a slightly different set of arguments or require more boilerplate to access them.

For our interception example, `kprobes` are ideal because they offer direct access to the system call arguments exactly as they are passed to the kernel function.

## Setting Up Our Environment

To follow along, you'll need a Linux system with a relatively recent kernel (4.9+ for basic eBPF, 5.x+ for more advanced features like BPF CO-RE). We'll use the `bpftool` utility and C for our eBPF program.

```bash
# Install necessary packages (Ubuntu/Debian example)
sudo apt update
sudo apt install clang llvm libelf-dev build-essential linux-headers-$(uname -r) bpftool
```

## Example: Intercepting `openat` Calls

Let's say we want visibility into which processes are trying to open files in a sensitive directory, like `/etc/shadow`. We'll write an eBPF program that attaches to `sys_openat`, checks the path being opened, and logs a detection event when it matches our target. A `kprobe` fires *before* the probed function runs, which makes it a natural fit for observation — but, as we'll get to below, it isn't the right tool for actually denying the open. For that, we'll turn to the BPF LSM once we've seen why.

### The eBPF C Program (`openat_blocker.c`)

```c
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// Define a maximum path length for our buffer
#define MAX_PATH_LEN 256

// Helper map to store blocked PIDs if needed, though not strictly required for this simple block
// struct {
//     __uint(type, BPF_MAP_TYPE_HASH);
//     __uint(max_entries, 1024);
//     __uint(key_size, sizeof(u32));
//     __uint(value_size, sizeof(bool));
// } blocked_pids SEC(".maps");

SEC("kprobe/sys_openat")
int kprobe_sys_openat(struct pt_regs *ctx) {
    char path_buf[MAX_PATH_LEN];

    // On x86_64 kernels built with CONFIG_ARCH_HAS_SYSCALL_WRAPPER (the
    // default since 4.17), the function we're probing takes a single
    // `struct pt_regs *` argument holding the *real* syscall registers —
    // PT_REGS_PARM2(ctx) on the outer kprobe context is not the pathname,
    // it's whatever happened to be in that register at the call site.
    // Unwrap the inner pt_regs first with PT_REGS_SYSCALL_REGS(), then
    // pull the syscall's own arguments out of that.
    struct pt_regs *real_regs = PT_REGS_SYSCALL_REGS(ctx);
    const char *pathname = (const char *)PT_REGS_PARM2(real_regs); // arg2 of sys_openat is pathname

    // Read the user-space string into our kernel-space buffer
    // bpf_probe_read_user_str returns the length read or a negative error code
    long res = bpf_probe_read_user_str(&path_buf, sizeof(path_buf), pathname);

    if (res > 0) {
        // Example: flag access attempts to /etc/shadow
        if (bpf_strncmp(path_buf, MAX_PATH_LEN, "/etc/shadow") == 0) {
            bpf_printk("eBPF: Detected openat for /etc/shadow by PID %d\n", bpf_get_current_pid_tgid() >> 32);
            // NOTE: this is a detection point, not an enforcement point.
            // A kprobe handler runs before the probed function executes,
            // and sys_openat will still run to completion regardless of
            // anything we do here — see "A Note on kprobes vs. the BPF
            // LSM for Enforcement" below for how to actually deny the open.
        }
        // Example: Log attempts to open files in /tmp for a specific PID
        // u32 current_pid = bpf_get_current_pid_tgid() >> 32;
        // if (current_pid == <TARGET_PID> && bpf_strncmp(path_buf, MAX_PATH_LEN, "/tmp/") == 0) {
        //     bpf_printk("eBPF: PID %d attempting to open file in /tmp: %s\n", current_pid, path_buf);
        // }
    }

    return 0;
}

char _license[] SEC("license") = "GPL";
```

### Understanding the Code

1.  **`#include <vmlinux.h>`**: This header provides kernel types and definitions, generated by `bpftool btf dump file /sys/kernel/btf/vmlinux format c`.
2.  **`#include <bpf/bpf_helpers.h>` and `<bpf/bpf_tracing.h>`**: These provide eBPF helper functions and macros for tracing.
3.  **`SEC("kprobe/sys_openat")`**: This macro tells the eBPF loader to attach this program to the `sys_openat` kernel function as a `kprobe`.
4.  **`int kprobe_sys_openat(struct pt_regs *ctx)`**: This is our eBPF program function. `struct pt_regs *ctx` provides access to the CPU registers at the time of the `kprobe` hit.
5.  **`PT_REGS_SYSCALL_REGS(ctx)` and `PT_REGS_PARM2(real_regs)`**: On kernels with the syscall wrapper enabled, the function we've probed doesn't receive `sys_openat`'s own arguments directly — it receives one argument, a pointer to a `struct pt_regs` holding the register state userspace passed into the syscall. `PT_REGS_SYSCALL_REGS()` (from `bpf_tracing.h`) unwraps that inner `pt_regs`, and *then* `PT_REGS_PARM2` on the result gives us the second logical argument to `sys_openat(int dfd, const char *filename, int flags, umode_t mode)` — `filename` (the path).
6.  **`bpf_probe_read_user_str(&path_buf, sizeof(path_buf), pathname)`**: This crucial helper function safely reads a string from user-space memory (where `pathname` resides) into our eBPF program's kernel-space buffer (`path_buf`). Direct dereferencing of user-space pointers from eBPF is not allowed for security reasons.
7.  **`bpf_strncmp(path_buf, MAX_PATH_LEN, "/etc/shadow") == 0`**: We compare the read path with our target sensitive path. `bpf_strncmp` is another eBPF helper for string comparison.
8.  **`bpf_printk(...)`**: When the path matches, we log a detection event, which can be viewed with `sudo cat /sys/kernel/debug/tracing/trace_pipe`. This is as far as a `kprobe` can take us: it's a pre-execution observation point, not a gate. Writing to `PT_REGS_RC(ctx)` here would *not* stop `sys_openat` from running — the kernel proceeds to execute the real function regardless of what a kprobe handler does to the registers. Actually overriding a probed function's return value requires the dedicated `bpf_override_return()` helper (gated behind `CONFIG_BPF_KPROBE_OVERRIDE` and the target function being marked `ALLOW_ERROR_INJECTION`), and even then the kernel maintainers consider it a debugging/fault-injection facility, not a production enforcement mechanism — which is exactly why the next section reaches for the BPF LSM instead.

### Compiling the eBPF Program

We'll use `clang` and `llvm` to compile our C code into an eBPF bytecode object file.

```bash
clang -target bpf -O2 -g -c openat_blocker.c -o openat_blocker.o \
    -I/usr/include/bpf -I/usr/include/linux \
    -D__KERNEL__ -D__BPF_TRACING__ \
    -Wno-unused-value -Wno-pointer-sign -Wno-compare-distinct-pointer-types
```

*   `-target bpf`: Specifies the BPF target architecture.
*   `-O2`: Optimization level.
*   `-g`: Include debug information (helpful for `bpftool` inspection).
*   `-c`: Compile only, do not link.
*   `-o openat_blocker.o`: Output object file.
*   `-I...`: Include paths for necessary headers.
*   `-D...`: Define preprocessor macros.

### Loading and Attaching the eBPF Program

Now, load the compiled object file into the kernel and attach it using `bpftool`.

```bash
sudo bpftool prog load openat_blocker.o /sys/fs/bpf/openat_blocker type kprobe
sudo bpftool link create prog_id <PROG_ID> attach kprobe event sys_openat
```

Replace `<PROG_ID>` with the ID of the loaded program, which `bpftool prog load` will output. For example, if it outputs `prog_id: 123`, then use `123`.

To verify:
```bash
sudo bpftool prog show
sudo bpftool link show
```

### Testing the Interceptor (Detection, Not Blocking)

Remember, this program only logs — it doesn't touch the syscall's outcome. `/etc/shadow`'s own file permissions (typically mode `0640`, owned by `root:shadow`) are still what stand between a normal user and the file, entirely independent of our eBPF program:

```bash
cat /etc/shadow
```

You should see the usual denial, which has nothing to do with our kprobe:
```
cat: /etc/shadow: Permission denied
```

To actually see our program do something, read the file as root, where the filesystem permission check passes and the open reaches `sys_openat`'s real implementation:

```bash
sudo cat /etc/shadow
```

The contents print normally — our kprobe never stood in the way of that. What it *did* do is log the attempt. Tail the shared trace pipe in a separate terminal while you run the command above:

```bash
sudo cat /sys/kernel/debug/tracing/trace_pipe
```

You should see a line logged for the `sudo cat /etc/shadow` invocation, including the PID that made it — confirmation that both the detection logic and the `PT_REGS_SYSCALL_REGS()` unwrapping are working. Try `cat /etc/hosts` as well: it should produce no matching log line, since our program only flags paths equal to `/etc/shadow`.

### Cleaning Up

Once you're done, detach and remove the program so it doesn't keep tracing syscalls on a system you're no longer actively testing on:

```bash
sudo bpftool link detach id <LINK_ID>
sudo rm /sys/fs/bpf/openat_blocker
```

Forgetting this step is a common source of confusion in eBPF demos — a pinned program under `/sys/fs/bpf` survives reboots on many systems and will keep silently logging accesses you've forgotten you're watching for.

## A Note on `kprobes` vs. the BPF LSM for Enforcement

Everything above works, and it's a great way to learn how syscall interception functions under the hood. But there's an important caveat for anything beyond a demo: `kprobes` attach to internal kernel function names and offsets, which are **not a stable ABI**. A kernel upgrade can rename, inline, or restructure `sys_openat` entirely, silently breaking (or worse, subtly misbehaving) any `kprobe`-based enforcement you've shipped.

For actual runtime *enforcement* — as opposed to observability and debugging — the Linux kernel provides a purpose-built mechanism: the **BPF LSM** (`BPF_PROG_TYPE_LSM`). Instead of hooking an internal function by name, you attach to a stable Linux Security Module hook, such as `file_open`, which is explicitly designed to be an enforcement point and is guaranteed to be called at the right place in the security-relevant code path:

```c
SEC("lsm/file_open")
int BPF_PROG(restrict_shadow_open, struct file *file) {
    // Compare file->f_path against the target path using bpf_d_path()
    // and return a negative errno to deny the open, or 0 to allow it.
    return 0;
}
```

The BPF LSM requires the kernel to be built with `CONFIG_BPF_LSM=y` and `bpf` listed in `/sys/kernel/security/lsm`, but in exchange you get a hook that's explicitly meant for exactly this use case, rather than one you're borrowing for a purpose it wasn't designed for.

## Conclusion

eBPF gives you a genuinely safe way to observe and, with the right hook, enforce policy deep inside the kernel without the crash risk of a hand-rolled kernel module or the overhead of `ptrace`. `kprobes` are the right tool for investigating and prototyping — they let you attach to almost anything, instantly, with no kernel changes — but for production enforcement, reach for the BPF LSM or a stable tracepoint instead, since your security control shouldn't be one kernel minor version away from silently going dark.