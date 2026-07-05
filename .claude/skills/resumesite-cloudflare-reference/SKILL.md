---
name: resumesite-cloudflare-reference
description: >
  Conceptual reference for the Cloudflare edge layer of resumesite: the single
  Worker (worker/index.ts), the /api/contact handler and its D1 tables, wrangler.jsonc
  bindings, blog-src/public/_headers, Turnstile siteverify, ForwardEmail mail
  transport, and the @cloudflare/vitest-pool-workers test model. Load this skill
  when you see or are asked about: "Worker", "wrangler.jsonc", "D1", "D1Database",
  "ASSETS binding", "run_worker_first", "contact_attempts", "submissions table",
  "Turnstile", "siteverify", "cf-turnstile-response", "ForwardEmail", "FE_API_KEY",
  "CONTACT_FROM/CONTACT_TO", "_headers", "CSP", "Content-Security-Policy",
  "Cache-Control", "CDN-Cache-Control", "stale-while-revalidate", "cloudflare:test",
  "miniflare", "vitest-pool-workers", "workers.dev", "nodejs_compat", a 403/404/405/413/415
  from /api/contact, a stale fingerprinted /css or /js asset 404ing, or "why does dev
  server X behave differently from the deployed Worker". Do NOT use this for the
  Astro static build itself (astro.config.mjs, PurgeCSS, OG/PDF rendering — use
  resumesite-astro-reference), for the deploy/operate runbook (use
  resumesite-run-and-operate), for env var / flag inventories as a config surface
  (use resumesite-config-and-flags), or for the history of the F1 origin-bypass bug
  (use resumesite-failure-archaeology). This skill explains the CURRENT Cloudflare
  runtime model and why it is shaped the way it is.
---

# resumesite Cloudflare reference

Conceptual reference for the Cloudflare edge: one Worker, one D1 database, static
assets, and the security headers that ride along with them. If you need to
change any of this, the change still goes through **resumesite-change-control**
(PR + green CI) — nothing here is a workaround for that gate.

All facts below were verified against the repo on 2026-07-05 (branch `skills`).
Re-verification commands are in "Provenance and maintenance" at the end.

## 1. The execution model: one Worker, three routing tiers

`wrangler.jsonc` (repo root) is the single source of Worker config:

```jsonc
{
  "name": "resumesite",
  "compatibility_date": "2026-04-17",
  "compatibility_flags": ["nodejs_compat"],
  "main": "worker/index.ts",
  "assets": {
    "directory": "dist",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": ["/api/*", "/css/*", "/js/*"]
  },
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "contact-submissions", "database_id": "…" }
  ]
}
```

- **`main`**: `worker/index.ts` is the only Worker script. There is no separate
  API worker/service — one Worker handles everything that isn't a plain static
  asset.
- **`assets`**: Cloudflare's native "Workers with assets" feature. `directory:
  "dist"` is the build output of `npm run build` (see resumesite-astro-reference
  / resumesite-build-and-env). The `ASSETS` binding is a `Fetcher` — call
  `env.ASSETS.fetch(request)` to serve a static file from code.
- **`run_worker_first`**: by default, when `assets` is configured, Cloudflare
  serves matching requests straight from the assets store WITHOUT invoking
  `main` at all (cheaper, no CPU billed). `run_worker_first` is the escape
  hatch — it forces these three path patterns through `worker/index.ts` first:
  - `/api/*` — has to run in code; there is no static file to serve.
  - `/css/*`, `/js/*` — deliberately routed through the Worker for the
    stale-fingerprint fallback below, NOT served as pure passthrough.
- **`database_id`**: don't copy the UUID into other docs or this skill — read
  it live from `wrangler.jsonc`; it's a deploy-target identifier, not a fact
  worth duplicating.

### `worker/index.ts` — the actual routing logic

```ts
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FE_API_KEY: string;
  TURNSTILE_SECRET: string;
  CONTACT_FROM: string;
  CONTACT_TO: string;
}
```

Three-way dispatch inside `fetch()`:

1. **`/api/contact`** — POST → `handleContact()` (see §2). OPTIONS → `204`
   with `Allow: POST, OPTIONS`. Anything else → `405` with the same `Allow`
   header. (`tests/worker/contact.test.ts` "router" block asserts both.)
2. **`/css/*`, `/js/*`** (via `run_worker_first`) — first tried against
   `env.ASSETS.fetch(request)`. If that comes back `404`, the pathname is
   tested against a `HASHED_ASSET` regex:
   ```ts
   const HASHED_ASSET = /^(\/(?:css|js)\/.+)\.[0-9a-f]{10}(\.(?:css|js))$/;
   ```
   That regex matches a fingerprinted filename produced by
   `blog-src/scripts/fingerprint-assets.mjs` post-build, e.g.
   `/css/style.4c1f0b9a2e.css`. If it matches, the Worker retries
   `env.ASSETS.fetch()` against the **unhashed** path (`/css/style.css`) from
   the *current* deploy. **Why this exists**: CDN-cached HTML from a previous
   deploy can still reference the old hash after a redeploy replaces the
   asset; without this fallback that reference would 404 until the cached
   HTML itself expires. `tests/worker/assets.test.ts` exists specifically to
   pin this behavior (stubs `ASSETS` with a fixed set of existing paths and
   asserts: exact hash hit → 200; stale hash with a live unhashed asset → 200
   fallback; stale hash with no unhashed asset → 404; non-fingerprinted
   missing path → plain 404, no fallback attempted).
3. **Everything else** — straight `env.ASSETS.fetch(request)`, response
   returned as-is (no fallback logic applies outside `/css/*` and `/js/*`).

This is why the Worker's routing is described as three tiers, not the simpler
"code handles `/api/contact`, ASSETS handles the rest" — `/css/*` and `/js/*`
also go through code, just for asset-fallback rather than business logic.

## 2. `/api/contact` — the hardened request pipeline

`worker/api/contact.ts` implements `handleContact(request, env, ctx)`, called
only for POST. In request order:

| Step | Check | Failure response |
|---|---|---|
| 1 | `Origin` header must equal `url.origin` exactly (missing Origin also fails) | `403 Forbidden` (plain text, `Cache-Control: no-store`) |
| 2 | `Content-Type` must start with `application/x-www-form-urlencoded` or `multipart/form-data` | `415 Unsupported media type` |
| 3 | Declared `Content-Length` > `MAX_FORM_BYTES` (32 KiB) | `413 Payload too large` (fast path) |
| 4 | Real byte count via `readBodyCapped()` > `MAX_FORM_BYTES` | `413` (stream cap — catches chunked uploads with no `Content-Length`) |
| 5 | `bot-field` present in the form (honeypot) | `303` → `/thank-you/` (pretend success; no upstream calls, nothing stored) |
| 6 | Field validation: name/message non-empty, email matches `EMAIL_RE`; `stripControl()` removes `\x00`–`\x1f`,`\x7f` from name/email first | `303` → `/contact-error/` |
| 7 | Turnstile token present | `303` → `/contact-error/` if missing |
| 8 | Per-IP rate limit (see below) | `303` → `/contact-error/` |
| 9 | Turnstile `siteverify` call succeeds | `303` → `/contact-error/` on any failure mode (see §3) |
| 10 | Insert into D1 `submissions`, send mail | see §2.1 |

Field caps (from `contact.ts`): `MAX_NAME_LEN=200`, `MAX_EMAIL_LEN=200`,
`MAX_MESSAGE_LEN=5000`, `MAX_FORM_BYTES=32*1024`.
`stripControl()` exists specifically so a newline in `name`/`email` can't
inject extra headers into the outbound email (verified by
`tests/worker/contact.test.ts` "strips control characters..." test, which
posts `name: 'Mallory\nBcc: x@evil.com'` and asserts the stored value has no
`\n`).

**Per-IP rate limit**: `RATE_LIMIT_MAX = 5` per `RATE_LIMIT_WINDOW_MS = 1h`
(3,600,000 ms), keyed on `request.headers.get('CF-Connecting-IP')`. If the IP
header is absent, rate limiting is skipped entirely (verified: "does not
rate-limit when CF-Connecting-IP is absent" test loops 10 requests and expects
all 10 to succeed). The counter is `SELECT COUNT(*) FROM contact_attempts
WHERE ip = ?1 AND ts > ?2`, and **every POST that reaches this check gets an
INSERT into `contact_attempts`** — including ones that go on to fail
Turnstile. This is deliberate: it counts attempts, not accepted submissions, so
repeatedly failing the Turnstile challenge doesn't buy unlimited free retries
against `siteverify`/D1 (verified by the "counts failed Turnstile attempts
toward the rate limit" test — 5 failed challenges, then a 6th request with a
*valid* token is still rejected, and the stub asserts `fetchSpy` was never
called for that 6th request, i.e. the rate limit fired before Turnstile was
even contacted).

### 2.1 Success path: D1 write, retention purge, mail

On acceptance: `INSERT INTO submissions (name, email, message, ip, ts) ...`,
then two `ctx.waitUntil()` background tasks kicked off **before** the response
is decided:

- **Retention purge**: `DELETE FROM submissions WHERE ts < ?1` for
  `ts < now - RETENTION_MS` (`RETENTION_MS = 90 * 86_400_000`, i.e. 90 days).
  There is no scheduled/cron Worker for this — the code comment states
  explicitly: *"Cloudflare's free Workers plan caps cron triggers per
  account, so we piggy-back on accepted submissions instead of using a
  scheduled handler."* This means retention pruning only happens when someone
  successfully submits the form; an idle site accumulates rows until the next
  real submission.
- **`contact_attempts` purge**: happens right after the rate-limit INSERT
  (step 8, not tied to acceptance) — `DELETE FROM contact_attempts WHERE ts <
  ?1` for `ts < now - RATE_LIMIT_WINDOW_MS`. Runs on every recorded attempt, so
  the table can't grow unbounded even if no submission is ever accepted.
- **Sender auto-reply** (`renderAutoReplyEmail`): fired via `ctx.waitUntil()`
  as best-effort — its failure never blocks or delays the redirect. `replyTo`
  is set to `env.CONTACT_TO` so a reply-to-the-autoreply still reaches the
  owner.
- **Owner notification** (`renderNotificationEmail`): sent synchronously
  (`await`ed) because its outcome decides the redirect target:
  - Send throws (network error) or `!res.ok` → `303` → `/thank-you/?delivery=delayed`
    (the D1 row is already safely stored, so the copy acknowledges receipt
    instead of inviting a duplicate resubmission).
  - Send succeeds → `303` → `/thank-you/`.

Both emails go through one chokepoint, `sendMail()`, which POSTs to
`https://api.forwardemail.net/v1/emails` with HTTP Basic auth
(`Authorization: Basic base64(FE_API_KEY + ':')`) and an
`AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` where `UPSTREAM_TIMEOUT_MS =
10_000` (10s) — the same constant used for the Turnstile call. This bounds
how long a hung upstream (ForwardEmail or Cloudflare's own siteverify) can
stall the Worker before the platform kills it.

Email templates (`worker/email/templates.ts`) share one inline-styled HTML
shell (`shell()`) so both messages look like michaellaplante.com — Material
Indigo `#3F51B5`, Poppins/Roboto Mono type. `esc()` HTML-escapes name/email/
message before interpolation (verified: "escapes HTML in the sender
name/message" test posts `<script>alert(1)</script>` and asserts it never
appears unescaped in the rendered HTML). This is a second, independent layer
of injection defense on top of `stripControl()` in contact.ts — `stripControl`
protects the email *headers* (replyTo/subject), `esc()` protects the email
*body* HTML.

## 3. Turnstile: fail-closed by design

`handleContact` POSTs `secret` (from `env.TURNSTILE_SECRET`), `response` (the
client's `cf-turnstile-response` token), and `remoteip` (if known) to
`https://challenges.cloudflare.com/turnstile/v0/siteverify`, capped at the same
10s `UPSTREAM_TIMEOUT_MS`. Every failure mode of this call is caught and routed
to the SAME outcome — reject via `/contact-error/` — never a bare 500 and
never a silent skip of verification:

- `siteverify` unreachable / throws (network error) → caught, rejected. Test:
  "fails closed (redirect, no stored row) when siteverify is unreachable"
  asserts `submissions` count stays `0`.
- `siteverify` returns non-JSON / malformed body (e.g. an HTML 502 gateway
  page) → `.json()` throws, caught, rejected. Test: "fails closed when
  siteverify returns a non-JSON body".
- `siteverify` returns valid JSON with `success: false` → rejected, error
  codes logged via `console.warn`.

## 4. D1: `contact-submissions` — schema, indexes, and a stale comment

D1 is Cloudflare's SQLite-at-the-edge product, bound here as `DB`
(`d1_databases[0].binding` in `wrangler.jsonc`, `database_name:
"contact-submissions"`). Schema lives in `worker/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT NOT NULL, message TEXT NOT NULL,
  ip TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_ts ON submissions (ts DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_ts ON submissions (ip, ts DESC);

CREATE TABLE IF NOT EXISTS contact_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_attempts_ip_ts ON contact_attempts (ip, ts DESC);
CREATE INDEX IF NOT EXISTS idx_contact_attempts_ts ON contact_attempts (ts DESC);
```

**Why two tables**: `submissions` holds accepted, stored contact-form
messages (what the owner reads and replies to). `contact_attempts` holds one
row per POST that reaches the Turnstile check — a lighter, higher-churn ledger
used only to enforce the rate limit (§2), independent of whether the
submission itself is ever accepted. Splitting them means the rate limit can
count failed/rejected attempts without bloating the message table, and the two
tables can be pruned on independent schedules (90 days vs. the 1h rate window).

**Verified discrepancy — schema.sql comment is stale.** The comment directly
above `idx_submissions_ip_ts` reads *"Used by per-IP rate limit lookup; covers
the (ip, ts > ?) predicate."* But `grep -rn "FROM submissions" worker/ tests/
scripts/ blog-src/` (run 2026-07-05) shows `submissions` is only ever read/
written by `ts`-range deletes, `COUNT(*)`, and a `SELECT ... WHERE email = ?1`
(test-only) — **no query anywhere in the repo filters `submissions` by
`ip`.** The rate-limit lookup actually described by that comment runs against
`contact_attempts` (`idx_contact_attempts_ip_ts`). Read this as an artifact of
the two-table split having been introduced after the comment was written, not
as a live bug — `idx_submissions_ip_ts` is otherwise harmless (D1 storage is
cheap, and no query result depends on it being wrong). **Do not delete or
"fix" the index/comment without going through resumesite-change-control** —
correctness isn't at stake here, so this is a documentation nit, not a hotfix.

**Opportunistic purge, not a cron Worker**: see §2.1 — both tables are pruned
inline on relevant requests, never via `wrangler.jsonc`'s `triggers.crons` (not
configured here) because of the free-plan cron-trigger cap noted in the
`contact.ts` comment.

## 5. `_headers`: how Cloudflare Pages/assets headers work here

`blog-src/public/_headers` is Astro's `public/` passthrough — it is copied
byte-for-byte into `dist/_headers` by the build, and Cloudflare's assets layer
reads that file to attach response headers per path pattern (this is the same
`_headers` convention Cloudflare Pages popularized; it applies here to the
`assets` block of `wrangler.jsonc`). Verified file contents, path patterns and
directives (2026-07-05):

**Global (`/*`)**: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(),
usb=(), interest-cohort=()`, plus a CSP (full allowlist owned by
resumesite-config-and-flags — the one invariant to know here is **`script-src`
has no `'unsafe-inline'`**, which is why `astro.config.mjs` sets
`vite.build.assetsInlineLimit: 0` on the Astro side; that build-time
consequence belongs to resumesite-astro-reference), and a baseline
`Cache-Control: public, max-age=0, must-revalidate` / `CDN-Cache-Control:
public, max-age=3600, stale-while-revalidate=86400`.

**Per-path overrides** (all verified in the file): `/_astro/*`, `/css/*`,
`/js/*`, `/fonts/*` → `max-age=31536000, immutable` (safe because these are
Astro/fingerprint-hashed filenames — content at a given URL never changes).
`/images/*`, `/og/*` → 30-day (`2592000`) `must-revalidate` with a 1-day
`stale-while-revalidate` on the CDN edge. `/favicon*`, `/apple-touch-icon.png`,
`/android-chrome-*.png`, `/site.webmanifest`, `/robots.txt`,
`/.well-known/security.txt` → 1–7 day, `must-revalidate`. `/blog/search.json`,
`/feed.json`, `/llms-full.txt`, `/resume.pdf` → short browser TTL (300s = 5min)
paired with a longer 1h `CDN-Cache-Control` + 1-day
`stale-while-revalidate` — these are dynamic-ish/user-facing surfaces where
the edge can serve slightly stale content while it revalidates, but a
browser shouldn't cache too long locally. `/llms.txt` → 1-day both.

**Meaning of the two header names**: `Cache-Control` governs what the
*browser* does. `CDN-Cache-Control` is a Cloudflare-specific override that lets
the edge cache differently (usually longer) than the browser — e.g.
`/blog/search.json`'s browser TTL is 5 minutes but the CDN can hold it for an
hour with a further day of `stale-while-revalidate` (serve the stale copy
immediately while refetching in the background).

**UNVERIFIED**: whether `_headers` directives for `/css/*` and `/js/*`
actually apply to responses that come back through the `run_worker_first`
worker-first routing path (§1) versus only to responses served directly from
the assets store without touching the Worker. The repo doesn't contain a test
or doc that settles this either way — if it matters for a specific change,
verify against a live deploy rather than assuming.

## 6. Testing model: real Workers runtime, not just mocks

`vitest.config.ts` defines three vitest **projects** in one config, and the
comment at the top of the file states the reason for the split directly:
*"Two projects so the Worker tests run inside a real Cloudflare Workers
runtime (miniflare-backed) with D1 bindings, while the shared blog-post lib
tests run in plain Node — they exercise filesystem and crypto APIs that
aren't available inside the Workers sandbox."*

| Project | Includes | Environment |
|---|---|---|
| `worker` | `tests/worker/**/*.test.ts` | `@cloudflare/vitest-pool-workers` (`^0.16.13` as of 2026-07-05) — real `workerd` runtime via miniflare |
| `lib` | `tests/lib/**/*.test.js` | plain Node (`environment: 'node'`) |
| `site` | `tests/site/**/*.test.ts` | plain Node; self-skips when `dist/` doesn't exist |

The `worker` project's miniflare config:

```ts
cloudflareTest({
  singleWorker: true,
  wrangler: { configPath: './wrangler.jsonc' },
  miniflare: {
    d1Databases: { DB: 'test-contact-submissions' },   // NOT the prod database_id
    bindings: {
      TURNSTILE_SECRET: 'test-turnstile-secret',
      FE_API_KEY: 'test-fe-api-key',
      CONTACT_FROM: 'test@example.com',
      CONTACT_TO: 'inbox@example.com',
    },
    compatibilityFlags: ['nodejs_compat'],
  },
})
```

Real binding config (`main`, `assets`, compat flags) is read straight from
`wrangler.jsonc`; only the D1 database name and the secret-shaped bindings are
overridden for the test run — **tests never touch prod D1 or real secrets**
(this is also one of the repo's standing discipline rules; see §7).

`tests/worker/contact.test.ts` hand-maintains a `TEST_SCHEMA_STATEMENTS` array
that mirrors `worker/schema.sql` verbatim, applied once in `beforeAll()`. The
comment explains why: *"the Workers sandbox can't read the host filesystem"*
— there's no way to point miniflare's D1 at the `.sql` file on disk, so the
two copies (`worker/schema.sql` and the inline array) must be kept in sync by
hand. **If you change `schema.sql`, you must also update this array or the
worker tests will run against a stale schema** — nothing enforces the two
stay identical except discipline.

`tests/worker/assets.test.ts` stubs the `ASSETS` binding directly (a plain
object with a `fetch()` that serves from a fixed `Record<string,string>`)
rather than exercising a real `dist/` build, "because the CI test job runs
without a production build" (comment in the file) — this is what lets the
`worker` vitest project run in the `test` CI job (no `npm run build`
dependency) while `site` project assertions (`tests/site/build-output.test.ts`)
only fire in the `site` CI job, which does build first.

Both `env` (the D1/binding proxy) and `createExecutionContext()` /
`waitOnExecutionContext()` come from the special `cloudflare:test` module,
which only resolves inside the `worker` vitest project — this is exactly why
`lib` and `site` tests must run in plain Node instead: they don't have (and
don't need) that module or the `workerd` sandbox, and conversely the worker
project can't do filesystem/crypto work the lib tests depend on.

## 7. Deploy verification: why it probes `workers.dev`, not the custom domain

`.github/workflows/purge-cloudflare-cache.yml` ("Deploy Status") runs on every
push to `master`, two jobs:

1. **`purge`**: `POST /zones/{zone}/purge_cache` with `{"purge_everything":true}`.
   Best-effort — if `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN` secrets
   aren't set, the step logs a notice and exits `0` rather than failing the
   job (edge cache just expires on its normal TTL instead). If the secrets
   ARE set but the API call doesn't return `"success":true`, the job fails.
2. **`verify`** (needs `purge`): curls the live site. The comment explains the
   host choice directly: *"the zone's bot protection challenges automated
   requests from CI runners with a 403 before they ever reach the Worker,
   while workers.dev sits outside the zone and hits the Worker directly."*
   Default probe host: `resumesite.laplantewebdevelopment.workers.dev`,
   overridable via the `DEPLOY_CHECK_HOST` repo **variable** (not a secret —
   Settings → Secrets and variables → Actions → Variables). Two checks, each
   retried 3× with a 10s backoff:
   - `GET https://$HOST/` expects `200` (static assets serving).
   - `GET https://$HOST/api/contact` expects `405` — proving the Worker
     itself is deployed and routing (a missing/broken Worker would 404/5xx
     instead, since there'd be no `main` script to return the router's own
     405).

This workflow's README badge doubles as a deploy-status badge — green means
both the purge (if configured) succeeded and the live Worker responded
correctly to both probes.

## When NOT to use this skill

- Astro build internals (astro.config.mjs, PurgeCSS, satori/resvg OG images,
  pdfkit résumé PDF, `assetsInlineLimit: 0`'s Astro-side cause) →
  **resumesite-astro-reference**.
- The day-to-day deploy runbook (`npm run worker:deploy`, `.dev.vars` setup,
  when to redeploy) → **resumesite-run-and-operate**.
- The CSP allowlist as a tunable knob, or any other env var / threshold
  inventory → **resumesite-config-and-flags**.
- The history/story of the F1 same-origin bypass bug → **resumesite-failure-archaeology**.
- Fresh-clone setup, `npm ci` in two places, `dist/` build pipeline →
  **resumesite-build-and-env**.
- Making an actual change to any of the above (headers, Worker logic, schema,
  rate limits) → still gated by **resumesite-change-control** (PR + green CI);
  nothing in this skill authorizes skipping that.

## Provenance and maintenance

Compiled 2026-07-05 from direct repo inspection (branch `skills`). Re-verify
with:

```bash
# Worker config / bindings
cat wrangler.jsonc

# Contact handler constants and pipeline order (re-read after any edit)
sed -n '1,30p' worker/api/contact.ts

# D1 schema + confirm the stale-comment discrepancy still holds
cat worker/schema.sql
grep -rn "FROM submissions\|submissions WHERE\|submissions (ip" worker/ tests/ scripts/ blog-src/

# _headers directives (copied verbatim into dist/_headers at build time)
cat blog-src/public/_headers

# Test-runtime versions (date-stamped 2026-07-05: @cloudflare/vitest-pool-workers ^0.16.13, vitest ^4.1.9)
grep -E '"@cloudflare/vitest-pool-workers"|"vitest"' package.json

# Confirm vitest project split + miniflare test D1 name/bindings
cat vitest.config.ts

# Confirm the hand-maintained schema mirror is still in sync with worker/schema.sql
sed -n '1,40p' tests/worker/contact.test.ts

# Deploy-check host + probe behavior
cat .github/workflows/purge-cloudflare-cache.yml

# wrangler is unpinned in package.json — confirm npx still resolves it at deploy time
grep -n '"wrangler"' package.json blog-src/package.json   # expect: no match (not a listed dependency)

# Full green baseline this skill was authored against
npm test        # 2026-07-05: Test Files 6 passed | 1 skipped (7); Tests 328 passed | 20 skipped (348)
npm run typecheck   # 2026-07-05: 0 errors, 0 warnings, 12 hints
```
