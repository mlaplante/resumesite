---
title: "Building a Secure and Observable Data Plane with Envoy and WebAssembly Filters"
date: 2026-05-23
category: "thought-leadership"
tags: []
excerpt: "In today's distributed architectures, the data plane is the beating heart of your application, handling all network traffic between services. Ensuring..."
---

# Building a Secure and Observable Data Plane with Envoy and WebAssembly Filters

In today's distributed architectures, the data plane is the beating heart of your application, handling all network traffic between services. Ensuring this layer is both secure and observable is paramount for reliability and threat detection. While service meshes like Istio or Linkerd offer comprehensive solutions, understanding the underlying components and how to leverage them directly can provide immense flexibility and control, especially for specialized use cases or when a full mesh is overkill.

This post will dive into building a robust, secure, and observable data plane using Envoy Proxy and custom WebAssembly (Wasm) filters. We'll explore how Envoy acts as a universal data plane, and how Wasm filters empower you to inject custom logic, security policies, and rich telemetry directly into the traffic flow without recompiling Envoy itself.

## Why Envoy and Wasm?

Envoy Proxy has become the de facto standard for the data plane in many modern architectures. Its powerful capabilities include:

*   **L4/L7 Load Balancing:** Sophisticated routing, retries, circuit breaking, and more.
*   **Protocol Agnostic:** Handles HTTP/1.1, HTTP/2, gRPC, TCP, and more.
*   **Observability:** Built-in support for metrics (Prometheus), tracing (Jaeger, Zipkin), and access logs.
*   **Extensibility:** Crucially, Envoy is designed to be extended, and WebAssembly is the modern, secure, and performant way to do it.

WebAssembly filters allow you to write custom logic in languages like C++, Rust, Go (TinyGo), or AssemblyScript, compile it to a `.wasm` module, and dynamically load it into Envoy. This offers several advantages over traditional C++ filters:

*   **Safety:** Wasm runs in a sandboxed environment, preventing crashes or memory leaks from affecting Envoy.
*   **Portability:** Wasm modules are platform-independent.
*   **Performance:** Near-native performance.
*   **Dynamic Loading:** Filters can be updated without restarting Envoy.

## Scenario: Enforcing API Key Security and Custom Logging

Let's imagine we have an internal API gateway fronting several microservices. We want to achieve two things:

1.  **API Key Validation:** Ensure all incoming requests to a specific path (`/api/v1/*`) have a valid API key in the `X-API-Key` header.
2.  **Custom Access Logging:** Augment Envoy's standard access logs with additional, business-specific metadata extracted from the request, such as a client ID derived from the API key.

We'll implement this using a Wasm filter.

### Step 1: Writing the WebAssembly Filter (Rust Example)

We'll use Rust for our Wasm filter, leveraging the `proxy-wasm-sdk`.

First, set up your Rust project:

```bash
cargo new --lib envoy-auth-logger-filter
cd envoy-auth-logger-filter
```

Add the `proxy-wasm-sdk` to your `Cargo.toml`:

```toml
[dependencies]
proxy-wasm = "0.2.0"
log = "0.4"

[lib]
crate-type = ["cdylib"]
```

Now, let's write the filter logic in `src/lib.rs`. This example will be simplified; in a real-world scenario, the API key validation might involve an external service call.

```rust
use proxy_wasm::traits::{Context, HttpContext, RootContext};
use proxy_wasm::types::{Action, LogLevel};
use std::collections::HashMap;

// A simple mock for API key validation
const VALID_API_KEY: &str = "super-secret-api-key-123";

#[no_mangle]
pub fn _start() {
    proxy_wasm::set_log_level(LogLevel::Debug);
    proxy_wasm::set_root_context(|_| -> Box<dyn RootContext> { Box::new(AuthLoggerRoot) });
}

struct AuthLoggerRoot;

impl RootContext for AuthLoggerRoot {
    fn on_vm_start(&mut self, _vm_configuration_size: usize) -> bool {
        log::info!("AuthLoggerRoot: VM started.");
        true
    }

    fn new_http_context(&self, _context_id: u32) -> Box<dyn HttpContext> {
        Box::new(AuthLoggerFilter {
            path_prefix_to_match: "/api/v1/".to_string(),
        })
    }
}

struct AuthLoggerFilter {
    path_prefix_to_match: String,
}

impl HttpContext for AuthLoggerFilter {
    fn on_http_request_headers(&mut self, _num_headers: usize, _end_of_stream: bool) -> Action {
        let path = self.get_http_request_header(":path").unwrap_or_default();

        // Only apply logic to paths starting with /api/v1/
        if !path.starts_with(&self.path_prefix_to_match) {
            log::debug!("Path '{}' does not match prefix, skipping auth.", path);
            return Action::Continue;
        }

        log::info!("Intercepting request for path: {}", path);

        match self.get_http_request_header("x-api-key") {
            Some(api_key) => {
                if api_key == VALID_API_KEY {
                    log::info!("Valid API Key received.");
                    // Set a custom metadata for logging later
                    self.set_property(
                        vec!["filter_state", "client_id"],
                        Some(api_key.strip_prefix("super-secret-api-key-").unwrap_or("unknown_client").as_bytes()),
                    );
                    Action::Continue
                } else {
                    log::warn!("Invalid API Key: {}", api_key);
                    self.send_http_response(
                        401,
                        vec![("content-type", "application/json")],
                        Some(b"{\"error\": \"Unauthorized: Invalid API Key\"}"),
                    );
                    Action::Pause // Stop further processing and send response
                }
            }
            None => {
                log::warn!("Missing X-API-Key header.");
                self.send_http_response(
                    401,
                    vec![("content-type", "application/json")],
                    Some(b"{\"error\": \"Unauthorized: Missing API Key\"}"),
                );
                Action::Pause // Stop further processing and send response
            }
        }
    }

    fn on_log(&mut self) {
        // Retrieve custom metadata set during request headers
        let client_id = self.get_property(vec!["filter_state", "client_id"])
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_else(|| "unknown".to_string());

        log::info!("Custom Log Entry: Client ID: {}", client_id);
    }
}
```

Compile the filter to Wasm:

```bash
cargo build --target wasm32-unknown-unknown --release
```

The compiled module will be at `target/wasm32-unknown-unknown/release/envoy_auth_logger_filter.wasm`.

### Step 2: Configuring Envoy with the Wasm Filter

Now, let's configure Envoy to load and execute this Wasm filter. We'll set up a simple listener and route requests to an upstream service (or a mock service for testing).

Create an `envoy.yaml` file:

```yaml
admin:
  access_log_path: "/dev/stdout"
  address:
    socket_address:
      protocol: TCP
      address: 127.0.0.1
      port_value: 9901

static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address:
        protocol: TCP
        address: 0.0.0.0
        port_value: 8080
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          route_config:
            name: local_route
            virtual_hosts:
            - name: backend
              domains: ["*"]
              routes:
              - match: { prefix: "/api/v1/" }
                route: { cluster: service_api }
              - match: { prefix: "/" }
                route: { cluster: service_default }
          http_filters:
          - name: envoy.filters.http.wasm
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.wasm.v3.Wasm
              config:
                name: "auth_logger_filter"
                root_id: "AuthLoggerRoot" # Matches the root context name in our Rust code
                vm_config:
                  vm_id: "auth_logger_vm"
                  runtime: "envoy.wasm.runtime.v8" # Use V8 runtime
                  code:
                    local:
                      filename: "target/wasm32-unknown-unknown/release/envoy_auth_logger_filter.wasm"
                  allow_precompiled: true
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
          # Custom access log configuration
          access_log:
          - name: envoy.access_loggers.file
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
              path: "/dev/stdout"
              format: |
                [%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%" %RESPONSE_CODE% %RESPONSE_FLAGS% %BYTES_RECEIVED% %BYTES_SENT% %DURATION% "%REQ(X-FORWARDED-FOR)%" "%REQ(USER-AGENT)%" "%REQ(X-REQUEST-ID)%" "%VS(filter_state:client_id)%" "%RESP(X-RESPONSE-CLIENT-ID)%"
                %FILTER_STATE(client_id)%
                %UNESCAPED_REQ(X-API-KEY)%
                %REQ(X-API-KEY)%
                %RESP(X-API-KEY)%
                %REQ(:AUTHORITY)%
                %RESP(X-CLIENT-ID)%
                %REQ(X-CLIENT-ID)%
                %REQ(X-CLIENT-ID)%
                %RESP(X-CLIENT-ID)%
                %REQ(X-CLIENT-ID)%
                %RESP(X-