---
title: "Crafting a WebAuthn Server in Go: Deep Dive into Advanced Attestation"
date: 2026-08-17
category: "thought-leadership"
tags: ["webauthn", "go", "security", "cryptography", "authentication", "fido2"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "WebAuthn has revolutionized secure authentication, moving beyond passwords to a more robust, phishing-resistant future. While many tutorials cover the..."
---

WebAuthn has revolutionized secure authentication, moving beyond passwords to a more robust, phishing-resistant future. While many tutorials cover the basics of WebAuthn registration and authentication, diving into advanced attestation formats and building a custom server to handle them provides a deeper understanding of the underlying security mechanisms.

This post will guide you through building a WebAuthn Relying Party (RP) server in Go, focusing on parsing and validating various attestation statements, including `packed`, `fido-u2f`, and `android-key`. We'll explore the cryptographic nuances and practical implementation details.

## Why Go for WebAuthn?

Go's strong typing, excellent concurrency primitives, and robust standard library make it an ideal choice for building secure, high-performance backend services. Its cryptographic packages are well-maintained and provide the necessary primitives for handling WebAuthn's complex signatures and certificates.

## WebAuthn Attestation: A Quick Primer

During registration, a FIDO authenticator generates a new credential key pair and sends the public key to the RP. Attestation is the process where the authenticator proves to the RP that it legitimately created this key pair. The attestation statement includes the public key, authenticator data, and a signature over this data, often accompanied by an attestation certificate chain.

The WebAuthn specification defines several attestation formats, each with its own structure and validation rules. We'll focus on `packed`, `fido-u2f`, and `android-key`.

## Setting Up Our Go Project

Let's start with a basic Go project structure. We'll need a few external libraries for CBOR decoding and WebAuthn-specific structures.

```bash
mkdir webauthn-server && cd webauthn-server
go mod init webauthn-server
go get github.com/go-webauthn/webauthn
go get github.com/fxamacker/cbor/v2
```

Our server will handle two main endpoints: `/register/begin` and `/register/finish`.

## The Core WebAuthn Library

The `github.com/go-webauthn/webauthn` library provides a solid foundation, abstracting away much of the complexity of parsing WebAuthn structures. However, understanding how it works internally, especially for attestation, is key.

Let's define our WebAuthn configuration:

```go
package main

import (
	"log"
	"net/http"

	"github.com/go-webauthn/webauthn/webauthn"
)

var webAuthn *webauthn.WebAuthn
var userStore = map[string]*User{} // A simple in-memory store for demonstration

func main() {
	var err error
	webAuthn, err = webauthn.New(&webauthn.Config{
		RPDisplayName: "My Awesome WebAuthn App",        // Display Name for your site
		RPID:          "localhost",                      // Relying Party ID
		RPOrigins:     []string{"http://localhost:8080"}, // Relying Party Origins (a slice, not a single string)
	})
	if err != nil {
		log.Fatalf("failed to create webauthn instance: %v", err)
	}

	// For production, cross-reference the AAGUID on each registration
	// against the FIDO Alliance's Metadata Service (MDS) rather than
	// trusting attestation validity alone — see "Metadata Service (MDS)"
	// below.

	http.HandleFunc("/register/begin", beginRegistration)
	http.HandleFunc("/register/finish", finishRegistration)

	log.Println("Server started on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// User represents a user in our system
type User struct {
	ID          []byte
	Name        string
	Credentials []webauthn.Credential
	// Challenge is stored per-user for simplicity in this example
	CurrentChallenge []byte
}

func (u *User) WebAuthnID() []byte                          { return u.ID }
func (u *User) WebAuthnName() string                        { return u.Name }
func (u *User) WebAuthnDisplayName() string                 { return u.Name }
func (u *User) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }
func (u *User) WebAuthnIcon() string                        { return "" }
```

## Advanced Attestation Validation

The `webauthn` library handles much of the attestation parsing and basic validation automatically. However, understanding what happens under the hood, especially for certificate chain validation and specific attestation statement checks, is crucial for advanced use cases or debugging.

Let's look at how we can manually inspect and validate different attestation formats. This typically happens within the `finishRegistration` handler after the `webAuthn.FinishRegistration` call.

The `webauthn.Credential` object returned by `FinishRegistration` does *not* hand you a parsed, per-format attestation statement. What it actually exposes is narrower:

*   `credential.AttestationType` — a string classifying trust (e.g. `"basic_full"`).
*   `credential.AttestationFormat` — a string naming the format used, exactly as defined by the spec (`"packed"`, `"fido-u2f"`, `"android-key"`, `"none"`, and so on).
*   `credential.Attestation.Object` — the **raw, still-CBOR-encoded** attestation object. This is where the certificate chain and signature actually live; the library doesn't unpack them into typed Go structs for you.

So "deeper inspection" means decoding `credential.Attestation.Object` yourself. The WebAuthn spec fixes the top-level CBOR map's keys (`fmt`, `attStmt`, `authData`), and `attStmt` is itself a format-specific map — for `packed`, `fido-u2f`, and `android-key` it holds `x5c` (the certificate chain, leaf first) and `sig`. A CBOR library like `github.com/fxamacker/cbor/v2` (already in our `go.mod`) can decode that into a generic map without needing per-format Go types:

```go
// (imports "github.com/fxamacker/cbor/v2" as cbor, alongside the handler's other imports)

// Inside finishRegistration handler, after successful finish
credential, err := webAuthn.FinishRegistration(user, session, response)
if err != nil {
    // Handle error
    return
}

log.Printf("Attestation Format: %s (Type: %s)", credential.AttestationFormat, credential.AttestationType)

switch credential.AttestationFormat {
case "packed":
    log.Println("Handling Packed Attestation")
    // Decode the raw attestation object to reach the certificate chain.
    var obj map[string]interface{}
    if err := cbor.Unmarshal(credential.Attestation.Object, &obj); err != nil {
        log.Printf("failed to decode attestation object: %v", err)
        break
    }
    if attStmt, ok := obj["attStmt"].(map[string]interface{}); ok {
        if _, hasX5C := attStmt["x5c"]; hasX5C {
            log.Println("Packed Attestation has an X5C certificate chain")
            // attStmt["x5c"] is the chain (leaf first) and attStmt["sig"]
            // is the signature to verify against it, e.g. with x509.Verify.
        } else if _, hasECDAA := attStmt["ecdaaKeyId"]; hasECDAA {
            log.Println("Packed Attestation uses ECDAA")
            // ECDAA is more complex and typically involves a trusted third-party service.
        } else {
            log.Println("Packed Attestation uses self-attestation (no x5c/ecdaaKeyId)")
        }
    }
case "fido-u2f":
    log.Println("Handling FIDO U2F Attestation")
    // Same shape as packed: decode attStmt["x5c"] for the certificate chain.
    // U2F attestation certificates are typically self-signed or issued by a FIDO Alliance root.
case "android-key":
    log.Println("Handling Android Key Attestation")
    // Decode attStmt["x5c"] as above, then walk the leaf certificate's
    // extensions for the Android Key Attestation Extension
    // (OID 1.3.6.1.4.1.11129.2.1.17, using encoding/asn1) and verify fields
    // like attestationChallenge, softwareEnforced, and teeEnforced.
    // This is critical for confirming the key was generated in secure hardware.
case "none":
    log.Println("Handling None Attestation (self-attestation)")
    // No attestation statement, only the authenticator's self-signed public key.
    // This offers less security assurance but is allowed by the spec.
default:
    log.Printf("Unhandled Attestation Format: %s", credential.AttestationFormat)
}
```

**Key Takeaways for Attestation Validation:**

1.  **Root of Trust:** For `packed`, `fido-u2f`, and `android-key` formats, the primary security comes from validating the attestation certificate chain against a set of trusted root Certificate Authorities (CAs).
    *   **FIDO Alliance:** For U2F and many FIDO2 authenticators, you'll validate against FIDO Alliance root CAs.
    *   **Google:** For Android Key attestation, you'll validate against Google's attestation root.
    *   **Proprietary:** Some enterprise authenticators might have their own root CAs.
    *   Rather than curating this list by hand, cross-reference against the FIDO Alliance's own Metadata Service (MDS3) — see "Metadata Service (MDS)" below.
2.  **Attestation Statement Specifics:**
    *   **`packed` (X5C):** Verify the X.509 certificate chain. The first certificate is the attestation certificate.
    *   **`packed` (ECDAA):** More complex, involves cryptographic accumulators, usually outsourced to a trusted service.
    *   **`fido-u2f`:** Similar to `packed` X5C, but with U2F-specific certificate structures.
    *   **`android-key`:** Crucially, this format is meant to prove the credential's private key was generated and is held inside the device's secure hardware (a TEE or StrongBox), not just that a certificate chain is valid. Verifying the chain alone isn't enough — you also need to parse the Key Description extension (OID `1.3.6.1.4.1.11129.2.1.17`) out of the leaf certificate and check two things: that `attestationChallenge` matches the SHA-256 of your WebAuthn `clientDataJSON`, and that `attestationSecurityLevel` (and `keymasterSecurityLevel`, on older devices) reports `TrustedEnvironment` or `StrongBox` rather than `Software`. Skip that second check and the "hardware-backed" guarantee this format exists to provide is nothing more than an unverified claim.
3.  **Sign Counters:** Every `webauthn.Credential` carries a `SignCount` that the authenticator is supposed to increment on each successful authentication. Track the last seen value per credential and reject (or at minimum, flag and alert on) an authentication where the new counter is less than or equal to the stored one — that's the classic signal of a cloned authenticator. Some platform authenticators, notably many implementations of Touch ID and Windows Hello, always report a counter of `0` and never increment it; for those, sign-counter tracking is simply not a viable detection mechanism, and you should lean more heavily on attestation and device metadata instead.
4.  **Metadata Service (MDS):** The FIDO Alliance publishes a Metadata Service (MDS3) listing known authenticator models, their certification level, and known vulnerabilities. A production RP should cross-reference the AAGUID returned during registration against MDS rather than trusting attestation validity alone — a cryptographically valid attestation from a since-revoked or downgraded authenticator model is not something certificate chain validation alone will catch.

## Conclusion

The `go-webauthn` library does the heavy lifting of CBOR decoding and basic structural validation, but "advanced attestation" ultimately means not stopping at "the chain validated." Each format carries its own additional guarantees — hardware backing for `android-key`, U2F-specific certificate semantics for `fido-u2f` — and skipping the format-specific checks quietly turns a hardware attestation into a much weaker claim than your users or compliance requirements assume it to be. If you're building an RP that needs to make real trust decisions based on attestation (not just "was a credential registered"), budget the time to parse these extensions yourself rather than treating the library's success return value as the end of the story.