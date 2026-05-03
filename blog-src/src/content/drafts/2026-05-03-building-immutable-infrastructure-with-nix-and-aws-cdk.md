---
title: "Building Immutable Infrastructure with Nix and AWS CDK"
date: 2026-05-03
category: "thought-leadership"
tags: []
excerpt: "As security and operations leaders, we've all wrestled with the challenges of mutable infrastructure. The \"snowflake\" servers, the undocumented change..."
---

# Building Immutable Infrastructure with Nix and AWS CDK

As security and operations leaders, we've all wrestled with the challenges of mutable infrastructure. The "snowflake" servers, the undocumented changes, the dreaded "it works on my machine" syndrome – these are not just annoyances; they're significant security risks and operational liabilities. Immutable infrastructure offers a powerful antidote, providing consistency, reproducibility, and a clear path to rollback.

Today, I want to dive into a practical approach for achieving immutable infrastructure, combining the declarative power of Nix with the infrastructure-as-code capabilities of AWS CDK. This pairing allows us to define our entire environment, from the operating system to application dependencies, and provision it reliably on AWS.

## Why Immutable Infrastructure?

Before we get into the "how," let's quickly recap the "why":

*   **Consistency:** Every deployment starts from a known, clean state, eliminating configuration drift.
*   **Reproducibility:** If you can build it once, you can build it a thousand times, identically. This is crucial for disaster recovery and scaling.
*   **Reliability:** Fewer manual changes mean fewer human errors. Rollbacks are simpler: just deploy the previous immutable image.
*   **Security:** A known, consistent state makes it easier to audit and harder for attackers to persist changes. If a server is compromised, you can simply replace it with a fresh, untainted instance.

## The Power Duo: Nix and AWS CDK

### Nix: The Reproducible System Builder

Nix is a purely functional package manager and system configuration tool. What sets it apart is its atomic upgrades and rollbacks, and its ability to build entire systems declaratively. Every package and configuration is built in isolation, ensuring that dependencies don't clash and builds are reproducible.

With Nix, we can define a complete server image, including the operating system, all libraries, and our application code, as a single, self-contained unit. This unit is then built into a Nix store path, which can be deployed.

### AWS CDK: Infrastructure as Code

AWS Cloud Development Kit (CDK) allows us to define our cloud infrastructure using familiar programming languages (TypeScript, Python, Java, Go, C#). It compiles down to CloudFormation, providing a robust, version-controlled way to manage our AWS resources.

By combining Nix and CDK, we can define our immutable server images *and* the AWS infrastructure that hosts them, all within a single, version-controlled repository.

## A Practical Example: Deploying a Simple Web Server

Let's walk through an example of deploying a simple web server (e.g., Nginx) as an immutable instance using Nix and AWS CDK.

### Step 1: Define the Immutable Server Image with Nix

First, we define our server's configuration using Nix. This will create an Amazon Machine Image (AMI) that we can launch.

Let's create a file named `ami.nix` (or similar) to define our system:

```nix
# ami.nix
{ pkgs, lib, ... }:

{
  # Define the base system
  imports = [ <nixpkgs/nixos/modules/virtualisation/amazon-image.nix> ];

  # System-wide configuration
  boot.loader.grub.enable = false;
  boot.loader.systemd-boot.enable = true; # Or grub, if preferred

  # Enable SSH for initial access (though we'll lock it down later)
  services.openssh.enable = true;

  # Install Nginx
  services.nginx.enable = true;
  services.nginx.virtualHosts."default" = {
    root = "/var/www";
    locations."/" = {
      extraConfig = ''
        return 200 "Hello from immutable NixOS on AWS!";
      '';
    };
  };

  # Define users
  users.users.admin = {
    isNormalUser = true;
    extraGroups = [ "wheel" ]; # For sudo access
    # Add your SSH public key here for initial access
    # openssh.authorizedKeys.keys = [ "ssh-rsa AAAAB3Nz..." ];
  };

  # Set timezone
  time.timeZone = "America/New_York";

  # Allow outbound HTTP/HTTPS for updates (if needed)
  networking.firewall.allowedOutPorts = [ 80 443 ];

  # For generating the AMI, we need a specific format
  virtualisation.amazon-image.ami.name = "my-nginx-immutable-server";
  virtualisation.amazon-image.ami.description = "Nginx server built with NixOS";
}
```

To build this into an AMI, you'd typically use a tool like `nix-build-ami` (a community tool) or a custom script that leverages `nixos-build-vms` and then uploads the resulting disk image to S3, registering it as an AMI. For simplicity in this blog post, let's assume we have a process that takes this `ami.nix` and produces an AMI ID.

**Actionable Takeaway:** Your `ami.nix` file is your single source of truth for the server's configuration. Version control this file!

### Step 2: Provision Infrastructure with AWS CDK

Now, let's use AWS CDK (TypeScript in this example) to define the EC2 instance, security groups, and other necessary infrastructure.

```typescript
// lib/my-immutable-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface MyImmutableStackProps extends cdk.StackProps {
  amiId: string; // The AMI ID generated from our Nix build
}

export class MyImmutableStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyImmutableStackProps) {
    super(scope, id, props);

    // Look up the default VPC (or create a new one)
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    // Define a Security Group for our web server
    const webSecurityGroup = new ec2.SecurityGroup(this, 'WebSG', {
      vpc,
      description: 'Allow HTTP access to web server',
      allowAllOutbound: true, // For updates/external calls
    });
    webSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');

    // Define the EC2 Instance
    const instance = new ec2.Instance(this, 'NginxImmutableInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.genericLinux({
        'us-east-1': props.amiId, // Use the AMI ID from our Nix build
        // Add other regions if needed
      }),
      securityGroup: webSecurityGroup,
      // Key pair for initial SSH access (optional, but recommended for debugging)
      // keyName: 'my-ssh-key-pair',
    });

    // Output the public IP address of the instance
    new cdk.CfnOutput(this, 'NginxPublicIp', {
      value: instance.instancePublicIp,
      description: 'Public IP address of the immutable Nginx server',
    });
  }
}
```

And your `bin/my-app.ts` to deploy:

```typescript
// bin/my-app.ts
import * as cdk from 'aws-cdk-lib';
import { MyImmutableStack } from '../lib/my-immutable-stack';

const app = new cdk.App();

// IMPORTANT: Replace with the actual AMI ID generated from your Nix build
const AMI_ID = 'ami-0abcdef1234567890'; // Placeholder - Get this from your Nix build process

new MyImmutableStack(app, 'ImmutableNginxStack', {
  amiId: AMI_ID,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

**Actionable Takeaway:** The `amiId` is the critical link. Your CI/CD pipeline should build the Nix image, get the AMI ID, and then pass it to the CDK deployment.

### Step 3: CI/CD Pipeline for Automation

This is where the magic truly happens. A robust CI/CD pipeline is essential for immutable infrastructure.

1.  **Code Commit:** Developer pushes changes to `ami.nix` or CDK code.
2.  **Nix Build:**
    *   CI system (e.g., GitLab CI, GitHub Actions, Jenkins) triggers a Nix build job.
    *   This job uses `nixos-build-vms` (or similar) to create the disk image.
    *   The disk image is uploaded to an S3 bucket.
    *   An AWS AMI is registered from the S3 object, and the AMI ID is captured.
3.  **CDK Deploy:**
    *   A subsequent CI job takes the captured AMI ID.
    *   It uses AWS CDK to deploy or update the stack, referencing the *new* AMI ID.
    *   This might involve creating new instances and gracefully terminating old ones (e.g., using an Auto Scaling Group with a rolling update policy, which we didn't show in the simple example but is crucial for production).

**Example CI/CD Snippet (Conceptual - GitHub Actions):**

```yaml
# .github/workflows/deploy.yml
name: Deploy Immutable Nginx

on:
  push:
    branches:
      - main
    paths:
      - 'ami.nix'
      - 'lib/**'
      - 'bin/**'

jobs:
  build-nix-ami:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Nix
        uses: cachix/install-nix-action@v22
        with:
          nix_path: nixpkgs=channel:nixos-23.11 # Or your desired channel

      - name: Build and Upload AMI
        id: ami_build
        run: |
          # This is a conceptual step. In reality, you'd use tools like
          # nix-build-ami or custom scripts to build ami.nix into an AWS AMI.
          # For demonstration, let's simulate.
          echo "Simulating AMI build and upload..."
          # Replace with actual build/upload logic and capture the real AMI ID
          SIMULATED_AMI_ID="ami-$(date +%s%N | sha256sum | head -c 17)"
          echo "Generated AMI ID: $SIMULATED_AMI_ID"
          echo "ami_id=$SIMULATED_AMI_ID" >> $GITHUB_OUTPUT
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets