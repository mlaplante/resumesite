---
title: "Building Immutable Infrastructure with Nix and AWS CDK"
date: 2026-05-13
category: "thought-leadership"
tags: []
excerpt: "As security professionals and engineers, we constantly strive for greater reliability, consistency, and security in our systems. One of the most power..."
---

# Building Immutable Infrastructure with Nix and AWS CDK

As security professionals and engineers, we constantly strive for greater reliability, consistency, and security in our systems. One of the most powerful paradigms to achieve these goals is **immutable infrastructure**. The core idea is simple: once a server or component is deployed, it is never modified in place. Instead, any update or change triggers the creation of a brand new instance, replacing the old one.

This approach eliminates configuration drift, simplifies rollbacks, and makes your infrastructure significantly more predictable. But how do you practically achieve this, especially when dealing with complex cloud environments?

Today, I want to share a powerful combination that I've found incredibly effective for building truly immutable infrastructure: **Nix** for defining reproducible server images and **AWS CDK** for orchestrating their deployment in AWS.

## The Challenge of Mutable Infrastructure

Let's quickly recap why mutable infrastructure is problematic:

*   **Configuration Drift:** Over time, manual changes, patches, or ad-hoc scripts can lead to differences between instances that were supposedly identical. This makes debugging and scaling a nightmare.
*   **Lack of Reproducibility:** If you can't reliably recreate an environment from scratch, you can't trust your deployments or disaster recovery plans.
*   **Security Vulnerabilities:** Patching in place is often rushed, inconsistent, and can leave systems vulnerable if a step is missed.
*   **Difficult Rollbacks:** If a change introduces a bug, reverting it often means trying to undo a series of modifications, which is error-prone.

## Nix: The Ultimate Tool for Reproducible Systems

Nix is a purely functional package manager and a powerful tool for building reproducible systems. What makes Nix revolutionary is its approach to dependency management and system configuration:

*   **Atomic Updates:** Every package and configuration is built into a unique path in the Nix store (e.g., `/nix/store/hash-package-version`). This means updates never overwrite existing files; they create new ones.
*   **Rollbacks are Trivial:** Because old versions are never deleted, you can instantly roll back to a previous system state if something goes wrong.
*   **Hermetic Builds:** Nix ensures that builds are hermetic, meaning they only depend on their declared inputs. This eliminates "works on my machine" syndrome.
*   **Declarative Configuration:** You define your entire system (packages, services, users, kernel modules, etc.) in a declarative Nix expression.

When applied to server images, Nix allows you to define an entire operating system, including all its packages and configurations, in a single, reproducible derivation. This derivation can then be built into an Amazon Machine Image (AMI).

### Example: A Simple NixOS EC2 Image

Let's say we want an EC2 instance running Nginx. Using NixOS (the Linux distribution built on Nix), our configuration might look something like this:

```nix
# default.nix
{ config, pkgs, lib, ... }:

{
  # Basic system configuration
  imports = [ <nixpkgs/nixos/modules/virtualisation/amazon-image.nix> ];

  # Set host name
  networking.hostName = "immutable-nginx-server";

  # Enable SSH and allow root login (for initial setup/debugging, consider IAM roles later)
  services.openssh.enable = true;
  # services.openssh.permitRootLogin = lib.mkDefault true; # Uncomment for root login

  # Enable and configure Nginx
  services.nginx = {
    enable = true;
    virtualHosts."default" = {
      enable = true;
      root = "/var/www";
      locations."/" = {
        extraConfig = ''
          index index.html;
        '';
      };
    };
  };

  # Create a simple index.html
  systemd.tmpfiles.rules = [
    "f /var/www/index.html - - - - <h1>Hello from Immutable NixOS Nginx!</h1>"
  ];

  # Allow inbound HTTP and SSH traffic (for security groups to open)
  networking.firewall.allowedTCPPorts = [ 80 22 ];

  # Cloud-init for initial setup (e.g., setting a password or adding users)
  # For AMIs, cloud-init is often used to inject SSH keys or run initial scripts.
  # For NixOS AMIs, this might be less critical as configuration is baked in.
  # However, it's still useful for things like user management.
  # users.users.admin = {
  #   isSudoer = true;
  #   hashedPassword = "$6$salt$hash"; # Replace with a strong hash
  # };
}
```

To build an AMI from this, you'd typically use `nix-build` with a `nixpkgs` overlay that defines the `amazon-image` module. The output would be an `.ami` file path or a direct upload to AWS if configured.

The key takeaway: this Nix expression *fully defines* the server. Every package, every service, every configuration parameter is explicit. No more "ssh'ing in and apt-getting something."

## AWS CDK: Orchestrating Immutable Deployments

While Nix gives us the power to build reproducible server images, AWS CDK (Cloud Development Kit) allows us to define and deploy our AWS infrastructure programmatically using familiar programming languages (TypeScript, Python, Java, C#, Go).

CDK is fantastic for immutable infrastructure because it treats your cloud resources as code. You define your desired state, and CDK translates that into CloudFormation templates, which are then deployed. If you change your CDK code, CDK figures out the minimal set of changes required to update your infrastructure.

Combining Nix and CDK, the workflow looks like this:

1.  **Build your NixOS AMI:** Your Nix expression is built into a custom AMI. This build process is often integrated into your CI/CD pipeline.
2.  **CDK Defines Launch Configuration:** Your CDK application defines an EC2 Launch Configuration or Launch Template that references the newly built AMI.
3.  **CDK Deploys Auto Scaling Group:** An Auto Scaling Group (ASG) is configured to use this Launch Configuration/Template, ensuring that instances are always launched from your immutable AMI.
4.  **Updates are Replacements:** When you need to update your application or OS, you repeat step 1 (build a *new* AMI), update your CDK code to reference the *new* AMI ID, and deploy your CDK stack. The ASG will then gracefully roll out new instances using the updated AMI, terminating the old ones.

### Example: Deploying the NixOS Nginx AMI with CDK

Let's assume our Nix build process has pushed an AMI to AWS, and we have its ID. Now, we use CDK (in TypeScript) to deploy it.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface NginxStackProps extends cdk.StackProps {
  amiId: string; // The AMI ID built by Nix
}

export class ImmutableNginxStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NginxStackProps) {
    super(scope, id, props);

    // Define a VPC for our resources
    const vpc = new ec2.Vpc(this, 'NginxVpc', {
      maxAzs: 2, // Use 2 Availability Zones
      natGateways: 1,
    });

    // Security Group for Nginx
    const nginxSecurityGroup = new ec2.SecurityGroup(this, 'NginxSecurityGroup', {
      vpc,
      description: 'Allow HTTP and SSH access to Nginx instances',
      allowAllOutbound: true,
    });
    nginxSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP access');
    nginxSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

    // Auto Scaling Group for Nginx instances
    const asg = new autoscaling.AutoScalingGroup(this, 'NginxASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.genericLinux({
        'us-east-1': props.amiId, // Specify the AMI ID for your region
        // Add other regions if you deploy globally
      }),
      minCapacity: 1,
      maxCapacity: 2,
      desiredCapacity: 1,
      securityGroup: nginxSecurityGroup,
      // You can add user data if needed, but for NixOS, most config is baked into the AMI.
      // userData: ec2.UserData.forLinux(),
      // keyName: 'your-ssh-key-pair', // Optional: for SSH access, ensure it exists in AWS
    });

    // Create a Load Balancer to distribute traffic to Nginx instances
    const lb = new elbv2.ApplicationLoadBalancer(this, 'NginxLB', {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('HttpListener', { port: 80 });
    listener.addTargets('NginxTarget', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/', // Nginx will respond on root
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      },
    });

    // Output the Load Balancer DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: lb.loadBalancerDnsName,
      description: 'The DNS name of the Application Load Balancer',
    });
  }
}

// Main application entry point
const app = new cdk.App();
new ImmutableNginxStack(app, 'ImmutableNginxStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  amiId: 'ami-0abcdef1234567890', // Replace with your actual Nix-built AMI ID
});

app.synth();
```

**To deploy this:**

1.  **Build your NixOS AMI:** Use your Nix tooling to build and push an AMI. Get its ID.
2.  **Update CDK:** Replace `'ami-0abcdef1234567890'` with your actual AMI ID in `app.ts`.
3.  **Deploy:** Run `cdk deploy`.

When you need to update Nginx or the underlying OS:

1.  Modify your `default.nix` (e.g.,