---
title: "When Your Vulnerability Scanner Becomes the Vulnerability: Lessons from the Trivy Supply Chain Attack"
date: 2026-03-22
category: "thought-leadership"
tags: ["security", "supply-chain", "github-actions", "ci-cd", "trivy", "devsecops"]
excerpt: "A vulnerability scanner trusted by millions got backdoored — twice in one month. Here's what happened with Trivy and what it means for everyone running security tools in CI/CD."
---

There's a particular kind of irony when the tool you rely on to find vulnerabilities *is* the vulnerability. That's exactly what happened this month with Trivy, one of the most widely used open-source vulnerability scanners in the container security space — over 32,000 GitHub stars and more than 100 million Docker Hub downloads.

The tool organizations trusted to keep their software safe was compromised to steal their secrets instead.

## What Happened

In late February, a threat group known as TeamPCP (also tracked as DeadCatx3 and ShellForce) exploited a misconfigured GitHub Actions workflow in the Trivy repository. The workflow, which had been present since October 2025, triggered on external pull requests with access to repository secrets. The attackers used this to steal a personal access token with write permissions to the repo.

With that token, they went to work. They force-pushed 75 out of 76 version tags in the `aquasecurity/trivy-action` repository and seven tags in `aquasecurity/setup-trivy`. They also compromised the Trivy binary itself — version 0.69.4 shipped with a backdoor. Malicious releases were pushed to GitHub Releases, Docker Hub, GHCR, and ECR.

The payload was clever. The credential stealer was injected into a script that runs immediately *before* the legitimate Trivy scan. The scan still executes normally, so developers see expected output and have no reason to investigate. Meanwhile, in the background, the malware — self-described as "TeamPCP Cloud stealer" — dumps the GitHub Actions Runner.Worker process memory, harvests SSH keys, cloud credentials, and Kubernetes secrets, encrypts everything with AES-256 and RSA-4096, and exfiltrates it to a remote server.

Aqua Security rotated credentials after the first incident. But the rotation was incomplete, and TeamPCP compromised Trivy *a second time* within the same month using retained access.

## Why This Attack Is Different

Supply chain attacks against open-source projects aren't new. We saw it with `event-stream` in 2018, `ua-parser-js` in 2021, and the XZ Utils backdoor in 2024. But this one hits differently for a few reasons.

**The trust inversion.** Security tools occupy a privileged position in CI/CD pipelines. They need broad access to scan images, inspect configurations, and evaluate dependencies. When a security scanner is compromised, it has access to exactly the kind of secrets an attacker wants — cloud credentials, API tokens, SSH keys. The very permissions we grant for security become the attack surface.

**The stealth factor.** Because the legitimate scan still runs, there's no failed build to investigate. No red flag in the pipeline output. The attack is invisible unless you're inspecting the action source or monitoring for unexpected network traffic from your runners.

**The blast radius.** Tag manipulation in GitHub Actions is devastating. Any workflow referencing `trivy-action@v1` or similar mutable tags pulled the compromised code on next run. Thousands of organizations running Trivy in CI/CD were potentially exposed without changing a single line in their own repositories.

## What You Should Do Right Now

If you were running Trivy in CI/CD during March 2026, here's the immediate action list:

**1. Check your versions.** The safe versions are Trivy v0.69.3, trivy-action tag 0.35.0, and setup-trivy 0.2.6. If you ran anything else during the incident window, assume compromise.

**2. Pin actions to commit SHAs, not tags.** This is the single most impactful change. Tags are mutable — anyone with write access can point them somewhere else. Commit SHAs are immutable.

```yaml
# Vulnerable: tag can be force-pushed
- uses: aquasecurity/trivy-action@v1

# Safe: pinned to a specific, immutable commit
- uses: aquasecurity/trivy-action@a3fdef3ef3fb574d646498f1f1edf55e548d842b
```

**3. Rotate everything.** If you were affected, treat your CI/CD environment as fully compromised. Rotate cloud credentials, SSH keys, API tokens, database passwords — all of it. Check for unexpected IAM users, roles, or access keys that may have been created with stolen credentials.

**4. Audit your workflow permissions.** Apply the principle of least privilege to GitHub Actions. Use `permissions:` blocks to restrict what each workflow can access. External PRs should never trigger workflows with access to secrets.

```yaml
permissions:
  contents: read
  security-events: write  # only what's needed
```

## The Bigger Picture

This attack exposes a fundamental tension in DevSecOps: the tools we integrate to improve security also expand our attack surface. Every GitHub Action, every scanner, every linter that runs in your pipeline is code you're trusting implicitly — often without reviewing it, often pulling from mutable references.

The follow-on attack made this even worse. TeamPCP leveraged stolen credentials to compromise npm packages downstream, spreading a self-propagating worm dubbed CanisterWorm that used Internet Computer blockchain canisters as dead-drop resolvers for C2 infrastructure. What started as one compromised action cascaded into a much broader supply chain event.

We need to treat CI/CD pipelines with the same rigor we apply to production infrastructure:

- **Pin everything.** Actions, base images, dependency versions. Mutable references are mutable attack surfaces.
- **Monitor runner behavior.** Unexpected network connections, memory dumps, and file system writes from CI runners should trigger alerts.
- **Limit blast radius.** Use separate credentials per workflow. Don't share a single powerful PAT across your entire CI/CD system.
- **Verify, then trust.** Review action source code on updates. Use tools like StepSecurity's Harden-Runner or GitHub's built-in workflow security features.

The irony of a vulnerability scanner being the vector for credential theft shouldn't be lost on us. It's a reminder that "shift left" doesn't just mean running more tools earlier — it means critically evaluating the trust we place in those tools themselves.

Safe versions: Trivy v0.69.3 | trivy-action 0.35.0 | setup-trivy 0.2.6. Go check your pipelines.
