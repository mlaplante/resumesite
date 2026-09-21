---
title: "Unlocking Peak Performance With Rust and io_uring"
date: 2026-06-09
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Unlocking Peak Performance With Rust and io_uring
 
 For those of us in the trenches of information security and operations, squeezing every last drop..."
---

 For those of us in the trenches of information security and operations, squeezing every last drop of performance out of our systems isn't just a nice-to-have, it's a fundamental requirement. Whether we're building high-throughput network services, optimizing data processing pipelines, or ensuring our storage solutions are lightning-fast, efficient I/O is king.
 
 For years, asynchronous I/O in Linux has largely been the domain of `epoll`, a powerful but sometimes complex beast. However, a newer, more capable player has emerged: `io_uring`. Designed from the ground up to be a truly asynchronous, zero-copy I/O interface, `io_uring` promises to revolutionize how we handle I/O operations on Linux. And when you combine its power with the safety and expressiveness of Rust, you get a formidable combination for building high-performance applications.
 
 ## What is `io_uring`?
 
 At its core, `io_uring` is an asynchronous I/O interface for Linux that aims to simplify and accelerate I/O operations. Unlike traditional models where the kernel might block or require multiple system calls for a single I/O operation, `io_uring` uses a ring buffer mechanism to communicate between userspace and the kernel.
 
 This mechanism involves two main rings:
 
 *   **Submission Queue (SQ):** Userspace writes I/O requests (like `read`, `write`, `stat`) into this ring.
 *   **Completion Queue (CQ):** The kernel writes the results of these I/O operations into this ring.
 
 This design allows for:
 
 *   **Reduced System Call Overhead:** Instead of a system call per I/O operation, you submit multiple operations to the kernel in a single go and poll for completions.
 *   **Zero-Copy:** `io_uring` can often avoid copying data between kernel and userspace buffers, especially for operations like `splice`.
 *   **Batching:** Submit multiple requests at once and receive multiple completions, improving efficiency.
 *   **Flexibility:** Supports a wide range of I/O operations, from basic file and network I/O to more advanced features like I/O event notification.
 
 ## Why Rust for `io_uring`?
 
 Rust's strengths align perfectly with the goals of high-performance I/O:
 
 *   **Memory Safety:** Eliminates entire classes of bugs like null pointer dereferences and data races without a garbage collector. This is crucial for stability in long-running, performance-sensitive services.
 *   **Fearless Concurrency:** Rust's ownership and borrowing system makes it much easier to write concurrent code safely, which is essential when dealing with asynchronous operations.
 *   **Performance:** Rust compiles to efficient native code, offering performance comparable to C/C++ without sacrificing safety.
 *   **Rich Ecosystem:** A growing number of crates provide bindings to low-level system interfaces, making it easier to leverage powerful kernel features like `io_uring`.
 
 ## Getting Started with `io_uring` in Rust
 
 The `io-uring` crate provides excellent Rust bindings for the `io_uring` interface. Let's dive into a simple example: performing an asynchronous read from a file.
 
 First, ensure you have the `io-uring` crate added to your `Cargo.toml`:
 
 ```toml
 [dependencies]
 io-uring = "0.7"
 tokio = { version = "1", features = ["rt-multi-thread", "time"] } # For a runtime and timer
 ```
 
 Now, let's write some Rust code. We'll use `tokio` for its runtime and timer capabilities, though `io_uring` itself doesn't strictly require a specific async runtime.
 
 ```rust
 use io_uring::{opcode, squeue, types, IoUring};
 use std::fs::File;
 use std::io::{self, Write};
 use std::os::fd::{AsRawFd, FromRawFd};
 use tokio::task;
 use tokio::time::{timeout, Duration};
 
 #[tokio::main]
 async fn main() -> io::Result<()> {
     // Create a temporary file for demonstration
     let mut file = File::create("temp_test_file.txt")?;
     file.write_all(b"Hello, io_uring!")?;
     file.sync_all()?; // Ensure data is written
     drop(file); // Close the file handle in this scope
 
     // Initialize io_uring with a ring size of 32
     // `with_entries` specifies the maximum number of entries in the submission and completion queues.
     let mut ring = IoUring::new(32)?;
 
     // Open the file again for reading
     let file_fd = std::fs::OpenOptions::new()
         .read(true)
         .open("temp_test_file.txt")?
         .as_raw_fd();
 
     let mut buffer = vec![0u8; 1024];
 
     // Build the read operation, then finalize it into a submission queue entry
     // with `.build()`. `.user_data()` tags the entry so we can match it back up
     // with the right completion later (useful once more than one op is in flight).
     let read_e = opcode::Read::new(
         types::Fd(file_fd),
         buffer.as_mut_ptr(),
         buffer.len() as u32,
     )
     .build()
     .user_data(0x42);
 
     // Push the built entry onto the submission queue. This is unsafe because the
     // kernel will read from `buffer` after this call returns, so the buffer must
     // stay alive and untouched until the matching completion arrives.
     unsafe {
         ring.submission()
             .push(&read_e)
             .expect("submission queue is full");
     }
 
     println!("Submitted read operation. Waiting for completion...");
 
     // Submit the pending entry and block until at least one completion is ready.
     ring.submit_and_wait(1)?;
 
     // Retrieve the completion event from the kernel.
     let cqe = ring.completion().next().expect("Failed to get completion event");
 
     // Check for errors. `cqe.result()` returns the number of bytes read or an error.
     if cqe.result() < 0 {
         eprintln!("Read error: {}", io::Error::from_raw_os_error(-cqe.result()));
     } else {
         let bytes_read = cqe.result() as usize;
         println!("Successfully read {} bytes.", bytes_read);
         // Safely slice the buffer to the number of bytes read.
         let data = &buffer[..bytes_read];
         println!("Data: {:?}", String::from_utf8_lossy(data));
     }
 
     // Clean up the temporary file
     std::fs::remove_file("temp_test_file.txt")?;
 
     Ok(())
 }
 ```
 
 ### Explanation of the Code:
 
 1.  **Initialization:** We create an `IoUring` instance with a specified number of entries (32 in this case). This determines the maximum number of operations that can be pending.
 2.  **File Handling:** We open a file for reading. `io_uring` operates on file descriptors (`fd`), so we get the raw file descriptor using `as_raw_fd()`.
 3.  **Buffer Setup:** A byte buffer is prepared. In `io_uring`, you directly provide pointers to your userspace buffers.
 4.  **Operation Construction:** `opcode::Read::new()` constructs the read operation, taking the file descriptor, a pointer to the buffer, and the buffer's length. Calling `.build()` turns that into a submission queue entry, and `.user_data()` tags it with an identifier so you can match this entry to its eventual completion — essential once more than one operation is in flight at a time.
 5.  **Submission Queue Entry (SQE):** `ring.submission().push(&read_e)` places the built entry onto the submission queue. This is `unsafe` because the kernel reads directly from `buffer` once the operation is submitted, so the buffer must stay valid and untouched until the matching completion event arrives — there's no copy in either direction.
 6.  **Submission:** `ring.submit_and_wait(1)` sends the pending entries in the submission queue to the kernel in a single syscall and blocks until at least one completion is ready.
 7.  **Completion Queue (CQE):** `ring.completion().next()` retrieves a completion event from the kernel. In a real async application, you would integrate this with your event loop rather than blocking, driving the ring from a reactor task instead of calling `submit_and_wait` directly.
 8.  **Result Handling:** `cqe.result()` contains the result of the operation: either the number of bytes read or a negative error code. We then process the buffer accordingly.
 
 ## Beyond Basic Reads: A Glimpse into Possibilities
 
 This is a very basic example. `io_uring` can do much more:
 
 *   **Asynchronous Writes:** Similar to reads, but writing data from a buffer.
 *   **Network I/O:** `recv`, `send`, `accept`, `connect` operations can all be performed asynchronously. This is where `io_uring` truly shines for network services.
 *   **File System Operations:** `stat`, `fsync`, `unlink`, and even `splice` (for zero-copy data transfer between file descriptors).
 *   **I/O Event Notification:** `io_uring` can also be used to receive notifications for events like socket readiness, without performing an actual I/O operation.
 *   **`IORING_FEAT_FAST_POLL`:** For highly tuned applications, this feature allows for extremely fast polling of completions when many operations are expected to complete quickly.
 
 ## Practical Considerations and Best Practices
 
 *   **Buffer Management:** Careful management of buffers is key. Ensure your buffers remain valid for the entire duration of the I/O operation. The `io-uring` crate helps with this by providing mechanisms to register buffers.
 *   **Error Handling:** Always check `cqe.result()` for negative values indicating errors.
 *   **Polling vs. Waiting:** For high-throughput services, continuously polling `ring.completion()` or using `ring.submit_and_wait(N)` with a small `N` can be more performant than blocking indefinitely. However, this can lead to busy-waiting if completions are infrequent. A balanced approach, often managed by an async runtime, is usually best.
 *   **Ring Size:** Choose a ring size that balances memory usage with the number of in-flight operations your workload actually needs. Undersizing the ring forces `submit()` to block until the kernel drains existing entries, which defeats the point of batching; oversizing it just pins memory you'll never use. Start conservative — 32 to 256 entries is a reasonable range for most services — and tune based on observed queue depth under load.
 *   **`io_uring_enter` Flags:** Beyond basic submission, flags such as `IORING_ENTER_GETEVENTS` let you submit new work and wait for completions in a single system call, which is usually what you want inside a tight event loop rather than issuing separate submit and wait steps.
 
 ## Conclusion
 
 `io_uring` doesn't just make async I/O on Linux faster — it changes the shape of the problem, replacing a system call per operation with a shared-memory ring that batches submission and completion together. Paired with Rust's ownership model, which forces you to reason explicitly about buffer lifetimes exactly where `io_uring` needs that discipline most, the combination is a strong foundation for I/O-bound services that can't afford the overhead of the traditional syscall-per-operation model. Start with the basics shown here, lean on higher-level abstractions in the `io-uring` crate's ecosystem once you're comfortable with the raw ring semantics, and always benchmark against your actual workload before committing to a given ring size or polling strategy.