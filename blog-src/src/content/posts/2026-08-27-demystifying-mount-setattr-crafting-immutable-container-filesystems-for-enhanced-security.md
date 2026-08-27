---
title: "Demystifying mount_setattr: Crafting Immutable Container Filesystems for Enhanced Security"
date: 2026-08-27
category: "thought-leadership"
tags: ["linux", "security", "containers", "filesystem", "system-calls", "immutability"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of containerized applications, security is paramount. One of the most effective strategies for bolstering security is to embrace..."
---

# Demystifying mount_setattr: Crafting Immutable Container Filesystems for Enhanced Security

In the world of containerized applications, security is paramount. One of the most effective strategies for bolstering security is to embrace immutability – the principle that once a system or component is deployed, it should not be modified. For containers, this often translates to read-only root filesystems, preventing attackers from modifying binaries, injecting malware, or altering critical configurations post-deployment. While tools like Docker's `read-only` flag or Kubernetes' `readOnlyRootFilesystem` are a good start, they often rely on existing mount options and can sometimes be circumvented or lack fine-grained control.

This is where `mount_setattr`, a relatively new Linux system call introduced in kernel 5.12, comes into play. It offers a powerful, granular way to modify mount attributes, including making a mounted filesystem truly immutable from a security perspective, even for privileged processes. Let's dive into how `mount_setattr` works and how we can leverage it to create more secure container environments.

## The Challenge with Traditional Read-Only Mounts

Before `mount_setattr`, achieving robust read-only filesystems often involved:

1.  **`MS_RDONLY` mount flag:** This is the most common approach. When you specify `ro` in `/etc/fstab` or use `mount -o ro`, you're essentially applying this flag. While effective for most user processes, root can remount the filesystem as read-write (`mount -o remount,rw /mnt/myfs`). This is a significant security gap if an attacker gains root privileges inside a container.
2.  **Filesystem-level immutability:** Some filesystems like SquashFS are inherently read-only. While excellent for base images, they aren't suitable for layers that need to be writable during the build process.
3.  **AppArmor/SELinux:** These MAC frameworks can restrict write access, but they operate at a different layer and can be complex to configure correctly for all scenarios.

The core issue is that `MS_RDONLY` is a *suggestion* to the kernel that can be overridden by a privileged user. We need something stronger.

## Enter `mount_setattr`: A New Era of Mount Control

`mount_setattr` allows you to atomically change various attributes of an existing mount point. Its true power for security lies in its ability to apply attributes that *cannot be undone* by a simple `remount` operation, even by root.

The system call signature looks like this:

```c
int mount_setattr(int dfd, const char *path, unsigned int flags, struct mount_attr *attr);
```

Key arguments:

*   `dfd`, `path`: Identify the mount point.
*   `flags`: Control how `path` is resolved (e.g., `AT_EMPTY_PATH` for an already open file descriptor, `AT_RECURSIVE` to apply to submounts).
*   `attr`: A structure containing the attributes to set. This is where the magic happens.

For our purpose of creating immutable filesystems, the `mount_attr` struct has a crucial field: `attr_set`. Within `attr_set`, we're interested in `MOUNT_ATTR_IMMUTABLE`.

## Crafting an Immutable Container Root Filesystem

Let's walk through a practical example of how you could leverage `mount_setattr` to make a container's root filesystem truly immutable *after* it has been set up but *before* the main application process starts.

Imagine a container runtime or an orchestrator like Kubernetes that wants to enforce this.

### Step 1: Prepare a Container Image

First, you'd build your container image as usual. It would have a writable root filesystem during the build process.

```dockerfile
# Dockerfile
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y nginx
COPY index.html /var/www/html/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Step 2: Run the Container and Apply `mount_setattr`

Now, let's simulate how a hypothetical container runtime could launch this and then "lock down" its root filesystem. We'll use a small C program to call `mount_setattr`.

First, compile the C program:

```c
// lock_mount.c
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <unistd.h>

// Helper for mount_setattr system call
int __mount_setattr(int dfd, const char *path, unsigned int flags, struct mount_attr *attr) {
    return syscall(SYS_mount_setattr, dfd, path, flags, attr);
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <mount_point>\n", argv[0]);
        return EXIT_FAILURE;
    }

    const char *mount_point = argv[1];
    struct mount_attr attr = {0};

    // Set the IMMUTABLE attribute
    attr.attr_set = MOUNT_ATTR_IMMUTABLE;

    printf("Attempting to set MOUNT_ATTR_IMMUTABLE on %s...\n", mount_point);

    if (__mount_setattr(AT_FDCWD, mount_point, 0, &attr) == -1) {
        perror("mount_setattr failed");
        return EXIT_FAILURE;
    }

    printf("Successfully set MOUNT_ATTR_IMMUTABLE on %s.\n", mount_point);

    // Verify by attempting a write
    printf("Attempting to create a file in %s...\n", mount_point);
    FILE *fp = fopen("/test_immutable.txt", "w");
    if (fp == NULL) {
        perror("Failed to create file (as expected)");
    } else {
        fprintf(stderr, "ERROR: Successfully created file, immutability failed!\n");
        fclose(fp);
        unlink("/test_immutable.txt");
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
```

Compile it:

```bash
gcc -o lock_mount lock_mount.c
```

Now, let's run a Docker container, copy our `lock_mount` binary into it, and execute it *inside* the container, targeting the root filesystem (`/`).

```bash
# Build the nginx image (if not already built)
docker build -t my-nginx-immutable .

# Run the container in privileged mode initially to allow mount_setattr
# In a real orchestrator, this would be handled by the runtime itself,
# which would have the necessary capabilities.
docker run --rm -it --privileged --name immutable-test my-nginx-immutable bash

# Inside the container:
# Copy the compiled lock_mount binary into the container
docker cp ./lock_mount immutable-test:/usr/local/bin/

# Now, execute it inside the container
# This would typically be a step performed by the container runtime
# after initial setup and before the application starts.
docker exec immutable-test /usr/local/bin/lock_mount /

# Expected output from lock_mount:
# Attempting to set MOUNT_ATTR_IMMUTABLE on /...
# Successfully set MOUNT_ATTR_IMMUTABLE on /.
# Attempting to create a file in /...
# Failed to create file (as expected): Read-only file system

# Verify further by trying to touch a file
docker exec immutable-test touch /another_test.txt
# touch: cannot touch '/another_test.txt': Read-only file system

# Try to modify an existing file (e.g., /etc/hosts)
docker exec immutable-test sh -c "echo 'hello' >> /etc/hosts"
# sh: 1: cannot create /etc/hosts: Read-only file system

# Even trying to remount as rw won't work:
docker exec immutable-test mount -o remount,rw /
# mount: /: permission denied.
# (This error message can vary depending on kernel version and capabilities)
```

**Important Note on `--privileged`:** Running a container with `--privileged` in Docker gives it almost full host capabilities. In a production scenario, a container runtime would use specific capabilities (like `CAP_SYS_ADMIN` and potentially `CAP_DAC_OVERRIDE` if paths need to be resolved against a different user's permissions) to perform the `mount_setattr` call, not a blanket `--privileged` flag. The goal is that the *application container itself* does not have these capabilities; only the runtime orchestrating it does.

## How `MOUNT_ATTR_IMMUTABLE` Differs

The key distinction with `MOUNT_ATTR_IMMUTABLE` is that once set, it's sticky. It cannot be unset, and the filesystem cannot be remounted read-write, even by a process with `CAP_SYS_ADMIN`. The only way to remove this attribute is to unmount the filesystem entirely.

This makes it incredibly powerful for security:

*   **Post-Exploitation Defense:** Even if an attacker gains root within the container, they cannot modify the core binaries or configuration files on the root filesystem. This significantly limits their ability to persist, escalate privileges, or pivot.
*   **Integrity Guarantees:** You can have higher confidence that the deployed binaries are precisely what you intended, reducing the risk of supply chain attacks or accidental corruption.
*   **Simplified Auditing:** If an immutable filesystem is involved, you know that any changes must have occurred in a separate, explicitly writable volume, simplifying incident response.

## Actionable Takeaways for Enhanced Container Security

1.  **Understand `mount_setattr`'s Potential:** Recognize that `mount_setattr` is a game-changer for enforcing filesystem immutability beyond what traditional `MS_RDONLY` offers.
2.  **Advocate for Runtime Integration:** If you're involved in designing container platforms or runtimes, push for the integration of `mount_setattr` to enforce immutable root filesystems by default or as a strong option. This could be a post-creation hook that locks down the mount.
3.  **Kernel Version Awareness:** Remember that `mount_setattr` requires Linux kernel 5.12 or newer. Ensure your host systems meet this requirement if you plan to utilize it.
4.  **Layered Security:** While `mount_setattr` provides strong filesystem immutability, it's part of a broader security strategy. Combine it with:
    *   **Least Privilege:** Run container processes as non-root users.
    *   **Seccomp Profiles:** Restrict available system calls.
    *   **AppArmor/SELinux:** Add mandatory access control.
    *   **Read-Only Volumes for Data:** Use separate read-only volumes for configuration or static