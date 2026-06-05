---
title: "Debugging Kernel Panics: A Hands-On Guide to `kdump` and `crash"
date: 2026-06-05
category: "thought-leadership"
tags: []
excerpt: "A kernel panic is arguably one of the most dreaded events for any system administrator or engineer. It means your Linux kernel has encountered a criti..."
---

# Debugging Kernel Panics: A Hands-On Guide to `kdump` and `crash`

A kernel panic is arguably one of the most dreaded events for any system administrator or engineer. It means your Linux kernel has encountered a critical, unrecoverable error and has stopped all operations. The system freezes, perhaps displaying a cryptic message on the console, and then reboots—leaving you with a blank slate and a gnawing question: "What just happened?"

While the immediate impact is clear, the underlying cause is often elusive. This is where `kdump` and `crash` become indispensable tools in your debugging arsenal. `kdump` is a kernel crash dumping mechanism that captures the state of the system's memory at the time of a panic. `crash` is an interactive utility that allows you to analyze this memory dump, providing a window into the kernel's internal state.

Let's dive into how to set up `kdump` and use `crash` to demystify those panics.

## Setting Up `kdump`: Your First Line of Defense

`kdump` works by reserving a small portion of memory that a secondary, minimal kernel can use to boot up if the primary kernel crashes. This "capture kernel" then takes a snapshot of the crashed kernel's memory and saves it to a specified location.

### Step 1: Install `kdump` Packages

First, ensure `kdump` and its associated tools are installed. The package names might vary slightly across distributions, but they are generally similar.

On RHEL/CentOS/Fedora:

```bash
sudo yum install kexec-tools crash kernel-debuginfo
# Or on modern Fedora/RHEL:
# sudo dnf install kexec-tools crash kernel-debuginfo
```

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install kdump-tools crash kernel-debuginfo-$(uname -r)
```

**Note on `kernel-debuginfo`**: This package is crucial. Without it, `crash` will have very limited symbolic information, making analysis incredibly difficult. It provides the necessary debugging symbols for your specific kernel version.

### Step 2: Configure `kdump`

The primary configuration file for `kdump` is typically `/etc/kdump.conf`. Here, you define where the dump file should be saved and other parameters.

A common configuration involves saving the dump to a local filesystem:

```bash
# /etc/kdump.conf
path /var/crash
# If you want to save to a specific device, e.g., a dedicated partition:
# target auto
# If you want to save to an NFS share:
# nfs example.com:/export/kdump
# If you want to save to a local disk, but ensure it's on a separate partition
# that isn't full or corrupted by the original crash:
# ext4 LABEL=kdump_partition
# For simplicity, we'll use a local path for now.

# Optional: Define what to do after saving the dump.
# reboot (default), poweroff, halt, shutdown
default reboot

# To specify the dump format (makedumpfile options)
# We often want to exclude zero-filled pages to save space
dump_filter 0x1f
```

After modifying `kdump.conf`, you need to enable and start the `kdump` service:

```bash
sudo systemctl enable kdump.service
sudo systemctl start kdump.service
```

### Step 3: Reserve Memory for `kdump`

This is a critical step that often requires a reboot. `kdump` needs a dedicated, contiguous block of memory that the primary kernel will *not* use. This is configured via a kernel boot parameter.

Edit your GRUB configuration file (e.g., `/etc/default/grub`):

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="... crashkernel=auto ..."
# Or manually specify size, e.g., for systems with >4GB RAM:
# GRUB_CMDLINE_LINUX_DEFAULT="... crashkernel=256M ..."
# For systems with less RAM, you might need a smaller allocation like 128M.
# 'auto' is generally a good starting point for modern systems.
```

After editing `GRUB_CMDLINE_LINUX_DEFAULT`, update GRUB and reboot:

```bash
sudo grub2-mkconfig -o /boot/grub2/grub.cfg # RHEL/CentOS
# Or on UEFI systems:
# sudo grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg
# On Debian/Ubuntu:
# sudo update-grub

sudo reboot
```

Verify `kdump` is configured by checking `cat /proc/cmdline` for `crashkernel=` and `systemctl status kdump`.

## Triggering a Test Panic

Before a real panic occurs, it's prudent to test your `kdump` setup. You can intentionally trigger a kernel panic. **WARNING: This will crash your system! Only do this on a test system.**

```bash
echo c > /proc/sysrq-trigger
```

Your system should panic, and after a moment, the `kdump` kernel should boot, save the dump, and then reboot the system. Once the system is back up, check `/var/crash` (or your configured path) for the dump file. It will typically be a directory named after the date and time of the crash.

## Analyzing the Dump with `crash`

Now that you have a `vmcore` file, it's time to use the `crash` utility.

Navigate to the directory containing your dump file. You'll typically find two key files: `vmcore` (the actual memory dump) and `vmlinux` (the uncompressed kernel image with debug symbols).

```bash
cd /var/crash/$(ls -dt /var/crash/*/ | head -1) # Go to the latest crash dump dir
```

To start `crash`, you need to provide the `vmlinux` file corresponding to the crashed kernel and the `vmcore` file:

```bash
sudo crash vmlinux vmcore
```

If you installed `kernel-debuginfo`, `crash` should automatically find the `vmlinux` file. If not, you might need to specify the path to it.

Once inside the `crash` prompt, you have a powerful set of commands:

*   **`log`**: Displays the kernel message buffer. This is often the first place to look, as it can contain the panic message itself or critical errors leading up to it.
*   **`bt`** (backtrace): Shows the backtrace of the currently active task or a specified process. For a panic, this is crucial as it reveals the call stack leading to the crash.
    ```
    crash> bt
    PID: 0      CPU: 0   COMMAND: "swapper/0"
    #0 [ffffffff818047d0] machine_kexec at ffffffff81044432
    #1 [ffffffff81804820] __crash_kexec at ffffffff8112521c
    #2 [ffffffff818048f8] crash_kexec at ffffffff8112534f
    #3 [ffffffff81804910] oops_end at ffffffff81014e42
    #4 [ffffffff81804938] no_context at ffffffff810471b8
    #5 [ffffffff81804988] bad_area at ffffffff8104764b
    #6 [ffffffff818049c8] __do_page_fault at ffffffff81047b85
    #7 [ffffffff81804a10] do_page_fault at ffffffff81047c38
    #8 [ffffffff81804a40] page_fault at ffffffff816e84d2
    [exception RIP: panic+0x163/0x1c3] # This is where the panic was called
    ```
    In this example, the panic was explicitly triggered by `panic()`. In a real scenario, you'd see the functions that led to the error.
*   **`ps`**: Lists all processes, similar to `ps -ef`. Useful for identifying what processes were running.
*   **`mod`**: Lists loaded kernel modules. A recently loaded or updated module is a common culprit.
*   **`sym <symbol_name>`**: Translates a kernel symbol (function or variable name) to its address, or vice-versa.
*   **`rd <address>`**: Reads memory at a specific address. Useful for inspecting kernel data structures.
*   **`struct <structure_name>`**: Dumps the definition of a kernel data structure.
*   **`dev`**: Shows device information.
*   **`help`**: Provides a list of all `crash` commands.

### Example Walkthrough: Analyzing a Null Pointer Dereference

Imagine your `bt` output shows something like this:

```
crash> bt
PID: 1234  CPU: 2   COMMAND: "my_bad_driver"
#0 [ffff88007a012340] my_bad_driver_function at ffffffffa0001234 [my_bad_driver]
#1 [ffff88007a012380] another_driver_function at ffffffffa0001456 [my_bad_driver]
#2 ...
```

And the `log` shows:

```
BUG: unable to handle kernel NULL pointer dereference at 0000000000000008
IP: [<ffffffffa0001234>] my_bad_driver_function+0x20/0x100 [my_bad_driver]
PGD 1234567890 PUD abcdef0123 PMD fedcba9876 PTE 6543210fed
Oops: 0000 [#1] SMP
```

This immediately points to `my_bad_driver_function` in the `my_bad_driver` module. The `NULL pointer dereference at 0000000000000008` suggests an attempt to access memory at a very low address, which is typically invalid for kernel code.

With the `kernel-debuginfo` installed, `crash` can often even show you the source line:

```
crash> dis -l my_bad_driver_function+0x20
/path/to/my_bad_driver/source.c:123  <-- This line is a direct hit!
ffffffffa0001234:       mov    (%rdi),%eax
