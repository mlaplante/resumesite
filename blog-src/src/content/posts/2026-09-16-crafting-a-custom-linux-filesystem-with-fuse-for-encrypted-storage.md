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
    ifs.read(reinterpret_cast<char*>(tag.data()), tag.size());

    std::vector<unsigned char> ciphertext(static_cast<size_t>(file_size) - tag.size());
    ifs.read(reinterpret_cast<char*>(ciphertext.data()), ciphertext.size());

    return decrypt_data(ciphertext, fs_context->encryption_key, fs_context->fixed_iv, tag);
}

// Helper to encrypt data and write it (tag-prefixed) to the backend
static bool encrypt_and_write(const std::string& backend_filepath, const std::vector<unsigned char>& plaintext) {
    std::vector<unsigned char> tag;
    std::vector<unsigned char> ciphertext = encrypt_data(plaintext, fs_context->encryption_key, fs_context->fixed_iv, tag);

    std::ofstream ofs(backend_filepath, std::ios::binary | std::ios::trunc);
    if (!ofs) {
        std::cerr << "Error opening backend file for write: " << backend_filepath << std::endl;
        return false;
    }
    ofs.write(reinterpret_cast<const char*>(tag.data()), tag.size());
    ofs.write(reinterpret_cast<const char*>(ciphertext.data()), ciphertext.size());
    return true;
}

// FUSE callback: getattr
static int enc_getattr(const char* path, struct stat* stbuf, struct fuse_file_info* fi) {
    (void)fi;
    std::string backend_path = get_backend_path(path);
    if (lstat(backend_path.c_str(), stbuf) == -1)
        return -errno;

    // The backend file holds tag || ciphertext, which is EVP_GCM_TLS_TAG_LEN
    // bytes larger than the plaintext. Report the plaintext size so callers
    // that trust st_size (cp, cat, readers that pre-allocate buffers) don't
    // read past the end of the decrypted content.
    if (S_ISREG(stbuf->st_mode) && stbuf->st_size >= EVP_GCM_TLS_TAG_LEN)
        stbuf->st_size -= EVP_GCM_TLS_TAG_LEN;

    return 0;
}

// FUSE callback: readdir
static int enc_readdir(const char* path, void* buf, fuse_fill_dir_t filler,
                        off_t offset, struct fuse_file_info* fi, enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;
    std::string backend_path = get_backend_path(path);
    DIR* dp = opendir(backend_path.c_str());
    if (!dp) return -errno;

    filler(buf, ".", NULL, 0, (fuse_fill_dir_flags)0);
    filler(buf, "..", NULL, 0, (fuse_fill_dir_flags)0);

    struct dirent* de;
    while ((de = readdir(dp)) != nullptr)
        filler(buf, de->d_name, NULL, 0, (fuse_fill_dir_flags)0);

    closedir(dp);
    return 0;
}

// FUSE callback: open. We defer actual decryption to read(), so open() just
// verifies the backend file exists and is accessible with the requested flags.
static int enc_open(const char* path, struct fuse_file_info* fi) {
    std::string backend_path = get_backend_path(path);
    int fd = open(backend_path.c_str(), fi->flags);
    if (fd == -1) return -errno;
    close(fd);
    return 0;
}

// FUSE callback: read. Decrypts the whole backend file, then serves the
// requested slice. Fine for small files; a production filesystem would
// chunk encryption per-block to avoid decrypting the whole file on every read.
static int enc_read(const char* path, char* buf, size_t size, off_t offset, struct fuse_file_info* fi) {
    (void)fi;
    std::vector<unsigned char> plaintext = read_and_decrypt(get_backend_path(path));
    if (offset >= static_cast<off_t>(plaintext.size()))
        return 0;

    size_t to_copy = std::min(size, plaintext.size() - static_cast<size_t>(offset));
    memcpy(buf, plaintext.data() + offset, to_copy);
    return static_cast<int>(to_copy);
}

// FUSE callback: write. Decrypts the current contents, patches in the new
// bytes at the given offset, then re-encrypts and rewrites the whole file.
static int enc_write(const char* path, const char* buf, size_t size, off_t offset, struct fuse_file_info* fi) {
    (void)fi;
    std::string backend_path = get_backend_path(path);
    std::vector<unsigned char> plaintext = read_and_decrypt(backend_path);

    if (static_cast<size_t>(offset) + size > plaintext.size())
        plaintext.resize(offset + size);
    memcpy(plaintext.data() + offset, buf, size);

    if (!encrypt_and_write(backend_path, plaintext))
        return -EIO;

    return static_cast<int>(size);
}

static struct fuse_operations enc_ops;

int main(int argc, char* argv[]) {
    fs_context = new EncryptedFS_Context();
    fs_context->backend_path = "/var/lib/encrypted_fs_backend"; // In production, take this from argv
    fs_context->encryption_key = generate_random_bytes(32);     // 256-bit key; see note below
    fs_context->fixed_iv = generate_random_bytes(12);           // 96-bit IV; see note below

    enc_ops.getattr = enc_getattr;
    enc_ops.open    = enc_open;
    enc_ops.read    = enc_read;
    enc_ops.write   = enc_write;
    enc_ops.readdir = enc_readdir;

    return fuse_main(argc, argv, &enc_ops, nullptr);
}
```

**Important Caveat — Fix This Before You Use It:** this implementation reuses `fixed_iv` for every single write, to every file, for the lifetime of the mount. That's a critical flaw, not a simplification. AES-GCM's security guarantees depend entirely on never reusing the same key/IV pair: reuse it twice and you leak the XOR of the two plaintexts, and an attacker who can induce two writes can forge authentication tags for arbitrary ciphertext. A real implementation must generate a fresh, random 96-bit IV for every encryption operation and store it alongside the ciphertext — typically as an `iv || tag || ciphertext` layout on the backend file — rather than pulling it from a single fixed value in the context struct.

## Actionable Takeaways

1.  **Never reuse an IV with GCM.** Generate one per write with `generate_random_bytes(12)` and persist it with the ciphertext; it doesn't need to be secret, just unique per encryption.
2.  **Chunk large files.** Decrypting and re-encrypting an entire file on every `write()` is fine for a demo, but it's O(file size) per write. A production design encrypts fixed-size blocks independently, addressed by offset, so a single write only touches the blocks it modifies.
3.  **Derive keys, don't hardcode them.** Use PBKDF2, scrypt, or Argon2 to derive the master key from a passphrase, or source it from a KMS or hardware-backed keystore — never bake it into the binary.
4.  **Mind the metadata leak.** File sizes, modification times, and directory structure are still visible on the backend filesystem even though contents are encrypted; if that's part of your threat model, you need to pad file sizes or encrypt filenames too.

## Conclusion

FUSE turns "write a filesystem" into "implement a handful of callbacks," which makes it a genuinely practical tool for bolting transparent encryption onto a directory tree without touching the kernel. The version here is a teaching example, not a production filesystem — fix the IV reuse, add per-block chunking, and put real key management behind it before you trust it with anything sensitive. But the architecture — intercept the FUSE operations, delegate storage to a backend directory, encrypt and decrypt at the boundary — scales cleanly from this toy example up to something you'd actually deploy.