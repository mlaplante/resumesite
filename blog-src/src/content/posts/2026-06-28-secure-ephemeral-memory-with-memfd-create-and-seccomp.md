---
title: "Secure Ephemeral Memory With Memfd_create and Seccomp"
date: 2026-06-28
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of information security, handling sensitive data is a constant challenge. Whether it's cryptographic keys, passwords, or proprietary..."
---

In the realm of information security, handling sensitive data is a constant challenge. Whether it's cryptographic keys, passwords, or proprietary algorithms, we need robust mechanisms to protect this information from unauthorized access. While many solutions focus on disk encryption or network security, a critical attack surface often overlooked is the memory space of a running process. This is where `memfd_create` and `seccomp` come into play, offering a powerful combination for creating secure, ephemeral memory regions.

## The Problem: Sensitive Data in Plain Memory

Traditionally, sensitive data might be loaded into memory as plain C strings or byte arrays. This data resides in the process's virtual address space, accessible by any other process that can gain sufficient privileges (e.g., through root access or exploiting a vulnerability). While memory protection mechanisms exist, they are often not granular enough for specific, short-lived sensitive data.

## Introducing `memfd_create`: Anonymous File Descriptors

The `memfd_create` system call, introduced in Linux kernel 3.17, provides a novel solution. It creates an anonymous file that resides entirely in RAM. This file is not associated with any filesystem path, making it inherently ephemeral. Crucially, it's accessible only via the returned file descriptor.

Here's a basic example of how to use `memfd_create`:

```c
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
    // Create an anonymous file in RAM, with a name for debugging purposes.
    // MFD_CLOEXEC ensures the file descriptor is closed on exec.
    int fd = memfd_create("sensitive_data_region", MFD_CLOEXEC);
    if (fd == -1) {
        perror("memfd_create");
        exit(EXIT_FAILURE);
    }

    printf("Created memfd with file descriptor: %d\n", fd);

    // You can now use standard file operations on this fd, like write, read, ftruncate.
    const char *secret = "This is my super secret key.";
    ssize_t written = write(fd, secret, strlen(secret));
    if (written == -1) {
        perror("write");
        close(fd);
        exit(EXIT_FAILURE);
    }

    printf("Wrote %zd bytes to the memfd.\n", written);

    // To retrieve the data, you'd typically read from the fd.
    // For demonstration, let's seek back and read.
    if (lseek(fd, 0, SEEK_SET) == -1) {
        perror("lseek");
        close(fd);
        exit(EXIT_FAILURE);
    }

    char buffer[100];
    ssize_t read_bytes = read(fd, buffer, sizeof(buffer) - 1);
    if (read_bytes == -1) {
        perror("read");
        close(fd);
        exit(EXIT_FAILURE);
    }
    buffer[read_bytes] = '\0';
    printf("Read from memfd: %s\n", buffer);

    // The memory region is automatically reclaimed when the last file descriptor
    // referring to it is closed.
    close(fd);
    printf("Closed memfd.\n");

    return 0;
}
```

**Key Benefits of `memfd_create`:**

*   **No Filesystem Footprint:** The data never touches persistent storage, reducing the risk of accidental exposure through disk backups or forensics.
*   **Ephemeral:** The memory is reclaimed by the kernel when all file descriptors referencing it are closed.
*   **Accessible via File Descriptor:** Access control is managed through standard file descriptor permissions.

## Enhancing Security with `seccomp`: Restricting System Calls

While `memfd_create` provides a secure memory *location*, we also need to control *how* this memory is accessed. This is where `seccomp` (secure computing mode) shines. `seccomp` allows a process to restrict the system calls it can make, significantly reducing its attack surface.

By combining `memfd_create` with `seccomp`, we can create a process that:

1.  Creates a `memfd` to hold sensitive data.
2.  Writes the sensitive data into the `memfd`.
3.  **Immediately restricts its own system call interface** to only allow operations necessary for processing the data (e.g., `read`, `write` on that specific `memfd`, `close`, `fstat`). It would deny calls like `open`, `unlink`, `mount`, `execve`, etc.

This creates a highly controlled environment. Even if an attacker gains control of the process, their ability to interact with the sensitive data or the system is severely limited.

### Implementing Seccomp with `prctl`

The `seccomp` functionality is typically enabled using the `prctl` system call with the `PR_SET_SECCOMP` option. You define a filter program in Berkeley Packet Filter (BPF) bytecode.

Here's a conceptual example of how you might set up a `seccomp` filter to allow only essential system calls after creating a `memfd`:

```c
#define _GNU_SOURCE
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>

// Example BPF program to allow only specific syscalls
// This is a simplified example. A real-world scenario would be more complex.
// We'll allow: read, write, close, fstat, and the original syscall number for exit.
// This example assumes you know the syscall numbers for your architecture.
// For x86_64:
// SYS_read      0
// SYS_write     1
// SYS_close     3
// SYS_fstat     5
// SYS_exit      60

// Note: The structure of 'struct sock_filter' and 'struct sock_fprog'
// and the BPF instructions are complex and architecture-dependent.
// This is a conceptual illustration.
// For a robust implementation, consider using libraries like libseccomp.

void enable_seccomp(int allowed_syscall_number) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offsetof(struct seccomp_data, nr))),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, allowed_syscall_number, 0, 1), // If syscall is allowed, jump to end
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS), // Otherwise, kill the process
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),        // Allow the syscall
    };

    struct sock_fprog prog = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) == -1) {
        perror("prctl(PR_SET_SECCOMP)");
        // In a real application, you'd handle this error more gracefully.
        // For this example, we'll just print and continue, but seccomp won't be active.
    } else {
        printf("Seccomp filter enabled.\n");
    }
}

int main() {
    // 1. Create memfd (as shown previously)
    int fd = memfd_create("secure_data", MFD_CLOEXEC);
    if (fd == -1) {
        perror("memfd_create");
        exit(EXIT_FAILURE);
    }
    printf("Created memfd with fd: %d\n", fd);

    // 2. Write sensitive data
    const char *sensitive_data = "MySecretPassword123";
    if (write(fd, sensitive_data, strlen(sensitive_data)) == -1) {
        perror("write");
        close(fd);
        exit(EXIT_FAILURE);
    }
    printf("Wrote sensitive data.\n");

    // 3. Enable Seccomp
    // This example is highly simplified and will likely kill the process
    // if you try to read from the memfd *after* enabling seccomp with this filter,
    // as SYS_read is not explicitly allowed in the jump target.
    // A real filter would be more complex, allowing specific syscalls like read/write on 'fd'.
    // For demonstration, let's allow SYS_exit.
    // You'd need to know your architecture's syscall numbers.
    // On x86_64, SYS_exit is 60.
    // For a real use case, you'd allow: read, write, close, fstat, etc.
    printf("Attempting to enable seccomp (allowing SYS_exit only for demo)...\n");
    enable_seccomp(SYS_exit); // This will likely kill the program if you try anything else.

    printf("Seccomp enabled. Trying to read...\n");

    // If seccomp was set up correctly to allow read/write on the fd,
    // this read would work. With the simplified filter above, it will likely fail.
    if (lseek(fd, 0, SEEK_SET) == -1) {
        perror("lseek (seccomp active)");
        // This lseek might fail if not allowed by seccomp.
    }

    char buffer[100];
    ssize_t read_bytes = read(fd, buffer, sizeof(buffer) - 1);
    if (read_bytes == -1) {
        perror("read (seccomp active)");
        // This read will likely fail with the simplified filter.
    } else {
        buffer[read_bytes] = '\0';
        printf("Read from memfd: %s\n", buffer);
    }

    // Attempting to open a new file here would fail if seccomp is active.
    // int another_fd = open("test.txt", O_RDONLY);
    // if (another_fd == -1) {
    //     perror("open (seccomp active)"); // This should fail if open is not allowed.
    // }


    close(fd);
    printf("Closed memfd.\n");

    // Exit is allowed by our seccomp filter.
    return 0;
}
```

**Important Considerations for `seccomp`:**

*   **Complexity:** Crafting a correct and secure `seccomp` filter by hand, as shown above, is challenging and error-prone — a single wrong jump offset either fails open, allowing a dangerous syscall through, or fails closed, killing the process on a syscall it actually needed. In production code, reach for `libseccomp` instead of hand-assembled BPF:

    ```c
    #include <seccomp.h>

    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL); // default-deny everything
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(read), 0);
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(write), 0);
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(close), 0);
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(fstat), 0);
    seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(exit_group), 0);
    seccomp_load(ctx);
    seccomp_release(ctx);
    ```

    `libseccomp` lets you allow syscalls by name, add per-argument conditions with `seccomp_rule_add`'s comparator arguments (for example, restricting `write` to only the memfd's specific file descriptor), and target the right syscall table for your architecture — all without touching raw BPF opcodes.
*   **Ordering Matters:** Apply the `seccomp` filter only *after* you've created the `memfd`, written the sensitive data, and finished any setup that needs broader syscall access. Once loaded, a filter is irrevocable for the life of the process — you can only stack more restrictive filters on top of it, never loosen what's already there.
*   **Pair It with `PR_SET_NO_NEW_PRIVS`:** Call `prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)` before loading the filter. This stops the process, and anything it later `execve`s, from regaining privileges through a setuid binary, closing off a common seccomp bypass.
*   **Test Exhaustively:** Enumerate every syscall your code path actually needs, including the ones libc issues on your behalf — `mmap` and `brk` for `malloc`, `rt_sigaction`, `futex` for threading — before locking the filter down. Running the unrestricted binary under `strace -f` is the fastest way to build an accurate allowlist.

## Conclusion

Combining `memfd_create` with a tightly scoped `seccomp` filter gives you a memory region that never touches disk and a process that, even if fully compromised, has almost nothing left to do. Neither primitive is a silver bullet by itself: `memfd_create` won't stop a co-resident process with `ptrace` privileges, and `seccomp` won't save you from a syscall you forgot to deny. Together, though, they meaningfully shrink the blast radius of a process handling keys, tokens, or other sensitive data in memory — and for that class of problem, the added complexity is worth it.