---
title: "Crafting a Custom x86-64 Disassembler in Rust for Binary Analysis and Security Audits"
date: 2026-09-15
category: "thought-leadership"
tags: ["rust", "x86-64", "disassembler", "binary-analysis", "security-audits", "reverse-engineering"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As security professionals and binary analysts, we often find ourselves needing to peek under the hood of compiled code. While commercial tools like..."
---

As security professionals and binary analysts, we often find ourselves needing to peek under the hood of compiled code. While commercial tools like IDA Pro and Ghidra are indispensable, understanding the fundamental mechanics of disassembly—and even building a custom one—offers unparalleled insight, flexibility, and a deep appreciation for the instruction set architecture (ISA). This post will explore the journey of crafting a basic x86-64 disassembler in Rust, highlighting its benefits for security audits and custom analysis tasks.

## Why Build Your Own?

"Why reinvent the wheel?" you might ask. Here's why:

1.  **Deep Understanding:** The process of parsing opcodes, decoding operands, and understanding instruction prefixes forces a granular understanding of the x86-64 ISA. This knowledge is invaluable when interpreting output from other tools or debugging complex exploits.
2.  **Custom Analysis:** Off-the-shelf disassemblers are general-purpose. A custom tool can be tailored for specific tasks:
    *   **Vulnerability Scanning:** Quickly identify specific instruction patterns (e.g., `ret` instructions after a `call` to a specific library function, or `syscall` instruction sequences).
    *   **Malware Analysis:** Extracting control flow graphs for specific functions, or identifying obfuscation techniques not easily detected by generic tools.
    *   **Firmware Analysis:** Disassembling bootloaders or embedded code where standard tools might struggle with memory maps or unusual binaries.
3.  **Educational Value:** It's a fantastic learning exercise in low-level programming, bit manipulation, and compiler/architecture theory.
4.  **Rust's Advantages:** Rust's strong type system, memory safety, and performance make it an excellent choice for systems programming tasks like this, reducing common pitfalls associated with C/C++ in binary parsing.

## The x86-64 Instruction Format: A Quick Primer

Before diving into code, let's briefly recap the x86-64 instruction format. It's notoriously complex due to its variable-length nature and historical baggage. A typical instruction can include:

*   **Prefixes (0-4 bytes):** Modifiers for operand size, address size, segment override, REX prefix (for 64-bit specific registers/extensions).
*   **Opcode (1-3 bytes):** The core instruction identifier.
*   **ModR/M Byte (1 byte):** If present, specifies addressing modes, register operands, and potentially extends the opcode.
*   **SIB Byte (1 byte):** If present (after ModR/M), specifies scaled-index-base addressing.
*   **Displacement (1, 2, or 4 bytes):** An offset used in memory addressing.
*   **Immediate (1, 2, 4, or 8 bytes):** A constant value directly embedded in the instruction.

The challenge lies in determining which of these components are present and how they interact.

## Building Blocks in Rust

Let's outline the core components of our disassembler. We'll focus on a very simplified example to illustrate the concepts.

### 1. Reading the Binary

First, we need to read the raw bytes of our target binary.

```rust
use std::fs::File;
use std::io::{self, Read};

fn read_binary(path: &str) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    Ok(buffer)
}

// Example usage:
// let binary_data = read_binary("path/to/my/binary").expect("Failed to read binary");
```

### 2. Representing an Instruction

We need a structure to hold the decoded instruction's components.

```rust
#[derive(Debug)]
pub enum Operand {
    Register(String),
    Immediate(u64),
    Memory(String), // Simplified for now
    None,
}

#[derive(Debug)]
pub struct Instruction {
    pub address: u64,
    pub bytes: Vec<u8>,
    pub mnemonic: String,
    pub operands: Vec<Operand>,
    pub length: usize,
}
```

### 3. The Disassembly Loop

The core of the disassembler is a loop that iterates through the binary data, attempts to decode one instruction at a time, and then advances the program counter.

```rust
pub fn disassemble(data: &[u8], base_address: u64) -> Vec<Instruction> {
    let mut instructions = Vec::new();
    let mut offset: usize = 0;

    while offset < data.len() {
        // Attempt to decode a single instruction
        match decode_instruction(&data[offset..], base_address + offset as u64) {
            Some(instr) => {
                offset += instr.length;
                instructions.push(instr);
            }
            None => {
                // If decoding fails, we might have invalid data or hit a data section.
                // For a simple disassembler, we'll just advance by 1 byte and try again.
                // A real disassembler would try to recover more intelligently.
                println!("Warning: Failed to decode instruction at {:x}. Skipping byte.", base_address + offset as u64);
                offset += 1;
            }
        }
    }
    instructions
}
```

### 4. Decoding a Single Instruction (Simplified Example: `NOP` and `RET`)

This is where the complexity lies. We need a lookup table for opcodes and logic to parse prefixes, ModR/M, SIB, displacement, and immediate values. For demonstration, let's just implement `NOP` (0x90) and `RET` (0xC3).

```rust
// A very simplified mapping of 1-byte opcodes
const OPCODE_MAP: [(u8, &str); 2] = [
    (0x90, "NOP"),
    (0xC3, "RET"),
];

fn decode_instruction(data: &[u8], address: u64) -> Option<Instruction> {
    if data.is_empty() {
        return None;
    }

    let first_byte = data[0];

    for (opcode, mnemonic) in &OPCODE_MAP {
        if first_byte == *opcode {
            return Some(Instruction {
                address,
                bytes: vec![first_byte],
                mnemonic: mnemonic.to_string(),
                operands: vec![],
                length: 1, // Both NOP and RET are 1 byte long
            });
        }
    }

    // Placeholder for more complex decoding
    // For now, if we don't recognize it, return None
    None
}
```

### 5. Adding More Instructions and Complexity

To make this useful, we'd need:

*   **REX Prefix Handling:** For 64-bit registers (R8-R15), extended operand sizes.
*   **ModR/M Byte Parsing:** Crucial for determining operands (register-to-register, register-to-memory, memory-to-register). This byte encodes three fields: `mod` (2 bits), `reg` (3 bits), `rm` (3 bits).
*   **SIB Byte Parsing:** For more complex memory addressing (e.g., `[base + index*scale + displacement]`).
*   **Displacement and Immediate Parsing:** Extracting these variable-length values.
*   **Opcode Tables:** Comprehensive tables for 1-byte, 2-byte (0x0F prefix), and 3-byte opcodes.
*   **Operand Decoding:** Mapping register IDs (0-7) to names (RAX, RCX, RDX, RBX, RSP, RBP, RSI, RDI) and handling REX-extended registers.

A more robust `decode_instruction` might look like this (conceptual, not runnable):

```rust
// fn decode_instruction(data: &[u8], address: u64) -> Option<Instruction> {
//     let mut current_offset = 0;
//     let mut prefixes = Vec::new();
//
//     // 1. Parse prefixes (up to 4 bytes)
//     while is_prefix(data[current_offset]) {
//         prefixes.push(data[current_offset]);
//         current_offset += 1;
//     }
//
//     // 2. Parse REX prefix (if present, usually after other prefixes)
//     let rex_prefix = prefixes.iter().find(|&&p| (p & 0xF0) == 0x40);
//
//     // 3. Parse Opcode (1-3 bytes)
//     let opcode_byte = data[current_offset];
//     current_offset += 1;
//     // ... logic for 2-byte opcodes (0x0F prefix)
//
//     // 4. Parse ModR/M byte (if required by opcode)
//     let modrm_byte = data[current_offset];
//     current_offset += 1;
//     // ... extract mod, reg, rm fields
//
//     // 5. Parse SIB byte (if required by ModR/M)
//     let sib_byte = data[current_offset];
//     current_offset += 1;
//
//     // 6. Parse Displacement (if required)
//     // ...
//
//     // 7. Parse Immediate (if required)
//     // ...
//
//     // Construct instruction using parsed components
//     // Map opcode to mnemonic, decode operands based on ModR/M, SIB, etc.
//     // Return Some(Instruction { ... })
// }
```

This conceptual flow highlights the stateful parsing required. You'd need extensive match statements and helper functions for each component.

## Practical Applications for Security Audits

Once you have even a basic disassembler, its utility for security audits becomes apparent:

*   **Quick Patch Analysis:** Disassemble a patched binary and compare it to an unpatched one to quickly identify changes at the instruction level, which can reveal the nature of a security fix.
*   **Shellcode Analysis:** Disassemble raw shellcode (which often lacks standard ELF/PE headers) to understand its functionality without relying on external tools.
*   **Custom Gadget Finders:** For ROP (Return-Oriented Programming) exploitation, a custom disassembler can be extended to quickly scan for specific instruction sequences (gadgets) ending in `ret`.
*   **Identifying Obfuscation:** Look for unusual instruction sequences, self-modifying code patterns, or anti-disassembly tricks.
*   **Firmware Vulnerability Discovery:** Analyze embedded firmware where traditional debugging tools might be unavailable or difficult to set up. You can pinpoint specific function