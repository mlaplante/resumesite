---
title: "Killing Static Cloud Credentials with GitHub Actions OIDC and Least-Privilege AWS Trust Policies"
date: 2026-11-19
category: "thought-leadership"
tags: ["aws", "github-actions", "iam", "oidc", "cicd-security", "supply-chain-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Every cloud security review I've done in the last several years has turned up the same thing: an AWS_ACCESS_KEY_ID sitting in a GitHub repository..."
---

Every cloud security review I've done in the last several years has turned up the same thing: an `AWS_ACCESS_KEY_ID` sitting in a GitHub repository secret, created by someone who left the company two reorgs ago. It's attached to an IAM user with `AdministratorAccess` "temporarily," and it was last rotated never.

GitHub Actions OIDC federation is supposed to fix this, and it largely does. Your workflow asks GitHub for a signed, short-lived JWT. AWS verifies it and hands back temporary credentials. Nothing long-lived is stored anywhere.

The catch is that OIDC moves the risk rather than removing it. The secret is gone, so the trust policy becomes the security boundary. I've audited plenty of "we moved to OIDC!" environments where the trust policy let any repository in the org, any branch, and any pull request assume a production deploy role. That's arguably worse than a static key, because nobody is watching it anymore.

This post covers how to do it properly. We'll set up the federation, look at the specific ways trust policies go wrong, harden them in tiers, and finish with tooling to audit and detect misuse.

## How the Flow Actually Works

Knowing the mechanics makes the security model obvious, so start here:

1. A job declares `permissions: id-token: write`.
2. The runner requests a JWT from GitHub's OIDC provider (`https://token.actions.githubusercontent.com`), specifying an audience.
3. GitHub signs a token containing claims about the run: `repository`, `ref`, `environment`, `job_workflow_ref`, `actor`, and others. A `sub` (subject) claim summarizes the context.
4. The workflow calls `sts:AssumeRoleWithWebIdentity` with that token.
5. AWS validates the signature against GitHub's published keys. It then evaluates the role's **trust policy conditions** against the token's claims.
6. If the conditions match, STS returns credentials, valid for one hour by default.

Step 5 is the important part. AWS will happily accept *any* validly signed GitHub token. That includes tokens minted for a repository an attacker controls on their own GitHub account. The only things that separate your org's workflows from the rest of GitHub are the `aud` and `sub` conditions in your trust policy.

## Baseline Setup in Terraform

First, register GitHub as an identity provider. You need one per AWS account.

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS validates GitHub's OIDC endpoint against its own trusted CA library
  # and no longer relies on this value. Older provider versions still
  # require the argument, so it's included for compatibility.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}
```

Next, create a role with a tightly scoped trust policy. Here's a production deploy role for a single repository and a single GitHub environment:

```hcl
data "aws_iam_policy_document" "payments_prod_trust" {
  statement {
    sid     = "GitHubActionsProdDeploy"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:acme-corp/payments-api:environment:production"]
    }
  }
}

resource "aws_iam_role" "payments_prod_deploy" {
  name                 = "gha-payments-api-prod-deploy"
  assume_role_policy   = data.aws_iam_policy_document.payments_prod_trust.json
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.cicd_boundary.arn

  tags = {
    ManagedBy  = "terraform"
    Repository = "acme-corp/payments-api"
    Purpose    = "github-actions-deploy"
  }
}
```

Then the workflow side:

```yaml
name: deploy-production

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write   # required to request the OIDC JWT

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/gha-payments-api-prod-deploy
          role-session-name: gha-${{ github.run_id }}-${{ github.run_attempt }}
          aws-region: us-east-1
          role-duration-seconds: 900

      - run: ./scripts/deploy.sh
```

Two details here are easy to skip and worth keeping:

- **`permissions` at the workflow level.** If you don't declare permissions, the `GITHUB_TOKEN` gets whatever your org default is. Declare the minimum explicitly, and add `id-token: write` only on jobs that need cloud access.
- **`role-session-name` with the run ID.** This value lands in CloudTrail. When you're doing incident response at 2 a.m., being able to map an API call straight back to a specific workflow run is very valuable.

## The Five Ways Trust Policies Go Wrong

These are the patterns I see repeatedly in audits, ordered roughly from catastrophic to subtle.

### 1. No `sub` condition at all

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
  }
}
```

This trusts **every GitHub Actions workflow on the planet**. An attacker creates a free account, writes a workflow that requests a token with audience `sts.amazonaws.com`, and assumes your role. The `aud` claim is fully attacker-controlled, so it is not an authorization control. AWS has added some guardrails against the most blatant version of this. Don't rely on platform guardrails to catch your mistakes.

### 2. Org-wide or repo-wide wildcards

```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:acme-corp/*"
}
```

This is better, but not much. Any repository in your org can now assume the role, including the intern's sandbox repo, a forked-in third-party tool, or a repo where someone with write access was phished. `repo:acme-corp/payments-api:*` is the same problem at smaller scale. It matches every branch, every tag, every environment, and pull requests.

### 3. Trusting the `pull_request` subject for anything privileged

When a workflow is triggered by `pull_request`, the default subject looks like this:

```
repo:acme-corp/payments-api:pull_request
```

The subject doesn't include the branch or the PR author, so it identifies "some PR in this repo." Anyone who can open a branch and a PR can run code under that identity. Read-only roles for things like `terraform plan` against a non-prod account are defensible. Anything that writes is not.

### 4. Assuming `ref` conditions still apply when you use environments

This one surprises people. When a job references a GitHub environment, the subject format **changes**:

```
# job WITHOUT an environment
repo:acme-corp/payments-api:ref:refs/heads/main

# job WITH environment: production
repo:acme-corp/payments-api:environment:production
```

Teams write a trust policy pinned to `ref:refs/heads/main`, then add `environment: production` to the job, and the deploy breaks. The usual "fix" is to switch to a wildcard. The correct fix is to match on the environment and enforce branch restrictions with **deployment branch rules** on the environment itself.

### 5. Branch conditions without branch protection

`ref:refs/heads/main` is only meaningful if `main` is protected. If anyone with write access can push directly to `main`, or force-push, the condition is weaker than it looks. The trust policy and the repository settings are one control. Configure them together.

## Hardening in Tiers

Not every role needs maximum lockdown. Here's how I tier it.

### Tier 1: Exact-match `sub` per role, per purpose

At minimum:

- Use `StringEquals`, not `StringLike`, wherever possible.
- Give each repository its own role. Better still, give each repository and environment pair its own role.
- Use separate roles for `plan` (read-only, can trust PRs in non-prod) and `apply` (write, trusts only a protected environment).

```hcl
locals {
  plan_subjects = [
    "repo:acme-corp/infra-live:pull_request",
    "repo:acme-corp/infra-live:ref:refs/heads/main",
  ]
  apply_subjects = [
    "repo:acme-corp/infra-live:environment:production",
  ]
}
```

### Tier 2: Protected environments as the real gate

Configure the `production` environment in GitHub with:

- **Required reviewers.** A human approves before the job gets a token.
- **Deployment branch rules.** Only `main`, or only tags matching `v*`, can deploy.
- **Wait timer**, optionally, as a buffer for rollback decisions.

The token for `environment:production` can't be minted until those gates pass. This is a much stronger control than branch matching alone, because GitHub enforces it before the JWT exists. You can manage environment settings as code with the GitHub Terraform provider:

```hcl
resource "github_repository_environment" "production" {
  repository  = "payments-api"
  environment = "production"

  reviewers {
    teams = [data.github_team.payments_leads.id]
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "main_only" {
  repository     = "payments-api"
  environment    = github_repository_environment.production.environment
  branch_pattern = "main"
}
```

### Tier 3: Custom subject claims with immutable IDs and pinned workflows

The default subject has two weaknesses.

**First, it uses names, not IDs.** If you rename your org, or delete a repository and someone later registers that name, a trust policy keyed on `repo:acme-corp/payments-api` could end up trusting the wrong thing. GitHub protects popular namespaces, but "probably fine" isn't a security posture.

**Second, it can't express *which workflow* is running.** If you've centralized deployment logic in a reusable workflow owned by your platform team, you want AWS to verify that the token came from *that* workflow at *that* ref. You don't want to accept any YAML a developer wrote in the calling repo.

GitHub lets you customize which claims are included in `sub`. AWS IAM condition keys for GitHub's provider are effectively limited to `aud` and `sub`. So putting the claims you care about *into* `sub` is the practical way to make them enforceable.

```bash
# Repository-level customization (org-level also available via /orgs/{org}/...)
gh api --method PUT \
  repos/acme-corp/payments-api/actions/oidc/customization/sub \
  --input - <<'EOF'
{
  "use_default": false,
  "include_claim_keys": [
    "repository_owner_id",
    "repository_id",
    "context",
    "job_workflow_ref"
  ]
}
EOF
```

The resulting subject looks like this:

```
repository_owner_id:1234567:repository_id:890123456:environment:production:job_workflow_ref:acme-corp/platform-workflows/.github/workflows/deploy-ecs.yml@refs/heads/main
```

The trust policy can now require all of the following at once:

- The **numeric** org and repo IDs, which survive renames and can't be squatted.
- The protected environment.
- The exact reusable workflow file and ref that must be executing.

```hcl
condition {
  test     = "StringEquals"
  variable = "token.actions.githubusercontent.com:sub"
  values = [join(":", [
    "repository_owner_id:1234567",
    "repository_id:890123456",
    "environment:production",
    "job_workflow_ref:acme-corp/platform-workflows/.github/workflows/deploy-ecs.yml@refs/heads/main",
  ])]
}
```

If you version reusable workflows with tags, you can use `StringLike` with a tightly anchored pattern such as `...deploy-ecs.yml@refs/tags/v*`. Be aware that this trusts every future tag matching the pattern, so protect tag creation with repository rulesets.

**Rollout warning:** changing the subject template immediately breaks every existing trust policy written against the default format for that repo. Roll out per repository, update trust policies first to accept *both* formats during the transition, then remove the old one.

To check what your token actually contains, add a temporary debug step that decodes only the payload. Never print the full token.

```yaml
- name: Inspect OIDC claims (remove after verification)
  run: |
    TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
    python3 - "$TOKEN" <<'PY'
    import sys, json, base64
    payload = sys.argv[1].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    keep = ["sub", "aud", "repository", "repository_id", "ref",
            "environment", "job_workflow_ref", "event_name"]
    print(json.dumps({k: claims.get(k) for k in keep}, indent=2))
    PY
```

## Don't Forget the Permissions Side

A tight trust policy controls *who* gets in. What they can do once inside still matters.

- **Permission boundaries on every CI/CD role.** Even if a role's inline policy gets widened by mistake, the boundary caps it. A good baseline boundary denies `iam:*` except for scoped actions like passing specific roles, and denies `organizations:*`, `account:*`, and CloudTrail tampering.

```hcl
data "aws_iam_policy_document" "cicd_boundary" {
  statement {
    sid       = "AllowWorkloadServices"
    effect    = "Allow"
    actions   = ["ecs:*", "ecr:*", "s3:*", "logs:*", "cloudwatch:*"]
    resources = ["*"]
  }

  statement {
    sid       = "AllowPassOnlyWorkloadRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::*:role/workload/*"]
  }

  statement {
    sid    = "DenyGuardrailTampering"
    effect = "Deny"
    actions = [
      "cloudtrail:StopLogging",
      "cloudtrail:DeleteTrail",
      "cloudtrail:UpdateTrail",
      "iam:CreateUser",
      "iam:CreateAccessKey",
      "iam:UpdateAssumeRolePolicy",
      "iam:DeleteRolePermissionsBoundary",
      "organizations:*",
    ]
    resources = ["*"]
  }
}
```

- **Short session durations.** Most deploys finish in minutes. Set `role-duration-seconds` to match, with 900 seconds as the minimum. Stolen credentials expire fast.
- **Restrict who can modify trust policies.** Lock `iam:UpdateAssumeRolePolicy`, `iam:CreateOpenIDConnectProvider`, and `iam:UpdateOpenIDConnectProviderThumbprint` to your IaC pipeline role through SCPs. Trust policy changes should only happen through reviewed Terraform.

## Auditing What You Already Have

Before you harden anything new, find out what's already out there. This script walks every role in an account and flags GitHub OIDC trust policies with the problems described above:

```python
#!/usr/bin/env python3
"""Audit IAM roles trusting GitHub Actions OIDC for weak trust conditions."""
import boto3

PROVIDER = "token.actions.githubusercontent.com"
SUB_KEY = f"{PROVIDER}:sub"
AUD_KEY = f"{PROVIDER}:aud"


def as_list(v):
    return v if isinstance(v, list) else [v]


def collect_conditions(condition_block, key):
    """Return list of (operator, value) for a given condition key."""
    found = []
    for operator, kv in (condition_block or {}).items():
        for k, vals in kv.items():
            if k.lower() == key.lower():
                found.extend((operator, v) for v in as_list(vals))
    return found


def audit_statement(stmt):
    findings = []
    principals = as_list(stmt.get("Principal", {}).get("Federated", []))
    if not any(PROVIDER in p for p in principals):
        return None
    if stmt.get("Effect") != "Allow":
        return None

    cond = stmt.get("Condition", {})
    subs = collect_conditions(cond, SUB_KEY)
    auds = collect_conditions(cond, AUD_KEY)

    if not subs:
        findings.append("CRITICAL: no sub condition (trusts all of GitHub)")
    if not auds:
        findings.append("HIGH: no aud condition")

    for op, val in subs:
        if "*" in val or "?" in val:
            sev = "CRITICAL" if val.rstrip("*").count("/") == 0 or val.endswith("/*") else "HIGH"
            findings.append(f"{sev}: wildcard sub via {op}: {val}")
        if val.endswith(":pull_request"):
            findings.append(f"MEDIUM: trusts pull_request subject: {val} (verify role is read-only)")
        if "job_workflow_ref" not in val and "environment:" not in val:
            findings.append(f"LOW: sub not scoped to environment or workflow: {val}")

    return findings


def main():
    iam = boto3.client("iam")
    for page in iam.get_paginator("list_roles").paginate():
        for role in page["Roles"]:
            doc = role["AssumeRolePolicyDocument"]
            for stmt in as_list(doc.get("Statement", [])):
                findings = audit_statement(stmt)
                if findings:
                    print(f"\n{role['Arn']}")
                    for f in findings:
                        print(f"  - {f}")


if __name__ == "__main__":
    main()
```

Run it across every account in your org. AWS Organizations plus a cross-account audit role makes that a loop. Feed the `CRITICAL` findings straight into your vulnerability management queue. They are equivalent to a publicly exposed admin credential.

## Detecting Misuse in CloudTrail

Every successful or failed federation attempt logs an `AssumeRoleWithWebIdentity` event. The `userIdentity.userName` field contains the token's `sub`, which tells you exactly which repo and context requested access.

```sql
-- Athena: GitHub OIDC role assumptions over the last 7 days
SELECT
  eventtime,
  useridentity.username                                      AS oidc_subject,
  json_extract_scalar(requestparameters, '$.roleArn')        AS role_arn,
  json_extract_scalar(requestparameters, '$.roleSessionName') AS session_name,
  sourceipaddress,
  errorcode
FROM cloudtrail_logs
WHERE eventname = 'AssumeRoleWithWebIdentity'
  AND useridentity.identityprovider LIKE '%token.actions.githubusercontent.com%'
  AND from_iso8601_timestamp(eventtime) > current_timestamp - INTERVAL '7' DAY
ORDER BY eventtime DESC;
```

There are three detections I'd put in place immediately:

1. **Unexpected subjects.** Alert on any successful assumption where `oidc_subject` doesn't match an allowlist built from your Terraform state. A new subject showing up means a trust policy is broader than you think.
2. **`AccessDenied` bursts.** Repeated failed `AssumeRoleWithWebIdentity` calls against your role ARNs from subjects outside your org are someone probing for wildcard trust policies. Role ARNs leak through public workflow files all the time.
3. **Session name anomalies.** If you standardize on `gha-<run_id>-<attempt>`, any session that doesn't match the pattern deserves a look.

## The Migration Plan: Actually Killing the Static Keys

OIDC only helps if the old keys die. Here's the sequence I use:

**1. Inventory every access key and when it was last used.**

```bash
aws iam generate-credential-report >/dev/null && sleep 5
aws iam get-credential-report --query Content --output text | base64 -d \
  | awk -F, 'NR==1 || $9=="true" || $14=="true" {print $1","$9","$11","$14","$16}'
```

This gives you each user with an active key, plus `last_used_date`. Cross-reference usernames against GitHub org secrets. The GitHub API lists secret *names* per repo, which is usually enough to map them.

**2. Stand up OIDC roles in parallel.** Deploy the provider and roles, then update workflows to use `configure-aws-credentials` with `role-to-assume`. Leave the old secrets in place for one release cycle.

**3. Deactivate, don't delete.** Run `aws iam update-access-key --status Inactive`. If something breaks, you'll find out fast and can reactivate in seconds. Wait two weeks.

**4. Delete the keys, the secrets, and the IAM users.** All three. Then add an SCP that denies `iam:CreateAccessKey` outside a break-glass path, so the problem can't quietly return.

**5. Enforce at the GitHub layer.** Use org-level secret scanning with push protection so new AWS keys get blocked before they land in a repo.

## The Checklist

If you only take one thing from this post, run through this list against your environment this week:

- [ ] Every GitHub OIDC trust policy has both `aud` and `sub` conditions
- [ ] No `sub` condition uses an org-wide or repo-wide wildcard
- [ ] Roles that write to production trust only a protected `environment:` subject
- [ ] Production environments require reviewers and restrict deployment branches
- [ ] `pull_request` subjects are trusted only by read-only, non-production roles
- [ ] High-value roles use custom subjects with `repository_id`, `repository_owner_id`, and `job_workflow_ref`
- [ ] Every CI/CD role has a permission boundary and a session duration under one hour
- [ ] Trust policy changes are restricted to your IaC pipeline via SCP
- [ ] CloudTrail alerting covers unexpected OIDC subjects and `AccessDenied` bursts
- [ ] Zero IAM user access keys exist for CI/CD, and creating new ones is blocked

Static credentials in CI were always a ticking clock. OIDC federation stops that clock, but only if the trust policy is written with the same rigor you'd apply to a firewall rule facing the internet, because functionally that's what it is. Get the conditions right, put the environment gates in front of them, and keep watching the logs.