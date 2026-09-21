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

Let's say we want to prevent a specific application from opening files in a sensitive directory, like `/etc/shadow`, even if it has the necessary permissions. We'll write an eBPF program that attaches to `sys_openat` and checks the path being opened. If it matches our target, we'll return an error code, effectively blocking the operation.

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
    const char *pathname = (const char *)PT_REGS_PARM2(ctx); // arg2 of sys_openat is pathname

    // Read the user-space string into our kernel-space buffer
    // bpf_probe_read_user_str returns the length read or a negative error code
    long res = bpf_probe_read_user_str(&path_buf, sizeof(path_buf), pathname);

    if (res > 0) {
        // Example: Block access to /etc/shadow
        if (bpf_strncmp(path_buf, MAX_PATH_LEN, "/etc/shadow") == 0) {
            bpf_printk("eBPF: Blocking openat for /etc/shadow by PID %d\n", bpf_get_current_pid_tgid() >> 32);
            // Return -EPERM to block the syscall
            // This effectively changes the return value of the syscall for the user process
            PT_REGS_RC(ctx) = -EPERM;
            return 0; // Indicate successful eBPF program execution
        }
        // Example: Log attempts to open files in /tmp for a specific PID
        // u32 current_pid = bpf_get_current_pid_tgid() >> 32;
        // if (current_pid == <TARGET_PID> && bpf_strncmp(path_buf, MAX_PATH_LEN, "/tmp/") == 0) {
        //     bpf_printk("eBPF: PID %d attempting to open file in /tmp: %s\n", current_pid, path_buf);
        // }
    }

    return 0; // Allow the syscall to proceed normally
}

char _license[] SEC("license") = "GPL";
```

### Understanding the Code

1.  **`#include <vmlinux.h>`**: This header provides kernel types and definitions, generated by `bpftool btf dump file /sys/kernel/btf/vmlinux format c`.
2.  **`#include <bpf/bpf_helpers.h>` and `<bpf/bpf_tracing.h>`**: These provide eBPF helper functions and macros for tracing.
3.  **`SEC("kprobe/sys_openat")`**: This macro tells the eBPF loader to attach this program to the `sys_openat` kernel function as a `kprobe`.
4.  **`int kprobe_sys_openat(struct pt_regs *ctx)`**: This is our eBPF program function. `struct pt_regs *ctx` provides access to the CPU registers at the time of the `kprobe` hit.
5.  **`PT_REGS_PARM2(ctx)`**: This macro (from `bpf_tracing.h`) helps us extract the second argument of the `sys_openat` function. For `sys_openat(int dfd, const char *filename, int flags, umode_t mode)`, the second argument is `filename` (the path).
6.  **`bpf_probe_read_user_str(&path_buf, sizeof(path_buf), pathname)`**: This crucial helper function safely reads a string from user-space memory (where `pathname` resides) into our eBPF program's kernel-space buffer (`path_buf`). Direct dereferencing of user-space pointers from eBPF is not allowed for security reasons.
7.  **`bpf_strncmp(path_buf, MAX_PATH_LEN, "/etc/shadow") == 0`**: We compare the read path with our target sensitive path. `bpf_strncmp` is another eBPF helper for string comparison.
8.  **`PT_REGS_RC(ctx) = -EPERM;`**: This is the core of the interception. By modifying `PT_REGS_RC(ctx)` (which represents the return code register for the syscall), we effectively change the return value of the `sys_openat` call *before* it returns to user-space. Returning `-EPERM` (Permission denied) tells the calling process that the operation failed due to insufficient permissions.
9.  **`bpf_printk(...)`**: This helper allows us to print debug messages from our eBPF program, which can be viewed with `sudo cat /sys/kernel/debug/tracing/trace_pipe`.

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

### Testing the Interceptor

Now, try to open `/etc/shadow` as a normal user.

```bash
cat /etc/shadow
```

You should see:
```
cat: /etc/shadow: Permission denied
```

This is expected, as even `root` cannot read `/etc/shadow` directly with `cat` (it often requires specific shadow utilities). However, the key is that *our eBPF program* is now the one enforcing this, not the standard kernel permissions.

Let's try a benign file:
```bash
cat /etc/hosts
```
This should work normally, as our eBPF program only intercepts `/etc/shadow`.

To see the `bpf_printk` output from our program, tail the shared trace pipe in a separate terminal while you run the tests above:

```bash
sudo cat /sys/kernel/debug/tracing/trace_pipe
```

You should see a line logged for every blocked attempt at `/etc/shadow`, including the PID that made it.

### Cleaning Up

Once you're done, detach and remove the program so it doesn't keep intercepting syscalls on a system you're no longer actively testing on:

```bash
sudo bpftool link detach id <LINK_ID>
sudo rm /sys/fs/bpf/openat_blocker
```

Forgetting this step is a common source of confusion in eBPF demos — a pinned program under `/sys/fs/bpf` survives reboots on many systems and will keep silently enforcing a rule you've forgotten about.

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