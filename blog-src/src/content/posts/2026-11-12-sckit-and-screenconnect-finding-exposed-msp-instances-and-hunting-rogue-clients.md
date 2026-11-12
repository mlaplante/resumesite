---
title: "SCKit and ScreenConnect: Finding Exposed MSP Instances and Hunting Rogue Clients"
date: 2026-11-12
category: "thought-leadership"
tags: ["screenconnect", "incident-response", "threat-hunting", "msp-security", "vulnerability-management"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Remote access tools are the skeleton keys of IT operations. When attackers get one, they get every door it opens. That is why the latest ScreenConnect..."
---

Remote access tools are the skeleton keys of IT operations. When attackers get one, they get every door it opens. That is why the latest ScreenConnect news needs attention from anyone who runs an MSP, depends on one, or has ConnectWise ScreenConnect anywhere in their environment.

According to reporting from The Hacker News, Blackpoint Cyber's Adversary Pursuit Group (APG) recovered an attacker toolkit, dubbed **SCKit**, used in an ongoing campaign against ScreenConnect deployments. The key detail is that the campaign does **not** use a new zero-day. It exploits **CVE-2026-84869**, a critical flaw with a **CVSS score of 9.9** that has already been patched. The headline describes the risk well: SCKit turns ScreenConnect support sessions into potential MSP attack paths.

In practice, this means the exposure comes from your patching and visibility gaps, not from attacker novelty. This post covers three jobs:

1. Find every ScreenConnect server you own, including the ones nobody remembers.
2. Patch them correctly without destroying evidence.
3. Hunt for rogue ScreenConnect clients and signs that a server was used as a launch point.

> **A note on specifics:** The public summary I'm working from doesn't list affected version ranges, fixed builds, or the exact technical mechanics of CVE-2026-84869. **Confirm those details in the ConnectWise security advisory** before you act. I won't guess at version numbers, and you shouldn't either.

---

## Why ScreenConnect Compromises Hit MSPs Harder

A typical internal application compromise affects one organization. A ScreenConnect server at an MSP is a **hub** connected to hundreds or thousands of endpoints across dozens of customers. Each of those endpoints runs a client that does three things:

- runs as a privileged Windows service,
- calls back to a relay the server controls, and
- accepts remote commands, file transfers, and interactive sessions by design.

An attacker who controls the server doesn't need to find a new exploit for each customer. They use the product the way it was designed to work. Malicious activity can look a lot like a technician doing their job, which is exactly why "support sessions as attack paths" is the right framing.

There is a second, related pattern: attackers often install **their own** ScreenConnect client on a victim machine, pointed at an attacker-controlled server. Because the binary is legitimate and signed, it can blend into environments where ScreenConnect is already expected. The hunting section below covers both cases.

---

## Step 1: Find Every Exposed Instance

You can't patch what you can't see. In my experience, the dangerous ScreenConnect server is rarely the production one the NOC watches. It is more often one of these:

- the trial instance a tech stood up three years ago,
- the server left over from an acquisition,
- a customer-owned on-prem instance that the MSP still has credentials for.

### Start with what you think you have

Pull together a list from these sources:

- **CMDB and asset inventory**: search for "ScreenConnect" and "ConnectWise Control" (the product's former name).
- **Licensing records**: ConnectWise license keys map to instances, and orphaned licenses point to orphaned servers.
- **DNS**: look for records like `support.`, `help.`, `remote.`, `control.`, and `sc.` across every zone you manage.
- **Firewall NAT rules**: inbound rules forwarding to internal hosts on the ScreenConnect web and relay ports. Default installs use **8040 (web)** and **8041 (relay)**, but many deployments move the web interface to 443, so don't rely on port alone.

### Then verify from the outside

Here is a small Python script I'd run against **your own** public IP space and hostnames to confirm which ones actually serve a ScreenConnect interface. Only scan assets you own or are authorized to test.

```python
#!/usr/bin/env python3
"""
sc_exposure_check.py - Identify ScreenConnect web interfaces on owned assets.
Usage: python3 sc_exposure_check.py targets.txt > results.csv
targets.txt: one host or host:port per line
"""
import csv
import sys
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEFAULT_PORTS = [443, 8040, 80]
MARKERS = ("screenconnect", "connectwise control")

def probe(host, port):
    scheme = "http" if port in (80, 8040) else "https"
    url = f"{scheme}://{host}:{port}/"
    try:
        r = requests.get(url, timeout=6, verify=False, allow_redirects=True)
    except requests.RequestException as e:
        return None
    blob = (r.text[:200_000] + " " + " ".join(f"{k}:{v}" for k, v in r.headers.items())).lower()
    if any(m in blob for m in MARKERS):
        return {
            "target": f"{host}:{port}",
            "url": r.url,
            "status": r.status_code,
            "server_header": r.headers.get("Server", ""),
        }
    return None

def main(path):
    writer = csv.DictWriter(sys.stdout, fieldnames=["target", "url", "status", "server_header"])
    writer.writeheader()
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                host, port = line.rsplit(":", 1)
                ports = [int(port)]
            else:
                host, ports = line, DEFAULT_PORTS
            for p in ports:
                hit = probe(host, p)
                if hit:
                    writer.writerow(hit)
                    break

if __name__ == "__main__":
    main(sys.argv[1])
```

Depending on the build and configuration, the response headers or page content may reveal version information. Check what your own instances expose, and don't assume a missing version string means you're safe. **Confirm the running version from the admin console on each server**, then compare it against the fixed builds listed in the ConnectWise advisory.

If you subscribe to an attack-surface or internet-scanning service, query it for your organization's IP ranges and certificates with "ScreenConnect" in page titles or HTML. The results often include a host your internal inventory missed.

### Cloud vs. on-prem

ConnectWise has historically remediated its cloud-hosted ScreenConnect instances on the vendor side, while on-premises customers have to upgrade themselves. **Confirm in the advisory how CVE-2026-84869 was handled for cloud instances.** Don't assume. Even if the vendor patched your cloud instance, you still need to run the hunting steps below, because the patch doesn't undo anything that happened before it was applied.

---

## Step 2: Contain, Preserve, Then Patch

The instinct is to patch immediately, and for most environments that is correct. But this flaw has a 9.9 severity score and is under active exploitation. If an on-prem server was internet-facing and unpatched at any point during the campaign window, **treat it as potentially compromised**. An in-place upgrade overwrites files you may later need for investigation.

Here is the order I recommend for an exposed, unpatched on-prem server:

1. **Restrict exposure first.** Firewall the web interface down to known technician IPs or put it behind a VPN or zero-trust proxy. If you can't do that quickly, take it offline. Restricting access takes minutes, while forensic imaging takes longer.
2. **Preserve evidence.** Snapshot the VM if possible. At a minimum, copy the installation directory, especially `App_Data` and any extensions folder, along with Windows Event Logs and IIS or web logs if present.
3. **Patch to the fixed version listed in the ConnectWise advisory.** Verify the version in the admin console afterward.
4. **Rotate credentials.** Reset all ScreenConnect user passwords, re-enroll MFA, and rotate any service accounts or API keys tied to the instance.
5. **Hunt** using the steps below.

A minimal evidence grab in PowerShell might look like this. Adjust the path for your install, since many on-prem servers live under `Program Files (x86)\ScreenConnect`.

```powershell
$scRoot   = 'C:\Program Files (x86)\ScreenConnect'
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidence = "D:\IR\ScreenConnect-$env:COMPUTERNAME-$stamp"

New-Item -ItemType Directory -Path $evidence -Force | Out-Null

# Copy the full install tree (App_Data holds config, users, and session data)
robocopy $scRoot "$evidence\install" /E /COPY:DAT /R:1 /W:1 /NP /LOG:"$evidence\robocopy.log"

# Export relevant event logs
foreach ($log in 'System','Security','Application') {
    wevtutil epl $log "$evidence\$log.evtx"
}

# Hash everything for chain of custody
Get-ChildItem $evidence -Recurse -File |
    Get-FileHash -Algorithm SHA256 |
    Export-Csv "$evidence\hashes.csv" -NoTypeInformation
```

If the session database is locked while the service runs, stop the ScreenConnect services after you've cut network exposure, then copy it.

---

## Step 3: Hunt on the Server

On a ScreenConnect server, you're looking for ways an attacker could persist through a patch. Focus on four areas.

### Unexpected or recently modified web files

A web shell dropped into the application directory survives an upgrade if the upgrade doesn't overwrite that specific file. Look for recently modified or unfamiliar server-side web files:

```powershell
$scRoot = 'C:\Program Files (x86)\ScreenConnect'
$since  = (Get-Date).AddDays(-60)

Get-ChildItem $scRoot -Recurse -File -Include *.aspx,*.ashx,*.asmx,*.asax,*.config,*.dll -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $since -or $_.CreationTime -gt $since } |
    Sort-Object LastWriteTime -Descending |
    Select-Object FullName, CreationTime, LastWriteTime, Length
```

The patch itself will modify many files, so run this **before** upgrading, using your preserved copy. Better still, diff against a clean install of the same version on a lab VM. Anything present in production but not in the clean install needs an explanation.

### Users you didn't create

Review the user store for accounts that appeared recently or have names that don't match your naming convention. On many on-prem installs, internal users live in an XML file under `App_Data`. The schema varies by version, so this query is deliberately loose:

```powershell
$userFile = 'C:\Program Files (x86)\ScreenConnect\App_Data\User.xml'
[xml]$doc = Get-Content $userFile -Raw

$doc.SelectNodes("//*[local-name()='User']") | ForEach-Object {
    $props = @{}
    foreach ($child in $_.ChildNodes) { $props[$child.LocalName] = $child.InnerText }
    [pscustomobject]$props
} | Format-Table -AutoSize
```

Cross-check the results against your HR or IdP roster. Every admin account should map to a real person who still works for you. Also review any external identity provider integrations configured in the admin console. An attacker who adds their own SSO trust can keep access even after you rotate every password.

### Extensions

ScreenConnect supports extensions that run inside the server process. Review the installed extensions list in the admin UI and the extensions directory on disk. Remove anything you don't recognize and can't trace to a legitimate source.

### Audit and session history

Review the instance's audit log and session history for these patterns:

- sessions created outside business hours or from unfamiliar source IPs,
- bulk commands pushed to many endpoints in a short window,
- new "Access" sessions (unattended installs) for machines nobody onboarded,
- toolbox items or file transfers you can't attribute to a ticket.

If you're an MSP, the endpoints touched during any suspicious window define your **customer notification scope**. Build that list early.

---

## Step 4: Hunt for Rogue Clients on Endpoints

This is where most of the work lands, and it applies to MSPs and their customers alike. Every ScreenConnect client installs a Windows service, typically named `ScreenConnect Client (<thumbprint>)`. The service's command line contains a query string that tells you **which relay it calls home to**, in the `h=` (host) and `p=` (port) parameters.

The core check is simple: any client pointing to a relay that isn't on your approved list is suspect.

```powershell
# Find-ScreenConnectClients.ps1
# Enumerate ScreenConnect client services and flag unapproved relays.

$ApprovedRelays = @(
    'support.example-msp.com',
    'relay.example-msp.com'
)

Get-CimInstance Win32_Service |
    Where-Object { $_.PathName -match 'ScreenConnect\.ClientService\.exe' -or $_.Name -like 'ScreenConnect Client*' } |
    ForEach-Object {
        $path   = $_.PathName
        $query  = ($path -split '\?', 2)[1]
        $params = @{}

        if ($query) {
            foreach ($pair in ($query.Trim('"', ' ') -split '&')) {
                $k, $v = $pair -split '=', 2
                if ($k) { $params[$k] = [uri]::UnescapeDataString([string]$v) }
            }
        }

        [pscustomobject]@{
            Computer    = $env:COMPUTERNAME
            ServiceName = $_.Name
            State       = $_.State
            StartMode   = $_.StartMode
            RelayHost   = $params['h']
            RelayPort   = $params['p']
            SessionType = $params['e']
            Approved    = ($ApprovedRelays -contains $params['h'])
            PathName    = $path
        }
    }
```

Push this through your RMM, Intune, or EDR live-response tooling and collect the output centrally. Every row with `Approved = False` needs triage. Keep three caveats in mind:

- **White-labeled builds** may rename the service or executable. If your MSP rebrands the client, add that naming pattern to the filter.
- **Legitimate third-party vendors**, such as a line-of-business software vendor's support team, may have their own ScreenConnect clients installed. Those aren't malicious, but they are third-party access you should know about and approve.
- **macOS and Linux clients** exist too. Look for ScreenConnect launch daemons or systemd units and check their configured relay host the same way.

### Catch new client installs as they happen

Windows logs service installations as **Event ID 7045** in the System log. This query shows recent ScreenConnect service creations on a host:

```powershell
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7045; StartTime = (Get-Date).AddDays(-90) } |
    Where-Object { $_.Message -match 'ScreenConnect' } |
    Select-Object TimeCreated, @{n='Detail';e={$_.Message}} |
    Format-List
```

Forward 7045 events to your SIEM and alert on any new ScreenConnect service whose image path doesn't contain an approved relay host.

### EDR queries

If you run Microsoft Defender for Endpoint, these KQL queries are good starting points. The same logic translates easily to other EDR query languages.

**Suspicious child processes spawned by the ScreenConnect client:**

```kql
DeviceProcessEvents
| where Timestamp > ago(30d)
| where InitiatingProcessFileName =~ "ScreenConnect.ClientService.exe"
   or InitiatingProcessParentFileName =~ "ScreenConnect.ClientService.exe"
| where FileName in~ ("cmd.exe","powershell.exe","pwsh.exe","rundll32.exe","regsvr32.exe",
                      "mshta.exe","wscript.exe","cscript.exe","certutil.exe","bitsadmin.exe")
| summarize Executions = count(),
            Devices    = dcount(DeviceName),
            SampleCmds = make_set(ProcessCommandLine, 25),
            FirstSeen  = min(Timestamp),
            LastSeen   = max(Timestamp)
  by FileName, InitiatingProcessFileName
| order by Devices desc
```

Your technicians legitimately run commands through ScreenConnect, so expect noise. The signal you want is **breadth and timing**. The same encoded PowerShell hitting 300 machines across 40 customers within 10 minutes at 2 a.m. is not a technician fixing a printer.

**ScreenConnect clients talking to unapproved destinations:**

```kql
let approved = dynamic(["support.example-msp.com","relay.example-msp.com"]);
DeviceNetworkEvents
| where Timestamp > ago(30d)
| where InitiatingProcessFileName =~ "ScreenConnect.ClientService.exe"
| where isnotempty(RemoteUrl) and not(RemoteUrl has_any (approved))
| summarize Devices = dcount(DeviceName), Ports = make_set(RemotePort), FirstSeen = min(Timestamp)
  by RemoteUrl, RemoteIP
| order by Devices desc
```

If a hit turns up an unapproved relay on a single machine, look at how the client got installed. Check its parent process, the download source, and the user context. Then sweep the rest of the fleet for the same relay host.

---

## Hardening So the Next One Hurts Less

Patching CVE-2026-84869 closes this specific hole. The structural fixes below reduce how much damage the next ScreenConnect-class vulnerability can do:

- **Don't expose the admin web interface to the internet.** Put technician access behind a VPN, ZTNA, or IP allowlist. The relay port may need broader reach for clients, but the login page usually doesn't.
- **Enforce MFA on every ScreenConnect account**, preferably through your IdP, and audit the IdP trust configuration regularly.
- **Separate customer tenancy where you can.** One server reaching every customer is convenient, and it is also a single blast radius.
- **Maintain an approved-relay allowlist** and run the rogue-client sweep on a schedule, not just during incidents.
- **Alert on bulk actions**, such as commands or toolbox runs across many sessions in a short window.
- **Subscribe to ConnectWise security bulletins** and set an internal SLA for critical remote-access patches. For internet-facing remote access tools, I'd target hours rather than the next maintenance window.

---

## The Takeaway

The most important fact in this story is that **SCKit exploits a vulnerability that is already patched.** That shifts the conversation from "what's the zero-day?" to "why are so many instances still vulnerable?" The answer is usually inventory: forgotten servers, unclear ownership, and remote access tools treated as background utilities instead of tier-zero infrastructure.

To summarize the response:

1. Find every instance, including the ones outside your CMDB.
2. Contain exposure, preserve evidence, then patch to the fixed version in the ConnectWise advisory.
3. Hunt the server for persistence: web files, users, extensions, and audit history.
4. Hunt endpoints for clients calling relays you don't control.

If you're an MSP, your customers are trusting you with the keys to their whole environment. If you're a customer of an MSP, ask them this week which ScreenConnect version they're running and whether they've completed a rogue-client sweep. Both conversations are worth having before an attacker forces them.

## Sources

- [SCKit Malware Turns ScreenConnect Support Sessions Into Potential MSP Attack Paths](https://thehackernews.com/2026/11/sckit-malware-targets-screenconnect.html) (2026-11-12)
