---
title: "WebAuthn with YubiKeys: FIDO2 Attestation and Assertion Deep Dive"
date: 2026-06-26
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As an SVP of Information Security and Operations, I've spent years navigating the complexities of authentication. Passwords, even strong ones, remain..."
---

# WebAuthn with YubiKeys: FIDO2 Attestation and Assertion Deep Dive

As an SVP of Information Security and Operations, I've spent years navigating the complexities of authentication. Passwords, even strong ones, remain a persistent vulnerability. Multi-factor authentication (MFA) helps, but often introduces friction or relies on less secure second factors. This is where WebAuthn, coupled with FIDO2 security keys like YubiKeys, offers a powerful, phishing-resistant alternative.

In this post, we're going beyond the "what" and diving into the "how." We'll explore the FIDO2 attestation and assertion flows, specifically focusing on how a relying party (your application) interacts with a YubiKey through the browser. My goal is to equip you with the technical understanding needed to implement this robust authentication mechanism effectively.

## Understanding the Core Components

Before we dissect the flows, let's quickly define the key players:

*   **Relying Party (RP):** Your web application that wants to authenticate users.
*   **Authenticator:** The FIDO2 security key (e.g., YubiKey) that generates and stores cryptographic credentials.
*   **WebAuthn API:** The JavaScript API in the browser that mediates communication between the RP and the Authenticator.
*   **FIDO2 Protocol:** The underlying standard that defines how authenticators and relying parties interact.
*   **Attestation:** The process of registering a new authenticator with the RP. It proves the authenticator is genuine and creates a public/private key pair.
*   **Assertion:** The process of authenticating an existing user with their registered authenticator. It proves possession of the private key.

## The Attestation Flow: Registering a YubiKey

Attestation is the initial setup phase where a user registers their YubiKey with your application. This involves generating a new credential (a public/private key pair) on the YubiKey and sending the public key, along with an attestation statement, to your server.

Here's a step-by-step breakdown and code snippets illustrating the RP's perspective:

1.  **RP Initiates Registration:**
    The RP server generates a `PublicKeyCredentialCreationOptions` object. This includes a `challenge`, `rp` (relying party) details, `user` details, and `pubKeyCredParams` (specifying supported algorithms like `ES256` or `RS256`).

    ```typescript
    // Server-side (simplified for illustration)
    import { generateChallenge, generateRegistrationOptions } from '@simplewebauthn/server';

    const userId = 'user-123';
    const userName = 'alice@example.com';
    const challenge = generateChallenge(); // Cryptographically secure random bytes

    const options = generateRegistrationOptions({
        rpName: 'My Secure App',
        rpID: 'myapp.com', // Must match origin
        userID: userId,
        userName: userName,
        challenge: challenge,
        timeout: 60000,
        attestationType: 'none', // Or 'direct' for stricter attestation
        authenticatorSelection: {
            authenticatorAttachment: 'cross-platform', // YubiKeys are cross-platform
            userVerification: 'preferred', // PIN/biometrics preferred but not required
            requireResidentKey: false, // YubiKeys support resident keys but not always required
        },
        supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });

    // Store challenge in session for later verification
    req.session.challenge = challenge;
    res.json(options);
    ```

2.  **Browser Requests Credential Creation:**
    The client-side JavaScript receives these options and calls `navigator.credentials.create()`.

    ```javascript
    // Client-side
    async function registerYubiKey() {
        try {
            const response = await fetch('/api/register/options');
            const options = await response.json();

            // Convert Base64URL to ArrayBuffer for challenge and user.id
            options.challenge = base64urlToArrayBuffer(options.challenge);
            options.user.id = base64urlToArrayBuffer(options.user.id);

            // Important: Handle `transports` if using 'direct' attestation
            // options.authenticatorSelection.authenticatorAttachment = 'cross-platform';
            // options.authenticatorSelection.userVerification = 'preferred';

            const credential = await navigator.credentials.create({
                publicKey: options
            });

            // Send credential back to server
            await fetch('/api/register/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(credential)
            });

            console.log('YubiKey registered successfully!');
        } catch (error) {
            console.error('Registration failed:', error);
        }
    }

    // Helper to convert Base64URL to ArrayBuffer
    function base64urlToArrayBuffer(base64url) {
        const padding = '='.repeat((4 - base64url.length % 4) % 4);
        const base64 = (base64url + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray.buffer;
    }
    ```

3.  **YubiKey Interaction (User Action):**
    The browser prompts the user to insert and touch their YubiKey (and optionally enter a PIN if `userVerification` is required). The YubiKey generates a new unique public/private key pair, stores the private key securely, and returns the public key along with an attestation statement.

4.  **RP Server Verifies Attestation:**
    The server receives the `PublicKeyCredential` object from the client. It then performs critical verification steps:

    *   **Challenge Verification:** Ensures the `challenge` in the attestation response matches the one issued by the server.
    *   **Origin Verification:** Confirms the origin matches the RP's `rpID`.
    *   **Attestation Statement Verification (Optional but Recommended):** If `attestationType` was set to 'direct', the server verifies the authenticator's attestation certificate chain. This provides cryptographic proof that the authenticator is a genuine FIDO device (e.g., a real YubiKey). For 'none' attestation, this step is skipped, trading some trust for simplicity.
    *   **Credential ID and Public Key Storage:** If all checks pass, the server stores the `credentialId` and the `publicKey` associated with the user.

    ```typescript
    // Server-side (simplified for illustration)
    import { verifyRegistrationResponse } from '@simplewebauthn/server';

    async function verifyRegistration(req, res) {
        try {
            const { credential } = req.body;
            const expectedChallenge = req.session.challenge; // Retrieve stored challenge

            const verification = await verifyRegistrationResponse({
                response: credential,
                expectedChallenge: expectedChallenge,
                expectedOrigin: 'https://myapp.com', // Must match origin
                expectedRPID: 'myapp.com', // Must match rpID
                requireUserVerification: false, // Depends on your policy
            });

            const { verified, registrationInfo } = verification;

            if (verified && registrationInfo) {
                const { credentialID, credentialPublicKey, counter } = registrationInfo;
                // Store credentialID (Base64URL), credentialPublicKey (Base64URL),
                // and counter (number) in your database, linked to the user.
                // Example:
                // await db.saveCredential({
                //     userId: 'user-123',
                //     credentialId: base64url.encode(credentialID),
                //     publicKey: base64url.encode(credentialPublicKey),
                //     counter: counter,
                //     transports: credential.response.transports, // Useful for future assertions
                // });
                res.status(200).send('Registration successful');
            } else {
                res.status(400).send('Registration verification failed');
            }
        } catch (error) {
            console.error('Registration verification error:', error);
            res.status(500).send('Server error');
        }
    }
    ```

**Key Takeaway for Attestation:** The server's role is not just to receive data, but to rigorously verify every aspect of the attestation response to prevent spoofing and ensure the integrity of the registered credential.

## The Assertion Flow: Authenticating with a YubiKey

Assertion is the process where a user proves their identity using a previously registered YubiKey. This involves the YubiKey cryptographically signing a challenge provided by the RP, proving possession of the private key.

1.  **RP Initiates Authentication:**
    The RP server generates a new `challenge` and retrieves the `credentialIds` previously registered for the user (or optionally allows discovery of resident keys).

    ```typescript
    // Server-side (simplified for illustration)
    import { generateChallenge, generateAuthenticationOptions } from '@simplewebauthn/server';

    const userId = 'user-123';
    // Fetch registered credentials for the user from your database
    const userCredentials = await db.getCredentialsByUserId(userId);

    const options = generateAuthenticationOptions({
        rpID: 'myapp.com',
        challenge: generateChallenge(),
        allowCredentials: userCredentials.map(cred => ({
            id: cred.credentialId, // Base64URL encoded
            type: 'public-key',
            transports: cred.transports, // Important for browser to know how to talk to authenticator
        })),
        userVerification: 'preferred',
    });

    req.session.challenge = options.challenge; // Store for verification
    res.json(options);
    ```

2.  **Browser Requests Credential Assertion:**
    The client-side JavaScript receives these options and calls `navigator.credentials.get()`.

    ```javascript
    // Client-side
    async function authenticateYubiKey() {
        try {
            const response = await fetch('/api/login/options');
            const options = await response.json();

            // Convert Base64URL to ArrayBuffer for challenge and credential IDs
            options.challenge = base64urlToArrayBuffer(options.challenge);
            options.allowCredentials.forEach(cred => {
                cred.id = base64urlToArrayBuffer(cred.id);
            });

            const assertion = await navigator.credentials.get({
                publicKey: options
            });

            // Send assertion back to server
            await fetch('/api/login/verify', {
                method: 'POST',
                headers: { 'Content-Type':