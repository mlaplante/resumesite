---
title: "Crafting a Custom Linux Filesystem with FUSE for Encrypted Storage"
date: 2026-09-16
category: "thought-leadership"
tags: ["linux", "fuse", "encryption", "filesystem", "security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of information security, data at rest encryption is paramount. While full-disk encryption solutions like LUKS are excellent for entire..."
---

In the world of information security, data at rest encryption is paramount. While full-disk encryption solutions like LUKS are excellent for entire volumes, there are scenarios where you need more granular control, or perhaps a specialized storage mechanism that integrates encryption transparently. This is where crafting your own filesystem, powered by FUSE (Filesystem in Userspace), can be incredibly powerful.

FUSE allows non-privileged users to create their own filesystems without modifying the kernel. This opens up a world of possibilities for custom storage backends, network filesystems, or, as we'll explore today, a simple encrypted storage layer. We'll walk through the process of building a basic FUSE filesystem in C++ that encrypts and decrypts file contents on the fly using a symmetric encryption algorithm.

## Understanding the FUSE Mechanism

Before diving into code, let's briefly understand how FUSE works. When you mount a FUSE filesystem, the kernel directs all filesystem operations (like `open`, `read`, `write`, `mkdir`, `getattr`) to your user-space program. Your program then intercepts these calls, performs its logic (in our case, encryption/decryption), and typically delegates the actual storage to an underlying "real" filesystem (like ext4 or XFS) or a custom storage backend.

The core of a FUSE filesystem is a set of callback functions that correspond to these kernel operations. You implement these functions, and the FUSE library handles the communication between your program and the kernel.

## Setting Up Our Project

For this example, we'll use C++ and the `libfuse` library. You'll need to install `libfuse-dev` (or `fuse-devel` on RHEL-based systems) and a suitable encryption library. For simplicity, we'll use OpenSSL's AES functions.

```bash
# On Debian/Ubuntu
sudo apt update
sudo apt install libfuse-dev libssl-dev build-essential

# On Fedora/RHEL
sudo dnf install fuse-devel openssl-devel gcc-c++
```

Our custom filesystem will store encrypted files in a designated "backend" directory. When a user interacts with the mounted FUSE directory, our filesystem will decrypt on read and encrypt on write.

## The Encryption Layer

Let's start with a simple AES-256 GCM encryption/decryption helper. This is a crucial component that will be invoked by our FUSE callbacks.

```cpp
// encrypt_decrypt.h
#pragma once

#include <vector>
#include <string>

// Function to generate a random AES key and IV
std::vector<unsigned char> generate_random_bytes(size_t num_bytes);

// Encrypts data using AES-256 GCM
std::vector<unsigned char> encrypt_data(
    const std::vector<unsigned char>& plaintext,
    const std::vector<unsigned char>& key,
    const std::vector<unsigned char>& iv,
    std::vector<unsigned char>& tag
);

// Decrypts data using AES-256 GCM
std::vector<unsigned char> decrypt_data(
    const std::vector<unsigned char>& ciphertext,
    const std::vector<unsigned char>& key,
    const std::vector<unsigned char>& iv,
    const std::vector<unsigned char>& tag
);
```

```cpp
// encrypt_decrypt.cpp
#include "encrypt_decrypt.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <iostream>

// Helper to handle OpenSSL errors
void handleErrors() {
    // In a real application, you'd log these errors
    std::cerr << "OpenSSL error occurred." << std::endl;
    // exit(1); // Or handle more gracefully
}

std::vector<unsigned char> generate_random_bytes(size_t num_bytes) {
    std::vector<unsigned char> bytes(num_bytes);
    if (RAND_bytes(bytes.data(), num_bytes) != 1) {
        handleErrors();
    }
    return bytes;
}

std::vector<unsigned char> encrypt_data(
    const std::vector<unsigned char>& plaintext,
    const std::vector<unsigned char>& key,
    const std::vector<unsigned char>& iv,
    std::vector<unsigned char>& tag
) {
    EVP_CIPHER_CTX *ctx;
    int len;
    int ciphertext_len;

    std::vector<unsigned char> ciphertext_buf(plaintext.size() + EVP_MAX_IV_LENGTH); // Max possible size

    if (!(ctx = EVP_CIPHER_CTX_new())) handleErrors();

    if (1 != EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL)) handleErrors();
    if (1 != EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, iv.size(), NULL)) handleErrors();
    if (1 != EVP_EncryptInit_ex(ctx, NULL, NULL, key.data(), iv.data())) handleErrors();

    if (1 != EVP_EncryptUpdate(ctx, ciphertext_buf.data(), &len, plaintext.data(), plaintext.size())) handleErrors();
    ciphertext_len = len;

    if (1 != EVP_EncryptFinal_ex(ctx, ciphertext_buf.data() + len, &len)) handleErrors();
    ciphertext_len += len;

    tag.resize(EVP_GCM_TLS_TAG_LEN); // Standard GCM tag length
    if (1 != EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, EVP_GCM_TLS_TAG_LEN, tag.data())) handleErrors();

    EVP_CIPHER_CTX_free(ctx);

    ciphertext_buf.resize(ciphertext_len);
    return ciphertext_buf;
}

std::vector<unsigned char> decrypt_data(
    const std::vector<unsigned char>& ciphertext,
    const std::vector<unsigned char>& key,
    const std::vector<unsigned char>& iv,
    const std::vector<unsigned char>& tag
) {
    EVP_CIPHER_CTX *ctx;
    int len;
    int plaintext_len;

    std::vector<unsigned char> plaintext_buf(ciphertext.size());

    if (!(ctx = EVP_CIPHER_CTX_new())) handleErrors();

    if (1 != EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL)) handleErrors();
    if (1 != EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, iv.size(), NULL)) handleErrors();
    if (1 != EVP_DecryptInit_ex(ctx, NULL, NULL, key.data(), iv.data())) handleErrors();

    if (1 != EVP_DecryptUpdate(ctx, plaintext_buf.data(), &len, ciphertext.data(), ciphertext.size())) handleErrors();
    plaintext_len = len;

    if (1 != EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, tag.size(), tag.data())) handleErrors();

    // Finalize the decryption. A positive return value indicates success,
    // anything else is a failure - the plaintext is not trustworthy.
    if (1 != EVP_DecryptFinal_ex(ctx, plaintext_buf.data() + len, &len)) {
        EVP_CIPHER_CTX_free(ctx);
        handleErrors(); // Tag verification failed
        return {}; // Return empty vector on failure
    }
    plaintext_len += len;

    EVP_CIPHER_CTX_free(ctx);

    plaintext_buf.resize(plaintext_len);
    return plaintext_buf;
}
```

**Important Note on Key Management:** For this example, we're hardcoding a key and IV (or generating them once). In a production environment, proper key management is critical. This would involve securely storing keys (e.g., in a hardware security module, a secure key vault, or derived from a strong passphrase using PBKDF2). The IV should always be unique for each encryption operation, but doesn't need to be secret; it's typically stored alongside the ciphertext.

## The FUSE Filesystem Implementation

Now, let's build the FUSE filesystem. We'll define a class `EncryptedFS` that holds our FUSE operations and the encryption key.

```cpp
// encrypted_fs.cpp
#define FUSE_USE_VERSION 31

#include <fuse.h>
#include <iostream>
#include <string>
#include <vector>
#include <fstream>
#include <cstring>
#include <unistd.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>

#include "encrypt_decrypt.h" // Our encryption helpers

// Global context for our filesystem
struct EncryptedFS_Context {
    std::string backend_path;
    std::vector<unsigned char> encryption_key;
    // For simplicity, we'll use a fixed IV for now, but in a real system,
    // the IV should be unique per file and stored with the ciphertext.
    std::vector<unsigned char> fixed_iv;
};

static EncryptedFS_Context* fs_context;

// Helper to get the full path in the backend storage
static std::string get_backend_path(const char* path) {
    return fs_context->backend_path + path;
}

// Helper to read encrypted data from backend and decrypt
static std::vector<unsigned char> read_and_decrypt(const std::string& backend_filepath) {
    std::ifstream ifs(backend_filepath, std::ios::binary);
    if (!ifs) {
        std::cerr << "Error opening backend file for read: " << backend_filepath << std::endl;
        return {};
    }

    // Read IV and Tag (if stored per-file) and then ciphertext
    // For simplicity in this example, we're using a fixed IV.
    // In a real system, IV and Tag would be prepended to the ciphertext.
    // For now, we assume fixed_iv and a fixed tag length.

    ifs.seekg(0, std::ios::end);
    std::streampos file_size = ifs.tellg();
    ifs.seekg(0, std::ios::beg);

    if (file_size < EVP_GCM_TLS_TAG_LEN) { // Minimum size for tag
        std::cerr << "Backend file too small for tag: " << backend_filepath << std::endl;
        return {};
    }

    std::vector<unsigned char> tag(EVP_GCM_TLS_TAG_LEN);
    ifs.read