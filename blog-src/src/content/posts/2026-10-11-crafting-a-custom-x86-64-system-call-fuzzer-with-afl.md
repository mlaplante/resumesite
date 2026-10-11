---
title: "Crafting a Custom x86-64 System Call Fuzzer with AFL++"
date: 2026-10-11
category: "thought-leadership"
tags: ["fuzzing", "system-calls", "security", "afl", "x86-64"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Fuzzing is an incredibly powerful technique for discovering vulnerabilities and uncovering unexpected behavior in software. While application-level..."
---

Fuzzing is an incredibly powerful technique for discovering vulnerabilities and uncovering unexpected behavior in software. While application-level fuzzing often grabs the headlines, targeting the kernel's system call interface with a custom fuzzer can yield particularly high-impact results. Kernels, after all, are the bedrock of our systems, and a flaw there can have catastrophic consequences.

In this post, we'll dive into how to build a custom x86-64 system call fuzzer using AFL++ (American Fuzzy Lop Plus Plus). We'll focus on the practical engineering steps, from understanding the syscall mechanism to crafting a harness and interpreting results.

## Why Fuzz System Calls?

System calls are the gateway between user-space applications and the kernel. They handle critical operations like file I/O, process management, memory allocation, and network communication. The sheer complexity and variety of arguments they accept make them fertile ground for bugs.

Consider these scenarios:
*   **Incorrect Argument Handling:** Passing an invalid pointer, an out-of-bounds size, or an unexpected flag combination to a syscall.
*   **Race Conditions:** Exploiting timing issues between multiple syscalls or concurrent operations.
*   **Resource Exhaustion:** Flooding the kernel with requests, leading to denial-of-service or unexpected state transitions.
*   **Undocumented Behavior:** Discovering edge cases that developers didn't anticipate.

A well-crafted syscall fuzzer can systematically explore this vast attack surface.

## Understanding x86-64 System Calls

Before we can fuzz, we need to understand how syscalls work on x86-64 Linux.
1.  **Syscall Number:** Each system call has a unique number. This number is loaded into the `rax` register.
2.  **Arguments:** Up to six arguments are passed in specific registers: `rdi`, `rsi`, `rdx`, `r10`, `r8`, and `r9`.
3.  **Instruction:** The `syscall` instruction is executed.
4.  **Return Value:** The kernel's return value is placed back into `rax`.

You can find the syscall numbers and their corresponding arguments in `/usr/include/asm/unistd_64.h` or by consulting the `man` pages (e.g., `man 2 open`).

## The Fuzzing Harness: Bridging User-Space and AFL++

Our core task is to create a "fuzzing harness" – a small program that AFL++ can instrument and execute repeatedly with mutated inputs. This harness will:
1.  Receive fuzzed data from AFL++.
2.  Parse this data into a sequence of system calls and their arguments.
3.  Execute these system calls.
4.  Report crashes or hangs back to AFL++.

Let's outline a simplified harness structure. We'll use a byte stream as input from AFL++, where each segment of bytes represents a syscall and its arguments.

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <errno.h>
#include <string.h>

// A simple structure to represent a syscall call
typedef struct {
    long syscall_num;
    long arg1, arg2, arg3, arg4, arg5, arg6;
    // Potentially add a flag for argument type (e.g., pointer, integer)
} syscall_info_t;

// A buffer for syscall arguments that might point to data
static char *data_buffer = NULL;
static size_t data_buffer_size = 4096; // Example size

// Helper to safely read N bytes from input buffer
// Returns pointer to data, or NULL if not enough bytes
static const unsigned char* consume_bytes(const unsigned char** buf, size_t* len, size_t num_bytes) {
    if (*len < num_bytes) {
        return NULL;
    }
    const unsigned char* current_pos = *buf;
    *buf += num_bytes;
    *len -= num_bytes;
    return current_pos;
}

int main(int argc, char **argv) {
    // Initialize data_buffer for pointer arguments
    data_buffer = mmap(NULL, data_buffer_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (data_buffer == MAP_FAILED) {
        perror("mmap data_buffer");
        return 1;
    }

#ifdef __AFL_HAVE_MANUAL_INIT
    __AFL_INIT();
#endif

    unsigned char *buf = NULL;
    size_t len = 0;

    // AFL++ typically reads from stdin, but for manual testing, we can simulate
    // In a real AFL++ run, __AFL_FUZZ_TESTCASE_LEN is defined and buf points to fuzzed data.
    // For simplicity, we'll assume a file input here for demonstration
    // In AFL++ context, this would be `read(__AFL_FUZZ_STDIN_FD, buf, len);`
    // or using `__AFL_FUZZ_TESTCASE_BUF` directly.
    if (read(STDIN_FILENO, &buf, &len) == -1) { // Placeholder for AFL++ input
        // In a real AFL++ setup, this part is handled by the AFL++ runtime.
        // For testing outside AFL++, you'd load a test case from a file.
        fprintf(stderr, "Error reading fuzzed input (or AFL++ not active).\n");
        // Example for manual test:
        // char test_data[] = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Syscall 1 (write)
        //                     0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // fd=1 (stdout)
        //                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ptr to data_buffer
        //                     0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // count=5
        //                     'H', 'e', 'l', 'l', 'o' // Data for write
        //                     };
        // buf = test_data;
        // len = sizeof(test_data);
        return 1;
    }

    const unsigned char* current_input_ptr = buf;
    size_t remaining_len = len;

    // Fill data_buffer with some fuzzed data for pointer arguments
    // A more sophisticated fuzzer might map specific parts of input to data_buffer
    if (remaining_len > 0 && remaining_len < data_buffer_size) {
        memcpy(data_buffer, current_input_ptr, remaining_len);
    } else if (remaining_len >= data_buffer_size) {
        memcpy(data_buffer, current_input_ptr, data_buffer_size);
    }

    // Reset input pointer for syscall parsing
    current_input_ptr = buf;
    remaining_len = len;

    // Loop to parse and execute syscalls from the fuzzed input
    while (remaining_len >= sizeof(syscall_info_t)) {
        const syscall_info_t* sci = (const syscall_info_t*)consume_bytes(&current_input_ptr, &remaining_len, sizeof(syscall_info_t));
        if (!sci) break; // Should not happen given the loop condition

        // Simple validation for syscall number (e.g., within a reasonable range)
        // A real fuzzer would have a more comprehensive whitelist/blacklist
        if (sci->syscall_num < 0 || sci->syscall_num > 500) {
            // Skip invalid syscall numbers
            continue;
        }

        // Example of handling pointer arguments:
        // For `write` (syscall 1), arg2 is `buf` (pointer to data)
        // We'll point it to our `data_buffer`
        long effective_arg2 = sci->arg2;
        if (sci->syscall_num == SYS_write || sci->syscall_num == SYS_read) {
            // For write/read, the second argument is a pointer.
            // We'll replace the fuzzed argument with a pointer into our controlled data_buffer.
            // A more advanced fuzzer might use the fuzzed arg2 as an offset into data_buffer.
            effective_arg2 = (long)data_buffer; 
        }

        // Execute the system call
        // Use `syscall` directly for flexibility
        long ret = syscall(sci->syscall_num, sci->arg1, effective_arg2, sci->arg3, sci->arg4, sci->arg5, sci->arg6);

        // Depending on the syscall, the return value might need specific handling.
        // For example, if a syscall returns a file descriptor, subsequent syscalls
        // might use it. For this basic fuzzer, we just log and continue.
        // fprintf(stderr, "Syscall %ld returned %ld (errno: %d)\n", sci->syscall_num, ret, errno);

        // A more advanced fuzzer would analyze the return value,
        // potentially store state (e.g., open FDs), and use them in subsequent syscalls.
        // It would also handle errors more gracefully or strategically.
    }

    munmap(data_buffer, data_buffer_size);
    // AFL++ will handle exit codes and crashes.
    return 0;
}
```

**Key Considerations for the Harness:**

*   **Input Parsing:** The example above uses a fixed `syscall_info_t` structure. A more robust fuzzer might use a variable-length format, perhaps with a "syscall type" byte followed by argument types and values. This allows for more diverse syscall sequences.
*   **Argument Types:** System call arguments aren't just raw `long` values. They can be pointers, file descriptors, flags, lengths, etc.
    *   **Pointers:** When a syscall expects a pointer, we must provide a valid, writeable memory region. Our `data_buffer` addresses this by providing a controlled memory area that fuzzed data can be copied into or pointed to.
    *   **File Descriptors:** Syscalls like `read`, `write`, `close` operate on file descriptors. The fuzzer needs to manage these: opening files, passing the returned FDs to subsequent calls, and closing them. This often requires maintaining a "state" or "context" for the fuzzer.
    *   **Flags/Enums:** These are often bitmasks or specific integer values. The fuzzer should prioritize known valid values but also inject invalid ones to test error handling.
*   **Error Handling:** While the harness itself shouldn't crash, it should log or ignore expected syscall errors (e.g., `EPERM`, `EINVAL`) unless they indicate a deeper issue. The goal is to find *unexpected* crashes or hangs.
*   **Resource Management:** Syscalls can open files, allocate memory, create processes. The fuzzer must ensure these resources are eventually cleaned up to avoid starving the system or causing false positives. This often means running the harness in a sandbox (e.g., `chroot`, `unshare`, or a VM) or carefully tracking resources.
*   **Stateful Fuzzing:** Many vulnerabilities arise from sequences of syscalls. A simple "stateless" fuzzer (like the one above) might miss these. A "stateful" fuzzer would track open file descriptors, allocated memory regions, process IDs, etc., and use these in subsequent fuzzed syscall arguments.

## Compiling and Fuzzing with AFL++

1.  **Install AFL++:** Follow the instructions on the AFL++ GitHub page.
2.  **Compile the harness:** Use the `afl-clang-fast` or `afl-gcc-fast` compiler wrappers provided by AFL++. These wrappers instrument your code for coverage tracking.

    ```bash
    afl-clang-fast -o syscall_fuzzer syscall_fuzzer.c
    ```

3.  **Prepare initial seeds:** AFL++ needs some starting inputs. For syscall fuzzing, these could be:
    *   Empty files.
    *   Files containing a few valid, basic syscall sequences (e.g., `open`, `write`, `close`).
    *   Files containing random bytes.

    Create a directory for seeds:
    ```bash
    mkdir in
    echo -n "" > in/empty.bin
    # Example: a minimal open/close sequence (needs more sophisticated encoding)
    # echo -ne "\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00..." > in/open_close.bin
    ```

4.  **Run AFL++:**

    ```bash
    afl-fuzz -i in -o out ./syscall_fuzzer
    ```

    AFL++ will start generating inputs, executing your harness, and monitoring for crashes or hangs.

## Interpreting Results

AFL++ will report crashes in the `out/crashes` directory and hangs in `out/hangs`.
*   **Crashes:** These are the gold standard. A crash indicates a kernel panic, an oops, or an unhandled exception triggered by your fuzzed syscall sequence. You'll get a unique test case that caused the crash.
*   **Hangs:** These indicate that your program (and potentially the kernel) became unresponsive. This can be a denial-of-service vector.

When a crash is found:
1.  **Reproduce:** Use `afl-replay` or simply run your fuzzer executable with the crashing input: `./syscall_fuzzer < out/crashes/<id>`.
2.  **Analyze:** Use `gdb` with kernel debugging symbols, `crash` utility, or `perf` to pinpoint the exact location and cause of the crash. This often involves looking at the stack trace and register values at the point of failure.
3.  **Kernel Logs:** Check `dmesg` for kernel messages, oops reports, or panics.

## Advanced Techniques

*   **Syscall Whitelisting/Blacklisting:** Focus on specific syscalls known to be complex or less tested.
*   **Argument Type Inference:** Develop a more intelligent input parser that understands argument types (e.g., `int`, `char*`, `struct`).
*   **State Management:** Track opened file descriptors, allocated memory, process IDs, etc., and feed these back into subsequent fuzzed syscall arguments. This is crucial for finding deeper, multi-syscall vulnerabilities.
*   **Environment Setup:** Use `unshare` to isolate the fuzzer from the host system, creating a fresh namespace for each execution. This helps avoid global state pollution and ensures consistent test environments.
*   **Kernel Modules:** Fuzzing custom kernel modules by calling their `ioctl` interfaces can be highly effective.
*   **Syzkaller:** For truly comprehensive kernel syscall fuzzing, consider tools like Google's Syzkaller. It's a much more sophisticated and mature solution that handles many of the complexities we've discussed. However, understanding how to build a custom fuzzer with AFL++ provides invaluable insight into the underlying mechanisms.

## Conclusion

Crafting a custom x86-64 system call fuzzer with AFL++ is a challenging but incredibly rewarding endeavor. It requires a deep understanding of the kernel's ABI, careful harness design, and systematic analysis of results. While this post provides a foundational example, the real power comes from iteratively refining your harness to model kernel state more accurately and explore the vast syscall input space. The insights gained from such an exercise are invaluable for any security engineer or systems programmer. Happy fuzzing!