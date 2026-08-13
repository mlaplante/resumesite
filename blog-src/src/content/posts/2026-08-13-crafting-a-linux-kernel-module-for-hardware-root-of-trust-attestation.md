---
title: "Crafting a Linux Kernel Module for Hardware Root of Trust Attestation"
date: 2026-08-13
category: "thought-leadership"
tags: ["linux-kernel", "security", "attestation", "trusted-computing", "embedded-systems"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of system security, the concept of a Hardware Root of Trust (HRoT) is paramount. It provides an immutable, verifiable starting point for..."
---

# Crafting a Linux Kernel Module for Hardware Root of Trust Attestation

In the realm of system security, the concept of a Hardware Root of Trust (HRoT) is paramount. It provides an immutable, verifiable starting point for a system's boot process, ensuring that the software running on the device hasn't been tampered with. While many modern systems incorporate HRoT features through technologies like Trusted Platform Modules (TPMs) or Secure Elements, interacting with these directly from user space can be complex and, in some cases, less secure due to the privileged nature of attestation operations.

This post will delve into how we can write a custom Linux kernel module to interface with a hypothetical HRoT device and perform attestation. This approach allows us to keep sensitive operations within the kernel, closer to the hardware, and provide a secure, controlled interface to user-space applications.

## Why a Kernel Module?

You might wonder why we'd opt for a kernel module instead of a user-space library. Here are a few compelling reasons:

1.  **Direct Hardware Access:** HRoT devices often communicate via low-level buses (SPI, I2C, memory-mapped I/O). The kernel is the ideal place to manage these interactions directly and securely, without requiring complex user-space drivers or elevated privileges for every application.
2.  **Security Context:** Attestation involves cryptographic operations and access to unique device identifiers. Keeping these operations in the kernel reduces the attack surface compared to exposing raw hardware interfaces or cryptographic keys to user-space applications.
3.  **Controlled Interface:** A kernel module can expose a clean, well-defined `/dev` interface or a Netlink socket, abstracting the complexities of the HRoT device from user applications.
4.  **Early Boot Integration:** While this post focuses on runtime attestation, kernel modules can also be integrated into early boot stages, contributing to a secure boot chain.

## Our Hypothetical HRoT Device

For this example, let's imagine a simple HRoT device accessible via memory-mapped I/O at a specific physical address (`0xDEADBEEF`). This device has two key registers:

*   `ATTEST_CMD_REG (offset 0x00)`: Write a command to this register.
*   `ATTEST_DATA_REG (offset 0x04)`: Read attestation data (a 64-byte signature) from this register after a command.
*   `ATTEST_STATUS_REG (offset 0x08)`: Read status (e.g., `0` for ready, `1` for busy, `2` for error).

Our HRoT device, when commanded, will generate a cryptographic signature over a measurement of the currently running kernel image, using an internal, immutable private key. This signature is the attestation data.

## Setting Up the Kernel Module

We'll create a basic character device driver that user-space can open, write to (to trigger attestation), and read from (to get the attestation signature).

### 1. The `Makefile`

```makefile
obj-m += hrot_attest.o

all:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) modules

clean:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) clean
```

### 2. The `hrot_attest.c` Source

```c
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/io.h>
#include <linux/slab.h>
#include <linux/delay.h>

#define DEVICE_NAME "hrot_attest"
#define CLASS_NAME  "hrot"

// Hypothetical HRoT device base physical address
#define HROT_BASE_PHYS_ADDR 0xDEADBEEF
#define HROT_REG_SIZE       0x10 // Enough for CMD, DATA, STATUS

// Register offsets
#define ATTEST_CMD_REG_OFFSET   0x00
#define ATTEST_DATA_REG_OFFSET  0x04 // Assuming 64-byte signature starts here
#define ATTEST_STATUS_REG_OFFSET 0x08

// Commands
#define CMD_TRIGGER_ATTESTATION 0x01

// Status values
#define STATUS_READY 0x00
#define STATUS_BUSY  0x01
#define STATUS_ERROR 0x02

static int major_number;
static struct class* hrot_attest_class = NULL;
static struct device* hrot_attest_device = NULL;

// Pointer to memory-mapped HRoT device registers
static void __iomem *hrot_regs_base;

// --- Function Prototypes ---
static int     hrot_open(struct inode *, struct file *);
static int     hrot_release(struct inode *, struct file *);
static ssize_t hrot_read(struct file *, char __user *, size_t, loff_t *);
static ssize_t hrot_write(struct file *, const char __user *, size_t, loff_t *);

static struct file_operations fops =
{
   .open = hrot_open,
   .release = hrot_release,
   .read = hrot_read,
   .write = hrot_write,
};

static int __init hrot_attest_init(void) {
    printk(KERN_INFO "HROT_ATTEST: Initializing the HROT Attestation LKM\n");

    // 1. Register character device
    major_number = register_chrdev(0, DEVICE_NAME, &fops);
    if (major_number < 0) {
        printk(KERN_ALERT "HROT_ATTEST: Failed to register a major number\n");
        return major_number;
    }
    printk(KERN_INFO "HROT_ATTEST: Registered with major number %d\n", major_number);

    // 2. Register the device class
    hrot_attest_class = class_create(THIS_MODULE, CLASS_NAME);
    if (IS_ERR(hrot_attest_class)) {
        unregister_chrdev(major_number, DEVICE_NAME);
        printk(KERN_ALERT "HROT_ATTEST: Failed to register device class\n");
        return PTR_ERR(hrot_attest_class);
    }
    printk(KERN_INFO "HROT_ATTEST: Device class registered\n");

    // 3. Create the device
    hrot_attest_device = device_create(hrot_attest_class, NULL, MKDEV(major_number, 0), NULL, DEVICE_NAME);
    if (IS_ERR(hrot_attest_device)) {
        class_destroy(hrot_attest_class);
        unregister_chrdev(major_number, DEVICE_NAME);
        printk(KERN_ALERT "HROT_ATTEST: Failed to create the device\n");
        return PTR_ERR(hrot_attest_device);
    }
    printk(KERN_INFO "HROT_ATTEST: Device created on /dev/%s\n", DEVICE_NAME);

    // 4. Memory map the HRoT device registers
    hrot_regs_base = ioremap(HROT_BASE_PHYS_ADDR, HROT_REG_SIZE);
    if (!hrot_regs_base) {
        device_destroy(hrot_attest_class, MKDEV(major_number, 0));
        class_destroy(hrot_attest_class);
        unregister_chrdev(major_number, DEVICE_NAME);
        printk(KERN_ALERT "HROT_ATTEST: Failed to ioremap HRoT device physical address 0x%lx\n", (unsigned long)HROT_BASE_PHYS_ADDR);
        return -ENOMEM;
    }
    printk(KERN_INFO "HROT_ATTEST: HRoT device registers memory-mapped to %p\n", hrot_regs_base);

    return 0;
}

static void __exit hrot_attest_exit(void) {
    printk(KERN_INFO "HROT_ATTEST: Exiting the HROT Attestation LKM\n");

    // Unmap memory
    if (hrot_regs_base) {
        iounmap(hrot_regs_base);
        printk(KERN_INFO "HROT_ATTEST: HRoT device registers unmapped\n");
    }

    // Destroy device, class, and unregister
    device_destroy(hrot_attest_class, MKDEV(major_number, 0));
    class_unregister(hrot_attest_class);
    class_destroy(hrot_attest_class);
    unregister_chrdev(major_number, DEVICE_NAME);
    printk(KERN_INFO "HROT_ATTEST: Goodbye from the HROT Attestation LKM!\n");
}

static int hrot_open(struct inode *inodep, struct file *filep) {
    printk(KERN_INFO "HROT_ATTEST: Device opened by process %d\n", current->pid);
    return 0;
}

static int hrot_release(struct inode *inodep, struct file *filep) {
    printk(KERN_INFO "HROT_ATTEST: Device successfully closed by process %d\n", current->pid);
    return 0;
}

static ssize_t hrot_write(struct file *filep, const char __user *buffer, size_t len, loff_t *offset) {
    char command_buf[1];
    unsigned int status;

    if (len != 1) {
        printk(KERN_WARNING "HROT_ATTEST: Expected a single byte command, received %zu\n", len);
        return -EINVAL;
    }

    if (copy_from_user(command_buf, buffer, 1) != 0) {
        printk(KERN_ALERT "HROT_ATTEST: Failed to copy command from user space\n");
        return -EFAULT;
    }

    if (command_buf[0] == CMD_TRIGGER_ATTESTATION) {
        printk(KERN_INFO "HROT_ATTEST: Triggering attestation...\n");

        // Write command to HRoT device
        iowrite32(CMD_TRIGGER_ATTESTATION, hrot_regs_base + ATTEST_CMD_REG_OFFSET);

        // Poll for completion (simplified for example, real-world might use interrupts)
        int timeout = 100; // 100 * 10ms = 1 second timeout
        do {
            status = ioread