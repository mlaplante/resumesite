---
title: "Dissecting seccomp-bpf: Crafting Custom Linux Container Sandboxes for Enhanced Security"
date: 2026-06-14
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Linux containers have revolutionized how we deploy applications, offering consistency and portability. However, the default isolation provided by..."
---

# Dissecting `seccomp-bpf`: Crafting Custom Linux Container Sandboxes for Enhanced Security

Linux containers have revolutionized how we deploy applications, offering consistency and portability. However, the default isolation provided by namespaces and cgroups, while robust, isn't always sufficient for high-security workloads. This is where `seccomp-bpf` (secure computing with Berkeley Packet Filter) steps in, allowing us to define precisely which system calls a process can make, effectively creating a granular sandbox.

While tools like Docker and Kubernetes offer default `seccomp` profiles, understanding how to craft your own custom profiles empowers you to tailor security to your application's exact needs, minimizing the attack surface significantly.

## The Problem: Unnecessary System Calls

Every process, including those inside a container, interacts with the kernel through system calls (syscalls). A typical application might only need a handful of syscalls to function correctly (e.g., `read`, `write`, `openat`, `exit`). However, by default, a process can make *any* syscall. If an attacker compromises an application within a container, they can then attempt to leverage any available syscall to escalate privileges, access host resources, or break out of the container.

`seccomp-bpf` addresses this by allowing us to whitelist or blacklist specific syscalls. When a process attempts to make a disallowed syscall, the kernel immediately terminates the process (or takes another defined action).

## `seccomp-bpf` Under the Hood

At its core, `seccomp-bpf` uses a BPF (Berkeley Packet Filter) program to inspect each syscall as it's made. The BPF program, loaded into the kernel, determines whether the syscall should be allowed, denied, or handled in another way.

A `seccomp` profile is essentially a JSON document that defines these rules. Let's break down a simple example.

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "exit",
        "exit_group",
        "read",
        "write",
        "openat",
        "close",
        "fstat",
        "newfstatat",
        "lseek",
        "mmap",
        "mprotect",
        "munmap",
        "brk",
        "arch_prctl",
        "set_tid_address",
        "set_robust_list",
        "rt_sigaction",
        "rt_sigprocmask",
        "sigaltstack",
        "getpid",
        "gettid",
        "futex",
        "sched_getaffinity",
        "getrandom",
        "clone",
        "execve"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

In this simplified profile:

*   `"defaultAction": "SCMP_ACT_ERRNO"`: This is crucial. It means any syscall *not explicitly allowed* will result in an `EPERM` error, effectively denying it. Other common default actions include `SCMP_ACT_KILL` (terminate the process) or `SCMP_ACT_LOG` (log the violation). For production, `SCMP_ACT_KILL` or `SCMP_ACT_ERRNO` are preferred.
*   `"syscalls"`: This array contains rules for specific syscalls.
    *   `"names"`: A list of syscall names (e.g., `exit`, `read`, `write`).
    *   `"action": "SCMP_ACT_ALLOW"`: Explicitly permits these syscalls.

## Crafting a Custom Profile: A Practical Approach

Creating a robust `seccomp` profile involves careful observation and iteration. Here's a practical workflow:

### Step 1: Baseline and Observe

Start with a very permissive profile or even no profile, and observe the syscalls your application makes during normal operation.

**Tooling:**
*   `strace`: For direct observation of a single process.
*   `auditd`: For system-wide syscall logging.
*   `docker run --security-opt seccomp=unconfined --log-driver=json-file`: Run your container unconfined and capture logs.

Let's say we have a simple Go web server:

```go
package main

import (
	"fmt"
	"net/http"
	"os"
)

func handler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "Hello from %s!\n", os.Getenv("HOSTNAME"))
}

func main() {
	http.HandleFunc("/", handler)
	fmt.Println("Server starting on :8080")
	http.ListenAndServe(":8080", nil)
}
```

Build and run it with `strace`:

```bash
# Build the Go app
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o mywebapp main.go

# Run in a container with strace attached
docker run --rm -it --name mywebapp-test \
  --security-opt seccomp=unconfined \
  -v "$(pwd)/mywebapp:/mywebapp" \
  ubuntu:latest \
  strace -f /mywebapp
```

Interact with the web server: `curl localhost:8080`. You'll see a flood of syscalls. Capture these.

### Step 2: Generate an Initial Profile

Manually sifting through `strace` output is tedious. Tools can help generate a basic profile.

**`go-seccomp-exporter` (or similar):** A utility that can generate a `seccomp` profile based on `strace` output.

```bash
# Example usage (install go-seccomp-exporter first)
strace -f -o syscalls.log /mywebapp
go-seccomp-exporter --input syscalls.log --output mywebapp.json
```

This will give you a good starting point, but it will likely be too broad.

### Step 3: Refine and Test Iteratively

Now, take the generated profile and start tightening it.

1.  **Set `defaultAction` to `SCMP_ACT_ERRNO` or `SCMP_ACT_KILL`.** This is critical for security.
2.  **Remove unnecessary syscalls.** Look for syscalls that are clearly not needed for your application's core function. For a static Go binary, you might not need many filesystem-related syscalls beyond initial setup and serving.
3.  **Test thoroughly.** Run your application with the custom `seccomp` profile and ensure all functionalities work. Observe for `EPERM` errors or unexpected crashes.

    ```bash
    docker run --rm -it --name mywebapp-secure \
      --security-opt seccomp=mywebapp.json \
      -v "$(pwd)/mywebapp:/mywebapp" \
      ubuntu:latest \
      /mywebapp
    ```

    If it crashes or fails, check your container logs for `seccomp` violations. Docker will typically log messages like: `seccomp: seccomp_load: Invalid argument` or `seccomp: seccomp_load: Operation not permitted`. You'll need to re-enable the necessary syscalls in your profile.

4.  **Consider arguments and return values.** `seccomp` can also filter based on syscall arguments. For instance, you could restrict `openat` to only allow opening files within specific paths or with certain flags. This adds a layer of complexity but offers even finer granularity.

    ```json
    {
      "names": ["openat"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 1,
          "value": 0,
          "valueTwo": 0,
          "op": "SCMP_CMP_EQ"
        }
      ]
    }
    ```
    This example is overly simplistic. Real-world argument filtering is complex and often requires understanding the syscall's specific argument structure (e.g., `openat`'s `flags` argument).

### Step 4: Maintenance

`seccomp` profiles are not "set it and forget it."

*   **Application updates:** New versions of your application might introduce new dependencies or behaviors that require different syscalls.
*   **Library updates:** Upgrading system libraries or language runtimes can also change syscall patterns.
*   **Base image changes:** A different base OS image might have different underlying syscall requirements.

Regularly review and test your `seccomp` profiles, especially after major updates.

## Key Takeaways

*   **Default `seccomp` is good, custom is better:** While container runtimes provide default profiles, custom profiles offer the highest level of tailored security.
*   **Least privilege principle:** Aim to allow only the absolute minimum set of syscalls required for your application to function.
*   **Iterative process:** Crafting a robust `seccomp` profile is an iterative process of observation, generation, refinement, and testing.
*   **Tools are your friends:** Leverage `strace`, `auditd`, and `seccomp` profile generators to streamline the process.
*   **Don't forget maintenance:** Profiles need to be reviewed and updated as your application and its dependencies evolve.

By investing the time to craft custom `seccomp-bpf` profiles, you significantly harden your Linux containers, making them more resilient against exploitation and reducing the potential blast radius in the event of a compromise. This is a critical layer in a defense-in-depth strategy for any security-conscious deployment.