---
title: "Demystifying `ptrace`: Building a Custom Debugger for Linux Binaries"
date: 2026-05-24
category: "thought-leadership"
tags: []
excerpt: "As security professionals and system engineers, we often interact with debuggers like GDB. While incredibly powerful, their inner workings can seem li..."
---

# Demystifying `ptrace`: Building a Custom Debugger for Linux Binaries

As security professionals and system engineers, we often interact with debuggers like GDB. While incredibly powerful, their inner workings can seem like black magic. Understanding how a debugger attaches to a process, inspects its memory, and manipulates its execution flow is not just an academic exercise; it's fundamental to reverse engineering, exploit development, and even advanced system troubleshooting. At the heart of this magic on Linux lies the `ptrace` system call.

`ptrace` (process trace) is a powerful, yet often misunderstood, system call that allows one process (the "tracer") to observe and control the execution of another process (the "tracee"). It enables the tracer to examine and change the tracee's memory and registers, and to intercept system calls and signals. This is precisely what makes debuggers, system call tracers (like `strace`), and even some sandboxing mechanisms possible.

In this post, we'll peel back the layers of `ptrace` by building a rudimentary custom debugger. Our goal isn't to replicate GDB, but to illustrate the core `ptrace` operations needed to inspect a running process.

## The `ptrace` System Call: A Closer Look

The `ptrace` system call has a surprisingly simple signature:

```c
long ptrace(enum __ptrace_request request, pid_t pid, void *addr, void *data);
```

Let's break down the parameters:

*   `request`: This is the most crucial parameter, dictating the operation `ptrace` should perform. Examples include `PTRACE_ATTACH` (attach to a running process), `PTRACE_CONT` (continue execution), `PTRACE_PEEKTEXT`/`PTRACE_PEEKDATA` (read memory), `PTRACE_POKETEXT`/`PTRACE_POKEDATA` (write memory), and `PTRACE_GETREGS`/`PTRACE_SETREGS` (read/write CPU registers).
*   `pid`: The Process ID of the tracee.
*   `addr`: An address in the tracee's virtual memory space. Its meaning depends on the `request`.
*   `data`: Data to be written to or read from the tracee, or an argument for certain requests.

A common pattern when using `ptrace` is that the tracee will stop (e.g., due to a signal, a breakpoint, or being attached to) and the tracer will be notified. The tracer then performs its operations (reading memory, registers, etc.) and then resumes the tracee's execution.

## Our Target: A Simple C Program

To make our debugger tangible, let's create a simple target program that we'll attach to and inspect. Save this as `target.c`:

```c
#include <stdio.h>
#include <unistd.h> // For sleep()

int main() {
    int secret_value = 0xDEADBEEF; // A value we want to find
    char message[] = "Hello from target!";

    printf("Target process started. PID: %d\n", getpid());
    printf("Secret value address: %p\n", &secret_value);
    printf("Message address: %p\n", message);

    while (1) {
        printf("Running... secret_value = 0x%x\n", secret_value);
        sleep(2);
    }
    return 0;
}
```

Compile it: `gcc -g target.c -o target` (the `-g` is helpful for GDB, but not strictly necessary for `ptrace` memory reads).

Run it in a separate terminal: `./target`. Note down its PID.

## Building Our Debugger Skeleton

Now, let's build our debugger. We'll start with the basics: attaching to a process, waiting for it to stop, and then detaching. Save this as `my_debugger.c`:

```c
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h> // For struct user_regs_struct
#include <unistd.h>
#include <errno.h>
#include <string.h>

// Function to print an error and exit
void die(const char *msg) {
    perror(msg);
    exit(EXIT_FAILURE);
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <pid>\n", argv[0]);
        return EXIT_FAILURE;
    }

    pid_t pid = atoi(argv[1]);
    int status;

    printf("[DEBUGGER] Attaching to PID %d...\n", pid);

    // PTRACE_ATTACH: Attach to the process. This sends a SIGSTOP to the tracee.
    if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) == -1) {
        die("ptrace(PTRACE_ATTACH)");
    }

    // Wait for the tracee to stop (due to SIGSTOP from PTRACE_ATTACH)
    if (waitpid(pid, &status, 0) == -1) {
        die("waitpid");
    }

    if (WIFSTOPPED(status)) {
        printf("[DEBUGGER] Process %d stopped by signal %d.\n", pid, WSTOPSIG(status));
    } else {
        printf("[DEBUGGER] Process %d did not stop as expected. Status: %d\n", pid, status);
        // Detach if we didn't get the expected stop
        ptrace(PTRACE_DETACH, pid, NULL, NULL);
        return EXIT_FAILURE;
    }

    // --- Debugging operations will go here ---
    printf("[DEBUGGER] Performing inspection...\n");

    // Example: Read a 4-byte word from a specific address
    // For demonstration, let's assume we want to read the 'secret_value'
    // You'd get this address from /proc/<pid>/maps or by analyzing the binary.
    // For now, let's use the address printed by our target program.
    // Replace this with the actual address from your target's output!
    // E.g., if target prints "Secret value address: 0x7ffc12345678"
    // long addr_to_read = 0x7ffc12345678L;
    // For dynamic addresses, we'll need more advanced techniques.
    // For a simple demo, let's assume a known, fixed-ish relative offset or just use the printed address.
    // For this example, I'll use a placeholder. **YOU MUST REPLACE THIS WITH THE ACTUAL ADDRESS
    // PRINTED BY YOUR `target` PROGRAM FOR `secret_value`!**
    long addr_to_read = 0x7ffc12345678L; // Placeholder! Replace with actual address!

    errno = 0; // Clear errno before ptrace call to detect errors
    long data_read = ptrace(PTRACE_PEEKDATA, pid, (void*)addr_to_read, NULL);
    if (errno != 0) {
        die("ptrace(PTRACE_PEEKDATA)");
    }
    printf("[DEBUGGER] Data at 0x%lx: 0x%lx\n", addr_to_read, data_read);

    // Example: Reading CPU registers
    struct user_regs_struct regs;
    if (ptrace(PTRACE_GETREGS, pid, NULL, &regs) == -1) {
        die("ptrace(PTRACE_GETREGS)");
    }
    printf("[DEBUGGER] RIP: 0x%llx, RSP: 0x%llx\n", regs.rip, regs.rsp);


    // --- End of debugging operations ---

    printf("[DEBUGGER] Detaching from PID %d...\n", pid);
    // PTRACE_DETACH: Detach from the process. It will continue execution.
    if (ptrace(PTRACE_DETACH, pid, NULL, NULL) == -1) {
        die("ptrace(PTRACE_DETACH)");
    }

    printf("[DEBUGGER] Detached successfully.\n");

    return EXIT_SUCCESS;
}
```

Compile it: `gcc my_debugger.c -o my_debugger`

## Running Our Debugger

1.  Run the `target` program in one terminal: `./target`.
2.  Note the PID and the address of `secret_value` it prints. For example:
    ```
    Target process started. PID: 12345
    Secret value address: 0x7ffc12345678
    Message address: 0x7ffc12345670
    Running... secret_value = 0xdeadbeef
    ```
3.  **Crucially, edit `my_debugger.c` and replace `0x7ffc12345678L` with the actual address printed by your `target` program for `secret_value`.** Recompile `my_debugger.c`.
4.  Run `my_debugger` in another terminal, passing the PID: `./my_debugger 12345` (replace 12345 with your target's PID).

You should see output similar to this (addresses and PIDs will vary):

```
[DEBUGGER] Attaching to PID 12345...
[DEBUGGER] Process 12345 stopped by signal 19.
[DEBUGGER] Performing inspection...
[DEBUGGER] Data at 0x7ffc12345678: 0xdeadbeef
[DEBUGGER] RIP: 0x7f23abcd1234, RSP: 0x7f23abcd5678
[DEBUGGER] Detaching from PID 12345...
[DEBUGGER] Detached successfully.
```

In the `target` terminal, you'll notice it paused when the debugger attached and resumed when it detached.

## Understanding the Key Operations

*   **`PTRACE_ATTACH`**: This is how our debugger "hooks" into the running process. When successful, it sends a `SIGSTOP` to the tracee, pausing its execution.
*   **`waitpid`**: The debugger then calls `waitpid` to wait for the tracee to stop. `WIFSTOPPED(status)` confirms it stopped due to a signal, and `WSTOPSIG(status)` tells us which signal (`SIGSTOP` in this case).
*   **`PTRACE_PEEKDATA`**: This request allows us to read a word (typically `sizeof(long)`) from the tracee's memory at the specified address. We successfully read our `0xDEADBEEF`! Note that