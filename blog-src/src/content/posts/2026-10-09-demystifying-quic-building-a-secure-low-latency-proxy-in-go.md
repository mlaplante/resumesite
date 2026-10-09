---
title: "Demystifying QUIC: Building a Secure, Low-Latency Proxy in Go"
date: 2026-10-09
category: "thought-leadership"
tags: ["quic", "networking", "go", "performance", "security", "architecture"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "If you’ve spent any time tuning edge infrastructure or fighting the laws of physics over high-latency links, you’ve likely felt the pains of TCP...."
---

If you’ve spent any time tuning edge infrastructure or fighting the laws of physics over high-latency links, you’ve likely felt the pains of TCP. Head-of-line blocking, connection establishment handshakes that consume precious round-trip times (RTTs), and connection drops during network transitions (like switching from Wi-Fi to cellular) are fundamental limitations of the classic TCP stack.

Enter QUIC. Originally designed at Google and standardized as RFC 9000, QUIC moves transport layer intelligence up to user space on top of UDP. It integrates TLS 1.3 natively, multiplexes streams without head-of-line blocking, and tracks connections using explicit IDs rather than the IP/Port 4-tuple.

In this post, we’re going to look beyond the theoretical hype and build a fully functional, highly performant TCP-to-QUIC-to-TCP proxy in Go using `quic-go`. This pattern—wrapping legacy TCP traffic inside a QUIC tunnel for cross-datacenter or edge-to-cloud transport—is one of the most effective ways to lower latency and improve resilience without rewriting your upstream application code.

---

## Why QUIC Matters for Infrastructure Engineering

To appreciate why we’re building this proxy, we need to quickly review the architectural improvements QUIC brings over TCP + TLS 1.3:

1. **Zero-RTT Connection Establishment (0-RTT):** If a client has connected to the server before, it can send payload data in the very first packet, bypassing the standard 1-RTT or 2-RTT TCP+TLS handshake.
2. **Stream Multiplexing Without Head-of-Line Blocking:** In TCP, if a single packet in a stream is lost, the operating system pauses delivery for *all* logical streams until that packet is retransmitted. In QUIC, streams are independent at the transport layer. A dropped packet on Stream A does not stall Stream B.
3. **Connection Migration:** QUIC connections are identified by a 64-bit to 128-bit Connection ID, not the client's source IP and port. If a client switches networks, the QUIC connection survives seamlessly.
4. **User-Space Control:** Because QUIC runs over UDP in user space, you can fine-tune congestion control algorithms (like BBRv2) and loss recovery mechanisms without modifying kernel modules or waiting for host OS upgrades.

---

## Architecture: The QUIC Tunnel

Our goal is to build a low-latency proxy pair:

* **Local Ingress Proxy (Client):** Accepts plain TCP connections from upstream clients (e.g., microservices, database clients), wraps the byte streams into QUIC streams over a single multiplexed QUIC connection, and forwards them across the WAN.
* **Remote Egress Proxy (Server):** Terminates the QUIC connection, unpacks the individual QUIC streams, and proxies the raw payload data out to the target downstream TCP services.

```
+--------------------+        TCP        +-----------------------+
|  Application Client | ----------------> |  Local Ingress Proxy  |
+--------------------+                   +-----------------------+
                                                     |
                                                     | QUIC over UDP
                                                     | (Multiplexed)
                                                     v
+--------------------+        TCP        +-----------------------+
| Target Service     | <---------------- |  Remote Egress Proxy  |
+--------------------+                   +-----------------------+
```

---

## Step 1: Generating TLS Certificates for QUIC

Because TLS 1.3 is baked directly into QUIC, you cannot run a plain, unencrypted QUIC socket. For testing and internal proxy routing, we can generate a self-signed certificate with appropriate `KeyUsage` settings.

Here is a quick helper in Go to generate an in-memory `tls.Config`:

```go
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"time"
)

func generateTLSConfig() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"Internal Infrastructure"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}

	tlsCert := tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
	}

	return &tls.Config{
		Certificates: []tls.Certificate{tlsCert},
		NextProtos:   []string{"quic-proxy-demo"}, // ALPN identifier
	}, nil
}
```

---

## Step 2: Implementing the Remote Egress Server

The egress proxy listens for incoming QUIC connections on a UDP port. When a connection is established, it continuously accepts new *QUIC streams*. Each stream corresponds to a unique incoming TCP connection from the ingress side.

```go
package main

import (
	"context"
	"io"
	"log"
	"net"

	"github.com/quic-go/quic-go"
)

func runEgressServer(ctx context.Context, listenAddr string, targetTCPAddr string) error {
	tlsConfig, err := generateTLSConfig()
	if err != nil {
		return err
	}

	quicConfig := &quic.Config{
		EnableDatagrams: true,
		MaxIdleTimeout:  30 * time.Minute,
	}

	listener, err := quic.ListenAddr(listenAddr, tlsConfig, quicConfig)
	if err != nil {
		return err
	}
	defer listener.Close()

	log.Printf("[Egress] Listening for QUIC streams on %s, forwarding to TCP %s", listenAddr, targetTCPAddr)

	for {
		conn, err := listener.Accept(ctx)
		if err != nil {
			log.Printf("[Egress] Error accepting QUIC connection: %v", err)
			return err
		}

		go handleQUICConnection(ctx, conn, targetTCPAddr)
	}
}

func handleQUICConnection(ctx context.Context, conn quic.Connection, targetTCPAddr string) {
	defer conn.CloseWithError(0, "connection closed")

	for {
		// Accept individual multiplexed streams within the single QUIC connection
		stream, err := conn.AcceptStream(ctx)
		if err != nil {
			// Stream accept error generally means the connection was closed
			return
		}

		go handleQUICStream(stream, targetTCPAddr)
	}
}

func handleQUICStream(stream quic.Stream, targetTCPAddr string) {
	defer stream.Close()

	// Dial the actual upstream target service over TCP
	tcpConn, err := net.Dial("tcp", targetTCPAddr)
	if err != nil {
		log.Printf("[Egress] Failed to connect to TCP target %s: %v", targetTCPAddr, err)
		return
	}
	defer tcpConn.Close()

	// Bidirectional pipe between QUIC Stream and TCP Connection
	errChan := make(chan error, 2)

	go func() {
		_, err := io.Copy(tcpConn, stream)
		errChan <- err
	}()

	go func() {
		_, err := io.Copy(stream, tcpConn)
		errChan <- err
	}()

	// Wait for one side to close or fail
	<-errChan
}
```

---

## Step 3: Implementing the Local Ingress Client

The local ingress client listens on a standard TCP port (e.g., `:8080`). When local applications connect to it, it opens a stream on an active, long-lived QUIC session to the Egress Proxy and pipes the data across the wire.

```go
package main

import (
	"context"
	"crypto/tls"
	"io"
	"log"
	"net"

	"github.com/quic-go/quic-go"
)

func runIngressProxy(ctx context.Context, localTCPAddr string, remoteQUICAddr string) error {
	tlsConfig := &tls.Config{
		InsecureSkipVerify: true, // For self-signed certs in dev; use proper validation in prod
		NextProtos:         []string{"quic-proxy-demo"},
	}

	quicConfig := &quic.Config{
		MaxIdleTimeout: 30 * time.Minute,
	}

	log.Printf("[Ingress] Connecting to Remote QUIC Server at %s...", remoteQUICAddr)
	quicConn, err := quic.DialAddr(ctx, remoteQUICAddr, tlsConfig, quicConfig)
	if err != nil {
		return err
	}
	defer quicConn.CloseWithError(0, "client exit")

	listener, err := net.Listen("tcp", localTCPAddr)
	if err != nil {
		return err
	}
	defer listener.Close()

	log.Printf("[Ingress] Listening on local TCP %s", localTCPAddr)

	for {
		tcpConn, err := listener.Accept()
		if err != nil {
			log.Printf("[Ingress] TCP Accept error: %v", err)
			continue
		}

		go func(c net.Conn) {
			defer c.Close()

			// Open a new QUIC stream on the existing connection
			stream, err := quicConn.OpenStreamSync(ctx)
			if err != nil {
				log.Printf("[Ingress] Failed to open QUIC stream: %v", err)
				return
			}
			defer stream.Close()

			// Proxy data bidirectionally
			errChan := make(chan error, 2)

			go func() {
				_, err := io.Copy(stream, c)
				errChan <- err
			}()

			go func() {
				_, err := io.Copy(c, stream)
				errChan <- err
			}()

			<-errChan
		}(tcpConn)
	}
}
```

---

## Tuning for Performance in Production

When deploying QUIC tunnels at scale, standard UDP socket defaults in Linux will quickly hit limits. Here are the core tuning knobs you must adjust:

### 1. OS Buffer Sizes
By default, the Linux kernel sets conservative socket buffer caps. Under heavy QUIC throughput, packets will drop at the OS socket layer before reaching your Go runtime.

Set these via `sysctl`:

```bash
# Increase maximum receive and send socket buffer sizes
sysctl -w net.core.rmem_max=25000000
sysctl -w net.core.wmem_max=25000000
sysctl -w net.core.rmem_default=25000000
sysctl -w net.core.wmem_default=25000000
```

### 2. Stream and Connection Window Sizes
`quic-go` allows configuring connection-level and stream-level flow control windows. On high-bandwidth, high-latency links (e.g., cross-region AWS/GCP routing), defaults can severely throttle total bandwidth.

Update your `quic.Config`:

```go
quicConfig := &quic.Config{
    MaxInitialStreamReceiveWindow:     8 * 1024 * 1024,  // 8 MB
    MaxInitialConnectionReceiveWindow: 16 * 1024 * 1024, // 16 MB
    KeepAlivePeriod:                   10 * time.Second,
}
```

### 3. UDP Generic Segmentation Offload (GSO)
Ensure your deployment targets kernel versions 4.18+ to leverage UDP GSO. `quic-go` automatically attempts to use packet consolidation via GSO when supported by the network interface card (NIC). This drastically reduces CPU consumption by avoiding per-packet syscall overhead.

---

## Actionable Takeaways

1. **Multiplex to Avoid Head-of-Line Blocking:** If you are tunneling dozens of cross-datacenter connections over a single long-haul pipe, using a single QUIC connection with multiple streams prevents loss in one stream from stalling all others.
2. **Handle Reconnections Gracefully:** QUIC connections automatically handle transient underlying IP shifts, but long idle timeouts can still drop state. Configure client keepalives (`KeepAlivePeriod`) to ensure active state management through intermediate NAT gateways.
3. **Tune System Buffers:** High-throughput UDP requires aggressive kernel UDP receive buffer configuration (`net.core.rmem_max`). Neglecting this will manifest as mystery packet loss under high network load.

By wrapping legacy TCP workloads in custom Go-based QUIC tunnels, you gain modern TLS 1.3 encryption, reduced connection handshake overhead, and resilience against lossy WAN infrastructure—all without touching application layer code.