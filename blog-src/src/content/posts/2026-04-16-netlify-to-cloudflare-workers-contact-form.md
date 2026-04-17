---
title: "Off Netlify: Self-Hosting a Contact Form on Cloudflare Workers"
date: 2026-04-16
category: "dev-session"
tags: ["cloudflare", "cloudflare-workers", "d1", "turnstile", "migration", "contact-form", "serverless"]
excerpt: "Migrating my portfolio from Netlify to Cloudflare Workers meant rebuilding Netlify Forms from scratch. Here's the pipeline I landed on — and the three surprises that nearly derailed it."
---

I moved my portfolio off Netlify tonight. The site itself was the easy part — it's a static Astro build, and Cloudflare Pages/Workers happily serves static assets. The hard part was Netlify Forms. I had a contact form on the homepage using `data-netlify="true"`, and that attribute carries more weight than it looks: spam filtering, submission storage, and email notifications, all wired into one magical HTML attribute.

I wanted an equivalent on Cloudflare with no third-party form vendors. Here's what I ended up with, and the three things that caught me off guard along the way.

## The architecture

```
Browser → Cloudflare Worker → [Turnstile verify] → D1 (log) → ForwardEmail API → inbox
```

Four pieces, all on Cloudflare's platform except the email hop:

- **Turnstile** for bot protection (free, CAPTCHA-style but invisible when possible)
- **Cloudflare Worker** at `/api/contact` to validate, verify, log, and relay
- **D1** (SQLite at the edge) to persist every submission as a backup
- **ForwardEmail API** for the actual mail delivery — open-source, privacy-focused, and crucially *not* built on AWS SES

Total code: about 70 lines of TypeScript for the Worker, one SQL file for the D1 schema, one `wrangler.jsonc` for bindings. That's it.

## Surprise #1: `functions/` is Pages-only

I started by creating `functions/api/contact.ts` — the Cloudflare Pages convention. Pushed it. Looked at the Cloudflare dashboard: "Variables cannot be added to a Worker that only has static assets."

Turns out Cloudflare merged Workers and Pages into a unified product, and the new model creates everything as a **Worker with static assets**. `functions/` is a Pages-only directory convention — the unified Worker model ignores it entirely and needs an explicit entrypoint in `wrangler.jsonc`:

```jsonc
{
  "name": "resumesite",
  "main": "worker/index.ts",
  "assets": { "directory": "dist", "binding": "ASSETS" }
}
```

Once I gave it a real `main`, the Variables panel lit up and bindings worked.

## Surprise #2: Build-time vs runtime env vars

Next problem: the Turnstile widget rendered as an empty `<div class="cf-turnstile">` — no `data-sitekey` attribute. I'd set `PUBLIC_TURNSTILE_SITE_KEY` as a runtime environment variable in the dashboard, expecting Astro to pick it up at build.

It doesn't. Cloudflare's new UI has two entirely separate variable lists:

- **Runtime variables/secrets** — available to Worker code via `env.FOO`
- **Build variables** — available to the build process via `import.meta.env.FOO`

Astro bakes `PUBLIC_*` variables into the HTML at build time. So a runtime-only variable is invisible to Astro, and `data-sitekey={import.meta.env.PUBLIC_TURNSTILE_SITE_KEY}` silently resolved to `undefined`. Moved the var to the build variables panel; widget appeared.

## Surprise #3: The static asset layer eats your POST

This was the stickiest one. Turnstile worked, the form submitted, and I got a "This page isn't working" browser error with `HTTP ERROR 405`. Method Not Allowed. But my Worker explicitly handles POST at `/api/contact`.

It took a few minutes to realize: Cloudflare's static asset layer runs *before* the Worker. For any request path, it first checks whether a matching file exists in `dist/`. If not, the default behavior depends on `not_found_handling`. And the asset layer only speaks GET and HEAD. When a POST came in for `/api/contact` (not an asset), it returned 405 *without ever invoking my Worker*.

The fix is a little-documented directive:

```jsonc
"assets": {
  "directory": "dist",
  "binding": "ASSETS",
  "run_worker_first": ["/api/*"]
}
```

`run_worker_first` tells Cloudflare to bypass the asset layer for matching paths and hand them directly to the Worker. Static pages still get the fast asset-layer path; API routes route correctly.

## Surprise #4: ForwardEmail's outbound approval gate

Last gotcha, for the road. Submissions started landing in D1, but emails didn't arrive. The Worker logs showed:

```
ForwardEmail failed 400
{"error":"Bad Request","message":"Domain does not exist on your account."}
```

I triple-checked: the domain *was* verified (TXT, MX, SPF, DKIM, DMARC all green). The API key was correct. A direct `curl` test revealed the real error:

```
403 Forbidden
"Domain is not approved for outbound SMTP access, please contact us."
```

Enhanced Protection on ForwardEmail covers *inbound* forwarding automatically. *Outbound* SMTP via API requires manual per-domain approval to prevent abuse. The original 400 response was misleading — the actual 403 only appears on the send endpoint. Their support approves legitimate use cases quickly; I filed a request and moved on.

Meanwhile, the D1 log means submissions aren't lost — I can query them any time:

```bash
wrangler d1 execute contact-submissions --remote \
  --command="SELECT * FROM submissions ORDER BY ts DESC"
```

## The payoff

No more `data-netlify="true"` magic. No third-party form vendor logging my submissions. Every piece of the pipeline is code I own, running on infrastructure I understand. Four moving parts, one bill from Cloudflare, and a contact form that's genuinely mine.

The migration itself took an evening. The four surprises took most of that evening. Worth it.
