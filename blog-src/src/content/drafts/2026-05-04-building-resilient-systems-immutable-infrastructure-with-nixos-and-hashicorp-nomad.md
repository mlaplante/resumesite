---
title: "Building Resilient Systems: Immutable Infrastructure with NixOS and HashiCorp Nomad"
date: 2026-05-04
category: "thought-leadership"
tags: []
excerpt: "In the world of modern infrastructure, the pursuit of reliability, predictability, and efficiency is constant. One paradigm that has gained significan..."
---

# Building Resilient Systems: Immutable Infrastructure with NixOS and HashiCorp Nomad

In the world of modern infrastructure, the pursuit of reliability, predictability, and efficiency is constant. One paradigm that has gained significant traction in achieving these goals is **immutable infrastructure**. The core idea is simple: once a server or component is deployed, it is never modified. If a change is needed, a new, updated component is built and deployed, replacing the old one. This approach drastically reduces configuration drift, simplifies rollbacks, and enhances the consistency of your environments.

Today, I want to dive into a powerful combination for implementing immutable infrastructure: **NixOS** and **HashiCorp Nomad**. NixOS provides a unique, declarative, and reproducible way to define your entire operating system, while Nomad offers a flexible and efficient orchestrator for deploying and managing applications across a cluster.

## Why Immutable Infrastructure? The Pain Points It Solves

Before we get into the "how," let's quickly reiterate the "why." What problems does immutable infrastructure solve?

1.  **Configuration Drift:** Ever had a production server that was "special" because someone logged in and manually installed a package or tweaked a config file? Over time, these manual changes accumulate, making environments inconsistent and difficult to troubleshoot.
2.  **"Works on My Machine" Syndrome:** Without a consistent build process, differences between development, staging, and production can lead to unexpected issues.
3.  **Difficult Rollbacks:** If a deployment goes wrong, rolling back mutable infrastructure often involves trying to reverse manual changes or restoring backups, which can be time-consuming and error-prone.
4.  **Security Vulnerabilities:** Manually patched systems can miss critical updates, leading to security gaps. Immutable infrastructure ensures all components are built from a known, secure state.
5.  **Scaling Challenges:** As you scale, managing individual mutable servers becomes a nightmare. Immutable infrastructure makes it easier to spin up identical new instances.

## NixOS: The Ultimate Declarative OS

NixOS is a Linux distribution built around the [Nix package manager](https://nixos.org/manual/nix/stable/). What makes it revolutionary for immutable infrastructure is its entirely declarative configuration model. Every aspect of your system – from the kernel version and installed packages to system services and user accounts – is defined in a single, atomic configuration file (or a set of files).

When you build a NixOS system, Nix ensures that all dependencies are precisely specified and isolated. The result is a **closure** – a self-contained set of all necessary components. When you boot NixOS, it's booting into a specific, cryptographically hashed generation of your system configuration.

**Key benefits of NixOS for immutability:**

*   **Atomic Upgrades/Rollbacks:** A new configuration is an entirely new generation. If something breaks, you can instantly roll back to a previous working generation at boot time.
*   **Reproducibility:** Given the same Nix configuration, you will always get the exact same system, byte for byte. This eliminates "works on my machine" issues at the OS level.
*   **Declarative Configuration:** Define *what* your system should look like, not *how* to build it.
*   **No Configuration Drift:** Because the system is built from a declarative definition, manual changes are ephemeral and reset on reboot (or simply overwritten by the next deployment).

### A Glimpse at NixOS Configuration

Here's a simplified `configuration.nix` for a basic server:

```nix
# /etc/nixos/configuration.nix
{ config, pkgs, ... }:

{
  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  # Networking
  networking.hostName = "nomad-client-01";
  networking.interfaces.eth0.useDHCP = true;

  # Enable SSH
  services.openssh.enable = true;
  # Allow root login for initial setup, but disable in production!
  services.openssh.permitRootLogin = "yes";

  # Add your public SSH key for user michael
  users.users.michael = {
    isNormalUser = true;
    extraGroups = [ "wheel" ]; # A group that can use sudo
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3Nz...michael@laptop"
    ];
  };

  # Essential packages
  environment.systemPackages = with pkgs; [
    git
    vim
    htop
    curl
    wget
  ];

  # Set your time zone.
  time.timeZone = "America/New_York";

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # are inherited.
  system.stateVersion = "23.11"; # Don't change this value unless you know what you're doing.

  # Enable the Nomad client service
  services.nomad = {
    enable = true;
    client.enable = true;
    # Configure the Nomad client to connect to your Nomad servers
    settings = {
      data_dir = "/var/lib/nomad";
      client = {
        servers = [ "192.168.1.10:4647", "192.168.1.11:4647" ]; # Replace with your Nomad server IPs
        network_interface = "eth0"; # Or your specific interface
      };
      # Optional: ACL token for client registration
      # acl = {
      #   token = "your-client-acl-token";
      # };
    };
  };
}
```

To apply this configuration, you'd run `nixos-rebuild switch`. This command will build a new system generation and atomically switch to it. If it fails, you can easily `nixos-rebuild switch --rollback` or select a previous generation from the bootloader.

## HashiCorp Nomad: Orchestration for Immutable Workloads

While NixOS gives us immutable servers, we still need a way to deploy and manage our applications on those servers. This is where HashiCorp Nomad shines. Nomad is a lightweight, flexible, and highly performant workload orchestrator that can run any containerized, virtualized, or standalone application.

Nomad's strength lies in its simplicity and versatility. It's not just for Docker containers; it can schedule Java JARs, Go binaries, QEMU VMs, and more. This makes it a great choice for environments where you might have a mix of workloads.

**Key benefits of Nomad for immutable infrastructure:**

*   **Application Deployment:** Nomad defines applications as "jobs" using HCL (HashiCorp Configuration Language). These jobs specify what to run, where to run it, and how it should behave.
*   **Service Discovery & Load Balancing:** Integrates seamlessly with HashiCorp Consul for service discovery and automatically registers/deregisters applications as they come and go.
*   **Health Checks & Self-Healing:** Nomad continuously monitors the health of your applications and can automatically reschedule unhealthy tasks.
*   **Resource Management:** Efficiently packs workloads onto available client nodes, maximizing resource utilization.
*   **Simple to Operate:** Compared to more complex orchestrators, Nomad is known for its operational simplicity.

### A Basic Nomad Job Definition

Here's an example of a Nomad job that deploys a simple Nginx web server as a Docker container:

```hcl
# nginx-web.nomad
job "nginx-web" {
  datacenters = ["dc1"]
  type        = "service"

  update {
    max_parallel = 1
    min_healthy_time = "10s"
    healthy_deadline = "5m"
    auto_revert = true
    canary = 0
  }

  group "web" {
    count = 3 # Run 3 instances of Nginx

    network {
      port "http" {
        to = 80
      }
    }

    task "nginx" {
      driver = "docker"

      config {
        image = "nginx:stable-alpine"
        ports = ["http"]
      }

      resources {
        cpu    = 100 # 100 MHz
        memory = 64 # 64 MB
      }

      service {
        name = "nginx-web"
        port = "http"
        tags = ["web", "http"]

        check {
          type     = "http"
          path     = "/"
          interval = "10s"
          timeout  = "2s"
        }
      }
    }
  }
}
```

To deploy this job, you would run `nomad job run nginx-web.nomad`. Nomad will then find suitable NixOS client nodes and schedule the Nginx containers.

## Bringing It All Together: Immutable Infrastructure Workflow

Here's how NixOS and Nomad combine to create a robust immutable infrastructure workflow:

1.  **Define Base NixOS Images:**
    *   Create a base NixOS configuration for your Nomad clients. This includes the NixOS system itself, the Nomad client service enabled, Docker (if you're using containers), and any other core utilities.
    *   Build this configuration into a bootable image (e.g., an ISO for VMs, an AMI for AWS, a raw disk image for bare metal).
    *   Store these image definitions and their resulting hashes in version control.

2.  **Provision Immutable Nomad Clients:**
    *   When you need a new Nomad client, provision a new VM or server *from scratch* using your defined NixOS base image.
    *   Crucially, you don't log in and configure it manually. It boots directly into the desired state defined by NixOS.
    *   The Nomad client service starts automatically and registers itself with your Nomad servers.

3.  **Define and Deploy Applications with Nomad:**
    *   Your applications are defined as Nomad jobs (e.g., Docker containers, Java apps).
    *   These job definitions are also stored in version control.
    *   Deploy or update applications by submitting new or updated job files to Nomad. Nomad handles scheduling, health checks, and rollouts.

4.  **Updates and Rollbacks:**
    *   **OS Updates (NixOS):** To update the underlying OS or change system services, you modify your NixOS configuration, build a *new* NixOS image, and then replace existing client nodes with new ones built from this updated image. This can be done in a rolling fashion, similar to how you'd update application deployments.
    *   **Application Updates (Nomad):** To update an application, you modify its Nomad job definition (e.g., change the Docker image tag) and resubmit it. Nomad performs a rolling update, replacing old instances with new ones.
    *   **Rollback:** If an OS update causes issues, you can provision new nodes from a previous, known-good NixOS image. If an application update fails, Nomad's `auto_revert` feature or a simple `nomad job revert` command can roll it back.

## Practical Considerations and Takeaways

*   **Networking:** Ensure your NixOS clients can reach your Nomad servers (and Consul servers if you're using it).