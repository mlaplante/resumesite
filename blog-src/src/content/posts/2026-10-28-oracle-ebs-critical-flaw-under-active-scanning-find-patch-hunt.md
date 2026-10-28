---
title: "Oracle EBS Critical Flaw Under Active Scanning: Find, Patch, Hunt"
date: 2026-10-28
category: "thought-leadership"
tags: ["oracle-ebs", "vulnerability-management", "patching", "threat-hunting", "incident-response", "web-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Oracle E-Business Suite has a critical vulnerability that attackers are already probing. According to threat intelligence firm Defused Cyber, threat..."
---

Oracle E-Business Suite has a critical vulnerability that attackers are already probing. According to threat intelligence firm Defused Cyber, threat actors have begun scanning for **CVE-2026-101767** (CVSS 9.8), a flaw in the Oracle Application Object Library component of EBS. Oracle patched it last week in its Critical Patch Update (CPU).

The short window between patch and probing is the part that matters. Once a CVE is public and patched, the gap between "we should schedule this" and "someone is testing the internet for it" can be a matter of days. EBS is also a high-value target. It typically holds financials, HR, procurement, and supplier data, and it is often internet-facing because of supplier portals, iProcurement, and self-service HR.

Here is how I'd spend the next 72 hours: find what's exposed, patch, and hunt for evidence of prior exploitation.

A note on scope: the public reporting I'm working from gives the CVE, the score, the affected component, and the fact that probing has started. It doesn't give me exploit details, affected version ranges, or patch numbers, and I won't guess at them. Where I need those, I'll point you to the Oracle CPU advisory. Everything below is deliberately generic EBS operations and detection engineering that holds up regardless of the exploit's specifics.

## Step 1: Find your exposed EBS instances

You can't patch what you don't know about. EBS sprawl is real: a forgotten UAT clone, a DR environment, or an acquired company's instance can all be reachable from the internet while your CMDB insists otherwise.

### External view

Start from the attacker's perspective. If you have an external attack surface management tool, query it for EBS fingerprints. If not, you can do a lot with open tooling against your own address space and certificate inventory.

```bash
# Build a host list from your known external ranges and cert transparency hits,
# then probe for typical EBS login pages.
# (Only scan assets you own or are authorized to test.)

cat external_hosts.txt | httpx -silent -follow-redirects \
  -path /OA_HTML/AppsLocalLogin.jsp \
  -mc 200,302 \
  -title -tech-detect -status-code \
  -o ebs_candidates.txt

# Also check for alternate ports commonly used by EBS web tiers
nmap -iL external_ips.txt -p 80,443,8000,8001,4443,7001,7002 \
  --open -sV -oA ebs_portscan
```

`/OA_HTML/` is the conventional web root for EBS self-service pages. Treat a hit as a lead, not proof. Also search for hostnames in cert transparency logs that include `ebs`, `erp`, `apps`, `prod`, `uat`, or `ora` for your domains:

```bash
curl -s "https://crt.sh/?q=%25.example.com&output=json" \
  | jq -r '.[].name_value' | sort -u \
  | grep -Ei 'ebs|erp|apps|oracle|ora|fin' 
```

### Internal view

Reconcile the external list against what you think you own. On the database tier, the EBS application registry is authoritative for which web entry points exist:

```sql
-- Run on the EBS database as APPS (or a read-only equivalent)
SELECT profile_option_value AS apps_web_agent
FROM   fnd_profile_option_values v
JOIN   fnd_profile_options o USING (profile_option_id)
WHERE  o.profile_option_name = 'APPS_WEB_AGENT'
AND    v.level_id = 10001;
```

Compare `APPS_WEB_AGENT` and related URL profiles (`APPS_FRAMEWORK_AGENT`, `ICX_FORMS_LAUNCHER`) to your external findings. Mismatches usually point to a reverse proxy, a load balancer, or a clone nobody documented.

### Triage by exposure class

Sort what you find into three buckets:

1. **Internet-facing, full EBS**: patch and investigate first.
2. **Internet-facing through a reverse proxy with path restrictions**: patch next, but verify the restrictions actually work.
3. **Internal only**: patch on an accelerated schedule. Internal doesn't mean safe, since a foothold anywhere on the network changes the picture.

## Step 2: Reduce exposure while you patch

Patching EBS is rarely a same-day affair. Between the CPU being available and your change window, shrink the attack surface.

If you run an external-tier reverse proxy, allow-list only the URL paths you need for external users, such as supplier or self-service modules, and deny the rest. Oracle documents a URL firewall approach for EBS external tiers. Confirm the current guidance for your release in Oracle's documentation. A generic reverse-proxy sketch looks like this:

```nginx
# nginx example: only permit explicitly required EBS paths externally
map $request_uri $ebs_allowed {
    default                                   0;
    ~^/OA_HTML/AppsLocalLogin\.jsp            1;
    ~^/OA_HTML/OA\.jsp\?page=/oracle/apps/pos 1;  # example: supplier portal
    ~^/OA_HTML/cabo/                          1;  # static assets
    ~^/OA_MEDIA/                              1;
}

server {
    listen 443 ssl;
    server_name ebs.example.com;

    location / {
        if ($ebs_allowed = 0) { return 403; }
        proxy_pass https://ebs-internal:4443;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Treat the allow-list above as a template, not a recommendation. Build yours from observed legitimate traffic (see the log analysis below), and test with real user journeys. Also remember that a path allow-list is a **compensating control, not a fix**. I don't know which endpoints this specific flaw is reachable through, so I wouldn't assume that blocking a few paths neutralizes it. Check the Oracle advisory for any published workarounds.

If the instance doesn't need to be internet-facing at all, pull it behind your VPN or zero-trust proxy now. That is the single most effective short-term control.

## Step 3: Apply the CPU patch

Get the exact patch identifiers, prerequisites, and affected release matrix from the Oracle Critical Patch Update advisory and the associated EBS support notes. I'm not going to list patch numbers because I'd rather you read them from the source than trust a blog post.

The operational flow differs by release, so here is the general shape.

### Release 12.2 (online patching)

```bash
# Source the run edition environment
. /u01/oracle/EBSPROD/EBSapps.env run

# Verify the patch edition is healthy before starting
adop -status

# Apply to the patch edition (patch number from Oracle's advisory)
adop phase=apply patches=<PATCH_NUMBER_FROM_ORACLE_ADVISORY>

# Then finalize, cutover, cleanup per your standard cycle
adop phase=finalize
adop phase=cutover
adop phase=cleanup
```

Before kicking this off, check whether a previous adop cycle is still open. Starting a new cycle on top of an unfinished one is a classic way to lose a weekend.

### Verify the patch landed

Don't trust the console output alone. Verify in the database:

```sql
-- Confirm the bug/patch is recorded as applied
SELECT bug_number, creation_date, last_update_date
FROM   ad_bugs
WHERE  bug_number = '<PATCH_NUMBER_FROM_ORACLE_ADVISORY>';
```

Also inventory the patch history from the application tier, and record the result in your change ticket so audit has a clean artifact:

```bash
# Capture applied-patch evidence for the ticket
sqlplus -s apps/**** <<'EOF' > patch_evidence_$(hostname)_$(date +%F).txt
SET LINESIZE 200 PAGESIZE 100
SELECT bug_number, last_update_date
FROM   ad_bugs
WHERE  last_update_date > SYSDATE - 14
ORDER  BY last_update_date DESC;
EOF
```

Finally, re-scan after patching. Vulnerability scanners that support EBS checks should be updated for this CVE. Confirm with your vendor that the plugin exists, because a "no findings" result from a scanner with no check is worse than useless.

## Step 4: Hunt for exploitation

Here is the uncomfortable truth: if probing started within days of the patch, you should assume some internet-facing instances were touched **before** you patched. Patching closes the door but doesn't tell you whether someone already walked through it.

Because I don't have exploit specifics, the hunt focuses on two things that hold for almost any web-tier RCE: **anomalous requests** at the edge, and **post-exploitation behavior** on the host.

### 4a. Baseline and anomaly analysis on web logs

Pull Apache/OHS access logs from the EBS web tier (and your reverse proxy or WAF) going back to at least the CPU release date, and ideally earlier, since attackers sometimes develop exploits from earlier diffing or prior knowledge.

First, see what normal looks like:

```bash
# Top requested paths by unique client IPs
awk '{print $1, $7}' access_log* \
  | sed 's/?.*//' \
  | sort -u | awk '{print $2}' \
  | sort | uniq -c | sort -rn | head -50
```

Then look for outliers: paths requested by few IPs, unusual HTTP methods, abnormal response sizes, and bursts of 4xx/5xx from a single source.

```python
#!/usr/bin/env python3
"""Flag suspicious clients in Apache combined-format logs."""
import re, sys, collections

LOG_RE = re.compile(
    r'(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] '
    r'"(?P<method>\S+) (?P<path>\S+) [^"]*" '
    r'(?P<status>\d{3}) (?P<size>\S+)'
)

per_ip = collections.defaultdict(lambda: {
    "paths": set(), "errors": 0, "total": 0, "methods": set()
})

for fname in sys.argv[1:]:
    with open(fname, errors="replace") as f:
        for line in f:
            m = LOG_RE.match(line)
            if not m:
                continue
            d = per_ip[m["ip"]]
            d["total"] += 1
            d["paths"].add(m["path"].split("?")[0])
            d["methods"].add(m["method"])
            if m["status"].startswith(("4", "5")):
                d["errors"] += 1

for ip, d in sorted(per_ip.items(), key=lambda x: -x[1]["errors"]):
    # Heuristics: tune thresholds to your traffic
    broad_probe = len(d["paths"]) > 40
    noisy = d["errors"] > 25 and d["errors"] / d["total"] > 0.5
    odd_method = d["methods"] - {"GET", "POST", "HEAD", "OPTIONS"}
    if broad_probe or noisy or odd_method:
        print(f"{ip}\ttotal={d['total']} errors={d['errors']} "
              f"uniq_paths={len(d['paths'])} methods={sorted(d['methods'])}")
```

This won't pinpoint the exploit. It will surface scanners and fuzzers, which are exactly the "probing" Defused Cyber described. Cross-reference those IPs against successful (200) responses to unusual paths. A scanner that got only 404s is noise. One that got a 200 with a large response on an odd path deserves a closer look.

If you have a SIEM, a rough equivalent in Splunk:

```
index=web sourcetype=access_combined host=ebs*
| eval path=replace(uri_path,"\?.*","")
| stats dc(path) as uniq_paths,
        count(eval(status>=400)) as errors,
        count as total,
        values(method) as methods by clientip
| where uniq_paths>40 OR (errors>25 AND errors/total>0.5)
| sort - errors
```

### 4b. Post-exploitation behavior on the host

Whatever the entry point, RCE on an EBS web or application tier tends to produce a handful of recognizable side effects. Hunt for these on every internet-facing EBS node.

**Unexpected child processes of the Java/OHS/WebLogic processes.** Application servers rarely spawn shells.

```bash
# Quick live check: shells or download tools whose parent is a Java/httpd process
ps -eo pid,ppid,user,lstart,cmd --forest \
  | grep -E 'java|httpd|opmn' -A2 \
  | grep -E 'sh -c|bash|curl|wget|nc |python|perl' 
```

If you run EDR or auditd, make this a standing detection. An auditd rule to log execve activity by the application owner (adjust the UID for your `applmgr`/`oracle` account):

```bash
# /etc/audit/rules.d/ebs.rules
-a always,exit -F arch=b64 -S execve -F uid=1001 -k ebs_exec
```

```bash
# Review what the app owner executed recently
ausearch -k ebs_exec -ts this-week | aureport -x --summary
```

**New or modified files in web-served directories.** Web shells are a staple of post-exploitation. Look for recently created or changed JSP and script files under the web roots:

```bash
find $COMMON_TOP/webapps -type f \
  \( -name '*.jsp' -o -name '*.jspx' -o -name '*.war' -o -name '*.sh' \) \
  -newermt '2026-10-01' -printf '%TY-%Tm-%Td %TH:%TM  %u  %p\n' \
  | sort
```

Adjust the date to precede the CPU release. Anything modified outside your documented change windows needs an explanation. Be aware that patching itself will legitimately update many files, so compare against your adop logs.

**Outbound connections from the application tier.** EBS app servers should have a very predictable egress profile: the database, LDAP/SSO, SMTP, and a few APIs. Check firewall or flow logs for new external destinations:

```bash
# Example: established outbound connections from the app host to non-RFC1918 space
ss -tnp state established \
  | awk '{print $4, $5, $6}' \
  | grep -vE '(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' 
```

**Database-side persistence.** Since the application tier connects to the database with powerful credentials, check for signs of tampering there too:

```sql
-- Recently created or modified EBS users
SELECT user_name, creation_date, last_update_date, last_logon_date
FROM   fnd_user
WHERE  creation_date    > DATE '2026-10-01'
   OR  last_update_date > DATE '2026-10-01'
ORDER  BY last_update_date DESC;

-- Recently created concurrent programs/executables (a known abuse path
-- for running OS commands from inside the application)
SELECT executable_name, execution_method_code, creation_date, created_by
FROM   fnd_executables
WHERE  creation_date > DATE '2026-10-01'
ORDER  BY creation_date DESC;

-- Responsibilities granted recently
SELECT u.user_name, r.responsibility_key, g.start_date, g.creation_date
FROM   fnd_user_resp_groups_direct g
JOIN   fnd_user u           ON u.user_id = g.user_id
JOIN   fnd_responsibility r ON r.responsibility_id = g.responsibility_id
                           AND r.application_id    = g.responsibility_application_id
WHERE  g.creation_date > DATE '2026-10-01'
ORDER  BY g.creation_date DESC;
```

Adjust the date literals to your window. Any new account holding System Administrator or another privileged responsibility, created outside your normal provisioning flow, is a high-priority finding. A new concurrent program executable that calls an OS host script is a persistence mechanism worth treating as hostile until proven otherwise.

### 4c. Preserve evidence before you clean up

If something looks wrong, don't reboot or restore from a snapshot first. Preserve:

- Web tier access/error logs, application server logs, and OPMN/WebLogic logs
- A memory capture and a disk snapshot, if your IR process supports it
- Database audit data and the query outputs above, with timestamps
- Reverse proxy/WAF logs, which often outlive host logs

Then follow your incident response plan. An EBS compromise commonly implies exposure of financial and personal data, which can trigger legal and regulatory notification clocks. Bring counsel and privacy teams in early.

## A practical 72-hour checklist

**Day 0 (today)**
- Enumerate all EBS instances, including non-production clones
- Pull internet-facing instances behind a VPN or tighten reverse-proxy allow-lists
- Read the Oracle CPU advisory for this CVE: affected versions, patch numbers, workarounds
- Turn on or confirm logging: web access logs, auditd/EDR, DB auditing

**Day 1**
- Run the log analysis across the window from before the CPU release to today
- Run the host and database hunts on internet-facing nodes
- Schedule emergency change windows for exposed instances

**Day 2–3**
- Apply the patch (internet-facing first), verify in `ad_bugs`, and re-scan
- Rotate credentials for service accounts if you found anything suspicious
- Add durable detections: app-server-spawns-shell, new JSPs, new privileged EBS users
- Document findings, including clean results, for your risk and audit teams

## Takeaways

1. **Patch-to-probe time is now measured in days.** For critical flaws in internet-facing enterprise apps, your emergency change process needs to be real, not aspirational.
2. **Exposure reduction is your fastest control.** Removing EBS from direct internet reachability beats any signature or path rule.
3. **Patching isn't the end.** Hunt for exploitation across the window before you patched, using behaviors that don't depend on knowing the exploit.
4. **Verify, don't assume.** Check `ad_bugs`, re-scan, and confirm your scanner actually has a check for this CVE.
5. **Defer to the vendor for specifics.** Affected versions, patch IDs, and workarounds belong in Oracle's advisory. Pull them from there and record them in your change ticket.

If you take only one action today, find out whether any EBS instance is reachable from the internet and who owns it. Every other step depends on that answer.

## Sources

- [Hackers Target Critical Oracle E-Business Suite RCE Flaw Days After Security Patch](https://thehackernews.com/2026/10/hackers-target-critical-oracle-e.html) (2026-10-28)
