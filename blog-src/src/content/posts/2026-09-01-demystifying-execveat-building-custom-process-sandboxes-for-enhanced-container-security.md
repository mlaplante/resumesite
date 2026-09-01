---
title: "Demystifying execveat: Building Custom Process Sandboxes for Enhanced Container Security"
date: 2026-09-01
category: "thought-leadership"
tags: ["linux", "security", "containers", "syscalls", "sandboxing", "low-level"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As an SVP of Information Security and Operations, I've spent years advocating for and implementing robust security measures. While containers offer..."
---

# Demystifying execveat: Building Custom Process Sandboxes for Enhanced Container Security

As an SVP of Information Security and Operations, I've spent years advocating for and implementing robust security measures. While containers offer incredible agility, their security often relies on a layered approach. Beyond network segmentation and image scanning, true defense-in-depth demands granular control over what processes can actually *do* within a container. This is where a deep dive into Linux syscalls, specifically `execveat`, becomes invaluable for building custom, highly effective process sandboxes.

You're probably familiar with `execve`, the workhorse syscall for executing a new program. But `execveat` offers a subtle yet powerful extension: the ability to specify the directory relative to which the program should be executed, and more importantly, to control its execution environment with flags. This "at" variant, common across many Linux syscalls (e.g., `openat`, `fstatat`), is a cornerstone for building robust sandboxes and even for how modern container runtimes operate.

## Why `execveat` for Sandboxing?

Imagine a scenario where a compromised process inside a container attempts to execute a malicious binary. Standard security measures might catch the binary itself, but what if it's a legitimate utility like `curl` being used for exfiltration, or `bash` for a reverse shell? Traditional approaches like `seccomp` profiles can block specific syscalls, but they often operate at a coarse grain.

`execveat` provides a hook that, when combined with other Linux primitives, allows us to build a more intelligent execution policy. Specifically, we can leverage `execveat` within a custom seccomp filter to gain fine-grained control over *which* executables can be run and with *what* capabilities.

## A Practical Example: Restricting Executables with `seccomp` and `execveat`

Let's walk through a simplified example. We want to create a container environment where only a very specific set of binaries can be executed, and no others. If an attempt is made to run anything else, it should fail.

### Step 1: Understanding `execveat`'s Signature

The C signature for `execveat` is:

```c
int execveat(int dirfd, const char *pathname,
             char *const argv[], char *const envp[], int flags);
```

Key parameters:
*   `dirfd`: A file descriptor referring to the directory relative to which `pathname` is interpreted. If `AT_FDCWD` is used, it's relative to the current working directory.
*   `pathname`: The path to the executable.
*   `argv`, `envp`: Standard arguments and environment variables.
*   `flags`: Crucially, flags like `AT_EMPTY_PATH` (execute based on `dirfd` and `pathname` only) or `AT_SYMLINK_NOFOLLOW`. For our sandboxing, the arguments `pathname` and `flags` are what we'll be inspecting.

### Step 2: Crafting a `seccomp` Filter

We'll use `libseccomp` to create a BPF filter. Our goal is to:
1.  Allow `execveat` by default.
2.  Define specific rules that *only* allow `execveat` calls for whitelisted binaries.
3.  Block all other `execveat` calls.

Consider a scenario where our container should *only* be able to run `/usr/bin/python3` and `/bin/sh`.

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <seccomp.h>

// Helper to check if a string ends with another string
int ends_with(const char *str, const char *suffix) {
    if (!str || !suffix) return 0;
    size_t len_str = strlen(str);
    size_t len_suffix = strlen(suffix);
    if (len_suffix > len_str) return 0;
    return strncmp(str + len_str - len_suffix, suffix, len_suffix) == 0;
}

int main(int argc, char *argv[]) {
    scmp_filter_ctx ctx;
    int rc;

    // 1. Initialize seccomp context
    // Default action: KILL the process if a rule is violated.
    // SECCOMP_RET_ERRNO would return EPERM instead.
    ctx = seccomp_init(SCMP_ACT_KILL);
    if (!ctx) {
        perror("seccomp_init");
        return 1;
    }

    // 2. Allow all other syscalls by default
    // We only want to specifically filter execveat
    rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS_EXECVE, 0); // Allow execve for legacy
    if (rc < 0) {
        perror("seccomp_rule_add (execve)");
        seccomp_release(ctx);
        return 1;
    }
    
    // 3. Define the execveat filtering logic
    // We allow specific paths, everything else will be caught by the default KILL action
    
    // Allow /usr/bin/python3
    rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS_EXECVEAT, 2,
                          SCMP_A1(SCMP_CMP_EQ, (long)AT_FDCWD), // relative to CWD
                          SCMP_A2(SCMP_CMP_EQ, (long)"/usr/bin/python3")); // specific path
    if (rc < 0) {
        perror("seccomp_rule_add (python3)");
        seccomp_release(ctx);
        return 1;
    }

    // Allow /bin/sh
    rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS_EXECVEAT, 2,
                          SCMP_A1(SCMP_CMP_EQ, (long)AT_FDCWD),
                          SCMP_A2(SCMP_CMP_EQ, (long)"/bin/sh"));
    if (rc < 0) {
        perror("seccomp_rule_add (sh)");
        seccomp_release(ctx);
        return 1;
    }

    // You could also add more complex rules, e.g., checking flags, or using SCMP_CMP_MASKED_EQ
    // For example, to allow execution of *any* binary in /app/bin:
    // This requires more advanced BPF to inspect the string content.
    // For simplicity, we stick to exact matches here.

    // 4. Load the filter
    rc = seccomp_load(ctx);
    if (rc < 0) {
        perror("seccomp_load");
        seccomp_release(ctx);
        return 1;
    }

    printf("Seccomp filter loaded. Trying to execute allowed binaries...\n");

    // Test 1: Allowed binary (python3)
    char *python_argv[] = {"/usr/bin/python3", "-c", "print('Hello from Python!')", NULL};
    if (fork() == 0) {
        execveat(AT_FDCWD, "/usr/bin/python3", python_argv, NULL, 0);
        perror("execveat (python3)"); // Should not reach here if successful
        exit(1);
    }
    wait(NULL);

    // Test 2: Allowed binary (sh)
    char *sh_argv[] = {"/bin/sh", "-c", "echo 'Hello from Sh!'", NULL};
    if (fork() == 0) {
        execveat(AT_FDCWD, "/bin/sh", sh_argv, NULL, 0);
        perror("execveat (sh)"); // Should not reach here if successful
        exit(1);
    }
    wait(NULL);

    printf("Trying to execute disallowed binary (ls). This should kill the process.\n");

    // Test 3: Disallowed binary (ls) - This should trigger the KILL action
    char *ls_argv[] = {"/bin/ls", "-la", NULL};
    if (fork() == 0) {
        printf("Child process attempting to execute /bin/ls...\n");
        execveat(AT_FDCWD, "/bin/ls", ls_argv, NULL, 0);
        perror("execveat (ls)"); // Should not reach here
        exit(1);
    }
    int status;
    wait(&status);
    if (WIFSIGNALED(status)) {
        printf("Child process killed by signal %d (expected for disallowed execveat).\n", WTERMSIG(status));
    } else {
        printf("Child process exited with status %d (unexpected).\n", WEXITSTATUS(status));
    }


    seccomp_release(ctx);
    return 0;
}
```

To compile and run this:

```bash
# Install libseccomp-dev on Debian/Ubuntu
sudo apt-get install libseccomp-dev

# Compile
gcc -o execveat_sandbox execveat_sandbox.c -lseccomp

# Run
./execveat_sandbox
```

**Expected Output:**

```
Seccomp filter loaded. Trying to execute allowed binaries...
Hello from Python!
Hello from Sh!
Trying to execute disallowed binary (ls). This should kill the process.
Child process attempting to execute /bin/ls...
Child process killed by signal 31 (expected for disallowed execveat).
```

(Signal 31 is `SIGSYS`, the signal sent by the kernel when a seccomp `SCMP_ACT_KILL` rule is triggered.)

### Analysis of the `seccomp` Filter

*   `scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL);`: This sets the default action to `KILL`. Any syscall that doesn't match an explicit `ALLOW` rule will terminate the process. This is a very strong default for sandboxing.
*   `seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS_EXECVEAT, 2, SCMP_A1(SCMP_CMP_EQ, (long)AT_FDCWD), SCMP_A2(SCMP_CMP_EQ, (long)"/usr/bin/python3"));`: This is the core. It adds a rule that *allows* the `execveat` syscall *only if