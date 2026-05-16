---
title: "templates/k8srequiredlabels.yaml"
date: 2026-05-16
category: "thought-leadership"
tags: []
excerpt: "In the dynamic world of Kubernetes, ensuring security, compliance, and operational best practices isn't just a good idea – it's a necessity. As cluste..."
---

## Automating Kubernetes Policy Enforcement with OPA Gatekeeper and GitOps

In the dynamic world of Kubernetes, ensuring security, compliance, and operational best practices isn't just a good idea – it's a necessity. As clusters scale and teams grow, manual checks become untenable, and misconfigurations can lead to significant vulnerabilities or outages. This is where automated policy enforcement shines, and when combined with the principles of GitOps, it creates a robust, auditable, and self-healing security posture.

Today, we're going to dive deep into how to implement automated Kubernetes policy enforcement using [OPA Gatekeeper](https://open-policy-agent.github.io/gatekeeper/website/docs/) and a GitOps workflow. This combination allows us to define policies as code, store them in Git, and have them automatically enforced across our clusters, providing continuous validation and remediation.

### The Challenge: Manual Policy Enforcement in Kubernetes

Consider a common scenario: you want to prevent users from deploying containers with the `latest` tag, enforce specific label requirements on all deployments, or ensure that all ingresses use TLS. Without automation, this involves:

*   **Manual Reviews:** Developers submit manifests, and someone manually reviews them against a checklist. This is slow, error-prone, and doesn't scale.
*   **Post-Deployment Audits:** Policies are checked *after* resources are deployed, leading to potential security gaps or downtime if non-compliant resources need to be reverted.
*   **Inconsistent Enforcement:** Different clusters or teams might interpret policies differently, leading to drift.

### The Solution: OPA Gatekeeper + GitOps

OPA Gatekeeper is an admission controller that leverages the Open Policy Agent (OPA) engine to enforce policies on your Kubernetes clusters. It intercepts requests to the Kubernetes API server and validates them against a set of policies written in Rego, OPA's high-level declarative language.

When we combine Gatekeeper with GitOps, we achieve:

1.  **Policy as Code:** All policies are defined in Rego and stored in a Git repository.
2.  **Version Control & Auditability:** Every change to a policy is tracked, reviewed, and approved via standard Git workflows.
3.  **Automated Deployment:** GitOps tools (like Argo CD or Flux CD) detect changes in the policy repository and automatically apply them to the cluster.
4.  **Continuous Enforcement:** Gatekeeper continuously monitors and enforces these policies, blocking non-compliant resources at creation/update time and identifying existing violations.

### Anatomy of Gatekeeper Policies

Gatekeeper introduces two custom resource definitions (CRDs):

*   **`ConstraintTemplate`**: Defines the schema and Rego logic for a policy. It's like a function definition.
*   **`Constraint`**: An instance of a `ConstraintTemplate`, applying the policy with specific parameters (like calling the function with arguments).

Let's walk through an example. We want to enforce that all `Deployment` resources must have a `team` label.

#### Step 1: Define the `ConstraintTemplate`

First, we define a `ConstraintTemplate` that checks for the presence of specific labels.

```yaml
# templates/k8srequiredlabels.yaml
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              description: "A list of labels that must be present."
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("You must provide the following labels: %v", [missing])
        }
```

**Explanation:**

*   `crd.spec.names.kind: K8sRequiredLabels`: This defines the name of the `Constraint` resource that will instantiate this template.
*   `crd.spec.validation.openAPIV3Schema`: This defines the parameters that our `Constraint` can accept. Here, it's an array of strings called `labels`.
*   `targets`: Specifies where this policy applies. `admission.k8s.gatekeeper.sh` means it's an admission controller policy.
*   `rego`: This is the core OPA policy logic.
    *   It defines a `violation` rule. If this rule evaluates to true, a violation is reported.
    *   `provided := {label | input.review.object.metadata.labels[label]}`: Creates a set of labels present on the incoming Kubernetes object.
    *   `required := {label | label := input.parameters.labels[_]}`: Creates a set of labels defined in the `Constraint`'s parameters.
    *   `missing := required - provided`: Calculates the set of labels that are required but not provided.
    *   `count(missing) > 0`: If there are any missing labels, the `violation` rule triggers.
    *   `msg`: Formats a user-friendly error message.

#### Step 2: Create a `Constraint`

Now, let's instantiate this template to enforce the `team` label on `Deployment` resources.

```yaml
# constraints/deployment-team-label.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: deployment-must-have-team-label
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
  parameters:
    labels:
      - team
```

**Explanation:**

*   `kind: K8sRequiredLabels`: Refers to the `ConstraintTemplate` we defined.
*   `match`: This section defines which resources this `Constraint` applies to. Here, it targets `Deployment` resources in the `apps` API group.
*   `parameters`: Provides the input for our `ConstraintTemplate`. We specify that the `team` label is required.

### Integrating with GitOps (e.g., Argo CD)

Here's how we'd integrate this with an Argo CD-based GitOps workflow:

1.  **Repository Structure:** Create a Git repository (e.g., `git@github.com:your-org/kubernetes-policies.git`) that holds your `ConstraintTemplate`s and `Constraint`s.

    ```
    kubernetes-policies/
    ├── templates/
    │   └── k8srequiredlabels.yaml
    └── constraints/
        └── deployment-team-label.yaml
        └── no-latest-tag.yaml
        └── ingress-must-have-tls.yaml
    ```

2.  **Argo CD Application:** Configure an Argo CD `Application` resource to synchronize this repository to your cluster.

    ```yaml
    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: gatekeeper-policies
      namespace: argocd
    spec:
      project: default
      source:
        repoURL: git@github.com:your-org/kubernetes-policies.git
        targetRevision: HEAD
        path: .
      destination:
        server: https://kubernetes.default.svc
        namespace: gatekeeper-system # Or wherever Gatekeeper is installed
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
    ```

**Workflow:**

1.  A developer wants to introduce a new policy or modify an existing one.
2.  They create a branch, add/modify the relevant `ConstraintTemplate` or `Constraint` YAML files in the `kubernetes-policies` repository.
3.  They open a Pull Request (PR).
4.  The PR undergoes code review, potentially with automated tests (e.g., `conftest` to test Rego policies against example manifests).
5.  Once approved and merged to `main`, Argo CD detects the change in the `kubernetes-policies` repository.
6.  Argo CD automatically applies the new/updated policies to your Kubernetes cluster.
7.  Gatekeeper immediately starts enforcing these policies.

### Seeing It in Action

Let's assume our `k8srequiredlabels` `ConstraintTemplate` and `deployment-must-have-team-label` `Constraint` are deployed.

**Attempting to deploy a non-compliant resource:**

```yaml
# bad-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app-bad
  labels:
    app: my-app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-container
        image: nginx
```

If you try to apply this:

```bash
kubectl apply -f bad-deployment.yaml
```

You'll get an error similar to this:

```
Error from server ([deployment-must-have-team-label] You must provide the following labels: {"team"}): error when creating "bad-deployment.yaml": admission webhook "validation.gatekeeper.sh" denied the request: [deployment-must-have-team-label] You must provide the following labels: {"team"}
```

Gatekeeper blocked the deployment *before* it even reached the cluster's persistent state, preventing a security or compliance violation.

**Deploying a compliant resource:**

```yaml
# good-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app-good
  labels:
    app: my-app
    team: backend # <-- Compliant now!
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
        team: backend
    spec:
      containers:
      - name: my-container
        image: nginx
```

```bash
kubectl apply -f good-deployment.yaml
# deployment.apps/my-app-good created
```

Success! The deployment is allowed because it satisfies the policy.

### Auditing Existing Resources

Gatekeeper doesn't just block new creations/updates; it can also audit existing resources for compliance. Once a `Constraint` is applied, Gatekeeper will periodically scan the cluster and report any violations under the `status.violations` field of the `Constraint` resource itself.

```bash
kubectl get k8srequiredlabels deployment-must-have-team-label -o yaml
```

You'll see a `status.violations` section listing any deployments that are currently missing the `team` label. This is incredibly powerful for identifying drift and ensuring continuous compliance.

### Actionable Takeaways

*   **Start