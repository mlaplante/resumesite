---
title: "Cisco Expressway Under Active Attack: Find Exposure, Patch, and Hunt Lateral Movement"
date: 2026-11-21
category: "thought-leadership"
tags: ["cisco", "vulnerability-management", "incident-response", "threat-hunting", "network-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Some vulnerabilities give you a week of runway. This one does not. CVE-2026-76466 is a critical flaw in Cisco Expressway with a CVSS score of 9.8...."
---

Some vulnerabilities give you a week of runway. This one does not.

CVE-2026-76466 is a critical flaw in Cisco Expressway with a CVSS score of 9.8. According to reporting from November 20, 2026, an **unauthenticated, remote attacker with network access** to an Expressway device can exploit it. Threat actors have already used it against a Russian organization **shortly after a public proof-of-concept was released**. In that incident, the attackers reportedly **breached four Expressway devices and reached the internal network**.

That last detail changes how you should respond. Patching closes the door, but it doesn't tell you whether someone already walked through it. This post covers the full loop:

1. Find every Expressway you own, especially the ones you forgot about.
2. Determine exposure and version.
3. Preserve evidence, then patch.
4. Hunt for lateral movement from those boxes into your environment.
5. Restrict what the next compromised edge appliance can reach.

**A note on what we don't know.** The public reporting I'm working from does not list fixed release versions, workarounds, specific indicators of compromise, or a named threat actor. I won't guess at any of them. **Confirm affected and fixed versions, and any published IOCs, in Cisco's official security advisory for CVE-2026-76466.** Everything below is designed to work regardless of those specifics.

---

## Why Expressway Is Such a Good Target

Expressway is usually deployed as a pair:

- **Expressway-E** sits in the DMZ and faces the internet. It handles Mobile and Remote Access (MRA), B2B calling, and similar services.
- **Expressway-C** sits on the internal network. It holds a traversal zone relationship with the E and talks to Unified CM, IM&P, and other collaboration infrastructure.

By design, the Expressway-E must be reachable from the internet, and it has a trusted path inward. An attacker who controls an Expressway-E holds a pre-authorized pivot point. It's a DMZ host that the internal firewall already expects to talk to the inside.

Collaboration appliances also tend to be owned by the voice/UC team rather than the infrastructure or security team. In my experience, that means they're often missing from vulnerability scanner scope, EDR coverage, and centralized logging. Assume that applies to yours until you prove otherwise.

---

## Step 1: Find Every Expressway You Own

Your CMDB is a starting point, not an answer. I've seen too many "we only have two" conversations end with a third cluster in a regional office that nobody documented.

### Ask the people who'd know

Send one message to the UC team, network team, and any MSPs that manage collaboration for you:

> List every Expressway-C and Expressway-E node, including lab, DR, and decommissioned-but-still-powered units. Include management IP, public IP/FQDN, and current software version.

### Verify externally

Scan your own public IP space for services an Expressway-E typically exposes. Port usage depends on your deployment and the features you enable, so validate this list against your own design docs:

```bash
# Scan your owned public ranges for common Expressway-E service ports.
# -Pn: don't rely on ICMP; edge devices often drop it
# Adjust ports to match your deployment (MRA, B2B, TURN, admin UI, etc.)
nmap -Pn -sV --open \
  -p 443,8443,5061,5222,3478 \
  -iL public_ranges.txt \
  -oA expressway_external_$(date +%Y%m%d)
```

### Fingerprint against a known-good baseline

Rather than relying on banner strings I'd be guessing at, take a fingerprint from an Expressway you *know* about and use it to find ones you don't. This Python script collects TLS certificate details and the HTTP response from each candidate host:

```python
#!/usr/bin/env python3
"""
Collect TLS cert + HTTP fingerprint data from candidate hosts so you can
compare them against a known Expressway in your environment.
Only run against address space you own or are authorized to test.
"""
import socket
import ssl
import sys
import json
import http.client
from concurrent.futures import ThreadPoolExecutor

PORTS = [443, 8443]
TIMEOUT = 5

def probe(host: str, port: int) -> dict | None:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # we're fingerprinting, not trusting

    result = {"host": host, "port": port}
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
                result["tls_version"] = tls.version()
                result["cert_der_len"] = len(der)
                # Parse subject/issuer via a second handshake with verification off
                # but cert decoding on; fall back gracefully if unavailable.
                result["cert"] = ssl.DER_cert_to_PEM_cert(der)[:120] + "..."
    except Exception as e:
        return None

    try:
        conn = http.client.HTTPSConnection(host, port, timeout=TIMEOUT, context=ctx)
        conn.request("GET", "/")
        resp = conn.getresponse()
        body = resp.read(4096).decode(errors="replace")
        result["status"] = resp.status
        result["server_header"] = resp.getheader("Server")
        result["location"] = resp.getheader("Location")
        result["body_snippet"] = body[:300]
    except Exception as e:
        result["http_error"] = str(e)

    return result

def main(targets_file: str):
    with open(targets_file) as f:
        hosts = [line.strip() for line in f if line.strip()]

    jobs = [(h, p) for h in hosts for p in PORTS]
    with ThreadPoolExecutor(max_workers=32) as pool:
        for r in pool.map(lambda hp: probe(*hp), jobs):
            if r:
                print(json.dumps(r))

if __name__ == "__main__":
    main(sys.argv[1])
```

Run it against a known Expressway first. Note the redirect location, page content, and certificate characteristics. Then run it across your ranges and `grep` for matches:

```bash
python3 fingerprint.py known_expressway.txt > baseline.jsonl
python3 fingerprint.py all_candidates.txt > candidates.jsonl
# Compare on whatever stable markers you observed in baseline.jsonl
jq -r 'select(.location != null) | [.host, .port, .location] | @tsv' candidates.jsonl
```

Certificate transparency logs help too. If your Expressway-E certs carry SANs like `collab-edge` or your MRA domain, a search on a CT log service for your domains will often turn up hostnames you'd forgotten.

---

## Step 2: Determine Version and Exposure

For each node, you need three things:

| Field | Why it matters |
|---|---|
| Software version | Compare against the affected/fixed versions in Cisco's advisory |
| Role (E or C) | E nodes are internet-facing and the highest priority |
| Network reachability of the vulnerable interface | Determines who can reach the attack surface. "Unauthenticated with network access" means anyone who can reach it. |

You can pull the version from the web UI, or from the admin CLI over SSH. Expressway uses the `xStatus` / `xConfiguration` command family. Here's a small collector using Paramiko. Verify the exact status path on your release before relying on it:

```python
#!/usr/bin/env python3
import paramiko
import csv
import getpass

NODES = [
    # hostname/IP, role
    ("expe-01.example.net", "E"),
    ("expc-01.corp.example.net", "C"),
]

CMD = "xStatus SystemUnit Software"  # confirm the path on your release

def get_version(host, user, pw):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.load_system_host_keys()
    client.connect(host, username=user, password=pw, timeout=10,
                   allow_agent=False, look_for_keys=False)
    try:
        _, stdout, _ = client.exec_command(CMD, timeout=15)
        return stdout.read().decode(errors="replace")
    finally:
        client.close()

if __name__ == "__main__":
    user = input("admin user: ")
    pw = getpass.getpass()
    with open("expressway_versions.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["host", "role", "raw_output"])
        for host, role in NODES:
            try:
                out = get_version(host, user, pw)
            except Exception as e:
                out = f"ERROR: {e}"
            w.writerow([host, role, out.strip()])
            print(f"[+] {host} ({role}) collected")
```

I deliberately used `RejectPolicy()`. If a host key has changed on an edge appliance during an active exploitation campaign, I want the script to fail loudly so someone investigates.

**Priority order:**
1. Expressway-E nodes reachable from the internet
2. Expressway-E nodes reachable only from partner or B2B networks
3. Expressway-C nodes. These are lower priority only if you've confirmed the vulnerable interface isn't reachable from untrusted networks. A compromised E may give an attacker exactly that reach.

---

## Step 3: Preserve Evidence, Then Patch

In this campaign, attackers moved from public PoC to compromise quickly. If an internet-facing node has been running a vulnerable version since the PoC dropped, treat it as **potentially compromised**, not just "vulnerable."

Patching or rebuilding can overwrite the logs you'll need later. Spend 15 minutes capturing evidence before you upgrade:

1. **Download a system snapshot / diagnostic bundle** from the web UI (Maintenance → Diagnostics on most releases). Store it off-box with a hash:
   ```bash
   sha256sum expressway-e-01_snapshot_*.tar.gz | tee -a evidence_hashes.txt
   ```
2. **Export the event log and configuration log.** The configuration log records admin changes, which is where new accounts or altered settings would appear.
3. **Record current state:** admin accounts, enabled services (including whether root SSH access is enabled), configured syslog targets, and active sessions.
4. **If virtualized, snapshot the VM** (including memory, if your platform supports it) before touching it.

Then apply the fixed release identified in Cisco's advisory. If Cisco publishes a workaround or mitigation and you can't patch immediately, apply it. Also restrict access to the affected interface at your perimeter firewall as an interim control. A rule that limits the attack surface to known partner IPs, or temporarily blocks it, buys you time.

**If you find evidence of compromise, don't just patch in place.** An attacker who had code execution on the box may have persistence that survives an upgrade. Rebuild from known-good media, restore configuration you've reviewed line by line, and rotate every credential and certificate private key that lived on that device.

---

## Step 4: Hunt for Lateral Movement

This is the part most teams skip, and it's the part this incident shows matters most. The reporting says attackers reached the internal network. So the question isn't only "was my Expressway hit?" It's also "where did they go next?"

### 4a. Build your "normal" first

An Expressway-E should have a very boring network profile. Write it down explicitly:

```yaml
# expressway_allowed_flows.yaml - document your real design here
expressway_e:
  ips: [203.0.113.10, 203.0.113.11, 10.50.1.10, 10.50.1.11]   # public + DMZ
  allowed_outbound_internal:
    - dest: expressway_c        # traversal zone
      ports: [7001, 2222]       # verify against your traversal config
  allowed_outbound_internet:
    - purpose: DNS
      dest: [10.50.0.53]
      ports: [53]
    - purpose: NTP
      dest: [10.50.0.123]
      ports: [123]
    - purpose: media/signaling to remote endpoints
      note: "broad by nature; baseline volume and peer diversity instead"
expressway_c:
  ips: [10.20.5.10, 10.20.5.11]
  allowed_outbound_internal:
    - dest: cucm_cluster
    - dest: imp_cluster
    - dest: [dns, ntp, ldap_if_used, syslog]
```

Anything outside this is worth a look. Port numbers above are illustrative. Pull the real ones from your traversal zone and firewall configuration.

### 4b. Hunt in firewall and NetFlow data

The highest-signal query is **Expressway-E initiating connections to internal addresses other than Expressway-C.**

**Splunk:**

```spl
index=firewall action=allowed
    src_ip IN ("10.50.1.10","10.50.1.11")
    NOT dest_ip IN ("10.20.5.10","10.20.5.11","10.50.0.53","10.50.0.123")
    (dest_ip="10.0.0.0/8" OR dest_ip="172.16.0.0/12" OR dest_ip="192.168.0.0/16")
| stats count earliest(_time) as first_seen latest(_time) as last_seen
        values(dest_port) as ports by src_ip dest_ip
| convert ctime(first_seen) ctime(last_seen)
| sort first_seen
```

Also check **denied** connections. An attacker probing from a compromised DMZ host will generate a lot of blocks before finding an opening, and those blocks are often your earliest signal:

```spl
index=firewall action IN ("blocked","denied","dropped")
    src_ip IN ("10.50.1.10","10.50.1.11")
| timechart span=1h count by dest_port limit=15
```

A sudden burst of denies to 22, 445, 3389, 5985, or 88 from an Expressway is a red flag.

**Microsoft Sentinel (KQL)**, if your firewall logs land in `CommonSecurityLog`:

```kql
let ExpE = dynamic(["10.50.1.10","10.50.1.11"]);
let Allowed = dynamic(["10.20.5.10","10.20.5.11","10.50.0.53","10.50.0.123"]);
CommonSecurityLog
| where TimeGenerated > ago(30d)
| where SourceIP in (ExpE)
| where DestinationIP !in (Allowed)
| where ipv4_is_private(DestinationIP)
| summarize Connections=count(), Ports=make_set(DestinationPort),
            FirstSeen=min(TimeGenerated), LastSeen=max(TimeGenerated)
    by SourceIP, DestinationIP, DeviceAction
| order by FirstSeen asc
```

**Zeek**, if you have sensors in the DMZ:

```bash
# Expressway-E -> internal, excluding known-good peers
cat conn.*.log | zeek-cut ts id.orig_h id.resp_h id.resp_p proto conn_state \
  | awk '$2 ~ /^10\.50\.1\.1[01]$/ && $3 ~ /^10\./ \
         && $3 !~ /^10\.20\.5\.1[01]$/ && $3 != "10.50.0.53" && $3 != "10.50.0.123"'
```

### 4c. Hunt for command-and-control from the appliance

Compromised edge devices commonly beacon out or pull tooling. Expressway-E media traffic is noisy and broad, so filter on **TCP connections to ports and destinations that don't fit the SIP/MRA/TURN profile**:

```spl
index=firewall src_ip IN ("10.50.1.10","10.50.1.11") transport=tcp
    NOT dest_port IN (443, 5061, 5222, 8443, 3478, 53, 123)
    NOT (dest_ip="10.0.0.0/8")
| stats count dc(dest_ip) as uniq_dests values(dest_ip) as dests by dest_port
| sort - count
```

Also look for:
- **Outbound HTTP/HTTPS from the appliance to hosting providers or raw IPs.** Expressway doesn't browse the web.
- **Regular-interval connections** (beaconing). Bucket by destination and look at the standard deviation of inter-arrival times.
- **DNS queries from the appliance for domains unrelated to collaboration**, if you have DNS logs from the resolver it uses.

### 4d. Check the appliance itself

From the configuration log and snapshot you preserved, look for:

- Admin accounts you don't recognize, or changes to existing accounts
- Changes to syslog targets. An attacker silencing your logging is classic.
- Root access or SSH settings toggled
- Unexpected changes to zones, search rules, or certificates
- Admin logins from IP addresses outside your management network

If you're not already sending Expressway logs to your SIEM, enable remote syslog now on every node. You'll need it for the next one.

### 4e. Follow the trail inward

If any of the above produced hits, pivot to the destinations:

- **Expressway-C:** review its logs with the same rigor. It's the natural second hop.
- **Any internal host the E touched:** pull EDR telemetry for that window. Look for new services, scheduled tasks, unexpected authentication, and process creation from network-facing services.
- **Identity:** search your directory logs for authentication from Expressway IPs. If Expressway is integrated with AD or LDAP for admin auth, look for credential use outside that pattern. Treat any service account it uses as exposed.

---

## Step 5: Shrink the Blast Radius for Next Time

Edge appliances will keep getting critical pre-auth bugs. That's been true across vendors for years. What you control is how far an attacker gets from one.

**Egress filtering on the DMZ.** Your Expressway-E should be able to reach Expressway-C on traversal ports, plus DNS/NTP/syslog. It should not be able to reach anything else internal. Expressed as policy:

```text
# DMZ -> Internal policy for Expressway-E (illustrative)
permit tcp host 10.50.1.10 host 10.20.5.10 eq <traversal-port>
permit tcp host 10.50.1.11 host 10.20.5.11 eq <traversal-port>
permit udp host 10.50.1.10 host 10.50.0.53 eq 53
permit udp host 10.50.1.10 host 10.50.0.123 eq 123
permit udp host 10.50.1.10 host 10.50.0.514 eq 514
deny   ip  10.50.1.0/24 10.0.0.0/8 log
```

That final `deny ... log` line is the most valuable detection control you have for this class of attack. It turns lateral movement into a log event.

**Management plane isolation.** The admin web UI and SSH should be reachable only from a dedicated management network or jump host, never from the internet.

**Put appliances in scope.** Add every Expressway to your vulnerability scanning, asset inventory, and log pipeline. Assign a security owner, not just an operational owner.

**Time-to-patch SLA for edge devices.** For internet-facing appliances with a public PoC and confirmed exploitation, my bar is emergency change within 24–48 hours. Your change process should have a pre-approved path for this. Don't fight that battle during the incident.

---

## Your Checklist

- [ ] Inventory every Expressway-E and -C, including lab and DR. Verify with external scanning and CT logs.
- [ ] Record software versions and compare them against **Cisco's advisory for CVE-2026-76466**.
- [ ] Restrict access to the vulnerable interface at the perimeter while you work.
- [ ] Capture snapshots, logs, and VM images **before** patching.
- [ ] Patch, or rebuild from clean media if compromise indicators exist.
- [ ] Rotate credentials and certificate keys on any node you suspect.
- [ ] Hunt for E → internal connections, denied probes, and unusual outbound TCP.
- [ ] Review configuration logs for new accounts, syslog changes, and access settings.
- [ ] Enforce DMZ egress filtering with a logged default deny.
- [ ] Bring Expressway into vulnerability management, SIEM, and patch SLAs permanently.

The reported attack chain was simple: a critical bug, a public PoC, four devices breached, and a path to the internal network. Patching addresses the first two. The hunting and egress controls address the last two, and those are what decide whether a vulnerable appliance becomes a full incident.

## Sources

- [Hackers Exploit Critical Cisco Expressway Flaw, Breach Four Devices and Reach Internal Network](https://thehackernews.com/2026/11/hackers-exploit-critical-cisco.html) (2026-11-20)
