---
title: "Crafting a Custom TLS Interception Proxy with eBPF for Deep Packet Inspection"
date: 2026-09-02
category: "thought-leadership"
tags: ["ebpf", "tls", "network-security", "deep-packet-inspection", "proxy", "network-engineering"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the realm of network security and observability, the ability to inspect encrypted traffic is a critical, yet often challenging, requirement. While..."
---

In the realm of network security and observability, the ability to inspect encrypted traffic is a critical, yet often challenging, requirement. While traditional proxies can perform TLS interception, they often involve user-space solutions that introduce latency and complexity, or require explicit trust configuration on clients. What if we could achieve deeper, more granular visibility into TLS handshakes and even application-layer data *without* a traditional proxy architecture, leveraging the power of eBPF?

This post explores the fascinating possibility of crafting a custom TLS interception proxy primarily driven by eBPF. Our goal isn't to build a production-ready MITM proxy (that's a whole other beast of trust and legal implications), but rather to demonstrate how eBPF can provide unprecedented visibility into the TLS stack, enabling sophisticated packet inspection and even selective interception capabilities.

## Why eBPF for TLS Interception?

Traditional TLS interception often involves:

1.  **User-Space Proxies:** Tools like Squid, Nginx, or specialized security gateways terminate TLS, inspect, and then re-encrypt. This works, but adds overhead and requires certificate trust on clients.
2.  **Network Taps/SPAN Ports:** Passive listening provides raw packets, but decrypting TLS without the private key is impossible.
3.  **Kernel Modules:** Historically, kernel modules could hook into network stack, but they are notoriously hard to write, debug, and maintain, and can destabilize the kernel.

eBPF offers a compelling alternative:

*   **Kernel-Native Performance:** eBPF programs run in the kernel, minimizing context switches and maximizing performance.
*   **Safe and Sandboxed:** Unlike kernel modules, eBPF programs are verified by the kernel and run in a sandboxed environment, preventing system crashes.
*   **Dynamic Hooking:** eBPF allows us to attach programs to various kernel tracepoints, kprobes (kernel function entry/exit), and user-space uprobes (user-space function entry/exit). This is key for TLS.
*   **Rich Context:** eBPF programs can access kernel data structures, providing deep insight into network packets, socket states, and even cryptographic operations.

## The Conceptual Architecture: eBPF-driven TLS Visibility

Our "proxy" won't be a traditional forwarding proxy. Instead, it will be a system for *observing and potentially manipulating* TLS traffic at a very low level, driven by eBPF.

Here's the high-level concept:

1.  **User-Space TLS Libraries (OpenSSL, GnuTLS):** Most applications use these libraries for TLS. These libraries perform the actual encryption/decryption.
2.  **eBPF Uprobes/Kprobes:** We'll attach eBPF programs to key functions within these libraries (e.g., `SSL_write`, `SSL_read`, `SSL_do_handshake`) or to kernel network functions (`tcp_sendmsg`, `tcp_recvmsg`).
3.  **Data Extraction:** The eBPF programs will extract relevant data:
    *   TLS handshake messages (ClientHello, ServerHello, Certificates).
    *   Pre-master secrets (if we want to decrypt later, requires specific library versions or patching).
    *   Application data being passed to/from `SSL_read`/`SSL_write`.
4.  **eBPF Maps:** Extracted data will be pushed into eBPF maps for retrieval by a user-space application.
5.  **User-Space Analysis:** A user-space application will read from the eBPF maps, reconstruct TLS sessions, and perform deep packet inspection.

### Key Challenges and Considerations

*   **Secret Extraction:** Decrypting TLS traffic requires session keys. These are typically derived from the pre-master secret. Extracting this secret from a running process without modifying the application or library is challenging. Some TLS libraries (like NSS) offer a `SSLKEYLOGFILE` mechanism. For others, we might need to hook into the key derivation functions or use specific eBPF tools like `openssl-keylog.py` from BCC.
*   **Performance Impact:** While eBPF is fast, attaching many uprobes/kprobes and copying large amounts of data to user space can introduce overhead. Careful design is needed.
*   **Dynamic Library Loading:** Applications might link TLS libraries dynamically. Uprobes need to be re-attached if libraries are unloaded/reloaded.
*   **Kernel/User-Space Communication:** Efficiently passing data from eBPF to user space is crucial. Ring buffers or perf buffers are ideal.

## A Practical Example: Observing TLS ClientHello with eBPF

Let's start with a simpler, yet powerful, demonstration: observing the TLS ClientHello message, which contains critical information like SNI (Server Name Indication) and supported cipher suites, *without* decrypting the entire session. This can be done by hooking into kernel network functions.

### The eBPF Program (Simplified `bpf_program.c`)

We'll use a `kprobe` on `tcp_sendmsg` to inspect outgoing TCP packets. We'll look for the TLS Handshake record type.

```c
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

// Define a struct to hold our extracted data
struct client_hello_info {
    u32 pid;
    u16 eth_proto;
    u16 ip_proto;
    u16 l4_proto;
    u16 dport;
    u16 sport;
    u32 saddr;
    u32 daddr;
    // Potentially add space for SNI or other ClientHello fields
    // For simplicity, we'll just indicate detection here.
};

// BPF map to send data to user-space
struct {
    __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
    __uint(key_size, sizeof(u32));
    __uint(value_size, sizeof(u32));
} events SEC(".maps");

// Helper to check if a buffer contains a TLS ClientHello
// This is a simplified check and might need refinement for robustness
static __always_inline bool is_tls_client_hello(const void *data, u32 len) {
    if (len < 5) return false; // Minimum TLS record header length
    const u8 *buf = data;
    // TLS Handshake (0x16)
    // Version (e.g., TLS 1.0 = 0x0301, TLS 1.2 = 0x0303)
    // Length (2 bytes)
    if (buf[0] == 0x16 && buf[1] == 0x03 && (buf[2] >= 0x01 && buf[2] <= 0x04)) {
        // Further check: Handshake Type Client Hello (0x01)
        // Offset 5 bytes into TLS record header, then 1 byte for handshake type
        if (len >= 6 && buf[5] == 0x01) {
            return true;
        }
    }
    return false;
}

SEC("kprobe/tcp_sendmsg")
int bpf_tcp_sendmsg(struct pt_regs *ctx) {
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    struct msghdr *msg = (struct msghdr *)PT_REGS_PARM2(ctx);
    size_t size = (size_t)PT_REGS_PARM3(ctx);

    if (!sk || !msg || size == 0) {
        return 0;
    }

    // Filter for IPv4 TCP sockets
    if (sk->__sk_common.skc_family != AF_INET || sk->__sk_common.skc_protocol != IPPROTO_TCP) {
        return 0;
    }

    struct client_hello_info info = {};
    info.pid = bpf_get_current_pid_tgid() >> 32;
    info.saddr = sk->__sk_common.skc_rcv_saddr; // Local address
    info.daddr = sk->__sk_common.skc_daddr;   // Remote address
    info.sport = sk->__sk_common.skc_num;
    info.dport = bpf_ntohs(sk->__sk_common.skc_dport); // dport is in network byte order

    // Access the scatterlist for the message data
    struct iov_iter *iter = &msg->msg_iter;
    if (!iter || iter->iov_offset >= iter->count) {
        return 0; // No data or invalid iterator
    }

    // Try to read the first few bytes directly from the first iovec
    // This is a simplification; a full implementation might need to iterate iovs
    struct iovec iov;
    // bpf_probe_read_kernel needs to be used carefully with iov_iter
    // For simplicity, let's assume direct access to the first iovec for small data
    // A robust solution would involve iterating through the iov_iter
    // For demonstration, we'll try to read a small chunk
    if (bpf_probe_read_kernel(&iov, sizeof(iov), &iter->iov) != 0) {
        return 0;
    }

    char buf[128]; // Max size to read for initial check
    u32 read_len = (iov.iov_len < sizeof(buf)) ? iov.iov_len : sizeof(buf);
    if (read_len > size) read_len = size; // Don't read more than actual msg size

    if (bpf_probe_read_kernel(&buf, read_len, iov.iov_base) != 0) {
        return 0;
    }

    if (is_tls_client_hello(buf, read_len)) {
        bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &info, sizeof(info));
    }

    return 0;
}
```

### The User-Space Loader (`main.go` using `cilium/ebpf`)

```go
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/perf"
	"golang.org/x/sys/unix"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall" bpf bpf_program.c -- -I/usr/include/bpf

type clientHelloInfo struct {
	Pid      uint32
	EthProto uint16
	IPProto  uint16
	L4Proto  uint16
	Dport    uint16
	Sport    uint16
	Saddr    uint32
	Daddr    uint32
}

func main() {
	objs := bpfObjects{}
	if err := loadBpfObjects(&objs, nil); err != nil {
		log.Fatalf("loading eBPF objects: %v", err)
	}
	defer objs.Close()

	kp, err := link.Kprobe("tcp_sendmsg", objs.bpfPrograms.BpfTcpSendmsg, nil)
	if err != nil {
		log.Fatalf("attaching kprobe: %v", err)
	}
	defer kp.Close()

	rd, err := perf.NewReader(objs.bpfMaps.Events, os.Getpagesize())
	if err != nil {
		log.Fatalf("creating perf event reader: %v", err)
	}
	defer rd.Close()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		rd.Close()
	}()

	fmt.Println("Listening for TLS ClientHello messages... (Ctrl-C to stop)")
	for {
		record, err := rd.Read()
		if err != nil {
			log.Printf("reading from perf reader: %v", err)
			return
		}
		if record.LostSamples != 0 {
			log.Printf("perf ring buffer full, dropped %d samples", record.LostSamples)
			continue
		}

		var info clientHelloInfo
		if err := binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &info); err != nil {
			log.Printf("parsing perf event: %v", err)
			continue
		}

		src := net.IPv4(byte(info.Saddr), byte(info.Saddr>>8), byte(info.Saddr>>16), byte(info.Saddr>>24))
		dst := net.IPv4(byte(info.Daddr), byte(info.Daddr>>8), byte(info.Daddr>>16), byte(info.Daddr>>24))
		fmt.Printf("[pid %d] ClientHello observed: %s:%d -> %s:%d\n", info.Pid, src, info.Sport, dst, info.Dport)
	}
}
```

A few notes on this code before moving on. `bpf2go` generates `loadBpfObjects` and the `bpfObjects` struct (with `bpfPrograms` and `bpfMaps` sub-structs) from the C source at build time, so the Go and C sides stay in lockstep without hand-written CO-RE loading boilerplate. `link.Kprobe` attaches our `bpf_tcp_sendmsg` program to the live kernel function by symbol name, and `perf.NewReader` gives us a blocking, per-CPU-buffered channel for pulling `client_hello_info` structs out of the `BPF_MAP_TYPE_PERF_EVENT_ARRAY` we defined earlier. In a real deployment you'd also want to handle kprobe attach failures gracefully across kernel versions, since `tcp_sendmsg`'s exact signature has shifted between LTS releases — this is one of the reasons CO-RE (Compile Once, Run Everywhere) and `vmlinux.h` matter so much for portability.

### Limitations of the ClientHello-Only Approach

This gets us SNI and cipher-suite visibility essentially for free, without touching the TLS session at all, but it's worth being honest about what it doesn't give us:

*   **TCP segmentation:** A single call to `tcp_sendmsg` doesn't guarantee we see a complete TLS record. Large ClientHello messages (common with many cipher suites, extensions, and ALPN entries) can be split across multiple sends or coalesced by the socket buffer, so a production implementation needs to track partial records per-socket rather than assuming one probe hit equals one full handshake message.
*   **TLS 1.3 encrypts more of the handshake:** Only the ClientHello and ServerHello remain in the clear in TLS 1.3; Certificate and Finished messages are encrypted immediately after the key exchange. SNI is still visible here (unless Encrypted Client Hello is in play), but this technique alone won't get you certificate details or application data.
*   **No decryption:** As the name implies, this is pure metadata observation. Getting to plaintext application data requires a fundamentally different hook point.

## Extending to Full Plaintext Capture: Hooking `SSL_write`/`SSL_read`

If the goal is genuine deep packet inspection of application-layer data — not just handshake metadata — the trick is to stop fighting the encryption at the network layer entirely and instead hook the TLS library *after* it has already decrypted (on read) or *before* it has encrypted (on write). This is precisely how tools like BCC's `sslsniff` and eBPF-based observability agents such as Pixie work.

The approach uses uprobes/uretprobes on the user-space OpenSSL library rather than kprobes on the kernel network stack:

*   **`uprobe` on `SSL_write`:** Attached at function entry, this gives us the `SSL *` context pointer and the plaintext `buf`/`num` arguments — the exact bytes the application is about to hand off for encryption, read directly via `bpf_probe_read_user`.
*   **`uprobe` on `SSL_read` (entry):** At entry, `SSL_read` hasn't populated its output buffer yet, so we stash the buffer pointer (keyed by PID/TID) in a `BPF_MAP_TYPE_HASH` scratch map for the matching `uretprobe` to pick up.
*   **`uretprobe` on `SSL_read` (return):** By the time `SSL_read` returns, OpenSSL has already decrypted the data into the caller's buffer and the return value tells us how many bytes were written. We look up the buffer pointer we stashed at entry and read that many bytes back out with `bpf_probe_read_user`.

Correlating the `SSL *` pointer to a specific TCP socket (and therefore back to the metadata we captured from `tcp_sendmsg`) typically means also hooking `SSL_set_fd` or walking the `SSL` struct's underlying BIO, which is fragile across OpenSSL versions — another good argument for pairing this with `vmlinux.h`-style CO-RE relocations and per-library offset tables rather than hardcoded struct layouts.

## Conclusion

None of this amounts to a drop-in replacement for a traditional MITM proxy, and it isn't meant to — the value of the eBPF approach is that it gets you handshake and even application-layer visibility without terminating TLS, without distributing a CA certificate to every client, and without the latency of a user-space forwarding hop. The tradeoff is real engineering cost: kernel-version sensitivity on the kprobe side, library-version sensitivity on the uprobe side, and the ongoing burden of correlating multiple independent probe sources into one coherent session view. For security teams that need deep, low-overhead visibility into what's actually crossing the wire inside a Kubernetes cluster or a service mesh, though, this is exactly the kind of primitive worth building toward.