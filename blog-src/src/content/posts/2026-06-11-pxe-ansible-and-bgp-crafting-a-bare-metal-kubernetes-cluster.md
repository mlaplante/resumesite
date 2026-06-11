---
title: "PXE, Ansible, and BGP: Crafting a Bare-Metal Kubernetes Cluster"
date: 2026-06-11
category: "thought-leadership"
tags: []
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "In the world of cloud-native infrastructure, the allure of bare metal remains strong for those seeking ultimate control, performance, and cost efficie..."
---

# PXE, Ansible, and BGP: Crafting a Bare-Metal Kubernetes Cluster

In the world of cloud-native infrastructure, the allure of bare metal remains strong for those seeking ultimate control, performance, and cost efficiency. While managed Kubernetes services abstract away much of the underlying complexity, building your own bare-metal Kubernetes cluster offers invaluable insights into the stack and provides a foundation for highly optimized workloads. This post will walk you through the practical engineering steps of automating the deployment of a bare-metal Kubernetes cluster using a powerful trio: PXE for network booting, Ansible for configuration management, and BGP for robust network routing.

## Why Bare Metal?

Before diving into the "how," let's briefly touch on the "why." Bare metal gives you:

*   **Predictable Performance:** No noisy neighbors, direct access to hardware resources.
*   **Cost Control:** Eliminates cloud provider markups for compute and storage.
*   **Customization:** Full control over hardware, kernel, and software stack.
*   **Learning Opportunity:** A deep dive into networking, operating systems, and Kubernetes internals.

This approach is particularly beneficial for high-performance computing, data processing, and applications with strict latency requirements.

## The Architecture Overview

Our bare-metal Kubernetes cluster will consist of several physical servers (or VMs if you're simulating). We'll designate one or more as control plane nodes and others as worker nodes. The key components of our automation stack are:

1.  **PXE Server (TFTP/DHCP):** For network booting and OS installation.
2.  **HTTP Server:** To serve installation media (e.g., Ubuntu `preseed.cfg` files).
3.  **Ansible Control Host:** To orchestrate post-installation configuration.
4.  **BGP Router(s):** To announce Kubernetes service IPs and provide external connectivity.

Let's assume we have a dedicated management network and a data network for our cluster nodes.

## Step 1: Setting Up PXE Boot and OS Installation

The first hurdle with bare metal is getting an operating system onto the servers. PXE (Preboot eXecution Environment) is our friend here. We'll set up a DHCP server to provide network configuration and a TFTP server to deliver bootloaders and kernel images.

**Prerequisites:** A dedicated server (physical or VM) to act as your PXE/HTTP server. We'll use Ubuntu Server for this example.

```bash
# On your PXE/HTTP server
sudo apt update
sudo apt install -y isc-dhcp-server tftpd-hpa nginx
```

**DHCP Configuration (`/etc/dhcp/dhcpd.conf`):**

```dhcp
# Basic DHCP configuration
subnet 192.168.1.0 netmask 255.255.255.0 {
    range 192.168.1.100 192.168.1.200;
    option routers 192.168.1.1;
    option domain-name-servers 8.8.8.8;
    filename "pxelinux.0"; # Bootloader for PXE
    next-server 192.168.1.10; # IP of your TFTP server
}

# Host-specific configurations for your bare metal nodes
# Replace MAC addresses and IPs with your actual server details
host k8s-master-01 {
    hardware ethernet 00:11:22:33:44:55;
    fixed-address 192.168.1.101;
}
host k8s-worker-01 {
    hardware ethernet AA:BB:CC:DD:EE:FF;
    fixed-address 192.168.1.102;
}
# ... add more hosts
```

**TFTP Configuration:**

We need to copy the PXE bootloader and kernel images. For Ubuntu, you'd typically download the `netboot` tarball.

```bash
# On your PXE/HTTP server
sudo mkdir -p /srv/tftp
cd /srv/tftp
wget http://archive.ubuntu.com/ubuntu/dists/focal/main/installer-amd64/current/images/netboot/netboot.tar.gz
sudo tar -xzf netboot.tar.gz
sudo mv ubuntu-installer/amd64/* . # Move necessary files to /srv/tftp
```

Create a PXE boot menu file (`/srv/tftp/pxelinux.cfg/default`):

```
DEFAULT install
PROMPT 0
TIMEOUT 0

LABEL install
    MENU LABEL ^Install Ubuntu Server
    KERNEL ubuntu-installer/amd64/linux
    APPEND vga=normal initrd=ubuntu-installer/amd64/initrd.gz \
           url=http://192.168.1.10/preseed/ubuntu-server.seed \
           hostname=<hostname> \
           interface=auto \
           netcfg/dhcp_timeout=60 \
           netcfg/choose_interface=auto \
           # Optionally add `ip=192.168.1.101::192.168.1.1:255.255.255.0:k8s-master-01:eth0:none` for static IP
           # For simplicity, we'll let DHCP assign temporary IPs, then Ansible will manage static IPs.
```

**HTTP Server for Preseed Files:**

The `preseed.cfg` file automates the Ubuntu installation. Place it in `/var/www/html/preseed/ubuntu-server.seed` on your HTTP server.

```ini
# Example preseed.cfg (simplified for brevity)
d-i debian-installer/locale string en_US
d-i keyboard-configuration/xkb-model string pc105
d-i keyboard-configuration/xkb-layouts select us
d-i netcfg/get_hostname string <hostname>
d-i netcfg/get_domain string local
d-i netcfg/dhcp_timeout string 60
d-i mirror/country string manual
d-i mirror/http/hostname string archive.ubuntu.com
d-i mirror/http/directory string /ubuntu
d-i mirror/http/proxy string
d-i time/zone string UTC
d-i clock-setup/ntp boolean true
d-i partman-auto/disk string /dev/sda
d-i partman-auto/method string lvm
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true
d-i partman-auto-lvm/guided_size string max
d-i partman-partitioning/confirm_write_changes boolean true
d-i partman/confirm boolean true
d-i passwd/root-login boolean true
d-i passwd/root-password password yourrootpassword
d-i passwd/root-password-again password yourrootpassword
d-i user-setup/encrypt-home boolean false
d-i user-setup/allow-password-weak boolean true
d-i user-setup/fullname string Kubernetes Admin
d-i user-setup/username string k8sadmin
d-i passwd/user-password password youruserpassword
d-i passwd/user-password-again password youruserpassword
d-i ssh-server/install boolean true
d-i pkgsel/update-policy select unattended-upgrades
d-i pkgsel/install-language-support boolean false
d-i grub-installer/only_debian boolean true
d-i finish-install/reboot_in_progress boolean true
```

**Actionable Takeaway:** With PXE, DHCP, and TFTP configured, your bare-metal servers will now boot, fetch an IP, download the kernel, and then pull the `preseed.cfg` to automate the OS installation. Power on your bare-metal nodes and watch them install Ubuntu Server!

## Step 2: Ansible for Kubernetes Deployment

Once your nodes have a base OS, Ansible takes over. We'll use it to configure static IPs, install Docker/containerd, set up `kubeadm`, and deploy the Kubernetes cluster.

**Prerequisites:** An Ansible control host (can be the PXE server or a separate machine) with SSH access to all bare-metal nodes. Ensure SSH keys are set up for passwordless authentication.

**Ansible Inventory (`inventory.ini`):**

```ini
[all:vars]
ansible_user=k8sadmin
ansible_ssh_private_key_file=~/.ssh/id_rsa

[kube_control_plane]
k8s-master-01 ansible_host=192.168.1.101

[kube_node]
k8s-worker-01 ansible_host=192.168.1.102
k8s-worker-02 ansible_host=192.168.1.103 # Add more workers as needed

[k8s_cluster:children]
kube_control_plane
kube_node
```

**Ansible Playbooks (High-level Outline):**

1.  **`01-initial-setup.yml`**:
    *   Configure static IP addresses (important for bare metal).
    *   Disable swap.
    *   Install common utilities.
    *   Set up NTP.

    ```yaml
    # tasks/configure_network.yml
    - name: Configure static IP for {{ inventory_hostname }}
      ansible.builtin.template:
        src: netplan.yaml.j2
        dest: /etc/netplan/01-netcfg.yaml
      notify: apply netplan

    # handlers/main.yml
    - name: apply netplan
      ansible.builtin.command: netplan apply
    ```

2.  **`02-container-runtime.yml`**:
    *   Install `containerd` (or Docker).
    *   Configure `containerd` to use `systemd` cgroup driver.
    *   Enable and start `containerd` service.

3.  **`03-kubernetes-components.yml`**:
    *   Add Kubernetes apt repository.
    *   Install `kubelet`, `kubeadm`, `kubectl`.
    *   Hold package versions to prevent accidental upgrades.

4.  **`04-kubeadm-init.yml` (Control Plane Only)**:
    *   Initialize the Kubernetes control plane using `kubeadm init`.
    *   Copy `kubeconfig` to `/home/k8sadmin/.kube/config`.
    *   Generate a `kubeadm join` command for worker nodes.

    ```yaml
    # tasks/kubeadm_init.yml (on control plane)
    - name: Initialize Kubernetes control plane
      ansible.builtin.command: >
        kubeadm init --pod-network-