---
title: "Cursor's Malicious Claude Code Extension: Find Installs, Rotate Keys, Hunt"
date: 2026-11-16
category: "thought-leadership"
tags: ["supply-chain", "incident-response", "threat-hunting", "developer-security", "credential-rotation"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Cursor has confirmed a security breach that let attackers distribute a malicious Claude Code extension through its marketplace. According to the..."
---

Cursor has confirmed a security breach that let attackers distribute a malicious Claude Code extension through its marketplace. According to the report, the attackers got in after stealing credentials from AI infrastructure provider Fireworks AI.

The public details are thin so far. Cursor's advisory should be your source of truth for the exact extension identifier, affected versions, the exposure window, and any indicators of compromise. I won't guess at those here. What I can give you is the playbook that applies to any trojanized IDE extension, so you can start scoping now and tighten the results once the vendor details are in hand.

## Why this class of incident is nasty

An IDE extension is not a sandboxed web page. It runs in the extension host with your user's privileges and can:

- Read anything your user can read: `~/.ssh`, `~/.aws`, `.env` files, browser profile directories, shell history.
- Spawn child processes and make arbitrary outbound network calls.
- Persist through shell profiles, scheduled tasks, or launch agents.
- Touch every repo you open, including source and secrets in the working tree.

So the question isn't just "did we install it?" It's "what could that user account reach while it was installed?" Scope accordingly.

## Step 1: Inventory what's installed

Cursor is a VS Code fork, so installed extensions live in a predictable directory. Each folder is named `publisher.name-version`.

**macOS / Linux**

```bash
#!/usr/bin/env bash
# List Cursor extensions with install/modify times
EXT_DIR="$HOME/.cursor/extensions"

if [ -d "$EXT_DIR" ]; then
  # macOS uses stat -f, Linux uses stat -c
  if stat -f '%Sm' / >/dev/null 2>&1; then
    find "$EXT_DIR" -maxdepth 1 -mindepth 1 -type d \
      -exec stat -f '%Sm  %N' -t '%Y-%m-%dT%H:%M:%S' {} \; | sort
  else
    find "$EXT_DIR" -maxdepth 1 -mindepth 1 -type d \
      -exec stat -c '%y  %n' {} \; | sort
  fi
fi
```

**Windows (PowerShell)**

```powershell
$extDir = Join-Path $env:USERPROFILE ".cursor\extensions"
if (Test-Path $extDir) {
  Get-ChildItem $extDir -Directory |
    Sort-Object LastWriteTime |
    Select-Object LastWriteTime, Name
}
```

Then filter for anything matching "claude":

```bash
ls -1 ~/.cursor/extensions 2>/dev/null | grep -i claude
```

Compare what you find against the identifier and versions in Cursor's advisory. Look closely at publisher names. Lookalike publishers are the usual way a trojan hides next to the legitimate extension.

Also check `~/.cursor/extensions/extensions.json`. It typically records the source and install metadata for each extension, which can help establish when something arrived.

## Step 2: Scale it across a fleet

For more than a handful of machines, push the inventory through your endpoint tooling. With osquery, a file-based query avoids depending on any particular table's coverage of Cursor:

```sql
SELECT path, directory, mtime, ctime
FROM file
WHERE path LIKE '/Users/%/.cursor/extensions/%/package.json'
   OR path LIKE '/home/%/.cursor/extensions/%/package.json'
   OR path LIKE 'C:\Users\%\.cursor\extensions\%\package.json';
```

Pipe the results into your SIEM and match on the extension folder name once you have the confirmed identifier. Don't forget developer VMs, remote dev boxes, and shared build hosts. Those are the places people forget.

## Step 3: Inspect a suspect extension before you delete it

Preserve evidence first. Copy the directory somewhere safe, then look at it:

```bash
SUSPECT="$HOME/.cursor/extensions/<publisher.name-version>"
mkdir -p ~/ir && cp -a "$SUSPECT" ~/ir/

# What runs when the extension activates?
jq '{name, publisher, version, main, activationEvents, scripts}' \
  "$SUSPECT/package.json"

# Process spawning, network calls, and obfuscation tells
grep -RIlE "child_process|execSync|spawn\(|powershell|curl |wget |base64|eval\(" \
  "$SUSPECT" --include='*.js' | head -50

# Hardcoded URLs and IPs
grep -RIhoE "https?://[a-zA-Z0-9./_-]+" "$SUSPECT" --include='*.js' | sort -u
```

Some of these hits are normal. A legitimate coding-assistant extension probably spawns processes and makes network calls. What you're hunting for is a mismatch: heavily obfuscated code, a hash you can't match against a known-good release, and destinations that aren't the vendor's documented endpoints. Hash everything and keep the hashes:

```bash
find "$SUSPECT" -type f -exec shasum -a 256 {} \; > ~/ir/extension.sha256
```

## Step 4: Hunt for post-compromise activity

Assume the worst-case window runs from when the extension was installed or last updated until you removed it. Check these areas.

**Process lineage.** The extension host is a child of the Cursor process. It should rarely spawn shells or download tools. Flag chains like these in your EDR:

```
Parent: Cursor (or "Cursor Helper (Plugin)" on macOS) / extension host node process
Child:  sh, bash, zsh, cmd.exe, powershell.exe, curl, wget, osascript, python
```

A generic Sigma-style sketch (adapt field names to your pipeline):

```yaml
title: IDE Extension Host Spawning Shell or Downloader
logsource:
  category: process_creation
detection:
  parent_ide:
    ParentImage|contains:
      - 'Cursor'
  child_suspicious:
    Image|endswith:
      - '/sh'
      - '/bash'
      - '/curl'
      - '/wget'
      - '\powershell.exe'
      - '\cmd.exe'
  condition: parent_ide and child_suspicious
level: medium
```

Expect noise from the integrated terminal and task runners. Tune by excluding the terminal's known process pattern and focusing on activity at times when no human was typing.

**Network.** Look at DNS and proxy logs from affected hosts for the exposure window. Surface rare domains, direct-to-IP connections, and large outbound POSTs from the Cursor process. Compare against the IOCs from the vendor advisory once published.

**Persistence.** Check the usual spots:

```bash
# macOS
ls -la ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null

# Linux
crontab -l; ls -la ~/.config/autostart ~/.config/systemd/user 2>/dev/null

# Both: recent shell profile edits
ls -la ~/.zshrc ~/.bashrc ~/.bash_profile ~/.profile 2>/dev/null
```

```powershell
# Windows
Get-ScheduledTask | Where-Object { $_.Date -gt (Get-Date).AddDays(-30) }
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
```

**Cursor's own logs.** Extension host logs typically live under `~/Library/Application Support/Cursor/logs` (macOS), `~/.config/Cursor/logs` (Linux), or `%APPDATA%\Cursor\logs` (Windows). Look for the suspect extension's activation and any errors from unexpected modules.

**Downstream use of stolen credentials.** This is often where you'll actually catch it. Review cloud audit logs (CloudTrail and equivalents), source-control audit logs, and package registry activity for the affected users. Look for logins from new IPs, new SSH keys or tokens being created, and unusual clones or pushes.

## Step 5: Rotate, in priority order

If a machine ran the malicious extension, treat everything reachable from that user session as exposed. Rotate in this order, highest blast radius first:

1. **Cloud credentials:** AWS access keys, GCP service account keys, Azure CLI sessions. Prefer short-lived credentials going forward.
2. **Source control tokens:** GitHub/GitLab PATs, OAuth app grants, deploy keys, and SSH keys in `~/.ssh`.
3. **Package registry tokens:** npm, PyPI, container registry logins (`~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`).
4. **AI and API provider keys:** including Fireworks AI keys if your team uses them, plus any other model-provider keys in env files or IDE settings. Whether Fireworks customers need to take any specific action is something to confirm in the vendor advisories, not assume.
5. **Secrets in repos and env files:** run a scanner across the working directories on affected machines.
6. **Browser sessions and password manager sessions** on affected hosts, if your hunt found evidence of broader access.

A quick way to find what's lying around on a host:

```bash
# Common secret-bearing files in a user's home (names only, not contents)
find ~ -maxdepth 4 \( -name ".env*" -o -name "*.pem" -o -name "id_*" \
  -o -name ".npmrc" -o -name ".pypirc" -o -name "credentials" \) \
  -not -path "*/node_modules/*" 2>/dev/null
```

Then revoke at the issuer, not just locally. Deleting a token from a file doesn't invalidate it. After rotating, check the issuer's audit trail for use between exposure and revocation.

If the hunt turns up confirmed malicious execution, reimage the machine instead of cleaning it. That decision costs far less than a second incident.

## Step 6: Reduce the blast radius for next time

- **Allowlist extensions.** Maintain an approved extension list and enforce it via managed config or endpoint policy. Developer machines shouldn't be a free-for-all.
- **Pin and review updates.** Disable auto-update for extensions in sensitive environments, and review new versions before rolling out.
- **Keep secrets off disk.** Use a secrets manager or credential helper and short-lived tokens, so a compromised extension finds little to read.
- **Egress control.** Restrict outbound traffic from developer workstations and remote dev environments where practical, and log everything else.
- **Separate duties by machine.** The laptop used to try new editor plugins shouldn't also hold production deploy keys.
- **Alert on your own detections.** The Sigma sketch above is a starting point. Wire it into alerting now, not during the next incident.

## What to confirm with the vendor

Before closing your investigation, pin down these items in Cursor's and Fireworks AI's advisories rather than relying on secondhand summaries:

- The exact extension identifier and affected version(s)
- The exposure window, including when it was removed from the marketplace
- Published IOCs (domains, IPs, file hashes)
- Whether any customer credentials or data were affected, and what action they recommend

## Takeaway

The reported chain here, stolen credentials at an infrastructure provider leading to a poisoned marketplace listing, is a reminder that your developer tooling inherits the security posture of every vendor behind it. Inventory first, preserve evidence, hunt the exposure window, and rotate from the highest blast radius down. Do those four things in that order and you'll be in a defensible position whatever the final advisory says.

## Sources

- [Cursor confirms security breach led to malicious Claude Code extension](https://www.bleepingcomputer.com/news/security/cursor-confirms-security-breach-led-to-malicious-claude-code-extension/) (2026-11-14)
