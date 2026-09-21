---
title: "Crafting a Custom Linux Kernel Module for Encrypted Inter-Process Communication"
date: 2026-08-26
category: "thought-leadership"
tags: ["linux-kernel", "kernel-module", "ipc", "encryption", "cryptography", "system-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of high-security applications, standard Inter-Process Communication (IPC) mechanisms often fall short when robust confidentiality and..."
---

In the realm of high-security applications, standard Inter-Process Communication (IPC) mechanisms often fall short when robust confidentiality and integrity are paramount. While user-space libraries can provide encryption, moving the encryption/decryption operations into the kernel offers several advantages: reduced context switching overhead, enhanced control over cryptographic primitives, and the ability to operate on data before it ever reaches user-space memory, potentially mitigating certain classes of side-channel attacks.

Today, we're going to dive into building a custom Linux kernel module that facilitates encrypted IPC. Our module will expose a character device through which user-space processes can exchange encrypted messages. We'll use a simplified symmetric encryption scheme for demonstration, focusing on the kernel module mechanics rather than production-grade cryptography.

## Why a Kernel Module for Encrypted IPC?

Before we start coding, let's briefly reiterate the benefits:

1.  **Performance:** By performing encryption/decryption in the kernel, we can potentially reduce the overhead associated with copying data between user and kernel space multiple times, or repeated system calls to cryptographic libraries.
2.  **Security Baseline:** Data is encrypted as early as possible and decrypted as late as possible, minimizing its exposure in plaintext within kernel memory.
3.  **Customization:** Full control over cryptographic algorithms and key management, tailored to specific security requirements.

## The Core Idea: Character Device + Symmetric Encryption

Our kernel module will create a character device (e.g., `/dev/secure_ipc`). When a process writes to this device, the module will encrypt the data and store it in an internal buffer. When another process reads from the device, the module will retrieve the encrypted data, decrypt it, and pass it back to the user.

For simplicity, we'll use a fixed, hardcoded symmetric key and a very basic XOR cipher. **This is absolutely not suitable for production use**; real-world applications would require robust key derivation, secure key storage, and industry-standard algorithms like AES.

## Step 1: Setting Up the Development Environment

You'll need a Linux system with kernel headers installed. On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install build-essential linux-headers-$(uname -r)
```

## Step 2: The Kernel Module Code (`secure_ipc.c`)

Let's break down the code for our `secure_ipc` kernel module.

```c
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>       // For character device operations
#include <linux/cdev.h>     // For cdev structure
#include <linux/slab.h>     // For kmalloc/kfree
#include <linux/uaccess.h>  // For copy_to_user/copy_from_user
#include <linux/mutex.h>    // For synchronization

#define DEVICE_NAME "secure_ipc"
#define MAX_MSG_SIZE 4096 // Maximum message size
#define MAX_BUFFER_MSGS 10 // Number of messages our buffer can hold

// Our "secret" key (for demonstration only, DO NOT USE IN PRODUCTION)
static const char secure_key[] = "supersecretkey1234567890abcdef";
static const size_t secure_key_len = sizeof(secure_key) - 1; // Exclude null terminator

// Structure to hold our encrypted messages
struct ipc_message {
    char *data;
    size_t len;
};

// Global buffer for messages
static struct ipc_message *message_buffer[MAX_BUFFER_MSGS];
static int buffer_head = 0; // Next write position
static int buffer_tail = 0; // Next read position
static int message_count = 0; // Current number of messages in buffer

static DEFINE_MUTEX(ipc_buffer_mutex); // Mutex to protect buffer access

static dev_t dev_num;
static struct cdev secure_ipc_cdev;
static struct class *secure_ipc_class;

// --- Encryption/Decryption Helper (XOR Cipher) ---
static void xor_crypt(char *data, size_t len) {
    size_t i;
    for (i = 0; i < len; i++) {
        data[i] ^= secure_key[i % secure_key_len];
    }
}

// --- Character Device Operations ---

static int secure_ipc_open(struct inode *inode, struct file *file) {
    printk(KERN_INFO "secure_ipc: Device opened.\n");
    return 0;
}

static int secure_ipc_release(struct inode *inode, struct file *file) {
    printk(KERN_INFO "secure_ipc: Device closed.\n");
    return 0;
}

static ssize_t secure_ipc_write(struct file *file, const char __user *buf, size_t len, loff_t *offset) {
    struct ipc_message *new_msg;
    char *temp_buf;

    if (len == 0 || len > MAX_MSG_SIZE) {
        printk(KERN_WARNING "secure_ipc: Write length %zu out of bounds (0-%d).\n", len, MAX_MSG_SIZE);
        return -EINVAL;
    }

    // Allocate memory for the incoming message
    temp_buf = kmalloc(len, GFP_KERNEL);
    if (!temp_buf) {
        printk(KERN_ERR "secure_ipc: Failed to allocate memory for incoming message.\n");
        return -ENOMEM;
    }

    // Copy data from user space
    if (copy_from_user(temp_buf, buf, len)) {
        kfree(temp_buf);
        return -EFAULT;
    }

    // Encrypt the data in kernel space
    xor_crypt(temp_buf, len);

    mutex_lock(&ipc_buffer_mutex);
    if (message_count == MAX_BUFFER_MSGS) {
        printk(KERN_WARNING "secure_ipc: Buffer full, dropping message.\n");
        mutex_unlock(&ipc_buffer_mutex);
        kfree(temp_buf); // Free the buffer if we can't store it
        return -ENOSPC; // No space left on device
    }

    new_msg = kmalloc(sizeof(struct ipc_message), GFP_KERNEL);
    if (!new_msg) {
        printk(KERN_ERR "secure_ipc: Failed to allocate ipc_message struct.\n");
        mutex_unlock(&ipc_buffer_mutex);
        kfree(temp_buf);
        return -ENOMEM;
    }

    new_msg->data = temp_buf;
    new_msg->len = len;

    message_buffer[buffer_head] = new_msg;
    buffer_head = (buffer_head + 1) % MAX_BUFFER_MSGS;
    message_count++;

    printk(KERN_INFO "secure_ipc: Wrote %zu bytes (encrypted) to buffer. Count: %d\n", len, message_count);
    mutex_unlock(&ipc_buffer_mutex);

    return len; // Return the number of bytes written
}


static ssize_t secure_ipc_read(struct file *file, char __user *buf, size_t len, loff_t *offset) {
    struct ipc_message *read_msg;
    ssize_t bytes_read = 0;
    char *decrypted_data;

    mutex_lock(&ipc_buffer_mutex);
    if (message_count == 0) {
        printk(KERN_INFO "secure_ipc: Buffer empty, no data to read.\n");
        mutex_unlock(&ipc_buffer_mutex);
        return 0; // No data available
    }

    read_msg = message_buffer[buffer_tail];

    if (len < read_msg->len) {
        printk(KERN_WARNING "secure_ipc: Read buffer too small (%zu bytes) for message of %zu bytes.\n", len, read_msg->len);
        mutex_unlock(&ipc_buffer_mutex);
        return -EINVAL; // Invalid argument, user buffer too small
    }

    // Allocate temp buffer for decryption
    decrypted_data = kmalloc(read_msg->len, GFP_KERNEL);
    if (!decrypted_data) {
        printk(KERN_ERR "secure_ipc: Failed to allocate memory for decryption.\n");
        mutex_unlock(&ipc_buffer_mutex);
        return -ENOMEM;
    }

    // Copy encrypted data to temp buffer, then decrypt
    memcpy(decrypted_data, read_msg->data, read_msg->len);
    xor_crypt(decrypted_data, read_msg->len); // Decrypt

    // Copy decrypted data to user space
    if (copy_to_user(buf, decrypted_data, read_msg->len)) {
        printk(KERN_ERR "secure_ipc: Failed to copy data to user space.\n");
        kfree(decrypted_data);
        mutex_unlock(&ipc_buffer_mutex);
        return -EFAULT;
    }

    bytes_read = read_msg->len;

    // Clean up the message from the buffer
    kfree(read_msg->data); // Free the actual data
    kfree(read_msg);       // Free the message struct
    message_buffer[buffer_tail] = NULL; // Clear pointer

    buffer_tail = (buffer_tail + 1) % MAX_BUFFER_MSGS;
    message_count--;

    printk(KERN_INFO "secure_ipc: Read %zu bytes (decrypted) from buffer. Count: %d\n", bytes_read, message_count);
    kfree(decrypted_data); // Free temp decryption buffer
    mutex_unlock(&ipc_buffer_mutex);

    return bytes_read; // Return number of bytes read
}

static const struct file_operations secure_ipc_fops = {
    .owner = THIS_MODULE,
    .open = secure_ipc_open,
    .release = secure_ipc_release,
    .read = secure_ipc_read,
    .write = secure_ipc_write,
};

// --- Module Initialization and Exit ---

static int __init secure_ipc_init(void) {
    int ret;

    printk(KERN_INFO "secure_ipc: Initializing module...\n");

    // 1. Allocate a character device number
    ret = alloc_chrdev_region(&dev_num, 0, 1, DEVICE_NAME);
    if (ret < 0) {
        printk(KERN_ERR "secure_ipc: Failed to allocate character device region: %d\n", ret);
        return ret;
    }
    printk(KERN_INFO "secure_ipc: Allocated device number major=%d minor=%d\n",
           MAJOR(dev_num), MINOR(dev_num));

    // 2. Wire up the cdev with our file_operations and register it
    cdev_init(&secure_ipc_cdev, &secure_ipc_fops);
    secure_ipc_cdev.owner = THIS_MODULE;
    ret = cdev_add(&secure_ipc_cdev, dev_num, 1);
    if (ret < 0) {
        printk(KERN_ERR "secure_ipc: Failed to add character device: %d\n", ret);
        unregister_chrdev_region(dev_num, 1);
        return ret;
    }

    // 3. Create a device class so udev creates /dev/secure_ipc for us.
    // Note: class_create() dropped its owner argument in kernel 6.4; on
    // older kernels it takes (THIS_MODULE, name) instead of just (name).
    secure_ipc_class = class_create(THIS_MODULE, "secure_ipc_class");
    if (IS_ERR(secure_ipc_class)) {
        printk(KERN_ERR "secure_ipc: Failed to create device class\n");
        cdev_del(&secure_ipc_cdev);
        unregister_chrdev_region(dev_num, 1);
        return PTR_ERR(secure_ipc_class);
    }

    // 4. Create the actual device node under the class
    {
        struct device *dev = device_create(secure_ipc_class, NULL, dev_num, NULL, DEVICE_NAME);
        if (IS_ERR(dev)) {
            printk(KERN_ERR "secure_ipc: Failed to create device node: %ld\n", PTR_ERR(dev));
            class_destroy(secure_ipc_class);
            cdev_del(&secure_ipc_cdev);
            unregister_chrdev_region(dev_num, 1);
            return PTR_ERR(dev);
        }
    }

    printk(KERN_INFO "secure_ipc: Module loaded, /dev/%s ready.\n", DEVICE_NAME);
    return 0;
}

static void __exit secure_ipc_exit(void) {
    int i;

    device_destroy(secure_ipc_class, dev_num);
    class_destroy(secure_ipc_class);
    cdev_del(&secure_ipc_cdev);
    unregister_chrdev_region(dev_num, 1);

    // Drain and free any messages still sitting in the buffer
    mutex_lock(&ipc_buffer_mutex);
    for (i = 0; i < MAX_BUFFER_MSGS; i++) {
        if (message_buffer[i]) {
            kfree(message_buffer[i]->data);
            kfree(message_buffer[i]);
            message_buffer[i] = NULL;
        }
    }
    mutex_unlock(&ipc_buffer_mutex);

    printk(KERN_INFO "secure_ipc: Module unloaded.\n");
}

module_init(secure_ipc_init);
module_exit(secure_ipc_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Michael LaPlante");
MODULE_DESCRIPTION("A kernel module providing XOR-encrypted IPC over a character device");
```

## Step 3: Building and Loading the Module

With a standard out-of-tree `Makefile` (`obj-m += secure_ipc.o`, driven by the kernel build system via `make -C /lib/modules/$(uname -r)/build M=$(pwd) modules`), build and load it:

```bash
make
sudo insmod secure_ipc.ko
dmesg | tail -5          # confirm "Module loaded, /dev/secure_ipc ready."
ls -l /dev/secure_ipc
```

By default the device node is owned by root with restrictive permissions, which is the correct starting point — grant access explicitly (a `udev` rule or `chmod`/`chgrp` to a dedicated group) rather than opening it up to all users.

## Step 4: Testing the Encrypted Channel

Because the module encrypts on write and decrypts on read, two independent processes can exchange data through `/dev/secure_ipc` without either one seeing the wire format in plaintext at rest in the kernel's message buffer:

```bash
# Process A: write a message (gets XOR-encrypted before being buffered)
echo -n "attack at dawn" | sudo tee /dev/secure_ipc > /dev/null

# Process B: read it back (gets decrypted on the way out)
sudo cat /dev/secure_ipc
```

Watch `dmesg` while you do this — you'll see the "Wrote N bytes (encrypted) to buffer" and "Read N bytes (decrypted) from buffer" log lines confirming the round trip, and if you inspect kernel memory directly (or add a debug `printk` of the raw buffer), the bytes sitting in `message_buffer` never match the plaintext.

## Moving Beyond XOR

The XOR cipher here exists purely to keep the module's mechanics — character device registration, buffering, `copy_to_user`/`copy_from_user` — front and center without a cryptography library obscuring them. It provides no real confidentiality: a single known-plaintext byte recovers the entire key. A production version would replace `xor_crypt()` with the kernel's own crypto API rather than rolling anything by hand — allocate a transform with `crypto_alloc_aead("gcm(aes)", 0, 0)`, derive or load the key through the kernel keyring instead of a `static const char[]`, and encrypt/decrypt through `crypto_aead_encrypt()`/`crypto_aead_decrypt()` with a per-message nonce. That gets you authenticated encryption (tamper detection included) using primitives that have actually been audited, instead of a cipher an attacker can break by inspection.

## Wrapping Up

The mechanics that make this module interesting have nothing to do with the cipher — they're the character device lifecycle, the mutex-guarded ring buffer, and the discipline of never trusting a length or pointer that came from user space. Swap the XOR cipher for `gcm(aes)` via the kernel crypto API and proper key management, and you have the skeleton of a real encrypted-IPC mechanism that keeps plaintext out of any buffer an unprivileged process — or a compromised neighbor in the same buffer — could read.