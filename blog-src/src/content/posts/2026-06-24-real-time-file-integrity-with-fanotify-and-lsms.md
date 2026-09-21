---
title: "Real-time File Integrity with `fanotify` and LSMs"
date: 2026-06-24
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "File Integrity Monitoring (FIM) is a cornerstone of any robust security strategy. Detecting unauthorized changes to critical system files, binaries,..."
---

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
    printf("Permission request to open %s (PID: %d): ", path, metadata->pid);

    struct fanotify_response response;
    response.fd = metadata->fd;

    // In a real FIM/DLP tool, this decision would come from a policy
    // lookup, a hash check against a known-good baseline, or a call out
    // to a decision service — not a blanket allow. Here we just allow
    // and log, to keep the example focused on the response mechanics.
    response.response = FAN_ALLOW;
    printf("ALLOWED\n");

    if (write(fan_fd, &response, sizeof(response)) != sizeof(response)) {
        perror("write response");
    }
}
```

**A critical warning about permission events:** the process that opened the file is blocked, waiting on the kernel, until your listener writes a `fanotify_response`. If your listener's decision logic needs to read or write anything on the same filesystem it's monitoring — including, say, a log file or a local policy cache — you can deadlock the entire mount point. Keep the decision path either entirely in-memory or backed by a filesystem you are *not* monitoring with `FAN_OPEN_PERM`.

## Putting It Together: A Layered Real-Time FIM Architecture

The pattern that emerges from combining these two mechanisms is a classic detect-and-enforce split, and it's worth being explicit about which tool does which job:

*   **`fanotify` is your sensor.** It gives you real-time, process-attributed visibility into what's happening on the filesystem — who touched what, when, and how. Used with `_PERM` events, it can also act as a last-resort gatekeeper for operations no other layer caught.
*   **The LSM is your durable policy layer.** SELinux or AppArmor policy survives a compromised or crashed FIM daemon, because it's enforced in the kernel independent of any userspace process being alive and healthy. This matters a lot: a userspace `fanotify` listener that gets killed (or that an attacker manages to starve) stops alerting, but LSM policy keeps denying.

In production, you'd wire the `fanotify` alert path into whatever you already use for detection — syslog, a Unix socket to a local agent, or directly into a SIEM pipeline — and treat SELinux/AppArmor denials as a second, independent signal. If you ever see an LSM denial in the audit log (`ausearch -m avc`) without a corresponding `fanotify` alert, that's worth investigating on its own: it usually means your `fanotify` marks don't cover something your LSM policy does.

## Practical Limitations to Plan For

*   **`FAN_MARK_MOUNT` and `FAN_CLASS_CONTENT`/`FAN_CLASS_PRE_CONTENT` require `CAP_SYS_ADMIN`.** Your FIM daemon needs to run privileged (or with that specific capability), which makes it itself a high-value target — protect it accordingly.
*   **Permission events add latency to every matched syscall.** Every `open()` on a monitored path now waits on a round trip to userspace. Scope your `_PERM` marks tightly (specific files or directories, not entire mount points), or you'll measurably slow down the system.
*   **A crashed or hung listener with active `_PERM` marks can hang the filesystem.** If your process dies while permission events are outstanding, pending opens on marked paths can be left blocked — test this failure mode deliberately before relying on it in production.
*   **Older kernels have narrower visibility.** Features like `FAN_REPORT_FID` (reporting file handles instead of open file descriptors, useful when you can't safely hold an fd open) were added incrementally across kernel versions — check what your target kernel actually supports before designing around a specific flag.

## Conclusion

Real-time FIM isn't just "run `fanotify` and call it done." The real value comes from treating `fanotify` and your LSM as complementary layers: one gives you visibility and can act as an emergency gate, the other gives you policy that holds even if your userspace tooling goes down. Build the alerting path first, get it feeding into whatever you already use for detection, and only reach for `_PERM` events on the small set of paths where blocking-on-decision is actually worth the latency and deadlock risk. For everything else, let SELinux or AppArmor carry the enforcement weight — that's what they're built for.