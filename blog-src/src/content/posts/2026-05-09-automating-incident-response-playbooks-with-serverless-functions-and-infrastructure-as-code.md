---
title: "Automating Incident Response Playbooks with Serverless Functions and Infrastructure as Code"
date: 2026-05-09
category: "thought-leadership"
tags: []
excerpt: "Incident response is a race against time. The faster you can detect, contain, and eradicate a threat, the less impact it will have on your organizatio..."
---

Incident response is a race against time. The faster you can detect, contain, and eradicate a threat, the less impact it will have on your organization. While well-defined playbooks are crucial for guiding your team through a crisis, relying solely on manual execution can introduce delays, human error, and inconsistencies. This is where automation, specifically leveraging serverless functions and Infrastructure as Code (IaC), becomes a game-changer.

As an SVP of Information Security and Operations, I've seen firsthand how automating these repetitive, yet critical, steps can drastically improve response times and free up security engineers to focus on more complex analysis and decision-making.

## The Challenge of Manual Playbook Execution

Let's consider a common scenario: a suspicious login attempt from an unusual geographic location on a critical administrative account. A typical manual playbook might involve:

1.  **Alert Triage:** A security analyst reviews the SIEM alert.
2.  **User Verification:** The analyst contacts the user via an out-of-band channel to confirm legitimacy.
3.  **Account Lockout (if suspicious):** The analyst manually locks the user account in Active Directory or an identity provider.
4.  **Session Termination:** The analyst terminates existing sessions for the compromised account.
5.  **IP Blocking:** The analyst adds the source IP address to a firewall blocklist or WAF.
6.  **Forensic Snapshot:** The analyst initiates a snapshot of the affected system (if applicable).
7.  **Communication:** The analyst updates the incident management system and notifies stakeholders.

Each of these steps, while necessary, takes time and relies on the availability and expertise of an analyst. What if we could automate the initial, high-confidence actions?

## The Power of Serverless Functions and IaC

Serverless functions (like AWS Lambda, Azure Functions, or Google Cloud Functions) provide an ideal execution environment for automating playbook steps. They are:

*   **Event-driven:** Easily triggered by alerts from your SIEM, cloud security posture management (CSPM) tools, or even custom webhooks.
*   **Scalable:** Automatically scale to handle fluctuating incident volumes without managing servers.
*   **Cost-effective:** You only pay for the compute time consumed.
*   **Isolated:** Each function execution runs in an isolated environment, reducing the blast radius of any potential issues.

Coupling this with Infrastructure as Code (IaC) tools like Terraform or AWS CloudFormation allows us to define, provision, and manage our automation infrastructure in a repeatable, version-controlled manner. This ensures consistency, simplifies deployments, and makes auditing far easier.

## A Practical Example: Automating a Suspicious Login Response

Let's revisit our suspicious login scenario and explore how we can automate parts of the playbook using AWS services.

**Our Goal:** Upon detecting a suspicious login (e.g., from an unusual IP, outside business hours), automatically:
1.  Initiate a user lockout.
2.  Block the source IP at the network edge.
3.  Notify the security team via Slack.
4.  Create an incident ticket in Jira.

### Architecture Overview

```mermaid
graph TD
    A[SIEM Alert (e.g., Splunk, CrowdStrike Falcon LogScale)] --> B(AWS EventBridge Custom Bus)
    B --> C{EventBridge Rule: Suspicious Login}
    C --> D(AWS Lambda Function: `handleSuspiciousLogin`)
    D -- AWS SDK Call --> E[AWS IAM (Lock User)]
    D -- AWS SDK Call --> F[AWS WAF (Add IP to Blocklist)]
    D -- HTTP POST --> G[Slack Webhook]
    D -- HTTP POST --> H[Jira API]
    D --> I[AWS CloudWatch Logs (Logging)]
    I --> J[AWS CloudWatch Alarms (Function Errors)]
```

### Key Components and Code Snippets

#### 1. EventBridge Custom Bus and Rules (IaC with Terraform)

First, we define our EventBridge custom bus and a rule to capture the specific alert pattern. We'll assume our SIEM is configured to push relevant alerts to this bus.

```terraform
# main.tf
resource "aws_cloudwatch_event_bus" "security_events_bus" {
  name = "security-events-bus"
}

resource "aws_cloudwatch_event_rule" "suspicious_login_rule" {
  name          = "suspicious-login-alert-rule"
  event_bus_name = aws_cloudwatch_event_bus.security_events_bus.name
  description   = "Triggers on suspicious login alerts from SIEM."

  event_pattern = jsonencode({
    "detail-type": ["SIEM Alert"],
    "source": ["your.siem.platform"],
    "detail": {
      "alert_name": ["Suspicious Login Attempt"],
      "severity": ["Critical", "High"]
    }
  })
}

resource "aws_cloudwatch_event_target" "suspicious_login_target" {
  rule      = aws_cloudwatch_event_rule.suspicious_login_rule.name
  event_bus_name = aws_cloudwatch_event_bus.security_events_bus.name
  target_id = "lambda-handler"
  arn       = aws_lambda_function.handle_suspicious_login.arn
}
```

#### 2. AWS Lambda Function (`handleSuspiciousLogin`)

This is the core of our automation. The Lambda function will receive the alert payload from EventBridge and execute the defined actions.

```python
# lambda_function.py
import os
import json
import boto3
import requests

# Environment variables
IAM_USER_LOCK_ROLE_ARN = os.environ.get('IAM_USER_LOCK_ROLE_ARN')
WAF_IP_SET_ID = os.environ.get('WAF_IP_SET_ID')
WAF_SCOPE = os.environ.get('WAF_SCOPE', 'REGIONAL') # or CLOUDFRONT
SLACK_WEBHOOK_URL = os.environ.get('SLACK_WEBHOOK_URL')
JIRA_API_URL = os.environ.get('JIRA_API_URL')
JIRA_AUTH_TOKEN = os.environ.get('JIRA_AUTH_TOKEN') # Consider AWS Secrets Manager for production

def assume_role(role_arn):
    """Assumes an IAM role to perform actions."""
    sts_client = boto3.client('sts')
    assumed_role_object = sts_client.assume_role(
        RoleArn=role_arn,
        RoleSessionName="LambdaAssumeRoleSession"
    )
    credentials = assumed_role_object['Credentials']
    return boto3.client(
        'iam',
        aws_access_key_id=credentials['AccessKeyId'],
        aws_secret_access_key=credentials['SecretAccessKey'],
        aws_session_token=credentials['SessionToken']
    )

def lock_iam_user(username, iam_client):
    """Locks an IAM user by setting their password and access keys to inactive."""
    try:
        # Disable console password
        iam_client.update_login_profile(
            UserName=username,
            PasswordResetRequired=True # Forces password reset on next login
        )
        print(f"Set password reset required for IAM user: {username}")
    except iam_client.exceptions.NoSuchLoginProfileException:
        print(f"No login profile found for IAM user: {username}, skipping password action.")
    except Exception as e:
        print(f"Error updating login profile for {username}: {e}")

    try:
        # Deactivate all active access keys
        response = iam_client.list_access_keys(UserName=username)
        for key in response['AccessKeyMetadata']:
            if key['Status'] == 'Active':
                iam_client.update_access_key(
                    UserName=username,
                    AccessKeyId=key['AccessKeyId'],
                    Status='Inactive'
                )
                print(f"Deactivated access key {key['AccessKeyId']} for user {username}")
    except Exception as e:
        print(f"Error deactivating access keys for {username}: {e}")

def block_ip_with_waf(ip_address, waf_ip_set_id, scope):
    """Adds an IP address to an AWS WAF IP Set."""
    waf_client = boto3.client('wafv2')
    try:
        # Get current IP Set to find lock_token
        response = waf_client.get_ip_set(Name="YourIPSetName", Scope=scope, Id=waf_ip_set_id)
        lock_token = response['IPSet']['LockToken']

        waf_client.update_ip_set(
            Name="YourIPSetName", # Must match the actual name of your IP Set
            Scope=scope,
            Id=waf_ip_set_id,
            Addresses=[f"{ip_address}/32"], # Ensure CIDR notation
            LockToken=lock_token
        )
        print(f"Added {ip_address} to WAF IP Set: {waf_ip_set_id}")
    except Exception as e:
        print(f"Error adding IP to WAF IP Set: {e}")

def send_slack_notification(message):
    """Sends a notification to Slack."""
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URL not configured. Skipping Slack notification.")
        return

    headers = {'Content-type': 'application/json'}
    payload = {'text': message}
    try:
        response = requests.post(SLACK_WEBHOOK_URL, data=json.dumps(payload), headers=headers)
        response.raise_for_status()
        print("Slack notification sent successfully.")
    except requests.exceptions.RequestException as e:
        print(f"Error sending Slack notification: {e}")

def create_jira_ticket(summary, description):
    """Creates an incident ticket in Jira."""
    if not JIRA_API_URL or not JIRA_AUTH_TOKEN:
        print("Jira API credentials not configured. Skipping Jira ticket creation.")
        return

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {JIRA_AUTH_TOKEN}' # Or Basic Auth
    }
    payload = {
        "fields": {
            "project": {
                "key": "SECINC" # Your Jira project key for incidents
            },
            "summary": summary,
            "description": description,
            "issuetype": {
                "name": "Incident" # Your incident issue type
            }
        }
    }
    try:
        response = requests.post(f"{JIRA_API_URL}/rest/api/2/issue", data=json.dumps(payload), headers=headers)
        response.raise_for_status()
        print(f"Jira ticket created successfully: {response.json().get('key')}")
    except requests.exceptions.RequestException as e:
        print(f"Error creating Jira ticket: {e}")

def lambda_handler(event, context):
    """Entry point triggered by the EventBridge rule."""
    print(f"Received event: {json.dumps(event)}")

    detail = event.get('detail', {})
    username = detail.get('username')
    source_ip = detail.get('source_ip')
    location = detail.get('location', 'unknown location')

    if not username or not source_ip:
        print("Event missing required fields (username/source_ip); skipping automated response.")
        return {
            'statusCode': 400,
            'body': json.dumps({'message': 'Malformed alert payload'})
        }

    # 1. Lock the IAM user
    iam_client = assume_role(IAM_USER_LOCK_ROLE_ARN) if IAM_USER_LOCK_ROLE_ARN else boto3.client('iam')
    lock_iam_user(username, iam_client)

    # 2. Block the source IP at the edge
    if WAF_IP_SET_ID:
        block_ip_with_waf(source_ip, WAF_IP_SET_ID, WAF_SCOPE)

    # 3. Notify the security team
    send_slack_notification(
        f":rotating_light: Suspicious login detected for `{username}` from `{source_ip}` "
        f"({location}). Account locked and source IP blocked automatically."
    )

    # 4. Open an incident ticket
    create_jira_ticket(
        summary=f"Suspicious login: {username} from {source_ip}",
        description=(
            f"Automated response triggered for user {username}.\n"
            f"Source IP: {source_ip}\nLocation: {location}\n\n"
            "Actions taken: IAM user locked, access keys deactivated, source IP added to WAF blocklist."
        )
    )

    return {
        'statusCode': 200,
        'body': json.dumps({'message': f'Automated response completed for {username}'})
    }
```

#### 3. Deploying the Function with Least Privilege (IaC with Terraform)

The Lambda's own execution role shouldn't hold `iam:UpdateLoginProfile` or `iam:UpdateAccessKey` directly — those live on the role referenced by `IAM_USER_LOCK_ROLE_ARN`, which `assume_role()` picks up specifically so the account-locking privilege can be scoped down, audited, and rotated independently of the function itself. The execution role only needs permission to assume that role, plus enough WAF and logging access to do its own job.

```terraform
# main.tf (continued)
resource "aws_iam_role" "handle_suspicious_login_role" {
  name = "handle-suspicious-login-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "handle_suspicious_login_policy" {
  name = "handle-suspicious-login-policy"
  role = aws_iam_role.handle_suspicious_login_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = var.iam_user_lock_role_arn
      },
      {
        Effect   = "Allow"
        Action   = ["wafv2:GetIPSet", "wafv2:UpdateIPSet"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

resource "aws_lambda_function" "handle_suspicious_login" {
  function_name = "handleSuspiciousLogin"
  role          = aws_iam_role.handle_suspicious_login_role.arn
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.12"
  filename      = "handle_suspicious_login.zip"
  timeout       = 15

  environment {
    variables = {
      IAM_USER_LOCK_ROLE_ARN = var.iam_user_lock_role_arn
      WAF_IP_SET_ID           = var.waf_ip_set_id
      WAF_SCOPE                = "REGIONAL"
      SLACK_WEBHOOK_URL        = var.slack_webhook_url
      JIRA_API_URL              = var.jira_api_url
      JIRA_AUTH_TOKEN          = var.jira_auth_token
    }
  }
}
```

**Actionable Takeaway:** Store `SLACK_WEBHOOK_URL` and `JIRA_AUTH_TOKEN` in AWS Secrets Manager rather than as plain Lambda environment variables, and grant the execution role `secretsmanager:GetSecretValue` scoped to those specific secret ARNs. Environment variables are visible to anyone with read access to the function's configuration; secrets shouldn't be.

## Conclusion

None of these individual actions — locking a user, updating a WAF IP set, posting to Slack — is technically difficult. What automation buys you is the thing manual playbooks can't guarantee: that every one of those steps happens, in order, every time, in the seconds after detection rather than the minutes after an analyst finally gets to the alert. Start by automating the highest-confidence, lowest-risk steps of your existing playbooks — the ones an analyst would do without a second thought — and use the time you get back for the judgment calls that still need a human in the loop.