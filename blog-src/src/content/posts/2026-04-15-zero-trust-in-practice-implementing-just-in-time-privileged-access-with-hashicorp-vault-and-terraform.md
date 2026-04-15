---
title: "Zero Trust in Practice: Implementing Just-in-Time Privileged Access with HashiCorp Vault and Terraform"
date: 2026-04-15
category: "thought-leadership"
tags: []
excerpt: "“Zero Trust” is a buzzword that’s easy to say, but much trickier to implement. At its core, Zero Trust means never trust, always verify—but what does..."
---

# Zero Trust in Practice: Implementing Just-in-Time Privileged Access with HashiCorp Vault and Terraform

“Zero Trust” is a buzzword that’s easy to say, but much trickier to implement. At its core, Zero Trust means *never trust, always verify*—but what does that really look like for privileged access in an engineering organization? In this post, let’s get practical: we’ll walk through building just-in-time (JIT) privileged access with [HashiCorp Vault](https://www.vaultproject.io/) and [Terraform](https://www.terraform.io/), enabling ephemeral, auditable credentials for sensitive operations.

## The Problem: Standing Privileges Are a Liability

Traditionally, engineers and automation systems are granted persistent admin credentials for cloud resources, databases, or kubernetes clusters. These standing privileges are a goldmine for attackers—once compromised, they open the door to lateral movement and escalation.

**Zero Trust Principle:** Eliminate standing access. Grant privileges only when needed, for the minimum time required.

## Solution Overview: JIT Privileged Access

Just-in-Time access means:

- Privileges are **not** granted by default.
- Access is requested and approved for a limited time.
- Credentials are automatically revoked or expire.

We’ll use:

- **HashiCorp Vault** to issue dynamic, time-limited credentials.
- **Terraform** to provision and configure the necessary Vault resources as code.
- **Audit logging** to track access grants and expirations.

---

## Step 1: Dynamic Credentials with Vault

Vault can generate short-lived credentials for a variety of backends (AWS, databases, SSH, etc).

**Example: AWS IAM Credentials**

Let’s configure Vault to issue dynamic AWS IAM credentials for privileged actions.

### Vault AWS Secrets Engine Setup

```hcl
# terraform/vault_aws_secrets.tf

resource "vault_aws_secret_backend" "aws" {
  path = "aws"
  access_key = var.aws_access_key
  secret_key = var.aws_secret_key
  region     = "us-east-1"
}

resource "vault_aws_secret_backend_role" "admin" {
  backend         = vault_aws_secret_backend.aws.path
  name            = "admin"
  credential_type = "iam_user"
  policy_arns     = ["arn:aws:iam::123456789012:policy/AdminAccess"]

  # TTLs (1 hour max)
  default_sts_ttl = 1800
  max_sts_ttl     = 3600
}
```

Now, Vault can issue AWS credentials with the `AdminAccess` policy, valid for up to 1 hour.

---

## Step 2: Controlled Access with Vault Policies

Control who can request these credentials.

```hcl
# terraform/vault_policy_jit_admin.hcl
path "aws/creds/admin" {
  capabilities = ["read"]
}
```

Apply this policy only to approved users or groups (e.g., via Okta SSO or GitHub Teams integration).

---

## Step 3: Requesting Just-in-Time Access

A user authenticates to Vault (e.g., with SSO or a trusted CLI session) and requests credentials:

```bash
vault read aws/creds/admin
```

Vault returns:

```json
{
  "data": {
    "access_key": "ASIA....",
    "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCY...",
    "security_token": "...",
    "lease_duration": 3600,
    "lease_id": "aws/creds/admin/..."
  }
}
```

- **Lease duration:** 1 hour.
- **No standing access:** When the lease expires, credentials are revoked automatically.

---

## Step 4: Auditing and Expiry

Vault logs every credential issuance and revocation. Configure your audit log backend (`file`, `syslog`, or a SIEM forwarder) to ensure a full access trail.

**Example: Sample Audit Log Entry**

```
{"time":"2024-06-09T12:34:56Z","type":"response","auth":{"display_name":"okta-user"},"path":"aws/creds/admin","operation":"read"}
```

---

## Step 5: Automating with Terraform

The beauty here is infrastructure-as-code: Vault configuration, policies, and even user assignments are managed and versioned in code.

**Tip:** Use Terraform’s `vault` provider to automate all Vault resources, review PRs for policy changes, and ensure no manual drift.

**Example Directory Structure:**

```
terraform/
  vault_aws_secrets.tf
  vault_policy_jit_admin.hcl
  main.tf
  variables.tf
```

---

## Best Practices and Pitfalls

- **Short TTLs:** Keep credential lifetimes as short as operationally feasible.
- **Access Approval:** Integrate with your existing access request workflows (e.g., ServiceNow, Slack bots, or SSO groups).
- **Revocation:** Vault can revoke credentials early (e.g., via API or UI). Build this into your offboarding process.
- **Least Privilege:** Don’t just issue “admin” credentials—create fine-grained Vault roles for specific tasks.
- **Secrets Hygiene:** Make it easy (and required) for engineers to fetch credentials only when needed, and never hard-code them.

---

## Real-World Example: JIT Access for Production DB

Suppose you need to grant a DBA temporary superuser access for a migration.

1. **DBA requests access** via your workflow (e.g., ticket, chat-ops bot).
2. **Access is approved** (possibly with a manager’s sign-off).
3. **Vault issues credentials** with a 30-minute TTL, visible only to the DBA.
4. **Audit logs** capture the issuance and use.
5. **Credentials auto-expire**; no standing access remains.

---

## Conclusion

Zero Trust isn’t a product—it’s a process. By leveraging Vault and Terraform, you can build practical, self-service, just-in-time access workflows that minimize standing privileges, reduce risk, and keep your auditors happy.

Zero Trust is a journey. Start with one high-risk resource, codify your process, and expand. The best security is invisible until you need it—and gone when you don't.

---

**Have thoughts or questions on JIT access with Vault and Terraform? Drop a comment or reach out—let’s build better security, together.**