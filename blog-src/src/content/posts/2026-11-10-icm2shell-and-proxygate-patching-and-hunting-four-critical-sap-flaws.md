---
title: "ICM2SHELL and PROXYGATE: Patching and Hunting Four Critical SAP Flaws"
date: 2026-11-10
category: "thought-leadership"
tags: ["sap", "vulnerability-management", "threat-hunting", "patch-management", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "On SAP's November Security Patch Day (November 10, 2026), SAP fixed four vulnerabilities and rated every one of them CVSS 10.0. All four can be..."
---

On SAP's November Security Patch Day (November 10, 2026), SAP fixed four vulnerabilities and rated every one of them **CVSS 10.0**. All four can be exploited **without authentication**. Three are in the **SAP NetWeaver application server**. One is in the **SAP Web Dispatcher**, the component that often accepts HTTP traffic from the internet and passes it to NetWeaver. SAP and early reporting say **two of the four allow remote code execution**.

In this post I call the server-side attack path **ICM2SHELL** and the Web Dispatcher attack path **PROXYGATE**. These are working labels for the two halves of the problem, not official names. Use the SAP advisory for the mapping of CVEs to components.

When a perimeter component and the application server behind it both receive 10.0 ratings in the same month, treat it as an incident-response exercise, not a routine patch cycle. This post covers four steps: finding your exposed systems, building an accurate version inventory, patching in the right order, applying interim controls, and hunting for evidence that someone exploited the flaws before you patched.

## What We Know, and What You Need to Confirm

Here is what has been reported:

- Four flaws, all rated CVSS 10.0 by SAP.
- All four can be exploited without authentication.
- Three affect SAP NetWeaver AS. One affects SAP Web Dispatcher.
- Two can lead to remote code execution.

I am **not** going to list CVE IDs, SAP Note numbers, affected kernel or support package levels, or exploitation status. Several things are still unknown or unconfirmed, and you should look them up yourself:

- **The CVE IDs and SAP Security Note numbers.** Pull them from the November 2026 Patch Day page on the SAP Support Portal.
- **Affected releases and fixed patch levels.** Some fixes ship as kernel patches and some as ABAP or Java corrections. The Note tells you which.
- **Whether SAP has published a workaround** for teams that cannot patch immediately.
- **Whether exploitation in the wild has been confirmed.** Check the advisory, your threat intel feeds, and CISA KEV.

Everything else in this post assumes the worst case and works without those specifics.

## Why the Web Dispatcher and ICM Are the Crown Jewels of Exposure

Most SAP landscapes that serve web traffic look roughly like this:

```
Internet
   │
   ▼
[ Load balancer / WAF ]   (sometimes absent)
   │
   ▼
[ SAP Web Dispatcher ]  ← reverse proxy, often in a DMZ, TLS termination
   │
   ▼
[ ICM (icman) on NetWeaver AS ABAP / AS Java ]  ← HTTP engine of the app server
   │
   ▼
[ Work processes / J2EE server nodes ]  → database, RFC, everything
```

The **Web Dispatcher** usually sits at the edge, so a flaw there that needs no authentication can be reached from the internet by design.

The **Internet Communication Manager (ICM)** is the HTTP engine inside every NetWeaver instance. Even when a Web Dispatcher sits in front of it, the Dispatcher forwards requests to the ICM. A flaw in the request-handling path can therefore pass straight through the proxy.

The combination is what makes this month dangerous. If the PROXYGATE-class flaw weakens the front door and the ICM2SHELL-class flaw provides code execution, an attacker may only need to reach the edge.

## Step 1: Find Every Exposed System, Including the Ones Nobody Told You About

From years of SAP incident work, my rule is that your CMDB is wrong about SAP. Development and sandbox systems get published "temporarily." Fiori launchpads get opened to a partner. A Web Dispatcher in a forgotten DMZ keeps running an old kernel because nobody owns it. Start from the network and work inward.

### External view

Search your own address space in an internet-scanning service such as Shodan or Censys. Useful pivots are HTTP `Server` headers and page titles that SAP components commonly emit:

```
# Examples. Scope these to your own netblocks / org.
"SAP NetWeaver Application Server"
"SAP Web Dispatcher"
"SAP J2EE Engine"
http.title:"SAP NetWeaver"
```

Some teams suppress the `Server` header. On the Web Dispatcher and ICM this is controlled by `is/HTTP/show_server_header`. So an empty result from a header search does not mean you are clear. Combine header searches with port-based discovery.

### Active scan of your perimeter

Common SAP HTTP ports follow the instance number (`NN`):

| Component | Typical ports |
|---|---|
| ICM (ABAP) HTTP / HTTPS | `80NN`, `443NN` (e.g., 8000, 44300) |
| AS Java HTTP / HTTPS | `5NN00`, `5NN01` (e.g., 50000, 50001) |
| sapstartsrv (SAPControl) HTTP / HTTPS | `5NN13`, `5NN14` |
| Message server HTTP | `81NN` |
| Web Dispatcher | Anything, often 80/443 or 8xxx/44xxx |

A quick sweep from an external vantage point:

```bash
nmap -Pn -sV --open \
  -p 80,443,8000-8010,8100-8110,44300-44310,50000-50001,50013-50014,50100-50101,50113-50114 \
  --script http-headers,http-title \
  -oA sap_perimeter_$(date +%F) \
  -iL external_ranges.txt
```

> **Tip:** `sapstartsrv` (ports 5NN13 and 5NN14) should **never** be reachable from the internet. If it is, escalate that finding on its own, regardless of this month's CVEs.

### A fingerprinting script you can actually run

The following Python script probes each candidate host, records the `Server` header, and checks a few well-known public SAP paths. It does not exploit anything. It answers the question "is this SAP, and which component?"

```python
#!/usr/bin/env python3
"""sap_fingerprint.py - identify SAP NetWeaver / Web Dispatcher endpoints.
Usage: python3 sap_fingerprint.py targets.txt > results.csv
targets.txt: one base URL per line, e.g. https://10.1.2.3:44300
"""
import csv, sys, requests, urllib3
urllib3.disable_warnings()

PROBES = [
    "/",
    "/sap/public/info",          # ABAP: returns system info XML if SICF service is active
    "/sap/public/ping",
    "/sap/wdisp/admin/public/default.html",  # Web Dispatcher admin UI
    "/nwa",                       # AS Java NetWeaver Administrator
]

def classify(server, hits):
    s = (server or "").lower()
    if "web dispatcher" in s or hits.get("/sap/wdisp/admin/public/default.html") in (200, 401):
        return "WEB_DISPATCHER"
    if "as java" in s or "j2ee" in s or hits.get("/nwa") in (200, 302, 401):
        return "NW_JAVA"
    if "abap" in s or hits.get("/sap/public/info") == 200:
        return "NW_ABAP"
    if "sap" in s:
        return "SAP_UNKNOWN"
    return "NOT_SAP?"

w = csv.writer(sys.stdout)
w.writerow(["target", "server_header", "classification"] + PROBES)
for base in open(sys.argv[1]).read().split():
    hits, server = {}, ""
    for p in PROBES:
        try:
            r = requests.get(base.rstrip("/") + p, timeout=6, verify=False,
                             allow_redirects=False)
            hits[p] = r.status_code
            server = server or r.headers.get("Server", "")
        except requests.RequestException:
            hits[p] = "ERR"
    w.writerow([base, server, classify(server, hits)] + [hits[p] for p in PROBES])
```

If `/sap/public/info` returns `200` from the internet, that is a finding in itself. The response leaks the SID, kernel release, OS, and database details, which saves an attacker reconnaissance time. You should normally restrict it at the Web Dispatcher whatever happens with these CVEs.

## Step 2: Build an Accurate Version Inventory

Once SAP's Notes tell you which kernel patch levels and support packages are fixed, you need to know what you are actually running. Version strings on a wiki page are not enough.

### From the host

```bash
# As <sid>adm on the application server
disp+work -version | egrep -i "kernel release|patch number|compilation"

# On a Web Dispatcher host (standalone)
sapwebdisp -version | egrep -i "kernel release|patch number"

# Via sapcontrol (works locally; remotely may require OS credentials
# depending on service/protectedwebmethods)
sapcontrol -nr 00 -function GetVersionInfo
sapcontrol -nr 00 -function GetProcessList
```

### At scale

A minimal Ansible play gives you a fleet-wide snapshot:

```yaml
- name: Collect SAP kernel versions
  hosts: sap_all
  become: true
  tasks:
    - name: Find SAP instance profiles
      ansible.builtin.find:
        paths: /usr/sap
        patterns: "*_*_*"
        recurse: true
        file_type: file
        depth: 4
      register: profiles

    - name: Query version via sapcontrol for each instance number
      ansible.builtin.shell: |
        su - {{ sid | lower }}adm -c "sapcontrol -nr {{ item }} -function GetVersionInfo"
      loop: "{{ sap_instance_numbers }}"
      register: versions
      changed_when: false

    - name: Write results
      ansible.builtin.copy:
        content: "{{ versions.results | map(attribute='stdout') | join('\n---\n') }}"
        dest: "/tmp/sap_versions_{{ inventory_hostname }}.txt"
      delegate_to: localhost
      become: false
```

Join this output with the results from Step 1. The rows you care about most are **internet-reachable** and **below the fixed level**. That is your patch-first list.

Don't forget **embedded Web Dispatchers**. Newer releases can run a Web Dispatcher inside an ABAP instance. Some S/4HANA and Fiori front-end designs use one, and it is easy to miss because no separate `sapwebdisp` binary is running.

## Step 3: Patch in the Right Order

### Prioritization

1. **Internet-facing Web Dispatchers.** They are the most exposed, and kernel replacement on a standalone Web Dispatcher is usually quick.
2. **NetWeaver systems reachable through those Dispatchers**, or directly exposed. Production first, unless a dev or QA system is internet-facing. In that case the exposed system goes first.
3. **Internal-only systems**, on an accelerated but planned schedule.

### Web Dispatcher kernel replacement (standalone)

Every landscape differs, but the core sequence looks like this:

```bash
# As <sid>adm (or the Web Dispatcher OS user)
cd /usr/sap/<WDSID>/W<NN>/exe   # or your configured DIR_EXECUTABLE

# 1. Back up the current binaries
tar czf ~/wdisp_exe_backup_$(date +%F).tgz .

# 2. Stop the instance
sapcontrol -nr <NN> -function Stop
sapcontrol -nr <NN> -function WaitforStopped 300 5

# 3. Extract the new archive (downloaded from SAP Support Portal per the Note)
SAPCAR -xvf /stage/SAPWEBDISP_<patch>.SAR -R .

# 4. Start and verify
sapcontrol -nr <NN> -function Start
sapcontrol -nr <NN> -function WaitforStarted 300 5
./sapwebdisp -version | grep -i "patch number"
```

If you run a highly available Web Dispatcher pair, roll one node at a time and drain it at the load balancer first.

### NetWeaver

How you patch NetWeaver depends on what the Notes say:

- **Kernel fixes:** use the standard kernel update through SUM, or a manual `SAPCAR` replacement with the `sapcpe` distribution to all instances. Remember that every application server and the ASCS/SCS need a consistent kernel.
- **ABAP corrections:** implement them via SNOTE if the Note supports it, or apply the support package.
- **AS Java fixes:** deploy via SUM or the deployment tooling referenced in the Note.

### Verify that the fix actually took effect

Run the fingerprint script and the version collection again after patching. In my experience, about 10% of "patched" systems have a stale kernel on one app server, or a `sapcpe` copy that never ran. Trust the version output, not the change ticket.

## Step 4: Interim Controls While You Wait for a Window

Some SAP teams cannot patch production within days. If that applies to you, reduce exposure now. These controls lower risk; they do **not** replace the fix. If SAP publishes a specific workaround in the Note, apply that first.

### Get it off the internet

The most effective mitigation is to remove the unauthenticated network path entirely:

- Restrict Web Dispatcher and ICM listeners to known partner IPs or VPN ranges at the firewall.
- Put internet-facing Fiori or portal access behind an authenticating reverse proxy or zero-trust access broker. That way, unauthenticated traffic never reaches SAP code.

### Restrict paths at the Web Dispatcher

The Web Dispatcher's modification handler can block request paths before they are forwarded. Point it at a rules file:

```
# Web Dispatcher instance profile
icm/HTTP/mod_0 = PREFIX=/, FILE=$(DIR_INSTANCE)/data/edge_rules.txt
```

```
# edge_rules.txt - block internal/admin and info-leak paths at the edge.
# Verify syntax against SAP documentation for your release before deploying.
if %{PATH} regimatch ^/sap/public/info [OR]
if %{PATH} regimatch ^/sap/wdisp/admin [OR]
if %{PATH} regimatch ^/nwa [OR]
if %{PATH} regimatch ^/sap/bc/soap/rfc
RegForbiddenURL ^/(.*) -
```

A better design is an **allowlist**: forward only the paths your external users actually need, such as the Fiori launchpad, specific OData services, and the portal entry point, and deny everything else. Most organizations discover that the internet needs far fewer SAP paths than are currently exposed.

### Turn up the logging now

You can't hunt in logs you don't have. Enable HTTP access logging on both the Web Dispatcher and the ICM if it isn't already on:

```
icm/HTTP/logging_0 = PREFIX=/, LOGFILE=http_%y%m%d.log, MAXSIZEKB=100000, SWITCHTF=day, LOGFORMAT=%h %l %u %t "%r" %s %b %L "%{User-Agent}i" "%{X-Forwarded-For}i"
```

Ship these logs to your SIEM. Also keep the `dev_icm` and `dev_webdisp` trace files from **before** you patch, because they may contain the only record of earlier attempts.

## Step 5: Hunt for Unauthenticated RCE

Assume the bugs were exploitable before the Patch Day announcement. For internet-facing systems, hunt back at least as far as your log retention allows.

### 5a. Process lineage: SAP processes spawning shells

When code execution succeeds against an SAP server, the result usually shows up as an SAP process spawning something it shouldn't. Watch these parent process names: `icman`, `disp+work`, `jstart`, `sapwebdisp`, and `sapstartsrv`.

**Microsoft Defender for Endpoint (KQL):**

```kql
DeviceProcessEvents
| where Timestamp > ago(30d)
| where InitiatingProcessFileName in~ ("icman","disp+work","jstart","sapwebdisp","sapstartsrv",
                                       "icman.exe","disp+work.exe","jstart.exe","sapwebdisp.exe")
| where FileName in~ ("sh","bash","dash","ksh","python","python3","perl","curl","wget","nc","ncat",
                      "base64","cmd.exe","powershell.exe","pwsh.exe","certutil.exe","bitsadmin.exe")
| project Timestamp, DeviceName, AccountName, InitiatingProcessFileName,
          FileName, ProcessCommandLine
| order by Timestamp desc
```

**Linux auditd** gives you the same view on hosts without EDR. Log every `execve` by the `<sid>adm` user, then filter on parent process in your SIEM:

```
# /etc/audit/rules.d/sap-exec.rules
-a always,exit -F arch=b64 -S execve -F uid=<sidadm_uid> -k sap_exec
-a always,exit -F arch=b64 -S execve -F uid=<wdisp_uid>  -k sap_exec
```

```bash
ausearch -k sap_exec -i --start today | \
  awk '/^type=SYSCALL/ {ppid=$0} /^type=EXECVE/ {print ppid; print}' | \
  egrep -i "bash|sh -c|curl|wget|python|perl|nc "
```

**Baseline first.** SAP does legitimately run OS commands. External commands via SM49 and SM69 go through `sapxpg`, and some backup and monitoring scripts are launched from the stack as well. Collect two weeks of known-good children per system, then alert on anything new. A `curl` piped to `sh` from `icman` at 03:00 is never one of the legitimate cases.

### 5b. File system: new web-reachable artifacts

Web shells on SAP stacks tend to appear where the application server will serve or execute them.

```bash
SID=PRD

# AS Java: new JSP/class/JAR files in deployed app directories
find /usr/sap/$SID/J*/j2ee/cluster/apps -type f \
  \( -name "*.jsp" -o -name "*.jspx" -o -name "*.class" -o -name "*.jar" \) \
  -newermt "2026-10-01" -printf "%TY-%Tm-%Td %TT %u %p\n" | sort

# ICM static content / any instance dir: recently modified files owned by sidadm
find /usr/sap/$SID -xdev -type f -newermt "2026-10-01" \
  \( -name "*.jsp" -o -name "*.sh" -o -name "*.py" -o -name "*.so" -o -perm -u+x \) \
  -not -path "*/work/*.trc" -not -path "*/log/*" \
  -printf "%TY-%Tm-%Td %TT %u %p\n" | sort

# Web Dispatcher host: anything new outside exe/ and normal log output
find /usr/sap/<WDSID> -xdev -type f -newermt "2026-10-01" \
  -not -name "*.log" -not -name "dev_*" -printf "%TY-%Tm-%Td %TT %p\n"
```

Adjust the date to your exposure window. Compare the results against your change records. Each new executable or JSP that doesn't trace back to a transport or a deployment is a lead.

### 5c. HTTP logs: anomalous unauthenticated requests

You don't need the exploit signature to find likely exploitation attempts. Look for these patterns:

- **Unusual methods or paths** returning `200` with no authenticated user (`%u` is `-`) on paths that normally require login.
- **Long or encoded request lines**, header-smuggling indicators, and requests where the Web Dispatcher log and the backend ICM log disagree about the path. That disagreement is a classic sign of proxy and backend parsing differences.
- **Requests from IPs that were never seen before** hitting admin or service paths.
- **Response-size outliers** on endpoints that normally return small, fixed-size responses.

A simple Splunk starting point:

```spl
index=sap sourcetype=sap:icm:http user="-"
| eval path=mvindex(split(uri,"?"),0)
| stats count dc(src_ip) as uniq_src values(status) as statuses
        avg(bytes) as avg_bytes max(bytes) as max_bytes by path method
| where (method!="GET" AND method!="POST" AND method!="HEAD")
     OR len(path) > 200
     OR (max_bytes > avg_bytes*20 AND count > 1)
     OR match(path, "(?i)%2e%2e|%00|\\\\x|/\\.{2}/")
| sort - uniq_src
```

When the advisory or the security research community publishes indicators for these specific flaws, add exact-match detections. Keep the behavioral hunts running anyway.

### 5d. SAP-level indicators

Process and file artifacts aren't the only signal. Inside the application, look for:

- **New or modified users,** especially those with `SAP_ALL`/`SAP_NEW` or Java `Administrator` role assignments. Check the `USR02` creation dates and the change documents in SUIM.
- **Security Audit Log (SM20/RSAU)** entries for logons from unexpected terminals or IPs, and RFC calls from unknown sources.
- **New external commands** in SM69, and **new or modified background jobs** in SM37 that call OS commands.
- **Changes to SICF services,** for example a service activated that was previously off.

## Step 6: If You Find Something

1. **Isolate at the network layer first.** Pull the system from the Web Dispatcher pool or block it at the firewall. Avoid shutting down SAP before you have captured memory and volatile state if you can, because the work directory traces and the running processes are evidence.
2. **Preserve evidence:** `dev_*` traces, ICM and Web Dispatcher HTTP logs, the Security Audit Log, auditd/EDR telemetry, and a disk image or snapshot.
3. **Assume credential exposure.** A compromised SAP application server can typically reach the database credentials in the secure store, RFC destinations with stored passwords, and trust relationships with other systems. Rotate those credentials and review trusted RFC connections in SM59.
4. **Scope laterally.** Shared `/sapmnt` mounts, transport directories, and the `<sid>adm` SSH keys used across systems all provide easy paths between hosts.
5. **Rebuild rather than clean** when you confirm code execution on a host, then patch before you reconnect it.

## Takeaways

- **Treat this as an edge incident, not a patch ticket.** All four flaws are rated 10.0 and need no authentication. The component that receives internet traffic and the server behind it are both affected.
- **Discover from the network inward.** Fingerprint by header, path, and port, and assume the CMDB is missing some Web Dispatchers and sandboxes.
- **Verify versions on the host.** Use `disp+work -version`, `sapwebdisp -version`, or `sapcontrol GetVersionInfo`, and check again after patching.
- **Patch internet-facing Web Dispatchers first,** then the NetWeaver systems they front.
- **If you can't patch today, close the path.** Restrict listeners with IP allowlists, allowlist the paths the Web Dispatcher forwards, and block `/sap/public/info` at the edge permanently.
- **Hunt for child processes of SAP binaries.** Shells, downloaders, and interpreters spawned by `icman`, `disp+work`, `jstart`, or `sapwebdisp` are the highest-value signal you have.
- **Get CVE IDs, SAP Note numbers, fixed patch levels, and any workaround from the SAP advisory itself.** Don't rely on secondhand summaries, including this one.

SAP systems are where the money, the payroll, and the supply chain live. Your patch SLAs for ERP should be held to the same standard as for VPN appliances, because attackers already target both.

## Sources

- [SAP Patches Four CVSS 10.0 Flaws, Including Two Enabling Remote Code Execution](https://thehackernews.com/2026/11/sap-patches-four-cvss-100-flaws.html) (2026-11-10)
