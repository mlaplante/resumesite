---
title: "Deep Dive: Crafting Custom Seccomp and AppArmor Profiles for Kubernetes Hardening"
date: 2026-09-09
category: "thought-leadership"
tags: ["kubernetes", "security", "hardening", "seccomp", "apparmor", "linux"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the dynamic world of Kubernetes, security is paramount. While Kubernetes offers robust built-in security features, true hardening often requires..."
---

# Deep Dive: Crafting Custom Seccomp and AppArmor Profiles for Kubernetes Hardening

In the dynamic world of Kubernetes, security is paramount. While Kubernetes offers robust built-in security features, true hardening often requires going a layer deeper, directly interacting with the Linux kernel's security mechanisms. Two powerful tools for this are `seccomp` (Secure Computing Mode) and `AppArmor` (Application Armor). These allow us to fine-tune the system calls a container can make and the resources it can access, significantly reducing the attack surface.

This post will guide you through crafting custom `seccomp` and `AppArmor` profiles, demonstrating how to apply them to your Kubernetes deployments for enhanced security.

## Understanding the "Why": Beyond the Defaults

Kubernetes defaults provide a good baseline. Pods run with a default `seccomp` profile (typically `RuntimeDefault` which is quite permissive) and usually no `AppArmor` profile. While convenient, this broad stroke allows containers to perform a wide range of system calls and access resources that might be unnecessary for their function.

Consider a simple web server. Does it need to make `mknod` system calls? Or access `/dev/mem`? Probably not. By restricting these unnecessary capabilities, we create a more resilient system. If an attacker compromises a container, their ability to escalate privileges or perform malicious actions is severely curtailed.

## Crafting a Custom Seccomp Profile

`seccomp` profiles are JSON files that define which system calls a process is allowed or denied. The `RuntimeDefault` profile typically allows most common syscalls. Our goal is to create a more restrictive profile.

### Step 1: Baseline and Observation

The first step is to understand what syscalls your application *actually* needs. This can be challenging. Tools like `strace` or `falco` can help, but for a running Kubernetes pod, a more practical approach is often to start with a permissive profile and observe failures, or use a tool like `scmp_sysgen` (from libseccomp-tools) to generate a baseline.

Let's assume we have a simple Nginx container. We know it needs basic network operations, file reading, and process management.

Here's a simplified `seccomp` profile that allows a minimal set of syscalls. We'll start with `SCMP_ACT_ERRNO` (deny with EPERM) as the default action and then explicitly allow necessary syscalls.

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "bind", "clone", "close", "connect", "dup", "dup2", "epoll_ctl",
        "epoll_create", "epoll_create1", "eventfd", "eventfd2", "execve", "exit", "exit_group",
        "fcntl", "fcntl64", "fstat", "fstat64", "futex", "getdents", "getdents64", "getpid",
        "getppid", "gettid", "gettimeofday", "ioctl", "listen", "lseek", "lstat", "lstat64",
        "madvise", "mmap", "mmap2", "mprotect", "munmap", "nanosleep", "open", "openat",
        "pipe", "pipe2", "poll", "ppoll", "pread64", "pwrite64", "read", "readv", "recvfrom",
        "recvmmsg", "sendfile", "sendfile64", "sendmsg", "sendto", "set_robust_list", "setsockopt",
        "shutdown", "socket", "stat", "stat64", "sysinfo", "tgkill", "wait4", "waitid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

**Explanation:**
*   `defaultAction: SCMP_ACT_ERRNO`: Any syscall not explicitly listed will fail with a "Permission denied" error. This is a strong default.
*   `syscalls`: An array of objects defining specific syscalls and their actions.
*   `names`: An array of syscall names.
*   `action: SCMP_ACT_ALLOW`: These syscalls are permitted.

This is still a relatively broad list. For a truly hardened profile, you'd iterate by running your application, observing failures, and incrementally adding only the necessary syscalls.

### Step 2: Deploying the Seccomp Profile

1.  **Save the profile:** Save the JSON above as `nginx-seccomp.json`.
2.  **Make it available to Kubernetes:**
    The Kubernetes Kubelet needs access to this file. The recommended way is to store it as a ConfigMap and mount it into the Kubelet's seccomp root directory on each node. However, for a quick test, you can manually place it on the node.
    Let's use a ConfigMap:

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: nginx-seccomp-profile
      namespace: default
    data:
      nginx-seccomp.json: |
        {
          "defaultAction": "SCMP_ACT_ERRNO",
          "syscalls": [
            {
              "names": [
                "accept", "accept4", "bind", "clone", "close", "connect", "dup", "dup2", "epoll_ctl",
                "epoll_create", "epoll_create1", "eventfd", "eventfd2", "execve", "exit", "exit_group",
                "fcntl", "fcntl64", "fstat", "fstat64", "futex", "getdents", "getdents64", "getpid",
                "getppid", "gettid", "gettimeofday", "ioctl", "listen", "lseek", "lstat", "lstat64",
                "madvise", "mmap", "mmap2", "mprotect", "munmap", "nanosleep", "open", "openat",
                "pipe", "pipe2", "poll", "ppoll", "pread64", "pwrite64", "read", "readv", "recvfrom",
                "recvmmsg", "sendfile", "sendfile64", "sendmsg", "sendto", "set_robust_list", "setsockopt",
                "shutdown", "socket", "stat", "stat64", "sysinfo", "tgkill", "wait4", "waitid", "write", "writev"
              ],
              "action": "SCMP_ACT_ALLOW"
            }
          ]
        }
    ```
    Apply this: `kubectl apply -f nginx-seccomp-configmap.yaml`

    Now, we need to ensure this profile is placed in the Kubelet's seccomp profile directory. This typically involves a DaemonSet that mounts the ConfigMap and copies the file. A simpler approach for demonstration is to assume the file is directly available on the node at `/var/lib/kubelet/seccomp/profiles/nginx-seccomp.json`.

3.  **Apply to a Pod:**
    In your Pod's security context, reference the custom profile:

    ```yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: nginx-seccomp-hardened
    spec:
      selector:
        matchLabels:
          app: nginx-seccomp
      template:
        metadata:
          labels:
            app: nginx-seccomp
        spec:
          securityContext:
            seccompProfile:
              type: Localhost
              localhostProfile: profiles/nginx-seccomp.json # Path relative to Kubelet's seccomp root
          containers:
          - name: nginx
            image: nginx:latest
            ports:
            - containerPort: 80
    ```
    The `localhostProfile` path is relative to the Kubelet's configured seccomp profile root (usually `/var/lib/kubelet/seccomp`). So, if our ConfigMap approach places the file in `/var/lib/kubelet/seccomp/profiles/nginx-seccomp.json`, this setup works.

## Crafting a Custom AppArmor Profile

`AppArmor` provides Mandatory Access Control (MAC) by confining programs to a limited set of resources. It operates at a higher level than `seccomp`, controlling file access, network access, and capabilities.

### Step 1: Understanding AppArmor Syntax

AppArmor profiles are plain text files. They define rules for what a program can do.

Here's a very basic AppArmor profile for Nginx:

```apparmor
#include <tunables/global>

profile nginx-profile flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/web-data>

  network tcp,
  network udp,

  # Deny all capabilities by default (will be overridden by K8s capabilities)
  deny capability,

  # Allow Nginx to execute itself and its helper binaries
  /usr/sbin/nginx mr,
  /usr/bin/nginx mr, # some distros might have it here
  /usr/lib/nginx/** r,

  # Allow Nginx to read configuration files
  /etc/nginx/** r,

  # Allow Nginx to write to its log files
  /var/log/nginx/** w,
  /var/log/nginx/** a,

  # Allow Nginx to read web content
  /usr/share/nginx/html/** r,

  # Deny all other file writes
  deny /** w,
  deny /** a,
  deny /** C,
  deny /** U,

  # Deny access to sensitive directories
  deny /boot/** rwk,
  deny /dev/** rwk,
  deny /proc/** rwk,
  deny /sys/** rwk,
  deny /root/** rwk,
}
```

**Explanation:**
*   `profile nginx-profile flags=(...)`: Defines the profile with a name and flags.
*   `#include <abstractions/...>`: AppArmor provides useful abstractions for common tasks (e.g., `base` for basic filesystem access, `nameservice` for DNS, `web-data` for common web paths).
*   `network tcp, network udp,`: Allows TCP and UDP network connections.
*   `deny capability,`: A strong default to deny all Linux capabilities.
*   `/path/to/file mr,`: `m` for mmap, `r` for read. Other common modes: `w` (write), `a` (append), `x` (execute), `k` (lock