---
name: resumesite-architecture-contract
description: Explains WHY resumesite is built the way it is and lists the load-bearing invariants that must not be silently broken. Load this BEFORE touching astro.config.mjs, blog-src/public/_headers, worker/index.ts, worker/api/contact.ts, wrangler.jsonc, blog-src/src/content.config.ts, blog-src/src/config.ts, or blog-src/src/data/resume.ts — or whenever you are asked "why is this like this", "can I remove/relax this", "is it safe to change X", or you see symptoms like scripts silently failing under CSP, a post/draft not showing up in the blog, résumé and homepage disagreeing, or JSON-LD/RSS/meta showing different site names. Also load it when reviewing a PR that touches security headers, the contact worker, the content loader glob, or brand/feed constants, to check the change against these invariants. Does NOT cover step-by-step build/run commands (see resumesite-build-and-env, resumesite-run-and-operate) or deep Astro/Cloudflare API mechanics (see resumesite-astro-reference, resumesite-cloudflare-reference) — this skill owns the WHY and the invariants, not the HOW.
---

# resumesite Architecture Contract

This is the "why is it built this way, and what happens if I change it" reference for
resumesite. Read this before changing any file listed in the frontmatter trigger list, and
before approving a PR that touches security headers, the contact worker, the content
loader, or the brand/feed constants.

Every claim below was verified by reading the actual file on 2026-07-05, on branch `skills`.
Re-verify commands are in "Provenance and maintenance" at the end — run them before trusting
this doc on a later date.

## 1. System shape (the 30-second mental model)

```
Browser
  │
  ▼
Cloudflare Worker  (worker/index.ts, "main": in wrangler.jsonc)
  │
  ├─ POST/OPTIONS /api/contact  ──────────►  worker/api/contact.ts (handleContact)
  ├─ /css/* or /js/* on a 404 from ASSETS ─►  stale-hash fallback (see §2.6)
  └─ everything else ──────────────────────►  env.ASSETS.fetch(request)  (static files in dist/)
```

- The site is **static Astro** (`output: 'static'` in `blog-src/astro.config.mjs`), built from
  `blog-src/` to `dist/` (repo root), and served by Cloudflare as static assets bound to the
  Worker as `ASSETS` (`wrangler.jsonc`: `"assets": { "directory": "dist", "binding": "ASSETS" }`).
- The Worker is small and single-purpose: it exists almost entirely to run `/api/contact`
  (POST handled, OPTIONS answered with a 204 + `Allow` header, anything else 405) and to patch
  one Cloudflare-assets edge case for hashed CSS/JS (§2.6). It does **not** run in front of every
  request by default — `wrangler.jsonc` explicitly opts `/api/*`, `/css/*`, `/js/*` into
  `run_worker_first`; every other path (HTML pages, images, fonts, `/blog/*`, etc.) is served
  directly from `ASSETS` without the Worker's `fetch()` even executing custom logic first.
- Correction against a common oversimplification: **"the Worker only handles /api/contact" is
  not quite right.** It also intercepts `/css/*` and `/js/*` to run the stale-fingerprint
  fallback below. Get this precise if you're editing `run_worker_first` or `index.ts`.

## 2. Load-bearing invariants

Each of these is a place where two files silently depend on each other. Changing one side
without the other does not throw an error — it breaks in production, often invisibly (a
script just doesn't run, a page 404s, structured data quietly drifts). Treat every change to
these as requiring extra scrutiny in review, and route any actual change through
**resumesite-change-control** (PR + green CI; no exceptions carved out here).

### 2.1 CSP `script-src` has no `'unsafe-inline'` ⟷ `assetsInlineLimit: 0`

- `blog-src/public/_headers` (line 7, global `/*` block):
  `script-src 'self' https://laplantedevanalytics.netlify.app https://static.cloudflareinsights.com https://challenges.cloudflare.com https://app.cal.com;` — no `'unsafe-inline'`, ever.
- `blog-src/astro.config.mjs` (`vite.build.assetsInlineLimit: 0`), with this comment in the
  file itself:
  > "Never inline bundled `<script>` blocks into the HTML. Required for the strict CSP in
  > `public/_headers` (script-src without 'unsafe-inline'): with the default 4KB limit, small
  > page scripts get embedded as inline `<script type="module">` and would be blocked."
- **Why this pairing exists:** Astro/Vite's default behavior is to inline small built assets
  (under a size threshold) directly into the HTML as `<script>`/`<style>` tags for performance.
  An inlined `<script>` has no `src=`, so the CSP's origin allowlist can't cover it — only
  `'unsafe-inline'` would, and that's exactly the thing this CSP refuses to add.
  `assetsInlineLimit: 0` unconditionally disables that inlining for scripts, so every script
  stays a separate file served from `'self'`.
- **What breaks if you touch one side alone:**
  - Remove/raise `assetsInlineLimit` (e.g. back to Astro's default) → small page scripts get
    inlined again → the CSP silently blocks them at the browser level (console CSP violation,
    feature just doesn't run) → **no build error, no test failure, no CI signal** — this is a
    production-only, browser-console-only symptom.
  - Add `'unsafe-inline'` to `script-src` to "fix" a CSP violation instead of tracing it back to
    `assetsInlineLimit` → you've weakened the CSP for the whole site to paper over a build
    config regression.
- **Correct fix for a CSP script violation:** confirm `assetsInlineLimit: 0` is still set before
  touching `_headers`. If the CSP needs a genuinely new script origin (e.g. a new third-party
  widget), add that specific origin to `script-src` deliberately and note why, in a PR under
  change-control — don't add `'unsafe-inline'`.

### 2.2 The whole site lives in `blog-src/` — a naming trap

- `blog-src/` is not "the blog" — it is the entire Astro project: portfolio, résumé, services
  booking, and the blog, all under one Astro app. `astro.config.mjs` sets `outDir: '../dist'`,
  i.e. the build output lands at the **repo root's** `dist/`, one level up from `blog-src/`.
- Everything Astro-related (`src/pages`, `src/components`, `src/content`, `public/`, its own
  `package.json` and `package-lock.json`) lives under `blog-src/`. The repo-root `package.json`
  is a thin orchestration layer (`cd blog-src && npm run build`, etc.) plus the AI blog-draft
  scripts and the shared test suite.
- **Why it matters:** any tool or contributor that assumes "blog stuff is in blog-src, site
  stuff is at root" will be wrong — there is no separate root-level site source. New pages,
  layouts, and static assets all belong under `blog-src/`, not root.

### 2.3 `blog-src/src/data/resume.ts` is the single source of truth for résumé + homepage

- Confirmed in the file's own header comment: "Single source of truth for résumé-style content
  shared by the homepage (`index.astro`) and the printable résumé page (`resume.astro`).
  Update a job, skill, or stat here once and both pages stay in sync — there is no separate
  résumé file to hand-maintain."
- It exports `profile`, `summary`, `stats`, `skills`, `certifications` (intentionally empty
  until real credentials exist — the file's own comment warns never to list a certification
  that isn't actually held), and (further down the file, not fully read for this skill)
  `ExperienceEntry`-shaped work history.
- **Why it matters:** never hand-edit résumé facts separately in `index.astro` or
  `resume.astro`. If the homepage and the résumé page ever show different job titles, dates,
  or stats, that's a bug — trace it back to whichever page stopped reading from `resume.ts`.
- The résumé PDF (`blog-src/src/pages/resume.pdf.ts`, rendered via `pdfkit` at build time) also
  reads from this same file, so a `resume.ts` edit propagates to three surfaces (homepage,
  HTML résumé, PDF résumé) without further changes.

### 2.4 `blog-src/src/config.ts` centralizes brand/feed identity

- `SITE_URL`, `DEFAULT_OG_IMAGE`, `AUTHOR_NAME`, `BLOG_TITLE`, `BLOG_DESCRIPTION`, `CAL_LINK`
  live in exactly one file, with this stated purpose in-file: "Centralized so JSON-LD, feeds,
  and meta tags share one source of truth instead of repeating the strings per page."
- **Why it matters:** RSS (`blog/rss.xml.ts`), JSON Feed (`feed.json.ts`), `<head>` meta/OG tags
  (via `BaseHead` component), and JSON-LD structured data all pull from here. If you ever see
  the site title or description differ between the RSS feed and the page `<title>`, someone
  bypassed `config.ts` and hardcoded a string — fix it by pointing back at the constant, not by
  hardcoding the other surface to match.
- `CAL_LINK = ''` is a deliberate kill-switch: setting it to an empty string hides all booking
  UI on `/services` until a real Cal.com account/handle exists. Don't delete the booking
  markup to "turn off" scheduling — clear this constant instead.

### 2.5 Content loader glob and the drafts/posts split (two separate mechanisms — don't conflate them)

`blog-src/src/content.config.ts`:
```ts
const posts = defineCollection({
  loader: glob({ pattern: '**/[^_A-Z]*.md', base: "./src/content/posts" }),
  ...
});
```

There are **two independent reasons** a Markdown file does not become a published post — do
not describe them as one mechanism:

1. **Directory scope**: `base: "./src/content/posts"` means the loader never even looks inside
   `src/content/drafts/`. A draft is excluded purely by living outside the scanned directory —
   the glob pattern is never evaluated against it at all. (As of 2026-07-05 there is no
   `drafts/` directory in the tree yet — `blog-src/src/content/` contains only `posts/` — it is
   created on demand the first time a draft is written there, e.g. by the `blog-draft` skill.)
2. **Filename pattern** `**/[^_A-Z]*.md`: *within* `src/content/posts/`, this glob still
   excludes any filename whose first character is `_` or an uppercase letter (`[^_A-Z]` is a
   negated character class matched against the first character of the basename). That's what
   keeps a stray `CLAUDE.md`, `README.md`, or an intentionally-prefixed `_partial.md` from ever
   being parsed as a blog post, even if someone drops one directly into `posts/`.
- **Why it matters:** if you want a file to never publish regardless of directory, prefix it
  with `_` or a capital letter. If you want a file to be a draft under normal review workflow,
  put it in `drafts/` (created on first use) — capitalization there doesn't matter since the
  loader never scans that directory at all.

### 2.6 Contact worker: same-origin-only, attempts-based rate limit, header-injection strip

`worker/api/contact.ts` (`handleContact`), in request order — treat every step as load-bearing,
not incidental:

| # | Guard | Detail | Failure mode if removed |
|---|---|---|---|
| 1 | Method routing | `worker/index.ts` only calls `handleContact` on POST; OPTIONS gets a 204, anything else 405 | non-POST requests reach handler logic unnecessarily |
| 2 | Same-origin enforcement | `origin !== url.origin` → `403`, **including when `Origin` is absent** | reopens the cross-site form-submission bypass fixed once already (see resumesite-failure-archaeology F1) |
| 3 | Content-Type allowlist | only `application/x-www-form-urlencoded` / `multipart/form-data` → else `415` | unexpected body parsing paths |
| 4 | Body size cap | `MAX_FORM_BYTES = 32*1024`; checked on `Content-Length` (fast reject) **and** enforced on the real stream via `readBodyCapped` | `Content-Length` is client-controlled/absent on chunked bodies — the header-only check alone is not a real cap |
| 5 | Honeypot | non-empty `bot-field` → silent redirect to `/thank-you/` (pretend success) | tips off bots that they were detected |
| 6 | Field caps + control-char strip | `stripControl()` removes `\x00`–`\x1f`,`\x7f`; `MAX_NAME_LEN=200`, `MAX_EMAIL_LEN=200`, `MAX_MESSAGE_LEN=5000`; `EMAIL_RE` requires a real 2+ char TLD | without `stripControl`, CR/LF in name/email could inject extra headers into outbound mail (header injection) since name/email flow into `replyTo`/`subject` |
| 7 | Turnstile verification | `cf-turnstile-response` token required, checked against `siteverify` with `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS=10_000)`; **fails closed** — a `siteverify` fetch error rejects the request rather than skipping verification | a hung/erroring Turnstile check must not silently let submissions through |
| 8 | Per-IP rate limit | `RATE_LIMIT_MAX=5` per `RATE_LIMIT_WINDOW_MS` (1h), counted in D1 table `contact_attempts` — counts **every POST that reaches the Turnstile check**, not just accepted submissions | counting only accepted submissions would let an attacker fail Turnstile unlimited times for free against `siteverify` and D1 |
| 9 | Store + notify | insert into D1 `submissions`; owner notification + sender auto-reply both go through the single `sendMail()` chokepoint (`worker/api/contact.ts`) | a second mail-sending code path could drift in auth/timeout/shape |
| 10 | Delivery-failure handling | row stored but mail fails → redirect `/thank-you/?delivery=delayed` (never invite resubmission of an already-stored message); hard reject → `/contact-error/` | resubmission on a stored-but-unmailed message risks duplicate submissions |
| 11 | Retention purge | submissions older than `RETENTION_MS = 90 days` deleted opportunistically on each **accepted** request (`ctx.waitUntil`, off the response path); `contact_attempts` pruned to the rate window on every attempt | see §3 "opportunistic, not scheduled" — this is a known limitation, not a bug |

D1 schema (`worker/schema.sql`): `submissions(id, name, email, message, ip, ts)` and
`contact_attempts(id, ip, ts)`, both with `ts`/`ip+ts` indexes. Env bindings (from
`worker/index.ts` `Env` interface and `vitest.config.ts` test bindings): `DB`, `TURNSTILE_SECRET`,
`FE_API_KEY`, `CONTACT_FROM`, `CONTACT_TO`.

**Also load-bearing but easy to miss:** `worker/index.ts` intercepts `/css/*` and `/js/*` (via
`run_worker_first` in `wrangler.jsonc`) purely to run a stale-fingerprint fallback: if `ASSETS`
404s on a hashed filename like `/css/style.4c1f0b9a2e.css` (the pattern `HASHED_ASSET` in
`worker/index.ts` matches `/(css|js)/<name>.<10-hex-char-hash>.(css|js)`), it strips the hash and
re-fetches the current (unhashed-suffix) asset instead of surfacing the 404. This exists because
old CDN-cached HTML can reference a previous deploy's hashed filename after a new deploy has
replaced it — without this fallback, that old cached HTML would 404 on its own CSS/JS until the
cache expires.

### 2.7 OG images + résumé PDF are build-time rendered

- Per-post OG images (`blog-src/src/pages/og/[slug].png.ts`) are generated at build time using
  `satori` (layout → SVG) + `@resvg/resvg-js` (SVG → PNG raster).
- The résumé PDF (`blog-src/src/pages/resume.pdf.ts`) is generated at build time with `pdfkit`,
  reading from `resume.ts` (§2.3). `wawoff2` is used to decompress WOFF2 fonts for use in these
  build-time renderers (neither satori nor pdfkit consume WOFF2 natively).
- **Why it matters:** none of this happens at request time — there is no runtime image or PDF
  generation in the Worker. If an OG image or the résumé PDF looks stale after a content change,
  the fix is "rebuild the site," not "check the Worker."

### 2.8 Two `package.json` / two `node_modules` — the lib tests need both

- Root `package.json` (repo root) and `blog-src/package.json` are separate npm projects with
  separate lockfiles and separate `node_modules` (confirmed present at both `node_modules/` and
  `blog-src/node_modules/` in this checkout).
- Root deps: `@anthropic-ai/sdk`, plus dev tooling (`vitest`, `eslint`, `@cloudflare/vitest-pool-workers`,
  `typescript-eslint`, etc.). Blog-src deps: `astro`, `@astrojs/rss`, `@astrojs/sitemap`,
  `@resvg/resvg-js`, `pdfkit`, `satori`, `wawoff2`, plus dev tooling (`@astrojs/check`,
  `bootstrap`, `purgecss`, `typescript`).
- **Why it matters:** `tests/lib/*.test.js` import from `blog-src/src/utils/*` (e.g. the résumé
  PDF and search utilities), which pull in `pdfkit`/`wawoff2` — packages that live only in
  `blog-src/node_modules`. A fresh clone that only runs `npm ci` at the root will have those
  imports fail; both `npm ci` (root) and `cd blog-src && npm ci` are required. Full setup
  sequencing is owned by **resumesite-build-and-env** — this skill only explains why two
  installs are necessary, not the exact commands.

## 3. Known weak points / open items (labeled candidate/open — no oversell)

| Item | Status | Detail |
|---|---|---|
| Single-region D1 | **open** | `wrangler.jsonc`'s `d1_databases` block configures no read replication — D1 runs as a single write region here. This is a statement of current config, not a claim that D1 categorically cannot replicate. Deeper D1 mechanics belong to **resumesite-cloudflare-reference**. |
| Retention purge is opportunistic, not scheduled | **open, by design (documented trade-off)** | `contact.ts`'s own comment: "Cloudflare's free Workers plan caps cron triggers per account, so we piggy-back on accepted submissions instead of using a scheduled handler." Practical effect: if contact submissions stop entirely, old rows are never purged (there's no traffic to trigger the purge). Attempts are pruned more often (on every attempt, not just accepted ones), so that table self-limits better than `submissions`. |
| Embedding cache is disk-only and gitignored | **open** | `scripts/.embeddings-cache.json` is listed in `.gitignore` (confirmed) and keyed by SHA-256 of input text, used by the AI blog-draft dedupe pipeline. A fresh CI checkout has a cold cache — the first embed call after a fresh clone re-embeds rather than hitting a warm cache. Full dedupe-pipeline detail is owned by whichever blog-draft-adjacent skill covers `scripts/lib/blog-post.js` — cross-reference rather than duplicate here. |
| Lighthouse `numberOfRuns: 1` | **open — noisy signal** | `lighthouserc.json` sets `"numberOfRuns": 1` (confirmed). A single run means performance/BP/SEO scores (all `"warn"`-level, not blocking) can vary run to run. Only `categories:accessibility` is `"error"`-level (`minScore: 0.9`) and actually blocks CI. Detailed CI mechanics belong to **resumesite-validation-and-qa**. |
| Custom-domain bot protection 403s CI | **open — known workaround in place** | The `purge-cloudflare-cache.yml` deploy-check step probes the `workers.dev` host rather than the custom domain, because the custom domain's bot protection 403s CI runners; override via the `DEPLOY_CHECK_HOST` repo variable. Full detail owned by **resumesite-cloudflare-reference** / **resumesite-run-and-operate** — this entry exists so "why does the deploy check use workers.dev, not the real domain" isn't a mystery at the architecture level.

## 4. When NOT to use this skill

- Step-by-step setup, install, or build commands → **resumesite-build-and-env**.
- Running, previewing, or deploying the built site → **resumesite-run-and-operate**.
- Astro-specific API/framework mechanics (collections API details, routing internals, image
  service internals) → **resumesite-astro-reference**.
- Cloudflare-specific mechanics (Workers runtime details, D1 operational behavior, Turnstile
  API details, cache purge internals) → **resumesite-cloudflare-reference**.
- The exact list/meaning of every env var, tunable constant, or CLI flag → **resumesite-config-and-flags**.
- Past incidents and their root causes in narrative form → **resumesite-failure-archaeology**.
- The actual gating process for making a change (PR, CI, review) → **resumesite-change-control**.
  This skill states invariants; it never tells you it's fine to bypass change-control to "fix"
  one.

## Provenance and maintenance

Compiled 2026-07-05 on branch `skills`, by direct read of every file cited above (not from a
digest). Re-verify each drift-prone claim with:

```bash
# CSP / assetsInlineLimit pairing (§2.1)
grep -n "assetsInlineLimit" blog-src/astro.config.mjs
grep -n "script-src" blog-src/public/_headers

# outDir / naming trap (§2.2)
grep -n "outDir" blog-src/astro.config.mjs

# resume.ts single-source-of-truth comment still present (§2.3)
head -5 blog-src/src/data/resume.ts

# brand/feed constants centralized (§2.4)
cat blog-src/src/config.ts

# content loader glob + base dir (§2.5)
grep -n "loader: glob" -A2 blog-src/src/content.config.ts
ls blog-src/src/content/   # confirm whether drafts/ exists yet

# contact worker guard order and constants (§2.6)
grep -n "RATE_LIMIT_MAX\|RATE_LIMIT_WINDOW_MS\|RETENTION_MS\|MAX_FORM_BYTES\|MAX_NAME_LEN\|MAX_EMAIL_LEN\|MAX_MESSAGE_LEN\|UPSTREAM_TIMEOUT_MS" worker/api/contact.ts

# run_worker_first scope (§1, §2.6)
grep -n "run_worker_first" wrangler.jsonc
grep -n "HASHED_ASSET" worker/index.ts

# two package.json / two node_modules (§2.8)
ls -d node_modules blog-src/node_modules

# weak points: D1 replication config, embeddings cache gitignore, Lighthouse runs
grep -n "d1_databases" -A4 wrangler.jsonc
grep -n "embeddings-cache" .gitignore
grep -n "numberOfRuns" lighthouserc.json
```

Discrepancies found against the task brief / fact-sheet while authoring this skill (file wins
in every case):

1. The Worker is not "only" `/api/contact` — `wrangler.jsonc`'s `run_worker_first` also routes
   `/css/*` and `/js/*` through it for the stale-fingerprint fallback in `worker/index.ts`.
2. The content-loader "excludes drafts" and "excludes `_`/uppercase files" are two separate
   mechanisms (directory scope vs. filename glob), not one combined glob rule — see §2.5.
3. Root `npm run build` invokes `cd blog-src && npm run build` (which is `astro build` as
   defined in `blog-src/package.json`), not `astro build` directly at the root — a one-hop
   indirection worth knowing if you're tracing what a build script actually runs.

Not independently re-verified for this skill (used from the shared fact-sheet as background,
not asserted as a primary claim here): exact `npm test` / `npm run typecheck` pass counts and
CI workflow list — those baselines are owned by resumesite-build-and-env /
resumesite-validation-and-qa; re-check there before citing a number.
