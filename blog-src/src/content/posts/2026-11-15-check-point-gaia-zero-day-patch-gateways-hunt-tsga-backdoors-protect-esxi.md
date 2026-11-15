---
title: "Check Point Gaia Zero-Day: Patch Gateways, Hunt TSGA Backdoors, Protect ESXi"
date: 2026-11-15
category: "thought-leadership"
tags: ["check-point", "incident-response", "threat-hunting", "vmware-esxi", "network-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Most organizations treat the firewall as a control: something that enforces policy and stays outside the threat model. When an attacker gets a root..."
---

Most organizations treat the firewall as a control: something that enforces policy and stays outside the threat model. When an attacker gets a root shell on the gateway, that assumption fails. The device you rely on for visibility becomes the attacker's best foothold.

That is the situation Check Point has described. According to their reporting, an unknown threat actor has been targeting **unpatched Check Point Security Gateways**. The chain works like this:

1. **Initial access** through the **PHP2Shell** vulnerabilities.
2. **Privilege escalation** through a **previously unreported local privilege escalation flaw in Gaia OS**.
3. **Persistence** through a backdoor called **TSGA**.
4. **Impact** that, according to the reporting, includes **wiping files on VMware ESXi hosts**.

The activity began on **October 30, 2026**. It initially targeted **Israeli organizations**, and a broader follow-up campaign came after.

A note on identifiers before we go further. Some write-ups track the Gaia privilege escalation flaw as CVE-2026-123039. I could not verify that identifier against the original news coverage. **Confirm the CVE assignment, affected versions, and fixed builds in Check Point's own advisory** before you put them in a change ticket. The same applies to the PHP2Shell CVE IDs and any indicators of compromise. Use the vendor's published list rather than anything you see repeated secondhand, including in this post.

Here is how I would run this response if it landed on my team's desk today.

## Why This Chain Is Worse Than It Looks

Each stage changes your response in a specific way:

- **The web-facing bug gives code execution on the gateway.** The gateway is reachable from the internet by design, so you cannot "just not expose it."
- **The LPE turns a limited foothold into root on Gaia.** Root on a gateway means access to the policy, VPN key material, certificates, SIC trust, and every network segment the gateway touches.
- **A dedicated backdoor (TSGA) means persistence survives patching.** Patching closes the door but does not evict anyone already inside.
- **ESXi wiping shows the objective is destruction, not just espionage.** Your virtualization layer is the blast radius.

So the work divides into four parallel tracks: **reduce exposure, patch, hunt, and harden ESXi**. Do not run them strictly in sequence. Patching a compromised box and declaring victory is the most likely way to get this wrong.

## Track 1: Inventory and Reduce Exposure (Hours, Not Days)

You cannot patch what you have not found. Start with a hard inventory of every Gaia system: gateways, clusters, VSX, Maestro, and any gateways managed by business units outside central IT.

On each gateway, capture the version and installed hotfixes. From Gaia clish:

```bash
clish -c "show version all"
```

From expert mode:

```bash
# Installed hotfixes and Jumbo takes per component
cpinfo -y all 2>/dev/null | tee /var/tmp/cpinfo_$(hostname)_$(date +%F).txt
```

Compare the output against the fixed builds listed in Check Point's advisory. Do not compare against a version number from a news article.

While you wait on maintenance windows, shrink the attack surface. Check the advisory to see exactly which web-facing component the PHP2Shell vulnerabilities live in. Then ask whether that portal needs internet exposure at all. In my experience, Gaia Portal and other management interfaces should never be reachable from untrusted networks. Here is a quick check from the gateway itself:

```bash
# What is listening, and on which interfaces?
netstat -tlnp | awk 'NR>2 {print $4, $7}' | sort -u
```

Then verify from outside. Run a scan from an external vantage point you control against your gateways' public IPs:

```bash
nmap -Pn -sT -p 22,80,443,4434,8443,18264 --open -oA gw_external_exposure <gateway_public_ips>
```

Treat anything management-related that answers from the internet as a finding. Fix it with an explicit drop rule or by binding the service to an internal interface. Also restrict Gaia's allowed management clients:

```bash
clish -c "show allowed-client all"
# Restrict to your jump hosts / management subnet, e.g.:
clish -c "add allowed-client network ipv4-address 10.20.30.0 mask-length 24"
clish -c "delete allowed-client host any-host"
clish -c "save config"
```

> **Caution:** Removing `any-host` before adding your own subnet is a classic way to lock yourself out. Add first, test from the jump host, then delete.

## Track 2: Patch, But Treat Patching as a Checkpoint

Apply the fixed Jumbo Hotfix or dedicated hotfix that Check Point specifies, following your normal cluster upgrade procedure (standby member first, failover, then the other member). Two operational notes:

1. **Collect forensic data before you patch.** Hotfix installation and the reboot that follows will overwrite or destroy volatile evidence: running processes, network connections, `/tmp` contents. Run the triage script below first.
2. **Record what "patched" means.** Save the post-patch `cpinfo -y all` output alongside the pre-patch output. Months from now, someone will ask whether gateway X was vulnerable during a given window. You want an answer in seconds.

## Track 3: Hunt for TSGA and Post-Exploitation Activity

I am not going to list TSGA file names, hashes, or C2 addresses. I do not have authoritative ones, and fabricated IOCs are worse than none. Pull those from Check Point's report and load them into your tooling.

What I *can* give you is a behavioral hunt that works regardless of the specific implant. A web-to-root chain on a Linux-based appliance leaves predictable traces:

- new or modified files in web roots
- unexpected persistence (cron, rc scripts, SSH keys)
- new or modified accounts
- processes running from odd locations or deleted binaries
- outbound connections the gateway itself initiated

### A Read-Only Triage Script for Gaia Expert Mode

The script below collects evidence. It changes nothing. Run it on every gateway, ideally **before** patching, and pull the tarball off-box.

```bash
#!/bin/bash
# gaia_triage.sh: read-only evidence collection for Gaia gateways
# Usage (expert mode): bash gaia_triage.sh 2026-10-25
# Arg 1: hunt start date (YYYY-MM-DD). Choose a date before the
# campaign start Check Point reported (Oct 30, 2026) for margin.

set -u
SINCE="${1:-2026-10-25}"
HOST=$(hostname)
OUT="/var/tmp/triage_${HOST}_$(date +%Y%m%d%H%M%S)"
mkdir -p "$OUT"

log() { echo "[*] $*"; }
run() { local name="$1"; shift; "$@" > "$OUT/$name.txt" 2>&1; }

touch -d "$SINCE" /var/tmp/.hunt_ref

log "System and versions"
run uname     uname -a
run uptime    uptime
run cpinfo    cpinfo -y all
run clish_ver clish -c "show version all"

log "Processes (full command lines, plus deleted or odd binaries)"
run ps_full ps -eo pid,ppid,user,lstart,cmd --forest
ls -l /proc/[0-9]*/exe 2>/dev/null | grep -E '\(deleted\)|/tmp/|/dev/shm/|/var/tmp/' \
  > "$OUT/suspicious_exe.txt"

log "Network state"
run netstat_listen netstat -tulnp
run netstat_estab  netstat -tnp

log "Accounts and auth"
run passwd     cat /etc/passwd
run uid0       awk -F: '$3==0 {print}' /etc/passwd
run clish_user clish -c "show users"
run lastlog    last -Fw
find / -xdev -name authorized_keys -exec ls -l {} \; -exec cat {} \; \
  > "$OUT/authorized_keys.txt" 2>/dev/null

log "Persistence locations"
{
  for u in $(cut -d: -f1 /etc/passwd); do
    echo "== crontab: $u"; crontab -l -u "$u" 2>/dev/null
  done
  echo "== /etc/cron*"; ls -laR /etc/cron* 2>/dev/null
  echo "== rc.local";   cat /etc/rc.d/rc.local 2>/dev/null
} > "$OUT/persistence.txt"

log "Kernel modules"
run lsmod lsmod

log "Recently modified files (excluding noisy log/proc paths)"
find / -xdev -newer /var/tmp/.hunt_ref -type f \
  ! -path "/proc/*" ! -path "/sys/*" \
  ! -path "$FWDIR/log/*" ! -path "/var/log/*" \
  -printf '%TY-%Tm-%Td %TH:%TM  %u  %m  %p\n' 2>/dev/null \
  | sort > "$OUT/modified_since_${SINCE}.txt"

log "Executable or script files in temp locations"
find /tmp /var/tmp /dev/shm -xdev -type f \
  \( -perm -u+x -o -name '*.php' -o -name '*.sh' -o -name '*.py' \) \
  -printf '%TY-%Tm-%Td %TH:%TM  %u  %p\n' 2>/dev/null > "$OUT/temp_execs.txt"

log "Recently modified PHP files anywhere on the root filesystem"
find / -xdev -name '*.php' -newer /var/tmp/.hunt_ref \
  -printf '%TY-%Tm-%Td %TH:%TM  %u  %p\n' 2>/dev/null > "$OUT/php_recent.txt"

log "Logs"
cp -a /var/log/messages* /var/log/secure* "$OUT/" 2>/dev/null

tar czf "${OUT}.tgz" -C /var/tmp "$(basename "$OUT")"
sha256sum "${OUT}.tgz" | tee "${OUT}.tgz.sha256"
log "Done: ${OUT}.tgz (copy off-box and record the hash)"
```

### What to Look For

When you review the output, these are the items I would escalate immediately:

- **`uid0.txt`** shows anything other than `root` (and any expected vendor accounts).
- **`suspicious_exe.txt`** is non-empty. Processes running from `/tmp`, `/dev/shm`, or deleted binaries on a firewall appliance are almost never legitimate.
- **`php_recent.txt`** contains files you cannot tie to a hotfix install date. A PHP file appearing in a web directory after October 30 deserves a close look.
- **`netstat_estab.txt`** shows the gateway itself (not traffic passing through it) holding connections to external IPs that are not Check Point update or licensing infrastructure, your SIEM, your management server, or your NTP/DNS servers.
- **`persistence.txt`** contains cron entries or rc.local lines nobody on your team wrote.
- **`authorized_keys.txt`** contains keys you cannot attribute to a named administrator.

### Use the Gateway's Own Logs Against It

Gateway-originated traffic is often under-logged. Make sure logging is enabled for implied rules in Global Properties, then query your SmartConsole or SIEM for connections **sourced from the gateway's own interface IPs** to the internet since late October.

The following is a generic pseudo-query. Translate it to your SIEM's syntax:

```
src IN (<gateway_interface_ips>)
AND dst NOT IN (<mgmt_server>, <siem>, <dns>, <ntp>, <checkpoint_update_ranges>)
AND action = "Accept"
AND time >= "2026-10-25"
| stats count, values(dst_port) by dst
| sort -count
```

A gateway that talks to a small set of rare external IPs on unusual ports is a strong lead.

## Track 4: Protect ESXi Before It Becomes the Payload

The reporting says this actor wiped ESXi files. I do not have authoritative details on the wiping technique, so I will not guess at it. The defensive logic is the same either way: **assume a compromised gateway can reach your hypervisor management plane, and make sure it cannot do anything useful when it gets there.**

### 1. Segment ESXi Management From the Gateway's Reach

Your vCenter and ESXi management interfaces should only be reachable from a dedicated admin jump network. Ideally, enforce that with a control that does **not** depend on the gateway you are worried about, such as host-level ESXi firewall rules.

Here is the intent expressed as a rule table:

| Source | Destination | Service | Action |
|---|---|---|---|
| Admin-Jump-Hosts | ESXi-Mgmt, vCenter | HTTPS, SSH (break-glass only) | Accept + Log |
| vCenter | ESXi-Mgmt | Required vCenter–host ports | Accept + Log |
| Any | ESXi-Mgmt, vCenter | Any | Drop + Log |

Enforce the same intent on the hosts themselves:

```bash
# On each ESXi host: restrict the web UI and API to the admin subnet
esxcli network firewall ruleset set --ruleset-id=webAccess --allowed-all=false
esxcli network firewall ruleset allowedip add --ruleset-id=webAccess --ip-address=10.20.30.0/24

esxcli network firewall ruleset set --ruleset-id=sshServer --allowed-all=false
esxcli network firewall ruleset allowedip add --ruleset-id=sshServer --ip-address=10.20.30.0/24

esxcli network firewall ruleset allowedip list
```

### 2. Shut Down Shell Access and Lock Down Hosts

```bash
# Stop and disable SSH and the ESXi Shell unless actively needed
vim-cmd hostsvc/stop_ssh
vim-cmd hostsvc/disable_ssh
vim-cmd hostsvc/stop_esx_shell
vim-cmd hostsvc/disable_esx_shell

# Only allow execution of binaries installed via signed VIBs
# (supported on ESXi 7.0 U2 and later; check VMware docs for your build)
esxcli system settings encryption set --require-exec-installed-only=T
```

Then enable **lockdown mode** through vCenter (normal or strict, depending on your break-glass process). That forces management through vCenter rather than direct host logins.

### 3. Ship ESXi Logs Off-Box Now

A wiper will not leave you local logs to analyze afterward. Forward them before anything happens:

```bash
esxcli system syslog config set --loghost='tcp://siem.internal.example:514'
esxcli system syslog reload
esxcli network firewall ruleset set --ruleset-id=syslog --enabled=true
```

Then alert in your SIEM on these events:

- interactive shell activity (`shell.log` content)
- SSH being enabled on a host
- logins from sources outside the admin subnet
- bursts of datastore file deletions or VM unregistrations

### 4. Verify Backups Are Actually Out of Reach

The question is not "do we have backups?" It is this: **"Could an attacker with root on our firewall and credentials harvested from it delete or encrypt them?"**

Backup repositories should meet these conditions:

- immutable or air-gapped
- authenticated with credentials that never transit or reside on systems the gateway can reach
- tested with an actual VM restore this week, not just a green job status

## If You Find Evidence of Compromise

Do not "clean" a compromised gateway in place. Root on a security appliance plus a custom backdoor means you cannot trust the filesystem. My playbook:

1. **Preserve.** Copy the triage tarball and logs off-box, and record hashes.
2. **Fail over or replace.** Bring up a freshly installed gateway on a fixed build. Restore configuration from a backup taken **before** the compromise window, reviewed by a human.
3. **Rotate everything the gateway touched:**
   - Gaia admin and expert passwords
   - SIC (reset trust)
   - VPN pre-shared keys
   - certificates and private keys
   - RADIUS/TACACS/LDAP bind credentials
   - any API keys stored on the box
4. **Scope laterally.** Every internal system the gateway could reach is in scope. Prioritize ESXi, vCenter, domain controllers, and backup infrastructure.
5. **Engage Check Point support and your IR retainer.** Share your findings and request the full IOC set.

## Key Takeaways

- **Confirm the details at the source.** Get CVE IDs, affected versions, fixed builds, and IOCs from Check Point's advisory, not from secondhand reporting.
- **Patching closes the entry point. It does not evict an attacker.** Collect evidence first, patch second, and hunt regardless.
- **Hunt behaviorally:**
  - new PHP files
  - processes running from temp paths
  - unexpected UID 0 accounts or SSH keys
  - outbound connections the gateway itself initiated
- **Get management interfaces off the internet**, and restrict Gaia's allowed clients.
- **Protect ESXi as if the gateway is already hostile:**
  - host-level firewall allowlists
  - SSH disabled
  - `execInstalledOnly` enabled
  - lockdown mode
  - off-box logging
  - backups that the gateway's network position cannot touch

Perimeter devices are among the highest-value targets in the environment, and we should monitor them that way. If your SIEM has rich telemetry from endpoints but almost nothing from the gateways themselves, close that gap this quarter.

## Sources

- [Hackers Exploit PHP2Shell Flaws in Check Point Gateways to Deploy TSGA Backdoor and Wipe ESXi Files](https://thehackernews.com/2026/11/hackers-exploit-php2shell-flaws-in.html) (2026-11-13)
