---
title: "Automating Secure AWS Multi-Account Deployment with Terraform and OPA"
date: 2026-04-26
category: "thought-leadership"
tags: []
excerpt: "In today's cloud-native landscape, managing a single AWS account is often insufficient for most organizations. The best practice, driven by security,..."
---

# Automating Secure AWS Multi-Account Deployment with Terraform and OPA

In today's cloud-native landscape, managing a single AWS account is often insufficient for most organizations. The best practice, driven by security, compliance, and operational efficiency, is to adopt a multi-account strategy. However, simply having multiple accounts isn't enough; they must be provisioned and managed securely and consistently. This is where the power of Infrastructure as Code (IaC) with Terraform, combined with policy enforcement using Open Policy Agent (OPA), truly shines.

This post will delve into how we can automate the secure deployment of an AWS multi-account structure using Terraform for provisioning and OPA for validating adherence to security policies *before* deployment.

## The Challenge: Ensuring Consistency and Security Across Accounts

Imagine you're rolling out a new application and need to provision dedicated AWS accounts for development, staging, and production. Each account requires a baseline set of resources: VPCs, subnets, IAM roles, S3 buckets for logging, CloudTrail, Config, and more. Manually configuring these across multiple accounts is not only tedious but also highly prone to errors and inconsistencies, leading to potential security vulnerabilities.

Furthermore, how do you ensure that every new VPC created has flow logs enabled, or that S3 buckets don't allow public access? Reviewing every Terraform plan manually is unsustainable.

## The Solution: Terraform for Provisioning, OPA for Policy Enforcement

Our solution hinges on two core technologies:

1.  **Terraform:** For defining and provisioning our AWS multi-account structure and the baseline resources within them. We'll leverage Terraform's ability to manage resources across different AWS accounts, typically by assuming roles.
2.  **Open Policy Agent (OPA):** An open-source, general-purpose policy engine that allows us to define policies as code (using Rego) and enforce them across our infrastructure. We'll integrate OPA into our CI/CD pipeline to evaluate Terraform plans against our security policies *before* any resources are provisioned.

### Step 1: Designing Your Multi-Account Structure

Before writing any code, design your account structure. A common pattern includes:

*   **Management/Root Account:** For AWS Organizations, consolidated billing, and potentially central logging/auditing.
*   **Shared Services Account:** For shared resources like Active Directory, VPN endpoints, or common CI/CD tools.
*   **Workload Accounts:** Dedicated accounts for applications (Dev, Staging, Prod).
*   **Security Account:** For security tooling, centralized security logs (e.g., GuardDuty findings, VPC Flow Logs).

For this example, we'll focus on provisioning a new "workload" account and ensuring its initial configuration is secure.

### Step 2: Terraform for Account Provisioning and Baseline Resources

We'll use Terraform to:

1.  Create a new AWS account within AWS Organizations.
2.  Set up essential IAM roles for cross-account access.
3.  Provision baseline security resources (e.g., CloudTrail, Config, S3 buckets for logging) within the new account.

Let's look at a simplified Terraform structure.

```terraform
# main.tf (in your management account's Terraform project)

provider "aws" {
  region = "us-east-1"
  # Configuration for the management account
}

resource "aws_organizations_account" "new_workload_account" {
  name  = "my-app-prod"
  email = "my-app-prod+aws@example.com"
  # Ensure this role exists in the new account for initial access
  iam_user_access_to_billing = "ALLOW"
}

# Output the ARN of the created account
output "new_account_arn" {
  value = aws_organizations_account.new_workload_account.arn
}

output "new_account_id" {
  value = aws_organizations_account.new_workload_account.id
}
```

Once the account is created, you'd have a separate Terraform project (or module) that assumes a role into this new account to provision its baseline resources.

```terraform
# modules/account_baseline/main.tf (applies to the new workload account)

variable "account_id" {
  description = "The ID of the account to configure"
}

provider "aws" {
  region = "us-east-1"
  assume_role {
    role_arn = "arn:aws:iam::${var.account_id}:role/OrganizationAccountAccessRole"
  }
}

# Example: Enforcing CloudTrail
resource "aws_cloudtrail" "main" {
  name                          = "cloudtrail-management-events"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  is_organization_trail         = true # If running from Management Account
}

resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket = "my-app-prod-${var.account_id}-cloudtrail-logs"
  acl    = "log-delivery-write" # Specific ACL for CloudTrail
  policy = data.aws_iam_policy_document.cloudtrail_bucket_policy.json

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket_policy" {
  statement {
    sid       = "AWSCloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail_logs.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
  statement {
    sid       = "AWSCloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${var.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

# Example: Enforcing VPC Flow Logs on all VPCs
resource "aws_flow_log" "vpc_flow_logs" {
  for_each             = toset(data.aws_vpcs.all_vpcs.ids)
  log_destination      = aws_s3_bucket.vpc_flow_log_bucket.arn
  log_destination_type = "s3"
  traffic_type         = "ALL"
  vpc_id               = each.value
}

data "aws_vpcs" "all_vpcs" {
  # This will fetch all existing VPCs in the account
}

resource "aws_s3_bucket" "vpc_flow_log_bucket" {
  bucket = "my-app-prod-${var.account_id}-vpc-flow-logs"

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }

  # Add appropriate bucket policy for flow logs
}
```

This modular approach allows us to apply a consistent security baseline to every new account.

### Step 3: Policy Enforcement with Open Policy Agent (OPA)

Now, how do we ensure that our Terraform code *itself* adheres to our security standards before it even touches AWS? This is where OPA comes in. We'll use OPA with its Terraform Rego policies to evaluate the `terraform plan -out=tfplan.binary` output.

First, install `conftest` (a utility that simplifies running OPA against various inputs, including Terraform plans):

```bash
brew install conftest # or download from GitHub releases
```

Next, define your policies in Rego. These policies will evaluate the *planned changes* in your Terraform.

**Example Policy: No Public S3 Buckets**

Let's write a Rego policy to ensure no S3 buckets are created with public access.

Create a file `policy/s3_no_public_access.rego`:

```rego
package terraform.aws.s3

deny[msg] {
  # Find S3 bucket resources in the Terraform plan
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket"
  resource.change.actions[_] == "create" # Only check new buckets

  # Check if ACL is public
  acl := object.get(resource.change.after, "acl", "private") # Default to private if not set
  is_public_acl(acl)

  msg := sprintf("S3 bucket '%s' has a public ACL set to '%s'. Public access is not allowed.", [resource.change.after.bucket, acl])
}

deny[msg] {
  # Find S3 bucket public access block resources in the Terraform plan
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket_public_access_block"
  resource.change.actions[_] == "create" # Only check new public access blocks

  # Check if any public access is explicitly allowed
  block_public_acls       := object.get(resource.change.after, "block_public_acls", false)
  block_public_policy     := object.get(resource.change.after, "block_public_policy", false)
  ignore_public_acls      := object.get(resource.change.after, "ignore_public_acls", false)
  restrict_public_buckets := object.get(resource.change.after, "restrict_public_buckets", false)

  not block_public_acls or not block_public_policy or not ignore_public_acls or not restrict_public_buckets

  msg := sprintf("S3 bucket public access block for '%s' does not block all public access. All public access must be blocked.", [resource.change.after.bucket])
}


is_public_acl(acl) {
  acl == "public-read"
}
is_public_acl(acl) {
  acl == "public-read-write"
}
is_public_acl(acl) {
  acl == "website" # Often used for public websites, but still public
}
```

**Example Policy: Require VPC Flow Logs**

```rego
package terraform.aws.vpc

deny[msg] {
  # Find VPC resources in the Terraform plan
  vpc_resource := input.resource_