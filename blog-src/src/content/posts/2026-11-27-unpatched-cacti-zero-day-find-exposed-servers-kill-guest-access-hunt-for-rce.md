---
title: "Unpatched Cacti Zero-Day: Find Exposed Servers, Kill Guest Access, Hunt for RCE"
date: 2026-11-27
category: "thought-leadership"
tags: ["cacti", "vulnerability-management", "incident-response", "threat-hunting", "linux-hardening"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Cacti has a new zero-day, and there is no patch yet. Researchers have published details and a proof-of-concept for an exploit chain tracked as..."
---

Cacti has a new zero-day, and there is no patch yet.

Researchers have published details and a proof-of-concept for an exploit chain tracked as **4HTTP2SHELL** (with a companion named **4HTTP2ROOT**). The chain moves from a fresh, unauthenticated HTTP session to command execution on the Cacti server in four HTTP requests, using **guest access** as the entry point. At the time of writing, it has no CVE identifier.

Cacti tends to be deployed once and then left alone. It polls SNMP across the network and stores device credentials. It often runs on a box with broad reach into management VLANs. In many shops, nobody has logged into the admin console since whoever installed it left the company. That makes it a high-value pivot point that few people are watching.

This post covers what I'd do over the next 48 hours, in order:

1. Find every Cacti instance you own, especially internet-facing ones.
2. Remove the guest-access precondition.
3. Shrink the network exposure.
4. Hunt for signs that someone already ran the chain.

## What We Know and What We Don't

**Known:**
- The vulnerability affects Cacti, the open-source network monitoring tool.
- A public PoC exists.
- The path is unauthenticated HTTP session → guest access → command execution as the Cacti server.
- It takes four HTTP requests.
- No CVE has been assigned.

**Not known, or not confirmed here:**
- The exact affected version range. Check the Cacti project's security advisories and GitHub repository rather than assuming your version is safe.
- A fixed release or official workaround.
- The specific endpoints or parameters in the chain.
- What "4HTTP2ROOT" achieves in practice. The name suggests escalation to root, but read the researcher's write-up and the vendor advisory to see what conditions it needs.

I won't guess at the vulnerable code path. The defensive steps below are useful no matter which parameter turns out to be the culprit.

> **Rule of thumb:** If the exploit needs guest access, removing guest access is your highest-leverage control until a patch ships. Removing network exposure comes right after.

## Step 1: Find Every Cacti Instance You Own

You can't protect servers you don't know about. The CMDB will list the official Cacti box. It usually won't list the one a network engineer built in 2019 to graph the WAN links.

### Fingerprint over HTTP

Cacti's login page is easy to recognize. A quick sweep with `nmap` and the `http-title` script will turn up most of them:

```bash
# Sweep internal ranges for web servers and grab page titles
nmap -p 80,443,8080,8443 --open \
  --script http-title \
  -oG - 10.0.0.0/8 2>/dev/null \
  | grep -i cacti
```

Default installs usually live under `/cacti/`, so also probe that path directly. Here's a small Python script that works through an inventory file:

```python
#!/usr/bin/env python3
"""cacti_finder.py - fingerprint Cacti instances from a host list."""
import sys
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

PATHS = ["/", "/cacti/", "/cacti/index.php"]
SCHEMES = ["https", "http"]
MARKERS = ["Login to Cacti", "cactiLogin", "include/themes/", "Cacti"]

def check(host: str):
    for scheme in SCHEMES:
        for path in PATHS:
            url = f"{scheme}://{host}{path}"
            try:
                r = requests.get(url, timeout=5, verify=False, allow_redirects=True)
            except requests.RequestException:
                continue
            body = r.text
            hits = [m for m in MARKERS if m in body]
            if hits:
                return url, r.status_code, hits
    return None

if __name__ == "__main__":
    for line in open(sys.argv[1]):
        host = line.strip()
        if not host:
            continue
        result = check(host)
        if result:
            url, code, hits = result
            print(f"[CACTI] {url} status={code} markers={hits}")
```

```bash
python3 cacti_finder.py hosts.txt | tee cacti_inventory.txt
```

### Check from the outside, too

Run the same check from a host outside your perimeter, or use your attack-surface management tool's external scan data. Look for page titles and HTML containing "Cacti", on your own IP space only. Anything that answers from the internet goes to the top of the list.

### Check the filesystem on hosts you already manage

If you have config management or EDR with live query, search for the install directly:

```bash
# Common install locations; adjust for your distros
for d in /var/www/html/cacti /usr/share/cacti /opt/cacti /var/www/cacti; do
  [ -f "$d/include/cacti_version" ] && echo "$d: $(cat $d/include/cacti_version)"
done

# Broader search if layouts vary
find / -xdev -type f -name cacti_version -path '*/include/*' 2>/dev/null
```

Record the version for each instance. You'll compare it against the advisory when the affected range is published.

## Step 2: Remove the Guest-Access Precondition

Per the disclosure, the exploit enters through guest access. Cacti allows a designated "guest" account to be used for unauthenticated viewing, which is typically how public graph pages are offered. If no guest user is configured, that entry point should be closed.

### Check from the outside

A rough heuristic: request a graph page without a session. If you get graph content instead of a login form, guest access is probably on.

```bash
curl -sk "https://cacti.example.internal/cacti/graph_view.php" \
  | grep -qiE 'login_username|Login to Cacti' \
  && echo "Login required (guest likely disabled)" \
  || echo "No login form - INVESTIGATE: guest access may be enabled"
```

This is only a quick triage signal. Confirm with the steps below.

### Disable it in the UI

In the Cacti console:

1. **Console → Configuration → Settings → Authentication**
   - Set **Guest User** to **No User**.
   - While you're here, confirm **Authentication Method** is not set to *None*. If it is, guest access is the least of your problems.
2. **Console → Configuration → Users**
   - Find the `guest` account, or whichever account is assigned as guest, and **disable** it.
   - Review every enabled account. Disable anything unowned or stale.

### Verify in the database

The UI can be misleading in multi-node setups, so I like to check the database directly. Table and column names below match common Cacti 1.x schemas. Confirm them against your install with `DESCRIBE` before running any `UPDATE`.

```sql
-- Which account (if any) is configured as guest, and what's the auth method?
SELECT name, value
FROM settings
WHERE name IN ('guest_user', 'auth_method', 'user_template');

-- Inspect user accounts and whether they're enabled
SELECT id, username, enabled, realm, last_login
FROM user_auth
ORDER BY id;
```

How to read the results:
- `guest_user` may hold a username or user ID. An empty value or `0` generally means no guest user.
- An `auth_method` of `0` means no authentication. Fix that immediately.

To disable from the CLI, back up first:

```bash
mysqldump --single-transaction cacti settings user_auth > /root/cacti_auth_backup_$(date +%F).sql
```

```sql
-- Clear the guest user setting
UPDATE settings SET value = '0' WHERE name = 'guest_user';

-- Disable the default guest account
UPDATE user_auth SET enabled = '' WHERE username = 'guest';
```

Then reload the UI and repeat the `curl` check from above.

**Business impact note:** If a NOC wallboard or a vendor depends on anonymous graph access, this change will break it. That is acceptable. Give those consumers a named, read-only account behind authentication, and bring the wallboard back once a patched release is available.

## Step 3: Shrink the Network Exposure

Disabling guest access closes the entry point we know about. Restricting who can reach the web UI at all protects you against variants nobody has published yet.

### Apache

```apache
# /etc/apache2/conf-available/cacti.conf (path varies by distro)
<Directory /usr/share/cacti>
    <RequireAny>
        Require ip 10.20.30.0/24      # NOC / admin jump hosts
        Require ip 192.168.100.10     # monitoring bastion
    </RequireAny>
</Directory>
```

```bash
apachectl configtest && systemctl reload apache2
```

### Nginx

```nginx
location /cacti/ {
    allow 10.20.30.0/24;
    allow 192.168.100.10;
    deny  all;
    # existing php-fpm config follows
}
```

### Host firewall (nftables)

Enforce the restriction at the host firewall as well. A web server config change can be reverted later without anyone noticing.

```bash
nft add table inet cacti_guard
nft add chain inet cacti_guard input '{ type filter hook input priority 0; policy accept; }'
nft add rule inet cacti_guard input tcp dport '{ 80, 443 }' ip saddr '{ 10.20.30.0/24, 192.168.100.10 }' accept
nft add rule inet cacti_guard input tcp dport '{ 80, 443 }' drop
```

The poller doesn't need inbound HTTP. It makes outbound SNMP and script calls. Cutting off web access won't stop graphs from updating.

If an instance is internet-facing and has no business reason to be, take it off the internet today. If the business insists it must stay public, put it behind a VPN or an authenticating reverse proxy (SSO in front of the app) until a patch ships.

## Step 4: Hunt for Evidence of Exploitation

A public PoC plus four HTTP requests means opportunistic scanning will start quickly, if it hasn't already. Assume any instance that was exposed with guest access enabled needs a look.

### 4a. Web logs: unauthenticated sequences

The exact request pattern isn't confirmed, so hunt for behavior rather than a signature. Look for:

- Short bursts of requests from a single IP with no prior login.
- Unusually long query strings or encoded payloads.
- Requests to admin-ish pages from IPs that have never authenticated.

```bash
LOG=/var/log/apache2/access.log*

# Top source IPs hitting Cacti PHP endpoints
zgrep -h '/cacti/' $LOG | awk '{print $1}' | sort | uniq -c | sort -rn | head -25

# Requests with shell-ish or encoded content in the URI
zgrep -hiE '/cacti/.*(%60|%24%28|\$\(|;|%3B|\|\||%7C|base64|/bin/(ba)?sh|wget|curl|nc%20)' $LOG

# IPs that hit Cacti but never POSTed to the login page
zgrep -h '/cacti/' $LOG | awk '{print $1}' | sort -u > /tmp/all_ips
zgrep -h 'POST /cacti/index.php' $LOG | awk '{print $1}' | sort -u > /tmp/login_ips
comm -23 /tmp/all_ips /tmp/login_ips
```

The last command lists IPs that interacted with Cacti without ever submitting a login. On a box where guest access was enabled, every IP on that list is worth reviewing.

Also check `cacti.log`, usually under `<cacti>/log/`. Look for errors, unexpected user activity, or setting changes around the times of any suspicious requests:

```bash
grep -iE 'guest|setting|error|warning' /usr/share/cacti/log/cacti.log | tail -200
```

### 4b. Process lineage: the web server should not spawn shells

This is the most reliable signal for web RCE, regardless of how the chain works.

From EDR, or osquery if you run it:

```sql
-- osquery: shells or network tools whose parent is the web server / php-fpm
SELECT p.pid, p.name, p.cmdline, p.uid, pp.name AS parent, pp.cmdline AS parent_cmd
FROM processes p
JOIN processes pp ON p.parent = pp.pid
WHERE pp.name IN ('apache2', 'httpd', 'php-fpm', 'php-fpm8.1', 'php-fpm8.2', 'nginx')
  AND p.name IN ('sh', 'bash', 'dash', 'nc', 'ncat', 'curl', 'wget', 'python3', 'perl');
```

That only shows what is running now. For history, add auditd coverage going forward:

```bash
# /etc/audit/rules.d/cacti-rce.rules
# Log execve by the web server user (adjust uid: www-data=33 on Debian, apache=48 on RHEL)
-a always,exit -F arch=b64 -S execve -F uid=33 -k web_exec
-a always,exit -F arch=b32 -S execve -F uid=33 -k web_exec
```

```bash
augenrules --load
ausearch -k web_exec -i | grep -E 'exe=.*(sh|bash|nc|curl|wget|python|perl)'
```

Expect some noise. Cacti legitimately runs external binaries such as `rrdtool`, `snmpget`, and `php` for polling, so baseline those first. A `bash -c` with a reverse-shell one-liner should never show up.

### 4c. Filesystem: dropped webshells and modified files

```bash
CACTI=/usr/share/cacti   # adjust

# PHP files changed in the last 30 days under the web root
find "$CACTI" -name '*.php' -mtime -30 -printf '%TY-%Tm-%Td %TH:%TM %u %p\n' | sort

# Files owned by the web user in places they shouldn't be writable
find "$CACTI" -user www-data -type f -name '*.php' 2>/dev/null

# Classic webshell primitives
grep -rlE '(eval\s*\(\s*\$_(POST|GET|REQUEST)|assert\s*\(\s*\$_|system\s*\(\s*\$_|passthru|shell_exec\s*\(\s*\$_)' "$CACTI" 2>/dev/null
```

If you installed from a distro package, verify file integrity against the package database:

```bash
# Debian/Ubuntu
debsums -c cacti

# RHEL/Rocky/Alma
rpm -V cacti
```

Any modified PHP file that you can't trace to a known local customization should be treated as compromise until proven otherwise.

### 4d. Database: persistence through Cacti's own features

Cacti has a legitimate feature for running commands: Data Input Methods. It also stores paths to the external binaries it executes. An attacker with code execution, or with admin access gained through the chain, can hide persistence in these. Past Cacti vulnerabilities have abused this class of setting. That doesn't prove it's part of this chain, but it's worth checking.

```sql
-- Data input methods that run scripts/commands; look for anything unfamiliar
SELECT id, name, type_id, input_string
FROM data_input
ORDER BY id;

-- Paths to external binaries Cacti will execute
SELECT name, value
FROM settings
WHERE name LIKE 'path\_%';

-- Recently created or modified users
SELECT id, username, enabled, realm, last_login, password_change
FROM user_auth
ORDER BY id DESC;
```

Things to flag:
- `input_string` values containing `curl`, `wget`, `bash -c`, `/tmp/`, or base64 blobs.
- `path_*` settings (rrdtool, php binary, snmp utilities) pointing anywhere other than standard system paths.
- Admin accounts nobody recognizes.

Diff these against a known-good backup if you have one.

### 4e. Check who the poller runs as

This matters because of the "4HTTP2ROOT" name. The Cacti poller is typically launched from cron:

```bash
grep -rn 'poller.php' /etc/cron* /var/spool/cron 2>/dev/null
systemctl list-units --all | grep -i cacti
```

If `poller.php` runs as **root**, anything an attacker can get the poller to execute will run as root. Whatever 4HTTP2ROOT turns out to be, a root poller makes escalation much easier. Run it as a dedicated unprivileged user, or as the web server user, as the Cacti docs recommend:

```cron
# /etc/cron.d/cacti
*/5 * * * * www-data php /usr/share/cacti/poller.php > /dev/null 2>&1
```

Also check for outbound connections that don't match the polling pattern:

```bash
ss -tnp state established | grep -vE ':(161|162|3306|443|80)\b'
```

Cacti talks SNMP, the database, and maybe some HTTP. Persistent outbound sessions from the web user to random high ports should be investigated.

## Step 5: If You Find Something

Don't just restore and move on. Cacti servers often hold:

- SNMP community strings and SNMPv3 credentials for your network gear.
- Database credentials in `include/config.php`.
- Credentials for scripts that log into devices.
- Network paths into management segments.

If you confirm compromise:

1. **Isolate the host** at the network layer. Keep it powered on for forensics.
2. **Snapshot** the disk and capture memory if your IR process supports it.
3. **Rotate every credential Cacti stored or could reach**: SNMP communities, SNMPv3 users, DB passwords, any device credentials used by data input scripts.
4. **Review network gear** that Cacti polls for config changes, especially if write communities were ever configured.
5. **Rebuild** from a clean image instead of cleaning in place, then restore only the database after reviewing the tables from 4d.

## The 48-Hour Checklist

| Priority | Action | Done when |
|---|---|---|
| P0 | Inventory all Cacti instances (internal + external) | Every instance has an owner and a version recorded |
| P0 | Remove internet exposure | No Cacti UI reachable from the internet |
| P0 | Set Guest User to "No User" and disable guest account | `curl` check shows login form; DB confirms |
| P1 | Restrict UI to admin subnets (web server + host firewall) | Unauthorized source gets connection refused or 403 |
| P1 | Confirm the poller doesn't run as root | Cron/systemd shows unprivileged user |
| P1 | Hunt: logs, process lineage, filesystem, DB | Findings documented per instance |
| P2 | Add auditd/EDR rules for web-user exec | Alerts flowing to SIEM |
| P2 | Watch for the vendor advisory and patched release | Patch scheduled with change window |

## The Bigger Lesson

No patch for a monitoring tool means we fall back on fundamentals: know what you run, don't expose admin interfaces, don't leave anonymous access on by default, and don't run anything as root that doesn't need it. None of that is new, but a four-request exploit chain makes skipping it very costly.

Watch the Cacti project's advisories for a CVE, the confirmed affected versions, and a fixed release. Until then, take away the guest entry point, limit who can reach the UI, and assume opportunistic scanning has already started.

## Sources

- [Unpatched Cacti Zero-Day Enables RCE in Just Four HTTP Requests via Guest Access](https://thehackernews.com/2026/11/unpatched-cacti-zero-day-enables-rce-in.html) (2026-11-27)
