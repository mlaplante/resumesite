---
title: "Hunting Microsoft 365 Token Replay Attacks and Locking Down Entra ID"
date: 2026-10-26
category: "thought-leadership"
tags: ["microsoft-365", "entra-id", "threat-hunting", "conditional-access", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Many identity programs still treat \"MFA everywhere\" as the finish line. Adversary-in-the-middle (AitM) phishing shows why it isn't. The user enters a..."
---

Many identity programs still treat "MFA everywhere" as the finish line. Adversary-in-the-middle (AitM) phishing shows why it isn't. The user enters a password, approves the push, completes MFA correctly, and still hands the attacker a working session.

Huntress recently disclosed a Microsoft 365 campaign that used an AitM relay to capture sign-in sessions and then replayed the stolen tokens to get into email accounts. They observed the activity between July 14 and September 22, 2026, and recorded 497 successful Microsoft 365 sign-in events, with 97 accounts compromised across 79 organizations. Check the original report for the full indicator set and infrastructure details. I won't guess at specifics that aren't public.

The technique is not new, and the defenses are well understood. This post covers what to hunt for in Entra ID and Exchange telemetry, how to respond when you find a replayed session, and how to configure Conditional Access so a stolen cookie no longer opens a mailbox.

## Why MFA Didn't Stop It

The typical AitM flow looks like this:

1. The victim clicks a link to a phishing domain that runs a reverse proxy.
2. The proxy forwards every request to the real Microsoft login endpoint and passes every response back. The victim sees the real Microsoft sign-in experience, including your company branding.
3. The victim enters credentials and completes MFA. Microsoft issues session cookies and tokens to the proxy, which relays them to the browser and **keeps a copy**.
4. The attacker imports the captured session into their own browser or tooling and replays it. The session already carries an MFA claim, so Microsoft is not asked to challenge again.

One detail matters a lot for detection. From Entra ID's point of view, the victim's "legitimate" interactive sign-in came from the proxy's IP address, not the user's home or office. The first sign-in event in the logs is already attacker infrastructure. The replay often comes from a second set of infrastructure.

Push notifications, number matching, SMS, and TOTP cannot prevent this, because the user really did complete them. The proxy simply carried the result to Microsoft. Only authentication bound to the origin or the device breaks the chain. We'll get to that.

## The Telemetry You Need

Confirm these sources are flowing into your SIEM before you start hunting. Examples use Microsoft Sentinel table names. Defender XDR advanced hunting has equivalents, but column names differ slightly.

| Source | Sentinel Table | Why It Matters |
|---|---|---|
| Interactive sign-ins | `SigninLogs` | Initial AitM authentication |
| Non-interactive sign-ins | `AADNonInteractiveUserSignInLogs` | Token refresh and replay activity, often the bulk of attacker traffic |
| Directory audit | `AuditLogs` | MFA method registration, app consent |
| Exchange/M365 audit | `OfficeActivity` or `CloudAppEvents` | Inbox rules, mail access, forwarding |
| Identity Protection | `AADUserRiskEvents` | Built-in risk detections such as anomalous token and attacker-in-the-middle |

Many tenants still don't export non-interactive sign-in logs because of volume and cost. If yours is one of them, fix that first. Without those logs you will miss most of the replay activity.

## Hunt 1: One Session, Many Networks

Each Entra sign-in session has a `SessionId`. When the attacker replays a stolen session, the new activity often keeps the same `SessionId` but arrives from a different IP, ASN, country, or user agent. That makes `SessionId` a useful pivot.

```kql
let lookback = 14d;
union isfuzzy=true
    (SigninLogs | where TimeGenerated > ago(lookback)),
    (AADNonInteractiveUserSignInLogs | where TimeGenerated > ago(lookback))
| where ResultType == 0
| where isnotempty(SessionId)
// LocationDetails is dynamic in SigninLogs but a string in the non-interactive table
| extend Loc = parse_json(tostring(LocationDetails))
| extend Country = tostring(Loc.countryOrRegion),
         ASN     = tostring(AutonomousSystemNumber)
| summarize
    FirstSeen  = min(TimeGenerated),
    LastSeen   = max(TimeGenerated),
    IPs        = make_set(IPAddress, 25),
    ASNs       = make_set(ASN, 25),
    Countries  = make_set(Country, 10),
    UserAgents = make_set(UserAgent, 10),
    Apps       = make_set(AppDisplayName, 15),
    Events     = count()
  by UserPrincipalName, SessionId
| where array_length(ASNs) > 1
| extend CountryCount = array_length(Countries)
| order by CountryCount desc, Events desc
```

**Tuning notes:**

- Mobile users switching between Wi-Fi and cellular will legitimately span ASNs. Rank by `CountryCount` first. One session touching two countries within minutes is a much stronger signal.
- Add a hosting-provider watchlist. Real users rarely authenticate from VPS or cloud hosting ranges. If you keep a `HostingASNs` watchlist, it plugs in directly:

```kql
let hosting = _GetWatchlist('HostingASNs') | project ASN = tostring(SearchKey);
// ...append to the query above, before the summarize:
| extend IsHosting = ASN in (hosting)
```

Then add `HostingHits = countif(IsHosting)` to the `summarize` and sort on it.

## Hunt 2: MFA-Satisfied Sign-ins From Infrastructure That Shouldn't Exist

The AitM proxy is what actually talks to Microsoft, so look for interactive sign-ins that completed MFA from an unmanaged device on a network the user has never used.

```kql
let lookback = 7d;
let baseline = 30d;
let hosting = _GetWatchlist('HostingASNs') | project ASN = tostring(SearchKey);
// Networks each user has historically signed in from
let knownASNs = SigninLogs
    | where TimeGenerated between (ago(baseline) .. ago(lookback))
    | where ResultType == 0
    | summarize KnownASNs = make_set(tostring(AutonomousSystemNumber), 100) by UserPrincipalName;
SigninLogs
| where TimeGenerated > ago(lookback)
| where ResultType == 0
| where AuthenticationRequirement == "multiFactorAuthentication"
| extend ASN       = tostring(AutonomousSystemNumber),
         IsManaged = tostring(DeviceDetail.isManaged),
         TrustType = tostring(DeviceDetail.trustType)
| where IsManaged != "true" and isempty(TrustType)
| join kind=leftouter knownASNs on UserPrincipalName
| where not(set_has_element(KnownASNs, ASN))
| extend IsHosting = ASN in (hosting)
| project TimeGenerated, UserPrincipalName, AppDisplayName, IPAddress, ASN,
          IsHosting, UserAgent, SessionId, RiskLevelDuringSignIn, ConditionalAccessStatus
| order by IsHosting desc, TimeGenerated desc
```

When this query returns a hit, pivot on its `SessionId` back into Hunt 1. A new hosting-ASN interactive sign-in followed by non-interactive activity on the same session from a different network is about as clear as AitM gets in log form.

Don't ignore Entra ID Protection's built-in detections. Identity Protection has risk detections aimed at this exact pattern, including anomalous token and attacker-in-the-middle signals:

```kql
AADUserRiskEvents
| where TimeGenerated > ago(30d)
| where RiskEventType in~ ("anomalousToken", "attackerinTheMiddle", "tokenIssuerAnomaly")
| project TimeGenerated, UserPrincipalName, RiskEventType, RiskLevel, IpAddress, DetectionTimingType
```

Exact detection names and licensing requirements change over time. Verify against the current Identity Protection documentation for your tenant.

## Hunt 3: What They Did in the Mailbox

Attackers who steal a mailbox session usually move quickly toward business email compromise. A common early step is an inbox rule that hides replies from the real user, such as messages from finance, the bank, or "was this you?" alerts.

The `Parameters` field in `OfficeActivity` is a JSON array of name/value pairs. Flatten it into something you can filter:

```kql
OfficeActivity
| where TimeGenerated > ago(30d)
| where Operation in~ ("New-InboxRule", "Set-InboxRule", "UpdateInboxRules")
| mv-expand P = todynamic(Parameters)
| extend PName = tostring(P.Name), PValue = tostring(P.Value)
| summarize Params = make_bag(bag_pack(PName, PValue))
    by OfficeId, TimeGenerated, UserId, ClientIP, Operation
| extend RuleName   = tostring(Params.Name),
         MoveTo     = tostring(Params.MoveToFolder),
         Delete     = tostring(Params.DeleteMessage),
         MarkRead   = tostring(Params.MarkAsRead),
         ForwardTo  = strcat(tostring(Params.ForwardTo), tostring(Params.RedirectTo)),
         Keywords   = strcat(tostring(Params.SubjectContainsWords), tostring(Params.BodyContainsWords))
| where strlen(RuleName) <= 3                                  // ".", "..", "x" style names
     or MoveTo has_any ("RSS", "Archive", "Conversation History", "Junk")
     or Delete =~ "True"
     or isnotempty(ForwardTo)
| project TimeGenerated, UserId, ClientIP, Operation, RuleName, MoveTo, Delete, MarkRead, ForwardTo, Keywords
```

`UpdateInboxRules` events (from Outlook clients via MAPI/EWS) carry a different parameter structure than the PowerShell-style cmdlets. Expect to tune for that, or use `CloudAppEvents` in Defender XDR, which normalizes some of it.

Then check whether the compromised session read mail at scale:

```kql
OfficeActivity
| where TimeGenerated > ago(14d)
| where Operation == "MailItemsAccessed"
| where UserId =~ "victim@contoso.com"
| summarize Items = count(), FirstAccess = min(TimeGenerated), LastAccess = max(TimeGenerated)
    by ClientIP, ClientInfoString
| order by Items desc
```

`MailItemsAccessed` coverage depends on your licensing and audit configuration. Find out whether you have it before an incident, not during one.

## Hunt 4: Persistence Through MFA Registration

A replayed session expires eventually. A newly registered authenticator on the victim's account does not. Look for security info registration shortly after a suspicious sign-in:

```kql
let suspicious = SigninLogs
    | where TimeGenerated > ago(14d)
    | where RiskLevelDuringSignIn in ("medium", "high")
       or tostring(DeviceDetail.isManaged) != "true"
    | project UserPrincipalName, SuspiciousTime = TimeGenerated, SuspiciousIP = IPAddress;
AuditLogs
| where TimeGenerated > ago(14d)
| where OperationName has "registered security info"
| extend UserPrincipalName = tostring(TargetResources[0].userPrincipalName),
         RegIP = tostring(InitiatedBy.user.ipAddress)
| join kind=inner suspicious on UserPrincipalName
| where TimeGenerated between (SuspiciousTime .. SuspiciousTime + 4h)
| project TimeGenerated, UserPrincipalName, OperationName, RegIP, SuspiciousIP, SuspiciousTime, ResultReason
```

Also check `AuditLogs` for `Consent to application` events in the same window. OAuth app consent is another persistence route that survives a password reset.

## Responding to a Confirmed Replay

Order matters here. Contain first, then eradicate. Resetting the password alone does not kill a stolen session.

```powershell
Connect-MgGraph -Scopes "User.ReadWrite.All","User.RevokeSessions.All","UserAuthenticationMethod.ReadWrite.All"

$upn = "victim@contoso.com"

# 1. Block sign-in so new tokens can't be minted
Update-MgUser -UserId $upn -AccountEnabled:$false

# 2. Invalidate refresh tokens and session cookies
Revoke-MgUserSignInSession -UserId $upn

# 3. Review authentication methods for anything the attacker added
Get-MgUserAuthenticationMethod -UserId $upn |
    Select-Object Id, @{n='Type'; e={ $_.AdditionalProperties.'@odata.type' }}
```

```powershell
Connect-ExchangeOnline

# 4. Hunt down and remove malicious inbox rules and forwarding
Get-InboxRule -Mailbox $upn |
    Select-Object Name, Enabled, MoveToFolder, DeleteMessage, ForwardTo, RedirectTo, Identity

Get-Mailbox -Identity $upn |
    Select-Object ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward

# Remove-InboxRule -Identity "<Identity from above>" -Confirm:$false
# Set-Mailbox -Identity $upn -ForwardingSmtpAddress $null -DeliverToMailboxAndForward $false
```

Then reset the password, remove any rogue MFA methods, review OAuth grants, re-enable the account, and require the user to re-register on a phishing-resistant method.

**Caveat:** revocation stops refresh tokens, but access tokens already issued can stay valid until they expire unless the client and resource support Continuous Access Evaluation (CAE). Disabling the account first and relying on CAE-capable workloads such as Exchange Online and SharePoint Online closes most of that gap. Don't assume revocation is instant everywhere.

Finally, scope the blast radius. Use the attacker IPs and ASNs from your hunt to search across **all** users. When one tenant is hit by a campaign like this, other accounts are often hit too.

## Locking It Down: Making Stolen Tokens Worthless

Detection buys you time. These Conditional Access controls are what actually reduce the risk.

### 1. Phishing-Resistant MFA Through Authentication Strengths

FIDO2 security keys, passkeys, Windows Hello for Business, and certificate-based authentication are bound to the origin or device. A passkey registered for `login.microsoftonline.com` will not produce a valid assertion for a lookalike proxy domain. This is the control that breaks AitM at the first step.

Start with admins and high-value users such as finance, executives, and anyone who can approve payments. Deploy in report-only mode via Graph:

```powershell
$policy = @{
    displayName = "CA010 - Require phishing-resistant MFA - Privileged and finance"
    state       = "enabledForReportingButNotEnforced"
    conditions  = @{
        users = @{
            includeGroups = @("<privileged-and-finance-group-id>")
            excludeGroups = @("<break-glass-group-id>")
        }
        applications   = @{ includeApplications = @("All") }
        clientAppTypes = @("all")
    }
    grantControls = @{
        operator               = "AND"
        builtInControls        = @()
        # Built-in "Phishing-resistant MFA" authentication strength
        authenticationStrength = @{ id = "00000000-0000-0000-0000-000000000004" }
    }
}

Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" `
    -Body ($policy | ConvertTo-Json -Depth 10)
```

Run it in report-only mode for at least a couple of weeks. Use the Conditional Access insights workbook to find users who would be blocked, enroll them, then switch `state` to `enabled`. Always exclude break-glass accounts, and protect them with FIDO2 keys kept in a safe.

### 2. Require a Compliant or Joined Device

An AitM proxy cannot present your device's identity. If a sign-in to Exchange Online requires a compliant (Intune) or hybrid-joined device, the proxy's sign-in fails even when the user completes MFA perfectly. For most enterprise workforces, "phishing-resistant MFA **or** compliant device" for Office 365 is a realistic baseline that removes most of this attack surface.

### 3. Token Protection for Sign-in Sessions

Token Protection binds sign-in session tokens to the device they were issued to, using the device's cryptographic key. A token exfiltrated from that device, or captured in a relay, will not be accepted when replayed from somewhere else.

You'll find it under **Conditional Access > Session > Require token protection for sign-in sessions**. Practical guidance:

- **Scope tightly.** Support covers specific client applications, resources, and device platforms. That list has changed over time, so confirm the current supported matrix in Microsoft's Token Protection documentation before building the policy. Unsupported clients are blocked, not silently allowed.
- **Target desktop and mobile clients**, and target the specific resources the docs list as supported, such as Exchange Online and SharePoint Online, instead of "All cloud apps."
- **Start in report-only mode.** Review the Conditional Access details on sign-in events to see which sessions would have failed, and why, before you enforce.
- **Pilot with a managed device cohort** first. Devices need to be registered or joined for binding to work.

Token Protection does not replace phishing-resistant MFA. It is defense in depth for stolen-token scenarios: infostealers lifting tokens from endpoints, and replays that get past your other controls.

### 4. Tighten the Session Itself

- **CAE with strict location enforcement.** If you have well-defined named locations, strict enforcement makes CAE-capable resources reject tokens used from an IP outside those locations.
- **Risk-based policies.** Require reauthentication with a phishing-resistant method, or block, when sign-in risk is medium or higher. This turns the Identity Protection detections from Hunt 2 into automatic containment.
- **Sign-in frequency** for unmanaged devices. Shorter session lifetimes limit how long a captured session stays useful.
- **Block legacy authentication** if you haven't yet. It's not the AitM vector, but it remains a common hole.

## Operationalizing It

Turn the hunts into scheduled analytics rules:

| Rule | Frequency | Severity | Auto-response |
|---|---|---|---|
| Session spans multiple countries or hosting ASNs | 1h | High | Revoke sessions, notify SOC |
| MFA sign-in from new hosting ASN, unmanaged device | 1h | Medium | Enrich, queue for triage |
| Suspicious inbox rule (hide, delete, forward) | 15m | High | Disable rule, notify user's manager |
| Security info registered after risky sign-in | 1h | High | Remove method pending review |

Wire the high-severity rules to a playbook (Logic App or your SOAR) that performs the containment steps above. When a stolen session is active, the attacker is reading mail in real time. Responding in minutes instead of the next business day makes a real difference.

## Key Takeaways

- **MFA completion is not proof of a legitimate user.** AitM relays turn a successful MFA prompt into a stolen, already-authenticated session.
- **Hunt on `SessionId`.** A single session appearing from multiple countries, ASNs, or hosting providers is one of the strongest replay signals available. Collect non-interactive sign-in logs.
- **The first sign-in is already the attacker.** In a relay, the "user's" interactive sign-in comes from proxy infrastructure, so baseline against each user's known networks.
- **Check the mailbox, not just the identity.** Inbox rules, forwarding, `MailItemsAccessed`, and new MFA methods show what the attacker did and how they plan to come back.
- **Contain in the right order:** disable, revoke, eradicate persistence, then reset and re-enroll.
- **Fix the root cause with binding.** Phishing-resistant MFA, compliant-device requirements, and Token Protection make stolen sessions useless. Deploy each in report-only mode, then enforce.

Campaigns like the one Huntress documented will keep working as long as a relayed push approval is enough to open a mailbox. Move your highest-risk users to phishing-resistant authentication first, keep the hunting rules running for everyone else, and expand coverage from there.

## Sources

- [Microsoft 365 Token-Replay Attacks Compromise 97 Accounts at 79 Organizations](https://thehackernews.com/2026/10/microsoft-365-token-replay-attacks.html) (2026-10-26)
