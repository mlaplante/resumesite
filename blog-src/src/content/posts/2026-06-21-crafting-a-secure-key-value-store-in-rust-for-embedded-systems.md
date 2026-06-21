---
title: "Crafting a Secure Key-Value Store in Rust for Embedded Systems"
date: 2026-06-21
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Embedded systems, by their very nature, often operate with stringent resource constraints. Limited memory, CPU cycles, and non-volatile storage are..."
---

# Crafting a Secure Key-Value Store in Rust for Embedded Systems

Embedded systems, by their very nature, often operate with stringent resource constraints. Limited memory, CPU cycles, and non-volatile storage are common challenges. When it comes to security, these constraints can make traditional database solutions or complex file systems impractical. Yet, many embedded applications require a robust, secure way to store configuration parameters, cryptographic keys, or small pieces of sensitive data persistently.

This is where a custom, lightweight key-value (KV) store, built with security in mind, becomes invaluable. Rust, with its memory safety guarantees, performance characteristics, and excellent tooling for embedded development, is an ideal language for this task.

## Why a Custom KV Store?

Before diving into the "how," let's briefly touch on the "why":

1.  **Resource Efficiency:** Off-the-shelf databases often have significant overhead. A custom solution can be tailored to use only the resources absolutely necessary.
2.  **Security Focus:** By controlling every aspect of the implementation, we can bake in security features like data integrity checks and encryption directly into the storage layer, rather than relying on external abstractions.
3.  **Portability:** A custom solution can be designed to run on various flash memory types (NOR, NAND) or even EEPROM, abstracting away hardware specifics.
4.  **Reliability:** We can implement robust wear-leveling and crash recovery mechanisms that are critical for embedded flash storage.

## Core Design Principles

Our secure KV store will adhere to a few core principles:

*   **Append-Only Log:** To minimize flash wear and simplify crash recovery, we'll use an append-only log structure. Updates to keys will write new entries, marking old ones as stale.
*   **Data Integrity:** Each entry will include a CRC or HMAC to detect corruption.
*   **Optional Encryption:** Sensitive values can be encrypted before writing.
*   **Wear Leveling:** We'll consider strategies to distribute writes evenly across flash blocks.
*   **Atomicity:** Operations should be atomic to prevent data loss or corruption during power loss.

## Building Blocks in Rust

Let's look at some Rust code snippets that illustrate the core components.

### 1. The Entry Structure

Each record in our KV store will be an `Entry`. This struct needs to contain enough information for us to manage it.

```rust
use crc::{Crc, CRC_32_ISO_HDLC}; // For data integrity
use aes_gcm::{Aes256Gcm, Key, Nonce}; // For encryption (optional)
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use core::fmt;

// A simple status to mark entries
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryStatus {
    Valid = 0x01,
    Stale = 0x02,
    Erased = 0x03, // For logical deletion, or marking a block as free
    Invalid = 0xFF, // Default for unwritten flash
}

impl TryFrom<u8> for EntryStatus {
    type Error = &'static str;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x01 => Ok(EntryStatus::Valid),
            0x02 => Ok(EntryStatus::Stale),
            0x03 => Ok(EntryStatus::Erased),
            0xFF => Ok(EntryStatus::Invalid),
            _ => Err("Invalid EntryStatus byte"),
        }
    }
}

// Header for each KV entry
#[repr(C, packed)] // Use packed for memory efficiency on embedded
pub struct EntryHeader {
    pub status: u8, // EntryStatus as u8
    pub key_len: u16,
    pub val_len: u16,
    pub crc32: u32, // CRC of key + value
    // Potential for a timestamp or sequence number for wear leveling/recovery
}

impl EntryHeader {
    pub const SIZE: usize = core::mem::size_of::<EntryHeader>();

    pub fn new(key_len: u16, val_len: u16, crc32: u32) -> Self {
        EntryHeader {
            status: EntryStatus::Valid as u8,
            key_len,
            val_len,
            crc32,
        }
    }

    pub fn is_valid(&self, expected_crc: u32) -> bool {
        self.status == EntryStatus::Valid as u8 && self.crc32 == expected_crc
    }
}

pub struct Entry<'a> {
    pub header: EntryHeader,
    pub key: &'a [u8],
    pub value: &'a [u8],
}
```

**Explanation:**

*   `EntryStatus`: A simple enum to manage the state of an entry. `Stale` is crucial for our append-only log.
*   `EntryHeader`: This struct is written directly to flash before the key and value. `#[repr(C, packed)]` ensures compatibility with C and reduces padding, which is vital for embedded systems.
*   `crc32`: We'll use a CRC-32 (e.g., ISO-HDLC variant) to ensure data integrity of the key and value. Any corruption during write or read can be detected.

### 2. The Flash Abstraction Layer

We need a trait to abstract away the underlying flash memory. This makes our KV store portable.

```rust
pub trait Flash {
    type Error: fmt::Debug;

    /// Read bytes from a specific address.
    fn read(&mut self, address: u32, data: &mut [u8]) -> Result<(), Self::Error>;

    /// Write bytes to a specific address.
    /// This typically can only change 1s to 0s.
    fn write(&mut self, address: u32, data: &[u8]) -> Result<(), Self::Error>;

    /// Erase a flash block starting at `block_address`.
    /// This sets all bytes in the block to 0xFF.
    fn erase_block(&mut self, block_address: u32) -> Result<(), Self::Error>;

    /// Get the total size of the flash in bytes.
    fn size(&self) -> u32;

    /// Get the size of an erasable block in bytes.
    fn block_size(&self) -> u32;

    /// Get the minimum write granularity (e.g., page size).
    fn write_granularity(&self) -> u32;

    /// Synchronize any pending writes to persistent storage.
    fn sync(&mut self) -> Result<(), Self::Error>;
}
```

**Explanation:**

*   This `Flash` trait defines the fundamental operations required: `read`, `write`, `erase_block`, and methods to query flash characteristics.
*   `erase_block` is critical because flash memory can only be written to by changing bits from 1 to 0. To change a 0 back to a 1, an entire block must be erased (reset to all 1s).

### 3. Implementing the KV Store Logic

Now, let's sketch out the `KeyValueStore` struct and some core methods.

```rust
use alloc::vec::Vec;
use alloc::boxed::Box;

const CRC_ALG: Crc<u32> = CRC_32_ISO_HDLC;

pub struct KeyValueStore<F: Flash> {
    flash: F,
    start_address: u32,
    end_address: u32,
    current_write_ptr: u32, // Pointer to the next available write location
    // Add encryption key management here if needed
    // cipher: Option<Aes256Gcm>,
    // nonce_counter: u64, // For unique nonces
}

impl<F: Flash> KeyValueStore<F> {
    pub fn new(mut flash: F, start_address: u32, end_address: u32) -> Result<Self, F::Error> {
        // Basic validation
        if start_address >= end_address || (end_address - start_address) % flash.block_size() != 0 {
            return Err("Invalid flash address range or alignment".into()); // Simplified error
        }

        let mut store = KeyValueStore {
            flash,
            start_address,
            end_address,
            current_write_ptr: start_address,
        };

        store.initialize()?; // Scan flash on startup to find current_write_ptr
        Ok(store)
    }

    /// Scans the flash to find the last valid entry and set `current_write_ptr`.
    fn initialize(&mut self) -> Result<(), F::Error> {
        let mut current_addr = self.start_address;
        let mut last_valid_ptr = self.start_address;

        while current_addr < self.end_address {
            let mut header_buf = [0u8; EntryHeader::SIZE];
            self.flash.read(current_addr, &mut header_buf)?;
            let header = unsafe {
                // Safety: Ensure header_buf is correctly aligned and sized for EntryHeader
                // In a real system, more robust deserialization would be used.
                core::ptr::read_unaligned(header_buf.as_ptr() as *const EntryHeader)
            };

            // Check if the block is erased (all 0xFFs)
            if header.status == EntryStatus::Invalid as u8 {
                // Found an erased or unwritten section. This is our write pointer.
                self.current_write_ptr = current_addr;
                return Ok(());
            }

            // If it's a valid or stale entry, skip its data to find the next header
            if header.status == EntryStatus::Valid as u8 || header.status == EntryStatus::Stale as u8 {
                let entry_data_len = header.key_len as u32 + header.val_len as u32;
                current_addr += EntryHeader::SIZE as u32 + entry_data_len;
                last_valid_ptr = current_addr; // Keep track of the furthest valid point
            } else {
                // Corrupted or unrecognized status, assume block is bad or needs cleaning
                // For now, we'll stop here and assume this is the end of valid data.
                // A more robust system would try to skip to the next block boundary.
                self.current_write_ptr = current_addr;
                return Ok(());
            }
        }
        self.current_write_ptr = last_valid_ptr; // If we scanned everything, point to the end
        Ok(())
    }

    /// Puts a key-value pair into the store.
    pub fn put(&mut self, key: &[u8], value: &[u8]) -> Result<(), F