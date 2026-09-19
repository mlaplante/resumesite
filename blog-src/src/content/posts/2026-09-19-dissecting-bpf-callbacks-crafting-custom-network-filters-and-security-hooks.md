---
title: "Dissecting BPF Callbacks: Crafting Custom Network Filters and Security Hooks"
date: 2026-09-19
category: "thought-leadership"
tags: ["ebpf", "bpf", "networking", "kernel", "security", "linux"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As practitioners in information security and operations, we often find ourselves needing more granular control than what traditional tools offer...."
---

As practitioners in information security and operations, we often find ourselves needing more granular control than what traditional tools offer. Whether it's for advanced network filtering, custom logging, or implementing bespoke security policies, the Linux kernel, through eBPF (extended Berkeley Packet Filter), provides an unparalleled level of extensibility. At its core, eBPF allows us to run sandboxed programs within the kernel, triggered by various events. Today, we're going to dive into how BPF callbacks enable us to craft custom network filters and security hooks, moving beyond the basics to real-world applications.

## The Power of Kernel-Level Hooks

Traditional network filtering often relies on `iptables` or `nftables`. While powerful, these tools operate at a higher abstraction layer. When we need to inspect packets, modify their behavior, or enforce policies based on application-specific logic *before* they even hit userspace, eBPF becomes indispensable. The "callback" mechanism in eBPF refers to attaching a BPF program to a specific kernel hook point. When that event occurs, our BPF program is executed.

Let's consider a practical scenario: we want to block all outbound SSH connections to a specific IP address range, but only if the connection originates from a non-privileged user ID, and log the attempt with custom metadata. This kind of nuanced policy is perfectly suited for an eBPF program attached to a network hook.

## Anatomy of an eBPF Network Filter

An eBPF program for network filtering typically attaches to a `TC` (Traffic Control) hook, specifically `ingress` or `egress` on a network interface. Alternatively, for socket-level control, `sock_ops` or `sock_filter` hooks can be used. For our example, we'll focus on `TC` for simplicity and broad applicability.

Our eBPF program will be written in C, compiled to BPF bytecode using `clang`, and then loaded into the kernel using the `bpf` syscall or a library like `libbpf`.

### Step 1: The BPF C Program

Let's outline a simplified C program that inspects outbound TCP packets.

```c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Define a BPF map for storing blocked IP ranges or user IDs
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);   // IP address prefix
    __type(value, __u8);  // Placeholder value
} blocked_ips SEC(".maps");

SEC("tc")
int egress_filter(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data = (void *)(long)skb->data;

    // Ensure we have enough data for Ethernet header
    struct ethhdr *eth = data;
    if (data + sizeof(*eth) > data_end)
        return TC_ACT_OK; // Allow, not enough data

    // Only process IPv4 packets
    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return TC_ACT_OK;

    // Ensure we have enough data for IP header
    struct iphdr *ip = data + sizeof(*eth);
    if (data + sizeof(*eth) + sizeof(*ip) > data_end)
        return TC_ACT_OK;

    // Only process TCP packets
    if (ip->protocol != IPPROTO_TCP)
        return TC_ACT_OK;

    // Ensure we have enough data for TCP header
    struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
    if ((void *)tcp + sizeof(*tcp) > data_end)
        return TC_ACT_OK;

    // Get destination IP and port
    __u32 dest_ip = bpf_ntohl(ip->daddr);
    __u16 dest_port = bpf_ntohs(tcp->dest);

    // Example: Block outbound SSH (port 22) to specific IP if found in map
    if (dest_port == 22) {
        // Check if destination IP matches a blocked prefix
        // For simplicity, let's assume `blocked_ips` map contains full IPs for now
        // In a real scenario, you'd implement prefix matching.
        if (bpf_map_lookup_elem(&blocked_ips, &dest_ip)) {
            // Log the attempt
            bpf_printk("BPF: Blocked SSH connection to %x:%d from UID %d\n",
                       dest_ip, dest_port, skb->uid);
            return TC_ACT_SHOT; // Drop the packet
        }
    }

    return TC_ACT_OK; // Allow by default
}

char _license[] SEC("license") = "GPL";
```

### Step 2: Compiling the BPF Program

To compile this, you'll need `clang` and `llvm` with BPF backend support.

```bash
clang -target bpf -O2 -emit-llvm -c custom_filter.c -o custom_filter.ll
llc -march=bpf -filetype=obj custom_filter.ll -o custom_filter.o
```

### Step 3: Loading and Attaching the Program

Now, we need a userspace loader to attach this `custom_filter.o` to a network interface. `libbpf` simplifies this greatly. Here's a conceptual outline of the loader logic:

```python
from bcc import BPF
import time

device = "eth0" # Or your primary network interface

# Load the BPF program
b = BPF(src_file="custom_filter.c") # bcc can compile on the fly from C source

# Attach to egress Traffic Control hook
# The 'filter' function corresponds to our SEC("tc") function
fn = b.load_func("egress_filter", BPF.TC_EGRESS)

# Get the network interface index
# In a real scenario, use netlink for robust device indexing
# For bcc, it often handles this implicitly.
# For libbpf, you'd use `if_nametoindex`.

# Attach the filter
# bcc_attach_tc is a simplified wrapper.
# With libbpf, you would create a Qdisc, then a filter, then attach the BPF program.
# Example using bcc's simplified API for demonstration:
# b.attach_tc(device=device, fn=fn, direction=BPF.EGRESS) # This API might vary slightly

# A more robust libbpf-style attachment (conceptual):
# qdisc = bpf_tc_attach_qdisc(ifindex, BPF_TC_INGRESS/BPF_TC_EGRESS, handle, parent)
# filter = bpf_tc_attach_filter(qdisc, bpf_prog_fd, priority, protocol)

# For our example, let's stick to the high-level concept:
# Imagine `bpf_prog_load` and `bpf_tc_attach` are called.
# Let's manually manage the map for demonstration.

# Populate the blocked_ips map (e.g., block 192.168.1.100)
# Convert IP to network byte order for the map key
blocked_ip_int = (192 << 24) | (168 << 16) | (1 << 8) | 100
blocked_ip_int_be = b.ntohl(blocked_ip_int) # Convert to big-endian for kernel

# Assuming `blocked_ips` is accessible via `b.get_map`
# For bcc, maps are often accessed directly:
# blocked_ips_map = b["blocked_ips"]
# blocked_ips_map[blocked_ip_int_be] = 1 # Value doesn't matter much for hash lookup

print(f"BPF program loaded and attached to {device} egress.")
print("Blocking SSH to 192.168.1.100...")
print("Press Ctrl-C to detach.")

try:
    while True:
        # You can read bpf_printk output using `b.trace_fields()` or `perf_event_open`
        # For simplicity, we just keep the program running
        time.sleep(1)
except KeyboardInterrupt:
    pass

# Detach the program (bcc handles this on exit)
# For libbpf, you'd explicitly call `bpf_tc_detach_filter` and `bpf_tc_detach_qdisc`
print("Detaching BPF program.")
```

**Actionable Takeaway:** This example demonstrates the core workflow: write C code, compile to BPF, load into kernel, and attach to a hook. The `bpf_printk` calls are crucial for debugging and getting visibility into your kernel-level logic.

## Crafting Security Hooks: Beyond Network Filters

The power of eBPF extends far beyond network filtering. We can attach BPF programs to various other kernel events to create powerful security hooks:

1.  **Syscall Tracing (`tracepoint`/`kprobe`):** Monitor or intercept system calls.
    *   **Use Case:** Detect suspicious file access patterns (e.g., a web server attempting to write to `/etc/passwd`), restrict specific syscalls for a container, or audit process execution.
    *   **Example:** Hook `execve` to log all new process executions with their arguments and parent PID.

2.  **Filesystem Operations (`kprobe` on VFS functions):** Observe file opens, reads, writes, and deletes.
    *   **Use Case:** Implement mandatory access control (MAC) policies that go beyond traditional Linux permissions, detect ransomware-like file encryption behavior, or prevent sensitive file tampering.
    *   **Example:** Block `open` calls to specific sensitive files if the process initiating the call is not whitelisted.

3.  **Process Management (`tracepoint` on `sched_process_exec`):** Gain insight into process lifecycle events.
    *   **Use Case:** Enforce container isolation by ensuring processes within a container cannot escape their cgroup, or implement custom auditing for process creation and termination.
    *   **Example:** Monitor `fork` and `exec` events to build a real-time process tree.

## Real-World Considerations and Best Practices

*   **Error Handling:** BPF programs run in the kernel and must be extremely robust. Bounds checking (`data + size > data_end`) is paramount to prevent kernel panics.
*   **Performance:** B