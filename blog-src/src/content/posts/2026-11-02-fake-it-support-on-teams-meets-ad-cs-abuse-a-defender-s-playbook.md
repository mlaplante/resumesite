---
title: "Fake IT Support on Teams Meets AD CS Abuse: A Defender's Playbook"
date: 2026-11-02
category: "thought-leadership"
tags: ["active-directory", "adcs", "microsoft-teams", "threat-hunting", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Some attack chains need a zero-day. This one needs a convincing chat message and a certificate template that nobody has reviewed since it was created...."
---

Some attack chains need a zero-day. This one needs a convincing chat message and a certificate template that nobody has reviewed since it was created.

According to recent reporting on a Microsoft investigation, attackers contacted employees on Microsoft Teams while posing as IT support. They persuaded those employees to grant remote control of their PCs. From that foothold, they abused insecure Active Directory Certificate Services (AD CS) settings to obtain authentication certificates for privileged accounts, including one for a domain controller. Microsoft said it investigated two intrusions of this kind, and at least one led to the theft of company data.

I haven't seen the full technical breakdown. I won't guess which remote tool was used, which template misconfigurations were exploited, or how long attackers stayed in the environment. Confirm those details in Microsoft's report. The broad pattern is well understood, though, and every step of it can be defended. This post covers three layers:

1. **Close the front door:** lock down Teams external access and remote-assistance tooling.
2. **Fix the escalation path:** audit and remediate AD CS templates and CA settings.
3. **Hunt for what's already happened:** find certificates that were issued to the wrong people.

## Why This Chain Is So Effective

Each stage takes advantage of a trust assumption:

- **Users trust Teams.** It feels internal. An email from "IT Helpdesk" gets scrutiny. A Teams chat often doesn't, especially when the user's inbox has just been flooded with spam and someone shows up offering to fix it.
- **Remote-assistance tools are legitimate.** Built-in or sanctioned remote support tools are signed binaries that your EDR expects to see.
- **AD CS is trusted by Kerberos.** A certificate with the right EKU and the right identity in it lets you authenticate as that identity through PKINIT. The account's password doesn't matter.

That last point catches a lot of defenders off guard. **Resetting a compromised account's password does not invalidate a certificate issued for that account.** The certificate stays valid until it expires or is revoked and the revocation has propagated. If an attacker holds a certificate for a domain controller account, they can request a Kerberos ticket as that DC and perform directory replication (DCSync). At that point you are responding to a domain compromise.

## Part 1: Close the Front Door

### Lock Down Teams External Access

Many tenants still run the defaults, which allow chat with users in any external Microsoft 365 tenant and sometimes with consumer Teams accounts. Start by checking where you stand:

```powershell
Connect-MicrosoftTeams

Get-CsTenantFederationConfiguration |
    Format-List AllowFederatedUsers, AllowedDomains, BlockedDomains,
                AllowTeamsConsumer, AllowTeamsConsumerInbound, AllowPublicUsers
```

If `AllowFederatedUsers` is `True` and `AllowedDomains` shows `AllowAllKnownDomains`, any external tenant can start a chat with your users. Anyone can create that tenant and name it something like "IT Service Desk."

**Option A: Allow-list the partners you actually work with.**

```powershell
$domains = "partner-one.com", "partner-two.com" |
    ForEach-Object { New-CsEdgeDomainPattern -Domain $_ }

$allowList = New-CsEdgeAllowList -AllowedDomain $domains

Set-CsTenantFederationConfiguration `
    -AllowedDomains $allowList `
    -AllowTeamsConsumer $false `
    -AllowTeamsConsumerInbound $false
```

**Option B: Deny by default and grant by exception.** In larger organizations, I prefer to turn off federation in the global external access policy and give a specific policy only to the people who need external chat, such as sales, partner management, and support.

```powershell
# Default: no external chat for anyone
Set-CsExternalAccessPolicy -Identity Global `
    -EnableFederationAccess $false `
    -EnableTeamsConsumerAccess $false

# Exception policy for teams that genuinely collaborate externally
New-CsExternalAccessPolicy -Identity "Tag:ExternalCollab" `
    -EnableFederationAccess $true `
    -EnableTeamsConsumerAccess $false

Grant-CsExternalAccessPolicy -Identity "jane.doe@corp.example" `
    -PolicyName "ExternalCollab"
```

Use both options together if you can. The tenant-level allow-list limits *who* can reach you, and the per-user policy limits *who in your organization* can be reached. Expect some policy propagation delay, and test with a pilot group before rolling out globally.

> **Note:** Microsoft has been adding Teams-specific protections over time, including external-sender warnings and admin controls for blocking domains. Check the current Teams admin center and Microsoft's documentation for the controls available in your tenant and license tier. Don't assume what I've listed here is everything.

### Make "IT Never Messages You First" a Real Policy

Technical controls lower the volume of these attempts. Process is what stops the ones that get through:

- **Publish one rule:** *The IT department will never contact you through an external Teams chat or ask you to start a remote session that you didn't request through the service portal.*
- **Teach users the "External" label.** Teams marks external senders. Show screenshots in training so people recognize it.
- **Give users a fast reporting path.** A one-click "Report suspicious chat" option or a monitored channel works better than a ticket form nobody fills out under pressure.
- **Have real support start sessions from the ticket.** If your helpdesk only initiates remote sessions from a ticket the user opened, a mismatch is easy to spot.

### Constrain Remote-Assistance Tooling

Pick one sanctioned remote support tool and block the others. If you don't use the built-in Quick Assist, remove it:

```powershell
# Remove Quick Assist for all users (run elevated; test first)
Get-AppxPackage -AllUsers -Name "MicrosoftCorporationII.QuickAssist" |
    Remove-AppxPackage -AllUsers
```

Back that up with an App Control (WDAC) or AppLocker policy so users can't reinstall it or run unsanctioned RMM tools from their Downloads folder.

To get a baseline of what remote tools are actually running in your environment, use Defender for Endpoint advanced hunting:

```kql
let remoteTools = dynamic([
    "QuickAssist.exe", "AnyDesk.exe", "TeamViewer.exe",
    "ScreenConnect.ClientService.exe", "ScreenConnect.WindowsClient.exe",
    "AteraAgent.exe", "rustdesk.exe", "Splashtop*"
]);
DeviceProcessEvents
| where Timestamp > ago(30d)
| where FileName in~ (remoteTools) or FileName matches regex @"(?i)^splashtop"
| summarize FirstSeen = min(Timestamp), LastSeen = max(Timestamp),
            Devices = dcount(DeviceId), Users = make_set(AccountName, 25)
          by FileName
| order by Devices desc
```

Any tool on that list that isn't your sanctioned one should be investigated. A tool that first appeared on a single workstation is a high-priority lead.

## Part 2: Audit Your AD CS Attack Surface

This is where the attackers turned a single workstation into control of the domain. The classic misconfiguration classes (commonly called ESC1 through ESC8 and beyond, from the SpecterOps "Certified Pre-Owned" research) all come down to one question: **can a low-privileged identity get a certificate that authenticates as someone more privileged?**

### The Dangerous Combination (ESC1)

A template is exploitable in the ESC1 sense when **all** of these are true:

1. It is **published** on an Enterprise CA.
2. It allows **client authentication**: Client Authentication, PKINIT, Smart Card Logon, Any Purpose, or no EKU at all.
3. The **enrollee supplies the subject**, so the requester chooses whose identity goes into the certificate (`CT_FLAG_ENROLLEE_SUPPLIES_SUBJECT`).
4. It requires **no manager approval** and **no authorized signatures**.
5. A **broad group** such as Domain Users, Domain Computers, or Authenticated Users has enrollment rights.

When all five line up, any user can request a certificate stating "I am the Domain Admin" and the CA will issue it.

### A Quick Triage Script

Use this for a first pass. It doesn't replace the dedicated tools covered below, but it runs with only the ActiveDirectory module, which makes it handy on a locked-down admin workstation.

```powershell
#Requires -Modules ActiveDirectory
$configNC = (Get-ADRootDSE).configurationNamingContext
$pks      = "CN=Public Key Services,CN=Services,$configNC"

# Templates actually published on an Enterprise CA
$published = Get-ADObject -SearchBase "CN=Enrollment Services,$pks" `
    -LDAPFilter '(objectClass=pKIEnrollmentService)' -Properties certificateTemplates |
    ForEach-Object { $_.certificateTemplates } | Sort-Object -Unique

$authEkus = @(
    '1.3.6.1.5.5.7.3.2',       # Client Authentication
    '1.3.6.1.5.2.3.4',         # PKINIT Client Authentication
    '1.3.6.1.4.1.311.20.2.2',  # Smart Card Logon
    '2.5.29.37.0'              # Any Purpose
)
$enrollRights = @(
    [guid]'0e10c968-78fb-11d2-90d4-00c04f79dc55',  # Certificate-Enrollment
    [guid]'a05b8cc2-17bc-4802-a710-e7c15ab866a2'   # Certificate-AutoEnrollment
)
$broad = '\\(Domain Users|Domain Computers|Authenticated Users|Everyone|Users)$|^Everyone$|^NT AUTHORITY\\Authenticated Users$'

Get-ADObject -SearchBase "CN=Certificate Templates,$pks" `
    -LDAPFilter '(objectClass=pKICertificateTemplate)' `
    -Properties name, 'msPKI-Certificate-Name-Flag', 'msPKI-Enrollment-Flag',
                'msPKI-RA-Signature', pKIExtendedKeyUsage, nTSecurityDescriptor |
Where-Object { $published -contains $_.name } |
ForEach-Object {
    $t    = $_
    $ekus = @($t.pKIExtendedKeyUsage)
    $ace  = $t.nTSecurityDescriptor.Access | Where-Object { $_.AccessControlType -eq 'Allow' }

    $enrollees = $ace | Where-Object {
        ($_.ActiveDirectoryRights -match 'ExtendedRight' -and
            ($enrollRights -contains $_.ObjectType -or $_.ObjectType -eq [guid]::Empty)) -or
        $_.ActiveDirectoryRights -match 'GenericAll'
    } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique

    $writers = $ace | Where-Object {
        $_.ActiveDirectoryRights -match 'GenericAll|GenericWrite|WriteDacl|WriteOwner|WriteProperty'
    } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique

    $authCapable     = ($ekus.Count -eq 0) -or [bool]($ekus | Where-Object { $authEkus -contains $_ })
    $suppliesSubject = ($t.'msPKI-Certificate-Name-Flag' -band 0x1) -ne 0
    $needsApproval   = ($t.'msPKI-Enrollment-Flag' -band 0x2) -ne 0
    $needsSignature  = [int]$t.'msPKI-RA-Signature' -gt 0
    $broadEnroll     = [bool]($enrollees | Where-Object { $_ -match $broad })
    $broadWrite      = [bool]($writers   | Where-Object { $_ -match $broad })

    [pscustomobject]@{
        Template        = $t.name
        AuthCapable     = $authCapable
        SuppliesSubject = $suppliesSubject
        Approval        = $needsApproval
        RASignatures    = $needsSignature
        BroadEnroll     = $broadEnroll
        ESC1_Candidate  = $authCapable -and $suppliesSubject -and -not $needsApproval -and
                          -not $needsSignature -and $broadEnroll
        ESC4_Candidate  = $broadWrite   # low-priv can rewrite the template itself
        Enrollees       = $enrollees -join '; '
    }
} | Sort-Object ESC1_Candidate, ESC4_Candidate -Descending | Format-Table -AutoSize
```

How to read the output:

- **`ESC1_Candidate = True`**: fix this today.
- **`ESC4_Candidate = True`**: a broad group can edit the template, which means it can make the template vulnerable. This is just as urgent.
- **`AuthCapable` with no EKUs**: also review these for ESC2 and subordinate-CA-style abuse.

### Validate With Purpose-Built Tools

My script is a flashlight. For thorough coverage, including ESC3 (enrollment agents), ESC6 (CA-level SAN flags), ESC7 (CA permissions), ESC8 (relay to web enrollment), and the newer variants, run one of the community tools that track this research:

```bash
# Certipy, from a Linux box with a low-privileged domain account
certipy find -u auditor@corp.example -p '<password>' -dc-ip 10.0.0.10 -vulnerable -stdout
```

```powershell
# Locksmith, PowerShell, from a domain-joined admin workstation
Install-Module -Name Locksmith -Scope CurrentUser
Invoke-Locksmith -Mode 1
```

Running them from a *low-privileged* account matters. You want to see what an attacker on a phished workstation would see.

### Check the CA Itself

Template hygiene isn't sufficient if the CA lets requesters add arbitrary SANs to any request (ESC6):

```powershell
certutil -config "PKI01.corp.example\Corp-Issuing-CA" -getreg policy\EditFlags
```

If `EDITF_ATTRIBUTESUBJECTALTNAME2` appears in the output, remove it:

```powershell
certutil -config "PKI01.corp.example\Corp-Issuing-CA" -setreg policy\EditFlags -EDITF_ATTRIBUTESUBJECTALTNAME2
Restart-Service certsvc
```

Also check whether HTTP-based web enrollment (`/certsrv`) is exposed. If it accepts NTLM over plain HTTP, it's an ESC8 relay target. Enforce HTTPS with Extended Protection for Authentication, or remove the role if no one uses it.

### Remediation Options, From Fastest to Best

1. **Unpublish** the template if nothing depends on it. This is fast and reversible:
   ```powershell
   certutil -config "PKI01.corp.example\Corp-Issuing-CA" -SetCATemplates -VulnerableTemplateName
   ```
2. **Require CA manager approval** as a stopgap. On the template, open the **Issuance Requirements** tab and select **CA certificate manager approval**.
3. **Fix the template properly.** Change the Subject Name setting to **Build from Active Directory information** instead of **Supply in the request**, and remove client-auth EKUs that the use case doesn't need.
4. **Narrow enrollment rights** from Domain Users to the specific security group that needs the template.
5. **Remove broad write permissions** on template objects and on the CA. Only PKI administrators should hold them.

On the DC side, make sure you are enforcing **strong certificate mapping** as described in Microsoft's current guidance. It makes some SAN-spoofing attacks harder. It is not a substitute for fixing templates, so don't use it as a reason to leave an ESC1 template published.

## Part 3: Hunt for Rogue Certificates

Assume someone found these paths before you did. The goal is to find certificates whose **requester** doesn't match the **identity inside the certificate**.

### Turn On CA Auditing (If It's Off)

Many CAs never had auditing enabled. Turn it on now so future requests get logged:

```powershell
certutil -setreg CA\AuditFilter 127
auditpol /set /subcategory:"Certification Services" /success:enable /failure:enable
Restart-Service certsvc
```

Key events on the CA:

| Event ID | Meaning |
|---|---|
| 4886 | Certificate request received |
| 4887 | Certificate request approved and issued |
| 4888 | Request denied |
| 4899 / 4900 | Template or template security updated |

### Query the CA Database Directly

The CA database records every certificate it ever issued, which makes it the source of truth. Pull recent issuances (Disposition 20 means issued):

```powershell
certutil -view -restrict "Disposition=20,NotBefore>=10/1/2026" `
    -out "RequestID,RequesterName,CommonName,UPN,CertificateTemplate,SerialNumber,NotBefore,NotAfter" csv |
    Out-File .\issued.csv -Encoding utf8
```

Column names and date formats depend on locale and CA version. Run `certutil -schema` to confirm the exact column names on your CA. Adjust the date to cover your investigation window.

Then flag mismatches:

```powershell
$certs = Import-Csv .\issued.csv
$certs | Where-Object {
    $requester = ($_.'Requester Name' -split '\\')[-1].TrimEnd('$')
    $upnUser   = ($_.'User Principal Name' -split '@')[0]
    $cn        = $_.'Issued Common Name'
    ($upnUser -and $upnUser -ne $requester) -or
    ($cn -and $cn -notmatch [regex]::Escape($requester))
} | Select-Object 'Request ID', 'Requester Name', 'User Principal Name',
                  'Issued Common Name', 'Certificate Template', 'Serial Number', 'Certificate Effective Date'
```

These results deserve immediate escalation:

- A standard user requesting a certificate whose UPN is a privileged account.
- Any non-DC requester obtaining a certificate that names a **domain controller**.
- Issuances from templates you flagged as ESC1 candidates in Part 2, from any requester.

Expect false positives from legitimate enrollment agents and some automation such as MDM or network access control, so baseline those. Note also that v2+ templates may show up as OIDs rather than friendly names.

### Find Where Those Certificates Were Used

When a certificate is used for Kerberos PKINIT, the DC's **4768** event (TGT requested) records the certificate's issuer and serial number. That lets you connect a suspicious issuance to actual logons. In Microsoft Sentinel:

```kql
SecurityEvent
| where TimeGenerated > ago(30d)
| where EventID == 4768
| extend ed = parse_xml(EventData)
| mv-apply d = ed.EventData.Data on (
    summarize bag = make_bag(pack(tostring(d['@Name']), tostring(d['#text'])))
  )
| extend TargetUser   = tostring(bag.TargetUserName),
         CertIssuer   = tostring(bag.CertIssuerName),
         CertSerial   = tostring(bag.CertSerialNumber),
         PreAuthType  = tostring(bag.PreAuthType),
         ClientIP     = tostring(bag.IpAddress)
| where isnotempty(CertSerial)
| summarize Logons = count(), FirstSeen = min(TimeGenerated), LastSeen = max(TimeGenerated),
            SourceIPs = make_set(ClientIP, 20)
          by TargetUser, CertIssuer, CertSerial
| order by FirstSeen desc
```

Three things to look for:

- **Privileged accounts authenticating with certificates** when your organization doesn't use smart cards for those accounts.
- **DC machine accounts getting TGTs through PKINIT from a source IP that isn't that DC.** In the scenario from the report, this is the single highest-value signal.
- **Serial numbers that match your mismatch list** from the CA database query.

If you run Defender for Identity, review its alerts for suspicious certificate usage and DCSync-style replication requests as well. They complement these raw-event hunts without replacing them.

### Watch for Persistence in the PKI Itself

An attacker who reached domain admin may have modified your PKI so they can come back later. Check for:

- **4899 / 4900 events** and directory change auditing (4662/5136) on objects under `CN=Certificate Templates`. Look for new templates, ACL changes, or EKU and flag changes.
- **Changes to CA permissions**, such as new CA managers or officers.
- **CA backup activity or private key access** on the CA server. A stolen CA private key ("golden certificate") lets an attacker forge certificates offline, and no hunt in the CA database will ever show them.

## Part 4: If You Find a Rogue Certificate

Treat it as a domain-level incident, not a workstation cleanup.

1. **Revoke and publish immediately.**
   ```powershell
   certutil -revoke <SerialNumber> 1      # reason 1 = Key Compromise
   certutil -crl                           # publish a fresh CRL now
   ```
   DCs cache revocation data, so revocation isn't instant everywhere. Know your CRL validity and overlap periods.
2. **Remember that password resets won't help on their own.** Revocation is what neutralizes the certificate. Reset passwords anyway, because attackers can use PKINIT to recover NT hashes.
3. **If a DC or other Tier 0 certificate was issued, assume a DCSync happened.** Rotate the `krbtgt` password twice, allowing for replication between rotations, and reset Tier 0 credentials and service accounts. Then hunt for additional persistence: new admins, GPO changes, scheduled tasks on DCs, and AdminSDHolder modifications.
4. **Fix the template before you do anything else.** If you revoke the certificate but leave the door open, the attacker can request a new one in seconds.
5. **If CA key compromise is plausible,** plan to rebuild the PKI. It's painful, but it's the only reliable fix for forged certificates.
6. **Trace back to initial access.** Pull Teams audit logs for the external chat, identify the remote session, and check whether other users received the same messages.

## The Checklist

If you only do the minimum this week, do this:

- [ ] Restrict Teams external access to an allow-list, or deny by default with per-user exceptions.
- [ ] Turn off consumer Teams inbound chat unless you have a clear business need.
- [ ] Standardize on one remote support tool. Remove or block the rest.
- [ ] Publish and train on "IT never initiates external chats."
- [ ] Run Certipy or Locksmith as a low-privileged user and fix every ESC1/ESC4 finding.
- [ ] Check CA `EditFlags` for `EDITF_ATTRIBUTESUBJECTALTNAME2`.
- [ ] Enable CA auditing and send 4886/4887/4899/4900 to your SIEM.
- [ ] Hunt the CA database for requester/subject mismatches.
- [ ] Hunt 4768 for certificate-based TGTs on privileged and DC accounts.
- [ ] Write the "rogue certificate found" runbook before you need it.

This attack chain was simple. It started with a chat message, used legitimate remote tooling, and finished with a certificate template that should have been fixed years ago. Every step can be defended with configuration and visibility you already have. The thing that tends to go wrong is that AD CS has no clear owner, and nobody looks at it until an incident forces the issue.

## Sources

- [Attackers Pose as IT Support on Microsoft Teams, Abuse AD CS to Steal Company Data](https://thehackernews.com/2026/11/attackers-pose-as-it-support-on.html) (2026-11-02)
