---
title: "Outlook NTLMv2 Hash Leak: Find, Patch, Block, and Hunt for Relay"
date: 2026-11-11
category: "thought-leadership"
tags: ["windows-security", "ntlm", "patch-management", "threat-hunting", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Microsoft's latest Patch Tuesday shipped fixes for 1,259 vulnerabilities. That is the second month in a row above 1,000. Windows accounts for 726 of..."
---

Microsoft's latest Patch Tuesday shipped fixes for **1,259 vulnerabilities**. That is the second month in a row above 1,000. Windows accounts for 726 of them and Office for 174, with SQL Server, SharePoint Server, developer tooling, and 165 non-Microsoft CVEs making up the rest.

When a release is that large, prioritization matters more than anything else. One item should go to the top of your list: **an actively exploited Outlook vulnerability that may expose NTLMv2 hashes.**

I've worked through this bug class several times over the years. The pattern stays the same. An attacker gets Outlook to reach out to a resource they control, Windows authenticates automatically, and the attacker walks away with a credential artifact. They can crack it offline or relay it in real time. Often the user never clicks anything.

This post is the playbook I'd hand my team this week:

1. Find exposed clients.
2. Patch and verify.
3. Block outbound SMB and restrict NTLM.
4. Hunt for hash capture and relay activity.

> **Before you start:** I'm intentionally not quoting a CVE number, CVSS score, affected build list, or fixed version here. Pull those directly from the Microsoft Security Update Guide entry for this Outlook issue. Confirm in the advisory which clients are in scope (classic Win32 Outlook vs. new Outlook, Click-to-Run channels vs. MSI) and which builds contain the fix.

---

## Why This Bug Class Keeps Hurting Us

Here's the mechanic in plain terms:

1. The attacker crafts a message or item that causes Outlook to resolve a **UNC path** such as `\\attacker-host\share\file`. The exact property or trigger varies by vulnerability, so check the advisory for this one.
2. Windows sees a UNC path and tries **SMB over TCP 445**. If that fails and the WebClient service is available, it may fall back to **WebDAV over HTTP(S)**.
3. The remote server requests NTLM authentication. Windows answers with an **NTLMv2 challenge-response** for the logged-on user.
4. The attacker now has two options:
   - **Crack it offline.** NTLMv2 responses aren't pass-the-hash material by themselves, but weak passwords fall quickly to GPU cracking.
   - **Relay it.** They forward the authentication in real time to an internal service that accepts NTLM without signing or channel binding, such as SMB, LDAP, AD CS web enrollment, or HTTP apps.

The relay path is the one that turns a mail client bug into domain compromise. Patching closes this specific trigger. Egress filtering and NTLM hardening close the *class*.

---

## Step 1: Find Exposed Outlook Clients

You can't patch what you can't see. Most environments I've audited have more Outlook variants than anyone expects: Click-to-Run on several channels, a few stubborn MSI installs, VDI golden images that haven't been refreshed, and kiosk machines nobody owns.

### Inventory with PowerShell

This script collects Outlook build information from endpoints. Run it through your RMM, Intune remediation scripts, ConfigMgr, or `Invoke-Command` across a host list.

```powershell
# Get-OutlookInventory.ps1
$result = [ordered]@{
    ComputerName   = $env:COMPUTERNAME
    C2RVersion     = $null
    C2RChannel     = $null
    OutlookExePath = $null
    OutlookFileVer = $null
    NewOutlook     = $false
    WebClientState = (Get-Service -Name WebClient -ErrorAction SilentlyContinue).StartType
}

# Click-to-Run installs
$c2r = 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'
if (Test-Path $c2r) {
    $cfg = Get-ItemProperty $c2r
    $result.C2RVersion = $cfg.VersionToReport
    $result.C2RChannel = $cfg.CDNBaseUrl   # Maps to update channel GUID
}

# Locate OUTLOOK.EXE (covers C2R and MSI layouts)
$candidates = @(
    "$env:ProgramFiles\Microsoft Office\root\Office16\OUTLOOK.EXE",
    "${env:ProgramFiles(x86)}\Microsoft Office\root\Office16\OUTLOOK.EXE",
    "$env:ProgramFiles\Microsoft Office\Office16\OUTLOOK.EXE",
    "${env:ProgramFiles(x86)}\Microsoft Office\Office16\OUTLOOK.EXE"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) {
    $result.OutlookExePath = $exe
    $result.OutlookFileVer = (Get-Item $exe).VersionInfo.ProductVersion
}

# New Outlook (packaged app)
$result.NewOutlook = [bool](Get-AppxPackage -AllUsers -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue)

[pscustomobject]$result
```

Collect the output into a CSV. Then compare `OutlookFileVer` and `C2RVersion` against the fixed builds listed in the advisory for each channel.

I also capture the `WebClient` startup type here because it comes up again in Step 3.

### Inventory with Defender for Endpoint

If you run Microsoft Defender for Endpoint, the software inventory tables give you a fleet-wide view quickly:

```kql
DeviceTvmSoftwareInventory
| where SoftwareName has "outlook" or SoftwareName has "office"
| summarize Devices = dcount(DeviceId), DeviceList = make_set(DeviceName, 50)
    by SoftwareVendor, SoftwareName, SoftwareVersion
| order by Devices desc
```

Once Defender maps the CVE, pivot to `DeviceTvmSoftwareVulnerabilities` filtered on the CVE ID from the advisory. That gives you an authoritative exposure list.

**Don't forget:**
- **VDI and RDS images.** Patch the golden image, not just running sessions.
- **Disconnected or traveling laptops.** These are often the most exposed and the last to update.
- **Servers with Outlook installed** for some legacy automation. They exist, and they usually run as service accounts with far too much privilege.

---

## Step 2: Patch and Verify

For an exploited client-side credential leak, I compress the normal ring schedule:

| Ring | Scope | Timing |
|---|---|---|
| 0 | IT and Security staff | Same day |
| 1 | Executives, admins, finance, HR (high-value targets) | Within 24 hours |
| 2 | General workforce | 48–72 hours |
| 3 | Exceptions, VDI images, kiosks | Tracked individually with owners and dates |

### Force Click-to-Run Updates

On Click-to-Run, you can trigger an update immediately instead of waiting for the scheduled task:

```powershell
$c2rClient = "$env:CommonProgramFiles\microsoft shared\ClickToRun\OfficeC2RClient.exe"
& $c2rClient /update user displaylevel=false forceappshutdown=true
```

`forceappshutdown=true` closes Office apps. Coordinate with users, or schedule it for off-hours on Ring 2.

### Verify, Don't Assume

Re-run the inventory script 24–48 hours after deployment. Diff the results against the fixed builds from the advisory. I track three numbers on a daily dashboard until we're done:

- **Patched**
- **Unpatched and reachable**
- **Unpatched and unreachable** (offline, stale, decommissioned)

That third bucket is where exposure hides. Chase it.

---

## Step 3: Block Outbound SMB and Restrict NTLM

Patching fixes this trigger. The controls in this section mean the *next* Outlook, Office, or Windows Explorer hash-leak bug lands on a hardened target.

### 3a. Block SMB Egress at the Perimeter

No workstation in a typical enterprise has a legitimate reason to speak SMB to the internet. Block **TCP 445 and TCP 139** outbound at the edge.

Here's an nftables example for a Linux egress gateway:

```bash
table inet egress_filter {
  set internal_nets {
    type ipv4_addr
    flags interval
    elements = { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 }
  }

  chain forward {
    type filter hook forward priority 0; policy accept;

    # Drop SMB/NetBIOS session traffic leaving the org
    ip daddr != @internal_nets tcp dport { 139, 445 } \
      log prefix "EGRESS-SMB-DROP " drop
  }
}
```

Translate this to your firewall platform. Make sure the **log** action stays on. Those logs become hunting data in Step 4.

If you use Azure Files or another cloud SMB service, add explicit allow rules for those endpoints only, and route that traffic over private connectivity where you can.

### 3b. Block SMB Egress on the Host

Perimeter rules don't help a laptop sitting on hotel Wi-Fi, so enforce the same block on the endpoint through Intune or GPO. Windows Firewall evaluates block rules ahead of allow rules. Scope the block to non-RFC1918 space so internal file shares keep working:

```powershell
$publicRanges = @(
    '0.0.0.0-9.255.255.255',
    '11.0.0.0-172.15.255.255',
    '172.32.0.0-192.167.255.255',
    '192.169.0.0-255.255.255.255'
)

New-NetFirewallRule -DisplayName 'Block Outbound SMB to Public Internet' `
    -Direction Outbound -Action Block -Protocol TCP `
    -RemotePort 445,139 -RemoteAddress $publicRanges `
    -Profile Any -Group 'Security Baseline'
```

Adjust the ranges if you use CGNAT space (`100.64.0.0/10`) or other non-RFC1918 blocks internally. Test this on Ring 0 first.

### 3c. Close the WebDAV Fallback

When 445 is blocked, the WebClient service can carry the UNC request over HTTP instead. Most knowledge workers don't need WebClient. Disable it where you can:

```powershell
Set-Service -Name WebClient -StartupType Disabled
Stop-Service -Name WebClient -Force -ErrorAction SilentlyContinue
```

The inventory from Step 1 shows where WebClient is set to start. Some SharePoint "Open in Explorer" workflows depend on it, so expect a few exceptions and document them.

### 3d. Restrict Outbound NTLM

This control has the most leverage, and it needs the most care. The setting is **Network security: Restrict NTLM: Outgoing NTLM traffic to remote servers**. It's backed by this registry value:

```
HKLM\SYSTEM\CurrentControlSet\Control\Lsa\MSV1_0
  RestrictSendingNTLMTraffic (REG_DWORD)
    0 = Allow all
    1 = Audit all
    2 = Deny all
  ClientAllowedNTLMServers (REG_MULTI_SZ)  -> exception list
```

Roll it out in three phases:

1. **Audit first.** Set the value to `1` fleet-wide. Collect events from the `Microsoft-Windows-NTLM/Operational` log for two to four weeks. Event ID 8001 records outgoing NTLM.
2. **Build the exception list.** Identify internal servers that still require NTLM. Add them to `ClientAllowedNTLMServers` and open tickets to move them to Kerberos.
3. **Enforce.** Set the value to `2`, starting with high-value users.

```powershell
# Phase 1: audit mode
$path = 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa\MSV1_0'
Set-ItemProperty -Path $path -Name RestrictSendingNTLMTraffic -Value 1 -Type DWord
```

Two related controls are worth applying now:

- **Protected Users group.** Members can't authenticate with NTLM at all. Put your privileged accounts here today. Test service-account dependencies first.
- **Enforce Kerberos where possible.** Every NTLM dependency you remove shrinks the relay attack surface.

### 3e. Make Relay Fail Even If a Hash Leaks

Assume some credential material will leak eventually. Make sure it can't be replayed anywhere useful:

| Target | Hardening |
|---|---|
| SMB | Require SMB signing on servers and clients |
| LDAP | Require LDAP signing and LDAP channel binding on domain controllers |
| AD CS web enrollment | Enable Extended Protection for Authentication (EPA) and require HTTPS, or remove the web enrollment role if unused |
| IIS and HTTP apps using Windows auth | Enable EPA |
| Exchange | Confirm EPA is enabled per Microsoft's current guidance |

Here's a quick check of SMB signing posture on servers:

```powershell
Get-SmbServerConfiguration | Select-Object RequireSecuritySignature, EnableSecuritySignature
Get-SmbClientConfiguration | Select-Object RequireSecuritySignature, EnableSecuritySignature
```

If `RequireSecuritySignature` is `False` on your file servers or domain controllers, that's a relay target. Fix it.

---

## Step 4: Hunt for Hash Capture and Relay

The bug is being exploited in the wild, so treat "we patched" as only half the job. The other half is answering this question: **did anyone use this against us before we closed it?**

### Hunt 1: Outlook Reaching Out over SMB

Outlook has no business initiating SMB connections to public IP addresses:

```kql
DeviceNetworkEvents
| where Timestamp > ago(30d)
| where InitiatingProcessFileName in~ ("outlook.exe", "olk.exe")
| where RemotePort in (139, 445)
| where RemoteIPType == "Public"
| project Timestamp, DeviceName, InitiatingProcessAccountName,
          RemoteIP, RemotePort, ActionType
| order by Timestamp desc
```

Widen it to any process. SMB to the internet from a workstation is suspicious no matter what started it:

```kql
DeviceNetworkEvents
| where Timestamp > ago(30d)
| where RemotePort == 445 and RemoteIPType == "Public"
| summarize Attempts = count(), Devices = dcount(DeviceId),
            Processes = make_set(InitiatingProcessFileName)
    by RemoteIP
| order by Devices desc
```

A single external IP touched by many devices is a strong signal that a campaign hit multiple mailboxes.

### Hunt 2: WebDAV Fallback Activity

When WebClient handles a UNC path, you'll often see `rundll32.exe` loading `davclnt.dll`:

```kql
DeviceProcessEvents
| where Timestamp > ago(30d)
| where FileName =~ "rundll32.exe"
| where ProcessCommandLine has "davclnt.dll" and ProcessCommandLine has "DavSetCookie"
| project Timestamp, DeviceName, AccountName, ProcessCommandLine,
          InitiatingProcessFileName
```

Look for external hostnames or IP addresses in the command line. Pay special attention when the parent chain traces back to Outlook.

### Hunt 3: Your Firewall Already Has the Evidence

The perimeter logs from Step 3a cover the period *before* you applied the block too, if you were logging permitted traffic. For Zeek users:

```bash
# External SMB destinations from internal hosts over the past 30 days
zcat conn.*.log.gz | zeek-cut ts id.orig_h id.resp_h id.resp_p conn_state \
  | awk '$4 == 445 && $3 !~ /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/' \
  | sort -k3 | uniq -c -f2 | sort -rn | head -50
```

Zeek's `ntlm.log` is even more useful. It records the **username and domain** sent in each NTLM exchange. That tells you exactly whose credentials went where.

### Hunt 4: Malicious Items Still Sitting in Mailboxes

Crafted items that trigger this class of bug can keep firing until someone removes them. Check Microsoft's advisory and any companion guidance for the specific message properties involved, along with any scanning tooling Microsoft provides. In the meantime, Defender for Office advanced hunting can surface messages with UNC or `file://` references:

```kql
EmailUrlInfo
| where Timestamp > ago(30d)
| where Url startswith "file://" or Url matches regex @"^\\\\[^\\]+\\"
| join kind=inner (EmailEvents | project NetworkMessageId, SenderFromAddress,
                   RecipientEmailAddress, Subject, Timestamp) on NetworkMessageId
| project Timestamp, SenderFromAddress, RecipientEmailAddress, Subject, Url
```

This won't catch every variant. Items like calendar invites, tasks, or embedded properties may not show up as URLs, which is why Microsoft's specific guidance matters here.

### Hunt 5: Detecting the Relay Itself

A relayed authentication lands on an internal server as an NTLM network logon (Event ID 4624, Logon Type 3). The telltale sign is a mismatch: **the account authenticates from an IP address that doesn't belong to that user's machine**, and often from a host that has no reason to be talking to that server.

```kql
SecurityEvent
| where TimeGenerated > ago(30d)
| where EventID == 4624 and LogonType == 3
| where AuthenticationPackageName == "NTLM"
| where TargetUserName !endswith "$" and TargetUserName != "ANONYMOUS LOGON"
| summarize SourceIPs = make_set(IpAddress, 20),
            Workstations = make_set(WorkstationName, 20),
            Targets = make_set(Computer, 20),
            Count = count()
    by TargetUserName, bin(TimeGenerated, 1h)
| where array_length(SourceIPs) > 1 or array_length(Workstations) > 1
```

Prioritize these patterns:

- **Privileged accounts** authenticating with NTLM at all. If they're in Protected Users, this shouldn't happen.
- **NTLM logons to domain controllers, AD CS servers, or file servers** from workstation IPs that don't match the claimed `WorkstationName`.
- **Machine account NTLM authentications** (`TargetUserName` ending in `$`) arriving from IP addresses that aren't that machine. This is the classic signature of coerced-authentication relay.
- **Defender for Identity alerts** for suspected NTLM relay or NTLM authentication tampering. If you run MDI, start here.

---

## If You Find Something

If the hunts turn up confirmed outbound authentication to attacker infrastructure:

1. **Reset passwords** for affected accounts. NTLMv2 responses can be cracked offline, so assume weak passwords are already compromised.
2. **Review logons by those accounts** after the leak timestamp. Focus on new devices, new source IPs, and access to sensitive systems.
3. **Purge the malicious items** from every mailbox, not just the ones you know were hit.
4. **Block the attacker infrastructure** at DNS and at the perimeter.
5. **If relay to AD CS is possible,** review recently issued certificates. A relayed enrollment produces a certificate that survives a password reset.
6. **Escalate to full incident response** if any privileged account or machine account shows signs of relay.

---

## The One-Page Checklist

- [ ] Pull the CVE, affected builds, and fixed versions from the Microsoft Security Update Guide
- [ ] Inventory every Outlook install, including C2R channel, MSI, new Outlook, VDI images, and servers
- [ ] Patch in compressed rings and verify by build number
- [ ] Block TCP 139/445 egress at the perimeter, with logging enabled
- [ ] Block outbound SMB to public IP ranges with host firewall policy
- [ ] Disable the WebClient service where it isn't needed
- [ ] Move outbound NTLM restriction to audit mode, then enforce
- [ ] Add privileged accounts to Protected Users
- [ ] Require SMB signing, LDAP signing and channel binding, and EPA on HTTP services
- [ ] Run Hunts 1–5 across at least the last 30 days
- [ ] Track unpatched and unreachable devices until the count reaches zero

---

## Final Thought

With 1,259 CVEs in a single release, any one bug can get lost in the noise. This one shouldn't. It's exploited, it targets the application every employee keeps open all day, and it can hand attackers credential material with little or no user interaction.

Patch it this week. More importantly, use it as the reason to finish the work that makes this whole bug class irrelevant. When no SMB leaves your network, NTLM is restricted, and every relay target requires signing or channel binding, the next Outlook hash-leak advisory becomes a routine patch instead of an incident.

## Sources

- [Microsoft Patches 1,259 Flaws, Including Exploited Outlook Bug That May Expose NTLMv2 Hashes](https://thehackernews.com/2026/11/microsoft-patches-1259-flaws-including.html) (2026-11-11)
