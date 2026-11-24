---
title: "N-able MailAssure SSRF Hits CISA KEV: Find, Patch, and Hunt LDAP Abuse"
date: 2026-11-24
category: "thought-leadership"
tags: ["vulnerability-management", "ssrf", "ldap", "threat-hunting", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "CISA added two vulnerabilities to its Known Exploited Vulnerabilities (KEV) catalog this week, citing evidence of active exploitation. One affects..."
---

CISA added two vulnerabilities to its Known Exploited Vulnerabilities (KEV) catalog this week, citing evidence of active exploitation. One affects MONAI Label. The other is the one I want to focus on, because it sits in a part of the stack most teams don't watch closely: **CVE-2026-134624**, a server-side request forgery (SSRF) flaw in **N-able MailAssure's LDAP functionality**, rated **CVSS 9.3**.

Email security gateways sit in an awkward place. They face the internet, they hold trust relationships with your directory, and they are often owned by "the email team" or an MSP instead of the security team. When the vulnerable feature is the LDAP integration, which is the component that talks to Active Directory, a perimeter bug can become an identity problem.

This post covers what to do this week: confirm the facts, find where you use MailAssure, get remediation confirmed, and look for evidence that your LDAP integration has already been abused.

## What We Know and What We Don't

Here is what is confirmed:

- **CVE:** CVE-2026-134624
- **Product:** N-able MailAssure
- **Class:** Server-side request forgery in the LDAP functionality
- **Severity:** CVSS 9.3
- **Status:** In CISA KEV due to evidence of active exploitation

Here is what I am **not** going to guess at, and you shouldn't either:

- Affected and fixed versions or builds
- Whether remediation is entirely vendor-side or needs customer action
- The KEV remediation due date for federal agencies
- Attribution or specific threat-actor activity

**Confirm all of those in N-able's advisory and the KEV entry itself.** I'll show you how to pull the KEV details programmatically below, so you aren't relying on a summary of a summary.

## Why SSRF in an LDAP Feature Is Worse Than It Sounds

SSRF means an attacker can make the server send requests to destinations the attacker chooses. In a generic web app, that usually means probing internal services or hitting cloud metadata endpoints. When the vulnerable code path is an LDAP integration, I worry about three abuse patterns. These are general patterns for this bug class, not confirmed exploit details for this CVE.

1. **LDAP pass-back / credential capture.** An LDAP connector stores a bind DN and password so it can verify recipients or sync users. If an attacker can redirect where that connector connects, the server may send those stored credentials to an attacker-controlled listener. This is a well-known technique against printers, MFPs, and appliances, and it works because simple binds send credentials to whoever answers.
2. **Internal reconnaissance.** If the service can reach your internal network through a site-to-site tunnel, an allowlisted inbound path, or a hybrid connector, the SSRF becomes a port scanner aimed at your internal ranges.
3. **Directory enumeration.** Even with no credential theft, a working bind against your AD lets an attacker read whatever the service account can read. In most environments that is far more than it needs.

The response plan follows from these patterns. **Patching closes the door, but it does not undo credential exposure.** If that bind account could have been captured, treat it as compromised.

## Step 1: Pull the Authoritative KEV Entry

CISA publishes the KEV catalog as JSON. Don't copy the due date from a news article. Pull it from the source, and wire it into your vuln management pipeline while you're at it.

```python
#!/usr/bin/env python3
"""Pull N-able / MailAssure entries from the CISA KEV feed."""
import json
import urllib.request

KEV_URL = (
    "https://www.cisa.gov/sites/default/files/feeds/"
    "known_exploited_vulnerabilities.json"
)

def main() -> None:
    with urllib.request.urlopen(KEV_URL, timeout=30) as resp:
        kev = json.load(resp)

    hits = [
        v for v in kev.get("vulnerabilities", [])
        if "n-able" in v.get("vendorProject", "").lower()
        or "mailassure" in v.get("product", "").lower()
    ]

    if not hits:
        print("No matching KEV entries found. Check vendor/product naming.")
        return

    for v in hits:
        print(f"{v['cveID']}  {v['vendorProject']} {v['product']}")
        print(f"  Added:     {v['dateAdded']}")
        print(f"  Due:       {v['dueDate']}")
        print(f"  Ransomware:{v.get('knownRansomwareCampaignUse', 'Unknown')}")
        print(f"  Action:    {v['requiredAction']}")
        print()

if __name__ == "__main__":
    main()
```

The `requiredAction` field matters here. It tells you whether CISA expects you to apply vendor mitigations, follow specific guidance, or discontinue use. Read it before you assume "patch and move on" is enough.

## Step 2: Find Every Place You Use MailAssure

Most organizations I talk to can't quickly answer "which of our domains route through product X?" That gets worse if you're an MSP, or if you have acquisitions, subsidiaries, or forgotten marketing domains.

### Inventory via MX Records

MailAssure is an inbound filtering service, so your MX records are the quickest signal. N-able provides the specific MX hostnames during onboarding. Pull them from your onboarding documentation or the admin console rather than guessing.

```python
#!/usr/bin/env python3
"""Flag domains whose MX records point at MailAssure.
Requires: pip install dnspython
"""
import sys
import dns.resolver

# Populate from your N-able onboarding docs / admin console.
# Use substrings that uniquely identify the MailAssure MX hosts.
MX_PATTERNS: list[str] = [
    # "example-mx-hostname-fragment",
]

def check_domain(domain: str) -> list[str]:
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=10)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer,
            dns.resolver.LifetimeTimeout) as exc:
        return [f"ERROR: {type(exc).__name__}"]
    return [str(r.exchange).rstrip(".").lower() for r in answers]

def main(path: str) -> None:
    if not MX_PATTERNS:
        sys.exit("Populate MX_PATTERNS before running.")
    with open(path) as fh:
        domains = [d.strip() for d in fh if d.strip() and not d.startswith("#")]

    for domain in domains:
        mx_hosts = check_domain(domain)
        matched = any(p in h for h in mx_hosts for p in MX_PATTERNS)
        flag = "MAILASSURE" if matched else "-"
        print(f"{flag:12} {domain:40} {', '.join(mx_hosts)}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "domains.txt")
```

Feed it every domain you own. Your registrar exports and certificate transparency logs are good sources for the list. **MX records only reveal inbound filtering.** If you also use outbound filtering or an archiving add-on, check your send connectors and smart host configuration too.

### Inventory the LDAP Integrations

The MX check tells you where MailAssure is in use. It does not tell you which tenants have the vulnerable LDAP feature configured. For each tenant:

- Log into the admin console and document whether LDAP or directory integration is enabled.
- Record the **target LDAP host**, **port**, **TLS mode**, and **bind DN**.
- Note how the service reaches your directory: a public-facing LDAPS endpoint, a firewall allowlist, a tunnel, or something else.

That last item determines your blast radius. If your directory is reachable from the internet on 389 or 636, even when restricted to vendor IPs, you need to know exactly which IPs and why.

## Step 3: Get Remediation Confirmed, in Writing

Your actions depend on the deployment model, which is why the vendor advisory matters.

- **If the fix is applied vendor-side**, get written confirmation from N-able (or your MSP) of when your tenant was remediated. You need that timestamp to scope your hunt window.
- **If customer action is required**, such as a configuration change, connector update, or feature toggle, apply it, then verify. Don't just mark the ticket done.
- **If you're an MSP**, don't assume the remediation propagated to every client tenant. Verify per tenant and record it.

If remediation isn't confirmed and the advisory permits it, consider **disabling the LDAP integration temporarily**. Recipient verification degrading to accept-all for a few days is an annoyance. Losing a directory credential is an incident.

## Step 4: Hunt for LDAP Abuse

Now assume exploitation happened before you closed the gap, and go looking for evidence. Your hunt window starts as far back as your logs go and ends at the confirmed remediation timestamp.

### 4a. Review the MailAssure Admin Audit Trail

Start with the product's own admin and activity logs. Look for:

- Changes to the LDAP server hostname, port, or TLS settings
- Changes to the bind DN or password fields
- "Test connection" actions you can't attribute to a known admin
- Admin logins from unfamiliar IPs or at unusual times

A change to the LDAP target host followed shortly by a revert is a strong indicator of credential capture.

### 4b. Baseline Who Binds as the Service Account

Find out where binds from the MailAssure service account come from. Every legitimate bind should originate from a small, known set of source IPs, such as vendor egress ranges or your connector host. Anything else needs an explanation.

**Microsoft Sentinel / Log Analytics.** Simple LDAP binds against a DC typically log as logon type 8 (NetworkCleartext):

```kql
let svc = "svc-mailassure-ldap";   // your bind account's sAMAccountName
SecurityEvent
| where TimeGenerated > ago(90d)
| where EventID in (4624, 4625)
| where TargetUserName =~ svc
| summarize
    Attempts   = count(),
    Failures   = countif(EventID == 4625),
    FirstSeen  = min(TimeGenerated),
    LastSeen   = max(TimeGenerated),
    LogonTypes = make_set(LogonType)
  by IpAddress, Computer
| order by FirstSeen asc
```

**Microsoft Defender for Identity:**

```kql
IdentityLogonEvents
| where Timestamp > ago(30d)
| where Protocol == "LDAP"
| where AccountName =~ "svc-mailassure-ldap"
| summarize Events = count(), FirstSeen = min(Timestamp), LastSeen = max(Timestamp)
  by IPAddress, DestinationDeviceName, ActionType
| order by FirstSeen asc
```

Look for:

- **New source IPs**, especially ones outside documented vendor ranges
- **A burst of failures**, which can indicate someone testing captured credentials or brute-forcing
- **The account used against non-LDAP services**, such as SMB, RDP, Kerberos TGT requests from workstations, or VPN. A recipient-lookup account has no business doing any of these.

### 4c. Turn On LDAP Interface Diagnostics (Temporarily)

If you need per-bind client IPs and your SIEM isn't capturing them, raise LDAP diagnostic logging on your DCs. Event **2889** records the client IP and identity for unsigned SASL binds and simple binds over cleartext.

```powershell
# On each DC. Level 2 is verbose, so revert after your collection window.
$key = "HKLM:\SYSTEM\CurrentControlSet\Services\NTDS\Diagnostics"
Set-ItemProperty -Path $key -Name "16 LDAP Interface Events" -Value 2 -Type DWord

# Later: pull 2889 events and summarize by client IP + identity
Get-WinEvent -FilterHashtable @{ LogName = 'Directory Service'; Id = 2889 } |
    ForEach-Object {
        [pscustomobject]@{
            Time     = $_.TimeCreated
            ClientIP = ($_.Properties[0].Value -split ':')[0]
            Identity = $_.Properties[1].Value
        }
    } |
    Group-Object ClientIP, Identity |
    Sort-Object Count -Descending |
    Select-Object Count, Name

# Revert when done
Set-ItemProperty -Path $key -Name "16 LDAP Interface Events" -Value 0 -Type DWord
```

If 2889 shows your MailAssure bind account authenticating in cleartext, that is a separate finding on its own. Fix it in Step 5.

### 4d. Check Network Telemetry for LDAP Going Somewhere Odd

There are two directions to check.

**Inbound to your directory.** Which external IPs reached your LDAP and LDAPS listeners? Compare them against the source ranges N-able documents for your region.

**Outbound LDAP from internal hosts.** Your connector host, or anything else on your side involved in the integration, should only speak LDAP to your DCs. Here is a Zeek example:

```bash
#!/usr/bin/env bash
# dc_ips.txt: one domain controller IP per line
# Flags LDAP/GC traffic to anything that is NOT a known DC.

zeek-cut ts id.orig_h id.resp_h id.resp_p proto < conn.log |
awk -v dcfile=dc_ips.txt '
  BEGIN { while ((getline ip < dcfile) > 0) dc[ip] = 1 }
  ($4 == 389 || $4 == 636 || $4 == 3268 || $4 == 3269) && !($3 in dc) {
    print strftime("%Y-%m-%dT%H:%M:%S", $1), $2, "->", $3 ":" $4, $5
  }'
```

Also look for **non-LDAP connections from the integration path**. If the MailAssure-facing allowlist or tunnel suddenly carried traffic to 22, 80, 443, 445, or 3389 on internal hosts, that is SSRF-driven reconnaissance and needs escalation.

### 4e. If You Find Something

Treat the bind account as compromised and scope from there:

- Review everything the account could read. Depending on ACLs, that may include group memberships, attributes, and possibly sensitive fields.
- Check whether the same password was reused anywhere. In my experience, service-account password reuse is depressingly common.
- Pivot on any suspicious source IPs across firewall, VPN, IdP, and EDR telemetry.

## Step 5: Rotate and Harden

Even if your hunt comes back clean, do these. They are cheap, and they shrink the impact of the next appliance bug.

**Rotate the bind credential.** Do it after remediation is confirmed, not before. Otherwise you risk handing a fresh password to the same hole.

```powershell
$svc = "svc-mailassure-ldap"
Set-ADAccountPassword -Identity $svc -Reset `
    -NewPassword (Read-Host -AsSecureString "New password")
# Then update the credential in the MailAssure console and test.
```

**Strip the account down to what it needs.** Recipient verification needs read access to a narrow set of attributes and nothing else:

```powershell
$svc = "svc-mailassure-ldap"

# Not delegatable, no Kerberos delegation games
Set-ADAccountControl -Identity $svc -AccountNotDelegated $true

# Confirm it is not in any privileged group
Get-ADPrincipalGroupMembership $svc | Select-Object Name

# Audit the account's current flags
Get-ADUser $svc -Properties PasswordLastSet, PasswordNeverExpires,
    LastLogonDate, servicePrincipalName |
    Format-List
```

Also deny interactive and RDP logon via GPO, and scope its read permissions to the OUs that actually contain mail recipients.

**Require LDAPS, never cleartext simple binds.** A simple bind over 389 hands the password to anything on the path, or to anything an SSRF bug points the connector at. LDAPS doesn't fully stop pass-back to an attacker who controls a valid certificate. It does stop passive capture, and it raises the bar.

**Restrict the network path.** Only the vendor's documented source ranges should reach your LDAPS listener, and only on 636. Here is an nftables sketch for a dedicated LDAP proxy or jump layer:

```nft
table inet ldap_guard {
  set mailassure_src {
    type ipv4_addr
    flags interval
    # Populate from N-able's published source ranges for your region
    elements = { 192.0.2.0/24 }
  }

  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport 636 ip saddr @mailassure_src accept
    tcp dport { 389, 636, 3268, 3269 } log prefix "LDAP-DENY " drop
  }
}
```

`192.0.2.0/24` is a documentation range. Replace it with the real ranges from N-able.

**Don't expose DCs directly.** If you can, put a read-only LDAP proxy or a dedicated, filtered endpoint between the vendor and your domain controllers. Then an SSRF on the vendor side can reach one tightly scoped service, not your entire identity plane.

**Alert on it going forward.** Turn the Step 4b query into a scheduled analytics rule: *"MailAssure bind account authenticated from an IP outside the allowlist"* should page someone.

## The Bigger Lesson

There's a pattern here that has come up repeatedly in my career: **the most dangerous integrations are the ones that hold directory credentials on someone else's infrastructure.** Email gateways, MFPs, HR platforms, ticketing systems, VPN appliances. Each one has a bind account, each account is usually over-privileged, and almost nobody hunts on them.

KEV additions like this are a good forcing function. Use this one to build an inventory of every system that binds to your directory, who owns it, what it can read, and where it connects from. The next appliance SSRF will be much less of a scramble.

## This Week's Checklist

- [ ] Pull the KEV entry for CVE-2026-134624 and record the due date and required action
- [ ] Read N-able's advisory for affected versions and required customer actions
- [ ] Inventory every domain and tenant using MailAssure, and which have LDAP integration enabled
- [ ] Get written confirmation of the remediation timestamp per tenant
- [ ] Review MailAssure admin audit logs for LDAP config changes
- [ ] Baseline and hunt bind-account activity in your SIEM and Defender for Identity
- [ ] Check network telemetry for unexpected LDAP destinations and non-LDAP traffic on the integration path
- [ ] Rotate the bind credential **after** remediation is confirmed
- [ ] Enforce LDAPS, least privilege, and source-IP restrictions
- [ ] Ship a detection for bind-account use outside the allowlist

If your hunt turns up something interesting, or you've found a cleaner way to inventory directory-bound integrations at scale, I'd like to hear about it.

## Sources

- [Hackers Exploit N-able MailAssure Flaw While AI Agents Exploit MONAI Label Zero-Day](https://thehackernews.com/2026/11/hackers-exploit-n-able-mailassure-flaw.html) (2026-11-24)
