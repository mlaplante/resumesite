---
title: "Demystifying Landlock: Crafting Fine-Grained Filesystem Sandboxes for Linux Applications"
date: 2026-09-11
category: "thought-leadership"
tags: ["linux", "security", "sandboxing", "landlock", "syscall-filtering", "c-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of application security, the principle of least privilege is paramount. Restricting what an application can access, especially its..."
---

# Demystifying Landlock: Crafting Fine-Grained Filesystem Sandboxes for Linux Applications

In the realm of application security, the principle of least privilege is paramount. Restricting what an application can access, especially its interaction with the filesystem, significantly reduces the attack surface. While tools like `chroot` and `seccomp` provide some level of isolation, they often fall short when truly fine-grained control over filesystem access is required. This is where `landlock` steps in, offering a robust, kernel-level mechanism to define precise access rules for a process and its children.

`landlock` is a Linux Security Module (LSM) that allows unprivileged processes to create and enforce their own security policies. Unlike `seccomp` which filters system calls, `landlock` operates at a higher semantic level, defining what *types* of filesystem operations are permitted on *specific* filesystem objects (files or directories). This distinction is crucial: you're not just blocking `openat`, but saying "this process can only read from `/etc/config` and write to `/var/log/myapp.log`."

Let's dive into how `landlock` works and walk through a practical example of sandboxing a simple application.

## The `landlock` Philosophy: Rules and Layers

At its core, `landlock` operates with rulesets. A ruleset is a collection of rules, each specifying a path and a set of allowed access rights. When a process attempts a filesystem operation, `landlock` checks if the operation is permitted by any active ruleset.

Key concepts:

1.  **Rulesets:** An empty ruleset is created using `landlock_create_ruleset()`.
2.  **Rules:** Rules are added to a ruleset using `landlock_add_rule()`. A rule consists of a file descriptor (representing a directory or file) and a bitmask of allowed access rights (e.g., `LANDLOCK_ACCESS_FS_READ_FILE`, `LANDLOCK_ACCESS_FS_WRITE_FILE`).
3.  **Enforcement:** Once a ruleset is populated, it's enforced on the current process using `landlock_restrict_self()`. From that point on, any filesystem access not explicitly permitted by the ruleset (or inherited from a parent process's `landlock` ruleset) will result in a permission error.

It's important to note that `landlock` policies are *additive* for children processes. If a parent process restricts itself with `landlock`, its children will inherit a policy that is *at least as restrictive* as the parent's. They can further restrict themselves, but they cannot loosen inherited restrictions.

## Practical Example: Sandboxing a Fictional Log Processor

Imagine a simple C program, `log_processor`, that needs to:

1.  Read configuration from `/etc/log_processor/config.json`.
2.  Read log files from `/var/log/input/`.
3.  Write processed logs to `/var/log/output/`.
4.  Write its own operational logs to `/tmp/log_processor.log`.

All other filesystem access should be denied.

Let's write a C program that uses `landlock` to enforce this.

```c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/syscall.h>

// Landlock system call wrappers (from landlock-tools or manual definitions)
// These typically come from a header like <linux/landlock.h> but we define them for clarity
// For a production system, use the official headers or liblandlock.
#ifndef LANDLOCK_ABI_LAST
#define LANDLOCK_ABI_LAST 1
#endif

struct landlock_ruleset_attr {
    __u64 handled_access_fs;
    __u32 abi;
    __u32 pad;
};

enum landlock_rule_type {
    LANDLOCK_RULE_TYPE_PATH_BENEATH = 1,
};

struct landlock_path_beneath_attr {
    __u64 allowed_access_fs;
    __s32 parent_fd;
};

// Access rights bitmasks
#define LANDLOCK_ACCESS_FS_EXECUTE              (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE           (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE            (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR             (1ULL << 3)
#define LANDLOCK_ACCESS_FS_WRITE_DIR            (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE          (1ULL << 5)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR           (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR            (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_DIR             (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_REG             (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK            (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO            (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK           (1ULL << 12)
#define LANDLOCK_ACCESS_FS_MAKE_SYM             (1ULL << 13)
#define LANDLOCK_ACCESS_FS_REFER_FILES          (1ULL << 14)
#define LANDLOCK_ACCESS_FS_TRUNCATE             (1ULL << 15)
#define LANDLOCK_ACCESS_FS_ACCESS_MASK          (LANDLOCK_ACCESS_FS_EXECUTE | \
                                                 LANDLOCK_ACCESS_FS_WRITE_FILE | \
                                                 LANDLOCK_ACCESS_FS_READ_FILE | \
                                                 LANDLOCK_ACCESS_FS_READ_DIR | \
                                                 LANDLOCK_ACCESS_FS_WRITE_DIR | \
                                                 LANDLOCK_ACCESS_FS_REMOVE_FILE | \
                                                 LANDLOCK_ACCESS_FS_REMOVE_DIR | \
                                                 LANDLOCK_ACCESS_FS_MAKE_CHAR | \
                                                 LANDLOCK_ACCESS_FS_MAKE_DIR | \
                                                 LANDLOCK_ACCESS_FS_MAKE_REG | \
                                                 LANDLOCK_ACCESS_FS_MAKE_SOCK | \
                                                 LANDLOCK_ACCESS_FS_MAKE_FIFO | \
                                                 LANDLOCK_ACCESS_FS_MAKE_BLOCK | \
                                                 LANDLOCK_ACCESS_FS_MAKE_SYM | \
                                                 LANDLOCK_ACCESS_FS_REFER_FILES | \
                                                 LANDLOCK_ACCESS_FS_TRUNCATE)


static inline int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
    return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static inline int landlock_add_rule(int ruleset_fd, enum landlock_rule_type type, const void *attr, __u32 flags) {
    return syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}

static inline int landlock_restrict_self(int ruleset_fd, __u32 flags) {
    return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

// Helper to open a directory and add a rule
static int add_path_rule(int ruleset_fd, const char *path, __u64 access_rights) {
    int fd = open(path, O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) {
        perror("open for landlock rule");
        return -1;
    }

    struct landlock_path_beneath_attr attr = {
        .allowed_access_fs = access_rights,
        .parent_fd = fd,
    };

    if (landlock_add_rule(ruleset_fd, LANDLOCK_RULE_TYPE_PATH_BENEATH, &attr, 0)) {
        perror("landlock_add_rule");
        close(fd);
        return -1;
    }
    close(fd); // The kernel holds a reference, we can close our FD
    printf("Added rule for '%s' with access 0x%llx\n", path, access_rights);
    return 0;
}

int main() {
    // 1. Initialize Landlock ruleset
    struct landlock_ruleset_attr attr = {
        .handled_access_fs = LANDLOCK_ACCESS_FS_READ_FILE |
                             LANDLOCK_ACCESS_FS_WRITE_FILE |
                             LANDLOCK_ACCESS_FS_READ_DIR |
                             LANDLOCK_ACCESS_FS_MAKE_REG, // For creating new log files
        .abi = LANDLOCK_ABI_LAST,
    };

    int ruleset_fd = landlock_create_ruleset(&attr, sizeof(attr), 0);
    if (ruleset_fd < 0) {
        if (errno == EOPNOTSUPP) {
            fprintf(stderr, "Landlock is not supported by this kernel or not enabled.\n");
        } else {
            perror("landlock_create_ruleset");
        }
        return EXIT_FAILURE;
    }
    printf("Landlock ruleset created (FD: %d).\n", ruleset_fd);

    // 2. Add rules for allowed paths
    // config.json: read file only
    if (add_path_rule(ruleset_fd, "/etc/log_processor", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR) != 0) return EXIT_FAILURE;
    
    // /var/log/input: read files and directories
    if (add_path_rule(ruleset_fd, "/var/log/input", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR) != 0) return EXIT_FAILURE;

    // /var/log/output: write files, make new regular files, read directory (for listing)
    if (add_path_rule(ruleset_fd, "/var/log/output", LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_READ_DIR) != 0) return EXIT_FAILURE;

    // /tmp: write a specific log file, make new regular file (for log_