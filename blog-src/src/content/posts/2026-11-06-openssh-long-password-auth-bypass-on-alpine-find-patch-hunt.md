---
title: "OpenSSH Long-Password Auth Bypass on Alpine: Find, Patch, Hunt"
date: 2026-11-06
category: "thought-leadership"
tags: ["openssh", "alpine-linux", "containers", "vulnerability-management", "incident-response", "threat-hunting"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "OpenSSH shipped an emergency release, 10.6p2, to fix a flaw that lets attackers log in to accounts that have no password on some Alpine Linux servers..."
---

OpenSSH shipped an emergency release, 10.6p2, to fix a flaw that lets attackers log in to accounts that have no password on some Alpine Linux servers running the standard `openssh-server` package. That includes the key-only accounts most of us consider "safe." The reported requirements are low:

- network access to the SSH service
- a valid account name
- a password between **257 and 1,024 bytes** long

OpenSSH rates the flaw critical. Alpine has published fixed packages. The news summary I'm working from is truncated, so I won't guess at details it doesn't give: the CVE identifier, CVSS score, exact affected Alpine releases, or fixed package version strings. **Get those from the OpenSSH release notes and the Alpine security advisory** and plug them into the commands below.

Alpine is everywhere in container land, so the work splits into three parts: find what you have, patch it, and check whether anyone got there first.

## Why this one deserves a fast response

Key-only SSH is the standard hardening advice. Admins lock the password field (`!` or `*` in `/etc/shadow`), disable passwords, and move on. A bug that turns "no usable password" into "log in with a long junk string" undermines that assumption. Three things make it urgent:

1. **The attacker needs only a username.** Names like `root`, `admin`, `git`, `ubuntu`, and `deploy` are guessable or discoverable.
2. **Alpine is common in odd places.** Bastion containers, CI runners, network appliances, sidecar debug images, and "temporary" SSH-enabled containers that became permanent.
3. **Authentication is the control that fails.** Whether it's exploitable depends on your config, but you shouldn't count on config to save you until you've verified it.

## Step 1: Find exposed hosts

Start with the question "where does Alpine run `sshd`?" and don't limit it to VMs.

### On hosts you manage

```sh
# Is it Alpine, and which OpenSSH packages are installed?
. /etc/os-release && echo "$PRETTY_NAME"
apk list -I 2>/dev/null | grep -E '^openssh'

# Is sshd actually running and listening?
rc-service sshd status 2>/dev/null
netstat -lntp 2>/dev/null | grep -E ':22\b|sshd'
```

Compare the installed `openssh-server` version to the fixed version in Alpine's advisory. Don't compare by eyeballing the upstream version, since Alpine package revisions (`-rN`) matter.

### Across a fleet over SSH

If you have an inventory, a simple loop gets you a first pass:

```sh
while read -r host; do
  printf '%s\t' "$host"
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" \
    '. /etc/os-release; [ "$ID" = alpine ] && apk list -I 2>/dev/null | grep -E "^openssh-server" || echo "not-alpine-or-none"' \
    2>&1 | tr '\n' ' '
  echo
done < hosts.txt
```

### Over the network (no credentials)

Banner grabbing tells you what's listening, but treat it as a lead and not a verdict, because banners don't prove the distro or the package revision:

```sh
nmap -p 22,2222 --open -sV --version-intensity 2 10.0.0.0/16 -oG ssh-sweep.gnmap
grep -i openssh ssh-sweep.gnmap
```

Don't forget alternate ports (2222, 2200, high NodePorts) and anything published by container port mappings.

### In containers

This is where most teams will miss things. Check three layers: running containers, images in your registry, and Kubernetes workloads.

**Running Docker containers:**

```sh
for c in $(docker ps -q); do
  name=$(docker inspect -f '{{.Name}}' "$c")
  out=$(docker exec "$c" sh -c \
    '. /etc/os-release 2>/dev/null; [ "$ID" = alpine ] && apk list -I 2>/dev/null | grep -E "^openssh-server"' 2>/dev/null)
  [ -n "$out" ] && echo "$name  $out"
done
```

**Images (static scan, no need to run them):** an SBOM tool answers this across your whole registry.

```sh
syft registry.example.com/team/app:latest -o json \
  | jq -r '.artifacts[] | select(.name|test("^openssh")) | "\(.name) \(.version)"'
```

Then run the same query over every image tag in use. Old tags still deployed by a forgotten CronJob count too.

**Kubernetes:**

```sh
kubectl get pods -A -o json \
 | jq -r '.items[] | .metadata.namespace as $ns | .metadata.name as $p
          | .spec.containers[] | "\($ns)/\($p)\t\(.image)"' \
 | sort -u > running-images.tsv
```

Feed that image list to your SBOM or scanner. Also look for Services of type `LoadBalancer` or `NodePort` that expose port 22, since those are your internet-reachable candidates:

```sh
kubectl get svc -A -o json | jq -r '
  .items[] | select(.spec.type=="LoadBalancer" or .spec.type=="NodePort")
  | select(any(.spec.ports[]?; .port==22 or .targetPort==22))
  | "\(.metadata.namespace)/\(.metadata.name)"'
```

### Prioritize by accounts and config

Not every installed `sshd` is equally dangerous. Rank by reachability first, then by which accounts exist.

```sh
# Accounts with empty or locked password fields
awk -F: '{ s=$2; t = (s=="") ? "EMPTY" : (s ~ /^[!*]/) ? "LOCKED" : "HASH"; print $1, t }' /etc/shadow

# Effective sshd config for a specific user/source
sshd -T -C user=root,host=localhost,addr=127.0.0.1 | \
  grep -Ei 'passwordauthentication|permitrootlogin|kbdinteractive|usepam|authenticationmethods|allowusers'
```

Be careful here. The advisory text I have says accounts with no password are affected. It doesn't say whether disabling password authentication prevents exploitation. Verify that in the vendor advisory before treating any config setting as a mitigation.

## Step 2: Patch to 10.6p2

On Alpine hosts:

```sh
apk update
apk upgrade --available openssh openssh-server openssh-server-common openssh-keygen
apk list -I | grep -E '^openssh'      # confirm against the advisory's fixed version
rc-service sshd restart
```

Package names vary by Alpine release and what you installed, so run `apk list -I | grep openssh` first and upgrade whatever is there. Existing SSH sessions generally survive a daemon restart, so a restart won't evict an attacker who already logged in. That's one more reason to do Step 3.

### Containers: rebuild, don't hot-patch

Patching inside a running container is a stopgap that disappears at the next restart. Fix the image:

```dockerfile
FROM alpine:<current-supported-tag>
RUN apk update && apk upgrade --no-cache \
 && apk add --no-cache openssh-server
```

```sh
docker build --pull --no-cache -t registry.example.com/team/bastion:fixed .
```

Then:

- Roll out through your normal pipeline and confirm the new digest is what's running.
- Make CI fail if an image contains an `openssh-server` below the fixed version. A one-line SBOM gate does it.
- Ask whether the container needs `sshd` at all. `kubectl exec`, `docker exec`, and SSM-style tooling replace most in-container SSH. If you can delete the package, that's the best fix.

### If you can't patch immediately

Reduce exposure while you schedule the fix:

- Restrict port 22 to known source ranges with security groups, firewall rules, or NetworkPolicy.
- Put SSH behind a VPN or bastion that isn't running the affected package.
- Use `AllowUsers` or `AllowGroups` to shrink the set of accounts that can even attempt authentication.
- Stop `sshd` on containers and hosts where it's not essential.

Treat these as risk reduction and not as a substitute for the fix.

## Step 3: Hunt for intrusions

Assume exploitation attempts began as soon as the fix went public, since patches get diffed quickly. You're looking for successful logins that should be impossible, then for what followed.

### Authentication logs

Alpine's default syslog (BusyBox) usually writes to `/var/log/messages`, but if you ship logs elsewhere, query there. Set `LogLevel VERBOSE` in `sshd_config` going forward for better attribution.

```sh
# Successful password-style logins. For key-only accounts, any of these is suspicious
grep -E 'sshd.*Accepted (password|keyboard-interactive)' /var/log/messages

# Which accounts, from where, how often
grep -E 'sshd.*Accepted' /var/log/messages \
 | awk '{for(i=1;i<=NF;i++){if($i=="for")u=$(i+1); if($i=="from")ip=$(i+1)}; print u, ip}' \
 | sort | uniq -c | sort -rn | head -50
```

The key question is whether any `Accepted password` or `Accepted keyboard-interactive` event appears for an account that is locked or has an empty password field and is supposed to use keys only. Cross-reference with the `awk` shadow listing from Step 1.

Also look for oddities:

- bursts of connections from one source followed by an acceptance
- logins for accounts that don't normally log in interactively (`git`, service accounts)
- successful logins from new ASNs or countries

I'm not claiming there's a log signature unique to this bug. The summary doesn't describe one, and password contents won't be in logs. Check the advisory for any detection guidance.

### Network telemetry

SSH payloads are encrypted, so you can't read password length directly. You can still look for anomalies in flow data: short-lived SSH sessions from external IPs to hosts that should only see traffic from your bastion, or sudden outbound connections from hosts that accept SSH.

```sh
# Current established SSH sessions
ss -tnp state established '( sport = :22 )'
# Recent logins
last -aiF | head -50
```

### Post-compromise checks

If you find a suspicious login, check for the usual persistence:

```sh
# Modified authorized_keys files
find / -xdev -name authorized_keys -mtime -14 -ls 2>/dev/null

# New or changed accounts
awk -F: '$3==0 || $7 !~ /(nologin|false)$/ {print}' /etc/passwd
ls -l --time-style=full-iso /etc/passwd /etc/shadow /etc/group

# Cron and startup hooks
ls -la /etc/crontabs /etc/periodic /etc/local.d 2>/dev/null
rc-update show

# Recently modified executables and unexpected listeners
find / -xdev -type f -perm -111 -mtime -14 -ls 2>/dev/null | head -100
netstat -lntp
```

For containers, remember that evidence may be gone. If a pod restarted, its filesystem and logs went with it. Pull from your central log pipeline, node-level logs, and registry/audit history. For a container you suspect, preserve it before replacing it:

```sh
docker export <container> > evidence-<container>.tar
docker diff <container>    # what changed from the image
docker logs <container> > evidence-<container>.log
```

If you confirm unauthorized access, rotate credentials and SSH keys that were present on the host, rebuild from a known-good image, and review lateral movement to anything the host could reach.

## Takeaways

- **Inventory first.** Alpine's footprint in containers makes "where is `sshd`?" the hardest question. Use SBOMs and registry scans, not just host agents.
- **Verify against the advisory.** Confirm affected Alpine releases, fixed package versions, and any config-based mitigations in the OpenSSH and Alpine advisories.
- **Patch by rebuilding images,** and take this chance to remove `sshd` from containers that don't need it.
- **Hunt for impossible logins.** Password-based acceptances on key-only accounts are your best signal, followed by persistence artifacts.
- **Restarting `sshd` isn't containment.** Anyone already in stays in until you rotate and rebuild.

Key-only SSH is still good practice, but this is a reminder that it works only as long as the daemon enforces it. Layer network restrictions, minimal packages, and log visibility so one auth bug doesn't become a breach.

## Sources

- [OpenSSH Issues Emergency Fix for Flaw Letting Long Passwords Bypass SSH Auth on Alpine Linux](https://thehackernews.com/2026/11/openssh-issues-emergency-fix-for-flaw.html) (2026-11-05)
