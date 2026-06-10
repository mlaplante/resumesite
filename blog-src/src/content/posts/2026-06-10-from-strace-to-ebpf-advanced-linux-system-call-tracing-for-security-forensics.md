---
title: "From Strace to eBPF Advanced Linux System Call Tracing for Security Forensics"
date: 2026-06-10
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As security professionals and system administrators, understanding what's happening under the hood of our Linux systems is paramount. When an incident..."
---

# From Strace to eBPF: Advanced Linux System Call Tracing for Security Forensics

As security professionals and system administrators, understanding what's happening under the hood of our Linux systems is paramount. When an incident occurs or when we need to deeply inspect system behavior, tracing system calls is a fundamental technique. For years, `strace` has been the go-to tool for this. However, the landscape of system observability has evolved dramatically, and `eBPF` (extended Berkeley Packet Filter) offers a powerful, more performant, and flexible alternative for advanced system call tracing, particularly in security forensics.

## The Familiar Friend: `strace`

`strace` works by intercepting and recording the system calls made by a process and the signals it receives. It's incredibly useful for debugging and understanding the interactions between a program and the kernel.

**Basic Usage:**

To trace all system calls made by a process, you can use:

```bash
strace -p <PID>
```

Or to run a command and trace its system calls:

```bash
strace your_command arguments
```

**Example:** Let's see what `ls -l` does:

```bash
strace ls -l
```

You'll see output like this, showing `openat`, `read`, `write`, `close`, etc.

```
...
openat(AT_FDCWD, ".", O_RDONLY|O_NONBLOCK|O_DIRECTORY|O_CLOEXEC) = 3
getdents64(3, /* 2 entries */, 32768)     = 128
readlinkat(AT_FDCWD, "my_file.txt", 4096) = 11
...
```

**Limitations of `strace`:**

While powerful, `strace` has some significant drawbacks, especially in a security context:

*   **Performance Overhead:** `strace` intercepts *every* system call and prints it to userspace. For busy processes or during high-volume events, this can introduce substantial performance degradation, potentially altering the very behavior you're trying to observe or even causing the system to become unresponsive.
*   **Limited Filtering and Aggregation:** Filtering and aggregating `strace` output often requires piping its output to other tools like `grep`, `awk`, or `sed`. This further increases overhead and can be cumbersome for complex analysis.
*   **Kernel-Level vs. Userspace:** `strace` operates by injecting a `ptrace` call for each syscall, which involves context switches between kernel and userspace. This is inherently inefficient.
*   **Data Retention:** `strace` typically outputs to the console or a file in real-time. Capturing historical data for forensic analysis can be challenging without prior setup.

## The Next Generation: `eBPF`

`eBPF` is a revolutionary technology that allows you to run sandboxed programs within the Linux kernel itself. These programs are attached to various hooks, including kprobes and tracepoints, and can inspect and manipulate network packets, trace kernel events, and much more. For system call tracing, `eBPF` offers a paradigm shift.

Instead of pulling data *out* of the kernel for every event, `eBPF` programs run *inside* the kernel, processing data and only sending necessary summaries or specific events to userspace. This drastically reduces overhead.

### How `eBPF` Traces System Calls

`eBPF` can hook into kernel functions that are triggered by system calls. Common attachment points include:

*   **Tracepoints:** Predefined static hooks in the kernel that mark specific events (e.g., `sys_enter` and `sys_exit` for system calls).
*   **Kprobes:** Dynamic probes that can be attached to almost any kernel function.

When a system call occurs, the `eBPF` program attached to the relevant tracepoint or kprobe executes *in kernel space*. This program can then:

1.  **Collect Data:** Access context information about the system call (PID, command name, arguments, return value).
2.  **Filter:** Decide if the event is relevant based on predefined criteria.
3.  **Aggregate:** Count occurrences, sum values, or build histograms *within the kernel*.
4.  **Send to Userspace:** Efficiently send only the processed data or specific events to a userspace collector via BPF maps or perf buffers.

### `eBPF` Tools for System Call Tracing

While you can write raw `eBPF` programs, several user-friendly tools leverage `eBPF` for system call tracing:

*   **`bpftrace`:** A high-level tracing language for `eBPF`. It has a syntax similar to `awk` and `C` and is incredibly powerful for quickly writing custom tracing scripts.
*   **`bcc` (BPF Compiler Collection):** A toolkit for creating efficient BPF-powered applications. It provides Python and Lua frontends to simplify writing `eBPF` programs.

### `bpftrace` Example: Tracing `execve`

Let's replicate some of `strace`'s functionality but with `eBPF`'s efficiency. We'll trace all `execve` system calls, which are used to execute new programs.

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%s called execve(%s)\n", comm, str(args->filename)); }'
```

**Explanation:**

*   `sudo bpftrace -e '...'`: Runs `bpftrace` with a provided script.
*   `tracepoint:syscalls:sys_enter_execve`: This is the hook. It triggers just before the `execve` system call is executed.
*   `{ ... }`: The action block that runs when the hook is triggered.
*   `printf(...)`: Prints output to the console.
*   `comm`: A built-in `bpftrace` variable representing the command name.
*   `str(args->filename)`: Accesses the `filename` argument of the `execve` system call and converts it to a string.

**Output Example:**

```
Attaching 1 probe...
bash called execve(/usr/bin/ls)
bash called execve(/usr/bin/vim)
```

This is much more efficient than `strace` because the filtering and printing happen entirely within the kernel.

### `bpftrace` Example: Tracking File Access by a Specific Process

For forensics, we might want to know which files a specific suspicious process is accessing.

```bash
# Find the PID of the suspicious process, e.g., 'suspicious_app'
PID=$(pgrep suspicious_app)

# Trace all syscalls for that PID, focusing on file operations
sudo bpftrace -p $PID -e 'tracepoint:syscalls:sys_enter_* /pid == $PID/ { @syscalls[probe] = count(); } tracepoint:syscalls:sys_exit_* /pid == $PID/ { @syscalls[probe] = count(); } END { print(@syscalls); }'
```

**Explanation:**

*   `-p $PID`: Attaches `bpftrace` to the specific process ID.
*   `tracepoint:syscalls:sys_enter_*` and `tracepoint:syscalls:sys_exit_*`: Hooks into the entry and exit of *all* system calls. The asterisk is a wildcard.
*   `/pid == $PID/`: A filter to ensure we only process events from our target PID.
*   `@syscalls[probe] = count()`: An `eBPF` map (associative array) where keys are probe names and values are counts. This aggregates counts of each system call.
*   `END { print(@syscalls); }`: After tracing, print the aggregated counts.

This example shows how `eBPF` can aggregate data *in kernel* before sending it to userspace. This is crucial for long-running investigations where the volume of raw syscall data could be overwhelming.

### `bcc` Example: A More Structured Approach

`bcc` allows you to write `eBPF` programs in C and embed them within Python scripts. This offers more programmatic control and is excellent for building custom forensic tools.

Here's a simplified `bcc` example to trace `openat` calls with their filenames:

```python
#!/usr/bin/python3

from bcc import BPF
import sys

# eBPF program
bpf_text = """
#include <uapi/linux/ptrace.h>
#include <linux/sched.h>

BPF_HASH(syscall_counts, u64, u64);

int syscall__openat(struct pt_regs *ctx) {
    u64 id = bpf_get_current_pid_tgid();
    u64 *count = syscall_counts.lookup_or_init(&id, 0);
    (*count)++;
    return 0;
}
"""

# Load BPF program
b = BPF(text=bpf_text)

# Attach to the sys_enter_openat tracepoint
# Note: tracepoint names can vary slightly between kernel versions
try:
    b.attach_tracepoint(tp="syscalls:sys_enter_openat", fn_name="syscall__openat")
except ValueError:
    # Fallback for older kernels or different naming conventions
    try:
        b.attach_kprobe(event="sys_openat", fn_name="syscall__openat")
    except Exception as e:
        print(f"Failed to attach kprobe for sys_openat: {e}")
        sys.exit(1)


print("Tracing sys_enter_openat syscalls... Hit Ctrl-C to end.")

try:
    while True:
        # You would typically process data from BPF maps here.
        # For simplicity, we'll just let it run and show how to access data later.
        pass
except KeyboardInterrupt:
    print("\nTracing stopped. Displaying syscall counts per PID:")
    for pid, count in b["syscall_counts"].items():
        print(f"PID {pid.value}: {count.value} openat calls")

```

**Explanation:**

*   `BPF(text=bpf_text)`: Compiles and loads the `eBPF` C code.
*   `b.attach_tracepoint(...)` or `b.attach_kprobe(...)`: Attaches the `eBPF` function `syscall__openat` to the kernel event.
*   `bpf_get_current_pid_tgid()`: Retrieves the process ID and thread group ID.
*   `BPF_HASH(...)`: Defines a hash map in `eBPF` to store counts per PID.
*   The Python script then periodically (or on interrupt) reads the data from the `syscall_counts` map.

This approach is more involved but provides a solid foundation for building sophisticated, custom forensic tools that can monitor specific system call patterns, detect anomalies, or log critical activities with minimal performance impact.

## `eBPF` for Security Forensics: Key Advantages

1.  **Low Overhead:** `e