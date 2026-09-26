---
title: "Crafting a Secure DNS-over-HTTPS (DoH) Proxy in Go"
date: 2026-09-26
category: "thought-leadership"
tags: ["golang", "security", "dns", "doh", "proxy", "networking"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In today's interconnected world, privacy and security are paramount. While much attention is paid to encrypting application traffic with TLS, a..."
---

In today's interconnected world, privacy and security are paramount. While much attention is paid to encrypting application traffic with TLS, a critical component often overlooked is DNS. Traditional DNS queries are sent in plain text, making them susceptible to eavesdropping, manipulation, and censorship. DNS-over-HTTPS (DoH) offers a robust solution by encrypting DNS traffic over HTTPS, blending it with regular web traffic and making it harder to distinguish and block.

While many clients now support DoH directly, there are scenarios where a centralized, custom DoH proxy can be incredibly valuable. Perhaps you're managing a fleet of legacy devices, want to enforce specific DNS policies, or simply desire a transparent DoH layer for your internal network. In this post, we'll walk through building a simple yet effective DoH proxy in Go, demonstrating how to secure your DNS resolution.

## Why Go for a DoH Proxy?

Go is an excellent choice for network services due to its strong concurrency primitives (goroutines and channels), robust standard library, and excellent performance characteristics. Its built-in `net/http` and `crypto/tls` packages make handling HTTPS traffic straightforward, while `github.com/miekg/dns` provides an industry-standard library for DNS message manipulation.

## Core Components of Our DoH Proxy

Our DoH proxy will perform the following steps:

1.  **Listen for incoming DNS queries:** We'll primarily focus on UDP port 53 for traditional DNS queries, but extending it to TCP is a minor change.
2.  **Parse the DNS query:** Extract the domain name and query type.
3.  **Construct a DoH request:** Format the DNS query into an HTTPS GET request.
4.  **Send the DoH request to an upstream resolver:** We'll use a public DoH resolver like Cloudflare or Google.
5.  **Receive and parse the DoH response:** Extract the DNS response.
6.  **Send the DNS response back to the client:** Relay the answer over UDP.

Let's dive into the code.

## Setting Up the Project

First, initialize a new Go module:

```bash
mkdir doh-proxy && cd doh-proxy
go mod init doh-proxy
```

## The DoH Client Component

We'll start by creating a function that takes a raw DNS message (as bytes) and sends it to an upstream DoH resolver, returning the raw DNS response.

```go
// dohclient/dohclient.go
package dohclient

import (
	"bytes"
	"fmt"
	"io/ioutil"
	"net/http"
	"time"

	"github.com/miekg/dns"
)

// DoHClient represents a client for making DoH requests.
type DoHClient struct {
	UpstreamURL string
	HTTPClient  *http.Client
}

// NewDoHClient creates a new DoHClient with a specified upstream URL.
func NewDoHClient(upstreamURL string) *DoHClient {
	return &DoHClient{
		UpstreamURL: upstreamURL,
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second, // Sensible timeout for DNS queries
		},
	}
}

// Resolve sends a raw DNS message to the upstream DoH resolver and returns the raw DNS response.
func (c *DoHClient) Resolve(queryMsg []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, c.UpstreamURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create HTTP request: %w", err)
	}

	// Set the DoH specific headers
	req.Header.Set("Accept", "application/dns-message")
	req.Header.Set("Content-Type", "application/dns-message")

	// Encode the DNS query message for the URL
	// DoH uses base64url encoding for the dns parameter
	// For GET requests, the DNS message is base64url encoded and appended to the URL.
	// We'll use a simple approach here for demonstration, typically it's part of the URL query param.
	// For true DoH GET, the query is appended as ?dns=<base64url(query_message)>
	// For simplicity and broader compatibility, many implementations use POST for DoH,
	// but GET is also specified. Let's adapt this to use POST for easier handling of the message body.
	// Re-evaluating: The RFC 8484 specifies both GET and POST.
	// For GET, the DNS message is base64url-encoded and passed in the 'dns' query parameter.
	// For POST, the DNS message is sent directly as the request body with Content-Type: application/dns-message.
	// POST is often simpler to implement when dealing with arbitrary DNS message sizes.
	// Let's switch to POST for cleaner implementation.

	req, err = http.NewRequest(http.MethodPost, c.UpstreamURL, bytes.NewReader(queryMsg))
	if err != nil {
		return nil, fmt.Errorf("failed to create HTTP POST request: %w", err)
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message") // Indicate we accept DNS messages back

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send DoH request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream DoH resolver returned non-OK status: %d", resp.StatusCode)
	}

	responseBody, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read DoH response body: %w", err)
	}

	return responseBody, nil
}
```

**Note on GET vs. POST:** I initially considered GET, but for simplicity and robustness with varying DNS query sizes, POST is often preferred for DoH implementations. The `Content-Type: application/dns-message` header is crucial.

## The UDP DNS Proxy Server

Now we'll build the UDP server that listens for traditional DNS queries and uses our `DoHClient` to resolve them.

```go
// main.go
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"time"

	"doh-proxy/dohclient" // Our custom DoH client package
	"github.com/miekg/dns"
)

const (
	listenAddr  = ":53" // Listen on UDP port 53
	upstreamDoH = "https://cloudflare-dns.com/dns-query" // Cloudflare's DoH endpoint
)

func main() {
	// Initialize our DoH client
	doHClient := dohclient.NewDoHClient(upstreamDoH)

	// Create a UDP listener
	addr, err := net.ResolveUDPAddr("udp", listenAddr)
	if err != nil {
		log.Fatalf("Failed to resolve UDP address: %v", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatalf("Failed to listen on UDP: %v", err)
	}
	defer conn.Close()

	log.Printf("DoH proxy listening on %s, upstream: %s", listenAddr, upstreamDoH)

	buffer := make([]byte, 2048) // Standard DNS UDP packet size limit is 512, but modern DNS uses EDNS0 for larger
	for {
		n, clientAddr, err := conn.ReadFromUDP(buffer)
		if err != nil {
			log.Printf("Error reading from UDP: %v", err)
			continue
		}

		// Process the DNS query in a goroutine to handle concurrent requests
		go handleDNSQuery(conn, clientAddr, buffer[:n], doHClient)
	}
}

func handleDNSQuery(conn *net.UDPConn, clientAddr *net.UDPAddr, queryData []byte, doHClient *dohclient.DoHClient) {
	// Parse the incoming DNS query
	var msg dns.Msg
	if err := msg.Unpack(queryData); err != nil {
		log.Printf("Failed to unpack DNS query from %s: %v", clientAddr, err)
		return
	}

	if len(msg.Question) == 0 {
		log.Printf("Received DNS query with no questions from %s", clientAddr)
		return
	}

	// Log the query for debugging
	log.Printf("Received query for %s (Type %s) from %s", msg.Question[0].Name, dns.Type(msg.Question[0].Qtype), clientAddr)

	// Resolve the query using our DoH client
	dohResponse, err := doHClient.Resolve(queryData) // Pass the original query data directly
	if err != nil {
		log.Printf("Failed to resolve DoH query for %s: %v", msg.Question[0].Name, err)
		// Send a SERVFAIL response back to the client
		sendErrorResponse(conn, clientAddr, &msg, dns.RcodeServerFailure)
		return
	}

	// Send the DoH response back to the original DNS client
	_, err = conn.WriteToUDP(dohResponse, clientAddr)
	if err != nil {
		log.Printf("Failed to write DoH response to %s: %v", clientAddr, err)
	}
}

// sendErrorResponse crafts and sends a DNS error response.
func sendErrorResponse(conn *net.UDPConn, clientAddr *net.UDPAddr, originalQuery *dns.Msg, rcode int) {
	m := new(dns.Msg)
	m.SetRcode(originalQuery, rcode)
	out, err := m.Pack()
	if err != nil {
		log.Printf("Failed to pack error response: %v", err)
		return
	}
	_, err = conn.WriteToUDP(out, clientAddr)
	if err != nil {
		log.Printf("Failed to write error response to %s: %v", clientAddr, err)
	}
}
```

## Running and Testing

To run the proxy:

```bash
go run .
```

You should see output similar to: `DoH proxy listening on :53, upstream: https://cloudflare-dns.com/dns-query`

Now, you can test it by configuring your system's DNS to point to the IP address where your proxy is running (e.g., `127.0.0.1` if running locally).

**On Linux/macOS:**

```bash
dig @127.0.0.1 google.com
```

You should see the DNS resolution working, and in your proxy's logs, you'll see the query being processed.

## Enhancements and Considerations

This basic proxy provides a solid foundation. Here are several enhancements you might consider for a production-ready system:

*   **Error Handling and Resilience:** More robust error handling, including retries to multiple upstream DoH servers.
*   **Caching:** Implement a local DNS cache to reduce latency and load on upstream resolvers. Go's `sync.Map` or a simple `map` with a `sync.Mutex` for expiry can work.
*   **Configuration:** Use command-line flags or a configuration file (e.g., `viper`) for `listenAddr` and `upstreamDoH`.
*   **Logging:** Integrate with a structured logging library like `zap` or `logrus` for better observability.
*   **Metrics:** Expose Prometheus metrics for query counts, error rates, and latency.
*   **Rate Limiting:** Protect against abuse or misconfigured clients by rate-limiting DNS queries.
*   **Security:**
    *   **ACLs:** Implement access control lists to restrict which IP addresses can use the proxy.
    *   **TLS Client Authentication:** If you're using a private DoH resolver, you might need client certificates.
    *   **DNSSEC Validation:** While DoH encrypts the transport, it doesn't inherently validate the DNS records. You could add DNSSEC validation to your proxy if your upstream doesn't guarantee it.
*   **TCP Support:** Extend the proxy to also listen on TCP port 53 for larger DNS responses or clients that prefer TCP. The `net.ListenTCP` and `conn.Read` / `conn.Write` patterns are similar.
*   **HTTP/2 for DoH:** The `net/http` client in Go automatically supports HTTP/2, which is often used by DoH providers for better performance.

## Conclusion

Building a DoH proxy in Go is a practical way to enhance the privacy and security of your DNS resolution. By encrypting your DNS queries, you add a significant layer of protection against surveillance and tampering. The Go ecosystem, with its strong networking capabilities and excellent third-party libraries like `miekg/dns`, makes this a straightforward and rewarding engineering task. This project serves as a great starting point for anyone looking to deepen their understanding of network programming, DNS, and secure communication practices.