---
title: "Gheist and GitHub Actions Secrets Theft: Detect, Rotate, Lock Down"
date: 2026-10-27
category: "thought-leadership"
tags: ["github-actions", "supply-chain-security", "incident-response", "secrets-management", "devsecops"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "According to a Wiz analysis reported by The Hacker News, an automated campaign dubbed Gheist is using stolen GitHub tokens to plant workflows that..."
---

According to a Wiz analysis reported by The Hacker News, an automated campaign dubbed Gheist is using stolen GitHub tokens to plant workflows that print a repository's secrets into GitHub Actions logs. The attackers download those logs and then delete the runs. The attacks reportedly worked against private repositories and GitHub Enterprise environments. The report also mentions a GitHub safeguard that pauses something. The excerpt I have cuts off there, so check the original coverage and GitHub's advisory for what it does and where it falls short.

The details of how the tokens were stolen aren't in what I have, and they matter less than the pattern. A valid credential with write access to a repo can turn your CI system into a secrets-dumping service, and the attacker then cleans up after themselves. Here's how to find out whether it happened to you, what to rotate, and how to make it harder next time.

## Why this attack pattern works

Actions workflows run with access to repository, environment, and sometimes organization secrets. If an attacker can push a workflow file (or modify an existing one) on a branch where it will execute, the runner does the rest:

```yaml
# Illustrative only: the shape of what you're hunting for
name: totally-normal-ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ toJSON(secrets) }}"
```

GitHub masks known secret values in logs, but masking is best-effort string matching. Any transformation of the value (encoding, splitting, reversing) can defeat it. I'm not claiming that's how Gheist does it, because the source doesn't say. But you should never treat log masking as a security boundary.

The cleanup step is what makes this hard to spot. Once the attacker downloads the logs and deletes the run, the Actions tab looks clean. Your evidence lives in the audit log and in git history, not in the runs list.

## Step 1: Hunt in the audit log

If you're on GitHub Enterprise Cloud, pull workflow-related audit events for your org. The most useful signal is workflow runs being deleted, especially by actors or tokens that don't normally do that.

```bash
# Org-level audit log (requires appropriate admin scope)
gh api -X GET "/orgs/YOUR_ORG/audit-log" \
  -f phrase='action:workflows.delete_workflow_run created:>=2026-10-01' \
  -f per_page=100 --paginate \
  --jq '.[] | [.["@timestamp"], .actor, .repo, .action, (.programmatic_access_type // "n/a")] | @tsv'
```

Event names and available fields can differ by plan and over time, so confirm them against GitHub's audit log documentation. Beyond deletions, look for:

- **Workflow runs triggered by unfamiliar actors** or at odd hours for that repo
- **Pushes to new or short-lived branches** followed shortly by a deletion event
- **Token activity from unexpected IPs**, since the audit log records `actor_ip` for many events
- **Unusual API bursts**, such as one token touching many repos in a short window

If you stream audit logs to a SIEM, the correlation rule is simple: a `workflows.delete_workflow_run` event within minutes of a workflow run created by the same actor or token, on a repo where that actor has no history of doing so.

## Step 2: Check git history for rogue workflow files

Attackers may delete the branch, but the commit often lingers in forks, caches, or your push events. Check what you can see:

```bash
# Every workflow file change across all refs in a fresh mirror clone
git clone --mirror git@github.com:YOUR_ORG/YOUR_REPO.git
cd YOUR_REPO.git
git log --all --date=iso --format='%h %ad %an <%ae> %s' \
  --diff-filter=AM -- .github/workflows/
```

Then list branches and look for anything recent you don't recognize:

```bash
gh api "repos/YOUR_ORG/YOUR_REPO/branches" --paginate \
  --jq '.[].name'

# Recent push events (limited retention, so check early)
gh api "repos/YOUR_ORG/YOUR_REPO/events" --paginate \
  --jq '.[] | select(.type=="PushEvent") | [.created_at, .actor.login, .payload.ref] | @tsv'
```

To scan workflow files across the org for suspicious patterns, a rough grep over cloned repos goes a long way:

```bash
grep -RInE 'toJSON\(secrets\)|base64|curl .*(pastebin|webhook|ngrok)|env \| sort' \
  --include='*.yml' --include='*.yaml' .github/workflows/
```

This will produce false positives. It's a triage tool, not a verdict.

## Step 3: Rotate in the right order

If you find evidence of a rogue run, or can't rule one out for a repo that a compromised token could reach, assume every secret that workflow could read is burned.

1. **Revoke the stolen credential first.** Rotating downstream secrets while the attacker still holds a working token just invites a second dump. Revoke PATs, OAuth app tokens, and deploy keys that may be implicated. Where you don't know which token was stolen, revoke broadly for the affected users and service accounts.
2. **Rotate repo, environment, and org secrets** that the affected repos could access. Include cloud keys, registry credentials, signing keys, and third-party API tokens.
3. **Check usage of the old credentials** in your cloud and SaaS logs before and after rotation. For AWS, for example, query CloudTrail for the access key ID:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=AKIAXXXXXXXXXXXXXXXX \
  --start-time 2026-10-01T00:00:00Z \
  --query 'Events[].[EventTime,EventName,Username]' --output text
```

4. **Re-issue with narrower scope.** Don't paste the same permissions into a new token.

## Step 4: Lock down who can run what

The goal is to make a single stolen token insufficient. Several controls stack well here.

**Set default `GITHUB_TOKEN` permissions to read-only** at the org level, and grant write per job:

```yaml
permissions:
  contents: read

jobs:
  release:
    permissions:
      contents: write
      id-token: write
```

**Protect the workflow directory itself.** Use CODEOWNERS plus branch protection or rulesets so workflow changes need review from your security or platform team:

```
# .github/CODEOWNERS
/.github/workflows/  @YOUR_ORG/platform-security
```

**Put sensitive secrets in environments with required reviewers** and restrict those environments to protected branches. A workflow on a random attacker-created branch then can't read production secrets without a human approving it:

```bash
# Inspect environment protection (repo admin required)
gh api repos/YOUR_ORG/YOUR_REPO/environments/production \
  --jq '{reviewers: .protection_rules, branch_policy: .deployment_branch_policy}'
```

**Restrict which actions can run** (allow-list by org or verified creators, and pin third-party actions to full commit SHAs). This doesn't stop a malicious `run:` step, but it narrows the surface.

**Prefer OIDC over long-lived cloud keys.** If there's no static AWS key in secrets, there's nothing to print. Scope the cloud trust policy tightly to repo, branch, and environment:

```json
{
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:environment:production"
    }
  }
}
```

**Tighten token hygiene:**

- Prefer fine-grained PATs or GitHub App installation tokens over classic PATs
- Set expiration on every PAT, and require approval for PATs accessing org resources if your plan supports it
- Use SSO authorization and IP allow-listing where available
- Run secret scanning with push protection so tokens don't land in repos and CI logs to begin with

## Step 5: Make deletion less useful to attackers

The attacker's cleanup step works because evidence is ephemeral. Counter that:

- **Stream the audit log to a SIEM** with retention longer than GitHub's native window
- **Alert on workflow-run deletions** by non-admin or programmatic actors
- **Alert on workflow file changes outside the default branch**, using a webhook or an org-level ruleset that restricts who can create or update matching paths
- **Limit who can delete runs** by tightening repository roles, since write access shouldn't be handed out casually

## What about GitHub's safeguard?

The news item references a GitHub safeguard that pauses something, but the text I have is truncated before explaining what or why it matters. Read the full Hacker News article and GitHub's own advisory or changelog to confirm what it covers, whether it applies to Enterprise environments, and what you need to enable. Don't assume it's on by default or that it covers your setup.

## A quick checklist

- [ ] Revoke potentially stolen tokens, then rotate secrets
- [ ] Audit `delete_workflow_run` events and recent workflow-file commits
- [ ] Check cloud and SaaS logs for use of exposed credentials
- [ ] Default `GITHUB_TOKEN` to read-only
- [ ] Require review on `.github/workflows/` via CODEOWNERS and rulesets
- [ ] Move prod secrets into environments with reviewers and branch restrictions
- [ ] Replace static cloud keys with OIDC
- [ ] Stream audit logs off-platform and alert on run deletion

## Takeaway

Gheist is a reminder that CI/CD is production infrastructure, and a repo write token is effectively a path to every secret that repo's workflows can read. Assume tokens will leak eventually, and design so a leaked token can't quietly reach your crown jewels. That means scoped credentials, gated environments, reviewed workflow changes, and logs that outlive the attacker's cleanup.

## Sources

- [Gheist Uses Stolen GitHub Tokens to Steal Private Repository Secrets via Actions Logs](https://thehackernews.com/2026/10/gheist-uses-stolen-github-tokens-to.html) (2026-10-26)
