---
title: "Crafting a Linux Kernel Module for Hardware Root of Trust Attestation"
date: 2026-08-13
category: "thought-leadership"
tags: ["linux-kernel", "security", "attestation", "trusted-computing", "embedded-systems"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of system security, the concept of a Hardware Root of Trust (HRoT) is paramount. It provides an immutable, verifiable starting point for..."
---

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
    // Since kernel 6.4, class_create() takes only the class name — the
    // owner/THIS_MODULE argument was dropped when struct class stopped
    // tracking a module pointer.
    hrot_attest_class = class_create(CLASS_NAME);
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
    // class_destroy() already calls class_unregister() internally, so
    // calling both here would unregister the same class kset twice.
    device_destroy(hrot_attest_class, MKDEV(major_number, 0));
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
            status = ioread32(hrot_regs_base + ATTEST_STATUS_REG_OFFSET);
            if (status == STATUS_READY) {
                break;
            }
            if (status == STATUS_ERROR) {
                printk(KERN_ALERT "HROT_ATTEST: Device reported an error during attestation\n");
                return -EIO;
            }
            msleep(10);
        } while (--timeout > 0);

        if (timeout == 0) {
            printk(KERN_ALERT "HROT_ATTEST: Timed out waiting for attestation to complete\n");
            return -ETIMEDOUT;
        }

        printk(KERN_INFO "HROT_ATTEST: Attestation complete, signature ready to be read\n");
        return len;
    }

    printk(KERN_WARNING "HROT_ATTEST: Unrecognized command 0x%x\n", command_buf[0]);
    return -EINVAL;
}

static ssize_t hrot_read(struct file *filep, char __user *buffer, size_t len, loff_t *offset) {
    unsigned char sig_buf[64]; // 64-byte attestation signature
    size_t sig_len = sizeof(sig_buf);
    size_t to_copy;

    if (*offset >= sig_len) {
        return 0; // EOF
    }

    // Pull the signature out of the device's data register into a kernel buffer.
    // memcpy_fromio() is the correct primitive here rather than a raw pointer
    // dereference, since hrot_regs_base is an __iomem pointer.
    memcpy_fromio(sig_buf, hrot_regs_base + ATTEST_DATA_REG_OFFSET, sig_len);

    to_copy = min(len, sig_len - (size_t)*offset);
    if (copy_to_user(buffer, sig_buf + *offset, to_copy) != 0) {
        printk(KERN_ALERT "HROT_ATTEST: Failed to copy signature to user space\n");
        return -EFAULT;
    }

    *offset += to_copy;
    return to_copy;
}

module_init(hrot_attest_init);
module_exit(hrot_attest_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Security Engineering");
MODULE_DESCRIPTION("Character device driver exposing hardware root-of-trust attestation to user space");
MODULE_VERSION("0.1");
```

### 3. Building and Testing the Module

With the `Makefile` and source in place, build and load the module, then exercise it from user space:

```bash
make
sudo insmod hrot_attest.ko
dmesg | tail -n 5

# Trigger attestation (writes the single-byte command)
printf '\x01' | sudo tee /dev/hrot_attest > /dev/null

# Read back the 64-byte signature
sudo xxd /dev/hrot_attest

sudo rmmod hrot_attest
```

If everything is wired up correctly, `dmesg` will show the registration and mapping messages from `hrot_attest_init`, the `write` will block briefly while the device polls to `STATUS_READY`, and the subsequent `read` will return the raw signature bytes.

## Security Considerations for This Approach

Exposing hardware attestation through a kernel module is only as secure as the interface you build around it:

*   **Device Node Permissions:** By default, `device_create` leaves the resulting `/dev/hrot_attest` node's permissions to whatever `udev` rule (or lack thereof) applies on the system, which is often world-readable and world-writable. Ship a `udev` rule that restricts the node to a dedicated group, or set permissions explicitly in `hrot_attest_init` via `device_create`'s owning class attributes, so unprivileged processes can't trigger attestation or read signatures on demand.
*   **Validate in User Space Too:** The kernel module's job is to get bytes off the hardware safely — it is not a substitute for verifying the signature. The consuming application must still verify the returned signature against the HRoT's known public key (or a certificate chain rooted in it) before trusting any claim about the running kernel image.
*   **Don't Trust Raw MMIO Blindly:** Anything that can get `/dev/mem` access or load its own module can, in principle, race your driver's access to the same physical address. Where the hardware supports it, prefer a locked-down bus (e.g., an SPI TPM with proper locality enforcement) over a raw memory-mapped register that any sufficiently privileged code can also poke.
*   **Avoid Busy-Polling in Production:** Our `msleep(10)` polling loop is fine for a blog post, but a real driver handling attestation on a hot path should use interrupts or a completion mechanism (`struct completion` plus an IRQ handler) instead of tying up a kernel thread in a poll loop.

## Conclusion

Moving attestation logic into a kernel module keeps sensitive hardware interactions close to the metal and out of reach of ordinary user-space processes, at the cost of the extra discipline kernel code demands: careful error handling, correct cleanup on every failure path, and honest permissions on the resulting device node. This pattern generalizes well beyond our hypothetical HRoT device — any time you're bridging a security-sensitive hardware interface (a TPM, a secure element, a custom ASIC) to user space, a narrow, purpose-built character device is usually a safer starting point than handing out raw MMIO or port I/O access.