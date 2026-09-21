---
title: "Automating Compliance Checks with OPA and Terraform for Kubernetes Deployments"
date: 2026-04-24
category: "thought-leadership"
tags: []
excerpt: "As organizations scale their Kubernetes footprint, ensuring every deployment adheres to internal security policies and external regulatory compliance..."
---

As organizations scale their Kubernetes footprint, ensuring every deployment adheres to internal security policies and external regulatory compliance becomes a herculean task. Manual reviews are slow, error-prone, and don't scale. This is where automation becomes not just a luxury, but a necessity.

In this post, we'll explore a powerful combination: using Open Policy Agent (OPA) for defining granular policies and integrating it with Terraform to automate compliance checks *before* your Kubernetes resources are even provisioned. This "shift-left" approach catches non-compliant configurations early, preventing potential security incidents and costly remediation down the line.

## The Challenge: Ensuring Policy Adherence in a Dynamic Environment

Consider a typical scenario: your security team mandates that all Kubernetes deployments must:

1.  **Not run as root:** `securityContext.runAsNonRoot` must be `true` or `securityContext.runAsUser` must be greater than 1000.
2.  **Have resource limits and requests:** Every container must define `resources.limits.cpu`, `resources.limits.memory`, `resources.requests.cpu`, and `resources.requests.memory`.
3.  **Use specific image registries:** Only images from approved registries (e.g., `mycompany.azurecr.io`, `gcr.io/my-project`) are allowed.

Manually reviewing YAML manifests for these policies across hundreds or thousands of deployments is simply not feasible. We need a programmatic way to enforce these rules.

## The Solution: OPA + Terraform = Policy-as-Code Nirvana

Here's how OPA and Terraform fit together to solve this problem:

*   **Open Policy Agent (OPA):** OPA is an open-source, general-purpose policy engine that enables you to define policies as code using a high-level declarative language called Rego. It can evaluate JSON, YAML, and other structured data.
*   **Terraform:** Our infrastructure-as-code tool of choice. Terraform allows us to define and provision infrastructure in a declarative manner. Its pluggable provider architecture makes it incredibly versatile.

Our strategy will involve:

1.  Defining our compliance policies in Rego.
2.  Using Terraform to provision Kubernetes resources.
3.  Leveraging a Terraform provider to execute OPA policies against the planned Kubernetes resources *before* applying them.

### Step 1: Defining Policies with OPA (Rego)

Let's translate our example policies into Rego. We'll create a file named `kubernetes_policies.rego`.

```rego
package kubernetes.admission

# Policy 1: Containers must not run as root
deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.securityContext.runAsNonRoot
    not container.securityContext.runAsUser > 1000
    msg := sprintf("Container '%s' in deployment '%s' must not run as root. Set runAsNonRoot to true or runAsUser > 1000.", [container.name, input.metadata.name])
}

# Policy 2: Containers must have resource limits and requests
deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.limits.cpu
    msg := sprintf("Container '%s' in deployment '%s' is missing CPU limits.", [container.name, input.metadata.name])
}

deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.limits.memory
    msg := sprintf("Container '%s' in deployment '%s' is missing memory limits.", [container.name, input.metadata.name])
}

deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.requests.cpu
    msg := sprintf("Container '%s' in deployment '%s' is missing CPU requests.", [container.name, input.metadata.name])
}

deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.requests.memory
    msg := sprintf("Container '%s' in deployment '%s' is missing memory requests.", [container.name, input.metadata.name])
}

# Policy 3: Only images from approved registries are allowed
approved_registries := {"mycompany.azurecr.io", "gcr.io/my-project"}

deny[msg] {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    image := container.image
    # Extract the registry part of the image
    parts := split(image, "/")
    registry := parts[0]

    not approved_registries[registry]
    msg := sprintf("Container '%s' in deployment '%s' uses an unapproved image registry '%s'. Allowed registries: %v", [container.name, input.metadata.name, registry, approved_registries])
}

```

A quick breakdown of the Rego code:

*   `package kubernetes.admission`: Defines the policy package.
*   `deny[msg] { ... }`: This rule evaluates to true if a policy violation occurs, and `msg` contains the error message.
*   `input`: This special variable holds the JSON document being evaluated (in our case, the Kubernetes resource manifest).
*   `some i`: An iterator to loop through arrays (like containers).
*   `sprintf`: A formatting function for constructing error messages.

### Step 2: Integrating OPA with Terraform

Terraform itself doesn't have native OPA integration for resource validation. However, we can use the `terraform-opa` project, which provides a data source and resource for executing OPA policies.

First, ensure you have the `terraform-opa` plugin installed. While it's not a HashiCorp-official provider, it's widely used for this purpose. You might need to manually install it or use a `terraformrc` file to configure a custom plugin directory if it's not available via the public registry. For simplicity, we'll assume it's available.

Let's define our Kubernetes deployment in `main.tf`:

```terraform
# main.tf

# Define a non-compliant deployment for demonstration
resource "kubernetes_deployment" "non_compliant_app" {
  metadata {
    name = "non-compliant-app"
    labels = {
      app = "non-compliant-app"
    }
  }

  spec {
    replicas = 1
    selector {
      match_labels = {
        app = "non-compliant-app"
      }
    }
    template {
      metadata {
        labels = {
          app = "non-compliant-app"
        }
      }
      spec {
        container {
          name  = "non-compliant-container"
          image = "nginx:latest" # Unapproved registry
          # Missing securityContext, resource limits/requests
        }
      }
    }
  }
}

# Define a compliant deployment
resource "kubernetes_deployment" "compliant_app" {
  metadata {
    name = "compliant-app"
    labels = {
      app = "compliant-app"
    }
  }

  spec {
    replicas = 1
    selector {
      match_labels = {
        app = "compliant-app"
      }
    }
    template {
      metadata {
        labels = {
          app = "compliant-app"
        }
      }
      spec {
        container {
          name  = "compliant-container"
          image = "mycompany.azurecr.io/my-app:v1.0.0" # Approved registry
          security_context {
            run_as_non_root = true
          }
          resources {
            limits = {
              cpu    = "500m"
              memory = "256Mi"
            }
            requests = {
              cpu    = "250m"
              memory = "128Mi"
            }
          }
        }
      }
    }
  }
}

# OPA Policy Check
data "opa_policy_check" "kubernetes_deployments_check" {
  policy_path = "kubernetes_policies.rego"
  data_json   = jsonencode([
    jsondecode(kubernetes_deployment.non_compliant_app.json),
    jsondecode(kubernetes_deployment.compliant_app.json)
  ])
}

output "policy_violations" {
  value = data.opa_policy_check.kubernetes_deployments_check.violations
}
```

And our `versions.tf` for provider configuration:

```terraform
# versions.tf
terraform {
  required_providers {
    kubernetes = {
      source = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    opa = {
      source = "terraform-opa/opa"
      version = "~> 0.1" # Adjust version as needed
    }
  }
}

provider "kubernetes" {
  # Configure your Kubernetes provider (e.g., context, kubeconfig path)
  # For local testing, ensure your kubeconfig is set up.
  # Example:
  # config_path = "~/.kube/config"
  # config_context = "my-k8s-cluster"
}
```

**Explanation of the `opa_policy_check` data source:**

*   `policy_path`: Points to our Rego policy file.
*   `data_json`: This is crucial. We're passing a JSON array containing the rendered JSON manifests of our Kubernetes deployments. The `kubernetes_deployment.non_compliant_app.json` attribute provides the full JSON representation of the planned resource. We `jsondecode` and then `jsonencode` to ensure it's properly formatted as a JSON string suitable for `data_json`.

### Step 3: Running Terraform and Observing Policy Enforcement

Now, let's run Terraform:

```bash
terraform init
terraform plan -out tfplan
```

When you run `terraform plan`, the `opa_policy_check` data source will execute the Rego policies against the planned Kubernetes manifests. If there are violations, the `violations` attribute of the data source will be populated.

For our `non_compliant_app`, we expect to see errors. The `terraform plan` output will show:

```
...

Changes to Outputs:
  + policy_violations = [
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' must not run as root. Set runAsNonRoot to true or runAsUser > 1000."
      },
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' is missing CPU limits."
      },
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' is missing memory limits."
      },
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' is missing CPU requests."
      },
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' is missing memory requests."
      },
      {
        "code" = ""
        "detail" = tostring(null)
        "message" = "Container 'non-compliant-container' in deployment 'non-compliant-app' uses an unapproved image registry 'nginx:latest'. Allowed registries: {\"gcr.io/my-project\", \"mycompany.azurecr.io\"}"
      },
    ]
```

As expected, `compliant_app` contributes no entries to `policy_violations` — its `run_as_non_root` is `true`, its resource requests and limits are all set, and `mycompany.azurecr.io` is on the approved registry list. `non_compliant_app` trips every rule we wrote: it runs as root by default, defines no resource limits or requests, and pulls from the unapproved `nginx:latest` image.

### Step 4: Failing the Pipeline on Violations

Notice that `terraform plan` doesn't stop on its own just because `policy_violations` came back non-empty — a populated data source output doesn't block anything by itself. You need to turn that output into an actual gate. Two practical ways to do it:

1.  **CI-level gate.** After `terraform plan -out=tfplan`, run `terraform show -json tfplan | jq '.values.outputs.policy_violations.value'` in your pipeline and fail the build step if the array isn't empty. This keeps the enforcement logic in CI, outside of Terraform state, and is the simplest option to reason about.
2.  **`precondition` blocks.** Since Terraform 1.2, you can attach a `lifecycle { precondition { ... } }` block directly to a resource, referencing the OPA data source, so `terraform apply` refuses to proceed:

```terraform
resource "kubernetes_deployment" "compliant_app" {
  # ... configuration as above ...

  lifecycle {
    precondition {
      condition     = length(data.opa_policy_check.kubernetes_deployments_check.violations) == 0
      error_message = "OPA policy violations detected — see the policy_violations output for details."
    }
  }
}
```

Either approach turns a passive report into a hard stop: a non-compliant manifest fails the build with a specific, actionable message, long before `kubectl apply` ever touches the cluster.

## Conclusion

Shifting compliance checks left, from a runtime admission controller to the Terraform plan stage, means a team finds out about a policy violation in the same pull request that introduced it, not three deploys later during an audit. Rego is expressive enough to cover the vast majority of Kubernetes hardening requirements, and pairing it with Terraform's plan-time evaluation turns "write a compliant manifest" from a code-review checklist item into an automated, enforced gate. Start with a handful of high-value policies — no root, mandatory resource limits, approved registries — and grow the policy set as your team's requirements mature.