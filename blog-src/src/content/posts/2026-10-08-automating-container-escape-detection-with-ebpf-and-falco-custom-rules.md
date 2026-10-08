---
title: "Automating Container Escape Detection with eBPF and Falco Custom Rules"
date: 2026-10-08
category: "thought-leadership"
tags: ["ebpf", "falco", "container-security", "threat-detection", "kubernetes"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Containerization has revolutionized how we build and deploy applications, but it also introduced a new attack surface. One of the most critical..."
---

Containerization has revolutionized how we build and deploy applications, but it also introduced a new attack surface. One of the most critical threats is a container escape – an attacker breaking out of the container's isolation to gain access to the host system. Detecting these escapes quickly is paramount for maintaining system integrity.

Traditional detection methods often rely on analyzing container logs or host-level security tools, which can be reactive or lack the granular context needed for sophisticated attacks. This is where the power of eBPF and Falco shines. By combining eBPF's low-level kernel visibility with Falco's flexible rule engine, we can create a robust, real-time detection system for container escapes.

## The Power Duo: eBPF and Falco

**eBPF (extended Berkeley Packet Filter)** allows us to run sandboxed programs in the Linux kernel without modifying kernel source code or loading kernel modules. This provides unparalleled visibility into system calls, network events, and other kernel activities with minimal overhead. For container escape detection, eBPF can observe exactly what a process is doing, regardless of its container boundaries.

**Falco** is a cloud-native runtime security tool that uses eBPF (or kernel modules) to monitor system calls and then applies a powerful rule engine to detect suspicious activity. Falco provides a rich set of default rules, but its true strength lies in its extensibility through custom rules.

## Crafting Custom Rules for Container Escape Scenarios

Let's walk through a practical example: detecting an attacker attempting to mount the host's root filesystem from within a container. This is a common step in many container escape techniques.

First, we need to understand what system calls are involved. Mounting a filesystem typically involves the `mount` system call. If a containerized process attempts to mount a device or path that doesn't belong to its container's isolated filesystem, it's a strong indicator of an escape attempt.

Here's how we can build a Falco custom rule for this scenario.

### Step 1: Identify the System Call and Arguments

The `mount` system call has several arguments, including `source`, `target`, `filesystem type`, and `flags`. We're particularly interested in the `target` argument, as a container escape often involves mounting the host's root (`/`) or other sensitive host directories.

### Step 2: Define the Falco Rule

Falco rules are defined in YAML. We'll create a new rule that looks for `mount` system calls where the target path is a sensitive host directory and the event originates from a container.

Let's create a file named `custom_escape_rules.yaml`:

```yaml
# custom_escape_rules.yaml
- rule: Possible Host Mount Container Escape
  desc: Detects attempts to mount sensitive host directories from within a container.
  condition: |
    evt.type = mount and
    container.id != host and
    (fd.target = "/" or
     fd.target startswith "/etc" or
     fd.target startswith "/var" or
     fd.target startswith "/opt" or
     fd.target startswith "/root") and
    not proc.name in (docker, containerd, kubelet) # Exclude legitimate container runtime mounts
  output: >
    Container (ID: %container.id, Name: %container.name) attempted to mount a sensitive host directory
    (Target: %fd.target, Source: %fd.name, Type: %fd.type) from process %proc.name (PID: %proc.pid)
    on host %host.name.
  priority: CRITICAL
  tags: [container, escape, host, mount, security]
```

Let's break down this rule:

*   **`rule: Possible Host Mount Container Escape`**: A descriptive name for our rule.
*   **`desc`**: A detailed explanation of what the rule detects.
*   **`condition`**: This is the core logic.
    *   `evt.type = mount`: We're looking for `mount` system calls.
    *   `container.id != host`: This is crucial. It ensures the event is happening *inside* a container, not by a process directly on the host. Falco automatically enriches events with container context.
    *   `(fd.target = "/" or ...)`: We check if the target of the mount operation is a sensitive host path. You might expand this list based on your environment.
    *   `not proc.name in (docker, containerd, kubelet)`: We exclude processes that are legitimate container orchestrators or runtimes, as they might perform mounts on behalf of containers. This helps reduce false positives.
*   **`output`**: The message that Falco will generate when this rule is triggered. It includes valuable context like container ID, name, target path, and the process involved.
*   **`priority: CRITICAL`**: Assigns a severity level, useful for alerting and incident response.
*   **`tags`**: Helps categorize the rule.

### Step 3: Loading the Custom Rule

To load this rule, you typically place the `custom_escape_rules.yaml` file in a directory that Falco is configured to scan for rules (e.g., `/etc/falco/rules.d/`).

If you're running Falco as a Docker container, you might mount the rules directory:

```bash
docker run -i -t --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /dev:/dev \
    -v /etc/falco/falco.yaml:/etc/falco/falco.yaml \
    -v /etc/falco/rules.d/custom_escape_rules.yaml:/etc/falco/rules.d/custom_escape_rules.yaml \
    falcosecurity/falco:latest
```

For Kubernetes deployments, you would typically use a `ConfigMap` to provide the custom rules to the Falco DaemonSet.

### Step 4: Testing the Rule

Now, let's simulate an escape attempt to see our rule in action.

1.  **Run a privileged container:** A common prerequisite for many escape techniques is a privileged container.
    ```bash
    docker run -it --privileged ubuntu bash
    ```
2.  **Inside the container, attempt to mount the host root:**
    ```bash
    mkdir /host_root
    mount /dev/sda1 /host_root # Replace /dev/sda1 with your actual host root device
    ```
    (Note: The actual device name might vary. You can find it on the host with `df /` or `lsblk`.)

If Falco is running with our custom rule, you should see an alert similar to this in its output:

```
16:04:30.123456789: Critical Container (ID: <container_id>, Name: <container_name>) attempted to mount a sensitive host directory (Target: /host_root, Source: /dev/sda1, Type: ext4) from process mount (PID: 12345) on host <hostname>.
```

This alert provides immediate, actionable intelligence that a container escape attempt is underway.

## Expanding Detection Capabilities

This is just one example. You can extend this approach to detect other common container escape vectors:

*   **Writing to host paths:** Detecting attempts to write to sensitive host files (e.g., `/etc/shadow`, `/root/.ssh`) from within a container.
*   **Modifying host kernel modules:** Identifying attempts to load or unload kernel modules.
*   **Accessing host devices:** Monitoring access to raw host devices (`/dev/mem`, `/dev/kmem`, etc.).
*   **Sensitive capability usage:** Detecting containers using capabilities like `CAP_SYS_ADMIN` in unexpected ways.

## Takeaways and Best Practices

1.  **Start with common attack patterns:** Focus on well-known container escape techniques when crafting your initial custom rules.
2.  **Understand system calls:** Familiarize yourself with the system calls involved in specific attack vectors. `strace` is your friend here.
3.  **Leverage Falco's context:** Utilize fields like `container.id`, `container.name`, `proc.name`, `fd.target`, etc., to make your rules precise.
4.  **Minimize false positives:** Exclude legitimate activities by processes like container runtimes or known applications. Test thoroughly in a non-production environment.
5.  **Integrate with SIEM/Alerting:** Configure Falco to send alerts to your Security Information and Event Management (SIEM) system, PagerDuty, Slack, or other alerting tools for prompt response.
6.  **Continuous Improvement:** Threat landscapes evolve. Regularly review and update your custom rules to address new vulnerabilities and attack methods.

By combining the deep visibility of eBPF with the flexible rule engine of Falco, we can build a proactive and highly effective defense against container escapes, significantly enhancing the security posture of our containerized environments. This hands-on approach empowers security engineers to move beyond generic detections and craft specific, high-fidelity alerts tailored to their infrastructure's unique risks.