---
title: "Building a Custom FIDO2 Authenticator with Rust and WebAuthn"
date: 2026-06-18
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As security professionals, we're constantly evaluating and implementing stronger authentication mechanisms. FIDO2, built upon the WebAuthn standard,..."
---

# Building a Custom FIDO2 Authenticator with Rust and WebAuthn

As security professionals, we're constantly evaluating and implementing stronger authentication mechanisms. FIDO2, built upon the WebAuthn standard, represents a significant leap forward, offering phishing-resistant, cryptographically secure authentication. While hardware authenticators are widely available, understanding the underlying mechanics by building a custom one can provide invaluable insight and open doors for specialized applications.

In this post, we'll explore the journey of implementing a basic FIDO2 authenticator using Rust. Rust's memory safety, performance, and strong type system make it an excellent choice for security-critical applications like this. We won't build a full production-ready device, but rather a conceptual framework that demonstrates the core interactions.

## The WebAuthn Handshake: A Quick Recap

Before diving into code, let's briefly refresh our understanding of the WebAuthn client-side flow:

1.  **Registration (Credential Creation):**
    *   The Relying Party (RP) sends a `PublicKeyCredentialCreationOptions` challenge to the browser.
    *   The browser relays this to the authenticator.
    *   The authenticator generates a new key pair (private key stored internally, public key returned).
    *   The authenticator signs an attestation statement, confirming its authenticity.
    *   The browser sends the `PublicKeyCredential` (containing the public key, attestation, and other metadata) back to the RP.

2.  **Authentication (Credential Assertion):**
    *   The RP sends a `PublicKeyCredentialRequestOptions` challenge to the browser.
    *   The browser relays this to the authenticator, specifying which credentials (via `credentialId`s) it can use.
    *   The authenticator uses its stored private key to sign the challenge.
    *   The browser sends the `AuthenticatorAssertionResponse` (containing the signature, authenticator data, and client data) back to the RP.

Our custom authenticator will focus on responding to these requests.

## Architecture of Our Rust Authenticator

For simplicity, our authenticator will:

*   **Simulate a USB HID interface:** We'll use a local TCP or Unix socket for communication, mimicking the structured requests and responses of CTAP2 over HID.
*   **Manage keys in memory:** For a real device, this would involve secure element interaction or persistent storage.
*   **Implement core CTAP2 commands:** Specifically, `authenticatorMakeCredential` and `authenticatorGetAssertion`.

## Setting Up the Rust Project

First, create a new Rust project:

```bash
cargo new --bin fido2-rust-authenticator
cd fido2-rust-authenticator
```

Add necessary dependencies to `Cargo.toml`. We'll need cryptographic primitives, serialization, and potentially a networking library.

```toml
[dependencies]
# For cryptographic operations (e.g., ECDSA, SHA256)
p256 = { version = "0.11", features = ["ecdsa"] }
sha2 = "0.10"
rand_core = { version = "0.6", features = ["std"] }
base64 = "0.21"

# For CBOR serialization (CTAP2 uses CBOR)
cbor = "0.5" # A simple CBOR library

# For byte manipulation
byteorder = "1.4"

# For simulating the transport
tokio = { version = "1", features = ["full"] } # Or just standard library networking
```

## Core Components: Key Management and CTAP2 Commands

### 1. Key Management

Our authenticator needs to generate and store key pairs. For FIDO2, ECDSA with the P-256 curve (secp256r1) is common.

```rust
// src/key_management.rs
use p256::ecdsa::{SigningKey, VerifyingKey, Signature, signature::Signer};
use p256::elliptic_curve::SecretKey;
use p256::NistP256;
use rand_core::OsRng;
use sha2::{Sha256, Digest};

#[derive(Debug, Clone)]
pub struct Credential {
    pub rp_id: String,
    pub user_id: Vec<u8>,
    pub credential_id: Vec<u8>,
    pub signing_key: SigningKey<NistP256>,
    pub verifying_key: VerifyingKey<NistP256>,
    pub counter: u32,
}

impl Credential {
    pub fn new(rp_id: String, user_id: Vec<u8>, credential_id: Vec<u8>) -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        let verifying_key = VerifyingKey::from(&signing_key);
        Credential {
            rp_id,
            user_id,
            credential_id,
            signing_key,
            verifying_key,
            counter: 0,
        }
    }

    pub fn sign(&mut self, data: &[u8]) -> Signature {
        self.counter += 1; // Increment counter on each use
        self.signing_key.sign(data)
    }

    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.verifying_key.to_encoded_point(false).as_bytes().to_vec()
    }
}
```

### 2. Simulating CTAP2 Command Processing

CTAP2 commands are typically sent as CBOR-encoded messages. We'll need to deserialize incoming requests and serialize responses.

Let's define a simplified `Authenticator` struct that holds our credentials.

```rust
// src/authenticator.rs
use std::collections::HashMap;
use crate::key_management::{Credential, self};
use sha2::{Sha256, Digest};
use byteorder::{BigEndian, WriteBytesExt};

pub struct Authenticator {
    credentials: HashMap<Vec<u8>, Credential>, // Map credential_id to Credential
    // Other authenticator state (e.g., AAGUID, attestation key)
    aaguid: [u8; 16],
    attestation_signing_key: SigningKey<NistP256>,
    attestation_verifying_key: VerifyingKey<NistP256>,
}

impl Authenticator {
    pub fn new() -> Self {
        let aaguid = [0x01; 16]; // Example AAGUID
        let attestation_signing_key = SigningKey::random(&mut OsRng);
        let attestation_verifying_key = VerifyingKey::from(&attestation_signing_key);

        Authenticator {
            credentials: HashMap::new(),
            aaguid,
            attestation_signing_key,
            attestation_verifying_key,
        }
    }

    // Simplified `authenticatorMakeCredential`
    pub fn make_credential(
        &mut self,
        rp_id: &str,
        user_id: &[u8],
        client_data_hash: &[u8],
    ) -> Result<cbor::Value, String> {
        // In a real scenario, credential_id would be random or derived
        let credential_id = Sha256::digest([rp_id.as_bytes(), user_id].concat()).to_vec();

        if self.credentials.contains_key(&credential_id) {
            return Err("Credential already exists for this RP/User".to_string());
        }

        let new_credential = Credential::new(rp_id.to_string(), user_id.to_vec(), credential_id.clone());
        let public_key_bytes = new_credential.public_key_bytes();

        self.credentials.insert(credential_id.clone(), new_credential);
        let credential = self.credentials.get(&credential_id).unwrap(); // Get immutable ref

        // Construct authenticator data
        let mut auth_data = Vec::new();
        auth_data.extend_from_slice(&self.aaguid); // AAGUID
        auth_data.push(0x41); // Flags: UP (User Present), AT (Attested Credential Data)
        auth_data.write_u32::<BigEndian>(credential.counter).unwrap(); // Signature Counter

        // RP ID hash
        let rp_id_hash = Sha256::digest(rp_id.as_bytes());
        auth_data.extend_from_slice(&rp_id_hash);


        // Attested Credential Data (ACD)
        auth_data.write_u16::<BigEndian>(credential_id.len() as u16).unwrap();
        auth_data.extend_from_slice(&credential_id);

        // COSE Public Key (simplified example, real COSE is more complex)
        // Representing P-256 public key as a map with specific keys
        let cose_key = cbor::Value::Map(vec![
            (cbor::Value::Integer(1), cbor::Value::Integer(2)), // kty: EC2
            (cbor::Value::Integer(3), cbor::Value::Integer(-7)), // alg: ES256
            (cbor::Value::Integer(-1), cbor::Value::Integer(1)), // crv: P-256
            (cbor::Value::Integer(-2), cbor::Value::Bytes(public_key_bytes[1..33].to_vec())), // x-coordinate
            (cbor::Value::Integer(-3), cbor::Value::Bytes(public_key_bytes[33..65].to_vec())), // y-coordinate
        ].into_iter().collect());
        let cose_key_bytes = cbor::to_vec(&cose_key).unwrap();
        auth_data.extend_from_slice(&cose_key_bytes);

        // Attestation Statement (basic self-attestation for this example)
        let attestation_object_bytes = [auth_data.as_slice(), client_data_hash].concat();
        let attestation_signature = self.attestation_signing_key.sign(&attestation_object_bytes);

        let att_fmt = cbor::Value::Text("none".to_string()); // For self-attestation
        let att_stmt = cbor::Value::Map(vec![].into_iter().collect()); // Empty for 'none' format

        let response_map = cbor::Value::Map(vec![
            (cbor::Value::Text("fmt".to_string()), att_fmt),
            (cbor::Value::Text("authData".to_string()), cbor::Value::Bytes(auth_data)),
            (cbor::Value::Text("attStmt".to_string()), att_stmt),
        ].into_iter().collect());

        