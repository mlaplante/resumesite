---
title: "Unlocking PostgreSQL Performance with Custom eBPF Probes"
date: 2026-06-06
category: "thought-leadership"
tags: []
excerpt: "As an SVP of Information Security and Operations, I've seen countless systems buckle under the weight of an unoptimized database. PostgreSQL, while ro..."
---

# Unlocking PostgreSQL Performance with Custom eBPF Probes

As an SVP of Information Security and Operations, I've seen countless systems buckle under the weight of an unoptimized database. PostgreSQL, while robust and feature-rich, is no exception. While we have an arsenal of tools like `pg_stat_statements`, `EXPLAIN ANALYZE`, and system-level metrics, sometimes we need to peer even deeper into the kernel to understand truly elusive performance bottlenecks. This is where eBPF shines, offering an unprecedented level of observability without altering application code or increasing the overhead of traditional tracing.

Today, I want to walk through how we can leverage custom eBPF probes to gain insights into specific PostgreSQL internal functions, focusing on a common bottleneck: buffer cache contention.

## Why eBPF for PostgreSQL?

Traditional monitoring tools often provide aggregated statistics or require significant instrumentation to get granular details. When you're trying to diagnose a query that's sporadically slow, or understand why a specific `VACUUM` run is impacting performance more than others, a higher-resolution lens is needed.

eBPF (extended Berkeley Packet Filter) allows us to execute small, sandboxed programs in the Linux kernel. This means we can dynamically attach probes to kernel functions, user-space functions, and even tracepoints, collecting data with minimal overhead. For PostgreSQL, this translates to:

1.  **Observing Internal Functions:** Pinpoint exactly when and how often specific PostgreSQL internal functions are called.
2.  **Low Overhead:** Because eBPF runs in the kernel, it's incredibly efficient, making it suitable for production environments.
3.  **Dynamic Tracing:** No need to recompile PostgreSQL or restart services to add new probes.
4.  **Contextual Data:** Capture arguments and return values of functions, providing rich context to the performance puzzle.

## Identifying a Target: Buffer Cache Contention

One common area of contention in high-transaction PostgreSQL environments is the buffer manager, specifically acquiring and releasing buffer pins. When a backend needs to read a page from disk or memory, it must "pin" that buffer in shared memory to ensure it's not evicted or modified by another process until it's done. Excessive pinning or contention for these pins can lead to significant delays.

Let's target the `BufferGetAndPin` function within PostgreSQL. This function is critical for acquiring a buffer and pinning it. By observing its calls and durations, we can identify if buffer contention is a significant factor.

## Setting Up Your Environment

To follow along, you'll need:

*   A Linux environment (Ubuntu 20.04+ or similar)
*   PostgreSQL installed (we'll assume a standard installation)
*   `bcc` tools (BPF Compiler Collection) installed: `sudo apt install bpfcc-tools linux-headers-$(uname -r)`
*   PostgreSQL debug symbols: `sudo apt install postgresql-$(pg_config --version | sed -e 's/PostgreSQL //g' -e 's/\..*//g')-dbgsym` (adjust version as needed)

**Important Note:** Debug symbols are crucial for `uprobe` to correctly resolve function offsets.

## Crafting Our eBPF Probe

We'll use `uprobe` (user-space probe) to attach to `BufferGetAndPin`. Our eBPF program will record the timestamp when the function is entered and calculate the duration when it exits.

Here's a simplified `bpf_program.py` script:

```python
#!/usr/bin/python3
from bcc import BPF
import ctypes as ct

# Define a structure for our output data
class Data(ct.Structure):
    _fields_ = [
        ("pid", ct.c_ulong),
        ("duration_ns", ct.c_ulonglong),
        ("buffer_id", ct.c_int),
    ]

# eBPF C program
bpf_text = """
#include <uapi/linux/ptrace.h>
#include <linux/sched.h>

// Define a hash map to store entry timestamps
BPF_HASH(start, u64);

// Define a perf buffer for outputting results
BPF_PERF_OUTPUT(events);

// Probe entry of BufferGetAndPin
int buffer_get_and_pin_entry(struct pt_regs *ctx) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start.update(&pid_tgid, &ts);
    return 0;
}

// Probe return of BufferGetAndPin
// We expect the buffer_id to be returned in RAX (x86-64 calling convention)
int buffer_get_and_pin_return(struct pt_regs *ctx) {
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 *tsp = start.lookup(&pid_tgid);
    if (tsp == 0) {
        return 0;   // Missed entry
    }

    u64 duration_ns = bpf_ktime_get_ns() - *tsp;
    start.delete(&pid_tgid);

    int buffer_id = PT_REGS_RC(ctx); // Return value (RAX on x86_64)

    struct Data data = {};
    data.pid = pid_tgid >> 32;
    data.duration_ns = duration_ns;
    data.buffer_id = buffer_id;

    events.perf_submit(ctx, &data, sizeof(data));
    return 0;
}
"""

# Get the path to the PostgreSQL executable
# This typically points to the main postgres binary, not pg_ctl or similar.
# You might need to adjust this based on your installation.
# For example: `/usr/lib/postgresql/14/bin/postgres`
postgres_path = "/usr/lib/postgresql/14/bin/postgres" # Adjust your version here

# Initialize BPF
b = BPF(text=bpf_text)

# Attach u(ret)probes
b.attach_uprobe(name=postgres_path, sym="BufferGetAndPin", fn_name="buffer_get_and_pin_entry")
b.attach_uretprobe(name=postgres_path, sym="BufferGetAndPin", fn_name="buffer_get_and_pin_return")

print("Tracing BufferGetAndPin... Hit Ctrl-C to stop.")
print(f"{'PID':<7} {'BUFFER_ID':<12} {'DURATION_US':<12}")

# Process events
def print_event(cpu, data, size):
    event = ct.cast(data, ct.POINTER(Data)).contents
    print(f"{event.pid:<7} {event.buffer_id:<12} {event.duration_ns / 1000:<12.2f}")

b.perf_buffer_open(print_event)

while True:
    try:
        b.perf_buffer_poll()
    except KeyboardInterrupt:
        exit()
```

## How the eBPF Script Works

1.  **`BPF_HASH(start, u64);`**: This creates a kernel-space hash map to store the entry timestamp for each `pid_tgid` (process ID + thread group ID). When `BufferGetAndPin` is called, we store `bpf_ktime_get_ns()` in this map.
2.  **`BPF_PERF_OUTPUT(events);`**: This sets up a perf buffer, which is a high-performance way for kernel-space eBPF programs to send data to user-space.
3.  **`buffer_get_and_pin_entry`**: This function is attached as a `uprobe` to the entry point of `BufferGetAndPin`. It records the current nanosecond timestamp.
4.  **`buffer_get_and_pin_return`**: This function is attached as a `uretprobe` to the return point of `BufferGetAndPin`.
    *   It retrieves the entry timestamp from the `start` hash map.
    *   Calculates the `duration_ns`.
    *   `PT_REGS_RC(ctx)`: This macro is crucial. It extracts the return value of the probed function. For x86-64, return values are typically in the `RAX` register. `BufferGetAndPin` returns the `Buffer` ID on success, which is exactly what we want.
    *   It then populates a `Data` struct and sends it to user-space via `events.perf_submit`.
5.  **Python User-Space:** The Python script loads the C code, attaches the probes, and then continuously polls the `perf_buffer` to print the collected events.

## Running and Interpreting

1.  Save the script as `buffer_pin_trace.py`.
2.  Make it executable: `chmod +x buffer_pin_trace.py`.
3.  Run it: `sudo ./buffer_pin_trace.py`.

Now, perform some operations on your PostgreSQL database – run a few queries, especially those that involve reading many pages. You should start seeing output like this:

```
Tracing BufferGetAndPin... Hit Ctrl-C to stop.
PID     BUFFER_ID    DURATION_US
2456    1            12.34
2456    2            8.12
2457    1024         15.67
2458    5            9.87
...
```

**What to look for:**

*   **High `DURATION_US`:** If you see consistently high durations for `BufferGetAndPin` calls, especially for frequently accessed buffers (`BUFFER_ID`), this is a strong indicator of contention.
*   **Correlation with `PID`:** Do certain PIDs (PostgreSQL backend processes) consistently show higher durations? This could point to specific queries or sessions causing the contention.
*   **Specific `BUFFER_ID`s:** While `BUFFER_ID` isn't directly the `relfilenode` or `block_number`, it's an internal shared buffer identifier. If a few IDs frequently appear with high durations, it suggests contention on those specific shared buffers. You can then correlate this with `pg_buffercache` or `pg_stat_statements` to understand which relations are occupying those buffers.

## Actionable Takeaways

Once you've identified high contention on `BufferGetAndPin`, here are some steps you can take:

1.  **Optimize Queries:** Review `pg_stat_statements` for queries that perform many sequential scans or touch a large number of blocks. `EXPLAIN ANALYZE` these queries to find opportunities for index improvements, better join strategies, or reducing data touched.
2.  **Increase `shared_buffers`:** If your system has ample RAM, increasing `shared_buffers` can reduce the need to read from disk, thus reducing the workload on the buffer manager. However, be mindful of over-allocating, as it can lead to other issues.