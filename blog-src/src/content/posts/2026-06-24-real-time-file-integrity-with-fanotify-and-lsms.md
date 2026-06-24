---
title: "Real-time File Integrity with `fanotify` and LSMs"
date: 2026-06-24
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "File Integrity Monitoring (FIM) is a cornerstone of any robust security strategy. Detecting unauthorized changes to critical system files, binaries,..."
---

# Real-time File Integrity with `fanotify` and LSMs

File Integrity Monitoring (FIM) is a cornerstone of any robust security strategy. Detecting unauthorized changes to critical system files, binaries, and configuration files can be the difference between a minor incident and a full-blown breach. Traditional FIM often relies on periodic scans and cryptographic hashes, which, while valuable, introduce a detection lag. In a high-stakes environment, real-time detection is paramount.

This post dives into how we can leverage the Linux kernel's `fanotify` subsystem and Linux Security Modules (LSMs) to build a powerful, real-time FIM solution. We'll explore the technical details and provide actionable examples.

## The Limitations of Traditional FIM

Before we get into the solution, let's briefly touch upon the challenges of traditional FIM:

*   **Detection Lag:** Periodic scans, even frequent ones, mean that an unauthorized change could persist for minutes or even hours before detection. This provides an attacker with a crucial window of opportunity.
*   **Resource Overhead:** Cryptographic hashing of large file systems can be resource-intensive, leading to performance impacts if done too frequently.
*   **Post-Mortem Analysis:** While helpful for forensics, traditional FIM often tells you *what* changed, not *when* or *by whom* in real-time.

## `fanotify`: The Real-time Watcher

`fanotify` is a Linux kernel interface that provides event notification about file system access and modification. Unlike `inotify`, `fanotify` can monitor entire mount points and provides more detailed information about the process performing the action, including its PID. Crucially, `fanotify` also supports permission events, allowing us to intercept and potentially deny operations.

### Basic `fanotify` Usage

Let's start with a simple C example to demonstrate `fanotify`'s capabilities. This program will monitor a directory for create, modify, and delete events.

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <sys/fanotify.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

#define BUF_SIZE 4096

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <path_to_monitor>\n", argv[0]);
        exit(EXIT_FAILURE);
    }

    int fan_fd = fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT, O_RDONLY);
    if (fan_fd == -1) {
        perror("fanotify_init");
        exit(EXIT_FAILURE);
    }

    // Add a mark for the directory to monitor
    // FAN_MARK_ADD: Add the mark
    // FAN_MARK_MOUNT: Monitor the entire mount point containing the path
    // FAN_MODIFY | FAN_CREATE | FAN_DELETE | FAN_ATTRIB: Event types
    if (fanotify_mark(fan_fd, FAN_MARK_ADD | FAN_MARK_MOUNT,
                      FAN_MODIFY | FAN_CREATE | FAN_DELETE | FAN_ATTRIB | FAN_MOVE,
                      AT_FDCWD, argv[1]) == -1) {
        perror("fanotify_mark");
        exit(EXIT_FAILURE);
    }

    printf("Monitoring %s for file system events...\n", argv[1]);

    char buf[BUF_SIZE];
    ssize_t len;
    struct fanotify_event_metadata *metadata;

    while (1) {
        len = read(fan_fd, buf, sizeof(buf));
        if (len == -1) {
            perror("read");
            exit(EXIT_FAILURE);
        }

        metadata = (struct fanotify_event_metadata *)buf;
        while (FAN_EVENT_OK(metadata, len)) {
            if (metadata->vers < 2) {
                fprintf(stderr, "Kernel fanotify version too old\n");
                exit(EXIT_FAILURE);
            }

            // Get the path of the affected file/directory
            char path[PATH_MAX];
            ssize_t path_len = readlinkat(metadata->fd, "", path, sizeof(path) - 1);
            if (path_len == -1) {
                perror("readlinkat");
                strncpy(path, "<unknown>", sizeof(path));
            } else {
                path[path_len] = '\0';
            }

            printf("Event on %s (PID: %d): ", path, metadata->pid);

            if (metadata->mask & FAN_CREATE) printf("CREATE ");
            if (metadata->mask & FAN_MODIFY) printf("MODIFY ");
            if (metadata->mask & FAN_DELETE) printf("DELETE ");
            if (metadata->mask & FAN_ATTRIB) printf("ATTRIB ");
            if (metadata->mask & FAN_MOVE)   printf("MOVE ");
            printf("\n");

            close(metadata->fd); // Close the file descriptor received from fanotify
            metadata = FAN_EVENT_NEXT(metadata, len);
        }
    }

    close(fan_fd);
    return 0;
}
```

Compile and run:
```bash
gcc -o fanotify_monitor fanotify_monitor.c
sudo ./fanotify_monitor /etc
```

Now, try creating, modifying, or deleting a file in `/etc` (e.g., `sudo touch /etc/testfile`). You'll see real-time events reported by the monitor. This is a significant step towards real-time FIM.

## Elevating Protection with LSMs

While `fanotify` provides excellent real-time notification, it doesn't inherently *prevent* unauthorized actions. This is where Linux Security Modules (LSMs) come into play. LSMs provide a framework for security hooks into the kernel, allowing modules like SELinux, AppArmor, and others to enforce access control policies.

For our real-time FIM, we can consider two primary approaches with LSMs:

1.  **Leveraging Existing LSMs:** Configure SELinux or AppArmor to protect critical files and directories. This is the most practical and recommended approach for most production systems.
2.  **Developing a Custom LSM (Advanced):** For highly specialized requirements, one could develop a custom LSM that integrates with `fanotify` events and enforces policies directly in the kernel. This is a complex undertaking and generally reserved for specific use cases.

Let's focus on the first approach, as it's more immediately actionable.

### Integrating `fanotify` with SELinux

Imagine you want to protect `/etc/passwd` from *any* modification, even by root, unless explicitly allowed by a specific process.

1.  **`fanotify` for Alerting:** Your `fanotify` monitor continuously watches `/etc`. If it detects a `FAN_MODIFY` event on `/etc/passwd`, it immediately triggers an alert (e.g., sends a syslog message, email, or webhook to a SIEM). This provides real-time awareness.

2.  **SELinux for Enforcement:** Concurrently, SELinux enforces a policy that prevents most processes from writing to `/etc/passwd`.

    Let's create a simple SELinux policy module to illustrate. Assume we want to prevent a generic unconfined process from writing to `/etc/passwd`.

    First, ensure SELinux is in enforcing mode.

    Create a file `local_policy.te`:
    ```selinux
    # local_policy.te
    policy_module(local_policy, 1.0)

    # Type for passwd file
    type passwd_file_t;
    # Inherit from existing etc_t, but make it more restrictive
    typeattribute passwd_file_t;

    # Apply this type to the /etc/passwd file
    file_type(passwd_file_t)

    # Deny write access to passwd_file_t for unconfined domains
    # This is an example; in a real scenario, you'd target specific domains.
    # Here, we're broadly denying most domains.
    dontaudit domain passwd_file_t:file { write append };

    # Allow read access for everyone (e.g., for login)
    allow domain passwd_file_t:file { read getattr open };
    ```

    Compile and load the policy:
    ```bash
    checkmodule -M -m -o local_policy.mod local_policy.te
    semodule_package -o local_policy.pp -m local_policy.mod
    sudo semodule -i local_policy.pp
    ```

    Now, label `/etc/passwd` with this new type:
    ```bash
    sudo semanage fcontext -a -t passwd_file_t "/etc/passwd"
    sudo restorecon -v /etc/passwd
    ```

    Try to modify `/etc/passwd` as a regular user or even root (e.g., `echo "test" | sudo tee -a /etc/passwd`).
    You will likely see a permission denied error, and if your `fanotify` monitor is running, it will still report the attempt.

    **Key Insight:** `fanotify` provides the *alert* that an attempt was made, giving you immediate visibility. SELinux provides the *enforcement* that prevents the attempt from succeeding. This layered approach is incredibly powerful.

### `fanotify` for Permission Events

`fanotify` can also monitor for `FAN_OPEN_PERM` and `FAN_ACCESS_PERM` events. These are particularly interesting because they allow an application to intercept and *deny* an operation before it completes. When a `_PERM` event occurs, the kernel sends an event to the `fanotify` listener and waits for a response (`FAN_ALLOW` or `FAN_DENY`).

This capability is typically used by sophisticated security products (e.g., antivirus, DLP solutions) that require fine-grained control over file access. Implementing this yourself requires careful consideration of performance and deadlocks, as your `fanotify` application essentially becomes a gatekeeper for file operations.

A basic example of using `FAN_OPEN_PERM`:

```c
// Modify fanotify_init and fanotify_mark calls from the previous example
// fan_fd = fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT | FAN_UNLIMITED_MARKS | FAN_UNLIMITED_NOTIFS, O_RDONLY);
// fanotify_mark(fan_fd, FAN_MARK_ADD | FAN_MARK_MOUNT, FAN_OPEN_PERM, AT_FDCWD, argv[1])

// Inside the while loop, when a FAN_OPEN_PERM event is received:
if (metadata->mask & FAN_OPEN_PERM) {
    printf("Permission request to