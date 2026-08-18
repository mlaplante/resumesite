---
title: "Unveiling the Linux Kernel's Dark Corners: Debugging with KProbes and Ftrace"
date: 2026-08-18
category: "thought-leadership"
tags: ["linux", "kernel", "debugging", "kprobes", "ftrace", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Debugging issues that manifest deep within the Linux kernel can feel like navigating a maze blindfolded. Standard user-space tools like gdb are often..."
---

# Unveiling the Linux Kernel's Dark Corners: Debugging with KProbes and Ftrace

Debugging issues that manifest deep within the Linux kernel can feel like navigating a maze blindfolded. Standard user-space tools like `gdb` are often insufficient, and recompiling the kernel for every potential theory is a non-starter in production environments. This is where dynamic instrumentation tools like KProbes and the powerful Ftrace framework become indispensable. They allow us to peer into the kernel's execution flow, observe function calls, and even extract runtime data without modifying source code or rebooting.

As an SVP of Information Security and Operations, I've seen firsthand how crucial these capabilities are when diagnosing elusive performance regressions, intermittent system hangs, or even suspicious activity that points to kernel-level compromise. Let's peel back the layers and explore how to leverage KProbes and Ftrace effectively.

## The Power of Ftrace: Your Kernel's Built-in Flight Recorder

Ftrace is a tracing framework built directly into the Linux kernel. It's incredibly versatile, capable of tracing function calls, scheduling events, I/O operations, and much more. Think of it as a low-overhead flight recorder for your kernel.

The primary interface for Ftrace is through the `debugfs` filesystem, typically mounted at `/sys/kernel/debug/tracing`.

Let's start with a simple example: tracing all function calls within the kernel.

```bash
# Ensure debugfs is mounted
sudo mount -t debugfs none /sys/kernel/debug

# Clear previous traces
echo nop | sudo tee /sys/kernel/debug/tracing/current_tracer
echo > sudo /sys/kernel/debug/tracing/trace

# Enable function tracing
echo function | sudo tee /sys/kernel/debug/tracing/current_tracer

# Start tracing
echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on

# Perform some activity, e.g., run a command
ls -l /tmp

# Stop tracing
echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on

# View the trace output
sudo cat /sys/kernel/debug/tracing/trace
```

The output will be voluminous, showing every function call. This is often too much information. Ftrace allows for powerful filtering. For instance, to trace only functions related to the `ext4` filesystem:

```bash
echo function | sudo tee /sys/kernel/debug/tracing/current_tracer
echo 'ext4_*' | sudo tee /sys/kernel/debug/tracing/set_ftrace_filter
echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on
# ... perform ext4 related activity ...
echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on
sudo cat /sys/kernel/debug/tracing/trace
```

This significantly narrows down the output, making it much more manageable. You can also filter by process ID (`set_ftrace_pid`) or apply more complex filtering rules.

**Actionable Takeaway:** When faced with performance issues, start with `function_graph` tracer (instead of `function`) to get a call graph view, which helps visualize function nesting and identify hot paths. Then, use `set_ftrace_filter` to target specific subsystems or drivers based on your initial hypotheses.

## KProbes: Dynamic Instrumentation at Your Fingertips

While Ftrace provides excellent general-purpose tracing, KProbes (Kernel Probes) offer a more granular and dynamic way to instrument the kernel. KProbes allow you to set breakpoints (probes) at almost any instruction in the kernel, execute custom code when that breakpoint is hit, and collect data from kernel memory or CPU registers.

There are two main types of KProbes:

1.  **Kprobes:** Placed at the entry point of a kernel function.
2.  **Kretprobes:** Placed at the return point of a kernel function.

You can interact with KProbes via the `trace_events` interface in `debugfs`. Let's say we want to know when the `sys_openat` system call is invoked and what arguments it receives.

First, identify the kernel function name. You can often guess it (e.g., `sys_openat` for `openat`), or use `grep` on `/proc/kallsyms`.

```bash
# Add a kprobe to sys_openat
# The 'p' prefix indicates a probe.
# The 'sys_openat' is the function name.
# The 'filename' argument is the second argument (after pt_regs *regs)
# which is at offset 8 in the pt_regs struct on x86_64, but easier to
# access via $arg2.
echo 'p:my_open_probe sys_openat filename=%s $arg2' | sudo tee /sys/kernel/debug/tracing/kprobe_events

# Enable the trace event
echo 1 | sudo tee /sys/kernel/debug/tracing/events/kprobes/my_open_probe/enable

# Clear trace buffer and enable tracing
echo > sudo /sys/kernel/debug/tracing/trace
echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on

# Perform some file operations
touch /tmp/testfile.txt
cat /etc/passwd

# Stop tracing
echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on

# View the trace
sudo cat /sys/kernel/debug/tracing/trace | grep my_open_probe

# Disable and remove the probe
echo 0 | sudo tee /sys/kernel/debug/tracing/events/kprobes/my_open_probe/enable
echo '-:my_open_probe' | sudo tee /sys/kernel/debug/tracing/kprobe_events
```

In the `kprobe_events` syntax:
*   `p:` indicates a kprobe.
*   `my_open_probe` is a user-defined event name.
*   `sys_openat` is the function to probe.
*   `filename=%s $arg2` tells the tracer to print the second argument (`$arg2`) as a string (`%s`). `$arg1`, `$arg2`, etc., correspond to the first, second, etc., arguments of the probed function. Other special registers like `$retval` (for kretprobes) and `$stack` are also available.

**Real-World Scenario:** Imagine a system experiencing unusual disk I/O. You suspect a rogue process or a misbehaving kernel module. You could use KProbes to trace `vfs_write` or `ext4_file_write_iter` to see which process is writing what data, and to which file.

```bash
# Probe vfs_write to see filename and data size
# $arg1 is struct file *, $arg2 is const char __user *, $arg3 is size_t
# We can dereference the struct file* to get the dentry and then the name
# This requires more advanced syntax, often better handled by BPF/perf.
# For simplicity, let's focus on a simpler probe:
echo 'p:my_write_probe vfs_write file_path=%s:string($arg1->f_path.dentry->d_name.name) write_len=%zu $arg3' | sudo tee /sys/kernel/debug/tracing/kprobe_events
# ... (enable, trace, disable, remove as above) ...
```

*Self-correction:* While the above `vfs_write` example is illustrative, directly dereferencing complex kernel structures like `f_path.dentry->d_name.name` in `kprobe_events` can be tricky and kernel version-dependent. For robust, complex data extraction, tools like `perf` with its `kprobe` functionality or even better, eBPF programs, provide much more flexibility and safety. However, for simpler arguments like integers or pointers to strings (where the string itself is directly passed), `kprobe_events` is perfectly adequate.

## Combining Forces: Ftrace and KProbes for Deeper Insight

Often, you'll use Ftrace for a broad overview and then narrow down your investigation using KProbes for specific points of interest.

**Example:** You notice high CPU usage reported by Ftrace's `function_graph` tracer pointing to a specific internal kernel function, say `my_driver_work_handler`. You don't know why it's being called so frequently.

1.  **Ftrace Initial Scan:**
    ```bash
    echo function_graph | sudo tee /sys/kernel/debug/tracing/current_tracer
    echo my_driver_work_handler | sudo tee /sys/kernel/debug/tracing/set_ftrace_filter
    echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on
    # ... observe the frequency ...
    echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on
    sudo cat /sys/kernel/debug/tracing/trace
    ```
    This shows you *when* it's called.

2.  **KProbe for Context:** Now, you want to know *what triggers it* or *what data it's processing*.
    ```bash
    # Assuming my_driver_work_handler takes a 'struct work_struct *work' as its argument
    echo 'p:my_work_probe my_driver_work_handler work_addr=%lx $arg1' | sudo tee /sys/kernel/debug/tracing/kprobe_events
    echo 1 | sudo tee /sys/kernel/debug/tracing/events/kprobes/my_work_probe/enable
    echo > sudo /sys/kernel/debug/tracing/trace
    echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on
    # ... trigger the issue ...
    echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on
    sudo cat /sys/kernel/debug/tracing/trace | grep my_work_probe
    ```
    This allows you to see the address of the `work_struct` that triggered the handler. You could then potentially correlate this address with other kernel data structures if you have kernel source access or debug symbols.

**Actionable Takeaway:** Don't be afraid to iterate. Start broad with Ftrace, identify suspicious areas, and then use KProbes to inject targeted breakpoints to extract precise data points that confirm or deny your hypotheses.

## Important Considerations and Best Practices

*   **Overhead:** While Ftrace and KProbes are designed for low overhead, extensive tracing, especially with complex KProbes, can impact system performance. Always be mindful of the scope and duration of your tracing.
*   **Kernel Version Dependency:** Kernel internals (struct layouts, function signatures) can change between kernel versions. KProbes that rely on specific offsets or argument orders might break. Always test in a non-production environment first.
*   **Permissions:** You need root privileges to interact with `debugfs` and enable tracing.
*   **Cleanup:** Always remember to disable