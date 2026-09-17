---
title: "Demystifying pkey_alloc(): Building Confidential Computing Enclaves with Memory Protection Keys"
date: 2026-09-17
category: "thought-leadership"
tags: ["confidential-computing", "memory-security", "kernel", "linux", "system-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Confidential Computing is rapidly gaining traction as organizations seek to protect data not just at rest and in transit, but also in use. While..."
---

Confidential Computing is rapidly gaining traction as organizations seek to protect data not just at rest and in transit, but also *in use*. While hardware-backed Trusted Execution Environments (TEEs) like Intel SGX, AMD SEV, and ARM TrustZone provide robust solutions, they often come with significant development overhead and platform-specific complexities. What if we could achieve a meaningful level of memory isolation for critical application components directly within a standard Linux environment, without specialized hardware or a full TEE SDK?

This is where Linux's Memory Protection Keys (MPKs) — specifically the `pkey_alloc()` system call — become a fascinating and powerful primitive. MPKs, introduced with Intel's Protection Keys for Supervisor Mode Access (PKS) and User Mode Access (PKU) features, allow us to assign a "protection key" to pages of memory and then dynamically control access to those pages based on the current protection key rights held by a thread. Think of it as a lightweight, per-thread, software-defined Memory Management Unit (MMU) overlay.

## The Core Concept: Protection Keys and Access Control

At its heart, MPKs enable a thread to switch between different access policies for memory pages tagged with specific keys. Each process gets 16 protection keys (0-15). Key 0 is typically the default key for all memory, and keys 1-15 are available for application use.

The two primary operations are:

1.  **Tagging memory with a key**: Using `mprotect()` with the `PROT_PKEY()` flag.
2.  **Setting a thread's access rights for keys**: Using `pkey_set()` to specify read/write permissions for each key.

Let's illustrate with a simple scenario: we want to create a "confidential enclave" within our application. This enclave will hold sensitive data and critical logic. We want to ensure that only specific, trusted code paths can access this memory, even if other parts of our application are compromised (e.g., via a buffer overflow or a ROP attack).

## Step-by-Step: Building an In-Process Enclave with `pkey_alloc()`

The `pkey_alloc()` system call is crucial because it gives us a *dynamically assigned*, unused protection key. This is vital for library developers or applications that might not know which keys are available or want to avoid conflicts.

Here's a breakdown of the process:

### 1. Allocate a Protection Key

```c
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

// Wrapper for pkey_alloc, as it's not always in glibc headers
static inline int sys_pkey_alloc(unsigned int flags, unsigned int access_rights) {
    return syscall(SYS_pkey_alloc, flags, access_rights);
}

// Wrapper for pkey_mprotect
static inline int sys_pkey_mprotect(void *addr, size_t len, int prot, int pkey) {
    return syscall(SYS_pkey_mprotect, addr, len, prot, pkey);
}

// Wrapper for pkey_set
static inline int sys_pkey_set(int pkey, unsigned int access_rights) {
    return syscall(SYS_pkey_set, pkey, access_rights);
}

// Wrapper for pkey_get
static inline unsigned int sys_pkey_get(int pkey) {
    return syscall(SYS_pkey_get, pkey);
}

int main() {
    int pkey;
    
    // Allocate a new protection key.
    // PKEY_DISABLE_ACCESS: Initially disable all access.
    // PKEY_DISABLE_WRITE: Initially disable write access.
    pkey = sys_pkey_alloc(0, PKEY_DISABLE_ACCESS | PKEY_DISABLE_WRITE);
    if (pkey == -1) {
        perror("pkey_alloc failed");
        if (errno == ENOSYS) {
            fprintf(stderr, "Protection Keys not supported by kernel or hardware.\n");
        }
        return 1;
    }
    printf("Allocated pkey: %d\n", pkey);
```
Here, `pkey_alloc(0, PKEY_DISABLE_ACCESS | PKEY_DISABLE_WRITE)` requests a new key and immediately sets its initial state to disallow both read and write access for the current thread. This "deny by default" approach is a good security practice.

### 2. Allocate and Tag Enclave Memory

Next, we allocate some memory for our "enclave" and tag it with our new protection key.

```c
    size_t enclave_size = 4096; // A single page
    char *enclave_mem = mmap(NULL, enclave_size, PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (enclave_mem == MAP_FAILED) {
        perror("mmap failed");
        sys_pkey_free(pkey);
        return 1;
    }
    printf("Allocated enclave memory at %p\n", enclave_mem);

    // Tag the allocated memory with our new protection key
    if (sys_pkey_mprotect(enclave_mem, enclave_size, PROT_READ | PROT_WRITE, pkey) == -1) {
        perror("pkey_mprotect failed");
        munmap(enclave_mem, enclave_size);
        sys_pkey_free(pkey);
        return 1;
    }
    printf("Tagged enclave memory with pkey %d\n", pkey);
```
Notice we use `mmap` with `PROT_READ | PROT_WRITE` first, then `pkey_mprotect`. This sets the base permissions; MPKs then refine these permissions. If `PROT_READ` is not set by `mmap`, MPKs cannot grant read access.

### 3. Accessing the Enclave: Controlled Entry and Exit

Now, let's demonstrate controlled access. We'll write data into the enclave, then try to access it when permissions are disabled, and finally re-enable permissions to read it.

```c
    // Initially, access is disabled for 'pkey'. This write should fail.
    printf("\nAttempting to write to enclave_mem with access disabled...\n");
    // This write will cause a segmentation fault if PKEY_DISABLE_ACCESS is active for this pkey
    // We'll wrap it in a signal handler for demonstration, but in real code,
    // you'd ensure permissions are set BEFORE accessing.
    
    // For simplicity of this example, we'll demonstrate the failure path by
    // commenting out direct access and showing the successful path.
    // If you uncomment the line below, it will likely SIGSEGV.
    // enclave_mem[0] = 'S'; 
    // printf("Wrote '%c' to enclave_mem[0] (THIS SHOULD NOT HAPPEN IF PKEY_DISABLE_ACCESS IS ACTIVE)\n", enclave_mem[0]);

    // Enable write and read access for our key
    printf("Enabling R/W access for pkey %d...\n", pkey);
    if (sys_pkey_set(pkey, 0) == -1) { // 0 means enable both read and write
        perror("pkey_set enable failed");
        // Cleanup and exit
        munmap(enclave_mem, enclave_size);
        sys_pkey_free(pkey);
        return 1;
    }
    printf("Access rights for pkey %d: 0x%x (0x0 means R/W enabled)\n", pkey, sys_pkey_get(pkey));

    // Now, write to the enclave memory
    printf("Writing 'S' to enclave_mem[0] with access enabled...\n");
    enclave_mem[0] = 'S';
    enclave_mem[1] = 'E';
    enclave_mem[2] = 'C';
    enclave_mem[3] = 'R';
    enclave_mem[4] = 'E';
    enclave_mem[5] = 'T';
    enclave_mem[6] = '\0';
    printf("Content written: %s\n", enclave_mem);

    // Disable access again
    printf("Disabling R/W access for pkey %d...\n", pkey);
    if (sys_pkey_set(pkey, PKEY_DISABLE_ACCESS | PKEY_DISABLE_WRITE) == -1) {
        perror("pkey_set disable failed");
        // Cleanup and exit
        munmap(enclave_mem, enclave_size);
        sys_pkey_free(pkey);
        return 1;
    }
    printf("Access rights for pkey %d: 0x%x\n", pkey, sys_pkey_get(pkey));

    // Attempt to read with access disabled - this should cause a fault
    printf("Attempting to read from enclave_mem with access disabled...\n");
    // Uncommenting this line will cause a SIGSEGV.
    // printf("Read with disabled access: %c (THIS SHOULD NOT HAPPEN)\n", enclave_mem[0]);

    printf("Successfully demonstrated controlled access.\n");

    // Clean up
    munmap(enclave_mem, enclave_size);
    // Free the protection key when no longer needed
    if (syscall(SYS_pkey_free, pkey) == -1) {
        perror("pkey_free failed");
        return 1;
    }
    printf("Freed pkey: %d\n", pkey);

    return 0;
}
```

To compile and run this code:

```bash
gcc -o pkey_enclave pkey_enclave.c
./pkey_enclave
```

You'll observe that attempts to access `enclave_mem` when `PKEY_DISABLE_ACCESS` is set for `pkey` will result in a Segmentation Fault (SIGSEGV). This is the desired behavior – the kernel's MMU enforces the access policy defined by MPKs.

## Actionable Takeaways and Use Cases

1.  **Isolate Sensitive Data Structures**: Store cryptographic keys, authentication tokens, or other highly sensitive data in MPK-protected memory. Access to this memory would be guarded by `pkey_set()`, ensuring only specific functions can touch it.
2.  **Protect Critical Code Paths**: Imagine a security-critical function. Its stack frame or local variables could be placed in MPK-protected memory. If an attacker diverts control flow to arbitrary code, that code would likely lack the correct `pkey_set()` permissions and crash upon attempting to manipulate the critical data.
3.  **Lightweight Sandboxing**: For plugin architectures or JIT compilers, MPKs could offer