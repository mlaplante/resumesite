---
name: resumesite-config-and-flags
description: Exhaustive catalog of every configuration knob in resumesite — secrets/env vars (TURNSTILE_SECRET, FE_API_KEY, CONTACT_FROM, CONTACT_TO, ANTHROPIC_API_KEY, GEMINI_API_KEY, GITHUB_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN, DEPLOY_CHECK_HOST, PUBLIC_TURNSTILE_SITE_KEY), code tunables and their defaults/guards (SEMANTIC_THRESHOLD, DUPLICATE_THRESHOLD, PICK_TOPIC_MAX_ATTEMPTS, DEFAULT_DAYS, FOCUS_UNTIL date-gate, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, RETENTION_MS, MAX_FORM_BYTES, MAX_NAME_LEN, MAX_EMAIL_LEN, MAX_MESSAGE_LEN, CAL_LINK), and build/CI config (assetsInlineLimit, wrangler.jsonc bindings, lighthouserc.json thresholds, _typos.toml, eslint.config.js). Load this when asked "where is X configured", "what's the default for Y", "what env var do I need", "how do I add a new flag/threshold", "why did the contact form / dedupe / rate limit / lighthouse gate do that", or when a `.env`/`.dev.vars`/secret is missing and something is silently misbehaving. Do NOT use this for WHY an invariant must hold (see resumesite-architecture-contract) or for HOW to run/deploy things (see resumesite-run-and-operate) — this skill is the knob catalog only.
---

# resumesite — Configuration & Flags Catalog

You are the reference for every tunable, secret, and gate in this repo. If someone
asks "what does X default to" or "where do I set Y", the answer is in this file —
if it isn't, that's a gap to fix here, not to answer from memory.

**Scope boundary:** this skill lists *what* each knob is, its default, where it
lives, and what breaks if it's wrong. It does not explain the *why* behind an
architectural invariant (that's `resumesite-architecture-contract`) and it does
not walk through running dev servers or deploying (that's `resumesite-run-and-operate`).
Any change to a flag that affects prod behavior still needs a green-CI PR — see
`resumesite-change-control`. Nothing here authorizes skipping that.

All facts below were verified directly against the repo on **2026-07-05**
(branch `skills`). Re-verification commands are in the last section — run them
before trusting a number here if you suspect drift.

---

## 1. Secrets & environment variables

Two separate places hold config: **`blog-src/.env`** (Astro build-time, only
`PUBLIC_*` keys are exposed to client bundles) and **`.dev.vars`** (Worker
runtime secrets for `wrangler dev`, gitignored, no example file is tracked).
Production Worker secrets are set with `wrangler secret put <NAME>`. GitHub
Actions secrets/vars are set under Settings → Secrets and variables → Actions.

| Name | Where set | Consumer | Default if unset | What breaks if missing |
|---|---|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | `blog-src/.env` (local); must be present in whatever env runs `npm run build` before a production deploy | `blog-src/src/pages/index.astro:416` (`import.meta.env.PUBLIC_TURNSTILE_SITE_KEY`) | none (undefined) | Turnstile widget renders with an empty `data-sitekey` — captcha never issues a token, so every real contact-form submission fails `!token` in the Worker and bounces to `/contact-error/`. **CI never sets this** (see `ci.yml` — no such env is exported), so the `site` job's build/Lighthouse pass regardless; this is a prod-only footgun. |
| `TURNSTILE_SECRET` | `.dev.vars` (dev) / `wrangler secret put TURNSTILE_SECRET` (prod); test value `'test-turnstile-secret'` in `vitest.config.ts` | `worker/api/contact.ts` → siteverify call | none | Empty/wrong secret → Cloudflare siteverify returns `success:false` → every submission rejected as `'turnstile'` (fails **closed**, not open — no spam gets through, but no legitimate mail does either). |
| `FE_API_KEY` | `.dev.vars` / `wrangler secret put FE_API_KEY` | `worker/api/contact.ts` `sendMail()` → ForwardEmail Basic auth | none | Wrong/missing key → ForwardEmail returns non-2xx → submission is still stored in D1, but both the owner notification and sender auto-reply fail. User sees `/thank-you/?delivery=delayed`; nothing loud fires — check Worker logs (`console.error('ForwardEmail failed', ...)`). |
| `CONTACT_FROM` | `.dev.vars` / `wrangler secret put CONTACT_FROM` | `worker/api/contact.ts` mail `from` | none | Missing/invalid sender → ForwardEmail rejects the send the same way as a bad API key (delayed-delivery path, submission still recorded). |
| `CONTACT_TO` | `.dev.vars` / `wrangler secret put CONTACT_TO` | `worker/api/contact.ts` mail `to` (owner notification) + `replyTo` on the auto-reply | none | Owner never receives the notification email even though ForwardEmail accepts the send (wrong destination) — silent data loss, no error surfaced. |
| `ANTHROPIC_API_KEY` | shell env only — **no dotenv loading** in `scripts/generate-post.js`; the Anthropic SDK reads `process.env` directly | `scripts/generate-post.js` (used by `npm run blog:draft:git` / `blog:draft:topic`, manual/local only — not wired into any GitHub Actions workflow) | none | SDK throws at construction/call time; draft generation fails immediately. |
| `ANTHROPIC_MODEL` | shell env (optional) | `scripts/generate-post.js:17` | `'claude-sonnet-4-20250514'` | n/a — just changes which model drafts are generated with. |
| `GEMINI_API_KEY` | GitHub Actions secret | `scripts/generate-post-gemini.js` — **this is the provider `generate-blog-post.yml` actually calls** (daily cron + manual dispatch) | none | Script exits 1 immediately; the daily draft-PR workflow produces no draft that day (no error surfaced beyond the Action run failing). |
| `GEMINI_MODEL` | hardcoded `'gemini-2.5-flash'` in `generate-blog-post.yml:54`; also overridable as a plain env var | `scripts/generate-post-gemini.js:20` | `'gemini-2.5-flash'` | n/a |
| `GEMINI_FALLBACK_MODELS` | shell env (optional) | `scripts/generate-post-gemini.js:21` | `'gemini-2.0-flash,gemini-2.5-flash-lite'` | n/a — comma-separated fallback chain tried on retryable HTTP errors (429/500/502/503/504). |
| `GEMINI_EMBED_MODEL` | shell env (optional) | `scripts/generate-post-gemini.js:24` | `'text-embedding-004'` | n/a — used for semantic dedupe embeddings. |
| `GITHUB_TOKEN` | provided automatically in Actions; also used by `generate-blog-post.yml`'s PR-creation step | `scripts/generate-post-gh-models.js` (GitHub Models provider) — **UNVERIFIED as currently wired into any scheduled workflow; grep confirms no workflow invokes this script today, so treat it as a candidate/manual-only provider, not part of the live pipeline** | none | Script exits with an explicit error if absent. |
| `GH_MODEL` | shell env (optional) | `scripts/generate-post-gh-models.js:22` | `'openai/gpt-4.1'` | n/a |
| `GH_EMBED_MODEL` | shell env (optional) | `scripts/generate-post-gh-models.js:23` | `'openai/text-embedding-3-small'` | n/a |
| `SEMANTIC_THRESHOLD` | shell/CI env (optional) | `scripts/lib/blog-post.js:27` | `0.85` | See §2 — controls how aggressively the AI-draft dedupe rejects near-duplicate topics. |
| `CLOUDFLARE_ZONE_ID` | GitHub Actions **secret** | `.github/workflows/purge-cloudflare-cache.yml:25` | none | If either this or `CLOUDFLARE_API_TOKEN` is unset, the purge step **skips itself on purpose** (`echo "::notice::..."; exit 0`) — does not fail the job. Edge cache just expires on its normal TTL instead of being purged immediately after deploy. |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions **secret** | same workflow, line 26 | none | Same graceful-skip behavior as above. |
| `DEPLOY_CHECK_HOST` | GitHub Actions **repository variable** (not secret) — Settings → Secrets and variables → Actions → Variables | `.github/workflows/purge-cloudflare-cache.yml:67` | `'resumesite.laplantewebdevelopment.workers.dev'` | The `verify` job probes this host directly (workers.dev, not the custom domain) because the zone's bot protection 403s CI runners hitting the custom domain. Wrong host → the deploy-status check fails even though the real site is fine. |

**Deploy note (not owned by this skill, flagging so you don't chase a ghost):**
no workflow in `.github/workflows/` runs `wrangler deploy`. Deployment is
manual/out-of-band; `purge-cloudflare-cache.yml` only purges cache + verifies
*after* a push to `master`, assuming a deploy already happened elsewhere. See
`resumesite-run-and-operate` for the actual deploy command.

---

## 2. Code tunables (defaults, location, guard)

| Constant | Default | Location | Env override? | Guard / what enforces it |
|---|---|---|---|---|
| `SEMANTIC_THRESHOLD` | `0.85` | `scripts/lib/blog-post.js:27` | Yes — `process.env.SEMANTIC_THRESHOLD` | Cosine similarity ≥ threshold between a candidate topic/post embedding and any existing post (title+excerpt) → rejected as a duplicate. Used in both `pickUniqueTopic` (topic-selection loop) and the final post-generation re-check in `runGenerator`. |
| `DUPLICATE_THRESHOLD` | `0.5` | `scripts/lib/blog-post.js:23` | No | Lexical Jaccard-overlap fallback used only when no `embed` adapter is supplied or the embedding call throws — degrades gracefully instead of aborting the whole pipeline. |
| `PICK_TOPIC_MAX_ATTEMPTS` | `4` | `scripts/lib/blog-post.js:28` | No | `pickUniqueTopic()` retries the LLM topic-suggestion call this many times before throwing `Could not find a sufficiently unique topic after 4 attempts.` |
| `DEFAULT_DAYS` | `7` | `scripts/lib/blog-post.js:21` | No (function param, not read from env) | Window `getGitLog()` looks back for `git log --since=...` in `git`-mode draft generation. |
| `FOCUS_UNTIL` | `'2026-08-12'` | `scripts/lib/blog-post.js:39` | No | **EXPERIMENTAL / date-gated, auto-reverting.** While `focusActive(today)` is true, `activeSystemPrompt()` and `topicPickerPrompt()` steer every AI-generated draft toward cybersecurity + AI-governance-in-security topics (`FOCUS_SYSTEM_PROMPT`, lines 45–46). After 2026-08-12 it silently reverts to the general `SYSTEM_PROMPT` (line 31) — no manual cleanup required, no flag to flip. This is the same gate `blog-draft/SKILL.md` documents; see `resumesite-blog-quality-campaign` for the campaign context. |
| `RATE_LIMIT_MAX` | `5` | `worker/api/contact.ts:14` | No | Max attempts per IP per window, counted in D1 `contact_attempts` (every POST that reaches the Turnstile check, not just accepted submissions — see contact.ts:170-171 comment). Enforced in `handleContact()` before the siteverify call. |
| `RATE_LIMIT_WINDOW_MS` | `60 * 60 * 1000` (1 hour) | `worker/api/contact.ts:15` | No | Sliding window for the above; `since = now - RATE_LIMIT_WINDOW_MS`. |
| `RETENTION_MS` | `90 * 86_400_000` (90 days) | `worker/api/contact.ts:17` | No | Opportunistic purge of `submissions` older than this, run via `ctx.waitUntil` on every **accepted** request (no cron — Cloudflare's free plan caps cron triggers, so purge piggybacks on traffic instead). |
| `MAX_NAME_LEN` | `200` | `worker/api/contact.ts:18` | No | Hard `.slice()` cap on the `name` field before storage/email. |
| `MAX_EMAIL_LEN` | `200` | `worker/api/contact.ts:19` | No | Hard `.slice()` cap on `email` before the `EMAIL_RE` regex check. |
| `MAX_MESSAGE_LEN` | `5000` | `worker/api/contact.ts:20` | No | Hard `.slice()` cap on `message`. |
| `MAX_FORM_BYTES` | `32 * 1024` (32 KiB) | `worker/api/contact.ts:21` | No | Enforced **twice**: fast-reject on the client-supplied `Content-Length` header (line 133), then a hard cap on the real byte stream via `readBodyCapped()` (line 52) since `Content-Length` is client-controlled and absent on chunked bodies. Either path → `413`. |
| `UPSTREAM_TIMEOUT_MS` | `10_000` (10s) | `worker/api/contact.ts:24` | No | `AbortSignal.timeout()` on both the Turnstile siteverify fetch and every `sendMail()` call — caps how long a hung upstream can stall the request. |
| `CAL_LINK` | `'mlaplante'` | `blog-src/src/config.ts:16` | No | Cal.com booking handle used by the inline scheduler on `/services`. **Setting it to `''` hides all booking UI** — this is the documented "no account yet" escape hatch, per the inline comment. |

Content-schema caps (not runtime tunables, but drift the same way — `blog-src/src/content.config.ts`):
`title` 1–200 chars, `excerpt` 1–300 chars (also doubles as meta/OG description),
`category` min 1 char, `tags` defaults to `[]`, `series` min 1 char (optional),
`seriesOrder` optional number. Enforced by Zod at build/typecheck time via
`npm run typecheck` and `npm run build` — a violating post/draft fails the
`site` CI job.

---

## 3. Build / site config

| Knob | Value | Location | Notes |
|---|---|---|---|
| `vite.build.assetsInlineLimit` | `0` | `blog-src/astro.config.mjs:27` | **DO NOT change this alone.** It exists solely because the CSP in `blog-src/public/_headers` has no `'unsafe-inline'` in `script-src`; Astro's default 4KB inline threshold would otherwise embed small `<script type="module">` blocks inline and the CSP would block them at runtime, silently. Any change here must be reasoned about together with the CSP — see `resumesite-architecture-contract` for the invariant and `resumesite-cloudflare-reference` for `_headers` mechanics. |
| `output` / `build.format` | `'static'` / `'directory'` | `astro.config.mjs:8,10` | Static output, directory-style URLs (`/foo/` not `/foo.html`). |
| `outDir` | `'../dist'` | `astro.config.mjs:6` | Astro emits outside `blog-src/`, to the repo-root `dist/` that `wrangler.jsonc`'s `assets.directory` points at. |
| `prefetch.defaultStrategy` | `'viewport'` | `astro.config.mjs:13` | Prefetches links as they enter the viewport. |
| `image.service.entrypoint` | `astro/assets/services/sharp` | `astro.config.mjs:17` | Sharp-based image service for the `<Image />` component / OG rendering pipeline. |
| `markdown.shikiConfig.themes` | `{ light: 'github-light', dark: 'github-dark' }`, `wrap: true` | `astro.config.mjs:32-37` | Code-block syntax highlighting themes for posts. |
| `integrations` | `[sitemap()]` | `astro.config.mjs:20` | `@astrojs/sitemap`, defaults (no custom filter/changefreq config). |
| `wrangler.jsonc` `compatibility_date` | `'2026-04-17'` | `wrangler.jsonc:4` | Bumping this is a deliberate, tested change — see `resumesite-cloudflare-reference`. |
| `wrangler.jsonc` `compatibility_flags` | `['nodejs_compat']` | `wrangler.jsonc:5` | Required for Node-API usage in the Worker/build toolchain. |
| `wrangler.jsonc` `assets.run_worker_first` | `['/api/*', '/css/*', '/js/*']` | `wrangler.jsonc:13` | `/css/*` and `/js/*` route through the Worker (not straight to `ASSETS`) so a fingerprinted-filename 404 from a stale cached HTML page can fall back to the current asset — see `worker/index.ts`'s `HASHED_ASSET` regex fallback. |
| `wrangler.jsonc` `d1_databases[0]` | binding `DB`, name `contact-submissions`, id `7d630334-b908-4819-bd9f-2ec6ff05c4e8` | `wrangler.jsonc:18-24` | Production D1. Tests use a separate binding (`test-contact-submissions`, `vitest.config.ts`) — tests never touch this one. |
| Lighthouse audited URLs | `/index.html`, `/blog/index.html`, `/blog/hello-world/index.html`, `/services/index.html`, `/resume/index.html` (against `http://localhost/...` over `staticDistDir: ./dist`) | `lighthouserc.json:5-11` | `numberOfRuns: 1`. |
| Lighthouse assertions | `accessibility` → **error** if `minScore < 0.9`; `performance`/`best-practices`/`seo` → **warn** if `< 0.8` / `< 0.9` / `< 0.9` | `lighthouserc.json:19-22` | **Accessibility is the only hard-blocking category** — a PR fails CI (`ci.yml` `site` job) only on an a11y regression below 0.90; the others just warn. See `resumesite-validation-and-qa` for how this gate is exercised. |
| `_typos.toml` extend-words | `aks`, `cose`, `counterfit`, `hashi`, `hav`, `shure`, `sie`, `unparseable` | `_typos.toml:12-19` | Spell-check allowlist for `crate-ci/typos` (`typos.yml` CI job). Add an entry here (with a one-line justification comment) rather than rewording copy around a false positive. |
| `_typos.toml` extend-exclude | `package-lock.json`, `blog-src/package-lock.json` | `_typos.toml:5-8` | Lockfiles are never spell-checked. |
| `eslint.config.js` ignores | `dist/**`, `node_modules/**`, `blog-src/node_modules/**`, `blog-src/public/css/**`, `blog-src/.astro/**`, `.wrangler/**` | `eslint.config.js:8-15` | |
| `eslint.config.js` file-group overrides | (1) Node ESM: `scripts/**`, `blog-src/scripts/**`, `tests/**`, root config files → `globals.node`. (2) `worker/**/*.ts` → `globals.serviceworker`. (3) `blog-src/public/js/**/*.js` → `sourceType: 'script'` + `globals.browser` (classic scripts, not modules — do not add `type="module"` or an `import`/`export` to these files without also changing this group). (4) `blog-src/src/**/*.{ts,astro}` → `globals.browser`. | `eslint.config.js:22-53` | |

---

## 4. How to add a new flag/knob — checklist

1. **Pick a home.** Secret or environment-dependent value → env var (`.env` for
   `PUBLIC_*` client-exposed Astro values, `.dev.vars`/`wrangler secret put`
   for Worker secrets, a GitHub Actions secret/variable for CI-only values).
   Everything else → an exported `const` colocated with its only consumer
   (see `SEMANTIC_THRESHOLD` and the `RATE_LIMIT_*` family above as the house
   pattern — a named const with an inline comment explaining the *reasoning*
   behind the number, not just its value).
2. **Choose a default that fails safe.** Follow the existing pattern: a
   missing/wrong Turnstile secret rejects every submission (fail closed); a
   missing rate-limit or size cap would fail *open* — don't add a knob whose
   unset state removes a guard. If the new knob gates a security control,
   its default absence must deny, not allow.
3. **Document it** — add a row to the correct table in this file, **and** to
   the README's `### Environment Variables` table if it's a secret/env var a
   human needs to set locally.
4. **Add a guard or test.** Threshold-like consts need a test asserting the
   boundary behavior (see `tests/lib/blog-post.test.js` for the dedupe
   threshold tests as the template). Env vars consumed by the Worker need a
   value in `vitest.config.ts`'s test bindings so `tests/worker/*.test.ts`
   can exercise the path.
5. **Gate the change via change-control** — no direct pushes to `master`;
   open a PR, keep CI green (lint + test + site jobs; accessibility ≥ 0.90 is
   the one hard Lighthouse gate). See `resumesite-change-control`.
6. **Date-stamp anything volatile.** If the knob is a temporary experiment
   (like `FOCUS_UNTIL`), give it an explicit expiry/revert condition in code,
   not just a comment saying "remove this later" — `FOCUS_UNTIL` is the
   template: the code itself reverts behavior once the date passes, no
   manual follow-up PR required.

---

## 5. Re-verify flags (things here that drift)

Run these before trusting a specific number in this file — thresholds and
consts get retuned as the AI-draft pipeline and contact-form hardening
evolve.

```bash
# Blog-draft dedupe thresholds + date-gate + retry counts
grep -n "SEMANTIC_THRESHOLD\|DUPLICATE_THRESHOLD\|PICK_TOPIC_MAX_ATTEMPTS\|DEFAULT_DAYS\|FOCUS_UNTIL" scripts/lib/blog-post.js

# Contact-form rate limit / retention / size caps / timeout
grep -n "RATE_LIMIT_MAX\|RATE_LIMIT_WINDOW_MS\|RETENTION_MS\|MAX_NAME_LEN\|MAX_EMAIL_LEN\|MAX_MESSAGE_LEN\|MAX_FORM_BYTES\|UPSTREAM_TIMEOUT_MS" worker/api/contact.ts

# Site identity / booking-link kill switch
grep -n "SITE_URL\|CAL_LINK\|BLOG_TITLE\|BLOG_DESCRIPTION" blog-src/src/config.ts

# CSP <-> assetsInlineLimit pairing (must change together, never alone)
grep -n "assetsInlineLimit" blog-src/astro.config.mjs
grep -n "script-src" blog-src/public/_headers

# Wrangler bindings / compat date / D1 name+id
grep -n "compatibility_date\|compatibility_flags\|run_worker_first\|database_name\|database_id" wrangler.jsonc

# Lighthouse thresholds (accessibility is the only hard-fail category)
grep -n "minScore" lighthouserc.json

# Which env vars each draft-generator script actually reads
grep -n "process.env\." scripts/generate-post.js scripts/generate-post-gemini.js scripts/generate-post-gh-models.js

# Which secrets/vars the workflows consume
grep -n "secrets\.\|vars\." .github/workflows/*.yml

# Confirm which generator the daily cron actually invokes (provider can change)
grep -n "generate-post" .github/workflows/generate-blog-post.yml

# Content-schema caps (Zod)
grep -n "z\.string\|z\.number\|min(\|max(" blog-src/src/content.config.ts

# Full current README env-var table (cross-check against §1 above)
grep -n -A8 "### Environment Variables" README.md
```

---

## Provenance and maintenance

Compiled 2026-07-05 against the `skills` branch by direct file inspection
(no assumptions carried over from any prior digest without opening the
source). Key facts and the exact command to re-check each:

- **`SEMANTIC_THRESHOLD` = 0.85, env-overridable; `DUPLICATE_THRESHOLD` = 0.5; `PICK_TOPIC_MAX_ATTEMPTS` = 4; `DEFAULT_DAYS` = 7; `FOCUS_UNTIL` = 2026-08-12** — re-verify: `grep -n "SEMANTIC_THRESHOLD\|DUPLICATE_THRESHOLD\|PICK_TOPIC_MAX_ATTEMPTS\|DEFAULT_DAYS\|FOCUS_UNTIL" scripts/lib/blog-post.js`. **`FOCUS_UNTIL` auto-reverts after 2026-08-12 — re-check this file after that date, the "focus" framing in this skill goes stale.**
- **Contact-form consts** (`RATE_LIMIT_MAX`=5, `RATE_LIMIT_WINDOW_MS`=1h, `RETENTION_MS`=90d, `MAX_FORM_BYTES`=32KiB, `MAX_NAME_LEN`/`MAX_EMAIL_LEN`=200, `MAX_MESSAGE_LEN`=5000, `UPSTREAM_TIMEOUT_MS`=10s) — re-verify: `grep -n "^const \(RATE_LIMIT\|RETENTION\|MAX_\|UPSTREAM_TIMEOUT\)" worker/api/contact.ts`.
- **The daily draft workflow calls the Gemini provider (`generate-post-gemini.js`), not Anthropic** — verified via `grep -n "generate-post" .github/workflows/generate-blog-post.yml`. `ANTHROPIC_API_KEY` is only for the manual local `npm run blog:draft:git`/`blog:draft:topic` commands. `GEMINI_API_KEY` is the one that actually gates the automated cron.
- **`scripts/generate-post-gh-models.js` (GitHub Models / `GITHUB_TOKEN`) is not invoked by any workflow today** — verified via `grep -rn "generate-post" .github/workflows/*.yml package.json`; treat as a manual/candidate provider until a workflow references it.
- **CI never sets `PUBLIC_TURNSTILE_SITE_KEY`** — verified via `grep -n "PUBLIC_TURNSTILE" .github/workflows/ci.yml` (no match). This means the `site` CI job's build/Lighthouse pass is not a signal that the real Turnstile widget works in production.
- **No workflow runs `wrangler deploy`** — verified via `grep -rln "wrangler deploy" .github/workflows/*.yml` (no match, as of this writing). If a deploy workflow is added later, this skill's §1 deploy-note goes stale — re-run that grep.
- **`assetsInlineLimit: 0` pairs with the no-`'unsafe-inline'` CSP** — re-verify both sides move together: `grep -n assetsInlineLimit blog-src/astro.config.mjs` and `grep -n script-src blog-src/public/_headers`.
- **Lighthouse: only `categories:accessibility` is `"error"`; perf/best-practices/seo are `"warn"`** — re-verify: `grep -n "minScore\|\"error\"\|\"warn\"" lighthouserc.json`.
- **`npm test` baseline 328 passed / 20 skipped (348 total), `npm run typecheck` 0 errors/12 hints, `npm run lint` clean** — these are cited elsewhere in this skill set as context, not restated as a hard number here since this skill doesn't own the test-count fact; re-check via `npm test` / `npm run typecheck` / `npm run lint` if you need current numbers (do **not** run `npm run build`, it deletes files and writes `dist/`).
