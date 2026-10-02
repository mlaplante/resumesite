---
title: "Pinpointing Elusive Network Glitches with `perf trace` and `tc qdisc"
date: 2026-10-02
category: "thought-leadership"
tags: ["networking", "linux", "debugging", "performance", "tc", "perf"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Intermittent network issues are the bane of every engineer's existence. They defy easy reproduction, vanish upon closer inspection, and often leave a..."
---

Intermittent network issues are the bane of every engineer's existence. They defy easy reproduction, vanish upon closer inspection, and often leave a trail of "it just felt slow for a second" complaints. When `ping` shows no packet loss and `netstat` looks normal, where do you turn? This is where diving deeper into kernel-level tracing with `perf trace` and strategically manipulating network queues with `tc qdisc` can provide invaluable insights.

Forget the black box. We're going to illuminate the kernel's network stack to understand *exactly* what's happening to those packets during those fleeting moments of trouble.

## The Problem with Intermittency

Imagine a microservice that occasionally experiences a 500ms spike in latency when communicating with its database, but only under specific, hard-to-reproduce load patterns. Standard monitoring might catch an average latency increase, but not the specific *cause* of those individual spikes. Is it application logic? Database contention? Or a fleeting network hiccup that drops a single SYN packet, causing a retransmission delay?

Traditional tools like `tcpdump` are great for capturing packets, but they often generate too much data for intermittent issues, and they don't tell you *why* a packet was dropped or delayed within the kernel itself.

## Enter `perf trace`: Kernel-Level Packet Journey

`perf trace` (part of the Linux `perf` suite) allows us to tap into kernel tracepoints, providing a granular view of system calls, kernel functions, and even specific network events. For our intermittent network issue, we're particularly interested in events related to packet transmission and reception.

Let's say we suspect packets are being dropped *within* the kernel before they even hit the wire, perhaps due to a full transmit queue or an overloaded network interface card (NIC) driver.

### Tracing Packet Drops and Delays

We can use `perf trace` to monitor various network-related tracepoints. A good starting point for outbound traffic is looking at `net` events:

```bash
# Start perf trace in the background, capturing network events
# We're interested in 'net' events, specifically those related to 'dev_queue' and 'xmit'
# -e net:net_dev_queue: This tracepoint fires when a packet is enqueued to a device's transmit queue.
# -e net:net_dev_xmit: This tracepoint fires when a packet is handed to the device driver for transmission.
# -o perf.data: Store output to a file for later analysis.
sudo perf trace -e net:net_dev_queue,net:net_dev_xmit -o perf.data &
PERF_PID=$!
```

Now, while this is running, try to reproduce your intermittent issue. Once you've observed the problem, stop `perf trace`:

```bash
sudo kill $PERF_PID
sudo perf script -i perf.data | less
```

The output can be extensive, but you'll see lines like:

```
           <...>-7390  [002] 10043.123456: net:net_dev_queue: dev=eth0 skbaddr=0xffff88810c3f0000 len=64 proto=0x0800
           <...>-7390  [002] 10043.123460: net:net_dev_xmit: dev=eth0 skbaddr=0xffff88810c3f0000 len=64 proto=0x0800
```

This shows a packet being enqueued and then transmitted. If you see `net_dev_queue` but *no corresponding `net_dev_xmit`* for a given `skbaddr` (SKB address, which identifies a specific packet buffer in the kernel), it suggests the packet was dropped *after* being enqueued but *before* being handed to the driver. This is a strong indicator of a full transmit queue.

For inbound traffic, you might look at `net:netif_receive_skb` or `net:napi_gro_receive` to see when packets are received by the driver and processed by NAPI.

**Actionable Takeaway:** Use `perf trace -e <tracepoint_group>:<tracepoint_name>` to pinpoint where packets are being dropped or delayed within the kernel. Start with broad `net:` tracepoints and narrow down as you gain insight.

## `tc qdisc`: Manipulating and Observing Queue Behavior

If `perf trace` suggests transmit queue issues, `tc qdisc` (traffic control queueing discipline) becomes your best friend. `tc qdisc` allows you to inspect and modify the kernel's packet queueing behavior.

By default, most interfaces use a `pfifo_fast` qdisc or a `fq_codel` qdisc. These are generally efficient, but under specific bursty loads, their internal buffers can fill up.

### Identifying Queue Drops

First, inspect the current qdisc and statistics for your interface (e.g., `eth0`):

```bash
tc -s qdisc show dev eth0
```

You'll get output similar to this:

```
qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024 quantum 1514 target 5.0ms interval 100.0ms memory_limit 32Mb ecn
 Sent 123456789 bytes 1234567 packets (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
  maxpacket 1514 drop_count 0 ecn_mark 0 new_flow_count 1234 flows_plimit 0
```

The `dropped` counter under `Sent` is crucial. If this number is increasing during your intermittent issue, it directly confirms that packets are being dropped by the qdisc *before* they even reach the NIC driver. The `overlimits` counter can also indicate congestion.

### Artificially Introducing Delay to Pinpoint Bottlenecks

Sometimes, you need to isolate *which* hop is introducing latency. You can use `tc qdisc add` to intentionally add delay or loss to an interface. This might seem counterintuitive, but it helps confirm if a specific link or service is sensitive to even minor network impairments.

For example, to add a 100ms delay to all outbound packets on `eth0`:

```bash
sudo tc qdisc add dev eth0 root netem delay 100ms
```

To add 1% packet loss:

```bash
sudo tc qdisc add dev eth0 root netem loss 1%
```

**Crucially, remember to remove these rules after testing:**

```bash
sudo tc qdisc del dev eth0 root
```

By adding a small, controlled delay, you can see if your application's "intermittent glitch" becomes a consistent, reproducible problem. If it does, it strongly suggests your application or a downstream service is highly sensitive to network latency, even if the underlying network isn't "broken." This shifts your investigation from "network is dropping packets" to "application is sensitive to typical network conditions."

### Monitoring Queue Lengths with `watch`

You can combine `tc -s qdisc show` with `watch` to get a real-time view of queue statistics:

```bash
watch -n 1 'tc -s qdisc show dev eth0'
```

This lets you observe the `dropped` and `backlog` counters dynamically as your intermittent issue occurs. A rapidly increasing `dropped` count or a growing `backlog` indicates congestion at the qdisc level.

**Actionable Takeaway:** Use `tc -s qdisc show dev <interface>` to monitor packet drops and queue backlog. If drops occur, consider tuning your qdisc or investigating upstream congestion. Use `tc qdisc add dev <interface> root netem delay <X>ms` to artificially introduce delay and test application resilience.

## Putting It Together: A Debugging Scenario

Let's revisit our microservice with the intermittent latency spikes.

1.  **Initial Observation:** Monitoring shows occasional 500ms latency spikes to the database. `ping` is fine.
2.  **Hypothesis:** Could be kernel-level packet drops on the microservice's outbound interface, causing retransmissions.
3.  **`perf trace` Investigation:**
    *   Start `sudo perf trace -e net:net_dev_queue,net:net_dev_xmit -o perf.data &`
    *   Reproduce the latency spike.
    *   Stop `perf trace` and analyze `perf script -i perf.data`.
    *   **Finding:** You observe instances where `net:net_dev_queue` appears for database-bound packets, but no corresponding `net:net_dev_xmit` shortly after. This points to drops *within* the qdisc.
4.  **`tc qdisc` Validation:**
    *   Start `watch -n 1 'tc -s qdisc show dev eth0'` (assuming `eth0` is the outbound interface).
    *   Reproduce the latency spike.
    *   **Finding:** The `dropped` counter for `eth0`'s qdisc visibly increments during the spike. This confirms packets are being dropped at the queueing discipline level.
5.  **Root Cause Analysis:** Why are packets being dropped by the qdisc?
    *   Is the application sending bursts of data that overwhelm the default qdisc buffer?
    *   Is the underlying NIC driver struggling?
    *   Is the CPU overloaded, preventing the kernel from processing the network stack fast enough?
6.  **Potential Solution/Mitigation:**
    *   **Tune `tc qdisc`:** Experiment with different qdiscs or adjust parameters. For example, `fq_codel` is generally good for latency-sensitive traffic. You might increase the `limit` for `pfifo_fast` or adjust `target` for `fq_codel`.
        ```bash
        # Example: Increase pfifo_fast length (use with caution, can increase bufferbloat)
        # sudo tc qdisc replace dev eth0 root pfifo_fast limit 1000
        # Example: Replace with fq_codel if not already in use
        # sudo tc qdisc replace dev eth0 root fq_codel
        ```
    *   **Application-level pacing:** Can the application be modified to send data less burstily?
    *   **Hardware upgrade:** Is the NIC itself a bottleneck under heavy load?

## Conclusion

Debugging intermittent network glitches requires moving beyond surface-level observations. `perf trace` gives you X-ray vision into the kernel's network stack, revealing precisely where packets are processed, delayed, or dropped. `tc qdisc` provides the complementary ability to inspect, monitor, and even manipulate these critical packet queues. By combining these powerful Linux tools, you can transform elusive "it just felt slow" complaints into concrete, actionable insights, leading to more robust and performant systems. Remember, the kernel isn't a black box; it's an incredibly detailed system waiting to tell you its story. You just need the right tools to listen.