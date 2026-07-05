---
name: resumesite-run-and-operate
description: Runbook for running, previewing, and deploying resumesite (michaellaplante.com — Astro 6 + Cloudflare Worker + D1). Load this when asked to "start the dev server", "run the site locally", "preview the build", "test the contact form locally", "deploy", "why is /api/contact 404 in dev", "the worker isn't binding D1 locally", "what does npm run worker:dev do vs npm run dev", "generate a blog draft" / "run the blog pipeline manually", "what does the deploy badge mean", "purge the Cloudflare cache", or when you see `npx wrangler dev`, `npx wrangler deploy`, `.dev.vars`, `DEPLOY_CHECK_HOST`, `workers.dev`, or `generate-blog-post.yml` in a question. Covers: the three run modes and their real differences, what `npm run build` emits and where each artifact lands, how deploy actually happens (and what does NOT happen in CI), and how to invoke the AI blog-draft generator by hand. Does NOT cover first-time environment setup or the build pipeline internals (see resumesite-build-and-env), individual env var / tunable meanings (see resumesite-config-and-flags), measuring or verifying a running site (see resumesite-diagnostics-and-tooling), or the merge/PR rules (see resumesite-change-control) — this skill only runs things that already build cleanly.
---

# resumesite: Run & Operate

Zero-context runbook for actually running this site — locally, in preview, and
in production — plus how to fire the AI blog-draft generator by hand. Assumes
`npm ci` (root and `blog-src/`) has already succeeded; if not, use
`resumesite-build-and-env` first.

**Not this skill:**
- Fresh-clone setup, the `npm run build` pipeline internals, two-lockfile
  install order → `resumesite-build-and-env`.
- What an env var or tunable *means* / what value to set → `resumesite-config-and-flags`.
- Measuring performance, Lighthouse, verifying a deployed change → `resumesite-diagnostics-and-tooling`.
- Merge rules, PR gate, who reviews AI drafts before they publish → `resumesite-change-control`.
  **Nothing in this skill authorizes pushing straight to `master` or skipping
  review** — deploy commands below are about mechanics, not permission.

## 1. The three run modes — know the difference before you reach for one

| Command | Runs | Serves `/api/contact`? | D1 bound? | Port | Needs |
|---|---|---|---|---|---|
| `npm run dev` | `cd blog-src && npm run dev` → `astro dev` | **No** | No | `http://localhost:4321` | Nothing extra |
| `npm run worker:dev` | `npx wrangler dev` (repo root) | **Yes** | Yes (Miniflare-backed D1, binding `DB`) | wrangler's default (prints on start) | `.dev.vars` at repo root (see §4) |
| `npm run preview` | `cd blog-src && npm run preview` → `astro preview` | No | No | astro preview's default | A completed `npm run build` first (serves `dist/` as-is) |

Verified from root `package.json` (`"dev": "cd blog-src && npm run dev"`,
`"worker:dev": "npx wrangler dev"`, `"preview": "cd blog-src && npm run preview"`)
and `blog-src/package.json` (`"dev": "astro dev"`, `"preview": "astro preview"`).

**Pick by what you're testing:**
- Editing Astro pages/components/content, fast HMR, don't care about the
  contact form → `npm run dev`.
- Testing the contact form end-to-end (Turnstile, D1 write, rate limit,
  ForwardEmail call) or any `worker/` code → `npm run worker:dev`. This is the
  **only** local mode that serves `/api/contact` at all — hitting it under
  `npm run dev` gets you Astro's 404, not a routing decision from
  `worker/index.ts`.
- Sanity-checking the actual production artifact (fingerprinted asset names,
  PurgeCSS'd CSS, rendered OG images / résumé PDF) before trusting a deploy →
  `npm run build && npm run preview`. Note `astro preview` serves the static
  `dist/` only — it does **not** run `worker/index.ts`, so it won't reproduce
  the Worker's stale-asset-fallback behavior (see `resumesite-astro-reference`
  / `resumesite-cloudflare-reference` for that).

## 2. `worker:dev` setup (the one mode with a prerequisite)

`npx wrangler dev` binds the `DB` D1 database (per `wrangler.jsonc`:
`binding: "DB"`, `database_name: "contact-submissions"`) and needs the Worker
secrets available locally. Create `.dev.vars` **at the repo root** (same
directory as `wrangler.jsonc`, not inside `blog-src/`):

```
TURNSTILE_SECRET=...
FE_API_KEY=...
CONTACT_FROM=...
CONTACT_TO=...
```

These four names come straight from the `Env` interface in `worker/index.ts`.
There is no tracked `.dev.vars.example`; `blog-src/.env.example` is the only
checked-in template and its comments indicate which values belong in
`.dev.vars` instead of `blog-src/.env`. Full detail on which var goes where →
`resumesite-build-and-env` §4 and `resumesite-config-and-flags`.

`wrangler.jsonc` also sets `"run_worker_first": ["/api/*", "/css/*", "/js/*"]`
— under `worker:dev`, requests to those three path prefixes are routed through
`worker/index.ts` before falling back to the `ASSETS` binding (this is how the
stale-fingerprinted-asset fallback in `worker/index.ts` gets exercised even
locally).

## 3. Where build output lands (after `npm run build` — see `resumesite-build-and-env` for the pipeline itself)

All paths below are relative to the repo-root `dist/` (Astro's `outDir` is
`'../dist'` relative to `blog-src/astro.config.mjs`, and `build.format:
'directory'` means post/page URLs are directories with an `index.html`, i.e.
`/blog/some-post/` not `/blog/some-post.html`).

| Artifact | Path in `dist/` | Rendered by |
|---|---|---|
| Pages (home, blog, résumé, services, uses, etc.) | `index.html`, `blog/…/index.html`, `resume/index.html`, … | Astro (`output: 'static'`) |
| Per-post OG social card | `og/<slug>.png` | `blog-src/src/pages/og/[slug].png.ts` via satori + `@resvg/resvg-js`, at build time |
| Downloadable résumé PDF | `resume.pdf` | `blog-src/src/pages/resume.pdf.ts` via pdfkit, at build time — driven by the same `blog-src/src/data/resume.ts` that powers `/resume` and the homepage |
| Blog full-archive client search index | `blog/search.json` | `blog-src/src/pages/blog/search.json.ts` |
| RSS feed | `blog/rss.xml` | `blog-src/src/pages/blog/rss.xml.ts` (`@astrojs/rss`) |
| JSON Feed | `feed.json` | `blog-src/src/pages/feed.json.ts` |
| Machine-readable site summary | `llms.txt` | Static passthrough from `blog-src/public/llms.txt` (not a build-time route) |
| Machine-readable full content dump | `llms-full.txt` | `blog-src/src/pages/llms-full.txt.ts`, build-time |
| Sitemap | `sitemap-index.xml` + `sitemap-*.xml` | `@astrojs/sitemap` integration |
| Fingerprinted CSS/JS | `css/*.<10-hex>.css`, `js/*.<10-hex>.js` (originals kept alongside) | `blog-src/scripts/fingerprint-assets.mjs` (post-build stage; **lives under `blog-src/`, not repo-root `scripts/`** — confirmed by directory listing) |
| PurgeCSS-trimmed Bootstrap + `style.css` | in place, same filenames | `blog-src/scripts/purge-css.mjs` |

For *why* each of these exists and the exact build-stage ordering, see
`resumesite-astro-reference` and `resumesite-build-and-env`.

## 4. Deploy

```bash
npm run worker:deploy   # = npx wrangler deploy, from repo root
```

`wrangler deploy` uploads **both** the Worker (`worker/index.ts`, per
`wrangler.jsonc`'s `"main"`) and the built static assets (`dist/`, per
`"assets": { "directory": "dist", "binding": "ASSETS" }`) in one shot — there
is no separate "deploy static site" vs "deploy Worker" step. Run
`npm run build` first; `wrangler deploy` does not build for you.

**What CI does and does NOT do (verified by reading every workflow in
`.github/workflows/`):**
- `ci.yml` has exactly 3 jobs — `lint`, `test`, `site` (typecheck + build +
  build-output smoke test + Lighthouse). **None of them run `wrangler
  deploy`.** There is no `deploy.yml` in this repo (a historical one existed
  and is gone — do not go looking for it).
- `purge-cloudflare-cache.yml` (badge name in the README: "Deploy Status")
  fires `on: push: branches: [master]`. It does two things, in order:
  1. **`purge` job**: best-effort Cloudflare edge cache purge via the API
     (`purge_everything: true`). Skips cleanly (exits 0, does not fail the
     job) if `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_API_TOKEN` secrets aren't set
     — cached content just expires on its normal TTL instead.
  2. **`verify` job**: probes the *live* site — `GET /` expects `200`,
     `GET /api/contact` expects `405` (proves the Worker is deployed and
     routing, since a missing Worker would 404/5xx instead) — 3 attempts,
     10s apart, against `https://${DEPLOY_CHECK_HOST}`, default
     `resumesite.laplantewebdevelopment.workers.dev`. It deliberately probes
     the `*.workers.dev` host, not the custom domain — the zone's bot
     protection 403s the custom domain for CI runners. Override with the
     `DEPLOY_CHECK_HOST` **repository variable** (not a secret) if your
     account's default subdomain differs.
  - This workflow's README badge is described in the repo as "doubles as a
    deploy-status badge" — green means the *live site responds*, not that
    this workflow itself performed a deploy.

**UNVERIFIED — how the live Worker actually gets the new code after a push to
`master`:** no workflow file in this repo runs `wrangler deploy`. The most
likely explanation is Cloudflare's own dashboard-configured "Workers Builds"
git integration (build/deploy triggered directly by Cloudflare from the GitHub
push, outside `.github/workflows/`), which would not be visible in-repo. The
alternative is that `npm run worker:deploy` is run manually/locally after
merge. Confirm which is true by checking the Cloudflare dashboard → Workers &
Pages → this Worker → Settings → Build & deploy, before asserting either as
fact in downstream work.

## 5. Operating the AI blog-draft generator

There are **two separate mechanisms** that both produce a new post file —
know which one you're invoking:

| | Manual (`npm run blog:draft:*`) | Scheduled (`generate-blog-post.yml`) |
|---|---|---|
| Provider | Anthropic Claude, via `scripts/generate-post.js` (`ANTHROPIC_MODEL` env, default `claude-sonnet-4-20250514`) | Google Gemini, via `scripts/generate-post-gemini.js` (`GEMINI_MODEL: 'gemini-2.5-flash'`, hardcoded in the workflow) |
| Modes | `git`, `topic` only (**no `auto`** — `supportsAuto: false` in the script) | `auto` (default), `topic`, `git`, chosen by `workflow_dispatch` input or the cron default |
| Trigger | You, locally | Cron `0 8 * * *` (daily, UTC) **or** manual `workflow_dispatch` |
| Where it writes | `blog-src/src/content/posts/<generated-filename>` — **directly into `posts/`, not `drafts/`** | Same: `blog-src/src/content/posts/` |
| What makes it a "draft" | Nothing in the directory structure — it's an uncommitted local file until you commit/PR it yourself | The workflow's own `git checkout -b blog/draft-...` + `gh pr create`; the PR itself is the draft state |

```bash
npm run blog:draft:git                       # draft from recent git activity (last 7 days, DEFAULT_DAYS)
npm run blog:draft:topic -- "Your topic here"   # note the `--`: npm needs it to pass the arg through
```

Both require `ANTHROPIC_API_KEY` in your shell env (read by the SDK
directly — not a `.env`/`.dev.vars` file). Running `npm run blog:draft:topic`
with no topic argument (or without `--`) prints
`Usage: node scripts/generate-post.js topic "Your topic here"` and exits 1
(from `runGenerator` in `scripts/lib/blog-post.js`).

The scheduled workflow (`generate-blog-post.yml`):
1. Runs `node scripts/generate-post-gemini.js "$INPUT_MODE"` (or
   `... topic "$INPUT_TOPIC"` when dispatched with `mode: topic`).
2. If a new file under `blog-src/src/content/posts/` shows up in
   `git status --porcelain`, it sanitizes the extracted `title:` for shell
   safety, creates branch `blog/draft-<date>-<slug>`, commits, pushes, and
   opens a PR against `master` labeled `blog-draft`.
3. **The PR body says outright: "the post is written directly into `posts/`,
   so merging this PR publishes and deploys it to the site."** There is no
   separate promotion step for this pipeline — merge = publish. Reviewing and
   either merging or closing the PR is a change-control action; see
   `resumesite-change-control` for the review bar (this skill does not grant
   authority to merge it yourself without following that gate) and
   `resumesite-content-and-writing` for what a human reviewer should check in
   the draft's content.
4. `concurrency: group: blog-post-generator, cancel-in-progress: false` —
   guards against two runs (a cron tick racing a manual dispatch) opening
   duplicate PRs; it queues rather than cancels.

**Do not confuse this with the separate `blog-draft` skill** (`.claude/skills/blog-draft/`),
which is a Claude Code slash-command that summarizes the *current chat
session* into a post and saves it to `blog-src/src/content/drafts/` (a real
staging directory, excluded from the build by the content-collection loader
glob) — a third, distinct path to a new post, for a different input (a
session transcript, not git history or a topic string).

**Content-focus date gate (shared with the `blog-draft` skill, expires
2026-08-12):** while `FOCUS_UNTIL = '2026-08-12'` is still in the future
(checked against the actual clock at generation time, in
`scripts/lib/blog-post.js`), both pipelines' system prompt is skewed toward
cybersecurity + AI-governance-in-security topics. After that date it reverts
automatically to the general prompt — no code change needed, but if you're
reading this after 2026-08-12, verify it actually reverted (see Provenance
below) before assuming this paragraph still applies.

## 6. Quick reference — commands in this skill

```bash
npm run dev                                   # Astro only, :4321, no worker/api
npm run worker:dev                            # wrangler dev = static + /api/contact, needs .dev.vars
npm run build && npm run preview              # build then serve dist/ as-is (no worker)
npm run worker:deploy                         # wrangler deploy — Worker + assets together
npm run blog:draft:git                        # Anthropic, from git log, writes to content/posts/
npm run blog:draft:topic -- "Topic string"    # Anthropic, on a topic, writes to content/posts/
```

## When NOT to use this skill (and where to go instead)

- First-time environment setup or the internals of the `npm run build` pipeline → **`resumesite-build-and-env`**.
- The meaning/default/guard of an individual env var or tunable (`TURNSTILE_SECRET`, `DEPLOY_CHECK_HOST`, `FOCUS_UNTIL`, thresholds) → **`resumesite-config-and-flags`**.
- Measuring or verifying a running/built site (Lighthouse, tests, dedupe audit) → **`resumesite-diagnostics-and-tooling`**.
- Whether a change is allowed to ship / PR + CI gating → **`resumesite-change-control`**.
- Why the Worker/edge is shaped this way (D1, `_headers`, Turnstile) → **`resumesite-cloudflare-reference`**.

This skill only runs things that already build cleanly; it does not decide *whether* they should ship.

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of this worktree (branch `skills`):
`package.json`, `blog-src/package.json`, `README.md`, `wrangler.jsonc`,
`worker/index.ts`, `blog-src/astro.config.mjs`, `.github/workflows/ci.yml`,
`.github/workflows/generate-blog-post.yml`,
`.github/workflows/purge-cloudflare-cache.yml`, `scripts/generate-post.js`,
`scripts/lib/blog-post.js`, `blog-src/src/pages/**` (directory listing +
`resume.pdf.ts` header comment), `blog-src/public/` (llms.txt presence).

**Known discrepancy vs. README:** the README's workflow table describes
`generate-blog-post.yml`'s trigger as "Manual / Mon-Wed-Fri" and says it uses
"Gemini and open[s] a PR". The actual workflow file's cron is
**`0 8 * * *` (daily)** with an explanatory comment ("daily drafting is safe
again"), confirmed by reading the YAML directly. The file wins; treat the
README's cadence text as stale.

| Claim | Re-verify with |
|---|---|
| `dev` / `worker:dev` / `preview` command bodies | `cat package.json` (`.scripts`); `cat blog-src/package.json` (`.scripts`) |
| Worker doesn't run under `astro dev`/`preview` | `grep -n "'/api/contact'" worker/index.ts` — routing only exists in the Worker, which only `wrangler dev`/`wrangler deploy` invoke |
| `.dev.vars` location + required keys | `grep -n "interface Env" -A 6 worker/index.ts`; confirm no tracked `.dev.vars.example` via `git ls-files \| grep dev.vars` |
| `run_worker_first` paths | `cat wrangler.jsonc` |
| Build output artifact list | `ls blog-src/src/pages blog-src/src/pages/og blog-src/src/pages/blog`; `cat blog-src/src/pages/resume.pdf.ts \| head -6` |
| No `wrangler deploy` in any workflow | `grep -rl "wrangler deploy" .github/workflows/` (expect no matches) |
| `purge-cloudflare-cache.yml` purge/verify behavior + `DEPLOY_CHECK_HOST` default | `cat .github/workflows/purge-cloudflare-cache.yml` |
| `generate-blog-post.yml` actual cron + provider script | `cat .github/workflows/generate-blog-post.yml` (look for `cron:` and `generate-post-gemini.js`) |
| Anthropic script has no `auto` mode | `grep -n "supportsAuto" scripts/generate-post.js` |
| Manual pipeline writes to `content/posts/` not `content/drafts/` | `grep -n "Post saved" scripts/lib/blog-post.js` |
| `FOCUS_UNTIL` date gate value + revert behavior | `grep -n "FOCUS_UNTIL" scripts/lib/blog-post.js` |
| CI has no deploy job | `sed -n '1,20p' .github/workflows/ci.yml` (job names: `lint`, `test`, `site`) |
