---
title: "Demystifying io_uring: Building High-Performance, Secure Network Services in Rust"
date: 2026-08-14
category: "thought-leadership"
tags: ["io-uring", "rust", "networking", "performance", "systems-programming", "security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of high-performance computing, every microsecond counts. When building network services that need to handle millions of connections or..."
---

# Demystifying io_uring: Building High-Performance, Secure Network Services in Rust

In the world of high-performance computing, every microsecond counts. When building network services that need to handle millions of connections or process vast amounts of data with minimal latency, traditional I/O models often hit a wall. While epoll and kqueue have served us well, a newer, more potent challenger has emerged in the Linux kernel: `io_uring`.

`io_uring` is a asynchronous I/O interface that fundamentally changes how applications interact with the kernel for I/O operations. Unlike its predecessors, which often require multiple system calls per operation (e.g., `read()` then `sendmsg()`), `io_uring` allows applications to batch multiple I/O requests and responses into shared queues, drastically reducing system call overhead and context switches. This can lead to significant performance improvements, especially under heavy load.

For those of us building systems in Rust, `io_uring` offers an exciting pathway to truly unlock the full potential of our hardware, all while leveraging Rust's unparalleled memory safety and concurrency features. But `io_uring` itself can seem daunting. It's a low-level API, exposed via raw system calls, and its asynchronous nature requires careful state management.

Let's demystify `io_uring` by exploring how we might use it in Rust to build a simple, high-performance network echo server. We'll focus on the core concepts and how Rust's type system can help us manage the complexity.

## The Core Concept: Submission and Completion Queues

At its heart, `io_uring` operates with two ring buffers shared between user space and the kernel:

1.  **Submission Queue (SQ):** User space writes `Submission Queue Entries (SQEs)` into this ring. Each SQE describes an I/O operation (e.g., read, write, accept).
2.  **Completion Queue (CQ):** The kernel writes `Completion Queue Entries (CQEs)` into this ring when an operation finishes. Each CQE contains the result of an operation.

The user application fills SQEs, tells the kernel there are new entries, and then polls the CQ for completed operations. This single-producer/single-consumer model, with the kernel as the consumer for the SQ and producer for the CQ, is incredibly efficient.

## Setting Up `io_uring` in Rust

While you could interact with `io_uring` via raw `syscall` calls, the `io_uring` crate for Rust provides a safe and idiomatic wrapper around the kernel interface.

First, add it to your `Cargo.toml`:

```toml
[dependencies]
io-uring = "0.6" # Use the latest version
libc = "0.2"
```

Now, let's initialize an `io_uring` instance:

```rust
use io_uring::{IoUring, opcode, squeue, cqueue};
use libc::{sockaddr_in, AF_INET, SOCK_STREAM, IPPROTO_TCP};
use std::
    {
        io::{self, IoSlice, IoSliceMut},
        net::{TcpListener, TcpStream, SocketAddr, Ipv4Addr},
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        ptr,
        mem::MaybeUninit,
    };

const QUEUE_DEPTH: u32 = 256; // How many operations can be outstanding
const BUF_SIZE: usize = 4096; // Size of our receive buffer

// Represents a state for an active connection or an operation
enum OpState {
    Accept(OwnedFd), // We're waiting for an accept on this listener
    Read(OwnedFd, Vec<u8>), // Reading into this buffer on this socket
    Write(OwnedFd, Vec<u8>, usize), // Writing this buffer on this socket, 'usize' is bytes written
    // ... potentially other states like Close, etc.
}

fn main() -> io::Result<()> {
    // 1. Initialize io_uring
    let ring = IoUring::builder().build(QUEUE_DEPTH)?;

    // 2. Set up a TCP listener
    let listener = TcpListener::bind("127.0.0.1:8080")?;
    listener.set_nonblocking(true)?; // Important for io_uring

    println!("Listening on {}", listener.local_addr()?);

    // 3. Register a fixed buffer for reads (optional but highly performant)
    //    io_uring allows registering buffers to avoid copying data between kernel and user space.
    //    For simplicity, we'll use dynamic buffers for now, but fixed buffers are a key optimization.

    // 4. Submit an initial 'accept' operation
    submit_accept(&ring, listener.as_raw_fd())?;

    // 5. Main event loop
    let mut op_states: Vec<Option<OpState>> = vec![None; QUEUE_DEPTH as usize];
    let mut next_user_data: u64 = 0;

    loop {
        // Wait for completions. Timeout can be 0 for non-blocking poll.
        ring.submit_and_wait(1)?;

        // Process completed operations
        let mut cq = ring.completion();
        for cqe in cq {
            let user_data = cqe.user_data();
            let res = cqe.result();

            // Retrieve the original operation state using user_data
            let state_idx = (user_data % QUEUE_DEPTH as u64) as usize;
            let current_state = op_states[state_idx].take()
                .expect("BUG: Completion for non-existent operation state");

            match current_state {
                OpState::Accept(listener_fd) => {
                    if res < 0 {
                        eprintln!("Accept failed: {}", io::Error::from_raw_os_error(-res));
                        // Re-submit accept, or handle error
                        submit_accept(&ring, listener_fd.as_raw_fd())?;
                    } else {
                        let client_fd = unsafe { OwnedFd::from_raw_fd(res) };
                        println!("Accepted new connection: {:?}", client_fd);

                        // Submit a read for the new client
                        submit_read(&ring, client_fd, state_idx as u64)?;
                        op_states[state_idx] = Some(OpState::Read(client_fd, vec![0; BUF_SIZE]));

                        // Re-submit accept to handle the next incoming connection
                        submit_accept(&ring, listener_fd.as_raw_fd())?;
                    }
                },
                OpState::Read(client_fd, mut buffer) => {
                    if res <= 0 { // Client disconnected or error
                        println!("Client {:?} disconnected or read error: {}", client_fd, io::Error::from_raw_os_error(-res));
                        // Clean up client_fd (it will be dropped when OpState is dropped)
                    } else {
                        let bytes_read = res as usize;
                        println!("Read {} bytes from {:?}", bytes_read, client_fd);

                        // Submit a write back to the client (echo)
                        submit_write(&ring, client_fd.try_clone()?, buffer, bytes_read, state_idx as u64)?;
                        op_states[state_idx] = Some(OpState::Write(client_fd, buffer, 0));
                    }
                },
                OpState::Write(client_fd, buffer, mut bytes_written_so_far) => {
                    if res < 0 {
                        eprintln!("Write failed for {:?}: {}", client_fd, io::Error::from_raw_os_error(-res));
                        // Clean up client_fd
                    } else {
                        bytes_written_so_far += res as usize;
                        // For simplicity, we assume one write completes the echo.
                        // In a real scenario, you'd check if all bytes were written
                        // and re-submit if not.
                        println!("Wrote {} bytes to {:?}", bytes_written_so_far, client_fd);

                        // Re-submit a read for the same client
                        submit_read(&ring, client_fd, state_idx as u64)?;
                        op_states[state_idx] = Some(OpState::Read(client_fd, buffer));
                    }
                },
            }
        }
    }
}

// Helper to submit an accept operation
fn submit_accept(ring: &IoUring, listener_fd: i32) -> io::Result<()> {
    let mut sq = ring.submission();
    let accept_sqe = opcode::Accept::new(
        io_uring::types::Fd(listener_fd),
        ptr::null_mut(),
        ptr::null_mut(),
        0 // flags
    )
    .build()
    .user_data(get_next_user_data()); // Unique ID for this operation

    unsafe {
        sq.push(&accept_sqe)
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "SQ is full"))?;
    }
    Ok(())
}

// Helper to submit a read operation
fn submit_read(ring: &IoUring, client_fd: OwnedFd, user_data: u64) -> io::Result<()> {
    let mut sq = ring.submission();
    let mut buffer = vec![0; BUF_SIZE]; // Each read needs its own buffer in this model
    let read_sqe = opcode::Read::new(
        io_uring::types::Fd(client_fd.as_raw_fd()),
        buffer.as_mut_ptr() as *mut _,
        buffer.len() as u32
    )
    .build()
    .user_data(user_data);

    unsafe {
        sq.push(&read_sqe)
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "SQ is full"))?;
    }
    Ok(())
}

// Helper to submit a write operation
fn submit_write(ring: &IoUring, client_fd: OwnedFd, buffer: Vec<u8>, len: usize, user_data: u64) -> io::Result<()> {
    let mut sq = ring.submission();
    let write_sqe = opcode::Write::new(
        io_uring::types::Fd(client_fd.as_raw_fd()),
        buffer.as_ptr() as *const _,
        len as u32
    )
    .build()
    .user_data(user_data);

    unsafe {
        sq.push(&write_sqe)
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "SQ is full"))?;
    }
    Ok(())
}

static mut NEXT_