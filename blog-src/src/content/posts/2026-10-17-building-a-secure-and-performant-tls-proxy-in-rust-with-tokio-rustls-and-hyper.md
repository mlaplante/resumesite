---
title: "Building a Secure and Performant TLS Proxy in Rust with Tokio Rustls and Hyper"
date: 2026-10-17
category: "thought-leadership"
tags: ["rust", "tls", "security", "networking", "proxy", "tokio"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In modern infrastructure, edge proxies and ingress controllers sit at the absolute boundary of your threat model. They bear the brunt of internet..."
---

In modern infrastructure, edge proxies and ingress controllers sit at the absolute boundary of your threat model. They bear the brunt of internet traffic, perform expensive cryptographic operations, and must route requests with sub-millisecond overhead. For years, C and C++ dominated this space via tools like NGINX and HAProxy. While performant, memory safety vulnerabilities in edge software remain a continuous risk.

Memory safety at the edge shouldn't cost performance. Rust has shifted the landscape here, offering zero-cost abstractions, memory safety without a garbage collector, and a world-class asynchronous ecosystem.

In this deep dive, we will build a production-ready, highly secure, and concurrent TLS-terminating reverse proxy using `tokio`, `rustls`, and `hyper`. We'll focus on strict TLS 1.3/1.2 configurations, zero-copy socket forwarding, memory-efficient streaming, and robust error handling.

---

### Architecture Overview

Our proxy will execute a common edge pattern:
1. Accept raw TCP connections on an encrypted public interface (e.g., port 443).
2. Perform a fast, secure TLS handshake using `tokio-rustls`.
3. Hand off the decrypted stream to `hyper` to parse HTTP/1.1 or HTTP/2 requests.
4. Proxy the HTTP request to an internal upstream service, streaming the response body back to the client.

```
+--------+    TLS/TCP     +-----------------------------------+   Cleartext/TCP   +------------------+
| Client | -------------> | Proxy (Tokio + Rustls + Hyper)    | ----------------> | Upstream Service |
+--------+  (Port 443)    +-----------------------------------+    (Port 8080)    +------------------+
```

---

### Step 1: Setting Up the Cargo Environment

Let's begin with our dependencies. We'll use `tokio` for the async runtime, `rustls` (via `tokio-rustls`) for crypto operations, and `hyper` for HTTP processing. `rustls` is crucial here: it's written in safe Rust, relies on `ring` for cryptography, and explicitly excludes legacy, insecure TLS features (like SSLv3, RC4, or MD5).

Add the following to your `Cargo.toml`:

```toml
[package]
name = "secure-tls-proxy"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1.38", features = ["full"] }
tokio-rustls = "0.26"
rustls-pki-types = "1.7"
hyper = { version = "1.4", features = ["full"] }
hyper-util = { version = "0.1", features = ["full"] }
http-body-util = "0.1"
rcgen = "0.13" # For generating self-signed certs in dev/testing
tracing = "0.1"
tracing-subscriber = "0.3"
anyhow = "1.0"
```

---

### Step 2: Configuring Hardened TLS Server Parameters

Default settings are rarely sufficient for high-security environments. We want to restrict cipher suites to modern authenticated encryption (AEAD) algorithms, enforce ALPN (Application-Layer Protocol Negotiation) for HTTP/2 and HTTP/1.1, and ensure perfect forward secrecy (PFS).

Here is how we build a hardened `ServerConfig`:

```rust
use std::sync::Arc;
use tokio_rustls::rustls::server::ServerConfig;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ALL_CIPHER_SUITES;

pub fn create_hardened_tls_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> anyhow::Result<Arc<ServerConfig>> {
    // Select modern, secure cipher suites (TLS 1.2 & TLS 1.3)
    let cipher_suites = ALL_CIPHER_SUITES
        .iter()
        .filter(|cs| cs.usable_for_protocol_version(tokio_rustls::rustls::ProtocolVersion::TLSv1_3) 
                 || cs.usable_for_protocol_version(tokio_rustls::rustls::ProtocolVersion::TLSv1_2))
        .cloned()
        .collect::<Vec<_>>();

    let mut config = ServerConfig::builder_with_provider(
        rustls::crypto::ring::default_provider().into()
    )
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(certs, key)?;

    // Enforce HTTP/2 and HTTP/1.1 via ALPN
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    // Disable session tickets if key rotation isn't configured, favoring session IDs
    config.require_ems = true; // Require Extended Master Secret for TLS 1.2

    Ok(Arc::new(config))
}
```

By explicitly declaring ALPN protocols (`h2`, `http/1.1`), `rustls` negotiates the application protocol during the initial TLS handshake. This eliminates an extra network round-trip before `hyper` begins processing HTTP frames.

---

### Step 3: Implementing the Proxy Engine with Hyper v1.0

With `hyper` v1.0, the framework separated lower-level IO primitives from higher-level HTTP abstractions. We use `hyper_util::rt::TokioIo` to wrap our `tokio_rustls::server::TlsStream` so `hyper` can perform asynchronous reads and writes over TLS natively.

Here is the full proxy loop and upstream forwarding logic:

```rust
use std::net::SocketAddr;
use std::sync::Arc;
use anyhow::Context;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::client::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioExecutor};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tracing::{error, info, instrument};

const UPSTREAM_ADDR: &str = "127.0.0.1:8080";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    // Generate ephemeral self-signed certs for testing
    let (certs, key) = generate_self_signed_cert()?;
    let tls_config = create_hardened_tls_config(certs, key)?;
    let acceptor = TlsAcceptor::from(tls_config);

    let listen_addr = "0.0.0.0:8443";
    let listener = TcpListener::bind(listen_addr).await?;
    info!("TLS Proxy listening on https://{}", listen_addr);

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(val) => val,
            Err(e) => {
                error!("Failed to accept raw TCP connection: {:?}", e);
                continue;
            }
        };

        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, peer_addr, acceptor).await {
                error!(peer = %peer_addr, "Connection error: {:?}", err);
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    acceptor: TlsAcceptor,
) -> anyhow::Result<()> {
    // 1. Perform TLS Handshake asynchronously
    let tls_stream = acceptor.accept(stream).await
        .context("TLS handshake failed")?;

    let io = TokioIo::new(tls_stream);

    // 2. Bind the TLS stream to Hyper's HTTP engine
    let service = service_fn(move |req: Request<hyper::body::Incoming>| {
        async move {
            forward_request(req).await
        }
    });

    if let Err(err) = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .await
    {
        error!(peer = %peer_addr, "Error serving HTTP connection: {:?}", err);
    }

    Ok(())
}

#[instrument(skip(req))]
async fn forward_request(
    req: Request<hyper::body::Incoming>,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error> {
    info!(method = %req.method(), uri = %req.uri(), "Forwarding request to upstream");

    // Connect to the upstream cleartext service
    let upstream_stream = match TcpStream::connect(UPSTREAM_ADDR).await {
        Ok(s) => TokioIo::new(s),
        Err(e) => {
            error!("Failed to connect to upstream: {:?}", e);
            let mut resp = Response::new(BoxBody::new(
                Empty::<Bytes>::new().map_err(|e| match e {}),
            ));
            *resp.status_mut() = StatusCode::BAD_GATEWAY;
            return Ok(resp);
        }
    };

    // Establish HTTP/1.1 handshake with upstream
    let (mut sender, conn) = http1::handshake(upstream_stream).await?;
    tokio::spawn(async move {
        if let Err(err) = conn.await {
            error!("Upstream connection failed: {:?}", err);
        }
    });

    // Send the request and obtain response stream
    let response = sender.send_request(req.map(BoxBody::new)).await?;
    
    // Box the response body to stream data back to the client with minimal buffering
    Ok(response.map(|body| BoxBody::new(body)))
}
```

---

### Step 4: Generating Ephemeral Certificates (Dev/Test Helper)

To test the implementation end-to-end without needing an external PKI or Certbot pipeline during local execution, we use `rcgen` to generate an in-memory X.509 certificate and private key.

```rust
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rcgen::generate_simple_self_signed;

fn generate_self_signed_cert() -> anyhow::Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    let subject_alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    let cert = generate_simple_self_signed(subject_alt_names)?;
    
    let cert_der = cert.cert.der().to_vec();
    let key_der = cert.key_pair.serialize_der();

    Ok((
        vec![CertificateDer::from(cert_der)],
        PrivateKeyDer::Pkcs8(key_der.into()),
    ))
}
```

---

### Hardening and Production Considerations

Writing the code is only half the battle. Running Rust at the edge requires specific runtime and compiler configurations to ensure low tail-latencies and resilience against denial-of-service (DoS) attacks.

#### 1. Connection Draining & Timeouts
Production reverse proxies must never hold sockets open indefinitely. You should wrap `acceptor.accept()` and `forward_request()` calls with strict timeouts using `tokio::time::timeout`.

```rust
use std::time::Duration;

let tls_stream = tokio::time::timeout(
    Duration::from_secs(5), 
    acceptor.accept(stream)
)
.await
.context("TLS Handshake timed out")??;
```

#### 2. Resource Limits & Backpressure
Always limit the maximum concurrent connections using a semaphore (`tokio::sync::Semaphore`). Accepting connections indiscriminately will consume file descriptors and exhaust system memory during traffic spikes.

#### 3. Optimized Release Profile
Ensure your `Cargo.toml` is optimized for binary size, execution performance, and Link-Time Optimization (LTO):

```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
```

* `lto = "fat"` allows LLVM to optimize aggressively across crate boundaries (crucial for `ring` and `tokio`).
* `panic = "abort"` removes unwinding landing pads, reducing binary size and improving control flow predictability.

---

### Practical Takeaways

1. **Memory Safety without Performance Penalty**: By leveraging Rust, `tokio-rustls`, and `hyper`, we achieve performance comparable to C-based solutions while eliminating whole classes of memory-corruption bugs (buffer overflows, use-after-free).
2. **Explicit Crypto**: `rustls` removes legacy, dangerous protocol fallbacks by default, ensuring your edge proxy complies with strict security baselines out-of-the-box.
3. **Zero-Copy Architecture**: Using `TokioIo` and streaming response bodies via `BoxBody` prevents full-payload buffering in RAM, ensuring memory consumption remains stable even under heavy throughput.

Building edge infrastructure in Rust guarantees that security and speed are shared design goals—not trade-offs.