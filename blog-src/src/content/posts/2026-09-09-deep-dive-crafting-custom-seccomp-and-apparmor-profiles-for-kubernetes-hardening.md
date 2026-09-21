---
title: "Deep Dive: Crafting Custom Seccomp and AppArmor Profiles for Kubernetes Hardening"
date: 2026-09-09
category: "thought-leadership"
tags: ["kubernetes", "security", "hardening", "seccomp", "apparmor", "linux"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the dynamic world of Kubernetes, security is paramount. While Kubernetes offers robust built-in security features, true hardening often requires..."
---

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
*   `/path/to/file mr,`: `m` for mmap, `r` for read. Other common modes: `w` (write), `a` (append), `x` (execute), `k` (allow file locking), and `l` (allow creating hard links to the file). Execute permissions also come in transition variants — `ix` (execute and inherit the current profile), `px` (execute under another defined profile), `ux` (execute unconfined) — which matter a lot if your application shells out to helper binaries.

### Step 2: Loading and Deploying the AppArmor Profile

Unlike `seccomp` profiles, which the Kubelet reads directly, AppArmor profiles must be *loaded into the kernel* on each node before a Pod can reference them.

1.  **Load the profile on the node:**

    ```bash
    sudo apparmor_parser -r /etc/apparmor.d/nginx-profile
    ```

    In practice you'd ship this via a DaemonSet that mounts the profile from a ConfigMap or hostPath and runs `apparmor_parser` on each node at startup, since there's no first-class Kubernetes object for AppArmor profile distribution the way there is for `seccomp` ConfigMaps mounted into the Kubelet's profile root.

2.  **Verify it loaded:**

    ```bash
    sudo aa-status | grep nginx-profile
    ```

3.  **Reference it from the Pod spec.** As of Kubernetes 1.30, AppArmor is a stable, first-class field on the security context:

    ```yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: nginx-apparmor-hardened
    spec:
      selector:
        matchLabels:
          app: nginx-apparmor
      template:
        metadata:
          labels:
            app: nginx-apparmor
        spec:
          containers:
          - name: nginx
            image: nginx:latest
            ports:
            - containerPort: 80
            securityContext:
              appArmorProfile:
                type: Localhost
                localhostProfile: nginx-profile
    ```

    On older clusters (pre-1.30), the equivalent is the pod annotation `container.apparmor.security.beta.kubernetes.io/<container-name>: localhost/nginx-profile`, set on the Pod's `metadata.annotations`. Either way, the profile name referenced must exactly match the `profile nginx-profile { ... }` name declared in the loaded profile, and the profile must already be loaded on whichever node the scheduler places the Pod on — a common source of confusing `CreateContainerError` failures when a Pod lands on a node the DaemonSet hasn't reached yet.

## Layering Seccomp and AppArmor Together

These two mechanisms aren't competing approaches — they operate at different layers and are meant to be stacked. `seccomp` filters the *syscall interface itself*, blocking entire classes of kernel functionality (like `ptrace`, `mount`, or raw socket creation) regardless of what file or resource is being targeted. `AppArmor` is a Linux Security Module operating at a higher semantic layer, reasoning about *which files, network operations, and capabilities* a confined program can touch, based on path-aware policy the kernel evaluates on each LSM hook. A container with an aggressive `seccomp` profile can still misuse the syscalls it's allowed to call — `AppArmor` closes that gap by constraining what those allowed syscalls can actually act on. Running both, alongside a restrictive Pod `securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: ["ALL"]`), gives you defense-in-depth that no single mechanism provides on its own.

## Conclusion

Kubernetes' default `seccomp` and (lack of) `AppArmor` posture is a reasonable baseline, not a hardened one. Building custom profiles is genuinely tedious work — you're iterating against real application behavior, watching for `EPERM`s and denied-access log lines, and tightening incrementally — but the payoff is a meaningfully smaller blast radius if a container is ever compromised. Start from observed behavior rather than guesswork, keep the profiles under version control next to the workloads they protect, and treat `seccomp` and `AppArmor` as complementary layers rather than alternatives to each other.