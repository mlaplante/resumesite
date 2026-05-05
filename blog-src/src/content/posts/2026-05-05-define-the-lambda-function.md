---
title: "Define the Lambda function"
date: 2026-05-05
category: "thought-leadership"
tags: []
excerpt: "In the fast-paced world of information security, incidents are an unfortunate reality. When an alert fires, every second counts. The ability to quickl..."
---

## Taming the Fire: Automating Incident Response with Serverless and IaC

In the fast-paced world of information security, incidents are an unfortunate reality. When an alert fires, every second counts. The ability to quickly and effectively respond can mean the difference between a minor blip and a catastrophic breach. But let's be honest, manually triaging and responding to every alert is a drain on valuable security resources. It's repetitive, prone to human error, and frankly, not the best use of our highly skilled engineers' time.

This is where the power of automation, specifically leveraging serverless functions and Infrastructure as Code (IaC), can transform our incident response capabilities. Instead of scrambling through dashboards and executing commands manually, we can build automated playbooks that react intelligently and consistently.

### The Problem: Manual Response is Slow and Error-Prone

Imagine a common scenario: a suspicious login attempt is detected on a critical server. The current process might look like this:

1.  **Alert received:** A security analyst receives an alert and must manually investigate.
2.  **Log analysis:** The analyst navigates to log aggregation tools, filters for relevant events, and tries to piece together the timeline.
3.  **System isolation (if needed):** If the activity appears malicious, the analyst must manually connect to the affected system (e.g., via SSH or RDP) and execute commands to isolate it, perhaps by modifying firewall rules or stopping services.
4.  **Evidence gathering:** Further manual steps to collect forensic data.

This process is time-consuming, requires deep contextual knowledge for each alert type, and is highly dependent on the analyst's availability and expertise. During a high-volume incident, this manual approach can quickly become a bottleneck.

### The Solution: Serverless Functions as Your Automated Responders

Serverless functions, like AWS Lambda, Azure Functions, or Google Cloud Functions, are ideal for building automated incident response workflows. Their key advantages include:

*   **Event-driven:** They can be triggered by a wide range of events, from security alerts and log entries to API calls.
*   **Scalable:** They automatically scale to handle fluctuating workloads.
*   **Cost-effective:** You only pay for compute time consumed.
*   **Managed infrastructure:** You don't need to manage servers, patching, or scaling.

By writing small, single-purpose functions, we can create modular response actions. For example, a function could be responsible for:

*   **Enriching an alert:** Fetching additional context about an IP address or user from threat intelligence feeds.
*   **Isolating an endpoint:** Modifying security group rules or network ACLs to block traffic.
*   **Disabling a user account:** Interacting with identity management systems.
*   **Collecting evidence:** Triggering the creation of snapshots or copying logs to a secure location.

### Orchestrating with Infrastructure as Code (IaC)

While serverless functions handle the *actions*, Infrastructure as Code (IaC) is crucial for defining, deploying, and managing the underlying infrastructure that supports these functions and their integrations. Tools like Terraform or AWS CloudFormation allow us to:

*   **Define serverless function configurations:** Specify memory, runtime, environment variables, and IAM permissions.
*   **Configure event sources:** Link functions to specific triggers (e.g., an SQS queue receiving security alerts, an SNS topic from a CloudWatch alarm).
*   **Manage network resources:** Define security groups, VPCs, and other network components that your functions will interact with.
*   **Ensure consistency and repeatability:** Treat your incident response infrastructure like any other application code, enabling version control, automated testing, and reliable deployments.

### A Practical Example: Automating Endpoint Isolation

Let's walk through a concrete example: automatically isolating a compromised EC2 instance based on a CloudWatch alarm.

**Scenario:** A CloudWatch alarm triggers if an EC2 instance exhibits unusual outbound network traffic patterns, indicative of potential command-and-control (C2) communication.

**Components:**

1.  **CloudWatch Alarm:** Monitors EC2 network metrics.
2.  **SNS Topic:** Receives the alarm notification.
3.  **SQS Queue:** A dead-letter queue (DLQ) for reliable message processing.
4.  **Lambda Function (Python):** The core of our automated response.
5.  **IAM Roles:** Granting necessary permissions to Lambda.
6.  **Security Groups:** The resource we'll modify to isolate the instance.

**IaC (Terraform Snippet):**

```terraform
# Define the Lambda function
resource "aws_lambda_function" "incident_responder" {
  function_name = "isolate-compromised-instance"
  role          = aws_iam_role.lambda_execution_role.arn
  handler       = "index.handler" # Assuming index.py with a handler function
  runtime       = "python3.9"
  filename      = "lambda_function.zip" # Zip file containing your Python code

  environment {
    variables = {
      TARGET_SECURITY_GROUP_ID = "sg-0123456789abcdef0" # ID of the security group to modify
      ALLOW_INBOUND_SG_ID      = "sg-abcdef01234567890" # Security group for legitimate inbound traffic
    }
  }
}

# Grant Lambda permission to be invoked by SNS
resource "aws_lambda_permission" "allow_sns_invoke" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.incident_responder.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.security_alerts.arn
}

# Link SNS Topic to Lambda Function
resource "aws_sns_topic_subscription" "lambda_subscription" {
  topic_arn   = aws_sns_topic.security_alerts.arn
  protocol    = "lambda"
  endpoint    = aws_lambda_function.incident_responder.arn
}

# IAM Role for Lambda execution
resource "aws_iam_role" "lambda_execution_role" {
  name = "lambda-incident-responder-role"

  assume_role_policy = jsonencode({
    Version = "DEPRECATED_VERSION",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# IAM Policy for Lambda to modify EC2 Security Groups
resource "aws_iam_policy" "ec2_security_group_policy" {
  name        = "lambda-ec2-sg-modify-policy"
  description = "Allows Lambda to modify EC2 security groups"

  policy = jsonencode({
    Version = "DEPRECATED_VERSION",
    Statement = [
      {
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:DescribeNetworkInterfaces",
          "ec2:ModifyNetworkInterfaceAttribute" # For more granular control if needed
        ],
        Effect   = "Allow",
        Resource = "*" # Consider scoping this down to specific regions or instance types for better security
      }
    ]
  })
}

# Attach the policy to the role
resource "aws_iam_role_policy_attachment" "attach_ec2_policy" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.ec2_security_group_policy.arn
}

# ... (CloudWatch Alarm and SNS Topic definitions would go here)
```

**Lambda Function (Python - `index.py`):**

```python
import json
import boto3
import os

ec2_client = boto3.client('ec2')

TARGET_SECURITY_GROUP_ID = os.environ['TARGET_SECURITY_GROUP_ID']
ALLOW_INBOUND_SG_ID = os.environ['ALLOW_INBOUND_SG_ID']

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    for record in event['Records']:
        message_body = json.loads(record['body']) # Assuming SQS trigger
        sns_message = json.loads(message_body['Message'])

        # Extract instance ID from CloudWatch alarm details
        # This part is highly dependent on the specific alarm structure
        instance_id = None
        if 'Trigger' in sns_message and 'Dimensions' in sns_message['Trigger']:
            for dim in sns_message['Trigger']['Dimensions']:
                if dim['name'] == 'InstanceId':
                    instance_id = dim['value']
                    break

        if not instance_id:
            print("Could not extract InstanceId from the alarm. Skipping.")
            continue

        print(f"Attempting to isolate instance: {instance_id}")

        try:
            # 1. Find the security group attached to the instance
            instance_response = ec2_client.describe_instances(InstanceIds=[instance_id])
            security_groups = instance_response['Reservations'][0]['Instances'][0]['SecurityGroups']
            instance_sg_id = security_groups[0]['GroupId'] # Assuming one primary SG for simplicity

            # 2. Revoke all existing ingress rules from the instance's security group
            #    (This is a broad stroke; adjust based on your needs)
            sg_description = ec2_client.describe_security_groups(GroupIds=[instance_sg_id])
            for rule in sg_description['SecurityGroups'][0]['IpPermissions']:
                if rule['IpProtocol'] != '-1': # Not all protocols
                    for ip_range in rule.get('IpRanges', []):
                        if ip_range['CidrIp'] != '0.0.0.0/0': # Don't revoke broad internet access if not intended
                            print(f"Revoking ingress rule: {rule['IpProtocol']} from {ip_range['CidrIp']}")
                            ec2_client.revoke_security_group_ingress(
                                GroupId=instance_sg_id,
                                IpPermissions=[{
                                    'IpProtocol': rule['IpProtocol'],
                                    'FromPort': rule.get('FromPort'),
                                    'ToPort': rule.get('ToPort'),
                                    'IpRanges': [{'CidrIp': ip_range['CidrIp']}]
                                }]
                            )
                    for sg_pair in rule.get('UserIdGroupPairs', []):
                         print(f"Revoking ingress rule from SG: {sg_pair['GroupId']}")
                         ec2_client.revoke_security_group_ingress(
                            GroupId=instance_sg_id,
                            IpPermissions=[{
                                'IpProtocol': rule['IpProtocol'],
                                'FromPort': rule.get('FromPort'),
                                'ToPort': rule.get('ToPort'),
                                'UserIdGroupPairs': [{'GroupId