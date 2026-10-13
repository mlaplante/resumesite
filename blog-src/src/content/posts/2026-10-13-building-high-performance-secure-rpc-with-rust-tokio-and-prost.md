---
title: "Building High-Performance, Secure RPC with Rust, Tokio, and Prost"
date: 2026-10-13
category: "thought-leadership"
tags: ["rust", "tokio", "rpc", "network-security", "protobuf", "systems-programming"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of distributed systems, efficient and secure inter-service communication is paramount. While REST APIs are ubiquitous, RPC (Remote..."
---

In the world of distributed systems, efficient and secure inter-service communication is paramount. While REST APIs are ubiquitous, RPC (Remote Procedure Call) frameworks often offer superior performance, type safety, and lower latency for internal service-to-service communication. When building such critical infrastructure, Rust emerges as an excellent choice, leveraging its memory safety, performance characteristics, and robust async ecosystem.

This post will guide you through crafting a foundational RPC framework in Rust, focusing on `tokio` for asynchronous operations and `prost` for Protocol Buffers (protobuf) serialization. We'll emphasize practical, hands-on engineering details, including secure transport considerations.

## Why Rust for RPC?

1.  **Performance:** Rust's zero-cost abstractions and control over memory layout allow for highly optimized code, crucial for low-latency RPC.
2.  **Memory Safety:** The borrow checker eliminates entire classes of bugs common in C++ or other systems languages, leading to more reliable services.
3.  **Concurrency:** `tokio` provides a powerful, ergonomic async runtime, making it straightforward to build highly concurrent network services.
4.  **Type Safety:** Combined with protobuf, Rust's strong type system ensures that RPC calls are type-checked at compile time, catching integration errors early.

## Core Components: Tokio and Prost

*   **Tokio:** The de facto standard asynchronous runtime for Rust. It provides the building blocks for network programming, including TCP streams, timers, and task scheduling.
*   **Prost:** A Protocol Buffers implementation for Rust. It generates native Rust types from `.proto` definitions, handling serialization and deserialization efficiently. This gives us our structured message format.

## Step 1: Defining the Service with Protocol Buffers

First, we define our RPC service and message structures using `.proto` files. Let's imagine a simple "Greeter" service.

```protobuf
// proto/greeter.proto
syntax = "proto3";

package greeter;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloResponse) {}
  rpc SayHelloStream (HelloRequest) returns (stream HelloResponse) {} // Example of streaming
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
}
```

To compile this, add `prost` and `prost-build` to your `Cargo.toml`:

```toml
# Cargo.toml
[dependencies]
prost = "0.12"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["codec"] } # For length-delimited frames
bytes = "1"
tracing = "0.1"
tracing-subscriber = "0.3"

[build-dependencies]
prost-build = "0.12"
```

Then, create a `build.rs` script to generate Rust code from the `.proto` file:

```rust
// build.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    prost_build::compile_protos(&["proto/greeter.proto"], &["proto/"])?;
    Ok(())
}
```

Running `cargo build` will now generate `greeter.rs` (or similar) in your `target` directory, containing the Rust structs and service traits.

## Step 2: Implementing Secure Transport with TLS

For secure RPC, encrypting the transport layer is non-negotiable. We'll use `tokio-rustls` for TLS.

First, add `tokio-rustls`, `rustls`, and `rustls-pemfile` to `Cargo.toml`:

```toml
# Cargo.toml (additions)
tokio-rustls = "0.24"
rustls = "0.21"
rustls-pemfile = "1"
```

Next, let's set up a basic TLS configuration for both server and client.

### Server TLS Configuration

```rust
use std::{fs::File, io::BufReader, sync::Arc};
use rustls::{Certificate, PrivateKey, ServerConfig};
use rustls_pemfile::{certs, pkcs8_private_keys};

fn load_certs(path: &str) -> Vec<Certificate> {
    certs(&mut BufReader::new(File::open(path).unwrap()))
        .unwrap()
        .into_iter()
        .map(Certificate)
        .collect()
}

fn load_private_key(path: &str) -> PrivateKey {
    let mut keys = pkcs8_private_keys(&mut BufReader::new(File::open(path).unwrap()))
        .unwrap();
    assert!(!keys.is_empty());
    PrivateKey(keys.remove(0))
}

pub fn create_server_tls_config(cert_path: &str, key_path: &str) -> Arc<ServerConfig> {
    let certs = load_certs(cert_path);
    let key = load_private_key(key_path);

    let config = ServerConfig::builder()
        .with_safe_defaults()
        .with_no_client_auth() // For now, no client auth; could add later
        .with_single_cert(certs, key)
        .expect("Failed to create server TLS config");

    Arc::new(config)
}
```

You'll need `server.crt` and `server.key` files for this. For development, you can generate self-signed certificates using OpenSSL:

```bash
# Generate a private key
openssl genrsa -out server.key 2048

# Generate a Certificate Signing Request (CSR)
openssl req -new -key server.key -out server.csr -subj "/CN=localhost"

# Generate a self-signed certificate
openssl x509 -req -days 365 -in server.csr -signkey server.key -out server.crt
```

### Client TLS Configuration

```rust
use rustls::{ClientConfig, RootCertStore};

pub fn create_client_tls_config(ca_cert_path: &str) -> Arc<ClientConfig> {
    let mut root_store = RootCertStore::empty();
    root_store.add_pem_file(&mut BufReader::new(File::open(ca_cert_path).unwrap()))
        .unwrap();

    let config = ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(root_store)
        .no_client_auth(); // No client cert for now

    Arc::new(config)
}
```

Here, `ca_cert_path` would point to the `server.crt` file (if self-signed) or your organization's CA certificate.

## Step 3: Framing and Codecs for RPC Messages

Raw TCP streams don't provide message boundaries. We need a way to delineate individual RPC messages. A common approach is length-prefixing. `tokio-util` provides `LengthDelimitedCodec` for this.

```rust
use bytes::{Bytes, BytesMut};
use tokio_util::codec::{LengthDelimitedCodec, Decoder, Encoder};
use prost::Message; // Trait for prost-generated messages

// Our custom codec wraps LengthDelimitedCodec
pub struct ProstCodec<T>(LengthDelimitedCodec, std::marker::PhantomData<T>);

impl<T> ProstCodec<T> {
    pub fn new() -> Self {
        ProstCodec(LengthDelimitedCodec::new(), std::marker::PhantomData)
    }
}

impl<T: Message + Default> Decoder for ProstCodec<T> {
    type Item = T;
    type Error = std::io::Error;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        match self.0.decode(src)? {
            Some(bytes) => Ok(Some(T::decode(bytes)?)),
            None => Ok(None),
        }
    }
}

impl<T: Message> Encoder<T> for ProstCodec<T> {
    type Error = std::io::Error;

    fn encode(&mut self, item: T, dst: &mut BytesMut) -> Result<(), Self::Error> {
        let mut buf = BytesMut::new();
        item.encode(&mut buf)?;
        self.0.encode(buf.freeze(), dst)
    }
}
```

This `ProstCodec` allows us to send and receive our protobuf-generated Rust structs directly over a `Framed` connection.

## Step 4: The RPC Server Implementation

Now, let's put it all together to build the server. We'll use the `greeter` service trait generated by `prost-build`.

```rust
// src/server.rs
use crate::proto::greeter::{greeter_server::Greeter, HelloRequest, HelloResponse};
use crate::tls::{create_server_tls_config};
use crate::codec::ProstCodec;

use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_util::codec::Framed;
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tracing::{info, error};

// Generated service trait and structs
pub mod proto {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/greeter.rs"));
}

#[derive(Default)]
pub struct MyGreeterService;

#[tonic::async_trait] // Using tonic's async_trait for simplicity, can be custom
impl Greeter for MyGreeterService {
    async fn say_hello(&self, request: HelloRequest) -> HelloResponse {
        info!("Received HelloRequest from: {}", request.name);
        HelloResponse {
            message: format!("Hello, {}!", request.name),
        }
    }

    type SayHelloStreamStream = tokio_stream::iter<std::vec::IntoIter<HelloResponse>>;

    async fn say_hello_stream(&self, request: HelloRequest) -> Self::SayHelloStreamStream {
        info!("Received HelloStreamRequest from: {}", request.name);
        let responses = vec![
            HelloResponse { message: format!("Stream 1: Hello, {}!", request.name) },
            HelloResponse { message: format!("Stream 2: Greetings, {}!", request.name) },
            HelloResponse { message: format!("Stream 3: Farewell, {}!", request.name) },
        ];
        tokio_stream::iter(responses.into_iter())
    }
}

pub async fn run_server(addr: &str, cert_path: &str, key_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(addr).await?;
    let tls_config = create_server_tls_config(cert_path, key_path);
    let tls_acceptor = TlsAcceptor::from(tls_config);

    info!("Greeter server listening on {} with TLS", addr);

    loop {
        let (socket, client_addr) = listener.accept().await?;
        info!("Accepted connection from: {}", client_addr);

        let tls_acceptor_clone = tls_acceptor.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(socket, tls_acceptor_clone).await {
                error!("Error handling connection from {}: {:?}", client_addr, e);
            }
        });
    }
}

async fn handle_connection(socket: TcpStream, tls_acceptor: TlsAcceptor) -> Result<(), Box<dyn std::error::Error>> {
    let tls_stream = tls_acceptor.accept(socket).await?;
    let mut framed = Framed::new(tls_stream, ProstCodec::<HelloRequest>::new());

    // In a real RPC, you'd multiplex requests and responses.
    // For simplicity, this example just handles one request per connection.
    if let Some(request) = framed.next().await {
        let request = request?; // Propagate potential decoding errors
        let service = MyGreeterService::default(); // Or use a shared Arc<MyGreeterService>
        let response = service.say_hello(request).await;
        framed.send(response).await?;
    }

    Ok(())
}
```

*Note*: The `handle_connection` logic above is highly simplified. A robust RPC server would need:
1.  A way to dispatch requests to different service methods based on a header (e.g., method name).
2.  A mechanism to correlate requests and responses (e.g., a request ID).
3.  Support for streaming RPCs (like `SayHelloStream`).
4.  Error handling for service-level errors.

These complexities are often abstracted by full-fledged RPC frameworks like `tonic` (which uses `prost` and `tokio` internally). Our goal here is to understand the *foundational* building blocks.

## Step 5: The RPC Client Implementation

The client side mirrors the server, but initiates the TLS handshake.

```rust
// src/client.rs
use crate::proto::greeter::{greeter_client::GreeterClient, HelloRequest};
use crate::tls::create_client_tls_config;
use crate::codec::ProstCodec;

use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_util::codec::Framed;
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use std::net::SocketAddr;
use tracing::{info, error};
use rustls::ServerName;

// Re-export proto module for client
pub use crate::server::proto;

pub async fn run_client(addr: &str, ca_cert_path: &str, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let tls_config = create_client_tls_config(ca_cert_path);
    let tls_connector = TlsConnector::from(tls_config);

    let server_addr: SocketAddr = addr.parse()?;
    let domain = ServerName::try_from("localhost")?; // Must match the CN in server.crt

    info!("Connecting to server at {} with TLS", addr);
    let stream = TcpStream::connect(server_addr).await?;
    let tls_stream = tls_connector.connect(domain, stream).await?;

    let mut framed = Framed::new(tls_stream, ProstCodec::<HelloResponse>::new()); // Client decodes HelloResponse

    let request = HelloRequest { name: name.to_string() };
    framed.send(request).await?; // Client sends HelloRequest

    if let Some(response) = framed.next().await {
        let response = response?;
        info!("Client received: {}", response.message);
    } else {
        error!("Client received no response!");
    }

    Ok(())
}
```

## Step 6: Putting it all in `main.rs`

```rust
// src/main.rs
mod proto; // The generated module from build.rs
mod tls;
mod codec;
mod server;
mod client;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} [server|client]", args[0]);
        return Ok(());
    }

    let addr = "127.0.0.1:50051";
    let cert_path = "server.crt";
    let key_path = "server.key";

    match args[1].as_str() {
        "server" => {
            server::run_server(addr, cert_path, key_path).await?;
        }
        "client" => {
            let client_name = args.get(2).map(|s| s.as_str()).unwrap_or("World");
            client::run_client(addr, cert_path, client_name).await?;
        }
        _ => {
            eprintln!("Invalid argument. Use 'server' or 'client'.");
        }
    }

    Ok(())
}
```

## Running the Example

1.  **Generate Certificates:** Follow the OpenSSL commands above to create `server.crt` and `server.key` in your project root.
2.  **Build:** `cargo build`
3.  **Run Server:** `RUST_LOG=info cargo run -- server`
4.  **Run Client (in another terminal):** `RUST_LOG=info cargo run -- client Michael`

You should see output similar to this:

**Server:**
```
INFO greeter_server::server: Greeter server listening on 127.0.0.1:50051 with TLS
INFO greeter_server::server: Accepted connection from: 127.0.0.1:xxxxx
INFO greeter_server::server: Received HelloRequest from: Michael
```

**Client:**
```
INFO greeter_server::client: Connecting to server at 127.0.0.1:50051 with TLS
INFO greeter_server::client: Client received: Hello, Michael!
```

## Actionable Takeaways

*   **Start with Protobuf:** Define your service contracts clearly using `.proto` files. This enforces type safety and allows for language-agnostic service definitions.
*   **Prioritize Secure Transport:** Always use TLS for inter-service communication, even within a private network. `tokio-rustls` provides a robust, performant option in Rust.
*   **Understand Framing:** Raw TCP streams require message framing. `LengthDelimitedCodec` is a simple yet effective strategy.
*   **Build vs. Buy:** While building a minimal RPC foundation like this is educational and offers deep control, for production systems, consider mature frameworks like `tonic` (which uses Protobuf, Tokio, and Rustls/OpenSSL under the hood) or `gRPC` (with its Rust implementation). They handle the complexities of multiplexing, streaming, error propagation, and advanced features.
*   **Performance Tuning:** For ultra-low latency, consider `SO_REUSEPORT` for listeners, `TCP_NODELAY` for sockets, and efficient buffer management with `bytes` and `BytesMut`.

This deep dive into building a secure, performant RPC framework in Rust with Tokio and Prost demonstrates the power and flexibility of Rust for systems programming. It provides a solid understanding of the underlying mechanisms that power modern distributed applications.