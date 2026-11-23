---
title: "Azure API Management Classic Tier Flaw: Find Exposure, Rotate Secrets, Hunt"
date: 2026-11-23
category: "thought-leadership"
tags: ["azure", "api-security", "incident-response", "secrets-management", "threat-hunting"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Microsoft has warned customers that a vulnerability in Azure API Management (APIM) Classic tiers was exploited to steal stored API credentials...."
---

Microsoft has warned customers that a vulnerability in **Azure API Management (APIM) Classic tiers** was exploited to steal stored API credentials. Norwegian authorities have linked the flaw to cyberattacks against energy companies.

API gateways are usually built to protect secrets, not to expose them. When the gateway itself leaks, the attacker skips your perimeter and gets the keys to everything behind it.

This post covers what I'd do this week as a defender: find every Classic-tier APIM instance, inventory what it holds, rotate in the right order, and hunt for signs that stolen credentials have already been used.

## What We Know and What We Don't

**What's been reported:**
- The vulnerability affects APIM **Classic tiers**.
- It was **actively exploited** to steal **stored API credentials**.
- Norwegian authorities tied it to attacks on **energy-sector companies**.

**What you need to confirm in Microsoft's advisory before acting on assumptions:**
- The CVE identifier, if one has been assigned, and its severity rating.
- Exactly which SKUs count as "Classic" for this issue. In Azure terminology, Classic usually means Developer, Basic, Standard, and Premium, as opposed to the v2 tiers. Check whether Consumption is in scope.
- Which credential types were exposed: named values, subscription keys, backend credentials, certificates, or credential manager tokens.
- Whether Microsoft has patched the platform side and whether customers need to take any action beyond rotation.
- The exploitation window, which determines how far back you need to hunt.

I'm not going to guess at any of those. The response plan below works no matter how those details shake out, because it assumes the worst: **anything stored in an affected APIM instance should be treated as compromised.**

## Why APIM Is Such a Valuable Target

Think about what a typical enterprise APIM instance holds:

| Asset | Where It Lives | Blast Radius If Stolen |
|---|---|---|
| Backend API keys and tokens | Named values (secret), backend credentials | Direct access to backend systems, bypassing the gateway |
| Subscription keys | APIM subscriptions | Impersonation of legitimate API consumers |
| Client certificates | Certificates store | mTLS impersonation to backends |
| OAuth refresh tokens | Credential manager (authorizations) | Access to SaaS such as Graph, Salesforce, or GitHub on behalf of users or apps |
| Hardcoded secrets | Policy XML | Whatever the developer pasted in at 4:55 PM on a Friday |

In energy and other critical infrastructure, APIM often fronts integrations between IT systems and operational data: metering, SCADA historians, and market and trading platforms. A stolen backend credential could let an attacker reach those systems directly, without passing through the gateway.

## Step 1: Find Every Classic-Tier APIM Instance

Start with Azure Resource Graph. It gives you a tenant-wide view in seconds and doesn't depend on someone remembering which subscription the integrations team used in 2019.

```kusto
resources
| where type =~ 'microsoft.apimanagement/service'
| extend skuName = tostring(sku.name),
         capacity = toint(sku.capacity),
         vnetType = tostring(properties.virtualNetworkType),
         publicAccess = tostring(properties.publicNetworkAccess),
         platformVersion = tostring(properties.platformVersion),
         gatewayUrl = tostring(properties.gatewayUrl)
| extend tierFamily = iff(skuName endswith 'V2', 'v2', 'classic')
| project subscriptionId, resourceGroup, name, location, skuName,
          tierFamily, capacity, vnetType, publicAccess, platformVersion, gatewayUrl
| order by tierFamily asc, skuName asc
```

Run it from the CLI so you can feed the output into later steps:

```bash
az graph query -q "
resources
| where type =~ 'microsoft.apimanagement/service'
| extend skuName = tostring(sku.name)
| where skuName !endswith 'V2'
| project subscriptionId, resourceGroup, name, skuName,
          vnetType = tostring(properties.virtualNetworkType)
" --first 1000 -o json > apim_classic.json

jq -r '.data[] | [.subscriptionId, .resourceGroup, .name, .skuName, .vnetType] | @tsv' apim_classic.json
```

A few notes:

- **Don't filter on VNet type to rule instances out.** Internal-mode deployments still store secrets. Until the advisory says otherwise, network isolation is a factor that might reduce risk, not a reason to exclude an instance.
- **Check every tenant you operate in**, including acquisitions, partner-managed tenants, and lab tenants. Resource Graph only sees what your identity can see.
- If the advisory narrows scope to specific SKUs, update the `where` clause. If it doesn't, keep the broad filter.

## Step 2: Inventory What Each Instance Is Holding

You can't rotate what you haven't found. For each instance, enumerate every credential-bearing object. I use `az rest` against the ARM API because it covers object types that the `az apim` command group doesn't.

```bash
#!/usr/bin/env bash
# apim-secret-inventory.sh <subscriptionId> <resourceGroup> <apimName>
set -euo pipefail
SUB="$1"; RG="$2"; APIM="$3"
API="2022-08-01"
BASE="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.ApiManagement/service/$APIM"

echo "== Secret named values (stored in APIM vs. Key Vault reference) =="
az rest --method get --url "$BASE/namedValues?api-version=$API" \
  --query "value[?properties.secret].{name:name, keyVault:properties.keyVault.secretIdentifier}" -o table

echo "== Subscriptions =="
az rest --method get --url "$BASE/subscriptions?api-version=$API" \
  --query "value[].{id:name, scope:properties.scope, state:properties.state, owner:properties.ownerId}" -o table

echo "== Backends with credentials =="
az rest --method get --url "$BASE/backends?api-version=$API" \
  --query "value[?properties.credentials].{name:name, url:properties.url, hasHeader:properties.credentials.header!=null, hasQuery:properties.credentials.query!=null, hasCertIds:properties.credentials.certificateIds!=null}" -o table

echo "== Certificates =="
az rest --method get --url "$BASE/certificates?api-version=$API" \
  --query "value[].{name:name, subject:properties.subject, expires:properties.expirationDate, keyVault:properties.keyVault.secretIdentifier}" -o table

echo "== Credential manager / authorization providers =="
az rest --method get --url "$BASE/authorizationProviders?api-version=$API" \
  --query "value[].{name:name, idp:properties.identityProvider}" -o table 2>/dev/null || echo "(none or not supported)"
```

The key distinction is in the named values output. If `keyVault` is null on a secret named value, **the secret value lives inside APIM**. That's your highest-priority rotation list. Key Vault references are better, but don't assume they're safe. If APIM's managed identity could read the secret, so could anything that compromised APIM's runtime context. Confirm the exposure model in the advisory.

### Don't Forget Secrets Hiding in Policies

This step is the one teams skip. Developers inline tokens in `set-header` policies all the time. Export every policy and grep it:

```bash
# Global policy
az rest --method get \
  --url "$BASE/policies/policy?api-version=$API&format=rawxml" \
  --query "properties.value" -o tsv > policy_global.xml

# Per-API policies
for api in $(az rest --method get --url "$BASE/apis?api-version=$API" --query "value[].name" -o tsv); do
  az rest --method get \
    --url "$BASE/apis/$api/policies/policy?api-version=$API&format=rawxml" \
    --query "properties.value" -o tsv > "policy_api_${api}.xml" 2>/dev/null || true
done

# Look for likely inline secrets (tune for your environment)
grep -EnHi '(authorization|x-api-key|api[-_]?key|bearer|password|secret|token)' policy_*.xml \
  | grep -v '{{' # filter out named-value references like {{backend-key}}
```

Anything that matches and isn't a `{{named-value}}` reference is a hardcoded secret. It goes on the rotation list, and it gets moved into Key Vault as part of remediation.

Product-level and operation-level policies can also contain secrets. If you use APIOps or another extractor, run it now and grep the whole output tree.

## Step 3: Rotate in the Right Order

This is where I see well-intentioned teams get it wrong. **Rotating a value inside APIM does nothing to the credential the attacker already holds.** If someone stole your backend API key, it's still valid at the backend until you revoke it *at the backend*.

Here's the order I use:

1. **Issue a new credential at the source system.** That might be the backend API, the SaaS provider, Entra ID app registration, or your internal CA.
2. **Store it in Key Vault**, not as a plain APIM secret.
3. **Point APIM at the Key Vault reference.**
4. **Verify traffic flows** by checking backend response codes in gateway logs.
5. **Revoke the old credential at the source.** Don't skip this step. Most of the risk reduction happens here.

### Moving a Named Value to a Key Vault Reference

```bash
# 1. New secret already issued by the backend owner; store it in Key Vault
az keyvault secret set --vault-name kv-apim-prod --name backend-billing-key --value "$NEW_KEY"

# 2. Ensure APIM's managed identity can read it (RBAC model)
APIM_MI=$(az apim show -g "$RG" -n "$APIM" --query identity.principalId -o tsv)
KV_ID=$(az keyvault show -n kv-apim-prod --query id -o tsv)
az role assignment create --assignee-object-id "$APIM_MI" \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID"

# 3. Repoint the named value
az rest --method put \
  --url "$BASE/namedValues/backend-billing-key?api-version=$API" \
  --body '{
    "properties": {
      "displayName": "backend-billing-key",
      "secret": true,
      "keyVault": {
        "secretIdentifier": "https://kv-apim-prod.vault.azure.net/secrets/backend-billing-key"
      }
    }
  }'
```

Leaving the version off the `secretIdentifier` lets APIM pick up future rotations automatically. That's what you want long-term.

### Regenerating Subscription Keys

Subscription keys authenticate consumers *to* APIM. If they were stolen, attackers can call your APIs as a legitimate client. The normal zero-downtime approach is to regenerate the secondary key, move consumers over, then regenerate the primary.

During an active compromise, you may not have time for that. Regenerate both keys and accept the coordination pain:

```bash
for sid in $(az rest --method get --url "$BASE/subscriptions?api-version=$API" \
               --query "value[?properties.state=='active'].name" -o tsv); do
  echo "Regenerating keys for subscription: $sid"
  az rest --method post --url "$BASE/subscriptions/$sid/regeneratePrimaryKey?api-version=$API"
  az rest --method post --url "$BASE/subscriptions/$sid/regenerateSecondaryKey?api-version=$API"
done
```

**Don't run that loop blindly in production.** Build the consumer contact list from the `ownerId` field first, and make the call jointly with application owners. The built-in "all-access" subscription deserves special attention: if it exists and is active, regenerate it and consider disabling it.

### Other Items on the List

- **Certificates:** Reissue client certificates from your CA, upload new ones (preferably via Key Vault), and **revoke the old ones** so backends doing mTLS reject them.
- **Credential manager connections:** Revoke the refresh tokens or grants at the identity provider, then re-consent. Deleting the connection in APIM is not enough.
- **Entra ID app secrets used by APIM policies** (for example, `send-request` to a token endpoint): Create a new client secret, update it, and delete the old one. Better yet, switch to `authentication-managed-identity` and eliminate the secret entirely.
- **Tenant-level access keys** (legacy direct management API and Git configuration access): If these are enabled on an instance, regenerate them. Disable them if nobody uses them.

## Step 4: Hunt

Two questions matter here: *Was the secret taken?* and *Has it been used?* The second one matters more, and you can usually answer it with better confidence.

Keep your hunt window wide. Until the advisory gives you a clear exploitation timeline, look back as far as your log retention allows.

### Control Plane: Who Read Secrets Through ARM?

```kusto
AzureActivity
| where TimeGenerated > ago(90d)
| where ResourceProviderValue =~ "MICROSOFT.APIMANAGEMENT"
| where OperationNameValue has_any (
    "namedValues/listValue/action",
    "subscriptions/listSecrets/action",
    "tenant/listSecrets/action",
    "regeneratePrimaryKey", "regenerateSecondaryKey")
| summarize events = count(),
            firstSeen = min(TimeGenerated),
            lastSeen  = max(TimeGenerated),
            ips = make_set(CallerIpAddress, 20)
  by Caller, OperationNameValue, _ResourceId
| order by firstSeen asc
```

This query has an important limit. **If the exploitation path didn't go through Azure Resource Manager, it won't show up here.** A clean result from this query doesn't mean you're clean. It means this particular door looks unused. Also, the Activity Log only keeps 90 days unless you export it, which is one more reason to send it to a Log Analytics workspace by default.

### Data Plane: New Callers Using Existing Subscription Keys

If you've enabled diagnostic settings in resource-specific mode, look for subscription keys suddenly being used from source IPs they've never used before:

```kusto
let baseline = ApiManagementGatewayLogs
    | where TimeGenerated between (ago(90d) .. ago(30d))
    | where isnotempty(ApimSubscriptionId)
    | distinct ApimSubscriptionId, CallerIpAddress;
ApiManagementGatewayLogs
| where TimeGenerated > ago(30d)
| where isnotempty(ApimSubscriptionId)
| summarize calls = count(),
            firstSeen = min(TimeGenerated),
            apis = make_set(ApiId, 20),
            statusCodes = make_set(ResponseCode, 10)
  by ApimSubscriptionId, CallerIpAddress
| join kind=leftanti baseline on ApimSubscriptionId, CallerIpAddress
| order by calls desc
```

If you're still on the legacy `AzureDiagnostics` table, the same logic applies, but the column names differ (`callerIpAddress_s`, `apimSubscriptionId_s`, and so on).

### Backends: The Most Important Hunt

Stolen backend credentials won't touch your gateway at all. The attacker goes straight to the backend. You have to hunt **where the credentials work**, not where they were stored.

For backends that authenticate with Entra ID service principals:

```kusto
let apimBackendApps = dynamic(["<appId-1>", "<appId-2>"]); // from your Step 2 inventory
AADServicePrincipalSignInLogs
| where TimeGenerated > ago(90d)
| where AppId in (apimBackendApps)
| summarize signIns = count(),
            firstSeen = min(TimeGenerated),
            resources = make_set(ResourceDisplayName, 10)
  by AppId, ServicePrincipalName, IPAddress, Location
| order by firstSeen desc
```

Legitimate sign-ins from APIM come from your APIM instance's egress IPs. Get them from `az apim show --query publicIpAddresses`, or from your NAT or firewall if you're VNet-integrated. **Anything else is a lead.**

For non-Entra backends (vendor APIs, on-prem services, OT data platforms), pull their access logs and apply the same rule: requests that use the APIM-held credential but don't come from APIM's egress IPs should be treated as an incident until proven otherwise. If a backend doesn't log the source IP for authenticated requests, write that down as a finding.

## Step 5: Harden So the Next One Hurts Less

Once you've finished rotating, use the momentum to fix the underlying design:

1. **Eliminate stored secrets where possible.** Use `authentication-managed-identity` for Azure and Entra-protected backends. A credential that doesn't exist can't be stolen.
2. **Key Vault references for everything else**, with unversioned identifiers and a rotation schedule owned by the backend team.
3. **Lock backends to APIM's egress.** IP allowlists, private endpoints, or mTLS limit the value of a stolen credential to someone who can't originate traffic from your gateway. This is probably the single most effective compensating control against this whole class of attack.
4. **Evaluate migrating to v2 tiers**, but make it a deliberate architecture decision, not a panic move. Check feature parity for your workloads first.
5. **Enforce policy hygiene in CI.** Add a pipeline check (APIOps plus a grep or Semgrep rule) that fails the build when a policy contains a literal credential.
6. **Log retention by default.** Send Activity Log and APIM gateway logs to a workspace with at least a year of retention. During an incident is the worst time to discover you have 30 days of data.

## The Checklist

- [ ] Read Microsoft's advisory; confirm affected SKUs, credential types, and timeline
- [ ] Run the Resource Graph query across every tenant
- [ ] Inventory named values, subscriptions, backends, certificates, credential manager connections, and policy XML for each instance
- [ ] Rotate **at the source**, store in Key Vault, repoint APIM, verify, **revoke the old credential**
- [ ] Hunt the control plane, the gateway, and, most importantly, each backend
- [ ] Restrict backends to APIM egress and replace secrets with managed identity
- [ ] Extend log retention and add policy secret scanning to CI

The organizations that come out of this well won't be the ones that rotated fastest inside the Azure portal. They'll be the ones that knew where every credential worked, revoked it there, and checked whether anyone else had already used it.

## Sources

- [Microsoft Azure flaw exploited to steal customers' API credentials](https://www.bleepingcomputer.com/news/security/microsoft-azure-flaw-exploited-to-steal-customers-api-credentials/) (2026-11-23)
