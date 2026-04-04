---
title: "Version Controlling Your .claude Directory Across Machines (With Secret Leak Prevention)"
date: 2026-04-04
category: "dev-session"
tags: ["claude-code", "git", "security", "developer-tools", "gitleaks"]
excerpt: "How I track my Claude Code configuration with git, sync it across multiple laptops, and use gitleaks to prevent credentials from ever hitting the remote."
---

If you use [Claude Code](https://claude.ai/code) across multiple machines, you've probably noticed the `~/.claude` directory quietly accumulating settings, hooks, skills, and plugin configs. Lose that directory and you're rebuilding your workflow from scratch.

Here's how I version-control mine with git, keep it synced across machines, and make sure secrets never leak into the repo.

## The Problem

The `~/.claude` directory contains everything that makes Claude Code *yours* — your `settings.json`, custom hooks, installed skills, plugin manifests, and project-specific instructions in `CLAUDE.md`. But it also contains session data, cache files, auth tokens, and other ephemeral state that absolutely should not be committed.

## Step 1: Initialize the Repo

```bash
cd ~/.claude
git init
```

## Step 2: Create a Thorough .gitignore

This is the critical part. The `.claude` directory has a lot of runtime data that shouldn't be tracked. Here's the `.gitignore` I use:

```gitignore
# macOS system files
.DS_Store

# Ephemeral session data
debug/
projects/
file-history/
shell-snapshots/
paste-cache/
downloads/
usage-data/
telemetry/
statsig/
backups/
todos/
tasks/

# Auto-generated state
history.jsonl
stats-cache.json
cache/

# Plugin runtime data (downloaded/cached, not config)
plugins/cache/
plugins/marketplaces/
plugins/known_marketplaces.json
plugins/installed_plugins.json
plugins/install-counts-cache.json

# Nested project-level Claude settings (machine-specific)
.claude/

# Local-only settings (machine-specific permissions etc.)
settings.local.json

# Runtime/ephemeral directories
sessions/
context-mode/

# Secrets
.env
*.local
```

The key insight: you want to track *configuration* (settings, hooks, skills) but ignore *state* (sessions, cache, telemetry). The `settings.local.json` exclusion is important — that file contains machine-specific permission overrides that won't make sense on another laptop.

## Step 3: Push to a Private Remote

```bash
git add .
git commit -m "Initial commit of Claude Code configuration"
git remote add origin git@github.com:yourusername/ClaudeDotFiles.git
git push -u origin master
```

**Make sure the repo is private.** Even with a good `.gitignore`, it's defense-in-depth.

## Step 4: Add Gitleaks as a Safety Net

A `.gitignore` prevents *known* sensitive files from being tracked, but it won't catch a secret accidentally pasted into a tracked file like `settings.json` or a hook script. That's where [gitleaks](https://github.com/gitleaks/gitleaks) comes in — it scans staged changes for API keys, tokens, and passwords before every commit.

Install it:

```bash
brew install gitleaks
```

Create a tracked hooks directory so the hook travels with the repo:

```bash
mkdir -p ~/.claude/githooks

cat > ~/.claude/githooks/pre-commit << 'HOOK'
#!/usr/bin/env bash
gitleaks git --pre-commit --staged
HOOK

chmod +x ~/.claude/githooks/pre-commit
```

Tell git to use it:

```bash
git -C ~/.claude config core.hooksPath githooks
```

Now commit and push the hook itself:

```bash
cd ~/.claude
git add githooks/pre-commit
git commit -m "Add gitleaks pre-commit hook for secret scanning"
git push
```

Every commit is now scanned. If gitleaks detects a secret, the commit is blocked with a clear message showing exactly which line triggered the alert.

## Step 5: Set Up Another Machine

On a new laptop:

```bash
# Clone your config
git clone git@github.com:yourusername/ClaudeDotFiles.git ~/.claude

# Activate the gitleaks hook
git -C ~/.claude config core.hooksPath githooks

# Install gitleaks
brew install gitleaks
```

That's it. Your settings, hooks, skills, and CLAUDE.md are all there. Claude Code picks them up immediately.

## What Gets Synced

Here's what I track and why:

| File/Directory | Purpose |
|---|---|
| `settings.json` | Global Claude Code settings, plugin config, env vars |
| `CLAUDE.md` | Global instructions that apply to all projects |
| `hooks/` | Custom shell hooks (session start, RTK rewrite, etc.) |
| `githooks/` | Git hooks like the gitleaks pre-commit |
| `skills/` | Installed and custom skills |
| `plugins/.install-manifests/` | Plugin installation state (so plugins restore on clone) |

## Bonus: Add Gitleaks to Your Other Repos Too

The same pattern works for any repo:

```bash
mkdir -p githooks

cat > githooks/pre-commit << 'HOOK'
#!/usr/bin/env bash
gitleaks git --pre-commit --staged
HOOK

chmod +x githooks/pre-commit
git config core.hooksPath githooks
git add githooks/pre-commit
git commit -m "Add gitleaks pre-commit hook for secret scanning"
```

I've added this to all my active projects. It's two lines in the hook, zero ongoing maintenance, and it's caught me before I committed a test API key more than once.

## Give This to Your AI

If you use Claude Code (or any AI coding assistant), you can paste this entire article as context and ask it to set this up for you. The commands are copy-paste ready, and the `.gitignore` covers the current structure of the `~/.claude` directory as of early 2026.

The one thing to customize is the `.gitignore` — if you use additional plugins or tools that generate runtime data in `~/.claude`, add those directories to the ignore list before your first commit.

---

*This setup has been running across my MacBook Air and MacBook Pro for several months now. The combination of a thorough `.gitignore` and gitleaks pre-commit hooks means I can freely commit config changes without worrying about what might slip through.*
