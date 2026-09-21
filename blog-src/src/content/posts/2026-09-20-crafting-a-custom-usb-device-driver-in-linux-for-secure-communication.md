---
title: "Crafting a Custom USB Device Driver in Linux for Secure Communication"
date: 2026-09-20
category: "thought-leadership"
tags: ["linux-kernel", "usb", "device-drivers", "embedded-security", "c-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As an SVP of Information Security and Operations, I've seen firsthand how critical secure communication is, not just over networks, but right down to..."
---

As an SVP of Information Security and Operations, I've seen firsthand how critical secure communication is, not just over networks, but right down to the physical layer. While off-the-shelf solutions often suffice, there are specific scenarios where custom hardware and the accompanying software become indispensable. One such area is when you need to secure communication with a unique peripheral, perhaps a hardware security module (HSM) or a specialized sensor, that doesn't fit standard USB classes.

In this post, we'll dive into the practicalities of implementing a custom USB device driver in Linux. This isn't about re-implementing existing drivers for keyboards or mice; it's about understanding the Linux USB subsystem well enough to build a bespoke driver for a custom USB device, enabling secure and controlled communication.

## Why a Custom Driver?

You might ask, "Why not just use `libusb` in userspace?" `libusb` is fantastic for many applications, especially rapid prototyping and user-space control. However, a kernel-level driver offers several distinct advantages for secure peripherals:

1.  **Direct Kernel Integration:** Tighter integration with the kernel's security mechanisms, memory management, and scheduling.
2.  **Performance:** Reduced overhead compared to user-space libraries, especially for high-throughput or low-latency applications.
3.  **Resource Management:** Better control over hardware resources and power management.
4.  **Security Boundaries:** The kernel provides a more robust isolation layer, making it harder for malicious user-space applications to interfere directly with the device or its data streams. For sensitive devices, this can be a critical control.
5.  **Exclusive Access:** A kernel driver can enforce exclusive access to a device, preventing other processes from tampering with it.

## Understanding the Linux USB Subsystem Basics

Before we write code, let's briefly review key USB concepts from a driver developer's perspective:

*   **Bus:** The physical USB bus.
*   **Device:** A physical USB peripheral connected to the bus.
*   **Configuration:** A device can have multiple configurations (though usually only one is active).
*   **Interface:** A configuration can have multiple interfaces, each representing a logical function (e.g., a composite device might have a keyboard interface and a mouse interface).
*   **Endpoint:** Interfaces communicate via endpoints. Endpoints are unidirectional and have a type:
    *   **Control:** For device configuration and status (always present, endpoint 0).
    *   **Bulk:** For large, bursty data transfers with error checking (no guaranteed latency).
    *   **Interrupt:** For small, time-sensitive data (e.g., keyboard input, guaranteed latency).
    *   **Isochronous:** For time-critical, continuous data (e.g., audio/video, no error checking).

Our custom device will typically use Bulk endpoints for secure data transfer due to their reliability.

## Getting Started: The Driver Structure

A Linux USB driver typically involves these main components:

1.  **Probe Function:** Called when the kernel finds a matching USB device.
2.  **Disconnect Function:** Called when the device is removed.
3.  **File Operations:** For user-space interaction (open, read, write, ioctl, close).
4.  **URB Handling:** USB Request Blocks are the core mechanism for asynchronous data transfer.

Let's sketch out a minimal driver structure. We'll assume our custom device has a Vendor ID (VID) of `0x1234` and a Product ID (PID) of `0x5678`.

```c
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/usb.h>
#include <linux/slab.h> // For kmalloc/kfree
#include <linux/uaccess.h> // For copy_to_user/copy_from_user

#define USB_VENDOR_ID_CUSTOM    0x1234
#define USB_PRODUCT_ID_CUSTOM   0x5678

// Structure to hold our device-specific data
struct custom_usb_dev {
    struct usb_device *udev;        // Pointer to the usb_device struct
    struct usb_interface *interface; // Pointer to the usb_interface struct
    unsigned char minor;            // Our assigned minor number
    struct urb *read_urb;           // URB for reading data
    struct urb *write_urb;          // URB for writing data
    unsigned char *read_buffer;     // Buffer for incoming data
    unsigned char *write_buffer;    // Buffer for outgoing data
    dma_addr_t read_dma_handle;     // DMA handle for read_buffer
    dma_addr_t write_dma_handle;    // DMA handle for write_buffer
    size_t bulk_in_size;            // Max packet size for bulk IN endpoint
    size_t bulk_out_size;           // Max packet size for bulk OUT endpoint
    __u8 bulk_in_endpoint_addr;     // Address of bulk IN endpoint
    __u8 bulk_out_endpoint_addr;    // Address of bulk OUT endpoint
    // Add any synchronization primitives or other state here
    struct mutex io_mutex;          // Mutex for protecting I/O operations
    wait_queue_head_t read_wait;    // Wait queue for readers
    int read_data_available;        // Flag for read data availability
};

static struct usb_driver custom_usb_driver; // Forward declaration

// Forward declarations for file operations
static int custom_usb_open(struct inode *inode, struct file *file);
static int custom_usb_release(struct inode *inode, struct file *file);
static ssize_t custom_usb_read(struct file *file, char __user *buf, size_t count, loff_t *ppos);
static ssize_t custom_usb_write(struct file *file, const char __user *buf, size_t count, loff_t *ppos);

static const struct file_operations custom_usb_fops = {
    .owner = THIS_MODULE,
    .open = custom_usb_open,
    .release = custom_usb_release,
    .read = custom_usb_read,
    .write = custom_usb_write,
};

// Our USB class structure
static struct usb_class_driver custom_usb_class = {
    .name = "custom_usb%d",
    .fops = &custom_usb_fops,
    .minor_base = 0, // Starts at minor 0
};

// Matches our custom device by VID/PID
static struct usb_device_id custom_usb_table[] = {
    { USB_DEVICE(USB_VENDOR_ID_CUSTOM, USB_PRODUCT_ID_CUSTOM) },
    { } /* Terminating entry */
};
MODULE_DEVICE_TABLE(usb, custom_usb_table);

// URB completion callback for read operations
static void custom_usb_read_bulk_callback(struct urb *urb) {
    struct custom_usb_dev *dev = urb->context;

    if (urb->status) {
        // Handle error, e.g., printk(KERN_ERR "Read URB failed: %d\n", urb->status);
        // Resubmit URB if recoverable, or signal error to user
        dev->read_data_available = -EIO; // Indicate error
    } else {
        // Data received, make it available to user-space
        dev->read_data_available = urb->actual_length;
    }
    // Wake up any waiting readers
    wake_up_interruptible(&dev->read_wait);
    // Free the URB if it's a one-shot, or prepare for next transfer
    // For continuous reading, you'd resubmit here
}

// URB completion callback for write operations
static void custom_usb_write_bulk_callback(struct urb *urb) {
    // For simplicity, we just free the URB and signal completion.
    // In a real driver, you might have a wait queue for writers
    // or a completion count.
    kfree(urb->transfer_buffer); // Free the buffer allocated for this write
    usb_free_urb(urb);
}

// Probe function: Called when our device is found
static int custom_usb_probe(struct usb_interface *interface, const struct usb_device_id *id) {
    struct usb_device *udev = interface_to_usbdev(interface);
    struct custom_usb_dev *dev;
    int retval = -ENOMEM;
    struct usb_endpoint_descriptor *endpoint;
    int i;

    dev = kzalloc(sizeof(*dev), GFP_KERNEL);
    if (!dev) {
        printk(KERN_ERR "custom_usb: Out of memory\n");
        return retval;
    }

    mutex_init(&dev->io_mutex);
    init_waitqueue_head(&dev->read_wait);

    dev->udev = udev;
    dev->interface = interface;

    // Find our bulk IN and OUT endpoints
    for (i = 0; i < interface->cur_altsetting->desc.bNumEndpoints; i++) {
        endpoint = &interface->cur_altsetting->endpoint[i].desc;

        if (usb_endpoint_is_bulk_in(endpoint)) {
            dev->bulk_in_endpoint_addr = endpoint->bEndpointAddress;
            dev->bulk_in_size = usb_endpoint_maxp(endpoint);
            printk(KERN_INFO "custom_usb: Found bulk IN endpoint 0x%x, max packet size %zu\n",
                   dev->bulk_in_endpoint_addr, dev->bulk_in_size);
        } else if (usb_endpoint_is_bulk_out(endpoint)) {
            dev->bulk_out_endpoint_addr = endpoint->bEndpointAddress;
            dev->bulk_out_size = usb_endpoint_maxp(endpoint);
            printk(KERN_INFO "custom_usb: Found bulk OUT endpoint 0x%x, max packet size %zu\n",
                   dev->bulk_out_endpoint_addr, dev->bulk_out_size);
        }
    }

    if (!dev->bulk_in_endpoint_addr || !dev->bulk_out_endpoint_addr) {
        printk(KERN_ERR "custom_usb: Could not find bulk IN/OUT endpoints\n");
        goto error;
    }

    // Allocate read buffer (DMA-safe)
    dev->read_buffer = usb_alloc_coherent(udev, dev->bulk_in_size, GFP_KERNEL, &dev->read_dma_handle);
    if (!dev->read_buffer) {
        printk(KERN_ERR "custom_usb: Failed to allocate read buffer\n");
        goto error;
    }

    // Allocate read URB
    dev->read_urb = usb_alloc_urb(0, GFP_KERNEL);
    if (!dev->read_urb) {
        printk(KERN_ERR "custom_usb: Failed to allocate read URB\n");
        goto error;
    }

    usb_set_intfdata(interface, dev);

    // Register this device with the USB core, which allocates a minor
    // number and creates /dev/custom_usbN via the class driver.
    retval = usb_register_dev(interface, &custom_usb_class);
    if (retval) {
        printk(KERN_ERR "custom_usb: Not able to get a minor for this device.\n");
        usb_set_intfdata(interface, NULL);
        goto error;
    }

    dev->minor = interface->minor;
    printk(KERN_INFO "custom_usb: Device now attached to /dev/custom_usb%d\n",
           interface->minor);

    return 0;

error:
    if (dev) {
        if (dev->read_urb)
            usb_free_urb(dev->read_urb);
        if (dev->read_buffer)
            usb_free_coherent(udev, dev->bulk_in_size, dev->read_buffer, dev->read_dma_handle);
        kfree(dev);
    }
    return retval;
}

// Disconnect function: called when the device is removed
static void custom_usb_disconnect(struct usb_interface *interface) {
    struct custom_usb_dev *dev = usb_get_intfdata(interface);

    usb_set_intfdata(interface, NULL);
    usb_deregister_dev(interface, &custom_usb_class);

    mutex_lock(&dev->io_mutex);
    usb_kill_urb(dev->read_urb);
    mutex_unlock(&dev->io_mutex);

    usb_free_urb(dev->read_urb);
    usb_free_coherent(dev->udev, dev->bulk_in_size, dev->read_buffer, dev->read_dma_handle);

    kfree(dev);
    printk(KERN_INFO "custom_usb: Device disconnected\n");
}

// File operations: open
static int custom_usb_open(struct inode *inode, struct file *file) {
    struct usb_interface *interface;
    struct custom_usb_dev *dev;
    int subminor = iminor(inode);

    interface = usb_find_interface(&custom_usb_driver, subminor);
    if (!interface)
        return -ENODEV;

    dev = usb_get_intfdata(interface);
    if (!dev)
        return -ENODEV;

    file->private_data = dev;
    return 0;
}

static int custom_usb_release(struct inode *inode, struct file *file) {
    (void)inode;
    file->private_data = NULL;
    return 0;
}

// Read: submit the device's persistent bulk IN URB and block until the
// completion callback signals that data has arrived (or the transfer failed).
static ssize_t custom_usb_read(struct file *file, char __user *buf, size_t count, loff_t *ppos) {
    struct custom_usb_dev *dev = file->private_data;
    int retval;

    (void)ppos;

    mutex_lock(&dev->io_mutex);

    usb_fill_bulk_urb(dev->read_urb, dev->udev,
                       usb_rcvbulkpipe(dev->udev, dev->bulk_in_endpoint_addr),
                       dev->read_buffer, min(count, dev->bulk_in_size),
                       custom_usb_read_bulk_callback, dev);
    dev->read_urb->transfer_dma = dev->read_dma_handle;
    dev->read_urb->transfer_flags |= URB_NO_TRANSFER_DMA_MAP;

    dev->read_data_available = 0;
    retval = usb_submit_urb(dev->read_urb, GFP_KERNEL);
    mutex_unlock(&dev->io_mutex);
    if (retval) {
        printk(KERN_ERR "custom_usb: Failed to submit read URB: %d\n", retval);
        return retval;
    }

    if (wait_event_interruptible(dev->read_wait, dev->read_data_available != 0))
        return -ERESTARTSYS;

    if (dev->read_data_available < 0)
        return dev->read_data_available; // Propagate the URB's error status

    if (copy_to_user(buf, dev->read_buffer, dev->read_data_available))
        return -EFAULT;

    return dev->read_data_available;
}

// Write: each call allocates its own URB and DMA-safe buffer, matching the
// one-shot cleanup already performed in custom_usb_write_bulk_callback above.
static ssize_t custom_usb_write(struct file *file, const char __user *buf, size_t count, loff_t *ppos) {
    struct custom_usb_dev *dev = file->private_data;
    struct urb *urb;
    unsigned char *buffer;
    size_t to_write = min(count, dev->bulk_out_size);
    int retval;

    (void)ppos;

    urb = usb_alloc_urb(0, GFP_KERNEL);
    if (!urb)
        return -ENOMEM;

    buffer = kmalloc(to_write, GFP_KERNEL);
    if (!buffer) {
        usb_free_urb(urb);
        return -ENOMEM;
    }

    if (copy_from_user(buffer, buf, to_write)) {
        kfree(buffer);
        usb_free_urb(urb);
        return -EFAULT;
    }

    usb_fill_bulk_urb(urb, dev->udev,
                       usb_sndbulkpipe(dev->udev, dev->bulk_out_endpoint_addr),
                       buffer, to_write,
                       custom_usb_write_bulk_callback, dev);

    retval = usb_submit_urb(urb, GFP_KERNEL);
    if (retval) {
        printk(KERN_ERR "custom_usb: Failed to submit write URB: %d\n", retval);
        kfree(buffer);
        usb_free_urb(urb);
        return retval;
    }

    return to_write;
}

static struct usb_driver custom_usb_driver = {
    .name       = "custom_usb",
    .probe      = custom_usb_probe,
    .disconnect = custom_usb_disconnect,
    .id_table   = custom_usb_table,
};

module_usb_driver(custom_usb_driver);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Security Engineering");
MODULE_DESCRIPTION("Custom USB driver for secure peripheral communication");
```

A few things worth calling out in this design before you'd trust it with production traffic:

*   **Never trust lengths reported by the device.** `urb->actual_length` on completion should always be validated against `dev->bulk_in_size` before it's used to size a `copy_to_user()` — a malicious or malfunctioning device is untrusted input, no different from a network peer.
*   **Lock down `/dev/custom_usbN` permissions.** By default, device nodes created via `usb_register_dev()` inherit whatever udev rule matches them. Ship a udev rule that restricts the node to a dedicated group rather than leaving it world-readable.
*   **Consider signing the module.** On a system with Secure Boot and lockdown mode enabled, an unsigned out-of-tree module won't load at all — and even without lockdown, module signing gives you a supply-chain guarantee that the `.ko` running in the kernel is the one you built.

## Conclusion

A kernel-level USB driver is more work than reaching for `libusb`, but for a device that's handling sensitive data — an HSM, a hardware token, a custom sensor — that extra work buys you kernel-enforced exclusive access, tighter integration with the kernel's own security model, and a permission boundary (the device node) that's far easier to lock down than an arbitrary user-space process. Start with the probe/disconnect/URB skeleton shown here, get bulk transfers working reliably in both directions, and only then layer on the access controls and input validation that turn a working driver into a trustworthy one.