---
title: "SSH Hardening with FIDO2 and OpenSSH 8.2+: Key Types and Agent Forwarding"
date: 2026-09-07
category: "thought-leadership"
tags: ["ssh", "security", "fido2", "openssh", "authentication"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "As security professionals, we're constantly evaluating and enhancing our authentication mechanisms. SSH, the backbone of remote administration, is a..."
---

As security professionals, we're constantly evaluating and enhancing our authentication mechanisms. SSH, the backbone of remote administration, is a prime target. While SSH key pairs are a significant improvement over passwords, the advent of FIDO2-based authentication with OpenSSH 8.2+ offers a new frontier in hardening access. This post dives into leveraging FIDO2 for SSH, focusing on key types, agent forwarding, and practical implementation details.

## The FIDO2 Advantage for SSH

FIDO2 security keys, such as YubiKeys, offer strong, phishing-resistant authentication. When integrated with SSH, they provide several benefits:

*   **Hardware-backed security:** Private keys never leave the security key, making them resistant to software-based exfiltration.
*   **Tamper-proof:** The key itself enforces security policies, such as user presence (touching the key).
*   **Phishing resistance:** The FIDO2 protocol cryptographically binds the authentication to the origin, preventing attackers from tricking users into authenticating to malicious sites.

OpenSSH 8.2 introduced support for FIDO2/U2F hardware authenticators, specifically through the `sk-ecdsa@openssh.com` and `sk-ed25519@openssh.com` key types. These are essentially ECDSA and Ed25519 keys where the private key operations are offloaded to a security key.

## Generating Your FIDO2 SSH Key

Let's start by generating a new FIDO2-backed SSH key. You'll need an OpenSSH client version 8.2 or newer and a FIDO2-compatible security key.

```bash
# Generate an sk-ecdsa key (requires user presence confirmation on the security key)
ssh-keygen -t sk-ecdsa -f ~/.ssh/id_sk_ecdsa_fido2 -C "michael.laplante@example.com-fido2"

# You will be prompted to touch your security key.
# It will then ask for an optional passphrase.
```

If your security key supports Ed25519, you can also generate an `sk-ed25519` key. The process is identical:

```bash
ssh-keygen -t sk-ed25519 -f ~/.ssh/id_sk_ed25519_fido2 -C "michael.laplante@example.com-fido2-ed25519"
```

After generation, you'll have two files: `id_sk_ecdsa_fido2` (the private key stub) and `id_sk_ecdsa_fido2.pub` (the public key). The private key stub doesn't contain the actual private key material; it's a pointer that tells `ssh-agent` and `ssh` how to interact with your security key.

## Deploying the Public Key

Copy the public key (`id_sk_ecdsa_fido2.pub`) to the `~/.ssh/authorized_keys` file on the remote server you wish to access.

```bash
# Example for a remote server 'myserver.example.com'
ssh-copy-id -i ~/.ssh/id_sk_ecdsa_fido2.pub michael@myserver.example.com
```

Alternatively, manually append the contents of `id_sk_ecdsa_fido2.pub` to `~/.ssh/authorized_keys` on the remote server.

## Authenticating with FIDO2 Keys

When you attempt to connect to the remote server, `ssh` will prompt you to touch your security key.

```bash
ssh michael@myserver.example.com
# Authenticator interaction required.
# Please touch the authenticator.
```

Upon touching your key, the authentication will proceed. This user presence requirement is a critical security feature, ensuring that you physically authorize each authentication attempt.

## SSH Agent Forwarding with FIDO2 Keys: A Deeper Look

SSH agent forwarding (`ssh -A`) is incredibly convenient for jumping between multiple hosts without re-authenticating. It allows your local `ssh-agent` to handle authentication requests for subsequent connections initiated from the remote server.

For FIDO2 keys, agent forwarding works seamlessly. When you connect to `HostA` with `ssh -A`, your `ssh-agent` (which holds the reference to your FIDO2 key) is forwarded. If you then `ssh` from `HostA` to `HostB`, `HostA` will forward the authentication request back to your local `ssh-agent`, which in turn interacts with your physical security key.

```bash
# Local machine:
# 1. Start ssh-agent (if not already running)
eval "$(ssh-agent -s)"

# 2. Add your FIDO2 key to the agent
ssh-add ~/.ssh/id_sk_ecdsa_fido2
# You will be prompted to touch your security key.

# 3. Connect to HostA with agent forwarding
ssh -A michael@hostA.example.com

# On HostA:
# 4. Connect to HostB. HostA forwards the request to your local agent.
ssh michael@hostB.example.com
# Your local machine will prompt you to touch your security key.
```

This is where the user presence requirement for FIDO2 keys becomes particularly powerful. Even with agent forwarding, each *initial* authentication requiring the FIDO2 key will prompt you to touch it. This mitigates some of the risks traditionally associated with agent forwarding, as an attacker compromising `HostA` would still need to trick you into touching your key for subsequent `ssh` connections from `HostA` to other hosts using that FIDO2 key.

### Configuration for Enhanced Security

While FIDO2 keys enhance security, it's still prudent to configure your SSH client and server for best practices.

**Client-Side (`~/.ssh/config`):**

```config
Host *
    # Prefer FIDO2 keys
    PreferredAuthentications publickey,keyboard-interactive

Host myserver.example.com
    IdentityFile ~/.ssh/id_sk_ecdsa_fido2
    # Ensure agent forwarding is enabled for this host if needed
    ForwardAgent yes
```

**Server-Side (`/etc/ssh/sshd_config`):**

```config
# Disable password authentication
PasswordAuthentication no

# Ensure PubkeyAuthentication is enabled
PubkeyAuthentication yes

# Optional: Restrict which agent keys can be forwarded (OpenSSH 8.9+)
# This is a powerful feature to limit exposure of specific keys.
# See 'man sshd_config' for AgentForwardingAllowGroups, AgentForwardingDenyGroups
# For example, to only allow agent forwarding for 'my_fido2_key_comment':
# AgentForwardingAllowGroups my_fido2_key_comment
```

**Important Note on Agent Forwarding and `sk-` keys:**

The `sk-` keys rely on a `ssh-sk-helper` program on the client side to communicate with the security key. This helper is invoked by `ssh-agent` or `ssh` directly. When agent forwarding is in use, the remote `ssh` daemon communicates with your local `ssh-agent`, which then uses `ssh-sk-helper` to talk to your physical security key. This architecture ensures that the critical private key operations remain isolated within your security key and are always subject to user presence.

## Hardening Beyond FIDO2

While FIDO2 keys are a significant step, remember to combine them with other hardening techniques:

*   **Disable password authentication:** `PasswordAuthentication no` in `sshd_config`.
*   **Disable root login:** `PermitRootLogin no`.
*   **Limit user access:** Use `AllowUsers` or `AllowGroups`.
*   **Restrict commands:** For specific keys, use the `command=` option in `authorized_keys`.
*   **Use a strong passphrase** on your FIDO2 key (if your key supports it and you choose to set one). This adds another layer of protection if the key is lost or stolen, though the user presence requirement is often sufficient.
*   **Keep OpenSSH updated:** Always run the latest stable version to benefit from security fixes and new features.

## Conclusion

Integrating FIDO2 security keys with OpenSSH 8.2+ provides a robust and phishing-resistant method for securing SSH access. By understanding the `sk-` key types, leveraging agent forwarding securely, and applying server-side best practices, you can significantly elevate your infrastructure's security posture. The user presence requirement inherent in FIDO2 keys ensures that even with the convenience of agent forwarding, critical authentication decisions remain firmly in the hands of the human user. Embrace these modern authentication methods to build a more resilient and secure environment.