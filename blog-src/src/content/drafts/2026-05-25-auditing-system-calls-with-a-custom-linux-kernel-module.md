---
title: "Auditing System Calls With a Custom Linux Kernel Module"
date: 2026-05-25
category: "thought-leadership"
tags: []
excerpt: "Auditing System Calls With a Custom Linux Kernel Module
 
 As security professionals, understanding what's happening at the deepest levels of our syst..."
---

 # Auditing System Calls With a Custom Linux Kernel Module
 
 As security professionals, understanding what's happening at the deepest levels of our systems is paramount. While tools like `strace` and `auditd` are invaluable, they often operate at a higher level or can generate overwhelming amounts of data. For highly specific, granular auditing needs, especially in sensitive environments, building a custom Linux kernel module offers unparalleled control and insight.
 
 This post will walk you through the foundational concepts and practical steps involved in creating a simple kernel module to audit specific system calls. We'll focus on intercepting `open` and `write` system calls to demonstrate the principles.
 
 ## Why a Custom Kernel Module?
 
 Before diving into the code, let's consider why you might choose this path:
 
 *   **Granularity:** Intercept specific system calls with custom logic.
 *   **Performance:** Potentially more efficient than userspace tools for high-frequency events, as it avoids context switching overhead for every audited call.
 *   **Custom Logic:** Implement unique filtering, alerting, or logging mechanisms directly within the kernel.
 *   **Obfuscation/Stealth:** While not the primary goal for legitimate auditing, kernel modules can be used for deeper system visibility that's harder for standard userspace tools to detect. (Use ethically and with proper authorization!)
 
 ## The Linux Kernel Module Basics
 
 A kernel module is a piece of code that can be loaded and unloaded into the kernel on demand. This allows us to extend kernel functionality without recompiling the entire kernel.
 
 The core components of a simple module are:
 
 *   **`init` function:** Executed when the module is loaded. This is where we'll register our hooks.
 *   **`exit` function:** Executed when the module is unloaded. This is where we'll clean up our hooks.
 *   **Module metadata:** `MODULE_LICENSE`, `MODULE_AUTHOR`, `MODULE_DESCRIPTION`.
 
 ## Intercepting System Calls
 
 Linux uses a system call table (sys_call_table) to map system call numbers to their corresponding kernel functions. The traditional (and now largely deprecated for security reasons) method involved directly patching this table. Modern, more secure approaches involve using kprobes or tracepoints.
 
 For this example, we'll leverage `kprobes`. Kprobes allow you to dynamically insert probes into the kernel to trap execution at arbitrary points. We'll use `pre_handler` to execute our auditing logic *before* the target system call.
 
 ### Setting Up Your Development Environment
 
 You'll need a Linux system with kernel development headers installed. The exact package name varies by distribution:
 
 *   **Debian/Ubuntu:** `sudo apt-get install linux-headers-$(uname -r) build-essential`
 *   **Fedora/CentOS/RHEL:** `sudo dnf install kernel-devel kernel-headers make gcc`
 
 ### The Kernel Module Code
 
 Let's create our module file, `syscall_auditor.c`:
 
 ```c
 #include <linux/module.h>
 #include <linux/kernel.h>
 #include <linux/init.h>
 #include <linux/kprobes.h>
 #include <linux/syscalls.h>
 #include <linux/sched.h> // For current->comm
 #include <linux/fs.h>    // For struct file
 #include <linux/path.h>  // For struct path
 #include <linux/dentry.h> // For struct dentry
 
 MODULE_LICENSE("GPL");
 MODULE_AUTHOR("Michael LaPlante");
 MODULE_DESCRIPTION("A custom kernel module to audit specific system calls.");
 
 /*
  * Define the system call numbers we want to audit.
  * We'll use __NR_open and __NR_write.
  * NOTE: These numbers can change between kernel versions and architectures.
  * It's safer to use sys_call_table lookups or sys_call_lookup if available
  * in newer kernels, but for simplicity here, we'll use known values.
  * On x86_64, __NR_open is 2, __NR_write is 1.
  */
 #define AUDIT_SYSCALL_OPEN __NR_open
 #define AUDIT_SYSCALL_WRITE __NR_write
 
 static struct kprobe kp_open;
 static struct kprobe kp_write;
 
 /*
  * Pre-handler for the 'open' system call.
  * This function is called *before* the actual sys_open() is executed.
  */
 static int handler_pre_open(struct kprobe *p, struct pt_regs *regs)
 {
  // regs->ax holds the system call number on x86_64.
  // We're already in the handler for __NR_open, so no need to check syscall number.
 
  // Get the filename from the arguments.
  // For sys_open(const char __user *filename, int flags, ...),
  // the filename is the first argument.
  const char __user *filename_user = (const char __user *)regs->di; // di is the first argument register on x86_64 for syscalls
  char filename[256]; // Buffer for the filename
  long error;
 
  // Copy the filename from userspace to kernelspace.
  error = strncpy_from_user(filename, filename_user, sizeof(filename) - 1);
  if (error < 0) {
  pr_warn("syscall_auditor: Failed to copy filename from user (error %ld)\n", error);
  return 0; // Continue execution
  }
  filename[sizeof(filename) - 1] = '\0'; // Ensure null termination
 
  // Log the event
  pr_info("syscall_auditor: [%s] open('%s')\n", current->comm, filename);
 
  return 0; // Return 0 to continue probing
 }
 
 /*
  * Pre-handler for the 'write' system call.
  * This function is called *before* the actual sys_write() is executed.
  */
 static int handler_pre_write(struct kprobe *p, struct pt_regs *regs)
 {
  // Get the file descriptor and buffer from the arguments.
  // For sys_write(unsigned int fd, const void __user *buf, size_t count),
  // fd is the first argument, buf is the second.
  int fd = regs->di; // di is the first argument register on x86_64 for syscalls
  const void __user *buf_user = (const void __user *)regs->si; // si is the second argument register
  size_t count = regs->dx; // dx is the third argument register
 
  // We can log the FD and count, but logging the buffer content
  // is more complex and potentially dangerous due to size and content.
  // For this example, we'll just log the FD and count.
 
  // Log the event
  pr_info("syscall_auditor: [%s] write(fd=%d, count=%zu)\n", current->comm, fd, count);
 
  return 0; // Return 0 to continue probing
 }
 
 /*
  * Module initialization function.
  * Registers the kprobes.
  */
 static int __init syscall_auditor_init(void)
 {
  int ret;
 
  pr_info("syscall_auditor: Loading module...\n");
 
  // Setup kprobe for open
  kp_open.pre_handler = handler_pre_open;
  kp_open.symbol_name = "sys_open"; // The kernel function name for open
 
  ret = register_kprobe(&kp_open);
  if (ret < 0) {
  pr_err("syscall_auditor: Failed to register kprobe for sys_open (error %d)\n", ret);
  return ret;
  }
  pr_info("syscall_auditor: kprobe for sys_open registered successfully.\n");
 
  // Setup kprobe for write
  kp_write.pre_handler = handler_pre_write;
  kp_write.symbol_name = "sys_write"; // The kernel function name for write
 
  ret = register_kprobe(&kp_write);
  if (ret < 0) {
  pr_err("syscall_auditor: Failed to register kprobe for sys_write (error %d)\n", ret);
  // Clean up the previously registered kprobe
  unregister_kprobe(&kp_open);
  return ret;
  }
  pr_info("syscall_auditor: kprobe for sys_write registered successfully.\n");
 
  pr_info("syscall_auditor: Module loaded.\n");
  return 0;
 }
 
 /*
  * Module exit function.
  * Unregisters the kprobes.
  */
 static void __exit syscall_auditor_exit(void)
 {
  pr_info("syscall_auditor: Unloading module...\n");
 
  // Unregister kprobes
  unregister_kprobe(&kp_open);
  pr_info("syscall_auditor: kprobe for sys_open unregistered.\n");
 
  unregister_kprobe(&kp_write);
  pr_info("syscall_auditor: kprobe for sys_write unregistered.\n");
 
  pr_info("syscall_auditor: Module unloaded.\n");
 }
 
 module_init(syscall_auditor_init);
 module_exit(syscall_auditor_exit);
 ```
 
 ### Explanation of the Code:
 
 *   **Includes:** We include necessary headers for kernel modules, kprobes, system calls, and process information.
 *   **`MODULE_LICENSE`:** Essential for kernel modules. "GPL" is common.
 *   **`AUDIT_SYSCALL_OPEN`, `AUDIT_SYSCALL_WRITE`:** Defines for the system call numbers. **Important:** These numbers are architecture-dependent and can change between kernel versions. Using `sys_call_lookup` or a more robust method is recommended for production systems.
 *   **`struct kprobe kp_open, kp_write;`:** Structures to hold our kprobe configurations.
 *   **`handler_pre_open` and `handler_pre_write`:** These are our pre-handler functions.
    *   They receive a `struct kprobe *` and `struct pt_regs *`. The `pt_regs` structure contains the system call arguments, passed via CPU registers. On x86_64, arguments are typically passed in `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`.
    *   In `handler_pre_open`:
        *   We cast `regs->di`