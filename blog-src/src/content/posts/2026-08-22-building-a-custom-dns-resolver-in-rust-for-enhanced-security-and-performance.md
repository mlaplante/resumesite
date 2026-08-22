---
title: "Building a Custom DNS Resolver in Rust for Enhanced Security and Performance"
date: 2026-08-22
category: "thought-leadership"
tags: ["rust", "dns", "network-security", "performance", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of information security and high-performance systems, we're constantly looking for ways to gain more control, improve visibility, and..."
---

# Building a Custom DNS Resolver in Rust for Enhanced Security and Performance

In the world of information security and high-performance systems, we're constantly looking for ways to gain more control, improve visibility, and shave off critical milliseconds. While the default DNS resolvers provided by operating systems or ISPs are convenient, they often lack the granular control and security features that enterprise environments demand. This is where building a custom DNS resolver, particularly in a language like Rust, becomes a compelling proposition.

Rust, with its focus on memory safety, concurrency, and performance, is an excellent choice for network-level services. In this post, we'll explore the architectural considerations and key Rust components involved in building a basic yet robust custom DNS resolver, highlighting how it can enhance both security and performance.

## Why Build Your Own DNS Resolver?

Before diving into the code, let's establish the "why":

1.  **Enhanced Security:**
    *   **Filtering:** Implement custom blocklists (e.g., known phishing sites, ad domains) directly at the resolver level.
    *   **Logging & Auditing:** Gain deep insights into all DNS queries originating from your network, identifying suspicious patterns or exfiltration attempts.
    *   **DNS-over-TLS/HTTPS (DoT/DoH) Enforcement:** Ensure all upstream queries are encrypted, preventing snooping and manipulation.
    *   **Response Validation:** Implement checks for DNSSEC validation or other anomalies.
2.  **Improved Performance:**
    *   **Custom Caching:** Fine-tune caching strategies beyond what standard resolvers offer, leading to faster lookups for frequently accessed domains.
    *   **Load Balancing/Failover:** Distribute queries across multiple upstream DNS servers and implement intelligent failover.
    *   **Reduced Latency:** Optimize network interactions and minimize overhead.
3.  **Flexibility and Control:**
    *   **Internal Domain Resolution:** Easily integrate with internal DNS zones for private networks.
    *   **Policy Enforcement:** Apply different resolution policies based on source IP, time of day, or other criteria.
    *   **Experimentation:** Test new DNS features or protocols before they are widely adopted.

## Core Components of a DNS Resolver

A custom DNS resolver, at its heart, performs several key functions:

1.  **Listening for Queries:** Accepts incoming DNS requests, typically on UDP port 53 (and sometimes TCP port 53 for larger responses or zone transfers).
2.  **Parsing Queries:** Decodes the incoming raw UDP/TCP payload into a structured DNS query object.
3.  **Caching:** Checks if the requested domain is already in its cache. If so, it returns the cached response.
4.  **Forwarding/Resolving:** If not cached, it forwards the query to an upstream DNS server (e.g., 8.8.8.8, 1.1.1.1) or performs a recursive lookup starting from the root servers.
5.  **Parsing Responses:** Decodes the upstream server's response.
6.  **Caching Responses:** Stores valid responses in its cache for future use.
7.  **Responding to Client:** Encodes and sends the response back to the original client.

## Building Blocks in Rust

Rust's ecosystem provides excellent crates for network programming and DNS protocol handling. We'll leverage a few key ones:

*   **`tokio`**: An asynchronous runtime for Rust, essential for building high-performance network services that can handle many concurrent connections without blocking.
*   **`trust-dns-proto`**: A robust library for encoding and decoding DNS messages. This handles the complex byte-level parsing of DNS packets, saving us a tremendous amount of effort.
*   **`moka`**: A high-performance, concurrent caching library, perfect for our DNS cache.

Let's outline a simplified `main.rs` structure.

```rust
// main.rs
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::timeout;

use trust_dns_proto::op::{Message, MessageType, OpCode, ResponseCode};
use trust_dns_proto::rr::{A, RData, Record, RecordType};
use trust_dns_proto::serialize::binary::{BinDecoder, BinEncoder};
use trust_dns_proto::error::ProtoError;

// For our simple cache, we'll store the response message and its expiry time.
#[derive(Debug, Clone)]
struct CachedResponse {
    message: Message,
    expires_at: Instant,
}

// A simple in-memory cache for demonstration. For production, consider `moka` or similar.
type DnsCache = Arc<RwLock<HashMap<String, CachedResponse>>>;

const UPSTREAM_DNS: &str = "8.8.8.8:53"; // Example upstream DNS server
const LISTEN_ADDR: &str = "0.0.0.0:53";   // Address to listen on

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listen_addr: SocketAddr = LISTEN_ADDR.parse()?;
    let upstream_addr: SocketAddr = UPSTREAM_DNS.parse()?;

    let socket = UdpSocket::bind(listen_addr).await?;
    println!("Listening for DNS queries on {}", listen_addr);

    let cache: DnsCache = Arc::new(RwLock::new(HashMap::new()));
    let (tx, mut rx) = mpsc::channel::<(Vec<u8>, SocketAddr)>(100); // Channel for incoming queries

    // Spawn a task to listen for incoming UDP packets
    let listener_socket = socket.try_clone()?;
    tokio::spawn(async move {
        let mut buf = vec![0; 512]; // Standard DNS UDP packet size
        loop {
            match listener_socket.recv_from(&mut buf).await {
                Ok((len, src)) => {
                    // Send the received data and source address to the processing channel
                    if tx.send((buf[..len].to_vec(), src)).await.is_err() {
                        eprintln!("Failed to send query to channel.");
                    }
                }
                Err(e) => eprintln!("Error receiving UDP packet: {}", e),
            }
        }
    });

    // Main loop to process queries
    while let Some((packet_data, src_addr)) = rx.recv().await {
        let cache_clone = Arc::clone(&cache);
        let socket_clone = socket.try_clone()?;

        tokio::spawn(async move {
            if let Err(e) = handle_query(
                packet_data,
                src_addr,
                upstream_addr,
                cache_clone,
                socket_clone,
            )
            .await
            {
                eprintln!("Error handling query from {}: {}", src_addr, e);
            }
        });
    }

    Ok(())
}

async fn handle_query(
    packet_data: Vec<u8>,
    src_addr: SocketAddr,
    upstream_addr: SocketAddr,
    cache: DnsCache,
    socket: UdpSocket,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut decoder = BinDecoder::new(&packet_data);
    let query_message = Message::read(&mut decoder)?;

    // Log the incoming query (for security visibility)
    if let Some(query) = query_message.queries().first() {
        println!(
            "[{}] Query from {}: {} {}",
            query_message.id(),
            src_addr,
            query.query_type(),
            query.name()
        );

        let query_name = query.name().to_string();

        // 1. Check cache
        if let Some(cached_resp) = cache.read().unwrap().get(&query_name) {
            if cached_resp.expires_at > Instant::now() {
                println!(
                    "[{}] Cache HIT for {} (expires in {:?})",
                    query_message.id(),
                    query_name,
                    cached_resp.expires_at.duration_since(Instant::now())
                );
                // Re-use the cached message, but update its ID to match the current query's ID
                let mut response = cached_resp.message.clone();
                response.set_id(query_message.id());
                let mut encoder = BinEncoder::new();
                response.emit(&mut encoder)?;
                socket.send_to(&encoder.as_bytes(), src_addr).await?;
                return Ok(());
            } else {
                println!("[{}] Cache MISS (expired) for {}", query_message.id(), query_name);
                cache.write().unwrap().remove(&query_name); // Remove expired entry
            }
        }
    }

    // 2. Forward to upstream DNS
    let upstream_socket = UdpSocket::bind("0.0.0.0:0").await?; // Bind to an ephemeral port
    upstream_socket.send_to(&packet_data, upstream_addr).await?;

    let mut response_buf = vec![0; 512];
    let (len, _) = match timeout(Duration::from_secs(2), upstream_socket.recv_from(&mut response_buf)).await {
        Ok(Ok((len, remote_addr))) => (len, remote_addr),
        Ok(Err(e)) => {
            eprintln!("Error receiving from upstream: {}", e);
            return send_error_response(&socket, src_addr, query_message.id(), ResponseCode::ServFail).await;
        },
        Err(_) => {
            eprintln!("Timeout receiving from upstream.");
            return send_error_response(&socket, src_addr, query_message.id(), ResponseCode::ServFail).await;
        },
    };

    let mut response_decoder = BinDecoder::new(&response_buf[..len]);
    let upstream_response = Message::read(&mut response_decoder)?;

    // 3. Cache the response (if successful and cacheable)
    if upstream_response.response_code() == ResponseCode::NoError {
        if let Some(query) = query_message.queries().first() {
            let query_name = query.name().to_string();
            // A very simple TTL for demonstration. In reality, parse actual record TTLs.
            let ttl = Duration::from_secs(60);
            let expires_at = Instant::now() + ttl;

            println!(
                "[{}] Cache SET for {} (TTL: {:?})",
                query_message.id(),
                query_name,
                ttl
            );
            cache.write