---
title: "Secure Multi-Tenant Container Isolation with eBPF and Seccomp"
date: 2026-05-02
category: "thought-leadership"
tags: []
excerpt: "In the world of cloud-native applications, containerization has become the de facto standard. For many organizations, especially SaaS providers, multi..."
---

# Secure Multi-Tenant Container Isolation with eBPF and Seccomp

In the world of cloud-native applications, containerization has become the de facto standard. For many organizations, especially SaaS providers, multi-tenancy is a critical requirement. It allows multiple customers (tenants) to share the same underlying infrastructure, optimizing resource utilization and reducing costs. However, multi-tenancy also introduces significant security challenges, primarily around ensuring robust isolation between tenants. A breach in one tenant's environment must not impact another.

Traditional container isolation relies heavily on Linux namespaces and cgroups. While powerful, these mechanisms primarily isolate resources and process trees. They don't inherently prevent a malicious or compromised container from attempting to interact with the underlying host kernel in unexpected ways, or from leveraging kernel vulnerabilities to break out. This is where advanced security mechanisms like eBPF and Seccomp come into play, offering a powerful combination for fine-grained, dynamic syscall filtering.

## The Challenge of Syscall-Level Isolation

Every operation a container performs eventually translates into a system call (syscall) to the Linux kernel. From reading a file to opening a network socket, it's all syscalls. A compromised container could attempt to make syscalls that are not necessary for its operation but could be used for privilege escalation, information disclosure, or host compromise.

Consider a simple web application container. Does it really need to make `mount()` calls? Or `reboot()`? Absolutely not. Limiting the syscalls a container can make significantly reduces its attack surface.

## Seccomp: The First Line of Defense

Seccomp (Secure Computing mode) is a Linux kernel feature that allows a process to restrict the syscalls it can make. When a Seccomp filter is loaded, any attempt to make a disallowed syscall will result in the process being terminated (usually with a `SIGKILL` or `SIGSYS` signal).

Kubernetes, Docker, and other container runtimes leverage Seccomp by default, applying a sensible baseline profile. This profile typically disallows a large number of dangerous syscalls. However, these default profiles are often generic. For true multi-tenant isolation, you need to tailor Seccomp profiles specifically for each application and tenant type.

Let's look at a simplified Seccomp profile in JSON format:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "bind", "close", "connect", "epoll_create",
        "epoll_create1", "epoll_ctl", "epoll_wait", "fstat", "getdents64",
        "getpeername", "getsockname", "getsockopt", "listen", "open", "openat",
        "read", "recvfrom", "recvmsg", "sendto", "sendmsg", "setsockopt",
        "shutdown", "socket", "stat", "write", "exit", "exit_group", "futex",
        "getpid", "getppid", "gettid", "rt_sigaction", "rt_sigprocmask",
        "set_robust_list", "mmap", "munmap", "brk", "readlink", "readlinkat",
        "getrandom"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
    // Add more specific syscalls as needed, or block dangerous ones explicitly
    // {
    //   "names": ["mount", "reboot", "setns", "ptrace"],
    //   "action": "SCMP_ACT_KILL"
    // }
  ]
}
```

In this example:
*   `"defaultAction": "SCMP_ACT_ERRNO"` means any syscall *not* explicitly allowed will return an `EPERM` error. This is generally safer than `SCMP_ACT_KILL` as it allows the application to gracefully handle errors, but for critical security, `SCMP_ACT_KILL` is often preferred for disallowed syscalls.
*   The `syscalls` array explicitly lists allowed syscalls for a typical web server.

**Actionable Takeaway:** Generate minimal Seccomp profiles for your applications. Tools like `strace` can help identify the syscalls an application uses during normal operation. Automate this process in your CI/CD pipeline to ensure profiles are always up-to-date.

## eBPF: Dynamic and Context-Aware Filtering

While Seccomp is powerful, it's a static filter. It allows or disallows syscalls based purely on their name and arguments. It doesn't understand the *context* in which a syscall is made. For example, a web server might need to open files, but only files within its own `/app` directory, not `/etc/shadow`. Seccomp alone can't enforce this.

This is where eBPF (extended Berkeley Packet Filter) shines. eBPF allows you to run sandboxed programs in the Linux kernel in response to various events, including syscall entry and exit. These eBPF programs can inspect the syscall arguments, the process's credentials, its cgroup, namespace, and much more, and then make a dynamic decision: allow, deny, modify, or log.

For multi-tenant container isolation, eBPF can be used to:

1.  **Refine Seccomp:** Instead of just allowing `openat`, an eBPF program can check if the path being opened is within the tenant's designated directory.
2.  **Network Policy Enforcement:** Beyond standard network policies, eBPF can enforce extremely granular rules, like preventing a container from connecting to specific internal IP ranges, even if firewalls are bypassed.
3.  **Process Sandboxing:** Restrict process creation, execution of specific binaries, or even arguments passed to binaries.
4.  **Resource Usage Monitoring:** Monitor and enforce resource limits beyond cgroups, e.g., tracking specific kernel resource allocations.

### eBPF for File Access Control

Let's consider a practical example: preventing a tenant's container from accessing files outside its designated root directory. We can attach an eBPF program to the `openat` syscall.

First, a simplified eBPF C program (this requires a full eBPF toolchain to compile and load, often using libraries like `libbpf` or `cilium/ebpf`):

```c
#include <linux/bpf.h>
#include <linux/ptrace.h>
#include <linux/version.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "GPL";

// Define a map to store tenant root directories (simplified)
// In a real scenario, this would be dynamically populated
// Key: cgroup_inode_id (or similar unique identifier for tenant)
// Value: inode_id of tenant's root directory
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __uint(key_size, sizeof(u64));
    __uint(value_size, sizeof(u64));
} tenant_roots SEC(".maps");

// Define a struct to hold syscall arguments
struct openat_args {
    long long r8, r9, r10, r11, r12; // Unused, for alignment
    long long syscall_nr;
    long long dfd;
    const char *filename;
    long long flags;
    long long mode;
};

// SEC("tp/syscalls/sys_enter_openat")
SEC("tracepoint/syscalls/sys_enter_openat")
int bpf_openat_check(struct openat_args *ctx) {
    // Get current process's cgroup ID (simplified for example)
    // In a real scenario, you'd correlate this with a tenant ID
    u64 cgroup_id = bpf_get_current_cgroup_id();

    // Look up tenant's allowed root inode
    u64 *allowed_root_inode_ptr = bpf_map_lookup_elem(&tenant_roots, &cgroup_id);
    if (!allowed_root_inode_ptr) {
        // Tenant not configured, allow by default or log/deny
        // For security, denying by default is often safer.
        // bpf_printk("Tenant %llu not configured, allowing openat.", cgroup_id);
        return 0; // Allow
    }

    u64 allowed_root_inode = *allowed_root_inode_ptr;

    char filename[256];
    bpf_probe_read_user_str(&filename, sizeof(filename), ctx->filename);

    // Get the inode of the file being opened
    struct path path_obj;
    // dfd is a file descriptor, not a direct path.
    // This is a simplification. A real implementation would need to resolve
    // the path accurately from dfd and filename, walking the dentry cache.
    // For demonstration, let's assume 'filename' is absolute or relative to a known path.
    // A robust solution would involve `bpf_lookup_dentry` and `bpf_d_path`.
    // This is significantly more complex in eBPF.

    // For a simpler, less robust check (illustrative, not production-ready):
    // Check if filename starts with a known tenant-specific prefix
    // e.g., "/var/lib/tenant_data/<tenant_id>/"
    // This would require passing the tenant_id or prefix to the eBPF program
    // or deriving it from the cgroup_id.

    // Example of a very basic, non-robust path check (illustrative only):
    // if (filename[0] == '/' && filename[1] == '.' && filename[2] == '.') {
    //     // Attempt to access parent directory, could be an escape
    //     bpf_printk("Blocked suspicious path traversal: %s", filename);
    //     return 1; // Deny
    // }

    // A truly robust solution would involve:
    // 1. Getting the inode of the current working directory (cwd) of the process.
    // 2. Resolving the full path of `ctx->filename` relative to `ctx->dfd` and cwd.
    // 3. Walking the parent directories of the resolved path to check if any parent
    //    is outside the `allowed_root_inode`.
    // This requires iterating through dentry/inode objects, which is non-trivial
    // in eBPF due to pointer restrictions and limited helpers.

    // A more practical approach for multi-tenant file isolation with eBPF:
    // Instead of checking against an inode, you might enforce that all `openat`
    // calls must have `ctx->dfd` pointing to a file descriptor that is known
    // to be within the tenant's allowed root, or that the path itself is
    // prefixed with a tenant-specific identifier.
    // Or, you could use a `security_inode_permission` hook.

    // For now, let's assume we want to