---
title: "Debugging Multi-Cloud Kubernetes with Cilium and Kube-Slice"
date: 2026-10-10
category: "thought-leadership"
tags: ["kubernetes", "cilium", "multi-cloud", "networking", "debugging", "ebpf"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Building robust, scalable applications across multiple Kubernetes clusters in different cloud providers presents a unique set of networking..."
---

Building robust, scalable applications across multiple Kubernetes clusters in different cloud providers presents a unique set of networking challenges. When you layer on advanced networking solutions like Cilium for eBPF-powered CNI and `kube-slice` for secure, multi-cluster network segmentation, the complexity multiplies. While powerful, this stack can lead to some head-scratching moments when things don't quite work as expected.

In this post, we'll walk through a hypothetical, yet all too common, debugging scenario involving a multi-cloud Kubernetes network mesh built with Cilium and `kube-slice`. We'll focus on practical, hands-on techniques to pinpoint and resolve connectivity issues.

## The Scenario: Inter-Cluster Service Communication Failure

Imagine we have two Kubernetes clusters: `cluster-aws` in AWS and `cluster-gcp` in GCP. Both are running Cilium as their CNI, and we've deployed `kube-slice` to create a secure, segmented network mesh between them. Our goal is for a service `frontend-app` in `cluster-aws` to securely communicate with a service `backend-api` in `cluster-gcp`.

Suddenly, `frontend-app` starts reporting connection timeouts when trying to reach `backend-api`. There have been no recent code changes to either application, leading us to suspect a networking issue within our multi-cloud mesh.

### Initial Triage: Where to Look First?

Before diving deep, let's establish a baseline and narrow down the problem space.

1.  **Application Logs:** Confirm the timeouts are indeed network-related. Are there specific error messages?
    ```bash
    kubectl logs -n default deployment/frontend-app -f
    ```
    (Expected: "connection timed out to backend-api.default.svc.clusterset.local")

2.  **Basic Connectivity within Clusters:** Can `frontend-app` reach other services within `cluster-aws`? Can `backend-api` be reached by other services within `cluster-gcp`? This helps isolate the problem to inter-cluster communication.
    ```bash
    # In cluster-aws
    kubectl exec -it deployment/frontend-app -- curl http://some-local-service:8080
    # In cluster-gcp
    kubectl exec -it deployment/backend-api -- curl http://some-other-local-service:8080
    ```
    If these work, the issue is almost certainly with the `kube-slice` or Cilium configuration for inter-cluster traffic.

## Deep Dive: Debugging `kube-slice` Connectivity

`kube-slice` essentially creates a secure tunnel (typically WireGuard) between clusters and manages the routing of traffic across these tunnels.

### 1. Verify `kube-slice` Pods and Status

Check if the `kube-slice` controller and gateway pods are healthy in both clusters.
```bash
# In both clusters
kubectl get pods -n kube-slice-system
```
Look for any pods in `CrashLoopBackOff` or `Error` states. Check their logs.
```bash
kubectl logs -n kube-slice-system deployment/kube-slice-controller
kubectl logs -n kube-slice-system deployment/kube-slice-gateway
```

### 2. Inspect `kube-slice` Network Slices

`kube-slice` uses a custom resource called `NetworkSlice` to define the network segments that are exposed between clusters.
```bash
# In both clusters
kubectl get networkslices -n kube-slice-system
kubectl describe networkslices backend-api-slice -n kube-slice-system
```
Ensure the `backend-api-slice` (or whatever your slice for the backend is named) exists in both clusters and its status indicates it's `Ready` and has learned the appropriate endpoints. Look at the `Status.Gateways` and `Status.Endpoints` fields. The `backend-api` service's IP should be listed as an endpoint in `cluster-gcp`'s slice, and `cluster-aws`'s slice should show `cluster-gcp`'s gateway.

### 3. Check WireGuard Tunnel Status

`kube-slice` gateways often use WireGuard for secure tunnels. You can inspect the WireGuard interface directly on the gateway pods.
```bash
# In both clusters, exec into the kube-slice-gateway pod
kubectl exec -it -n kube-slice-system deployment/kube-slice-gateway -- wg show
```
Look for:
*   **`interface: wg0`**: Confirms the interface exists.
*   **`peer: <public-ip-of-other-gateway>`**: Confirms the peer is configured.
*   **`endpoint: <public-ip-of-other-gateway>:51820`**: Confirms the endpoint.
*   **`latest handshake: ...`**: A recent handshake indicates the tunnel is active. If this is missing or very old, the tunnel is down.
*   **`transfer: ...`**: Data transfer confirms traffic is flowing.

If handshakes are not happening, check:
*   **Firewall rules:** Is the WireGuard port (default 51820 UDP) open between the gateway nodes' public IPs in both AWS and GCP? This is a common multi-cloud misconfiguration.
*   **Security Groups/Network ACLs:** Ensure the cloud provider's network security allows UDP 51820 between the gateway nodes.

### 4. Route Table Inspection on Gateway Nodes

`kube-slice` modifies the routing tables on the gateway nodes to direct inter-cluster traffic through the WireGuard tunnels.
```bash
# In both clusters, exec into the kube-slice-gateway pod
kubectl exec -it -n kube-slice-system deployment/kube-slice-gateway -- ip route show
```
You should see routes pointing to the remote cluster's service CIDR (or specific service IPs) via the `wg0` interface. For example, in `cluster-aws`, you might see a route like:
```
10.244.1.0/24 dev wg0 scope link
```
where `10.244.1.0/24` is the pod CIDR of `cluster-gcp` (or a specific IP range for `backend-api`).

## Deep Dive: Debugging Cilium and eBPF

Cilium, with its eBPF magic, handles the actual packet forwarding and policy enforcement within and across clusters (when integrated with `kube-slice`).

### 1. Cilium Connectivity Test

Cilium provides a built-in connectivity test that's invaluable for diagnosing networking issues.
```bash
# In both clusters
cilium connectivity test
```
This will deploy a series of test pods and run various connectivity checks. Pay close attention to any failures, especially those related to cross-node or cross-cluster communication.

### 2. Cilium Monitor

The `cilium monitor` command gives you a real-time view of packets being processed by Cilium's eBPF programs.
```bash
# In cluster-aws, from a node where frontend-app is running
cilium monitor --type drop --related-to pod:frontend-app
```
This will show you any packets dropped by Cilium, along with the reason. Look for drops related to `frontend-app` trying to reach `backend-api`. Common drop reasons include:
*   `Policy denied`: Indicates a Cilium Network Policy is blocking the traffic.
*   `Invalid source IP`: Could mean an IP address spoofing or routing issue.
*   `Host unreachable`: Suggests a routing problem at a lower level.

You can also monitor all traffic:
```bash
# In cluster-aws, from a node where frontend-app is running
cilium monitor --type all --related-to pod:frontend-app
```
This will show you if packets are even leaving the `frontend-app` pod and, if so, where they are being routed.

### 3. Cilium Endpoint Status

Cilium manages endpoints for each pod. Ensure the `frontend-app` and `backend-api` pods have healthy Cilium endpoints.
```bash
# In cluster-aws
cilium endpoint list | grep frontend-app
# In cluster-gcp
cilium endpoint list | grep backend-api
```
Look for `status: ready`. If an endpoint is not ready, check its logs (`cilium endpoint get <id> -o jsonpath='{.status.log}'`).

### 4. Cilium Network Policy Enforcement

If `cilium monitor` shows `Policy denied`, you need to investigate your Cilium Network Policies.
```bash
# In cluster-gcp, check policies affecting backend-api
kubectl get cnp -n default
kubectl describe cnp <policy-name> -n default
```
Ensure there's a policy allowing incoming connections from the `frontend-app`'s namespace/label or, more generically, from the `kube-slice` ingress. When using `kube-slice`, traffic often enters the remote cluster via the gateway pod, so policies might need to account for this.

A common pattern for `kube-slice` is to allow traffic from the `kube-slice` gateway's IP or a specific label that `kube-slice` applies to its traffic. For instance, you might need a policy like:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-kube-slice-ingress-to-backend
  namespace: default
spec:
  endpointSelector:
    matchLabels:
      app: backend-api
  ingress:
  - fromEndpoints:
    - matchLabels:
        io.cilium.k8s.policy.serviceaccount: kube-slice-gateway # Or similar label applied by kube-slice
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
```
*Note: The exact labels or selectors for `kube-slice` gateway traffic may vary based on your `kube-slice` version and configuration.*

### 5. `cilium-sysdump` for Comprehensive Data

When you're truly stumped, `cilium-sysdump` is your best friend. It collects a vast amount of diagnostic information from your Cilium agents and Kubernetes environment.
```bash
cilium-sysdump
```
This command generates a tarball with logs, eBPF maps, network configurations, and more. While reviewing it manually can be daunting, it's invaluable for support requests and for systematically exploring all relevant configurations.

## Conclusion

Debugging multi-cloud Kubernetes networking with advanced tools like Cilium and `kube-slice` requires a methodical approach. By systematically checking the health of your `kube-slice` components, verifying WireGuard tunnels, inspecting routing tables, and leveraging Cilium's powerful eBPF visibility tools, you can quickly narrow down and resolve even the most elusive connectivity issues.

Remember to always start with the basics (logs, pod status), then move to `kube-slice` specific components, and finally dive into the granular details provided by Cilium's observability tools. With practice, you'll find that these complex systems, while challenging, offer incredible insight and control over your network.