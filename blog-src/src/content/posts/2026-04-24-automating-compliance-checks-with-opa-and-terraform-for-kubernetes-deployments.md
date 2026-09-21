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

import rego.v1

# Policy 1: Containers must not run as root
deny contains msg if {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.securityContext.runAsNonRoot
    not container.securityContext.runAsUser > 1000
    msg := sprintf("Container '%s' in deployment '%s' must not run as root. Set runAsNonRoot to true or runAsUser > 1000.", [container.name, input.metadata.name])
}

# Policy 2: Containers must have resource limits and requests
deny contains msg if {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.limits.cpu
    msg := sprintf("Container '%s' in deployment '%s' is missing CPU limits.", [container.name, input.metadata.name])
}

deny contains msg if {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.limits.memory
    msg := sprintf("Container '%s' in deployment '%s' is missing memory limits.", [container.name, input.metadata.name])
}

deny contains msg if {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.requests.cpu
    msg := sprintf("Container '%s' in deployment '%s' is missing CPU requests.", [container.name, input.metadata.name])
}

deny contains msg if {
    some i
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[i]
    not container.resources.requests.memory
    msg := sprintf("Container '%s' in deployment '%s' is missing memory requests.", [container.name, input.metadata.name])
}

# Policy 3: Only images from approved registries are allowed
approved_registries := {"mycompany.azurecr.io", "gcr.io/my-project"}

deny contains msg if {
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
*   `import rego.v1`: Opts the module into Rego v1 syntax (the default since OPA 1.0) — required for the `contains`/`if` keywords below to parse.
*   `deny contains msg if { ... }`: A partial-set rule — `msg` is added to the `deny` set for every set of variable bindings that satisfies the body. `msg` contains the error message.
*   `input`: This special variable holds the JSON document being evaluated (in our case, the Kubernetes resource manifest).
*   `some i`: An iterator to loop through arrays (like containers).
*   `sprintf`: A formatting function for constructing error messages.

### Step 2: Integrating OPA with Terraform

Terraform has no built-in, in-band way to run OPA policies against a resource as part of `terraform plan` — there's no official (or reliable third-party) provider that hands you a `violations` output from inside your `.tf` files. The pattern that actually works, and the one both HashiCorp's own tutorials and OPA's docs document, runs *outside* Terraform's provider model entirely: render the plan to JSON with `terraform show -json`, and evaluate that JSON against your Rego policies with the OPA CLI or `conftest`. It's a pipeline step, not a resource.

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

There's no OPA provider block here, because there's no OPA provider — the policy check happens after `terraform plan`, against the plan's JSON output, as its own pipeline step.

### Step 3: Running Terraform and Observing Policy Enforcement

Now, let's run Terraform and render the plan to JSON:

```bash
terraform init
terraform plan -out=tfplan
terraform show -json tfplan > tfplan.json
```

`tfplan.json` contains the full planned state of both `kubernetes_deployment.non_compliant_app` and `kubernetes_deployment.compliant_app`. Now evaluate it against `kubernetes_policies.rego` with `conftest` (install via `brew install conftest`, or download from GitHub releases):

```bash
conftest test tfplan.json --policy kubernetes_policies.rego
```

For our `non_compliant_app`, we expect to see failures. The `conftest` output will show something like:

```
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' must not run as root. Set runAsNonRoot to true or runAsUser > 1000.
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' is missing CPU limits.
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' is missing memory limits.
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' is missing CPU requests.
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' is missing memory requests.
FAIL - tfplan.json - kubernetes.admission - Container 'non-compliant-container' in deployment 'non-compliant-app' uses an unapproved image registry 'nginx:latest'. Allowed registries: {"gcr.io/my-project", "mycompany.azurecr.io"}

6 tests, 0 passed, 0 warnings, 6 failures, 0 exceptions
```

`non_compliant_app` trips every rule we wrote: it runs as root by default, defines no resource limits or requests, and pulls from the unapproved `nginx:latest` image. `compliant_app` produces no `FAIL` lines — its `run_as_non_root` is `true`, its resource requests and limits are all set, and `mycompany.azurecr.io` is on the approved registry list.

### Step 4: Failing the Pipeline on Violations

Unlike a Terraform data source, `conftest test` doesn't need a separate gating step — it exits non-zero the moment any `deny` rule matches, which is exactly what a CI pipeline needs to fail the build on. Drop it in right after `terraform show -json` in your pipeline (GitHub Actions, GitLab CI, or whatever you're running), before the `apply` step:

```bash
terraform plan -out=tfplan
terraform show -json tfplan > tfplan.json
conftest test tfplan.json --policy kubernetes_policies.rego   # non-zero exit stops the pipeline here
terraform apply tfplan
```

A non-compliant manifest fails the build with the specific, actionable `msg` from the offending rule, long before `kubectl apply` (or Terraform's own `apply`) ever touches the cluster.

## Conclusion

Shifting compliance checks left, from a runtime admission controller to the Terraform plan stage, means a team finds out about a policy violation in the same pull request that introduced it, not three deploys later during an audit. Rego is expressive enough to cover the vast majority of Kubernetes hardening requirements, and pairing it with Terraform's plan-time evaluation turns "write a compliant manifest" from a code-review checklist item into an automated, enforced gate. Start with a handful of high-value policies — no root, mandatory resource limits, approved registries — and grow the policy set as your team's requirements mature.