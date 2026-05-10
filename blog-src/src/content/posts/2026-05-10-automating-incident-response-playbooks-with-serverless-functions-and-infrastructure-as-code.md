---
title: "Automating Incident Response Playbooks with Serverless Functions and Infrastructure as Code"
date: 2026-05-10
category: "thought-leadership"
tags: []
excerpt: "Incident response is a race against the clock. Every minute an incident persists, the potential for damage, data loss, and reputational harm increases..."
---

# Automating Incident Response Playbooks with Serverless Functions and Infrastructure as Code

Incident response is a race against the clock. Every minute an incident persists, the potential for damage, data loss, and reputational harm increases. While well-defined playbooks are crucial for a consistent and effective response, manual execution can be slow, error-prone, and divert valuable human resources from critical analysis and decision-making.

This is where automation shines. By leveraging serverless functions and Infrastructure as Code (IaC), we can transform static playbooks into dynamic, automated workflows that execute rapidly and reliably, freeing up our incident responders to focus on the truly complex challenges.

## The Challenge: Bridking the Gap Between Playbook and Execution

Traditional incident response often involves:

1.  **Detection:** An alert fires from a SIEM, EDR, or other monitoring tool.
2.  **Triage:** An analyst reviews the alert, correlates information, and determines if it's a true positive incident.
3.  **Playbook Activation:** The analyst identifies the relevant playbook (e.g., "Compromised EC2 Instance," "S3 Bucket Misconfiguration," "Suspect User Login").
4.  **Manual Steps:** The analyst then manually executes the steps outlined in the playbook:
    *   Isolate network segment.
    *   Gather forensic artifacts.
    *   Block IP addresses.
    *   Revoke credentials.
    *   Notify stakeholders.
    *   Update ticketing system.

This manual execution introduces latency and potential for human error. What if we could automate a significant portion of these steps, triggered directly by the alert?

## The Solution: Serverless Functions + Infrastructure as Code

Combining serverless functions with IaC provides a powerful pattern for automating incident response.

*   **Serverless Functions (e.g., AWS Lambda, Azure Functions, Google Cloud Functions):** These provide event-driven compute without managing servers. They are ideal for short-lived, reactive tasks, scaling automatically, and costing only for execution time.
*   **Infrastructure as Code (e.g., AWS CloudFormation, Terraform, Pulumi):** IaC allows us to define and provision infrastructure (including our serverless functions, event triggers, and permissions) in a declarative way. This ensures consistency, repeatability, and version control for our automation logic.

Let's walk through a practical example: **Automating the initial response to a suspected compromised EC2 instance.**

### Scenario: Suspected Compromised EC2 Instance

Imagine our EDR or SIEM detects suspicious activity on an EC2 instance, such as outbound connections to known malicious IPs, unexpected process execution, or a sudden increase in data transfer.

**Our Automated Playbook Steps:**

1.  **Isolate the EC2 instance:** Detach it from its current security groups and attach it to an "isolation" security group that only allows access from forensic workstations.
2.  **Create a Snapshot:** Take an immediate snapshot of the instance's EBS volumes for forensic analysis.
3.  **Notify Incident Responders:** Send a notification to the incident response Slack channel or PagerDuty.
4.  **Update Incident Ticket:** Add a note to the corresponding JIRA/ServiceNow ticket with details of the automated actions.

### Architecture Overview

```mermaid
graph TD
    A[SIEM/EDR Alert] --> B(CloudWatch Event Rule/EventBridge)
    B --> C(Lambda Function: "Isolate EC2")
    C --> D[AWS EC2 API Calls]
    D --> E[EC2 Instance Isolated & Snapshot Created]
    C --> F(Lambda Function: "Notify IR Team")
    F --> G[Slack/PagerDuty]
    C --> H(Lambda Function: "Update Ticket")
    H --> I[JIRA/ServiceNow API]
```

### Implementing with AWS (Example)

Let's look at some IaC and code snippets. We'll use AWS CloudFormation for IaC and Python for our Lambda functions.

#### 1. The Trigger: CloudWatch Event Rule

Our SIEM/EDR would need to send an event to AWS. This could be via a custom CloudWatch event, an SQS queue, or directly calling a Lambda. For simplicity, let's assume our SIEM can push a custom event to EventBridge (CloudWatch Events).

```yaml
# cloudformation/event-rule.yaml
Resources:
  EC2CompromiseEventRule:
    Type: AWS::Events::Rule
    Properties:
      Description: "Triggers when a suspected EC2 compromise event is received."
      EventPattern:
        source:
          - "my.security.solution" # Your SIEM/EDR identifier
        detail-type:
          - "EC2 Compromise Alert"
        detail:
          instance-id:
            - exists: true
      Targets:
        - Arn: !GetAtt IsolateEC2LambdaFunction.Arn
          Id: "IsolateEC2Target"

  PermissionForEventsToInvokeLambda:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !GetAtt IsolateEC2LambdaFunction.Arn
      Action: lambda:InvokeFunction
      Principal: events.amazonaws.com
      SourceArn: !GetAtt EC2CompromiseEventRule.Arn
```

#### 2. The Serverless Function: Isolate EC2

This Lambda function will perform the isolation and snapshotting.

```python
# lambda/isolate_ec2/main.py
import os
import boto3
import json

ec2_client = boto3.client('ec2')
sns_client = boto3.client('sns')

# Get the ARN of the SNS topic for notifications from environment variables
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN')
ISOLATION_SG_ID = os.environ.get('ISOLATION_SG_ID') # ID of your pre-created isolation security group

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    instance_id = event['detail']['instance-id']
    incident_id = event['detail'].get('incident-id', 'N/A') # For tracking

    if not instance_id:
        print("No instance-id found in the event detail. Exiting.")
        return {
            'statusCode': 400,
            'body': json.dumps('Missing instance-id')
        }

    try:
        # 1. Get current security groups
        response = ec2_client.describe_instances(InstanceIds=[instance_id])
        current_sgs = []
        if response['Reservations'] and response['Reservations'][0]['Instances']:
            instance = response['Reservations'][0]['Instances'][0]
            current_sgs = [sg['GroupId'] for sg in instance['SecurityGroups']]
            print(f"Instance {instance_id} currently has SGs: {current_sgs}")
        else:
            print(f"Could not find instance {instance_id}. It might be terminated or ID is incorrect.")
            return {
                'statusCode': 404,
                'body': json.dumps(f'Instance {instance_id} not found')
            }

        # 2. Modify security groups to isolate
        print(f"Attaching instance {instance_id} to isolation SG: {ISOLATION_SG_ID}")
        ec2_client.modify_instance_attribute(
            InstanceId=instance_id,
            Groups=[ISOLATION_SG_ID]
        )
        print(f"Instance {instance_id} successfully moved to isolation security group.")

        # 3. Create EBS snapshots
        volume_ids = [b['Ebs']['VolumeId'] for b in instance['BlockDeviceMappings'] if 'Ebs' in b]
        snapshot_ids = []
        for vol_id in volume_ids:
            print(f"Creating snapshot for volume {vol_id} on instance {instance_id}")
            snapshot = ec2_client.create_snapshot(
                VolumeId=vol_id,
                Description=f"Automated forensic snapshot for instance {instance_id} (Incident: {incident_id})",
                TagSpecifications=[
                    {
                        'ResourceType': 'snapshot',
                        'Tags': [
                            {'Key': 'IncidentID', 'Value': incident_id},
                            {'Key': 'InstanceID', 'Value': instance_id},
                            {'Key': 'AutomatedAction', 'Value': 'IsolationAndSnapshot'}
                        ]
                    }
                ]
            )
            snapshot_ids.append(snapshot['SnapshotId'])
            print(f"Created snapshot: {snapshot['SnapshotId']}")

        # 4. Notify via SNS
        message = {
            "IncidentID": incident_id,
            "InstanceID": instance_id,
            "Action": "Automated EC2 Isolation and Snapshot",
            "Details": f"Instance {instance_id} has been isolated (SG: {ISOLATION_SG_ID}) and snapshots {', '.join(snapshot_ids)} have been created. Original SGs: {', '.join(current_sgs)}",
            "Severity": "High"
        }
        if SNS_TOPIC_ARN:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Message=json.dumps(message),
                Subject=f"IR ALERT: EC2 Isolated - {instance_id}"
            )
            print("Notification sent via SNS.")

        return {
            'statusCode': 200,
            'body': json.dumps(f'Instance {instance_id} isolated and snapshots created.')
        }

    except Exception as e:
        print(f"Error processing event for instance {instance_id}: {e}")
        # Send error notification
        error_message = {
            "IncidentID": incident_id,
            "InstanceID": instance_id,
            "Action": "Automated EC2 Isolation and Snapshot (FAILED)",
            "Details": f"Failed to automate response for instance {instance_id}. Error: {str(e)}",
            "Severity": "Critical"
        }
        if SNS_TOPIC_ARN:
            sns_client.publish(
                TopicArn=SNS_TOPIC_ARN,
                Message=json.dumps(error_message),
                Subject=f"IR ERROR: EC2 Automation Failed - {instance_id}"
            )
        raise e
```

#### 3. CloudFormation for the Lambda and Permissions

```yaml
# cloudformation/lambda-isolation.yaml
Resources:
  IsolateEC2LambdaFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: "IR-IsolateEC2Instance"
      Handler: main.lambda_handler
      Runtime: python3.9
      Timeout: 300 # 5 minutes
      MemorySize: 256
      Code:
        S3Bucket: your-code-bucket-name # Replace with your S3 bucket for Lambda zips
        S3Key: lambda/isolate_ec2.zip
      Role: !GetAtt IsolateEC2LambdaRole.Arn
      Environment:
        Variables:
          