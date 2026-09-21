---
title: "Demystifying mount_setattr: Crafting Immutable Container Filesystems for Enhanced Security"
date: 2026-08-27
category: "thought-leadership"
tags: ["linux", "security", "containers", "filesystem", "system-calls", "immutability"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of containerized applications, security is paramount. One of the most effective strategies for bolstering security is to embrace..."
---

In the world of containerized applications, security is paramount. One of the most effective strategies for bolstering security is to embrace immutability – the principle that once a system or component is deployed, it should not be modified. For containers, this often translates to read-only root filesystems, preventing attackers from modifying binaries, injecting malware, or altering critical configurations post-deployment. While tools like Docker's `read-only` flag or Kubernetes' `readOnlyRootFilesystem` are a good start, they often rely on existing mount options and can sometimes be circumvented or lack fine-grained control.

This is where `mount_setattr`, a relatively new Linux system call introduced in kernel 5.12, comes into play. It offers a powerful, granular way to modify mount attributes — including applying a read-only attribute atomically and recursively across an entire mount tree, in a way the classic `mount(2)`/remount dance can't match. On its own it doesn't make a filesystem immune to a privileged process reverting it; what makes a container's root filesystem genuinely hard to reverse is pairing `mount_setattr` with dropping the capability that would let anyone remount it. Let's dive into how `mount_setattr` actually works and how to combine it with capability dropping to build a real hardened, read-only container root.

## The Challenge with Traditional Read-Only Mounts

Before `mount_setattr`, achieving robust read-only filesystems often involved:

1.  **`MS_RDONLY` mount flag:** This is the most common approach. When you specify `ro` in `/etc/fstab` or use `mount -o ro`, you're essentially applying this flag. While effective for most user processes, root can remount the filesystem as read-write (`mount -o remount,rw /mnt/myfs`). This is a significant security gap if an attacker gains root privileges inside a container.
2.  **Filesystem-level immutability:** Some filesystems like SquashFS are inherently read-only. While excellent for base images, they aren't suitable for layers that need to be writable during the build process.
3.  **AppArmor/SELinux:** These MAC frameworks can restrict write access, but they operate at a different layer and can be complex to configure correctly for all scenarios.

The core issue is that `MS_RDONLY` is a *suggestion* to the kernel that can be overridden by a privileged user. We need something stronger.

## Enter `mount_setattr`: A New Era of Mount Control

`mount_setattr` allows you to atomically change various attributes of an existing mount point — and, with the right flag, do it recursively across every submount in a tree in one call, instead of walking each mount by hand with `mount -o remount`.

The system call signature looks like this:

```c
int mount_setattr(int dirfd, const char *path, unsigned int flags,
                   struct mount_attr *attr, size_t size);
```

Key arguments:

*   `dirfd`, `path`: Identify the mount point.
*   `flags`: Control how `path` is resolved (e.g., `AT_EMPTY_PATH` for an already open file descriptor, `AT_RECURSIVE` to apply the change to every submount beneath `path`, not just the mount point itself).
*   `attr`: A `struct mount_attr` describing the attributes to set (`attr_set`) and clear (`attr_clr`).
*   `size`: The size of the `struct mount_attr` passed in — always `sizeof(attr)`. This extra argument (absent from the older `mount(2)`) is what lets the kernel grow the struct in future releases without breaking old binaries, the same pattern used by newer syscalls like `sched_setattr`.

For our purpose of building a read-only container root, the field we care about in `attr_set` is `MOUNT_ATTR_RDONLY` — the same read-only semantics as the classic `MS_RDONLY` mount flag, but applied through a call that can target an entire mount tree atomically instead of one mount at a time.

## Crafting a Read-Only Container Root Filesystem

Let's walk through a practical example of how you could leverage `mount_setattr` to lock a container's root filesystem read-only *after* it has been set up but *before* the main application process starts — and then take the extra step that actually makes it stick: dropping the capability that would let anyone undo it.

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
#include <linux/mount.h>   // struct mount_attr, MOUNT_ATTR_* (not in glibc's sys/mount.h yet)
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

// Wrapper for the mount_setattr system call (glibc has no wrapper for it yet)
static int do_mount_setattr(int dirfd, const char *path, unsigned int flags,
                             struct mount_attr *attr, size_t size) {
    return syscall(SYS_mount_setattr, dirfd, path, flags, attr, size);
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <mount_point>\n", argv[0]);
        return EXIT_FAILURE;
    }

    const char *mount_point = argv[1];
    struct mount_attr attr = {0};

    // Set the read-only attribute; AT_RECURSIVE (below) applies it to every
    // submount under mount_point in one atomic call.
    attr.attr_set = MOUNT_ATTR_RDONLY;

    printf("Attempting to set MOUNT_ATTR_RDONLY on %s...\n", mount_point);

    if (do_mount_setattr(AT_FDCWD, mount_point, AT_RECURSIVE, &attr, sizeof(attr)) == -1) {
        perror("mount_setattr failed");
        return EXIT_FAILURE;
    }

    printf("Successfully set MOUNT_ATTR_RDONLY on %s.\n", mount_point);

    // Verify by attempting a write
    printf("Attempting to create a file in %s...\n", mount_point);
    FILE *fp = fopen("/test_readonly.txt", "w");
    if (fp == NULL) {
        perror("Failed to create file (as expected)");
    } else {
        fprintf(stderr, "ERROR: Successfully created file, read-only mount failed!\n");
        fclose(fp);
        unlink("/test_readonly.txt");
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
# Attempting to set MOUNT_ATTR_RDONLY on /...
# Successfully set MOUNT_ATTR_RDONLY on /.
# Attempting to create a file in /...
# Failed to create file (as expected): Read-only file system

# Verify further by trying to touch a file
docker exec immutable-test touch /another_test.txt
# touch: cannot touch '/another_test.txt': Read-only file system

# Try to modify an existing file (e.g., /etc/hosts)
docker exec immutable-test sh -c "echo 'hello' >> /etc/hosts"
# sh: 1: cannot create /etc/hosts: Read-only file system

# But because this container still has CAP_SYS_ADMIN (we ran it --privileged),
# a root process inside it CAN remount the tree read-write again:
docker exec immutable-test mount -o remount,rw /
# (succeeds — no error)
docker exec immutable-test touch /another_test.txt
# (now succeeds too — the read-only attribute is gone)
```

**This is the part that's easy to miss.** `mount_setattr` applied `MOUNT_ATTR_RDONLY` atomically and recursively, which is genuinely useful, but the attribute itself is no stickier than the read-only bit `mount -o ro` has always set: anything holding `CAP_SYS_ADMIN` in the mount's namespace can remount it read-write again. There is no flag that makes a mount attribute survive a privileged remount — if you want that, the mechanism is capabilities, not the mount call.

**Important Note on `--privileged`:** Running a container with `--privileged` in Docker gives it almost full host capabilities, `CAP_SYS_ADMIN` included, which is exactly why the remount above succeeded. In a production scenario, a container runtime would perform the `mount_setattr` call itself — using its *own* `CAP_SYS_ADMIN`, from outside the container — and then start the application process in the container **without** `CAP_SYS_ADMIN` at all. The goal is that the *application container itself* never holds the capability that could reverse the mount; only the runtime orchestrating it does, and only briefly, before the workload starts.

## Making the Read-Only Mount Actually Stick

The fix isn't a stronger `mount_setattr` flag — it's making sure nothing inside the container can call `mount_setattr` (or plain `mount -o remount,rw`) with effect. Two pieces do that:

*   **Drop `CAP_SYS_ADMIN` before the application starts.** A container runtime typically does the `mount_setattr` call as one of its last privileged setup steps, then execs the application process with a capability set that no longer includes `CAP_SYS_ADMIN` (e.g. via `capset(2)` or, in Docker/OCI terms, simply not granting it — this is Docker's non-`--privileged` default). With `CAP_SYS_ADMIN` gone, `mount -o remount,rw` inside the container fails with `EPERM`, full stop.
*   **Or scope it to a user namespace that doesn't map to the host.** A process can hold `CAP_SYS_ADMIN` *inside* its own user namespace without that capability meaning anything on the host mount namespace — this is how rootless container runtimes let an unprivileged user "administer" their own sandbox without ever being root outside it.

Once either of those is true, the atomic, recursive `MOUNT_ATTR_RDONLY` that `mount_setattr` applied really does become effectively unreversible from inside the container — not because the attribute is special, but because nothing left in the container has the privilege to undo it.

This combination is genuinely useful for security:

*   **Post-Exploitation Defense:** If an attacker gains root *inside* the container but the container process never had `CAP_SYS_ADMIN`, they cannot modify the core binaries or configuration files on the root filesystem, and they cannot remount their way around that. This significantly limits their ability to persist, escalate privileges, or pivot.
*   **Integrity Guarantees:** You can have higher confidence that the deployed binaries are precisely what you intended, reducing the risk of supply chain attacks or accidental corruption.
*   **Simplified Auditing:** If a read-only root filesystem is enforced this way, you know that any changes must have occurred in a separate, explicitly writable volume, simplifying incident response.

## Actionable Takeaways for Enhanced Container Security

1.  **Understand what `mount_setattr` actually buys you:** an atomic, recursive way to apply `MOUNT_ATTR_RDONLY` (and friends) across a whole mount tree in one call — not a stronger, unreversible form of read-only. The durability comes from capability dropping, not the syscall.
2.  **Advocate for Runtime Integration:** If you're involved in designing container platforms or runtimes, push for `mount_setattr` plus capability dropping as a post-creation hook that locks down the mount *and* removes the ability to undo it, before the application process starts.
3.  **Kernel Version Awareness:** Remember that `mount_setattr` requires Linux kernel 5.12 or newer. Ensure your host systems meet this requirement if you plan to utilize it.
4.  **Layered Security:** `mount_setattr` plus capability dropping is one layer of a broader security strategy. Combine it with:
    *   **Least Privilege:** Run container processes as non-root users.
    *   **Seccomp Profiles:** Restrict available system calls.
    *   **AppArmor/SELinux:** Add mandatory access control.
    *   **Read-Only Volumes for Data:** Use separate read-only volumes for configuration or static assets that genuinely need to change between deployments, so you never have to punch a hole in the immutable root to accommodate them.

## Wrapping Up

`mount_setattr`'s real advantage over the classic `mount(2)`/`remount` dance is that it operates per-mount rather than per-superblock, and with `AT_RECURSIVE` it can apply the same attribute atomically across an entire mount tree in one call — no more walking submounts by hand to make sure a `bind` mount underneath didn't stay writable. What actually keeps a container from reversing its own read-only root isn't a sticky bit on the mount; it's dropping `CAP_SYS_ADMIN` (or confining it to a user namespace that doesn't map to the host) before the application process starts, so there's no capability left in the container that a remount could succeed under. Treat `mount_setattr` as the tool that lets a privileged runtime set that state up cleanly and atomically — the immutability itself comes from the capability boundary you build around it, not from the syscall alone.