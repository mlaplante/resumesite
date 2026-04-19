---
title: "Automating Secrets Rotation in Kubernetes with External Secrets and GitOps Workflows"
date: 2026-04-19
category: "thought-leadership"
tags: []
excerpt: "Keeping secrets safe in Kubernetes is a critical task—but keeping them fresh is just as important. Stale credentials are a security risk, but manual r..."
---

# Automating Secrets Rotation in Kubernetes with External Secrets and GitOps Workflows

Keeping secrets safe in Kubernetes is a critical task—but keeping them fresh is just as important. Stale credentials are a security risk, but manual rotation is tedious and error-prone. Fortunately, we can automate secrets rotation by combining External Secrets and GitOps workflows. Let’s walk through how to build a robust, automated secrets management pipeline that fits right into your Kubernetes deployment practices.

## Why Automate Secrets Rotation?

Secrets—like API keys, database passwords, and certificates—are often the weakest link in a deployment pipeline. Regular rotation reduces the blast radius of a leak and helps you comply with security policies. But manual rotation is tough:

- It’s easy to forget or delay.
- Human error can break apps.
- Coordination across teams is tricky.

Automating secrets rotation solves these issues and fits nicely into modern, declarative infrastructure strategies.

## Kubernetes Secrets: The Challenge

Kubernetes’ native `Secret` objects are convenient, but they have limitations:

- Secrets are typically static, baked into manifests or Helm charts.
- Rotating a secret requires updating the object and redeploying workloads.
- Storing secrets in Git is risky—even encrypted.

What we need is a way to source secrets from a secure vault, keep them out of Git, and keep them updated in Kubernetes.

## Enter External Secrets

[External Secrets](https://external-secrets.io/) is a Kubernetes operator that synchronizes secrets from external providers (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, etc.) into Kubernetes secrets—automatically.

**Benefits:**
- Secrets are dynamically synced from a central vault.
- No need to store secrets in Git.
- Easy integration with GitOps tools.

## GitOps Workflows: The Glue

GitOps tools (like ArgoCD or Flux) declare the desired state of infrastructure in Git, then reconcile that state in your cluster. External Secrets fits right in: you can declare which secrets should sync, and GitOps can handle the operator deployment and configuration.

## How It Works: End-to-End Example

Let’s walk through a practical setup: rotating a database password stored in AWS Secrets Manager and syncing it into Kubernetes using External Secrets, all managed via GitOps.

### 1. Store Secrets in AWS Secrets Manager

Suppose you have a secret called `prod-db-password`:

```bash
aws secretsmanager create-secret \
  --name prod-db-password \
  --secret-string '{"username":"dbuser","password":"s3cr3tP@ssw0rd"}'
```

### 2. Deploy External Secrets Operator via GitOps

Add the operator to your GitOps repo—for example, using Flux:

```yaml
# clusters/my-cluster/external-secrets-operator.yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: external-secrets
  namespace: flux-system
spec:
  url: https://charts.external-secrets.io

---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: external-secrets
  namespace: external-secrets
spec:
  chart:
    spec:
      chart: external-secrets
      version: "0.9.1"
      sourceRef:
        kind: HelmRepository
        name: external-secrets
        namespace: flux-system
```

Flux will reconcile and deploy the operator.

### 3. Configure the Secret Store

Define how to access AWS Secrets Manager:

```yaml
# clusters/my-cluster/secret-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: prod-app
spec:
  provider:
    aws:
      region: us-east-1
      auth:
        secretRef:
          accessKeyIDSecretRef:
            name: aws-creds
            key: access-key
          secretAccessKeySecretRef:
            name: aws-creds
            key: secret-key
```

### 4. Reference External Secrets in Kubernetes

Declare which secrets to sync:

```yaml
# clusters/my-cluster/external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: prod-db-credentials
  namespace: prod-app
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: prod-db-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: prod-db-password
        property: username
    - secretKey: password
      remoteRef:
        key: prod-db-password
        property: password
```

- **refreshInterval** ensures the secret is checked and updated every hour.

### 5. Rotate Secrets in AWS

When you rotate the secret in AWS (manually or via automation), the External Secrets operator picks up the change and updates the corresponding Kubernetes Secret.

```bash
aws secretsmanager update-secret \
  --secret-id prod-db-password \
  --secret-string '{"username":"dbuser","password":"n3wP@ssw0rd"}'
```

### 6. Application Redeployment and Rollout

To ensure your workloads pick up the rotated secret, consider:

- Using Kubernetes deployment strategies that trigger pod restarts on secret changes (e.g., [hashing secrets into pod annotations](https://github.com/bitnami-labs/sealed-secrets/issues/106)).
- Automating rollouts with GitOps tools or hooks.

Example: Annotate your deployment with a hash of the secret:

```yaml
# clusters/my-cluster/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: prod-app
spec:
  template:
    metadata:
      annotations:
        secret-hash: "{{ sha256sum of prod-db-credentials }}"
```

When the secret changes, update the annotation via pipeline or operator, triggering a pod restart.

## Actionable Takeaways

- **Move secrets to a managed vault** (AWS Secrets Manager, Vault, etc.)—never store them in Git.
- **Automate rotation** using cloud-native tools or scripts.
- **Deploy External Secrets Operator** via GitOps for reproducible, auditable infrastructure.
- **Declare ExternalSecret resources** in Git, referencing your secret store.
- **Tune refresh intervals** to balance performance and security.
- **Automate pod restarts** to ensure apps always use fresh secrets.

## Final Thoughts

Automating secrets rotation in Kubernetes is a must for modern operations. With External Secrets and GitOps, you get a pipeline that’s secure, auditable, and hands-off. Your secrets stay fresh, your apps stay safe, and your engineers stay happy.

If you’re not rotating secrets automatically yet, start by moving them to a vault, then layer in External Secrets and GitOps. It’s a small investment for a huge security win.

---

**Questions? Thoughts?** Drop a comment below or reach out if you want to see more deep-dives on hands-on Kubernetes security engineering!