---
title: "Demystifying `memfd_secret`: Building Secure, Confidential Computing Enclaves in Linux"
date: 2026-09-05
category: "thought-leadership"
tags: ["linux", "security", "kernel", "confidential-computing", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Confidential computing is a hot topic, promising to protect data not just at rest and in transit, but in use. While hardware-based trusted execution..."
---

# Demystifying `memfd_secret`: Building Secure, Confidential Computing Enclaves in Linux

Confidential computing is a hot topic, promising to protect data not just at rest and in transit, but *in use*. While hardware-based trusted execution environments (TEEs) like Intel SGX or AMD SEV get a lot of attention, the Linux kernel is also evolving to provide software-defined mechanisms for isolating sensitive data. One such powerful, yet often overlooked, addition is the `memfd_secret` system call.

This post will dive deep into `memfd_secret`, explaining its purpose, how it works, and demonstrating a practical example of its use for creating secure, confidential memory regions within a standard Linux environment.

## The Problem: Protecting Secrets in Memory

Consider a scenario where your application handles sensitive data – cryptographic keys, personal identifiable information (PII), or financial records. Even if your application runs in a container or VM, the data in its memory space is typically accessible to the host kernel. A malicious root user or a compromised kernel module could potentially inspect or dump your process's memory, exposing these secrets.

Traditional approaches often involve:
*   **Zeroing memory:** Manually overwriting sensitive data with zeros after use, but this doesn't prevent inspection *during* use.
*   **`mlock`:** Locking pages into RAM to prevent swapping, which helps against disk-based attacks but not against kernel inspection.
*   **Hardware TEEs:** The most robust solution, but often requires specialized hardware, specific tooling, and significant architectural changes.

`memfd_secret` offers a compelling alternative for certain use cases, providing a software-defined, kernel-protected memory region that is inaccessible to the kernel itself (under normal operation) and other processes.

## What is `memfd_secret`?

Introduced in Linux kernel 5.14, `memfd_secret` is a system call that creates an anonymous file descriptor (similar to `memfd_create`) backed by "secret" memory. The key characteristic of this secret memory is that it's encrypted and/or protected by the kernel such that the kernel itself cannot directly read its contents.

How does it achieve this?
1.  **Memory Encryption:** On systems with memory encryption capabilities (e.g., AMD SEV-ES or Intel TDX), `memfd_secret` can leverage these hardware features to encrypt the memory pages. This means even if the kernel or a hypervisor tries to access these pages, they will only see encrypted data.
2.  **Explicit Protection:** Even without hardware memory encryption, `memfd_secret` can still isolate pages by preventing kernel access paths. The kernel will not map these pages into its own address space, nor will it allow them to be swapped to disk in an unencrypted form.

The `memfd_secret` memory region is:
*   **Private:** Only accessible by the process(es) that explicitly map it.
*   **Isolated:** Not readable by the kernel or other processes.
*   **Swap-protected:** Cannot be swapped to disk by default.
*   **Fork-safe:** Child processes inherit the secret memory mapping, but the memory is *not* copied-on-write. Instead, it becomes shared read-only and *cannot be written to* by either parent or child after the fork. This is a crucial security detail to prevent accidental leakage through copy-on-write behavior.

## A Practical Example: Storing a Sensitive Key

Let's walk through a C example demonstrating how to use `memfd_secret` to store a hypothetical cryptographic key.

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <fcntl.h>
#include <errno.h>

// Define the memfd_secret syscall number if not available in headers
#ifndef __NR_memfd_secret
#define __NR_memfd_secret 461 // Check your architecture's syscall table
#endif

// Wrapper for the memfd_secret syscall
static inline int memfd_secret(unsigned int flags) {
    return syscall(__NR_memfd_secret, flags);
}

#define SECRET_SIZE 64 // Size for our hypothetical key
#define MFD_SECRET_EXEC 0x01 // Flag for executable secret memory (not used here)

int main() {
    int fd;
    char *secret_key_ptr = NULL;
    char temp_buffer[SECRET_SIZE]; // For demonstrating data persistence

    printf("Attempting to create a memfd_secret region...\n");

    // 1. Create the memfd_secret file descriptor
    // MFD_CLOEXEC: close on exec
    // 0: no special flags for now (like MFD_SECRET_EXEC)
    fd = memfd_secret(MFD_CLOEXEC);
    if (fd == -1) {
        if (errno == ENOSYS) {
            fprintf(stderr, "ERROR: memfd_secret syscall not available. "
                            "Requires Linux kernel 5.14+ and appropriate hardware/kernel config.\n");
        } else if (errno == EOPNOTSUPP) {
            fprintf(stderr, "ERROR: memfd_secret is not supported by the underlying hardware/kernel configuration.\n");
        } else {
            perror("memfd_secret");
        }
        return EXIT_FAILURE;
    }
    printf("memfd_secret file descriptor created: %d\n", fd);

    // 2. Truncate the secret memory region to the desired size
    if (ftruncate(fd, SECRET_SIZE) == -1) {
        perror("ftruncate");
        close(fd);
        return EXIT_FAILURE;
    }
    printf("Secret memory region truncated to %d bytes.\n", SECRET_SIZE);

    // 3. Map the secret memory into our process's address space
    secret_key_ptr = mmap(NULL, SECRET_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (secret_key_ptr == MAP_FAILED) {
        perror("mmap");
        close(fd);
        return EXIT_FAILURE;
    }
    printf("Secret memory mapped at address: %p\n", (void *)secret_key_ptr);

    // 4. Write our sensitive data (e.g., a 64-byte AES key)
    memset(secret_key_ptr, 0, SECRET_SIZE); // Initialize
    const char *key_data = "ThisIsMySuperSecretAESKeyThatIs64BytesLongAndVeryImportant1234";
    strncpy(secret_key_ptr, key_data, SECRET_SIZE - 1); // Copy key, ensure null termination if shorter
    secret_key_ptr[SECRET_SIZE - 1] = '\0'; // Just in case, for string-like data

    printf("Sensitive key written to secret memory.\n");
    printf("Key in secret memory (first 16 bytes): %.*s...\n", 16, secret_key_ptr);

    // 5. Demonstrate persistence and access
    // Copy out to a temporary buffer to prove it's there
    strncpy(temp_buffer, secret_key_ptr, SECRET_SIZE);
    temp_buffer[SECRET_SIZE - 1] = '\0';
    printf("Key copied from secret memory to temp_buffer: %s\n", temp_buffer);

    // --- SECURITY CONSIDERATIONS ---
    // At this point, the key is in secret_key_ptr.
    // A malicious process or the kernel *should not* be able to read this memory.
    // Let's try to simulate reading it from /proc/self/mem (which should fail for secret pages)
    printf("\nAttempting to read from /proc/self/mem (should fail for secret pages)...\n");
    FILE *mem_file = fopen("/proc/self/mem", "rb");
    if (mem_file) {
        if (fseek(mem_file, (off_t)secret_key_ptr, SEEK_SET) == 0) {
            char read_buf[SECRET_SIZE];
            memset(read_buf, 0, SECRET_SIZE);
            size_t bytes_read = fread(read_buf, 1, SECRET_SIZE, mem_file);
            printf("Read %zu bytes from /proc/self/mem at %p. Content: %.*s...\n",
                   bytes_read, (void *)secret_key_ptr, (int)bytes_read, read_buf);
            if (bytes_read == 0 && ferror(mem_file)) {
                printf("Error reading from /proc/self/mem: %s (This is expected for secret memory!)\n", strerror(errno));
            }
        } else {
            perror("fseek on /proc/self/mem");
        }
        fclose(mem_file);
    } else {
        perror("fopen /proc/self/mem");
    }

    // 6. When done, zero out the memory and unmap
    printf("\nZeroing out secret memory and unmapping...\n");
    memset(secret_key_ptr, 0, SECRET_SIZE); // Crucial for post-use cleanup

    if (munmap(secret_key_ptr, SECRET_SIZE) == -1) {
        perror("munmap");
    }

    // 7. Close the file descriptor
    if (close(fd) == -1) {
        perror("close fd");
    }

    printf("Application finished.\n");
    return EXIT_SUCCESS;
}
```

### Compiling and Running

To compile:
```bash
gcc -o memfd_secret_test memfd_secret_test.c
```

To run:
```bash
sudo ./memfd_secret_test
```
**Why `sudo`?** While `memfd_secret` itself doesn't strictly require root, the `/proc/self/mem` access often does, and some kernel configurations might restrict `memfd_secret` to privileged users or require specific capabilities. Running with `sudo` simplifies testing this example.

### Expected Output and Analysis

When you run this on a compatible system (Linux 5.14+ with `CONFIG_MEMFD_SECRET` enabled), you'll observe:

1.  Successful creation of the `memfd_secret` file descriptor.
2.  Successful mapping of the memory.
3.  The key written to and read from `secret_key_ptr`.
4.  **Crucially:** The attempt to read from `/proc/self/mem` at the address of `secret_key_ptr` will likely result in an error or read zero bytes, often with `EIO` (Input/output error) or `EPERM` (Operation not permitted). This is the explicit protection at work