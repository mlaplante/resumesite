---
title: "Unmasking Kubernetes Network Partitions with `netstat`, `ss`, and `tcpdump"
date: 2026-08-30
category: "thought-leadership"
tags: ["kubernetes", "networking", "debugging", "operations", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Network partitions in Kubernetes can be notoriously difficult to diagnose. A pod might be \"running\" according to kubectl get pods, but its application..."
---

# Unmasking Kubernetes Network Partitions with `netstat`, `ss`, and `tcpdump`

Network partitions in Kubernetes can be notoriously difficult to diagnose. A pod might be "running" according to `kubectl get pods`, but its application remains unreachable or exhibits sporadic connectivity issues. This often points to a deeper networking problem, where one part of your cluster can't communicate effectively with another. While Kubernetes provides high-level abstractions, sometimes you need to drop down to the host level and use classic Linux networking tools to uncover the truth.

In this post, we'll explore how to leverage `netstat`, `ss`, and `tcpdump` directly on Kubernetes nodes to debug network partitions. These tools, while venerable, remain indispensable for understanding the actual network state, bypassing the abstractions that can sometimes obscure the root cause.

## The Challenge: When `kubectl` Lies (or Omits)

Imagine a scenario: you have a `frontend` service trying to connect to a `backend` service. Some `frontend` pods can connect, others can't. `kubectl logs` shows connection timeouts. `kubectl describe pod` looks healthy. Where do you start?

The key is to remember that Kubernetes networking, at its core, is still Linux networking. Pods get IP addresses, communicate via virtual network interfaces, and traffic traverses the host's network stack, often involving `iptables` and CNI plugins. When things go wrong, the most reliable source of truth is often the network stack itself.

## Tool 1: `netstat` and `ss` – Peering into Socket States

`netstat` (and its faster, more modern successor `ss`) provide crucial insights into active network connections, listening sockets, and routing tables. When a network partition occurs, you'll often see connections stuck in a particular state (e.g., `SYN_SENT`, `CLOSE_WAIT`) or not established at all.

Let's say our `frontend` pod on `node-a` is trying to connect to a `backend` pod on `node-b`. We suspect `node-a` is having trouble reaching `node-b`.

### Actionable Takeaway: Checking Connection States

1.  **Identify the problematic pod and its node:**
    ```bash
    kubectl get pod <problematic-frontend-pod> -o wide
    # Output will show the Node where the pod is running, e.g., node-a
    ```

2.  **SSH into the node:**
    ```bash
    ssh node-a
    ```

3.  **Find the pod's network namespace:** Kubernetes pods run in their own network namespaces. To inspect their network stack, you need to execute commands within that namespace.
    ```bash
    # Get the PID of a process inside the problematic pod
    POD_NAME="<problematic-frontend-pod>"
    POD_NAMESPACE="default" # Or your pod's namespace
    POD_PID=$(kubectl exec -n $POD_NAMESPACE $POD_NAME -- ps aux | grep -v 'PID TTY' | awk '{print $1}' | head -n 1)
    
    # Alternatively, find the container ID and then the PID
    CONTAINER_ID=$(kubectl get pod $POD_NAME -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d'/' -f3)
    HOST_PID=$(sudo crictl inspect $CONTAINER_ID | grep -A1 "pid" | tail -n1 | awk '{print $2}' | tr -d ',')
    
    # Use nsenter to execute commands in the pod's network namespace
    # (assuming you have the correct PID, replace $HOST_PID if you used the first method)
    sudo nsenter -t $HOST_PID -n <command>
    ```
    *Self-correction: The `crictl` method is generally more robust for getting the *host* PID associated with the container's network namespace.*

4.  **Inside the pod's network namespace, use `ss` to check connections:**
    ```bash
    sudo nsenter -t $HOST_PID -n ss -tuanp
    ```
    *   **`-t`**: TCP sockets
    *   **`-u`**: UDP sockets
    *   **`-a`**: All sockets (listening and non-listening)
    *   **`-n`**: Numeric port numbers, don't resolve hostnames
    *   **`-p`**: Show process using socket

    **What to look for:**
    *   **`SYN_SENT`**: Your pod sent a SYN packet, but never received a SYN-ACK. This often indicates a firewall issue, routing problem, or the target service isn't listening/reachable.
    *   **`ESTAB`**: The connection is established. If you see this but the application still fails, the problem might be at the application layer, or data isn't flowing correctly *after* establishment (less common for partitions).
    *   **No entry for the target IP/port**: The pod isn't even attempting to connect, or its attempt failed so quickly it's not registered.

## Tool 2: `tcpdump` – The Packet-Level Truth

If `ss` shows `SYN_SENT` or no connection attempts, it's time to capture actual network traffic. `tcpdump` allows you to see packets flowing in and out of your node, or even within the pod's network namespace. This is where you confirm if packets are leaving the source, if they're arriving at the destination, and what their content looks like.

### Actionable Takeaway: Tracing Packet Flow

Let's refine our scenario: `frontend` on `node-a` (IP: `10.42.0.5`) trying to reach `backend` on `node-b` (IP: `10.42.1.10`) on port `8080`.

1.  **On `node-a` (source node), capture outgoing traffic from the `frontend` pod:**
    ```bash
    # Identify the pod's IP (e.g., 10.42.0.5)
    POD_IP="10.42.0.5" 

    # Capture traffic on the host's main network interface (e.g., eth0 or ensX)
    # Filter by source IP and destination IP/port
    sudo tcpdump -i any -nn host $POD_IP and host 10.42.1.10 and port 8080 -c 100
    ```
    *   **`-i any`**: Capture on all interfaces. You might want to be more specific (e.g., `cni0`, `eth0`) if you know the interface.
    *   **`-nn`**: Don't resolve hostnames or port names (faster and clearer for IPs).
    *   **`host <IP>`**: Filter by a specific IP address.
    *   **`port <PORT>`**: Filter by a specific port.
    *   **`-c 100`**: Capture 100 packets then exit.

    **What to look for:**
    *   **Are `SYN` packets leaving `node-a` from `10.42.0.5` to `10.42.1.10:8080`?** If not, the issue is before the host's main network stack (e.g., pod's `iptables`, CNI plugin misconfiguration on `node-a`).
    *   **Are there any `ICMP unreachable` messages?** This indicates a routing problem.

2.  **On `node-b` (destination node), capture incoming traffic destined for the `backend` pod:**
    ```bash
    # Identify the backend pod's IP (e.g., 10.42.1.10)
    BACKEND_POD_IP="10.42.1.10"

    # Capture traffic on the host's main network interface (e.g., eth0 or ensX)
    sudo tcpdump -i any -nn host $BACKEND_POD_IP and port 8080 -c 100
    ```
    **What to look for:**
    *   **Are the `SYN` packets from `10.42.0.5` arriving at `node-b`?**
        *   **If yes**: The network path between nodes is fine. The problem is likely within `node-b` (e.g., `iptables` dropping packets before they reach the pod, CNI issue on `node-b` preventing delivery to the pod's virtual interface, or the `backend` application isn't actually listening).
        *   **If no**: The problem is between `node-a` and `node-b`. This could be external network infrastructure, cloud provider networking, or a CNI routing issue (e.g., `kube-proxy` rules, routing table entries).

3.  **Inside the `backend` pod's network namespace on `node-b`, capture traffic:**
    ```bash
    # First, get the host PID for the backend pod (similar to step 3 for frontend)
    BACKEND_POD_PID=$(sudo crictl inspect $BACKEND_CONTAINER_ID | grep -A1 "pid" | tail -n1 | awk '{print $2}' | tr -d ',')

    # Capture traffic within the pod's namespace on its virtual interface (e.g., eth0)
    sudo nsenter -t $BACKEND_POD_PID -n tcpdump -i eth0 -nn port 8080 -c 100
    ```
    **What to look for:**
    *   **Are the `SYN` packets arriving at `eth0` *inside* the pod?**
        *   **If yes**: The network is delivering packets to the pod. The problem is almost certainly the application inside the pod not listening, or not responding correctly. You should see the application respond with a `SYN-ACK`. If you see `SYN` but no `SYN-ACK`, the application isn't listening or is misconfigured.
        *   **If no**: The packets are being dropped *after* arriving at `node-b` but *before* reaching the pod's network namespace. This strongly points to `iptables` rules on `node-b` or a CNI issue preventing the packet from being routed into the pod's namespace.

## Example Scenario: CNI Overlay Network Issue

Let's consider a practical example where `tcpdump` is invaluable. You're using a CNI like Calico or Flannel, and inter-node pod communication fails, but intra-node communication works.

1.  `frontend` (Node A: `10.42.0.5`) tries to reach `backend` (Node B: `10.42.1.10`).
2.  `ss` on `frontend` pod shows `SYN_SENT`.
3.  `tcpdump -i any host 10.42.0.5 and host 10.4