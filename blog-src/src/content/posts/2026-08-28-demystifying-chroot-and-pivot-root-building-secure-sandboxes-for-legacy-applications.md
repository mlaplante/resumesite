---
title: "Demystifying chroot and pivot_root: Building Secure Sandboxes for Legacy Applications"
date: 2026-08-28
category: "thought-leadership"
tags: ["linux", "security", "sandboxing", "system-administration", "legacy-systems", "engineering"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of information security and operations, we often encounter the challenge of managing legacy applications. These applications, while..."
---

# Demystifying chroot and pivot_root: Building Secure Sandboxes for Legacy Applications

In the world of information security and operations, we often encounter the challenge of managing legacy applications. These applications, while critical to business operations, frequently present significant security risks due to outdated dependencies, unpatched vulnerabilities, or simply a lack of modern security considerations in their original design. Containerization technologies like Docker and Kubernetes have become the de facto standard for isolating modern applications, but what about those stubborn applications that refuse to run in a container, or where the overhead of a full container runtime is overkill?

This is where understanding Linux primitives like `chroot` and `pivot_root` becomes incredibly valuable. While not a complete security panacea, they offer powerful, lightweight mechanisms for creating isolated environments, effectively sandboxing legacy applications to mitigate their potential impact on the host system. Let's peel back the layers and understand how these tools work and how we can leverage them.

## The Humble `chroot`: A Change of Root

`chroot` (change root) is perhaps the more well-known of the two. It changes the apparent root directory for the current running process and its children. From the perspective of the `chroot`ed process, the new directory *is* `/`. This is a fundamental building block for many security solutions and even for creating minimalist development environments.

### How `chroot` Works

When you `chroot` a process into a new directory, say `/my/sandbox`, any file path starting with `/` will now resolve relative to `/my/sandbox`. So, if the `chroot`ed process tries to open `/etc/passwd`, it will actually be trying to open `/my/sandbox/etc/passwd`.

**Key Limitation:** `chroot` is *not* a security boundary on its own. A process running as root *inside* a `chroot` can easily break out. For example, it can use `cd ../../..` to navigate outside the `chroot` if the environment is not carefully constructed, or simply call `fchdir()` to change its current working directory to a file descriptor that points outside the `chroot`. The primary security benefit comes from restricting the *visibility* of files, making it harder for a compromised application to access sensitive system files or traverse the filesystem.

### Practical `chroot` Example

Let's say we have an old, vulnerable web server `legacy_httpd` that we want to run in a restricted environment.

1.  **Prepare the Sandbox Directory:**
    First, we need a directory structure that mimics a minimal Linux system.

    ```bash
    mkdir /var/chroot_jail
    mkdir /var/chroot_jail/{bin,etc,lib,lib64,usr}
    mkdir /var/chroot_jail/usr/{bin,lib,lib64}
    ```

2.  **Copy Essential Binaries and Libraries:**
    The `legacy_httpd` and any commands it needs (like `ls`, `cat`, `sh`) must be present inside the `chroot_jail`. Don't forget their shared libraries!

    ```bash
    # Copy the httpd binary
    cp /path/to/legacy_httpd /var/chroot_jail/bin/

    # Copy minimal shell and utilities
    cp /bin/bash /var/chroot_jail/bin/
    cp /bin/ls /var/chroot_jail/bin/
    cp /bin/cat /var/chroot_jail/bin/

    # Identify and copy shared libraries for each binary
    # Example for bash:
    for i in $(ldd /bin/bash | grep -o '/lib[^ ]*' | sort -u); do
        cp "$i" "/var/chroot_jail/$i"
    done
    # Repeat for legacy_httpd, ls, cat, etc.
    # This can be automated with a script or a more robust tool like debootstrap for Debian-based systems.
    ```
    *Pro-tip:* `ldd <binary>` will show you all the shared libraries a binary depends on. You'll need to copy these into the corresponding `lib` or `lib64` directories within your `chroot_jail`. Be meticulous, as missing libraries will lead to runtime errors.

3.  **Copy Configuration Files:**
    The application will likely need its configuration files.

    ```bash
    mkdir /var/chroot_jail/etc
    cp /path/to/legacy_httpd.conf /var/chroot_jail/etc/
    cp /etc/passwd /var/chroot_jail/etc/ # Minimal passwd for user accounts
    cp /etc/group /var/chroot_jail/etc/ # Minimal group for user accounts
    ```

4.  **Mount `/proc` and `/dev` (if needed):**
    Some applications require access to `/proc` (process information) or `/dev` (device files). These need to be bind-mounted.

    ```bash
    mount -o bind /proc /var/chroot_jail/proc
    mount -o bind /dev /var/chroot_jail/dev
    ```
    *Note:* Only bind-mount what is absolutely necessary. Less access means a smaller attack surface.

5.  **Enter the `chroot`:**

    ```bash
    sudo chroot /var/chroot_jail /bin/bash
    ```
    Now you are in the `chroot`ed environment. You can verify this by trying to `ls /` – you'll only see the contents of `/var/chroot_jail`. From here, you can start your `legacy_httpd`.

### `chroot` Takeaways:
*   **Visibility Restriction:** Limits what files a process can "see."
*   **Dependencies:** Requires careful copying of all necessary binaries and libraries.
*   **Not a Hard Security Boundary:** A root process can escape. Best combined with user separation (running the `chroot`ed app as a non-privileged user).
*   **Lightweight:** Minimal overhead compared to full virtualization or container runtimes.

## `pivot_root`: The More Powerful (and Complex) Sibling

`pivot_root` is a more robust mechanism, often used in initramfs during boot and by container runtimes to truly change the root filesystem. Unlike `chroot`, which only changes the *apparent* root, `pivot_root` actually *moves* the entire root filesystem of the current process and its children. The old root filesystem is then available at a specified mount point within the new root.

### How `pivot_root` Works

The `pivot_root` system call takes two arguments: `new_root` and `put_old`.
*   `new_root`: The directory that will become the new root filesystem.
*   `put_old`: A directory within `new_root` where the *old* root filesystem will be remounted.

After `pivot_root` is called, the process's root directory is changed to `new_root`. The old root filesystem is detached and mounted at `put_old`. This allows the system to completely disassociate from the original root filesystem.

**Key Advantage:** `pivot_root` is generally considered more secure than `chroot` because it fully detaches the old root filesystem. Escaping `pivot_root` is significantly harder, especially for non-privileged processes, because the original filesystem is no longer the root and can be unmounted and removed.

### Practical `pivot_root` Example for a Sandbox

Let's refine our `legacy_httpd` sandboxing using `pivot_root`. This requires a bit more care with mount points.

1.  **Prepare the New Root Filesystem:**
    This is similar to `chroot`, but we typically prepare a dedicated filesystem (e.g., a loopback device, a separate partition, or a temporary `tmpfs`) rather than just a directory on the existing root. For simplicity, we'll use a directory on the existing root, but be aware of the implications.

    ```bash
    mkdir /mnt/new_root
    mkdir /mnt/new_root/{bin,etc,lib,lib64,usr,old_root}
    mkdir /mnt/new_root/usr/{bin,lib,lib64}
    # ... Copy binaries, libraries, and configs as with chroot ...
    ```
    Ensure `/mnt/new_root/old_root` exists. This is where the original root will be placed.

2.  **Mount the New Root as a Separate Filesystem (Crucial for Security):**
    While you *can* `pivot_root` into a subdirectory, using a separate mount point (even a `tmpfs` or a bind-mount of a new image) makes `pivot_root` more robust.

    ```bash
    # Create a temporary tmpfs for our new root
    mount -t tmpfs none /mnt/new_root

    # Now populate /mnt/new_root with your application's environment
    # Copy essential binaries, libraries, configs into /mnt/new_root
    # ... (as shown in the chroot example) ...
    ```

3.  **Prepare `/proc` and `/dev` (if needed) within the New Root:**
    These *must* be mounted *after* the `pivot_root` or bind-mounted from the host. For a truly isolated environment, remounting `/proc` and `/dev` from scratch within the new root is often preferred.

    ```bash
    # Within /mnt/new_root, create mount points
    mkdir /mnt/new_root/proc
    mkdir /mnt/new_root/dev
    ```

4.  **Perform `pivot_root`:**
    You need to be root to do this.

    ```bash
    cd /mnt/new_root # Change current directory to the new root
    sudo pivot_root . old_root # '.' is new_root, 'old_root' is where the old root goes
    ```
    After this command, your `/` is now `/mnt/new_root`, and the original `/` is mounted at `/old_root`.

5.  **Clean Up the Old Root and Mount `/proc`, `/dev`:**
    Now that the old root is at `/old_root`, you can unmount it and clean up.

    ```bash
    # Unmount the old root
    sudo umount /old_root

    # Remove the old_root directory if it's empty
    sudo rmdir /old_root

    # Mount /proc and /dev within the new root
    sudo mount -t proc none /proc
    sudo mount -t devtmpfs none /dev # Or use bind mounts if preferred
    ```
    At this point, you are truly isolated. Processes started here will see `/` as the new root filesystem, and the original system files are no longer directly accessible.

6.  **Start the Application:**
    Now you can start your `legacy_httpd` service.

### `pivot_root` Takeaways:
*   **Stronger Isolation:** Fully detaches the old root, making escapes much harder.
*   **Complexity:** Requires more careful handling of mount points