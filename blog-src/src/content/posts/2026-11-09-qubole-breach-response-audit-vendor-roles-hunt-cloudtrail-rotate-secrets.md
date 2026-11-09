---
title: "Qubole Breach Response: Audit Vendor Roles, Hunt CloudTrail, Rotate Secrets"
date: 2026-11-09
category: "thought-leadership"
tags: ["aws", "cloudtrail", "iam", "incident-response", "supply-chain-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Every vendor integration we approve carries a quiet assumption. We accept that the vendor will protect the keys we hand them as carefully as we..."
---

Every vendor integration we approve carries a quiet assumption. We accept that the vendor will protect the keys we hand them as carefully as we protect our own. The Qubole incident shows what happens when that assumption fails.

According to cloud security company Wiz, an attacker broke into AWS accounts belonging to multiple Qubole customers between October 14 and October 26. The attacker stole stored secrets and data. They got in using credentials for an AWS account that Qubole's platform uses to reach its customers. How the attacker obtained those credentials has not been disclosed.

Qubole is a data lake platform owned by Idera. For specifics on scope, affected account IDs, and recommended customer actions, check the official advisory from Qubole or Idera and Wiz's write-up. Don't rely on secondhand summaries, including this one.

The attacker never had to phish your engineers, exploit your workloads, or brute-force your console. They walked through a door you deliberately left open for a trusted partner.

If you're a Qubole customer, treat this as an active incident. If you're not, treat it as a free tabletop exercise. Most AWS estates I've reviewed have at least a handful of third-party cross-account roles that nobody has looked at in years.

This post covers four things:

1. How vendor cross-account access works and why it makes such a good target.
2. How to inventory every external trust in your AWS accounts.
3. How to hunt in CloudTrail for abuse of those roles.
4. How to contain, rotate, and harden.

## How Vendor Cross-Account Access Works

SaaS data platforms usually get into your AWS environment one of two ways:

- **Long-lived IAM user access keys** that you generate and paste into the vendor's console. This is the legacy pattern and it's bad.
- **An IAM role in your account** whose trust policy allows the vendor's AWS account to call `sts:AssumeRole`. This is the modern pattern, and it's better.

A typical vendor trust policy looks like this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "customer-unique-id-abc123" }
      }
    }
  ]
}
```

(Account `111122223333` is a placeholder. Verify the actual account ID your vendor uses from their documentation or your own IAM configuration.)

The `ExternalId` protects against the *confused deputy* problem, where one vendor customer tricks the vendor into acting against another customer. **It does not protect you if the vendor's own AWS account is compromised.** An attacker holding credentials in the vendor account can assume your role. If the vendor stores your ExternalId, the attacker very likely has it too.

That's the uncomfortable truth here. Everything in your environment trusts that principal. The blast radius of a vendor compromise equals the permissions you granted that role. For data platforms, those permissions are often broad: read access to data lake buckets, `secretsmanager:GetSecretValue` for database credentials, sometimes far more.

## Step 1: Inventory Every External Trust

You can't hunt for abuse of a role you don't know exists. Start by enumerating every IAM role whose trust policy names a principal outside your AWS Organization.

### Quick wins with IAM Access Analyzer

If you haven't enabled IAM Access Analyzer with your organization as the zone of trust, do it now. Its external access findings flag roles trusted by accounts outside your org:

```bash
# Create an org-level analyzer (run from the management or delegated admin account)
aws accessanalyzer create-analyzer \
  --analyzer-name org-external-access \
  --type ORGANIZATION

# List active findings for IAM roles
aws accessanalyzer list-findings-v2 \
  --analyzer-arn arn:aws:access-analyzer:us-east-1:<ACCOUNT_ID>:analyzer/org-external-access \
  --filter '{"resourceType": {"eq": ["AWS::IAM::Role"]}, "status": {"eq": ["ACTIVE"]}}'
```

### A script that gives you the full picture

Access Analyzer tells you *that* a trust exists. I also want to know whether an ExternalId is enforced, when the role was last used, and what permissions it carries. Here's a script I use as a starting point:

```python
#!/usr/bin/env python3
"""Inventory IAM roles trusted by AWS accounts outside the organization."""
import json
import boto3

iam = boto3.client("iam")
org = boto3.client("organizations")

def org_account_ids():
    ids = set()
    for page in org.get_paginator("list_accounts").paginate():
        ids.update(a["Id"] for a in page["Accounts"])
    return ids

def principals_from(stmt):
    p = stmt.get("Principal", {})
    if p == "*":
        return ["*"]
    aws = p.get("AWS", []) if isinstance(p, dict) else []
    return [aws] if isinstance(aws, str) else aws

def account_from_principal(p):
    if p == "*":
        return "*"
    if p.isdigit():
        return p
    return p.split(":")[4] if p.startswith("arn:") else p

def main():
    internal = org_account_ids()
    findings = []
    for page in iam.get_paginator("list_roles").paginate():
        for role in page["Roles"]:
            doc = role["AssumeRolePolicyDocument"]
            for stmt in doc.get("Statement", []):
                if stmt.get("Effect") != "Allow":
                    continue
                for p in principals_from(stmt):
                    acct = account_from_principal(p)
                    if acct in internal:
                        continue
                    cond = json.dumps(stmt.get("Condition", {}))
                    detail = iam.get_role(RoleName=role["RoleName"])["Role"]
                    last_used = detail.get("RoleLastUsed", {})
                    attached = iam.list_attached_role_policies(
                        RoleName=role["RoleName"])["AttachedPolicies"]
                    findings.append({
                        "role": role["RoleName"],
                        "external_principal": p,
                        "external_id_enforced": "sts:ExternalId" in cond,
                        "last_used": str(last_used.get("LastUsedDate", "never")),
                        "last_region": last_used.get("Region", "-"),
                        "managed_policies": [a["PolicyName"] for a in attached],
                    })
    print(json.dumps(findings, indent=2, default=str))

if __name__ == "__main__":
    main()
```

Run it across every account using your org's audit role. Then sort the output into three buckets:

- **Known and needed.** Document an owner, a business justification, and a review date.
- **Known but stale.** If `last_used` is months old, delete the role. Unused vendor trust is pure risk.
- **Unknown.** Investigate immediately. Sometimes it's a forgotten proof of concept. Sometimes it's persistence someone left behind.

For the Qubole case specifically, identify every role trusting the account ID Qubole's platform uses. Get that ID from your own Qubole configuration or the vendor advisory. Then note exactly what each role can reach. That permission set defines your hunting scope.

## Step 2: Hunt in CloudTrail

Here's the key mental model. When an external account assumes a role in your account, CloudTrail in **your** account records:

1. The `AssumeRole` event, where `userIdentity.type` is `AWSAccount` and `userIdentity.accountId` is the vendor's account.
2. Every subsequent API call made with that session, where `userIdentity.type` is `AssumedRole` and `userIdentity.sessionContext.sessionIssuer.arn` is your role.

**On time windows:** the reported window is October 14 to October 26. Hunt wider than that. I'd start at least a few weeks earlier and run through today. Initial disclosure timelines often get revised, and the credential theft may have happened well before the first observed use.

The queries below assume a standard Athena table over CloudTrail logs named `cloudtrail_logs`. Adjust the names to match your setup, or translate them to CloudTrail Lake SQL or your SIEM.

### Baseline: where does the vendor normally come from?

```sql
SELECT
  sourceipaddress,
  useragent,
  json_extract_scalar(requestparameters, '$.roleArn') AS role_arn,
  count(*) AS assumes,
  min(eventtime) AS first_seen,
  max(eventtime) AS last_seen
FROM cloudtrail_logs
WHERE eventsource = 'sts.amazonaws.com'
  AND eventname = 'AssumeRole'
  AND useridentity.type = 'AWSAccount'
  AND useridentity.accountid = '<VENDOR_ACCOUNT_ID>'
  AND eventtime >= '2026-09-01T00:00:00Z'
GROUP BY 1, 2, 3
ORDER BY first_seen;
```

Legitimate SaaS platforms tend to call from a stable set of AWS-owned IP ranges in predictable regions, with consistent SDK user agents. Look for these anomalies:

- New source IPs, especially outside AWS ranges, or VPN and hosting providers.
- New user agents, such as CLI tools where you normally see a Java or Python SDK.
- A spike in assume frequency, or assumes at unusual hours.
- Role ARNs the vendor doesn't normally touch.

### What did the sessions actually do?

Once you have the role ARN, pivot to session activity. Focus first on the high-value actions: secret retrieval, enumeration, and data access.

```sql
SELECT
  eventtime,
  eventsource,
  eventname,
  sourceipaddress,
  useragent,
  awsregion,
  json_extract_scalar(requestparameters, '$.secretId') AS secret_id,
  requestparameters,
  errorcode
FROM cloudtrail_logs
WHERE useridentity.type = 'AssumedRole'
  AND useridentity.sessioncontext.sessionissuer.arn =
      'arn:aws:iam::<YOUR_ACCOUNT_ID>:role/<VendorRoleName>'
  AND eventtime >= '2026-09-01T00:00:00Z'
  AND eventname IN (
    'GetSecretValue', 'BatchGetSecretValue', 'ListSecrets', 'DescribeSecret',
    'GetParameter', 'GetParameters', 'GetParametersByPath', 'DescribeParameters',
    'Decrypt', 'GenerateDataKey',
    'ListBuckets', 'ListObjects', 'ListObjectsV2', 'GetObject',
    'GetCallerIdentity', 'ListRoles', 'ListUsers', 'GetAccountAuthorizationDetails',
    'CreateAccessKey', 'CreateUser', 'AttachRolePolicy', 'PutRolePolicy',
    'UpdateAssumeRolePolicy', 'CreateLoginProfile'
  )
ORDER BY eventtime;
```

Here's what each group of events tells you:

- **`GetCallerIdentity`, `ListSecrets`, `ListBuckets`, `GetAccountAuthorizationDetails`.** This is classic reconnaissance. A legitimate data platform rarely needs to enumerate your whole secret store or IAM configuration.
- **`GetSecretValue` and `GetParameter*` with decryption.** These are direct secret theft. Record every `secretId` returned. Each one goes on your rotation list.
- **IAM write actions.** `CreateAccessKey`, `UpdateAssumeRolePolicy`, and new users or login profiles signal persistence. If you see any of these, assume the attacker no longer needs the vendor path and escalate accordingly.
- **A high `AccessDenied` rate.** The attacker was probing beyond the role's permissions. That's useful for understanding intent even when the calls failed.

### The S3 data-event gap

S3 object-level reads (`GetObject`) are **data events**. They're not logged by default. If you never enabled S3 data events on the buckets the vendor role could read, you won't see them in CloudTrail. In that case, check S3 server access logs if you had them enabled, and VPC flow logs or S3 request metrics for volume anomalies.

If you have no object-level visibility, plan as though everything the role could read was read. Then go enable data events on sensitive buckets today:

```bash
aws cloudtrail put-event-selectors \
  --trail-name org-trail \
  --advanced-event-selectors '[
    {
      "Name": "S3 data events for sensitive buckets",
      "FieldSelectors": [
        { "Field": "eventCategory", "Equals": ["Data"] },
        { "Field": "resources.type", "Equals": ["AWS::S3::Object"] },
        { "Field": "resources.ARN", "StartsWith": ["arn:aws:s3:::datalake-prod/"] }
      ]
    }
  ]'
```

### Quick sanity check with the CLI

If Athena isn't set up, `lookup-events` covers the last 90 days of management events per region. That's enough to triage quickly:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time 2026-09-01T00:00:00Z \
  --query 'Events[].CloudTrailEvent' --output text \
  | jq -r 'fromjson | select(.userIdentity.sessionContext.sessionIssuer.arn | test("VendorRoleName")) 
           | [.eventTime, .sourceIPAddress, .requestParameters.secretId] | @tsv'
```

Run it in every region the role could operate in, not just your primary one.

## Step 3: Contain

You can contain without breaking the integration permanently, and you can do it in stages.

**Revoke active sessions.** STS credentials stay valid until they expire, even if you change the role's trust policy. The IAM console's "Revoke active sessions" button attaches an inline deny policy keyed on token issue time. You can do the same thing yourself:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "DateLessThan": { "aws:TokenIssueTime": "2026-11-09T18:00:00Z" }
      }
    }
  ]
}
```

```bash
aws iam put-role-policy \
  --role-name VendorRoleName \
  --policy-name RevokeOlderSessions \
  --policy-document file://revoke.json
```

**Cut or restrict the trust.** Until the vendor confirms remediation, consider one of two options:

- Remove the vendor principal from the trust policy entirely.
- Add a `Deny` to the role's permissions that blocks calls from outside the vendor's published egress IPs. This only works if the vendor publishes stable egress ranges. Confirm with them.

```json
{
  "Effect": "Deny",
  "Action": "*",
  "Resource": "*",
  "Condition": {
    "NotIpAddress": { "aws:SourceIp": ["203.0.113.0/24"] },
    "Bool": { "aws:ViaAWSService": "false" }
  }
}
```

The `aws:ViaAWSService` condition stops the policy from breaking calls that AWS services make on the session's behalf. Test this in a non-production account first, because IP conditions can get subtle with VPC endpoints.

## Step 4: Rotate Secrets the Right Way

This is where teams most often get a false sense of closure. Clicking "rotate" in Secrets Manager only helps if the rotation **changes the underlying credential at its source**. If a secret holds a Snowflake password, a Stripe API key, or a database credential, the attacker already has the old value. Invalidate it where it's actually used.

Build the rotation list from two sources:

1. **Confirmed access.** Every `secretId` and parameter name returned by `GetSecretValue` or `GetParameter*` calls from the vendor role session.
2. **Potential access.** Every secret the role *could* read according to its policies, even if you have no evidence it was read. Logging gaps are real.

Then work the list:

```bash
# Secrets with native rotation configured: trigger it now
aws secretsmanager rotate-secret --secret-id prod/warehouse/admin

# Check last accessed date to help prioritize
aws secretsmanager list-secrets \
  --query 'SecretList[].{Name:Name,LastAccessed:LastAccessedDate,Rotation:RotationEnabled}' \
  --output table
```

For secrets without rotation Lambdas, such as third-party API keys, follow this sequence:

1. Generate a new credential in the upstream system.
2. Update the secret value with `put-secret-value`.
3. Redeploy or restart the consumers.
4. **Revoke the old credential upstream.**
5. Check the upstream system's own logs for use of the old credential during and after the window.

Don't forget the non-obvious material:

- **IAM user access keys** stored in Secrets Manager or SSM. These are attacker gold.
- **Data the attacker exfiltrated** may itself contain credentials: config files in S3, notebooks, ETL scripts. Data lake buckets are notorious for this.
- **KMS keys.** You can't rotate away exposure of data that was already decrypted, but review key policies so the vendor role can't decrypt anything it doesn't strictly need.

## Step 5: Harden for Next Time

Once the fire's out, tighten every third-party trust in your estate, not just Qubole's.

**Scope permissions brutally.** Vendor roles should never carry `secretsmanager:*` or `s3:*` on `*`. Grant specific actions on specific ARNs. Ask whether the vendor needs to read secrets at all, or whether you can inject credentials another way.

**Add a permissions boundary to every vendor role.** That way, a broad policy mistake can't exceed a ceiling you control:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::datalake-prod", "arn:aws:s3:::datalake-prod/*"]
    },
    {
      "Effect": "Deny",
      "Action": ["iam:*", "organizations:*", "secretsmanager:ListSecrets"],
      "Resource": "*"
    }
  ]
}
```

**Alert on vendor behavior in real time.** An EventBridge rule on `AssumeRole` from the vendor account, routed to a Lambda that checks the source IP against an allowlist, takes an afternoon to build. It would have turned a 12-day window into minutes:

```json
{
  "source": ["aws.sts"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventName": ["AssumeRole"],
    "userIdentity": { "accountId": ["<VENDOR_ACCOUNT_ID>"] }
  }
}
```

**Enable GuardDuty everywhere.** Its findings for anomalous API behavior and unusual credential use are a solid backstop when custom detections miss.

**Put vendor access in your review cadence.** Every external trust gets an owner, a quarterly review, and a deletion date if it goes unused for 90 days.

**Push your vendors.** Ask how they protect the AWS account that holds trust into yours. Ask whether they use short-lived credentials internally, how they monitor for misuse, and how fast they'll notify you. Those answers belong in your vendor risk assessment, not just their SOC 2 report.

## The Takeaway

The Qubole incident doesn't involve a novel exploit. It uses a trust relationship exactly as designed, by someone who shouldn't have had the keys. That's what makes it so instructive. Defending against it doesn't take exotic tooling. It takes knowing every door you've opened, watching who walks through it, and limiting what they can touch once inside.

If you take one action this week, run the inventory script across your org. Look hard at every external principal with access to secrets or sensitive data. The vendor you trust today could be the attacker's entry point tomorrow, and it's far cheaper to find out on your own schedule.

For Qubole customers: watch the official advisory from Qubole and Idera and the Wiz research for indicators, affected account details, and updated timelines. Fold those specifics into the hunting queries above as they're published.

## Sources

- [Hackers Exploit Qubole's Trusted AWS Access to Breach Customer Accounts and Steal Data](https://thehackernews.com/2026/11/hackers-exploit-quboles-trusted-aws.html) (2026-11-09)
