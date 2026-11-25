---
title: "Drupal Fail2Install Is Under Active Attack: Find, Patch, and Hunt for Compromise"
date: 2026-11-25
category: "thought-leadership"
tags: ["drupal", "vulnerability-management", "incident-response", "patching", "web-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Some vulnerabilities let you schedule the fix for next sprint. This is not one of them. This week, CISA added CVE-2026-132165, a Drupal core flaw..."
---

Some vulnerabilities let you schedule the fix for next sprint. This is not one of them.

This week, CISA added **CVE-2026-132165**, a Drupal core flaw nicknamed **"Fail2Install"**, to its Known Exploited Vulnerabilities (KEV) catalog. The flaw is a remote code execution (RCE) bug with a **CVSS score of 9.8**. Federal civilian agencies must remediate by **November 27, 2026**, which gives them a window measured in days.

Three facts set the urgency:

1. **It's in core.** You can't rule yourself out by saying "we don't use that contrib module."
2. **It's being exploited in the wild.** KEV listing means CISA has evidence of real attacks.
3. **Exploit details are now public.** Reporting indicates technical details are circulating. In my experience, mass scanning follows public details within hours to a few days.

Even if you're not a federal agency, use the federal deadline as your own. Below is the playbook I'd hand my team today: find every Drupal instance, patch it correctly, and then assume you may already be compromised and go look.

> **A note on what we don't know yet.** As of this writing, I'm not going to guess at affected version ranges, fixed release numbers, or the exact exploitation path. The name "Fail2Install" hints at something related to Drupal's installation flow, but treat that as a hint, not a fact. **Read the official Drupal security advisory for CVE-2026-132165** to confirm affected branches, fixed versions, and any vendor-recommended mitigations. Everything below works no matter what those details turn out to be.

---

## Step 1: Find Every Drupal Site You Own (Including the Ones You Forgot)

The site that hurts you is never the flagship marketing site with a dedicated team. It's the 2019 microsite for a conference, the staging box someone exposed for a demo, or the departmental site a contractor built and handed off.

### External discovery: fingerprint from the outside

Drupal is fairly chatty over HTTP. Many installs emit an `X-Generator` header, Drupal-specific cache headers, or a `generator` meta tag. Start with your known domain list and subdomain inventory:

```bash
#!/usr/bin/env bash
# drupal-fingerprint.sh — quick external Drupal detection
# Usage: ./drupal-fingerprint.sh hosts.txt

while read -r host; do
  [[ -z "$host" ]] && continue
  url="https://${host}"

  headers=$(curl -sk -m 10 -D - -o /tmp/body.$$ "$url" 2>/dev/null)
  body=$(head -c 200000 /tmp/body.$$ 2>/dev/null)

  signals=()
  grep -qi '^x-generator: drupal' <<<"$headers" && signals+=("x-generator")
  grep -qi '^x-drupal-cache\|^x-drupal-dynamic-cache' <<<"$headers" && signals+=("drupal-cache-hdr")
  grep -qi 'name="Generator" content="Drupal' <<<"$body" && signals+=("meta-generator")
  grep -qi '/sites/default/files/\|/core/misc/drupal' <<<"$body" && signals+=("asset-paths")

  if (( ${#signals[@]} > 0 )); then
    gen=$(grep -i '^x-generator:' <<<"$headers" | tr -d '\r')
    echo "[DRUPAL] $host  signals=${signals[*]}  ${gen}"
  fi
done < "$1"

rm -f /tmp/body.$$
```

If you already run `httpx` from ProjectDiscovery, you can scale this across thousands of hosts:

```bash
cat subdomains.txt | httpx -silent -td -title -server -mc 200,301,302,403 \
  | grep -i drupal | tee drupal-external.txt
```

**Don't trust the absence of signals.** Hardened sites often strip `X-Generator`. Treat external fingerprinting as a floor, not a ceiling.

### Internal discovery: ask the filesystem

On hosts you control, the filesystem is the authoritative answer. Modern Drupal (8+) is Composer-managed, so `composer.lock` tells you exactly what core version is deployed:

```bash
# Find every Drupal codebase on a host and report the core version
sudo find / -xdev -name composer.lock -path '*' 2>/dev/null | while read -r lock; do
  ver=$(jq -r '.packages[]? | select(.name=="drupal/core") | .version' "$lock" 2>/dev/null)
  [[ -n "$ver" ]] && echo "$(dirname "$lock")  drupal/core=$ver"
done
```

If Drush is available, it's even simpler:

```bash
cd /var/www/example-site
vendor/bin/drush status --field=drupal-version
```

For fleets, push this through whatever you already use, such as Ansible, SSM Run Command, or Salt. Here's a minimal Ansible task:

```yaml
- name: Inventory Drupal core versions
  hosts: webservers
  become: true
  tasks:
    - name: Locate composer.lock files
      ansible.builtin.find:
        paths: ["/var/www", "/srv", "/opt"]
        patterns: "composer.lock"
        recurse: true
        depth: 4
      register: locks

    - name: Extract drupal/core version
      ansible.builtin.shell: >
        jq -r '.packages[]? | select(.name=="drupal/core") | .version' {{ item.path }}
      loop: "{{ locks.files }}"
      register: core_versions
      changed_when: false

    - name: Report
      ansible.builtin.debug:
        msg: "{{ item.item.path }} => {{ item.stdout }}"
      loop: "{{ core_versions.results }}"
      when: item.stdout | length > 0
```

**Don't forget:**
- **Containers.** Scan images in your registry, not just running hosts. A patched host running an unpatched image is still unpatched.
- **Legacy Drupal 7.** D7 isn't Composer-managed in the same way. Check `includes/bootstrap.inc` for the `VERSION` constant. Confirm in the advisory whether D7 is in scope.
- **Managed hosting** (Acquia, Pantheon, Platform.sh, etc.). Check your provider's status page and advisories. Then verify whether you or the provider own the core update for your plan.

The output of this step should be a spreadsheet with four columns: **site, owner, core version, internet-exposed (Y/N)**. Sort by exposed-first.

---

## Step 2: Patch Core the Right Way

Once you've confirmed the fixed versions from the advisory, the update itself is straightforward for Composer-managed sites. Do it in a branch, deploy through your normal pipeline, and don't hand-edit files on production.

```bash
cd /var/www/example-site

# 1. Snapshot first: database and codebase
vendor/bin/drush sql:dump --gzip --result-file=../backups/pre-cve-2026-132165-$(date +%F).sql
tar czf ../backups/code-$(date +%F).tgz --exclude=sites/default/files .

# 2. Update core and its pinned dependencies together
composer update "drupal/core-*" --with-all-dependencies

# 3. Confirm the version you landed on matches the advisory's fixed release
composer show drupal/core | grep -E '^versions'

# 4. Apply any database updates and rebuild caches
vendor/bin/drush updatedb -y
vendor/bin/drush cache:rebuild

# 5. Verify
vendor/bin/drush status --field=drupal-version
vendor/bin/drush core:requirements --severity=2
```

A few things I've seen go wrong during emergency Drupal patching:

- **Updating `drupal/core` but not `drupal/core-recommended`.** If your project uses `core-recommended`, which most do, update the whole `drupal/core-*` family together. Otherwise Composer will fight you or silently hold you back.
- **Version constraints that block the fix.** A constraint like `drupal/core-recommended: 10.2.x` won't pull a fix released on a different minor branch. Check `composer.json` if the update doesn't move.
- **Patching code but skipping `updatedb`.** Security releases don't always include schema updates, but run it anyway. It's cheap insurance.
- **Patching staging and forgetting prod**, or the reverse. Re-run your inventory script after deployment to confirm.

### If you can't patch in the next few hours

Sometimes there's a frozen release, a vendor-controlled codebase, or a site nobody knows how to build. In that case, reduce exposure while you work the problem. These are **compensating controls, not fixes**:

1. **Pull it off the internet.** Put the site behind VPN or IP allowlisting, or take it down. A maintenance page beats a webshell.
2. **Deploy WAF rules.** Check whether your WAF vendor has published a rule for CVE-2026-132165 and enable it in blocking mode.
3. **Lock down installer and update entry points.** This is good hygiene on any production Drupal site, and it may be relevant here given the vulnerability's name. Confirm in the advisory whether it actually mitigates this flaw. A production site should never serve its installer:

```nginx
# nginx — deny Drupal installer/update scripts on production
location ~* ^/core/(install|rebuild|authorize)\.php$ {
    deny all;
    return 404;
}
location = /update.php {
    allow 10.0.0.0/8;   # admin network only
    deny all;
}
```

```apache
# Apache — equivalent in vhost or .htaccess
<FilesMatch "^(install|rebuild|authorize)\.php$">
    Require all denied
</FilesMatch>
```

4. **Make the codebase read-only to the web server user.** Only `sites/default/files` (and your private files path) should be writable by PHP-FPM or Apache. If an attacker gets code execution, read-only code directories make persistence harder.

```bash
# Example: code owned by deploy user, web server can only read
chown -R deploy:www-data /var/www/example-site
find /var/www/example-site -type d -exec chmod 750 {} \;
find /var/www/example-site -type f -exec chmod 640 {} \;
# Writable exceptions
chown -R www-data:www-data /var/www/example-site/web/sites/default/files
chmod 444 /var/www/example-site/web/sites/default/settings.php
```

---

## Step 3: Assume Breach and Go Hunting

Patching closes the door. It doesn't evict anyone who already walked through it. With active exploitation confirmed, **every internet-exposed, previously vulnerable Drupal site should get a compromise assessment**. Prioritize by how long the site was exposed after exploitation began.

Here's where I'd look, roughly in order of signal quality.

### 3a. Web server logs: find the attempts

Until the advisory or threat intel gives you precise indicators, look for anomalies around installer, update, and other bootstrap endpoints. Also look for POST requests to places that rarely receive them:

```bash
# Requests to installer/update scripts — should be ~zero on a healthy prod site
zgrep -hE '"(GET|POST) /(core/)?(install|update|rebuild|authorize)\.php' \
  /var/log/nginx/access.log* | awk '{print $1, $4, $6, $7, $9}' | sort | uniq -c | sort -rn | head -50

# POSTs that returned 200, grouped by path — look for the unexpected
zgrep -h '"POST ' /var/log/nginx/access.log* \
  | awk '$9 == 200 {print $7}' | cut -d'?' -f1 | sort | uniq -c | sort -rn | head -40

# Direct requests to PHP files under the public files directory (classic webshell access)
zgrep -hE '/sites/[^/]+/files/.*\.(php|phtml|phar|php[0-9])' /var/log/nginx/access.log*
```

Pull the source IPs from anything suspicious and pivot. Check what else those IPs hit, and when.

### 3b. Filesystem: find what was dropped

RCE on a PHP application almost always ends with a PHP file somewhere it shouldn't be. Start with the obvious places:

```bash
SITE=/var/www/example-site/web

# Any executable PHP in the public files dir is a red flag
find "$SITE/sites" -path '*/files/*' -type f \
  \( -iname '*.php*' -o -iname '*.phtml' -o -iname '*.phar' \) -ls

# Files modified recently anywhere in the docroot (adjust window to your exposure period)
find "$SITE" -type f -newermt "2026-11-01" ! -path '*/files/styles/*' -ls | sort -k8,10

# .htaccess tampering — Drupal ships a files/.htaccess that blocks PHP execution
find "$SITE" -name '.htaccess' -newermt "2026-11-01" -ls
cat "$SITE/sites/default/files/.htaccess"

# Common webshell primitives (expect some false positives in vendor/, review hits manually)
grep -rlE --include='*.php' \
  'eval\s*\(\s*(base64_decode|gzinflate|str_rot13|\$_(POST|GET|REQUEST|COOKIE))|assert\s*\(\s*\$_|preg_replace\s*\(.*/e' \
  "$SITE" 2>/dev/null | grep -v '/vendor/'
```

**The strongest check is a diff against known-good code.** If your site is in Git, this is a one-liner on the production host:

```bash
cd /var/www/example-site
git status --porcelain --ignored | grep -v 'sites/default/files'
git diff --stat
```

If the deployed tree isn't a Git checkout, build a pristine copy of the same release from your repo or via `composer install` in a clean directory. Then diff the two:

```bash
diff -rq --exclude='files' --exclude='settings*.php' \
  /tmp/pristine/web /var/www/example-site/web
```

Any core or vendor file that differs from pristine is guilty until proven innocent.

### 3c. Database: find the persistence

Attackers who get RCE on Drupal often add a quiet admin account or alter config so they can come back through the front door after you patch. On Drupal 8+:

```sql
-- Users created or logging in recently
SELECT uid, name, mail, status,
       FROM_UNIXTIME(created) AS created,
       FROM_UNIXTIME(access)  AS last_access,
       FROM_UNIXTIME(login)   AS last_login
FROM users_field_data
WHERE created > UNIX_TIMESTAMP('2026-11-01')
   OR login   > UNIX_TIMESTAMP('2026-11-01')
ORDER BY created DESC;

-- Everyone with the administrator role (compare against your expected list)
SELECT u.uid, u.name, u.mail, FROM_UNIXTIME(u.created) AS created
FROM users_field_data u
JOIN user__roles r ON r.entity_id = u.uid
WHERE r.roles_target_id = 'administrator';
```

Or do it through Drush, which is handy for scripting across many sites:

```bash
vendor/bin/drush sql:query "SELECT name, mail, FROM_UNIXTIME(created) FROM users_field_data u JOIN user__roles r ON r.entity_id=u.uid WHERE r.roles_target_id='administrator'"

# Config drift vs. what's in your repo — unexpected changes deserve a look
vendor/bin/drush config:status

# Recent watchdog entries, if dblog is enabled
vendor/bin/drush watchdog:show --count=200 --severity=Warning
```

Pay particular attention to config changes that enable PHP-capable text formats, new modules you didn't install, or altered `system.site` and `user.settings`, such as registration suddenly open to visitors without approval.

### 3d. The host: look beyond Drupal

RCE runs as your web server user. Check what that user has been doing:

```bash
# Cron entries for the web user (persistence favorite)
sudo crontab -u www-data -l 2>/dev/null
ls -la /var/spool/cron/crontabs/ /etc/cron.d/

# Processes running as the web user that aren't php-fpm/apache/nginx
ps -eo user,pid,ppid,lstart,cmd | awk '$1=="www-data"' | grep -vE 'php-fpm|apache2|nginx'

# Outbound connections from the web user — reverse shells, miners, C2
sudo ss -tunp | grep -E 'www-data|php'

# Writable temp dirs are common staging grounds
ls -la /tmp /var/tmp /dev/shm
```

Correlate with EDR telemetry if you have it. A PHP-FPM worker spawning `sh`, `curl`, `wget`, or `python` is one of the highest-fidelity detections you can write for web app RCE:

```yaml
# Example Sigma-style logic (adapt to your EDR/SIEM)
title: Web Server Process Spawning Shell or Downloader
logsource:
  category: process_creation
  product: linux
detection:
  parent:
    ParentImage|endswith: ['/php-fpm', '/apache2', '/httpd', '/nginx']
  child:
    Image|endswith: ['/sh', '/bash', '/dash', '/curl', '/wget', '/python3', '/perl', '/nc']
  condition: parent and child
level: high
```

---

## Step 4: If You Find Something, Don't Just Delete the Webshell

This is the mistake I see most often. Someone finds `sites/default/files/x.php`, deletes it, patches core, and closes the ticket. Meanwhile the attacker still has the database credentials from `settings.php`, a backdoor admin account, and a cron job that re-downloads the shell every hour.

If you confirm compromise:

1. **Preserve evidence first.** Snapshot the VM or volume, and copy logs off-host before you start cleaning.
2. **Rebuild, don't repair.** Deploy a fresh, patched codebase from source control onto a clean host or image. Treat the compromised filesystem as untrusted.
3. **Rotate every secret the web user could read.** That includes database credentials, the `$settings['hash_salt']` value in `settings.php` (rotating it invalidates existing sessions and one-time login links), API keys, SMTP credentials, and cloud credentials in environment variables or instance metadata.
4. **Audit and reset users.** Remove unknown accounts, force password resets for admins, and review role assignments.
5. **Scope lateral movement.** What else could that host reach? Shared database servers, internal APIs, and metadata endpoints are all fair game for an attacker with a shell.
6. **Check your legal and notification obligations** if the site held personal data.

---

## The Takeaway Checklist

Here's what I'd want on the whiteboard by end of day:

- [ ] **Read the official Drupal advisory** for CVE-2026-132165 and record affected and fixed versions.
- [ ] **Inventory every Drupal instance**, external and internal, including containers and legacy D7.
- [ ] **Patch internet-exposed sites first**, using `composer update "drupal/core-*" --with-all-dependencies`, then `drush updb` and `drush cr`.
- [ ] **Apply compensating controls** to anything you can't patch immediately: WAF rules, access restriction, installer lockdown, read-only code.
- [ ] **Hunt on every previously exposed site**: logs, filesystem diff, admin users, config drift, host processes.
- [ ] **Rebuild and rotate secrets** for anything showing signs of compromise.
- [ ] **Treat November 27, 2026 as your deadline**, whether or not you're a federal agency.

One last thought. Every time a core RCE like this lands, the teams that recover fastest aren't the ones with the best incident responders. They're the ones who already had an accurate asset inventory, Composer-managed builds in source control, and a deploy pipeline that can push a core update in under an hour. If this week was painful, write down why. That list is your Q1 roadmap.

Patch fast, hunt thoroughly, and assume the attacker read the exploit details before you did.

## Sources

- [Drupal Fail2Install Exploit Details Emerge as Critical RCE Flaw Faces Active Exploitation](https://thehackernews.com/2026/11/drupal-fail2install-exploit-details.html) (2026-11-25)
