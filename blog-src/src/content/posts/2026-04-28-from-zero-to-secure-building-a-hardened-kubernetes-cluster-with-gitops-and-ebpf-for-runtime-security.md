---
title: "From Zero to Secure: Building a Hardened Kubernetes Cluster with GitOps and eBPF for Runtime Security"
date: 2026-04-28
category: "thought-leadership"
tags: []
excerpt: "Building a Kubernetes cluster is one thing; building a hardened Kubernetes cluster is an entirely different beast. In today's threat landscape, simply..."
---

# From Zero to Secure: Building a Hardened Kubernetes Cluster with GitOps and eBPF for Runtime Security

Building a Kubernetes cluster is one thing; building a *hardened* Kubernetes cluster is an entirely different beast. In today's threat landscape, simply deploying a cluster and hoping for the best is a recipe for disaster. We need to bake security in from the ground up, automate its enforcement, and gain deep visibility into runtime behavior.

This post isn't about high-level concepts. We're going to roll up our sleeves and discuss a practical approach to building a secure Kubernetes cluster, leveraging GitOps for consistent configuration and eBPF for unparalleled runtime security monitoring and enforcement.

## The Foundation: GitOps for Immutable Security

Our first principle is "everything as code." This means our cluster's configuration, security policies, and even the deployment of our security tools will be managed through Git. GitOps provides several critical advantages for security:

1.  **Version Control:** Every change is tracked, auditable, and revertable.
2.  **Single Source of Truth:** Git is the definitive state of our cluster. Manual changes are actively discouraged and ideally, automatically reverted.
3.  **Automated Enforcement:** CI/CD pipelines ensure that only approved, reviewed changes make it to the cluster.
4.  **Drift Detection:** Tools like FluxCD or Argo CD constantly compare the cluster's actual state to the desired state in Git, alerting or even auto-correcting deviations.

Let's assume we're starting with a vanilla Kubernetes cluster (e.g., provisioned via `kubeadm`, EKS, GKE, AKS). Our first step is to establish GitOps control.

### GitOps Setup with FluxCD (Example)

First, we bootstrap FluxCD onto our cluster, pointing it to a Git repository containing our base cluster configurations.

```bash
# Install Flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash

# Create a Git repository for your cluster config (e.g., github.com/your-org/kube-cluster-config)
# Ensure you have a personal access token with repo write access

# Bootstrap Flux
flux bootstrap github \
  --owner=your-org \
  --repository=kube-cluster-config \
  --branch=main \
  --path=./clusters/my-secure-cluster \
  --personal
```

Inside `kube-cluster-config/clusters/my-secure-cluster`, we'll define our core components:

```yaml
# kube-cluster-config/clusters/my-secure-cluster/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/core-infra
  - ../../base/security-tools
  - ../../base/network-policies
```

This structure allows us to manage common security components centrally and apply them consistently across clusters.

## Hardening Kubernetes: Core Configuration

With GitOps in place, we can start layering our security configurations.

### 1. Network Policies

Network Policies are fundamental for segmenting your cluster and enforcing least-privilege communication. Define these in Git.

```yaml
# kube-cluster-config/base/network-policies/default-deny.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: default # Apply to all namespaces, or specific ones
spec:
  podSelector: {} # Selects all pods
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Egress
```

Then, explicitly allow necessary traffic. For example, allowing ingress to a web application:

```yaml
# kube-cluster-config/base/network-policies/web-app-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-app-ingress
  namespace: my-webapp-ns
spec:
  podSelector:
    matchLabels:
      app: my-webapp
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: ingress-controller # From your ingress controller
        - ipBlock:
            cidr: 10.0.0.0/8 # Or from specific external IPs
      ports:
        - protocol: TCP
          port: 80
        - protocol: TCP
          port: 443
```

**Actionable Takeaway:** Start with a default-deny posture for both ingress and egress in all namespaces. Then, meticulously define allow-list policies for each application based on its actual communication requirements. Use a dedicated `network-policies` directory in your GitOps repository.

### 2. Pod Security Admission (PSA)

PSA is the built-in Kubernetes mechanism to enforce Pod Security Standards (PSS). PSS define three security profiles: `Privileged`, `Baseline`, and `Restricted`. We want to enforce `Restricted` where possible.

```yaml
# kube-cluster-config/base/security-tools/pod-security-admission.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-app-namespace
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

For namespaces that *must* run privileged workloads (e.g., certain infrastructure components), you can relax this:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged # Example for kube-system
```

**Actionable Takeaway:** Apply the `restricted` PSA profile to all application namespaces. Only relax it for critical infrastructure namespaces that genuinely require more privileges, and document those exceptions thoroughly.

### 3. Role-Based Access Control (RBAC)

RBAC is critical. Define granular roles and role bindings in Git. Avoid `cluster-admin` for applications or human users whenever possible.

```yaml
# kube-cluster-config/base/security-tools/app-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-app-reader
  namespace: my-webapp-ns
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-app-reader-binding
  namespace: my-webapp-ns
subjects:
  - kind: ServiceAccount
    name: my-app-service-account
    namespace: my-webapp-ns
roleRef:
  kind: Role
  name: my-app-reader
  apiGroup: rbac.authorization.k8s.io
```

**Actionable Takeaway:** Audit existing RBAC policies. Use tools like `kube-audit` or `polaris` during CI to identify overly permissive roles. Implement a policy of least privilege for ServiceAccounts and user roles.

## Runtime Security with eBPF

Even with robust preventative controls, threats can bypass them. This is where runtime security, powered by eBPF, becomes invaluable. eBPF allows us to observe and control kernel-level operations without modifying kernel code, providing unparalleled visibility and enforcement capabilities at near-native performance.

We'll use Falco as an example for eBPF-based runtime detection.

### 4. Deploying Falco with GitOps

Falco uses eBPF probes (or kernel modules) to monitor system calls and other kernel events, matching them against a set of rules to detect suspicious activity.

```yaml
# kube-cluster-config/base/security-tools/falco-helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: falco
  namespace: falco # Deploy Falco into its own namespace
spec:
  interval: 1h
  chart:
    spec:
      chart: falco
      version: "2.x.x" # Use a specific, stable version
      sourceRef:
        kind: HelmRepository
        name: falcosecurity
        namespace: flux-system
  values:
    falco:
      jsonOutput: true
      jsonOutputAutoTrim: true
      logLevel: info
    falcosidekick: # Optional, for sending alerts to external systems
      enabled: true
      webui:
        enabled: true
      # Configure outputs like Slack, PagerDuty, S3, etc.
      # For example:
      # slack:
      #   webhookurl: <YOUR_SLACK_WEBHOOK_URL>
    driver:
      kind: eBPF
      # Ensure eBPF is enabled and correctly configured for your kernel
      # Some cloud providers might require specific settings or kernel versions
```

```yaml
# kube-cluster-config/base/security-tools/falcosecurity-helmrepo.yaml
apiVersion: source.toolkit.fluxcd.io/v2beta1
kind: HelmRepository
metadata:
  name: falcosecurity
  namespace: flux-system
spec:
  interval: 1h
  url: https://falcosecurity.github.io/charts
```

### 5. Custom Falco Rules for Specific Threats

While Falco comes with a robust set of default rules, you'll want to tailor them to your environment and application behavior. Create custom rules and manage them via ConfigMaps, deployed with GitOps.

Example: Detecting shell execution in a web server pod (which should ideally never happen).

```yaml
# kube-cluster-config/base/security-tools/falco-custom-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-custom-rules
  namespace: falco
data:
  custom_rules.yaml: |
    - rule: Shell in Web Server
      desc: Detects an interactive shell spawning inside a web server container.
      condition: >
        container.name in (nginx, apache, caddy) and
        proc.name in (bash, sh, dash, zsh) and
        evt.type = execve and
        evt.is_privileged = false and
        container.id != host
      output: >
        Shell spawned in web server container (user=%user.name
        container=%container.name image=%container.image command=%proc.cmdline
        pod=%k8s.pod.name namespace=%k8s.ns.name)
      priority: CRITICAL
      tags: [container, shell, web]
```

To apply these custom rules, you'd configure the Falco HelmRelease to mount this ConfigMap.

```yaml
# ... inside your