---
title: "Zyxel GS1900 Zero-Day: When the First Patch Fails, Here's Your Playbook"
date: 2026-11-05
category: "thought-leadership"
tags: ["network-security", "incident-response", "firmware", "vulnerability-management", "zyxel"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Most teams close a ticket once the patch is applied. This incident shows why that isn't enough. Researchers at Binarly found that Zyxel GS1900..."
---

Most teams close a ticket once the patch is applied. This incident shows why that isn't enough.

Researchers at Binarly found that Zyxel GS1900 switches running the vendor's earlier fix for an actively exploited flaw **are still vulnerable to the exploit attackers are using**. The flaw lets anyone who can reach the switch's web management interface run commands on the device without logging in. Zyxel has since released new firmware for 10 GS1900 models that closes the hole. The earlier fix was reported as the 2.90 firmware line.

If you patched to that earlier build and moved on, your switches may still be exposed, and possibly already compromised. This post covers how I'd work through it: find every GS1900 you own, cut off access to its management plane, reflash it properly, and then look for signs that someone got in first.

> **Before you start:** Pull the Zyxel advisory for this issue and confirm three things for your environment: the exact list of affected models, the exact fixed firmware version for each, and any indicators of compromise Zyxel or Binarly have published. I won't guess at version strings or model lists here. Use the advisory as your source of truth.

## Why This One Deserves Urgency

Switches are a blind spot in most security programs. They rarely run EDR, they rarely ship logs anywhere useful, and the firmware gets updated about once a decade. An unauthenticated command-execution bug on a switch's management interface is a serious problem for several reasons:

- **Network position.** A compromised switch sits in the path of your traffic. An attacker can configure port mirroring, pivot across VLANs, or just watch.
- **Persistence.** Embedded devices are a good place to hide. Nobody reimages a switch after a phishing incident.
- **False confidence.** Your vulnerability scanner probably reports these devices as remediated because they're running the "fixed" firmware. That makes them easy to overlook during triage.

The GS1900 line is aimed at SMB and branch deployments. Those are the environments where a switch's web UI is most likely to be reachable from places it shouldn't be: flat networks, guest Wi-Fi bleeding into management VLANs, or (worst case) port-forwarded to the internet for "remote admin."

## Step 1: Find Every GS1900 You Own

You can't fix what you can't find. CMDBs are usually wrong about network gear, so don't rely on yours. Scan for these devices directly.

### Start with a broad sweep for web management interfaces

```bash
# Sweep management and user subnets for HTTP/HTTPS listeners
# and grab page titles and server headers.
sudo nmap -sS -p 80,443,8080,8443 --open \
  --script http-title,http-server-header \
  -oA gs1900-sweep \
  10.0.0.0/16 172.16.0.0/12 192.168.0.0/16
```

Then grep the results for the model string:

```bash
grep -i -B6 "gs1900" gs1900-sweep.nmap | grep "Nmap scan report" | awk '{print $NF}' \
  | tr -d '()' | sort -u > gs1900-candidates.txt
wc -l gs1900-candidates.txt
```

In environments I've worked in, the login page title on these units includes the model name. Validate that against a known GS1900 in your own fleet before you trust the grep, because title formats can vary by firmware.

### Confirm model and firmware over SNMP

If you have SNMP enabled (and in a well-run shop you will), `sysDescr` is the quickest way to confirm what each device is. Here's a small script that walks your candidate list and builds an inventory CSV:

```python
#!/usr/bin/env python3
"""
gs1900_inventory.py - confirm GS1900 candidates via SNMP sysDescr / sysName.
Requires net-snmp CLI tools (snmpget) on the PATH.
"""
import csv
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

COMMUNITY = sys.argv[2] if len(sys.argv) > 2 else "public"  # use your RO community or switch to v3
OIDS = {
    "sysDescr": "1.3.6.1.2.1.1.1.0",
    "sysName": "1.3.6.1.2.1.1.5.0",
    "sysUpTime": "1.3.6.1.2.1.1.3.0",
}

def query(host: str) -> dict:
    row = {"host": host}
    for name, oid in OIDS.items():
        try:
            out = subprocess.run(
                ["snmpget", "-v2c", "-c", COMMUNITY, "-t", "2", "-r", "1", "-Oqv", host, oid],
                capture_output=True, text=True, timeout=10,
            )
            row[name] = out.stdout.strip().strip('"') or "NO_RESPONSE"
        except subprocess.TimeoutExpired:
            row[name] = "TIMEOUT"
    return row

def main():
    hosts = [h.strip() for h in open(sys.argv[1]) if h.strip()]
    with ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(query, hosts))

    with open("gs1900_inventory.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host", *OIDS.keys()])
        w.writeheader()
        w.writerows(results)

    for r in results:
        flag = "GS1900" if "gs1900" in r.get("sysDescr", "").lower() else "check-manually"
        print(f"{r['host']:<16} {flag:<15} {r['sysDescr'][:70]}")

if __name__ == "__main__":
    main()
```

```bash
python3 gs1900_inventory.py gs1900-candidates.txt 'your-ro-community'
```

For devices that don't answer SNMP, log into the web UI or CLI and record the model and running firmware by hand. It's tedious, but you need that list.

### Check external exposure separately

Run the same HTTP sweep against your public IP space from outside your network, using a cloud VM or an external attack-surface tool. **Any GS1900 management interface reachable from the internet should be treated as presumed compromised.** Those devices skip the queue and go straight to Step 4 after you isolate them.

## Step 2: Contain the Management Plane Now

Getting firmware rolled out across branch sites can take days. Restricting who can reach the web UI can be done in an hour, and the exploit depends on that reachability. Do this first.

The cleanest control is upstream of the switch, on whatever routes into the management VLAN. Here's an nftables example for a Linux-based router or firewall in front of a management subnet:

```bash
# /etc/nftables.d/mgmt-lockdown.nft
table inet mgmt_lockdown {
  set admin_jump_hosts {
    type ipv4_addr
    elements = { 10.10.50.10, 10.10.50.11 }   # your bastion/jump hosts only
  }

  set switch_mgmt_net {
    type ipv4_addr
    flags interval
    elements = { 10.99.0.0/24 }                # switch management VLAN
  }

  chain forward {
    type filter hook forward priority -10; policy accept;

    # Allow web management only from designated jump hosts
    ip daddr @switch_mgmt_net tcp dport { 80, 443 } ip saddr @admin_jump_hosts accept

    # Log and drop everything else trying to reach switch web UIs
    ip daddr @switch_mgmt_net tcp dport { 80, 443 } \
      log prefix "MGMT-WEB-BLOCK: " level warn drop
  }
}
```

```bash
sudo nft -f /etc/nftables.d/mgmt-lockdown.nft
sudo nft list table inet mgmt_lockdown
```

Keep that log rule. The blocked attempts it records are useful hunting data later, because anything hitting those ports from a non-admin source deserves a look.

If your upstream is a traditional router, the idea is the same: an ACL permitting only your admin hosts to the management subnet on 80/443, with a logged deny afterward. GS1900 switches also have their own management access controls in the web UI. Use them as a second layer, but don't rely on an on-device control as your only defense against a bug in that same device's web stack.

**Also, right now:** remove any port-forwards or NAT rules that expose switch management to the internet. I've seen "temporary" forwards that were still in place years later.

## Step 3: Reflash Properly

There's a reason this section says "reflash" and not "upgrade." If a device was compromised before you got to it, an in-place firmware upgrade from a running, attacker-controlled system is a weaker guarantee than you'd like. Here's the procedure I'd follow.

### 1. Capture evidence before you touch anything

For any device you suspect, especially the internet-exposed ones, collect what you can before upgrading:

- Export the running configuration
- Screenshot or export the user accounts, SNMP settings, syslog targets, and port mirroring config
- Record the current firmware version and uptime
- Pull any local logs the device keeps

Upgrading reboots the device, which wipes whatever volatile state might have shown you what happened.

### 2. Get firmware from the source, and verify it

Download the fixed firmware for your exact model directly from Zyxel's support portal. If Zyxel publishes checksums, verify them:

```bash
sha256sum GS1900-*.bin
# Compare against the vendor-published value. If there isn't one, record yours
# and make sure every technician is flashing the same file.
```

Stage the image on an internal, access-controlled file share. Don't let branch techs pull from random mirrors.

### 3. Flash, then factory reset suspect devices

For devices with **no exposure to untrusted networks** and no anomalies in Step 4, an in-place upgrade to the new fixed firmware is a reasonable risk call.

For devices that **were exposed or show any anomaly**, do the full process:

1. Flash the new firmware.
2. Factory reset.
3. Rebuild the configuration from a known-good template, **not** from the config you exported (that config may contain attacker changes).
4. Rotate every credential the device touched: local admin passwords, SNMP communities, RADIUS/TACACS shared secrets.

Some switches keep more than one firmware image and can boot a fallback. Check whether your model does. If it does, make sure the vulnerable image isn't left as a bootable backup.

### 4. Verify. Don't assume.

This is the main lesson of the whole incident: the first patch reported success and the exploit still worked. After reflashing, confirm the running version on every device against the advisory's fixed version:

```bash
# Re-run inventory and diff firmware strings against your expected fixed version
python3 gs1900_inventory.py gs1900-candidates.txt 'your-ro-community'
grep -i gs1900 gs1900_inventory.csv | grep -v "EXPECTED_FIXED_VERSION_STRING"
# Anything printed here is not on the fixed build.
```

Replace `EXPECTED_FIXED_VERSION_STRING` with the exact version from the advisory for each model. If your fleet mixes models, build a small model-to-version lookup instead of a single grep.

Next, check your vulnerability scanner. If its detection logic marks the earlier 2.90 fix as remediated, it will keep reporting false negatives until the plugin is updated. Talk to your scanner vendor, or write a custom check keyed on the fixed version.

## Step 4: Hunt for Compromise

Unauthenticated root-level command execution means you have to assume someone may have gotten in. Here's where I'd look, roughly in order of how much signal each source tends to give.

### Configuration drift

If you back up switch configs with RANCID, Oxidized, or even a cron job, compare current configs against your oldest trustworthy baseline. This simple diff script flags the changes that matter most on a switch:

```python
#!/usr/bin/env python3
"""
config_drift.py - flag security-relevant changes between two switch config exports.
Usage: config_drift.py baseline.cfg current.cfg
"""
import difflib
import re
import sys

WATCH = {
    "accounts":    re.compile(r"\b(user|username|account|password)\b", re.I),
    "snmp":        re.compile(r"\bsnmp\b", re.I),
    "logging":     re.compile(r"\b(syslog|logging)\b", re.I),
    "mirroring":   re.compile(r"\b(mirror|monitor session|span)\b", re.I),
    "mgmt_access": re.compile(r"\b(access[- ]?(list|control)|acl|management|http|ssh|telnet)\b", re.I),
    "aaa":         re.compile(r"\b(radius|tacacs|aaa)\b", re.I),
}

def load(path):
    with open(path, errors="replace") as f:
        return [l.rstrip() for l in f if l.strip()]

def main(base, curr):
    diff = difflib.unified_diff(load(base), load(curr), lineterm="", n=0)
    hits = 0
    for line in diff:
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        for label, rx in WATCH.items():
            if rx.search(line):
                print(f"[{label:<11}] {line}")
                hits += 1
                break
    print(f"\n{hits} security-relevant changes found." if hits else "\nNo watched changes found.")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

The most important things to look for:

- **New or modified local accounts.** These are a common way to keep access.
- **Port mirroring sessions you didn't create.** A rogue mirror port is one of the clearest signs of a compromised switch, since it means someone is copying your traffic.
- **Changed syslog destinations, or logging turned off.** Attackers want you not to see them.
- **New SNMP communities, especially read-write ones.**
- **Loosened management ACLs.**

### Outbound connections from switch management IPs

Switches should talk to very few things: your NTP servers, syslog collectors, RADIUS/TACACS, and maybe a controller. They should almost never initiate connections to the internet. That makes this one of the easier hunts to run.

With Zeek connection logs:

```bash
# Outbound connections FROM the switch management subnet to anything
# outside your known infrastructure services
cat conn.*.log | zeek-cut ts id.orig_h id.resp_h id.resp_p proto service orig_bytes resp_bytes \
  | awk '$2 ~ /^10\.99\.0\./' \
  | grep -vE '\s(10\.10\.20\.(5|6)|10\.10\.30\.10)\s' \
  | sort -k3,3 | uniq -c -f2 | sort -rn | head -50
```

Adjust the subnet and the exclusion list (your NTP, syslog, and AAA servers) to match your environment. If you're working from NetFlow or firewall logs in a SIEM, the same logic looks something like this:

```sql
SELECT src_ip, dst_ip, dst_port, COUNT(*) AS flows, SUM(bytes) AS total_bytes,
       MIN(event_time) AS first_seen, MAX(event_time) AS last_seen
FROM   firewall_flows
WHERE  src_ip  <<= '10.99.0.0/24'                -- switch management subnet
  AND  dst_ip NOT IN (SELECT ip FROM approved_infra_services)
  AND  event_time > NOW() - INTERVAL '90 days'
GROUP  BY src_ip, dst_ip, dst_port
ORDER  BY first_seen;
```

Pay particular attention to DNS queries originating from switch IPs and to any outbound HTTP/HTTPS. Command-execution exploits often end with the device fetching a second-stage payload.

### Inbound requests to the web interface

Look back through your perimeter and internal firewall logs for connections to switch management ports from sources outside your admin hosts, going back at least to when exploitation of the original flaw was first reported. Check the advisory for that window. Unusual sources, odd hours, or bursts of requests are all leads. The `MGMT-WEB-BLOCK` log prefix from Step 2 will catch new attempts from here on.

### Device-level signals

- **Unexpected reboots or uptime resets** that don't line up with maintenance windows.
- **Logging gaps** in your syslog collector for specific switches.
- **CPU or memory anomalies** on the device itself, if you poll them over SNMP.

### Published IOCs

Binarly's research and Zyxel's advisory are the authoritative sources for any specific indicators: request patterns, file artifacts, or infrastructure. I'm not repeating any here because I don't want you hunting on secondhand details. Get them from the original sources and load them into your detection tooling.

### If you find something

Treat it as a network compromise, not a device problem. Assume the attacker could see traffic passing through that switch, and work out what credentials or sensitive data crossed it. Check the hosts on those VLANs for lateral movement. Bring in your incident response process. A rogue mirror port means data has probably left the network.

## The Bigger Lessons

**1. "Patched" means the exploit no longer works.** It doesn't mean the version number changed. For actively exploited bugs, follow researcher and vendor channels for at least a few weeks after the fix ships. Incomplete patches are common, and this one was caught because someone outside the vendor tested it.

**2. Management planes should never be reachable from user or guest networks.** If your switch web UIs had been reachable only from two jump hosts, this would have been routine patching instead of an incident. Isolating management access is cheap, and it protects you against the next bug as well.

**3. Network gear needs the same telemetry as servers.** Centralized syslog, config backups with drift alerting, and flow monitoring on management subnets would turn most of Step 4 from a multi-day effort into a dashboard check.

**4. Your inventory of network gear is probably incomplete.** The sweep in Step 1 will likely turn up switches nobody knew about. Fix the inventory and keep it current.

## Your Checklist

- [ ] Pull the Zyxel advisory; confirm affected models, fixed versions, and IOCs
- [ ] Sweep internal and external address space for GS1900 management interfaces
- [ ] Isolate any internet-exposed units immediately and treat them as presumed compromised
- [ ] Restrict web management access to designated admin hosts with logged denies
- [ ] Capture configs and evidence before upgrading suspect devices
- [ ] Flash the new fixed firmware from a verified source
- [ ] Factory reset and rebuild exposed devices from known-good templates; rotate credentials
- [ ] Verify running versions against the advisory, and don't rely on scanner results alone
- [ ] Hunt: config drift, mirror ports, outbound connections, inbound management access, log gaps
- [ ] Escalate to incident response if anything turns up

The vendor shipped a fix, and the fix didn't hold. That will happen again with other products. The defenses that would have helped here are the same ones that help in every case: knowing what devices you have, limiting who can reach their management interfaces, verifying patches yourself, and collecting enough telemetry to notice when something is wrong.

## Sources

- [Zyxel GS1900 Patch Fails to Block Zero-Day Exploit Allowing Root Command Execution](https://thehackernews.com/2026/11/zyxel-gs1900-patch-fails-to-block-zero.html) (2026-11-05)
