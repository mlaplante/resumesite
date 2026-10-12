---
title: "Demystifying epoll: Building High-Performance, Secure Network Proxies in C"
date: 2026-10-12
category: "thought-leadership"
tags: ["networking", "epoll", "proxy", "security", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As an SVP of Information Security and Operations, I've seen countless network architectures, and one constant remains: the need for efficient, secure..."
---

As an SVP of Information Security and Operations, I've seen countless network architectures, and one constant remains: the need for efficient, secure data movement. While modern languages offer high-level abstractions, understanding the underlying mechanisms is crucial for debugging, optimizing, and securing critical infrastructure. Today, we're diving deep into `epoll`, the Linux kernel's high-performance I/O event notification facility, and how we can leverage it to build a robust, secure network proxy in C.

Why `epoll`? For high-concurrency network applications like proxies, traditional blocking I/O or even `select`/`poll` can become performance bottlenecks. `epoll` offers a scalable, efficient way to monitor multiple file descriptors for I/O readiness without iterating over large sets of descriptors repeatedly. This is particularly vital when handling thousands of concurrent connections, a common scenario for a busy proxy.

## The Core Concept: Event-Driven Architecture

At its heart, `epoll` enables an event-driven architecture. Instead of continuously asking "is there data?" for each socket, we tell the kernel "notify me when there's data (or space to write) on these sockets." The kernel then efficiently maintains a list of interested sockets and only wakes up our application when an event occurs.

Let's break down the key `epoll` system calls:

1.  **`epoll_create1(int flags)`**: Creates an `epoll` instance and returns a file descriptor referring to it. `EPOLL_CLOEXEC` is a good flag to use for security, ensuring the descriptor is closed on `exec`.
2.  **`epoll_ctl(int epfd, int op, int fd, struct epoll_event *event)`**: Used to add, modify, or delete file descriptors (like sockets) from the `epoll` instance.
    *   `epfd`: The `epoll` instance file descriptor.
    *   `op`: `EPOLL_CTL_ADD`, `EPOLL_CTL_MOD`, or `EPOLL_CTL_DEL`.
    *   `fd`: The file descriptor to operate on.
    *   `event`: A pointer to an `epoll_event` structure, defining the events to monitor (e.g., `EPOLLIN` for read readiness, `EPOLLOUT` for write readiness).
3.  **`epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout)`**: Waits for I/O events on the registered file descriptors.
    *   `epfd`: The `epoll` instance file descriptor.
    *   `events`: An array where `epoll_wait` stores the detected events.
    *   `maxevents`: The maximum number of events to return.
    *   `timeout`: How long to wait for events in milliseconds. `-1` waits indefinitely.

## Building a Basic `epoll` Echo Proxy

Let's start with a simplified echo proxy to illustrate the `epoll` mechanics. Our proxy will listen on a port, accept client connections, and then forward any data received from the client back to the client. This forms the foundation upon which we can build more complex forwarding logic.

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <errno.h>

#define MAX_EVENTS 10
#define BUFFER_SIZE 4096

// Error handling macro
#define ERR_EXIT(msg) \
    do { perror(msg); exit(EXIT_FAILURE); } while(0)

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <port>\n", argv[0]);
        exit(EXIT_FAILURE);
    }

    int listen_sock, client_sock;
    struct sockaddr_in server_addr, client_addr;
    socklen_t client_addr_len;
    char buffer[BUFFER_SIZE];
    int epoll_fd;
    struct epoll_event event, events[MAX_EVENTS];

    // 1. Create listening socket
    listen_sock = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (listen_sock == -1) ERR_EXIT("socket");

    int opt = 1;
    if (setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) == -1) ERR_EXIT("setsockopt");

    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    server_addr.sin_port = htons(atoi(argv[1]));

    if (bind(listen_sock, (struct sockaddr *)&server_addr, sizeof(server_addr)) == -1) ERR_EXIT("bind");
    if (listen(listen_sock, SOMAXCONN) == -1) ERR_EXIT("listen");

    printf("Listening on port %s...\n", argv[1]);

    // 2. Create epoll instance
    epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd == -1) ERR_EXIT("epoll_create1");

    // 3. Add listening socket to epoll for read events (new connections)
    event.events = EPOLLIN | EPOLLET; // Edge-triggered
    event.data.fd = listen_sock;
    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, listen_sock, &event) == -1) ERR_EXIT("epoll_ctl: listen_sock");

    // 4. Event loop
    while (1) {
        int num_events = epoll_wait(epoll_fd, events, MAX_EVENTS, -1);
        if (num_events == -1) {
            if (errno == EINTR) continue; // Interrupted by signal, retry
            ERR_EXIT("epoll_wait");
        }

        for (int i = 0; i < num_events; i++) {
            if (events[i].data.fd == listen_sock) {
                // New incoming connection
                while (1) { // Accept all pending connections (ET needs this)
                    client_addr_len = sizeof(client_addr);
                    client_sock = accept(listen_sock, (struct sockaddr *)&client_addr, &client_addr_len);
                    if (client_sock == -1) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) {
                            // No more incoming connections
                            break;
                        } else {
                            perror("accept");
                            break;
                        }
                    }

                    printf("Accepted connection from %s:%d\n",
                           inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));

                    // Make client socket non-blocking
                    if (fcntl(client_sock, F_SETFL, fcntl(client_sock, F_GETFL, 0) | O_NONBLOCK) == -1) {
                        perror("fcntl: client_sock non-blocking");
                        close(client_sock);
                        continue;
                    }

                    // Add client socket to epoll for read events
                    event.events = EPOLLIN | EPOLLET; // Edge-triggered
                    event.data.fd = client_sock;
                    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, client_sock, &event) == -1) {
                        perror("epoll_ctl: client_sock");
                        close(client_sock);
                    }
                }
            } else {
                // Data from an existing client connection
                int current_sock = events[i].data.fd;
                if (events[i].events & EPOLLIN) {
                    // Data available to read
                    ssize_t bytes_read;
                    while ((bytes_read = read(current_sock, buffer, BUFFER_SIZE)) > 0) {
                        // Echo data back to the client
                        ssize_t bytes_written = 0;
                        while (bytes_written < bytes_read) {
                            ssize_t res = write(current_sock, buffer + bytes_written, bytes_read - bytes_written);
                            if (res == -1) {
                                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                                    // Client write buffer full, re-add for EPOLLOUT
                                    event.events = EPOLLIN | EPOLLOUT | EPOLLET;
                                    event.data.fd = current_sock;
                                    epoll_ctl(epoll_fd, EPOLL_CTL_MOD, current_sock, &event);
                                    goto next_event_loop_iter; // Re-evaluate this socket later
                                } else {
                                    perror("write");
                                    goto close_client_socket;
                                }
                            }
                            bytes_written += res;
                        }
                    }
                    if (bytes_read == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                        // No more data to read for now
                    } else if (bytes_read == 0) {
                        // Client disconnected
                        printf("Client disconnected from fd %d\n", current_sock);
                        goto close_client_socket;
                    } else {
                        perror("read");
                        goto close_client_socket;
                    }
                }
                if (events[i].events & EPOLLOUT) {
                    // This branch would handle pending writes if we temporarily couldn't write all data
                    // For a simple echo, we assume we write immediately.
                    // In a real proxy, you'd have a send buffer per connection and try to flush it here.
                    // For now, we just remove EPOLLOUT if it was set temporarily.
                    event.events = EPOLLIN | EPOLLET; // Revert to just EPOLLIN
                    event.data.fd = current_sock;
                    epoll_ctl(epoll_fd, EPOLL_CTL_MOD, current_sock, &event);
                }
                if (events[i].events & (EPOLLHUP | EPOLLERR)) {
                    // Client hang up or error
                    printf("Client hangup/error on fd %d\n", current_sock);
                    goto close_client_socket;
                }
            }
            next_event_loop_iter:; // Label for goto
            continue;

            close_client_socket:
                epoll_ctl(epoll_fd, EPOLL_CTL_DEL, current_sock, NULL); // Remove from epoll
                close(current_sock); // Close the socket
        }
    }

    // Clean up (unreachable in this infinite loop, but good practice)
    close(listen_sock);
    close(epoll_fd);

    return 0;
}
```

### Key Takeaways from the Echo Proxy:

*   **`SOCK_NONBLOCK`**: Crucial for all sockets managed by `epoll`. This ensures `accept`, `read`, and `write` operations don't block the entire process, allowing `epoll_wait` to manage multiple connections.
*   **`EPOLLET` (Edge-Triggered)**: This is the default and generally preferred mode for high-performance `epoll` usage. It means `epoll_wait` will *only* notify you when a *change* occurs (e.g., data *becomes* available). If you don't read all the data in one go, `epoll_wait` won't notify you again until *new* data arrives. This requires you to loop `read()` until it returns `EAGAIN` or `EWOULDBLOCK` to ensure all pending data is processed.
*   **Error Handling**: Pay close attention to `EAGAIN` and `EWOULDBLOCK` for non-blocking operations. These are not errors but indications that the operation would block, and you should try again later (when `epoll` notifies you).
*   **`EPOLLHUP`/`EPOLLERR`**: Always check for these events to detect client disconnections or errors gracefully.

## Elevating to a Real Proxy: Bidirectional Data Flow

A true proxy needs to forward data bidirectionally between a client and a target server. This means managing pairs of sockets (client-to-proxy and proxy-to-target) and efficiently moving data between them.

For a secure proxy, we'd typically add TLS/SSL encryption. This introduces another layer of complexity, as `SSL_read` and `SSL_write` operations can also return `WANT_READ` or `WANT_WRITE`, indicating that the underlying socket needs to be ready for reading or writing before the TLS operation can complete.

### Conceptualizing a Bidirectional `epoll` Proxy:

1.  **Connection State**: Each client connection needs to track its associated target connection. A `struct connection` could hold:
    *   `client_fd`: The socket connected to the client.
    *   `target_fd`: The socket connected to the upstream server.
    *   `client_rbuffer`, `client_wbuffer`: Buffers for data from client.
    *   `target_rbuffer`, `target_wbuffer`: Buffers for data from target.
    *   `ssl_client_ctx`, `ssl_target_ctx`: (If TLS is used) SSL contexts.
    *   `state`: Enum to track connection lifecycle (e.g., `CONNECTING_TARGET`, `CONNECTED`, `CLOSING`).

2.  **Mapping FDs to Connections**: A hash map or array could map file descriptors to their corresponding `struct connection` pointers.

3.  **Event Handling Logic**:
    *   **New Client Connection (`listen_sock` `EPOLLIN`)**:
        *   `accept()` the client.
        *   Create a new `struct connection`.
        *   Initiate connection to the target server (non-blocking `connect`).
        *   Add both `client_fd` and `target_fd` to `epoll` (initially `EPOLLIN | EPOLLOUT` for `target_fd` to detect `connect` completion).
    *   **Existing `client_fd` `EPOLLIN`**:
        *   Read data from `client_fd` into `client_rbuffer`.
        *   Attempt to write data from `client_rbuffer` to `target_fd` (into `target_wbuffer` if using TLS, then `SSL_write`).
        *   If `write` to `target_fd` returns `EAGAIN` or `WANT_WRITE`, ensure `target_fd` is registered for `EPOLLOUT`.
    *   **Existing `target_fd` `EPOLLIN`**:
        *   Read data from `target_fd` into `target_rbuffer`.
        *   Attempt to write data from `target_rbuffer` to `client_fd`.
        *   If `write` to `client_fd` returns `EAGAIN` or `WANT_WRITE`, ensure `client_fd` is registered for `EPOLLOUT`.
    *   **Existing `client_fd` or `target_fd` `EPOLLOUT`**:
        *   Attempt to flush pending write buffers for that socket.
        *   If `connect` completed, transition state to `CONNECTED`.
        *   Remove `EPOLLOUT` if no more data to write.
    *   **`EPOLLHUP`/`EPOLLERR`**: Clean up both ends of the connection, free memory, and remove FDs from `epoll`.

## Security Considerations for a Proxy

While `epoll` provides performance, security is paramount. Here are critical areas:

1.  **Input Validation & Sanitization**: If your proxy parses protocols (e.g., HTTP headers), rigorously validate all input to prevent buffer overflows, injection attacks, and denial-of-service.
2.  **Resource Limits**: Implement limits on memory usage per connection, total connections, and read/write buffer sizes to prevent resource exhaustion attacks.
3.  **TLS/SSL**: For any sensitive data, terminate TLS at the proxy (if it's an SSL-terminating proxy) or tunnel it transparently. Use strong ciphers, up-to-date TLS versions, and proper certificate validation. Leverage libraries like OpenSSL.
4.  **Least Privilege**: Run the proxy process with the minimum necessary privileges. Drop root privileges after binding to privileged ports.
5.  **Logging and Monitoring**: Comprehensive logging of connection events, errors, and potential anomalies is crucial for detection and forensics. Integrate with your SIEM.
6.  **Rate Limiting**: Implement connection rate limiting per source IP to mitigate DoS attacks.
7.  **Configuration Management**: Securely manage proxy configuration, especially if it involves upstream server addresses, ports, or authentication credentials.
8.  **Error Handling**: Robust error handling prevents crashes that could expose services or lead to unhandled states.
9.  **Memory Management**: In C, careful `malloc`/`free` is essential to prevent memory leaks and use-after-free vulnerabilities.

## Conclusion

Building a high-performance network proxy in C with `epoll` is a rewarding exercise that provides deep insights into network programming and operating system internals. While the initial setup is more involved than with higher-level frameworks, the control, performance, and understanding gained are invaluable, especially in security-critical environments.

By mastering `epoll` and combining it with diligent security practices, you can engineer robust, efficient, and secure network infrastructure components essential for today's complex digital landscape. Remember, performance without security is a liability, and security without performance is often impractical. Strive for both.