---
title: "Automating Cloud Incident Response with Serverless Functions and Event-Driven Architectures"
date: 2026-05-01
category: "thought-leadership"
tags: []
excerpt: "In the fast-paced world of cloud operations, every second counts during an incident. Manual responses, while sometimes necessary, introduce delays and..."
---

# Automating Cloud Incident Response with Serverless Functions and Event-Driven Architectures

In the fast-paced world of cloud operations, every second counts during an incident. Manual responses, while sometimes necessary, introduce delays and human error. As organizations increasingly rely on dynamic cloud environments, the ability to automate incident response becomes not just a luxury, but a critical component of a robust security posture.

This post will explore how we can leverage serverless functions and event-driven architectures to build automated incident response playbooks in the cloud. We'll focus on practical, hands-on examples that you can adapt for your own environment.

## The Challenge of Manual Incident Response

Imagine a scenario: a critical S3 bucket policy is inadvertently changed, granting public read access. In a manual process, this might involve:

1.  **Alerting:** A CloudWatch alarm triggers, sending an SNS notification.
2.  **Triage:** An on-call engineer receives the alert, logs into the console, and investigates the specific S3 bucket.
3.  **Analysis:** The engineer identifies the misconfiguration.
4.  **Remediation:** The engineer manually edits the bucket policy to restrict public access.
5.  **Documentation:** The engineer logs the incident and actions taken.

This process can take minutes, or even longer during off-hours, leaving a critical resource exposed. What if we could shrink this to seconds, with minimal human intervention?

## The Power of Serverless and Event-Driven Architectures

Serverless functions (like AWS Lambda, Azure Functions, or Google Cloud Functions) combined with event-driven architectures provide the perfect foundation for automated incident response.

Here's why:

*   **Event-Driven:** Cloud services emit events for almost everything. A configuration change, a log entry, a security finding – these are all potential triggers.
*   **Scalable & Cost-Effective:** Serverless functions execute only when triggered, scaling automatically and costing only for the compute time used.
*   **Isolated & Secure:** Each function can have granular permissions, adhering to the principle of least privilege.
*   **Fast Remediation:** Automated actions can be executed almost instantaneously after an event is detected.

## A Practical Example: Auto-Remediating Public S3 Buckets

Let's walk through a concrete example: detecting and automatically remediating publicly accessible S3 buckets.

### The Architecture

Our automated response will involve the following AWS services:

1.  **AWS Config:** Continuously monitors resource configurations and detects non-compliant resources (e.g., S3 buckets with public access).
2.  **CloudWatch Events (EventBridge):** Routes AWS Config compliance change events.
3.  **AWS Lambda:** Our serverless function that performs the remediation action.
4.  **AWS SNS (Optional):** To notify security teams about the remediation.

```mermaid
graph TD
    A[S3 Bucket Policy Change] --> B(AWS Config Rule: S3_BUCKET_PUBLIC_READ_PROHIBITED);
    B --> C{Non-Compliance Detected};
    C --> D[CloudWatch Event (EventBridge) Rule];
    D -- Triggers --> E(AWS Lambda Function: `remediate-s3-public-access`);
    E -- Modifies Policy --> A;
    E -- Sends Notification --> F(AWS SNS Topic: `security-alerts`);
```

### Step 1: AWS Config Rule for S3 Public Access

First, we need an AWS Config rule to detect public S3 buckets. AWS provides a managed rule for this: `s3-bucket-public-read-prohibited` and `s3-bucket-public-write-prohibited`.

If you don't have AWS Config enabled, you'll need to do that first. Then, enable the relevant managed rules.

```bash
# Example using AWS CLI to enable a managed Config rule
aws configservice put-config-rule \
    --config-rule-name s3-bucket-public-read-prohibited \
    --source Owner=AWS,SourceIdentifier=S3_BUCKET_PUBLIC_READ_PROHIBITED \
    --input-parameters '{}' \
    --scope ComplianceResourceTypes=AWS::S3::Bucket
```

When an S3 bucket becomes non-compliant with this rule (e.g., its policy allows public read access), AWS Config will record this and emit an event.

### Step 2: CloudWatch Event Rule

We'll create a CloudWatch Event rule to capture events from AWS Config specifically for S3 bucket non-compliance.

The event pattern will look something like this:

```json
{
  "source": ["aws.config"],
  "detail-type": ["Config Rules Compliance Change"],
  "detail": {
    "messageType": ["ComplianceChangeNotification"],
    "configRuleName": ["s3-bucket-public-read-prohibited", "s3-bucket-public-write-prohibited"],
    "newEvaluationResult": {
      "complianceType": ["NON_COMPLIANT"],
      "resourceType": ["AWS::S3::Bucket"]
    }
  }
}
```

This pattern ensures our Lambda function is only triggered when a specific S3 public access rule detects non-compliance.

### Step 3: The Remediation Lambda Function

Now for the core of our automation – the Lambda function. This Python function will parse the incoming event, identify the non-compliant S3 bucket, and modify its policy to remove public read/write access.

```python
import json
import os
import boto3
from botocore.exceptions import ClientError

s3_client = boto3.client('s3')
sns_client = boto3.client('sns')

# Get SNS topic ARN from environment variable
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN')

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    # Extract relevant info from the AWS Config event
    try:
        config_rule_name = event['detail']['configRuleName']
        resource_type = event['detail']['newEvaluationResult']['resourceType']
        resource_id = event['detail']['newEvaluationResult']['resourceId']
        compliance_type = event['detail']['newEvaluationResult']['complianceType']
    except KeyError as e:
        print(f"Error parsing event: {e}")
        return {
            'statusCode': 400,
            'body': json.dumps({'message': 'Invalid event structure'})
        }

    if compliance_type != 'NON_COMPLIANT' or resource_type != 'AWS::S3::Bucket':
        print(f"Skipping event as it's not a non-compliant S3 bucket: {resource_id}")
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Event not relevant for remediation'})
        }

    bucket_name = resource_id
    print(f"Attempting to remediate S3 bucket: {bucket_name} for rule: {config_rule_name}")

    try:
        # Get the current bucket policy
        current_policy = s3_client.get_bucket_policy(Bucket=bucket_name)
        policy_json = json.loads(current_policy['Policy'])
        
        # Filter out statements that grant public read/write access
        # This is a simplified example; a real-world solution might need more complex logic
        # to handle various ways public access can be granted.
        new_statements = []
        for statement in policy_json.get('Statement', []):
            is_public_principal = False
            if 'Principal' in statement:
                if isinstance(statement['Principal'], str) and statement['Principal'] == '*':
                    is_public_principal = True
                elif isinstance(statement['Principal'], dict) and 'AWS' in statement['Principal'] and statement['Principal']['AWS'] == '*':
                    is_public_principal = True
            
            # Check for common public access actions
            is_public_action = False
            if 'Action' in statement:
                actions = statement['Action'] if isinstance(statement['Action'], list) else [statement['Action']]
                for action in actions:
                    if action.startswith('s3:Get') or action.startswith('s3:List') or action.startswith('s3:Put'):
                        is_public_action = True
                        break

            if is_public_principal and is_public_action:
                print(f"Removing public access statement from policy: {statement}")
            else:
                new_statements.append(statement)

        policy_json['Statement'] = new_statements

        # If no statements remain, consider removing the policy entirely or setting a default secure one
        if not new_statements:
            print(f"No non-public statements remaining. Deleting bucket policy for {bucket_name}.")
            s3_client.delete_bucket_policy(Bucket=bucket_name)
            remediation_message = f"Successfully removed public bucket policy for {bucket_name}."
        else:
            # Update the bucket policy
            s3_client.put_bucket_policy(Bucket=bucket_name, Policy=json.dumps(policy_json))
            remediation_message = f"Successfully updated bucket policy for {bucket_name} to remove public access statements."

        print(remediation_message)
        
        # Publish notification
        if SNS_TOPIC_ARN:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject=f"Automated Remediation: S3 Public Access Removed for {bucket_name}",
                Message=remediation_message
            )
        
        return {
            'statusCode': 200,
            'body': json.dumps({'message': remediation_message})
        }

    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchBucketPolicy':
            error_message = f"Bucket {bucket_name} has no policy. No action needed for policy remediation."
            print(error_message)
            return {
                'statusCode': 200,
                'body': json.dumps({'message': error_message})
            }
        else:
            error_message = f"Error remediating S3 bucket {bucket_name}: {e}"
            print(f"Error: {error_message}")
            
            if SNS_TOPIC_ARN:
                sns_client.publish(
                    TopicArn=SNS_TOPIC_ARN,
                    Subject=f"Automated Remediation FAILED: S3 Public Access for {bucket_name}",
                    Message=error_message
                )
            
            return {
                'statusCode': 500,
                'body': json.dumps({'message': error_message})
            }
    except Exception as e:
        error_message = f"An unexpected error occurred: {e}"
        print(f"Error: {error_message}")
        if SNS_TOPIC_ARN:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Subject=f"Automated Remediation FAILED: S3 Public Access for {bucket_name}",
                