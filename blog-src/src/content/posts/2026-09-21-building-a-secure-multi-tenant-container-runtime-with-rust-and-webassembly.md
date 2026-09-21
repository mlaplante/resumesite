---
title: "Building a Secure Multi-Tenant Container Runtime with Rust and WebAssembly"
date: 2026-09-21
category: "thought-leadership"
tags: ["rust", "webassembly", "containerization", "security", "multi-tenancy", "runtime"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "The promise of serverless functions and edge computing often hinges on the ability to run untrusted code securely and efficiently. While traditional..."
---

The promise of serverless functions and edge computing often hinges on the ability to run untrusted code securely and efficiently. While traditional container runtimes like containerd or CRI-O provide robust isolation for many use cases, their reliance on OS-level virtualization can introduce overhead and a larger attack surface than strictly necessary for certain workloads. For highly specialized, multi-tenant environments where fine-grained control and minimal footprint are paramount, we can explore an alternative: crafting a secure container runtime from scratch using Rust and WebAssembly (Wasm).

This isn't about replacing Docker or Kubernetes for general-purpose application deployment. Instead, consider scenarios like:

*   **Edge Function-as-a-Service (FaaS):** Running user-defined functions on resource-constrained edge devices with strict security requirements.
*   **Embedded Systems with Extensibility:** Allowing third-party plugins or scripts in a highly controlled environment.
*   **Secure Plugin Architectures:** Safely executing untrusted code within a larger application without full VM overhead.

Rust provides the memory safety and low-level control needed for a secure foundation, while WebAssembly offers a sandboxed, portable, and performant execution environment. Let's break down the core components and considerations.

## The Core Idea: Rust as the Host, Wasm as the Guest

At a high level, our runtime will consist of:

1.  **A Rust Host Application:** This will manage the lifecycle of Wasm modules, provide capabilities to the guests (e.g., I/O, network access), and enforce resource limits.
2.  **WebAssembly Modules:** These are the "containers" where untrusted user code runs. They are compiled from various languages (Rust, C/C++, Go, TypeScript via AssemblyScript) into a highly sandboxed binary format.

The beauty of Wasm is its "capability-based security" model. A Wasm module, by default, has *no* access to the host system. All interactions must be explicitly granted and proxied by the host. This is a significant advantage over traditional containers, where the kernel interface itself can be a source of vulnerabilities if not carefully managed (e.g., seccomp profiles).

## Step 1: Setting up the Rust Host with a Wasm Runtime

We'll use a Rust-based Wasm runtime. `wasmtime` is an excellent choice, providing a secure, performant, and standards-compliant Wasm engine.

First, add `wasmtime` to your `Cargo.toml`:

```toml
[dependencies]
wasmtime = "20.0.0"
anyhow = "1.0" # For easy error handling
```

Now, let's create a basic host that can load and execute a Wasm module.

```rust
use anyhow::{Result, anyhow};
use wasmtime::*;

/// Defines the host state that will be available to the Wasm module.
#[derive(Default)]
struct HostState {
    log_buffer: Vec<String>,
}

impl HostState {
    fn push_log_entry(&mut self, entry: String) {
        self.log_buffer.push(entry);
    }
}

fn main() -> Result<()> {
    // 1. Create a Wasmtime Engine
    // The Engine compiles and caches Wasm modules.
    let engine = Engine::default();

    // 2. Create a Wasmtime Store
    // The Store holds the state of the Wasm module and the host.
    // It's also where we attach our HostState.
    let mut store = Store::new(&engine, HostState::default());

    // 3. Define a Wasm module (e.g., from a file or byte array)
    // For this example, let's assume we have a simple Wasm module
    // that exports a function called `run_task` that takes no args and returns nothing.
    // In a real scenario, you'd load this from a user-provided file.
    let wasm_bytes = include_bytes!("../guest/target/wasm32-wasi/release/guest.wasm");
    let module = Module::new(&engine, wasm_bytes)?;

    // 4. Create a WASI (WebAssembly System Interface) context
    // This provides basic system calls like file I/O, environment variables, etc.
    // Crucially, we control what access is granted here.
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::add_to_linker(&mut linker, |s| s)?; // Add WASI functions

    // 5. Define a custom host function that the Wasm module can call.
    // This demonstrates how the host can expose capabilities.
    linker.func_wrap("host_api", "log_message", |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> Result<()> {
        let (memory, data) = caller.data_and_store_mut();
        let memory = memory.get_export(&mut caller, "memory")
                           .ok_or_else(|| anyhow!("failed to find host memory"))?
                           .into_memory()
                           .ok_or_else(|| anyhow!("failed to get host memory"))?;

        let msg_slice = &memory.data(&caller)[ptr as usize..(ptr + len) as usize];
        let msg = String::from_utf8_lossy(msg_slice).into_owned();
        data.push_log_entry(format!("[Wasm Guest] {}", msg));
        println!("[Host] Logged message from guest: {}", msg);
        Ok(())
    })?;


    // 6. Instantiate the module
    let instance = linker.instantiate(&mut store, &module)?;

    // 7. Get and call an exported function from the Wasm module
    let run_task = instance
        .get_typed_func::<(), (), _>(&mut store, "run_task")?;

    println!("[Host] Invoking Wasm guest function...");
    run_task.call(&mut store, ())?;
    println!("[Host] Wasm guest function finished.");

    // Access the state modified by the Wasm guest
    let host_state = store.data();
    println!("[Host] Collected logs from guest: {:?}", host_state.log_buffer);

    Ok(())
}
```

## Step 2: Crafting the Wasm Guest Module (Rust Example)

For the guest module, we'll write some Rust code that compiles to Wasm. This code will call our custom host function.

Create a new Rust library project: `cargo new --lib guest`.
Add `wasm-bindgen` and `wee_alloc` (for smaller binaries) to `guest/Cargo.toml`:

```toml
[package]
name = "guest"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"] # Crucial for Wasm output

[dependencies]
wasm-bindgen = "0.2.92"

[dev-dependencies]
wee_alloc = { version = "0.4.5", features = ["critical-section"] }
```

Now, the guest code (`guest/src/lib.rs`):

```rust
use wasm_bindgen::prelude::*;

// Allocate a global allocator for smaller Wasm binaries
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// Define the host function signature that we expect to call
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = "log_message", module = "host_api")]
    fn host_log_message(ptr: *const u8, len: usize);
}

// Helper to send a string to the host
fn log_to_host(message: &str) {
    let bytes = message.as_bytes();
    host_log_message(bytes.as_ptr(), bytes.len());
}

#[wasm_bindgen]
pub fn run_task() {
    log_to_host("Hello from the Wasm guest!");
    log_to_host("This is a multi-tenant function running securely.");
    // Simulate some work
    for i in 0..5 {
        log_to_host(&format!("Guest doing work, iteration {}", i));
    }
}
```

Compile the guest module:

```bash
cd guest
cargo build --target wasm32-wasi --release
```

This will produce `guest/target/wasm32-wasi/release/guest.wasm`. Copy this `guest.wasm` file to the root of your host project, or adjust the `include_bytes!` path.

## Step 3: Multi-Tenancy and Isolation

Now that we have a basic execution flow, let's address multi-tenancy and isolation.

### Instance-Level Isolation

Each Wasm module instance created from `linker.instantiate` has its own isolated memory space. This is a fundamental security feature of Wasm. One tenant's module cannot directly access another's memory.

To run multiple tenants, you would simply create a new `Store` and `Instance` for each tenant. Each `Store` would have its own `HostState`.

```rust
// ... (engine setup as before) ...

fn run_tenant(engine: &Engine, module_bytes: &[u8], tenant_id: &str) -> Result<()> {
    let mut store = Store::new(engine, HostState::default());
    let module = Module::new(engine, module_bytes)?;

    let mut linker = Linker::new(engine);
    wasmtime_wasi::add_to_linker(&mut linker, |s| s)?;

    // Custom host functions can be tenant-aware
    linker.func_wrap("host_api", "log_message", move |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> Result<()> {
        let (memory, data) = caller.data_and_store_mut();
        let memory = memory.get_export(&mut caller, "memory")
                           .ok_or_else(|| anyhow!("failed to find host memory"))?
                           .into_memory()
                           .ok_or_else(|| anyhow!("failed to get host memory"))?;

        let msg_slice = &memory.data(&caller)[ptr as usize..(ptr + len) as usize];
        let msg = String::from_utf8_lossy(msg_slice).into_owned();
        data.push_log_entry(format!("[Tenant {}] {}", tenant_id, msg)); // Tenant-specific logging
        println!("[Host - Tenant {}] Logged message from guest: {}", tenant_id, msg);
        Ok(())
    })?;

    let instance = linker.instantiate(&mut store, &module)?;
    let run_task = instance.get_typed_func::<(), (), _>(&mut store, "run_task")?;

    println!("[Host] Invoking Wasm guest function for Tenant {}...", tenant_id);
    run_task.call(&mut store, ())?;
    println!("[Host] Wasm guest function finished for Tenant {}.", tenant_id);

    let host_state = store.data();
    println!("[Host] Collected logs for Tenant {}: {:?}", tenant_id, host_state.log_buffer);

    Ok(())
}

fn main() -> Result<()> {
    let engine = Engine::default();
    let wasm_bytes = include_bytes!("../guest/target/wasm32-wasi/release/guest.wasm");

    run_tenant(&engine, wasm_bytes, "TenantA")?;
    run_tenant(&engine, wasm_bytes, "TenantB")?;

    Ok(())
}
```

### Resource Limits

Wasmtime allows setting limits on memory and CPU.

**Memory Limits:**
You can limit the maximum memory a Wasm module can allocate.

```rust
// In your Store creation
let mut store = Store::new(&engine, HostState::default());

// Set a memory limit (e.g., 64MB)
store.limiter(|s| s.memory_limiter(|_| Some(64 * 1024 * 1024)));
```

**CPU Limits (Timeouts):**
Wasmtime can also enforce execution timeouts. This is crucial for preventing runaway computations.

```rust
use std::time::Duration;

// In your Store creation
let mut store = Store::new(&engine, HostState::default());

// Set a timeout for the Wasm execution (e.g., 5 seconds)
// This requires `wasmtime::Config` for the engine.
let mut config = Config::new();
config.epoch_interruption(true); // Enable epoch interruption

let engine = Engine::new(&config)?; // Create engine with this config

// ... later, before calling the Wasm function ...
store.set_epoch_deadline(1); // Set the deadline to 1 epoch.
// You need to periodically increment the epoch on the engine for this to work.
// This is typically done in a separate thread.
let epoch_thread = std::thread::spawn(move || {
    for i in 0.. {
        std::thread::sleep(Duration::from_secs(1)); // Increment epoch every second
        engine.increment_epoch();
        println!("Epoch incremented to {}", i + 1);
    }
});

// If the guest exceeds the epoch deadline, the call will return an error.
let result = run_task.call(&mut store, ());
if let Err(e) = result {
    if let Some(trap) = e.downcast_ref::<Trap>() {
        if trap.trap_code() == Some(TrapCode::Interrupt) {
            println!("[Host] Wasm guest for Tenant {} timed out!", tenant_id);
        } else {
            println!("[Host] Wasm guest for Tenant {} failed: {:?}", tenant_id, e);
        }
    } else {
        println!("[Host] Wasm guest for Tenant {} failed with non-trap error: {:?}", tenant_id, e);
    }
}
// epoch_thread.join().unwrap(); // In a real app, manage this thread lifecycle
```

### Capability-Based Security (I/O, Network)

The `wasmtime-wasi` crate provides a default set of WASI capabilities. For multi-tenant environments, you'll want to heavily restrict these or provide your own custom host functions.

For example, to limit file system access for a tenant:

```rust
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder};
use std::path::PathBuf;
use std::fs;

// For a tenant, create a specific directory they can access
let tenant_dir = format!("./tenant_data/{}", tenant_id);
fs::create_dir_all(&tenant_dir)?; // Ensure directory exists

let wasi = WasiCtxBuilder::new()
    .inherit_stdout()
    .inherit_stderr()
    // Map a virtual path "/sandbox" to the tenant's specific directory
    .preopened_dir(Dir::open_ambient_dir(&tenant_dir, ambient_authority())?, "/sandbox")?
    .build();

// Then, when creating the Store:
let mut store = Store::new(engine, HostState::default());
store.data_mut().wasi = wasi; // Assuming HostState has a `wasi: WasiCtx` field

// And in the linker:
wasmtime_wasi::add_to_linker(&mut linker, |s| &mut s.wasi)?;
```

Now, the Wasm module can only access files within `/sandbox`, which maps to its dedicated host directory. Any attempt to access `/etc/passwd` or other arbitrary paths will fail at the host level.

For network access, you would typically *not* grant direct socket access via WASI. Instead, you'd expose specific HTTP client functions as host functions that proxy requests through your host application, allowing you to enforce strict firewall rules, rate limits, and authentication on behalf of the tenant.

## Conclusion and Next Steps

Building a secure multi-tenant container runtime with Rust and WebAssembly offers an unparalleled level of control and isolation, making it ideal for specialized FaaS, plugin systems, and edge computing. We've covered:

*   **Rust as the Secure Host:** Leveraging Rust's memory safety and `wasmtime` for robust execution.
*   **Wasm as the Sandboxed Guest:** Providing portable, capability-based security.
*   **Multi-Tenancy:** Isolating tenants with separate Wasm stores and host states.
*   **Resource Management:** Implementing memory and CPU limits.
*   **Fine-Grained Capability Control:** Restricting file system and network access.

This is just the beginning. A production-grade runtime would also require:

*   **Advanced Resource Scheduling:** Managing multiple tenants across available CPU cores.
*   **Snapshotting and Resumption:** For fast function cold starts.
*   **Observability:** Metrics, logging, and tracing integration.
*   **Module Management:** Securely storing, loading, and updating Wasm modules.
*   **API Gateway:** For incoming requests to tenant functions.
*   **Billing and Usage Tracking:** Based on resource consumption.

By taking this hands-on approach, you gain deep insight into the security primitives at play and can tailor the execution environment precisely to your application's needs, creating a truly robust and secure multi-tenant system. The combination of Rust's safety guarantees and WebAssembly's inherent sandboxing capabilities makes for a compelling foundation for the next generation of secure, high-performance distributed systems.