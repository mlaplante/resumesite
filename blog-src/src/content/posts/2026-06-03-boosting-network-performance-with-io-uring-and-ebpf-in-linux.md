---
title: "Boosting Network Performance with `io_uring` and eBPF in Linux"
date: 2026-06-03
category: "thought-leadership"
tags: []
excerpt: "As an SVP of Information Security and Operations, I've seen firsthand how critical network performance is to the success of modern applications. Wheth..."
---

# Boosting Network Performance with `io_uring` and eBPF in Linux

As an SVP of Information Security and Operations, I've seen firsthand how critical network performance is to the success of modern applications. Whether it's a high-frequency trading platform, a massively scalable content delivery network, or a distributed database, the ability to move data efficiently across the network often dictates the overall system throughput and latency. For years, the Linux kernel has offered various mechanisms for network I/O, but recent advancements with `io_uring` and eBPF have truly revolutionized how we can achieve extreme performance.

This post will dive into how these two powerful technologies can be leveraged together to optimize high-throughput network I/O, providing concrete examples and actionable takeaways for engineers looking to push the boundaries of their systems.

## The Bottleneck: Traditional Network I/O

Before we jump into the solutions, let's quickly recap why traditional network I/O can be a bottleneck. Most applications use the standard Berkeley sockets API, which relies on system calls like `read()`, `write()`, `sendmsg()`, and `recvmsg()`. Each of these system calls involves a context switch from user space to kernel space and back. For high-rate I/O, these context switches, along with data copying between user and kernel buffers, can introduce significant overhead.

Furthermore, traditional asynchronous I/O (like `epoll`) still requires separate system calls for initiating operations and checking their completion, leading to a "split-phase" approach that can add latency.

## Enter `io_uring`: Asynchronous I/O Reimagined

`io_uring` is a modern asynchronous I/O interface introduced in Linux 5.1 that aims to address the shortcomings of older AIO mechanisms. Its core innovation lies in its ring buffer design, which allows for batched submission and completion of I/O operations with minimal system calls.

Here's how it fundamentally changes the game:

1.  **Single System Call for Setup:** An application sets up two shared ring buffers: a Submission Queue (SQ) and a Completion Queue (CQ).
2.  **Batching Submissions:** The application can enqueue multiple I/O requests (e.g., `read`, `write`, `sendmsg`, `recvmsg`, even networking operations) into the SQ without any system calls.
3.  **Single System Call for Submission:** A single `io_uring_enter()` system call submits all pending requests in the SQ to the kernel.
4.  **Asynchronous Completion:** The kernel processes these requests and places their completion results into the CQ.
5.  **Batching Completions:** The application can poll the CQ for completed operations, potentially processing many results with minimal overhead.

This "submit-once, complete-many" model drastically reduces context switches and improves CPU efficiency.

### Practical `io_uring` for Network I/O

Let's look at a simplified example of using `io_uring` for receiving data on a network socket. Imagine a high-performance proxy or message broker.

```c
#include <liburing.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define QD_DEPTH 256
#define BUF_SIZE 2048
#define PORT 8080

struct io_data {
    int client_fd;
    char buffer[BUF_SIZE];
};

int main() {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    struct io_data *data;
    int server_fd, client_fd, ret;
    struct sockaddr_in server_addr, client_addr;
    socklen_t client_len = sizeof(client_addr);

    // Initialize io_uring
    ret = io_uring_queue_init(QD_DEPTH, &ring, 0);
    if (ret < 0) {
        perror("io_uring_queue_init");
        return 1;
    }

    // Setup server socket
    server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return 1;
    }
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(PORT);

    if (bind(server_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        perror("bind");
        return 1;
    }
    if (listen(server_fd, 5) < 0) {
        perror("listen");
        return 1;
    }
    printf("Listening on port %d\n", PORT);

    // Initial accept request (can also be io_uring_prep_accept)
    client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
    if (client_fd < 0) {
        perror("accept");
        return 1;
    }
    printf("Client connected: %s:%d\n", inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));

    // Prepare initial recv request
    data = (struct io_data *)malloc(sizeof(*data));
    data->client_fd = client_fd;
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_recv(sqe, client_fd, data->buffer, BUF_SIZE, 0);
    io_uring_sqe_set_data(sqe, data); // Attach our custom data

    io_uring_submit(&ring);

    while (1) {
        ret = io_uring_wait_cqe(&ring, &cqe);
        if (ret < 0) {
            perror("io_uring_wait_cqe");
            break;
        }

        data = (struct io_data *)io_uring_cqe_get_data(cqe);
        int bytes_received = cqe->res;

        if (bytes_received <= 0) {
            // Client disconnected or error
            printf("Client disconnected or error on fd %d, result: %d\n", data->client_fd, bytes_received);
            close(data->client_fd);
            free(data);
            io_uring_cqe_seen(&ring, cqe);
            // In a real app, you'd accept new connections here
            break; // For simplicity, exit
        }

        data->buffer[bytes_received] = '\0'; // Null-terminate
        printf("Received %d bytes from fd %d: %s\n", bytes_received, data->client_fd, data->buffer);

        // Re-submit another recv for the same client
        sqe = io_uring_get_sqe(&ring);
        io_uring_prep_recv(sqe, data->client_fd, data->buffer, BUF_SIZE, 0);
        io_uring_sqe_set_data(sqe, data);
        io_uring_submit(&ring);

        io_uring_cqe_seen(&ring, cqe);
    }

    io_uring_queue_exit(&ring);
    close(server_fd);
    return 0;
}
```
This simplified example demonstrates how to initiate a `recv` operation using `io_uring`. In a real-world scenario, you'd manage multiple client connections, potentially using `io_uring_prep_accept` to handle new connections asynchronously as well, and use `IORING_FEAT_FAST_POLL` for even lower latency. The key takeaway is the ability to submit and complete operations without constant context switching.

## Augmenting with eBPF: Programmable Kernel Logic

While `io_uring` optimizes the *path* of I/O operations, eBPF (extended Berkeley Packet Filter) allows us to inject custom, programmable logic *into* the kernel itself, at various hook points. For network I/O, this means we can perform tasks like:

*   **Custom Packet Filtering and Redirection:** More advanced than `iptables`, eBPF programs can filter packets at line rate, even redirecting them to specific sockets or processes based on complex logic.
*   **Load Balancing:** Distribute incoming connections or packets across multiple backend services or CPU cores.
*   **Telemetry and Monitoring:** Collect highly granular network statistics without impacting performance.
*   **Security Policies:** Implement custom access controls or intrusion detection at the network layer.

The beauty of eBPF is that these programs run in a sandboxed, verified environment within the kernel, offering safety and stability while delivering near-native performance.

### eBPF and `io_uring` Synergy: A Use Case

Consider a scenario where you have a high-throughput proxy application using `io_uring` to handle millions of concurrent connections. You want to implement a custom load-balancing strategy based on application-layer data (e.g., HTTP headers) or even client geographical location, *before* the data even reaches user space.

Traditionally, this would require the kernel to pass the packet to user space, the application to parse it, make a decision, and then potentially forward it. This adds latency.

With eBPF, you could attach a program to the `XDP` (eXpress Data Path) hook or `tc` (traffic control) ingress. This eBPF program could:

1.  **Parse Packet Headers:** Analyze TCP/IP headers, and even application-layer headers if necessary, directly in the kernel.
2.  **Make Routing Decisions:** Based on the parsed data (e.g., a specific URL path, source IP range), determine which `io_uring`-enabled worker process or even which specific CPU core should handle this connection.
3.  **Redirect Traffic:** Using eBPF maps and helpers, the program could redirect the packet to a specific socket or even another network interface, bypassing much of the traditional kernel network stack for that particular traffic flow.

This allows for intelligent, high-performance routing *before* the data even enters the application's `io_uring` receive queue, greatly reducing load on the application and minimizing latency.

```c
// Simplified eBPF XDP program (pseudo-code) for illustrative purposes
// This would be compiled with clang/llvm and loaded via libbpf
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <bpf/bpf