---
title: "Demystifying Linux Control Groups (cgroups v2): Crafting Resource Isolation for Secure Multi-Tenant Environments"
date: 2026-09-25
category: "thought-leadership"
tags: ["linux", "cgroups", "resource-management", "security", "multi-tenancy", "containers"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of modern infrastructure, especially within containerized and multi-tenant environments, resource isolation is paramount. Without it, a..."
---

In the world of modern infrastructure, especially within containerized and multi-tenant environments, resource isolation is paramount. Without it, a single runaway process from one tenant could starve the entire system, leading to performance degradation or even outages for others. This is where Linux Control Groups (cgroups) come into play, offering a powerful mechanism to allocate resources (CPU, memory, I/O, network) among groups of processes.

While cgroups v1 served us well for many years, cgroups v2 brings a cleaner, more unified hierarchy and improved resource management capabilities. As an SVP of Information Security and Operations, understanding and leveraging cgroups v2 is not just about performance; it's a critical component of building robust, secure, and predictable multi-tenant systems.

Let's dive into cgroups v2 and explore how we can use it to craft effective resource isolation.

## Understanding the cgroups v2 Unified Hierarchy

One of the most significant changes in cgroups v2 is the unified hierarchy. Unlike v1's multiple, independent hierarchies, v2 presents a single, tree-like structure where all controllers (CPU, memory, I/O, etc.) reside. This simplifies management and provides a more consistent view of resource allocation.

The cgroup filesystem is typically mounted at `/sys/fs/cgroup`. Within this directory, you'll find the root cgroup, and beneath it, you can create child cgroups to group processes and apply resource limits.

**Key Concepts:**

*   **Controllers:** These are the kernel components that manage specific resources (e.g., `cpu`, `memory`, `io`).
*   **cgroup.subtree_control:** This file in a parent cgroup lists the controllers that are *enabled* for its children. A parent must explicitly enable controllers for its children to use them.
*   **cgroup.procs:** This file lists the PIDs of processes belonging to a cgroup.
*   **cgroup.threads:** This file lists the TIDs of threads belonging to a cgroup.
*   **cgroup.events:** Provides event notifications, such as when a cgroup becomes empty.

## Setting Up a Basic cgroup v2 Environment

Let's walk through a practical example of creating a cgroup, assigning a process, and applying a memory limit.

First, ensure your system is running with cgroups v2. You can check this by looking at the mount options for `/sys/fs/cgroup`:

```bash
mount | grep cgroup
# Expected output similar to:
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate)
```

If you see `cgroup2` as the type, you're good to go.

### Step 1: Create a New cgroup

We'll create a cgroup called `my_tenant_group` under the root.

```bash
sudo mkdir /sys/fs/cgroup/my_tenant_group
```

### Step 2: Enable Controllers for the Child cgroup

For `my_tenant_group` to use controllers like `memory` and `cpu`, its parent (the root cgroup) must enable them in its `cgroup.subtree_control` file.

```bash
# Check current enabled controllers at the root
sudo cat /sys/fs/cgroup/cgroup.subtree_control

# Enable memory and cpu controllers for children of the root
# The '+' prefix adds a controller, '-' removes it.
echo '+memory +cpu' | sudo tee /sys/fs/cgroup/cgroup.subtree_control
```

Now, within `my_tenant_group`, you should see the `memory` and `cpu` controller files available.

```bash
ls /sys/fs/cgroup/my_tenant_group/
# Expected output includes:
# cpu.max      memory.high  memory.max  memory.swap.max  memory.stat ...
```

### Step 3: Apply a Memory Limit

Let's limit the memory usage for processes in `my_tenant_group` to 256MB.

```bash
echo 268435456 | sudo tee /sys/fs/cgroup/my_tenant_group/memory.max
# 268435456 bytes = 256 MB
```

We can also set a "memory high" limit, which acts as a soft limit. When memory usage exceeds `memory.high`, the kernel will try to reclaim memory from the cgroup.

```bash
echo 214748364 | sudo tee /sys/fs/cgroup/my_tenant_group/memory.high
# 214748364 bytes = 200 MB
```

### Step 4: Assign a Process to the cgroup

Now, let's run a memory-intensive process and assign it to our cgroup. We'll use a simple Python script for this.

Create a file named `memory_hog.py`:

```python
import time

# Allocate a large list of integers
data = []
for i in range(10 * 1024 * 1024): # Approx 80MB per 10M integers
    data.append(i)
    if len(data) % (1024 * 1024) == 0:
        print(f"Allocated {len(data) / (1024 * 1024):.0f} MB...")
        time.sleep(0.1) # Give kernel time to react

print("Finished allocation.")
while True:
    time.sleep(1) # Keep process alive
```

Now, run this script and immediately move its PID to the cgroup:

```bash
# In one terminal:
python3 memory_hog.py &
PID=$!
echo "Memory hog PID: $PID"

# In another terminal, or quickly after getting PID:
sudo echo $PID | sudo tee /sys/fs/cgroup/my_tenant_group/cgroup.procs
```

Observe the behavior. The `memory_hog.py` script will try to allocate memory. Once it hits the `memory.max` limit (256MB), the kernel will kill the process (OOM kill) within that cgroup, preventing it from affecting other parts of the system.

You can monitor memory usage within the cgroup:

```bash
sudo cat /sys/fs/cgroup/my_tenant_group/memory.current
```

You'll see the `memory_hog.py` process being terminated when it exceeds the limit. This is the isolation in action!

## CPU Resource Management

Similar to memory, cgroups v2 provides fine-grained control over CPU resources.

*   **cpu.max:** This file controls the maximum CPU bandwidth. It takes two space-separated values: `max` and `period`. `max` specifies the maximum time (in microseconds) that processes in the cgroup can run during each `period` (also in microseconds). For example, `50000 100000` means 50ms of CPU time per 100ms period (50% CPU). `max` can be `max` to indicate no upper limit.
*   **cpu.weight:** This file (replaces `cpu.shares` from v1) controls the proportional share of CPU time when the system is under contention. A higher weight means a larger share. The default is 100.

### Example: Limiting CPU to 25%

Let's limit our `my_tenant_group` to 25% of a CPU core.

```bash
# 25000 microseconds out of a 100000 microsecond period = 25%
echo '25000 100000' | sudo tee /sys/fs/cgroup/my_tenant_group/cpu.max
```

Now, if you run a CPU-intensive task (e.g., `stress -c 1` or a tight loop calculation) within this cgroup, you'll observe its CPU usage being capped.

To test this, run `stress` in the background and move it to the cgroup:

```bash
# In one terminal:
stress -c 1 &
PID=$!
echo "Stress PID: $PID"

# In another terminal:
sudo echo $PID | sudo tee /sys/fs/cgroup/my_tenant_group/cgroup.procs
```

You can then use `top` or `htop` to observe the CPU usage of the `stress` process, which should hover around 25%.

## I/O and Other Controllers

cgroups v2 also offers controllers for I/O (`io`), network (`net_cls`, `net_prio`), and more. The principles remain the same: enable the controller at the parent, then configure the specific limits within the child cgroup.

For example, to limit I/O bandwidth:

```bash
# Enable io controller at the root
echo '+io' | sudo tee /sys/fs/cgroup/cgroup.subtree_control

# Set I/O limits for a specific device (e.g., sda)
# This limits read/write bytes per second
# Format: <major>:<minor> <rbps> <wbps>
echo "8:0 1048576 1048576" | sudo tee /sys/fs/cgroup/my_tenant_group/io.max
# 8:0 typically refers to /dev/sda (check with 'lsblk -o MAJ:MIN,NAME')
# 1048576 bytes/sec = 1 MB/sec
```

## Actionable Takeaways for Secure Multi-Tenant Environments

1.  **Standardize cgroup Configuration:** For each tenant or service tier, define standard cgroup profiles. This ensures consistent resource allocation and prevents "noisy neighbor" problems.
2.  **Automate cgroup Creation:** Integrate cgroup creation and process assignment into your deployment pipelines. Tools like Ansible, Chef, or custom scripts can manage the cgroup filesystem.
3.  **Monitor cgroup Metrics:** Regularly monitor cgroup statistics (e.g., `memory.current`, `cpu.stat`, `io.stat`). This helps identify resource contention, potential bottlenecks, and misconfigured limits. Prometheus and Grafana are excellent tools for this.
4.  **Leverage for Container Runtimes:** Understand that container runtimes (Docker, containerd, CRI-O) use cgroups under the hood to enforce the resource limits you define in your container orchestrators (Kubernetes limits and requests). Direct cgroup manipulation is useful for understanding, debugging, and for non-containerized workloads.
5.  **Security Implications:** By isolating resources, you reduce the attack surface. A denial-of-service attack targeting one tenant's application is less likely to affect other tenants if their resources are properly constrained.
6.  **OOM Killer Awareness:** Be aware that hitting `memory.max` will result in the OOM killer terminating processes within that cgroup. Design your applications to handle this gracefully or ensure sufficient memory is allocated. `memory.min` and `memory.low` can also be used to reserve memory and provide protection against aggressive reclaim.

## Conclusion

Linux cgroups v2 provides a robust and unified framework for resource isolation. For anyone managing multi-tenant environments, whether they are bare-metal, virtualized, or containerized, a deep understanding of cgroups is indispensable. By carefully crafting cgroup configurations, we can build more secure, stable, and predictable systems, ensuring fair resource distribution and mitigating the risks associated with shared infrastructure. Embrace cgroups v2 to take your resource management to the next level.