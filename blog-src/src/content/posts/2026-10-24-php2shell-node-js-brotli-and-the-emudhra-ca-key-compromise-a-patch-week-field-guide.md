---
title: "PHP2Shell, Node.js Brotli, and the eMudhra CA Key Compromise: A Patch-Week Field Guide"
date: 2026-10-24
category: "thought-leadership"
tags: ["vulnerability-management", "php", "nodejs", "pki", "patch-management", "incident-response"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "PHP2Shell, a Node.js Brotli RCE, and eight eMudhra CA keys with weak entropy all landed in one week. Here is who is exposed, how to find your exposure, and what to patch first."
---

Some weeks deliver one big vulnerability. This week delivered three, and they hit three different layers of a typical web stack: the language runtime that serves your pages (PHP), the runtime behind your APIs and build tooling (Node.js), and the trust layer that tells every client which server it's talking to (the Web PKI, via eMudhra). Each one alone would justify an out-of-cycle change. Together they're a good test of whether your vulnerability management program can triage by exposure instead of by headline.

This is how I'd work through them, in priority order. Exact versions and CVE numbers below come from the vendor advisories and the coverage listed at the end. Advisories change during a fast-moving week, so check the primary source before you act on any detail.

## 1. PHP2Shell (CVE-2026-109618, CVE-2026-109619): patch first

**What happened.** PHP shipped emergency releases on October 21 for two flaws now called "PHP2Shell." Both are rated 9.2 under CVSS v4.0 and both allow unauthenticated remote code execution. One is memory corruption during out-of-memory handling. The other is a use-after-free involving state that persists between requests. The reported affected range runs from PHP 5.4 through 8.5, which covers almost every PHP install still running.

**Fixed versions:** 8.5.12, 8.4.27, 8.3.36, and 8.2.35. PHP 8.1 and older are end-of-life and get no official release. The PHP security team published minimal source backports for 7.4 through 8.1, and hosting vendors such as cPanel and CloudLinux shipped their own builds.

**Why it's first.** Exploitation attempts are being reported. watchTowr says it has seen active attempts, and Amazon Threat Intelligence reported one on October 17, before public disclosure. The coverage I've read treats Apache `mod_php` as the highest-risk deployment, because the flaws can be reached there with no help from the application. PHP-FPM, php-cgi, FrankenPHP, and LiteSpeed are also listed as affected.

### Find every PHP you actually run

An asset inventory will miss some installs. Look for running PHP instead:

```bash
# Running PHP processes on a host (php-fpm8.3, php-cgi, lsphp, frankenphp, ...)
ps -eo pid,comm,args | grep -Ei 'php|lsphp|frankenphp' | grep -v grep

# Version as the web SAPI sees it, not the CLI (they can differ)
curl -s -H 'Host: your.site' http://127.0.0.1/phpinfo-check.php | grep -m1 'PHP Version'

# Container images in a registry or on a node
docker images --format '{{.Repository}}:{{.Tag}}' | grep -i php
```

The `phpinfo` probe is a deliberate, temporary file that you remove right after the check. Don't leave it deployed. The underlying point matters more than the method: the CLI binary on `$PATH` and the module Apache actually loads can be different builds, and only the one serving requests counts.

### If you can't patch today

The interim guidance in circulation is to set `memory_limit = -1` so that applications can't override it, and to disable `session.upload_progress`. Several write-ups add that disabling upload progress alone is not enough, and recommend rejecting `multipart/form-data` at the edge for any app that doesn't take uploads. They also warn against using `RLIMIT_AS`/`RLIMIT_DATA` as a substitute, because those limits can reach the same vulnerable path.

For PHP-FPM, that means `php_admin_*` in **every** pool, because applications can override plain `php_value` settings:

```ini
; /etc/php/8.3/fpm/pool.d/www.conf (repeat in each pool)
php_admin_value[memory_limit] = -1
php_admin_flag[session.upload_progress.enabled] = off
php_admin_flag[file_uploads] = off   ; only if this app never accepts uploads
```

After you reload, check the values in a request served through FPM, not with `php -i`. Also understand what you're trading: an unbounded `memory_limit` gives up a memory-exhaustion safeguard. Keep `pm.max_children` sized so one runaway worker can't take down the box. Treat this as a bridge to the patched release, not a destination.

A third issue, CVE-2026-115560, was disclosed on October 23. PHP says it only affects unusually configured applications and is an unlikely risk. A mitigation exists but no patch had shipped at the time of writing. Track it, but don't let it hold up the patch for the first two.

**What to watch.** PHP should never spawn a shell. Child processes of `php-fpm*`, `php-cgi`, `httpd`/`apache2` (with `mod_php`), `lsphp`, or `frankenphp` that are `sh`, `bash`, `curl`, or `wget` are the highest-signal detection you can write this week. Match on the process-name prefix, because Debian and Ubuntu name the binary `php-fpm8.3` and similar.

## 2. Node.js October security release: the Brotli decoder

**What happened.** On October 21, Node.js released 26.12.1, 24.22.1, and 22.23.4, fixing ten CVEs. The headline is **CVE-2026-111497**, an out-of-bounds write in the bundled Brotli decoder. Malformed input can cause a crash, memory disclosure, or code execution in any application that decompresses attacker-controlled data with `node:zlib`. The other high-severity fixes are worth reading if your services connect to user-supplied addresses:

- **CVE-2026-105482**: `dns.resolve*()` and `dns.reverse()` truncate hostnames at a NUL byte, so you can get records for a different name than the one you validated.
- **CVE-2026-106069** and **CVE-2026-105483**: leading-zero and fullwidth-digit IPv4 spellings let a certificate that carries only a DNS SAN authenticate an IP endpoint.

Node 20 and older get nothing. If you're still on 20, this week is your forcing function.

### Am I decompressing untrusted Brotli?

More often than you'd expect. Third-party analyses point out two common paths. The built-in `fetch` advertises Brotli to HTTPS servers by default, so a malicious or compromised upstream can send you a crafted body. And on Express 5, `express.json()` decodes `Content-Encoding: br` request bodies from any client. Grep for explicit usage too:

```bash
# Explicit Brotli use in your code and dependencies
grep -rnE 'createBrotliDecompress|brotliDecompress(Sync)?' --include='*.js' --include='*.ts' src/ node_modules/ | head

# What's actually running, per process
node -p 'process.version + " brotli=" + process.versions.brotli'
```

If you package Node through a Linux distribution, check how your distro links Brotli. On Debian, the fix comes from the system `brotli` package, not from the Node version number, so `node -v` alone can mislead you in either direction.

### Pin the exact patch, not the major

One lesson I took from patching this site: a version file containing just `22` isn't a pin. Some hosted build images resolve a bare major to whatever patch release they bundle, which can be older than the security release. So `.nvmrc` here now names `22.23.4`, and CI sets `check-latest` so a cached older patch is never reused. If you build in containers, apply the same rule to `FROM node:22` and pin the patch (or the digest).

The release also updates Node's bundled CA store to handle the eMudhra intermediate compromise, which leads to the third item.

## 3. eMudhra: eight CA keys with insufficient entropy

**What happened.** On October 17 a researcher reported that the private keys for **eight eMudhra intermediate CA certificates** could be recovered. They weren't stolen. They were generated with insufficient randomness during an April 2025 key ceremony. According to eMudhra's account, a script produced a second set of weak keys with labels similar to the real ones, and staff selected the weak set. Six of the intermediates could issue TLS certificates and two could issue code-signing certificates. Anyone who recovered a key could have issued certificates that browsers would trust for any domain.

**The response was fast.** Chrome (CRLSet) and Mozilla (OneCRL) blocked the intermediates within hours on October 17. Apple followed on the 19th and Microsoft on the 20th. Chrome is also removing the **emSign ECC Root CA – G3** root that signed them, with the change reaching Chrome Root Store clients on October 27. eMudhra says it revoked the certificates within 14 hours, that none issued end-entity certificates, and that its root keys are unaffected. On October 22 it announced it is leaving the global TLS certificate business. No malicious use has been confirmed. Because the weak keys existed for about 17 months before discovery, though, "no evidence of misuse" is not the same as "no misuse."

**Why this one matters most for the long tail.** Browsers are already protected. The exposure is everything that doesn't use a browser trust store or check revocation: API clients, service meshes, build pipelines, IoT and embedded firmware, JVMs with their own `cacerts`, and Go binaries (tracked in Go's `crypto/x509` as CVE-2026-111943). Those clients trust the bad intermediates until **their** trust store gets updated.

### Audit the trust stores you own

```bash
# OS bundle (Debian/Ubuntu) — look for the emSign roots
openssl crl2pkcs7 -nocrl -certfile /etc/ssl/certs/ca-certificates.crt \
  | openssl pkcs7 -print_certs -noout | grep -i emsign

# Java
keytool -list -cacerts -storepass changeit 2>/dev/null | grep -i emsign

# Anything you ship as a pinned bundle (containers, firmware, vendored certifi)
find /opt /srv /usr/local \( -name '*.pem' -o -name '*.crt' \) 2>/dev/null | while read -r f; do
  openssl crl2pkcs7 -nocrl -certfile "$f" 2>/dev/null \
    | openssl pkcs7 -print_certs -noout 2>/dev/null | grep -qi emsign && echo "$f"
done
```

If something you control turns up, update the OS `ca-certificates` package, Node, your JDK, `certifi`, and your base images. For appliances and devices you can't update quickly, ask the vendor directly when the trust-store update ships. It's also worth checking Certificate Transparency for your domains (crt.sh or your CT monitoring) for any certificate chained to an eMudhra intermediate you didn't request. That's a cheap check that turns "probably fine" into evidence.

## Also worth your attention this week

- **Arista VeloCloud Orchestrator (CVE-2026-114625).** Arista patched an actively exploited critical zero-day in the on-prem Orchestrator. If you run it, treat it with the same urgency as PHP2Shell, since management planes are high-value targets.
- **Go `crypto/x509` (CVE-2026-111943).** This is the Go-side tracking for eMudhra. Upgrade the toolchain per the Go advisory, and rebuild services that ship their own root bundle.

## How I'd sequence it

1. **Today:** patch or mitigate PHP on anything internet-facing, and deploy the "PHP spawned a shell" detection. That's the one with reported exploitation and no authentication required.
2. **This week:** roll Node to 26.12.1 / 24.22.1 / 22.23.4, pinned to the exact patch. Prioritize services that accept compressed bodies from clients or fetch from servers you don't control.
3. **This sprint:** inventory every trust store you ship, remove the eMudhra intermediates and the emSign ECC Root CA – G3, and add a CT monitor if you don't have one.

The thread running through all three: the version you think you run, the version your build actually resolved, and the trust store your client actually loads are three different facts. Verify each one at runtime, not from a spreadsheet.

## Sources

- [Node.js — October 21, 2026 Security Releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Rapid7 — CVE-2026-109618 and CVE-2026-109619: Critical Unauthenticated RCE in PHP](https://www.rapid7.com/blog/post/etr-cve-2026-109618-and-cve-2026-109619-critical-unauthenticated-remote-code-execution-in-php/)
- [Tenable — PHP2Shell FAQ](https://www.tenable.com/blog/php2shell-cve-2026-109618-cve-2026-109619-frequently-asked-questions-about-critical-php-remote)
- [watchTowr — PHP2Shell FAQ](https://watchtowr.com/intelligence/php-cve-2026-109618-faq/)
- [The Hacker News — PHP Issues Emergency Patches for Two Critical PHP2Shell RCE Flaws](https://thehackernews.com/2026/10/php-issues-emergency-patches-for-two.html)
- [Sansec — PHP2Shell research](https://sansec.io/research/php2shell)
- [Mozilla Security Blog — Protecting Firefox users following the compromise of eMudhra intermediate certificates](https://blog.mozilla.org/security/2026/10/20/protecting-firefox-users-following-the-compromise-of-emudhra-intermediate-certificates/)
- [Google — Protecting Chrome and Android users from compromised eMudhra intermediate CA certificates](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/)
- [Cloudflare — 8 eMudhra certificates are compromised](https://blog.cloudflare.com/emudhra-certificate-compromise/)
- [eMudhra — Statement on Recent Certificate Security Incident](https://emudhra.com/en/post/certificate-security-incident)
- [BleepingComputer — Arista patches new VeloCloud Orchestrator zero-day exploited in attacks](https://bleepingcomputer.com/news/security/arista-patches-new-velocloud-orchestrator-zero-day-exploited-in-attacks)
