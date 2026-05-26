---
title: "Mastering eBPF for Custom Network Policy Enforcement in Kubernetes"
date: 2026-05-26
category: "thought-leadership"
tags: []
excerpt: "Kubernetes network policies are powerful, but sometimes you hit their limits. You might need granular control that goes beyond CIDR blocks, port range..."
---

# Mastering eBPF for Custom Network Policy Enforcement in Kubernetes

Kubernetes network policies are powerful, but sometimes you hit their limits. You might need granular control that goes beyond CIDR blocks, port ranges, and label selectors. Perhaps you need to enforce policies based on application-layer protocols, specific HTTP headers, or even the identity of the process initiating a connection within a pod. This is where eBPF shines, offering a flexible, high-performance mechanism to extend Kubernetes networking capabilities far beyond its native constructs.

As an SVP of Information Security and Operations, I've seen firsthand the need for bespoke policy enforcement. While standard network policies cover 90% of use cases, the remaining 10% often involve critical security requirements that demand a deeper integration into the kernel's networking stack. eBPF provides that surgical precision.

## Why eBPF Beyond Standard Network Policies?

Kubernetes Network Policies operate at Layer 3/4. They are essentially iptables rules managed by a CNI plugin. While effective, they have limitations:

*   **Layer 7 Visibility:** No inherent ability to inspect application-layer protocols (HTTP, TLS, DNS queries, etc.).
*   **Process-Level Granularity:** Cannot enforce policies based on the specific process *within* a pod making a connection.
*   **Dynamic Context:** Limited ability to react to dynamic, real-time context beyond pod labels and IP addresses.
*   **Performance Overhead:** For very complex or frequently changing rulesets, iptables can introduce measurable overhead due to linear rule traversal.

eBPF, or extended Berkeley Packet Filter, allows you to run sandboxed programs in the Linux kernel without changing kernel source code or loading kernel modules. These programs can be attached to various points in the kernel, including network interfaces, system calls, and even kernel tracepoints. This allows for incredibly powerful and efficient packet filtering, modification, and redirection.

## eBPF Fundamentals for Network Policy

At its core, eBPF allows us to write small C programs (compiled to eBPF bytecode) that get loaded into the kernel. For network policy, we're primarily interested in attaching these programs to:

1.  **XDP (eXpress Data Path):** Processes packets at the earliest possible point in the network driver, even before they hit the network stack. Ideal for high-performance dropping or redirection.
2.  **TC (Traffic Control) ingress/egress hooks:** Attaches programs to the `clsact` qdisc, allowing inspection and action on packets entering or leaving a network interface *after* they've been processed by the driver but *before* they hit the full network stack (ingress) or *before* they are sent out (egress). This is often where we'll do most of our policy enforcement.
3.  **Socket filters (SO_ATTACH_BPF):** Attaches eBPF programs directly to sockets, allowing filtering of data *before* it's passed to the application or *after* it's sent by the application. This is powerful for enforcing policies based on the application's perspective.

Let's walk through a practical example: enforcing a policy that allows HTTP GET requests to a specific path (`/healthz`) but blocks all other HTTP methods and paths, even if the Layer 3/4 policy would normally allow it.

## Example: HTTP Method/Path Enforcement with eBPF

Our goal:
*   Allow HTTP GET requests to `/healthz` on port 80.
*   Block all other HTTP methods (POST, PUT, DELETE, etc.) and paths on port 80.
*   Assume standard Kubernetes Network Policies already allow traffic to port 80.

### 1. The eBPF Program (C Code)

We'll write a C program that will be compiled into eBPF bytecode. This program will be attached to the `TC ingress` hook of our pod's network interface.

```c
#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/if_ether.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Define our HTTP method and path constants
#define HTTP_GET_LEN 3
static const char http_get_str[] = "GET";
#define HTTP_HEALTHZ_LEN 7
static const char http_healthz_str[] = "/healthz";

// Helper macro to calculate pointer offset safely
#define cursor_advance(_CURSOR, _LEN) ({ _CURSOR += _LEN; })

SEC("tc")
int http_policy_enforcer(struct __sk_buff *skb) {
    void *data_end = (void *)(long)skb->data_end;
    void *data = (void *)(long)skb->data;

    struct ethhdr *eth = data;
    if (cursor_advance(eth, sizeof(*eth)) > data_end) {
        return TC_ACT_OK; // Not an Ethernet packet or truncated
    }

    // Only process IPv4 packets
    if (bpf_ntohs(eth->h_proto) != ETH_P_IP) {
        return TC_ACT_OK;
    }

    struct iphdr *ip = (struct iphdr *)(eth + 1);
    if (cursor_advance(ip, sizeof(*ip)) > data_end) {
        return TC_ACT_OK;
    }

    // Only process TCP packets
    if (ip->protocol != IPPROTO_TCP) {
        return TC_ACT_OK;
    }

    struct tcphdr *tcp = (struct tcphdr *)(ip + 1);
    // Ensure the TCP header is fully within the packet
    if (cursor_advance(tcp, sizeof(*tcp)) > data_end) {
        return TC_ACT_OK;
    }

    // Check if it's an incoming packet to port 80
    if (bpf_ntohs(tcp->dest) != 80) {
        return TC_ACT_OK; // Not for port 80, let it pass
    }

    // Check for SYN or non-data packets
    if (tcp->syn || tcp->fin || tcp->rst || (tcp->ack && !skb->len_diff)) {
        return TC_ACT_OK; // Allow TCP handshake and control packets
    }

    // Calculate TCP payload offset
    // TCP header length is in 4-byte words
    unsigned int tcp_hdr_len = tcp->doff * 4;
    void *payload = data + ETH_HLEN + (ip->ihl * 4) + tcp_hdr_len;

    if (payload + HTTP_GET_LEN + HTTP_HEALTHZ_LEN + 1 /* for space */ > data_end) {
        // Not enough data for even minimal HTTP header, allow
        return TC_ACT_OK;
    }

    // Check for "GET /healthz HTTP/1.1" (or similar)
    // We're doing a very basic string match here for demonstration.
    // A real-world scenario might involve more robust parsing.
    if (bpf_memcmp(payload, http_get_str, HTTP_GET_LEN) == 0 &&
        bpf_memcmp(payload + HTTP_GET_LEN + 1, http_healthz_str, HTTP_HEALTHZ_LEN) == 0) {
        // It's a GET /healthz request, allow it
        return TC_ACT_OK;
    }

    // If we reached here, it's an HTTP request to port 80 but not GET /healthz
    // Block it.
    bpf_printk("eBPF: Blocking non-GET /healthz request to port 80.");
    return TC_ACT_SHOT; // Drop the packet

}

char _license[] SEC("license") = "GPL";
```

**Explanation:**

*   `SEC("tc")`: This macro marks the function `http_policy_enforcer` as an eBPF program suitable for the TC hook.
*   `struct __sk_buff *skb`: The primary context for network programs, containing packet data and metadata.
*   `data` and `data_end`: Pointers defining the start and end of the packet data within the `skb`.
*   **Header Parsing:** We manually parse Ethernet, IP, and TCP headers to locate the TCP payload.
*   `bpf_ntohs`: Converts network byte order to host byte order for multi-byte fields.
*   `bpf_memcmp`: Performs a memory comparison, crucial for string matching.
*   `TC_ACT_OK`: Allows the packet to continue processing (pass).
*   `TC_ACT_SHOT`: Drops the packet (block).
*   `bpf_printk`: A simple way to log messages from the eBPF program, visible via `sudo cat /sys/kernel/debug/tracing/trace_pipe`.

### 2. Compile the eBPF Program

You'll need `clang` and `llvm` for compiling eBPF programs. The `bpftool` utility (part of `iproute2`) is also invaluable.

```bash
# Assuming your C code is in `http_policy.c`
clang -O2 -target bpf -g -c http_policy.c -o http_policy.o
```

### 3. Deploying and Attaching in Kubernetes

This is the trickiest part. In a real Kubernetes environment, you'd typically have a DaemonSet that manages eBPF program deployment. This DaemonSet would:

1.  **Identify Pod Interfaces:** For each pod on the node, determine its network interface (e.g., `eth0` within the pod, which maps to a `veth` pair on the host).
2.  **Load Program:** Use `bpftool prog load` or `libbpf` to load the compiled `http_policy.o` into the kernel.
3.  **Attach to TC:** Use `bpftool link create` or `tc filter add` to attach the loaded program to the ingress hook of the target pod's network interface.

Here's a simplified illustration of the commands you'd run *on a host* with a pod's network namespace:

```bash
# 1. Find the pod's network namespace PID
# Let's say your pod is named 'my-nginx-pod' in namespace 'default'
POD_NAME="my-nginx-pod"
POD_NS="default"

# Get the PID of a container within the pod (e.g., the first one)
# This assumes you have `docker` or `crictl` available on the node
CONTAINER_ID=$(kubectl get pod $POD_NAME -n $POD_NS -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d'/' -f2)
POD_PID=$(sudo crictl inspectp $CONTAINER_ID | grep -A1 "Pid" | tail -n1 | awk '{print $2}')

# 2. Enter the pod's