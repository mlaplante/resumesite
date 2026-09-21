---
title: "Crafting a Custom Linux Capabilities Manager with libcap and eBPF for Fine-Grained Process Security"
date: 2026-09-13
category: "thought-leadership"
tags: ["linux", "capabilities", "libcap", "ebpf", "security", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of Linux security, the principle of least privilege is paramount. While traditional Unix permissions (uid, gid) offer a coarse-grained..."
---

In the realm of Linux security, the principle of least privilege is paramount. While traditional Unix permissions (`uid`, `gid`) offer a coarse-grained approach, Linux capabilities provide a much finer level of control, allowing us to grant specific privileges to processes without elevating them to full root. However, managing these capabilities effectively, especially in complex environments, can still be a challenge.

What if we could create a dynamic, highly granular system to manage and even restrict capabilities at a runtime level, beyond what standard file capabilities or process `exec` time settings allow? This is where the powerful combination of `libcap` for capability manipulation and eBPF for runtime policy enforcement comes into play.

Today, we're going to explore how to build a custom capabilities manager. This isn't about replacing `setcap` but augmenting it, providing a mechanism to enforce policies or even perform real-time auditing of capability usage based on process context.

## The Problem with Static Capabilities

Let's say you have an application that needs `CAP_NET_BIND_SERVICE` to bind to a low port (e.g., 80 or 443). You can set this capability on the executable using `setcap`:

```bash
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/my_web_server
```

This works great. But what if `my_web_server` also includes a diagnostic utility that, if compromised, could be abused with `CAP_NET_BIND_SERVICE`? Or what if you want to restrict *when* and *how* that capability can be used? Static capabilities are all-or-nothing at execution time.

Our goal is to create a system that can:
1.  **Dynamically audit capability changes:** See when a process tries to gain or drop a capability.
2.  **Enforce custom policies:** Prevent certain capabilities from being used by specific processes or under specific conditions.
3.  **Provide real-time visibility:** Understand the capability landscape of our running system.

## Introducing `libcap` and `CAP_SETPCAP`

`libcap` is the userspace library for managing capabilities. It provides a straightforward API to manipulate capability sets (Permitted, Effective, Inheritable, Bounding, Ambient).

A crucial capability for our manager is `CAP_SETPCAP`. A process with `CAP_SETPCAP` can manipulate the capabilities of *other* processes. This is what our manager will need to dynamically adjust capabilities.

Let's start with a simple C program using `libcap` to demonstrate capability manipulation.

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/capability.h>
#include <errno.h>

void print_caps(const char *msg) {
    cap_t caps = cap_get_proc();
    if (caps == NULL) {
        perror("cap_get_proc");
        exit(EXIT_FAILURE);
    }
    char *cap_text = cap_to_text(caps, NULL);
    if (cap_text == NULL) {
        perror("cap_to_text");
        cap_free(caps);
        exit(EXIT_FAILURE);
    }
    printf("%s: %s\n", msg, cap_text);
    cap_free(caps);
    cap_free(cap_text);
}

int main() {
    print_caps("Initial capabilities");

    // Try to add CAP_NET_BIND_SERVICE to our own process
    // This will likely fail if we don't have CAP_SETPCAP or are not root
    cap_t caps = cap_get_proc();
    if (caps == NULL) {
        perror("cap_get_proc");
        return EXIT_FAILURE;
    }

    cap_value_t cap_list[1] = { CAP_NET_BIND_SERVICE };
    if (cap_set_flag(caps, CAP_EFFECTIVE, 1, cap_list, CAP_SET) == -1) {
        perror("cap_set_flag (add)");
        cap_free(caps);
        return EXIT_FAILURE;
    }

    if (cap_set_proc(caps) == -1) {
        perror("cap_set_proc (add)");
        // This is expected to fail if we don't have CAP_SETPCAP or aren't root
        // or if CAP_NET_BIND_SERVICE isn't in our Permitted set.
        // It's a good demonstration of why dynamic management is tricky.
    } else {
        printf("Successfully added CAP_NET_BIND_SERVICE (unlikely without CAP_SETPCAP).\n");
    }
    cap_free(caps);

    print_caps("Capabilities after attempted add");

    // Now, let's simulate a manager's task:
    // If we had CAP_SETPCAP, we could set capabilities for another process.
    // For this example, we'll just demonstrate setting our own capabilities again.
    // To actually set another process's capabilities, you'd use cap_set_pid()
    // and would need CAP_SETPCAP in your effective set.

    return EXIT_SUCCESS;
}
```

Compile with: `gcc -o cap_test cap_test.c -lcap`

Run it: `./cap_test`

You'll likely see something like:
```
Initial capabilities: =
cap_set_flag (add): Operation not permitted
Capabilities after attempted add: =
```

This demonstrates that a process cannot simply grant itself new capabilities unless it already has `CAP_SETPCAP` or the capability is already in its Permitted set. Our manager *will* need `CAP_SETPCAP`.

## The eBPF Hook: Monitoring `cap_set_proc` and `cap_set_pid`

To create a *dynamic* manager, we need to intercept capability changes. This is where eBPF shines. We can attach eBPF programs to kernel tracepoints or kprobes that are called whenever capabilities are manipulated.

Specifically, we're interested in functions like `cap_set_proc` (for a process modifying its own capabilities) and `cap_set_pid` (for a process modifying another process's capabilities). These functions are typically called when `libcap`'s `cap_set_proc()` or `cap_set_pid()` are invoked, or by other kernel subsystems.

Let's outline an eBPF program that monitors calls to `cap_set_proc`.

### eBPF Program (in C for `bcc` or `libbpf`)

```c
#include <uapi/linux/ptrace.h>
#include <linux/sched.h>
#include <linux/cap.h>
#include <linux/security.h> // For cap_set_proc arguments

// Define an event structure to send data to userspace
struct cap_event {
    pid_t pid;
    uid_t uid;
    int target_pid; // PID whose capabilities are being changed (if cap_set_pid)
    int capability; // The specific capability being acted upon (if applicable)
    __u32 old_effective;
    __u32 new_effective;
    char comm[TASK_COMM_LEN];
};

BPF_PERF_OUTPUT(cap_events);

// Kprobe on security_cap_settime
// This is a good general hook for capability changes.
// The specific arguments depend on the kernel version and exact function.
// For simplicity, let's target the security_cap_settime hook which is
// called when capabilities are updated.
// NOTE: Finding the *exact* right kprobe/tracepoint for all capability changes
// can be tricky and kernel version dependent. `security_cap_settime`
// or `cap_set_proc` / `cap_set_pid` are good candidates.
//
// For this example, let's assume we're hooking `cap_set_proc`
// The actual kernel function might be `cap_set_proc` or a security hook
// like `security_cap_settime` that gets called *before* the change.
// We'll simulate arguments for `cap_set_proc` for clarity.

// Kprobe at the entry of `cap_set_proc`
int kprobe__cap_set_proc(struct pt_regs *ctx, struct kernel_cap_struct *new_caps) {
    struct cap_event event = {};
    event.pid = bpf_get_current_pid_tgid() >> 32;
    event.uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    bpf_get_current_comm(&event.comm, sizeof(event.comm));

    // In a real scenario, you'd extract old capabilities from the current task
    // and new capabilities from `new_caps`. This requires more advanced BPF
    // capabilities to read kernel structures safely.
    // For demonstration, let's just log the attempt.

    // Example of reading effective capability (simplified)
    // This would need to read `current->cred->cap_effective`
    // and then the `new_caps` struct.
    // Reading kernel structs requires careful pointer dereferencing in BPF.

    // Minimal example: just log the event
    // In a real program, you'd iterate through capability bits or
    // compare old and new capability sets.
    
    // As a simple example, let's assume we are interested in CAP_NET_BIND_SERVICE
    // and we want to prevent a non-root process from gaining it.
    // This is a simplified check.
    
    // To get the actual new capabilities, we'd need to dereference `new_caps`
    // and potentially `current->cred` for old caps. This is complex in a general kprobe.
    // A better approach might be a tracepoint that provides these arguments directly.

    // Let's assume `new_caps` points to the new capability struct
    // and we can read its effective set.
    // This is a simplified example.
    // The `kernel_cap_struct` itself is not directly passed to `cap_set_proc` in this way.
    // Instead, it's typically `struct cred *new` and `const struct cred *old`.
    // The `kernel_cap_struct` is inside `struct cred`.

    // For a more practical example, let's hook a tracepoint that gives us
    // more direct access to relevant data. `security_cap_settime` is a good candidate.
    // Or we could use a raw kprobe on `cap_set_proc` and carefully read `current->cred`.
    
    // For demonstration purposes, we'll just log the PID and command.
    // A full implementation would involve reading `struct cred` from `current`
    // and diffing its capability sets against `new_caps`. We'll skip that here
    // and just emit the event so userspace can see that a change was attempted.

    cap_events.perf_submit(ctx, &event, sizeof(event));
    return 0;
}
```

This gets us visibility, but notice how much of the comment block above is hedging. Kprobes on internal functions like `cap_set_proc` are attached to an unstable, non-ABI-guaranteed symbol — the exact function name and argument layout can change between kernel versions, and a kprobe can only *observe* the call, not safely veto it. For an auditing tool, that's fine. For a manager that needs to actually *enforce* policy, we need something better.

## Enforcing Policy with BPF LSM

This is where the BPF LSM comes in. Since Linux 5.7, with a kernel built with `CONFIG_BPF_LSM=y` and `bpf` included in the `lsm=` boot parameter (alongside whatever LSMs you already stack, such as AppArmor or SELinux), you can load a `BPF_PROG_TYPE_LSM` program that attaches directly to a security hook. Unlike a kprobe, an LSM program's return value participates in the actual security decision — return `0` and the kernel proceeds as normal, return a negative errno and the kernel treats it as a denial.

The hook we want is `capable`, defined in the kernel's LSM hook table and called every time `capable()` or `ns_capable()` checks whether the current task holds a given capability:

```c
// cap_lsm.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <linux/errno.h>

char LICENSE[] SEC("license") = "GPL";

// Per-PID bitmask of capabilities we want to deny, regardless of what the
// process's own Effective set says.
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);   // pid
    __type(value, __u64); // bitmask of denied capabilities (1ULL << CAP_*)
} denied_caps SEC(".maps");

SEC("lsm/capable")
int BPF_PROG(restrict_capable, const struct cred *cred,
             struct user_namespace *ns, int cap, unsigned int opts)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 *mask = bpf_map_lookup_elem(&denied_caps, &pid);

    if (mask && (*mask & (1ULL << cap))) {
        bpf_printk("cap_manager: denying cap %d for pid %d\n", cap, pid);
        return -EPERM;
    }

    return 0;
}
```

You can confirm this hook is attachable on your kernel before writing a line of code — every BPF-attachable LSM hook has a corresponding `bpf_lsm_<hook>` stub in kernel BTF:

```bash
sudo bpftool btf dump file /sys/kernel/btf/vmlinux format raw | grep bpf_lsm_capable
```

Load it with a `libbpf` skeleton (`bpftool gen skeleton`) the same way you'd load any other BPF program, then populate `denied_caps` from userspace using `bpf_map_update_elem()` — for example, denying `CAP_NET_BIND_SERVICE` to a specific PID after your kprobe-based auditor flags it as suspicious. This gives you a genuine two-stage system: the kprobe (or a tracepoint, which is the more stable alternative if one exists for your kernel version) for cheap, continuous auditing, and the LSM hook for hard enforcement when a policy is actually violated.

## Actionable Takeaways

1.  **Don't build enforcement on kprobes.** Use them for auditing and telemetry only. `CONFIG_BPF_LSM` and `SEC("lsm/...")` programs are the supported mechanism for BPF programs that need to influence a security decision.
2.  **Keep the policy data in a map, not in code.** A hash map keyed by PID (or better, by a cgroup ID for longer-lived policy) lets your userspace controller update policy without reloading the BPF program.
3.  **Pair this with `CAP_SETPCAP` sparingly.** Your userspace controller process is now a high-value target — it can both read and shape the capability landscape of every other process on the box. Run it with the minimum capabilities it needs, and audit its own behavior too.
4.  **Test against real kernel versions.** LSM hook availability and BTF layout can shift between kernel releases; pin your CI to the kernel versions you actually deploy on.

## Conclusion

`libcap` gives you the vocabulary to reason about and manipulate capabilities; eBPF — specifically the BPF LSM, not ad hoc kprobes — gives you a supported way to observe and enforce policy around them at runtime. Together they turn capabilities from a static, exec-time grant into a system you can audit continuously and restrict dynamically, without the overhead of a full mandatory access control framework. Start with auditing, prove the policy is correct against real traffic, and only then flip the LSM hook from logging to denying.