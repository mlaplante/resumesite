---
name: resumesite-build-and-env
description: Recreate the resumesite development environment from a fresh clone and produce a correct `dist/` build. Use when you see any of — "npm ci" questions, "two node_modules", "which lockfile", fresh clone / onboarding, `npm run build` failing or behaving oddly, `astro build` errors, `find blog-src/src -name 'CLAUDE.md' -delete` in the build log, PurgeCSS stripping styles that should exist, `fingerprint-assets: no references rewritten` error, missing `.env` / `.dev.vars` / `PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` / `FE_API_KEY`, "vitest Proxy environment variables detected" warning, or any "how do I set this repo up" / "green npm test" / "green typecheck" request. Covers setup and the build pipeline ONLY — not running/previewing/deploying the built site (see resumesite-run-and-operate) and not the meaning of individual config knobs/env vars (see resumesite-config-and-flags).
---

# resumesite: Build & Environment

Zero-context runbook to go from a fresh `git clone` to a green `npm test` +
`npm run typecheck`, and to understand exactly what `npm run build` does and
where it can bite you. This skill is setup + build only.

**Not this skill:**
- Running the dev server, `wrangler dev`, previewing, or deploying →
  `resumesite-run-and-operate`.
- What an env var or tunable *means* / what value to set it to →
  `resumesite-config-and-flags`.
- Architecture invariants (e.g. why CSP requires `assetsInlineLimit: 0`) →
  `resumesite-architecture-contract`.
- Anything requiring a merge to `master` → `resumesite-change-control` (PR +
  green CI is mandatory; nothing here authorizes skipping it).

## 1. Prerequisites

| Requirement | Verified value | How to check |
|---|---|---|
| Node.js | **22+** (CI pins `node-version: 22`; README says "Node.js 22+ (required for Astro 6)") | `node -v` |
| npm | ships with Node | `npm -v` |
| Git | any recent version | `git --version` |
| Cloudflare account + `wrangler` | only needed for `worker:dev` / `worker:deploy`, not for build/test | n/a |

There is **no `.nvmrc` and no `engines` field** in either `package.json` — verified
by inspection (2026-07-05). Node version discipline is enforced only by CI and
by this doc, not by tooling. Don't assume `nvm use` will auto-select anything.

## 2. Install sequence (verified — two lockfiles, two `node_modules`)

```bash
git clone https://github.com/mlaplante/resumesite.git
cd resumesite
npm ci                       # root deps: @anthropic-ai/sdk, eslint, vitest, @cloudflare/vitest-pool-workers, ...
cd blog-src && npm ci && cd . # site deps: astro, sitemap, satori, resvg-js, pdfkit, wawoff2, bootstrap, purgecss, typescript
```

**Why both are required, not optional:** `tests/lib/*.test.js` import
`blog-src/src/utils/*` (e.g. `resumePdf.ts`), which need `blog-src/node_modules`
for their own imports (`pdfkit`, `wawoff2`) *and* for the TypeScript
`tsconfig.json` extends chain — `blog-src/tsconfig.json` is just
`{ "extends": "astro/tsconfigs/strict" }`, which only resolves once
`blog-src/node_modules/astro` exists. Skip the second `npm ci` and `npm test`
/ `npm run typecheck` will fail or behave inconsistently. This exact two-step
sequence is what CI does — see `.github/workflows/ci.yml`'s `test` job (root
`npm ci` then `npm ci` with `working-directory: blog-src`) and `site` job
(installs `blog-src` deps first, builds, then installs root deps for the
build-output smoke test).

Optional, one-time, opt-in local hook:
```bash
git config core.hooksPath githooks   # enables githooks/pre-commit (gitleaks secret scan)
```

## 3. The build pipeline, decomposed

Root `package.json` `build` script (verified, exact text):

```
find blog-src/src -name 'CLAUDE.md' -delete && cd blog-src && npm run build && node scripts/purge-css.mjs && node scripts/fingerprint-assets.mjs
```

Run as `npm run build` from the repo root. This is **one shell invocation**,
so the `cd blog-src` applies to everything after it in the chain — that
matters for stage 3 and 4 below (their paths are relative to `blog-src/`,
not repo root).

| # | Command (as it actually runs) | What it does | Produces |
|---|---|---|---|
| 1 | `find blog-src/src -name 'CLAUDE.md' -delete` | Deletes any `CLAUDE.md` under `blog-src/src` (tracked or not) before the content-collection loader runs | Nothing tracked is at risk today — `git ls-files blog-src/src` has zero `CLAUDE.md` matches (verified 2026-07-05) |
| 2 | `cd blog-src && npm run build` → `astro build` | Astro 6 static build: `output: 'static'`, `build.format: 'directory'`, `outDir: '../dist'` (i.e. repo-root `dist/`, since `outDir` is relative to `blog-src/astro.config.mjs`). Validates every post/draft's frontmatter against the Zod schema in `content.config.ts`. Renders OG PNGs (satori + resvg) and the résumé PDF (pdfkit) at build time. | `dist/` (HTML, CSS, JS, `resume.pdf`, `/og/*.png`, sitemap, feeds) |
| 3 | `node scripts/purge-css.mjs` (cwd is `blog-src/`, so this is `blog-src/scripts/purge-css.mjs`) | Runs PurgeCSS over `dist/**/*.html` against 5 target CSS files (`bootstrap-reboot.min.css`, `bootstrap-grid.min.css`, `bootstrap-utilities.min.css`, `bootstrap.min.css`, `style.css`), with a `safelist` for classes mutated at runtime by `public/js/script.js` (`dark-mode`, `show-menu`, `ripple`, color-name classes, Bootstrap `fade`/`show`/`modal*` regexes, etc.) | Shrunk CSS files in place, logs before→after size and % reduction per file |
| 4 | `node scripts/fingerprint-assets.mjs` (also `blog-src/scripts/fingerprint-assets.mjs` — same cwd note) | Content-hashes every `dist/css/*.css` and `dist/js/*.js` (SHA-256, first 10 hex chars), copies each to a hashed filename **alongside** the original (original is kept, not replaced — the Worker falls back to it for stale-page requests from a previous deploy, per `worker/index.ts`), then rewrites `href="…"` / `src="…"` references across every `dist/**/*.html` file to point at the hashed name | Hashed, immutable-cacheable CSS/JS assets; exits **1** if `rewrittenRefs === 0` (guards against a silently-broken HTML/asset layout change) |

**Verified discrepancy vs. this skill's own source brief:** the brief that
seeded this doc says `fingerprint-assets.mjs` lives at repo-root
`scripts/fingerprint-assets.mjs`. That is wrong — the file does not exist
there. It lives at **`blog-src/scripts/fingerprint-assets.mjs`**, and the
build script only reaches it because `cd blog-src` earlier in the same `&&`
chain leaves the shell's working directory there. Root `scripts/` only
contains the AI blog-draft generators (`generate-post*.js`, `backfill-updated.js`,
`lib/`) — confirmed by directory listing 2026-07-05. If you're hunting for
either post-build script, look in `blog-src/scripts/`, not `scripts/`.

## 4. Local secrets (never commit; only the example template is tracked)

| File | Location | Tracked? | Contains |
|---|---|---|---|
| `.env` | `blog-src/.env` | No (gitignored) | Astro `PUBLIC_*` vars, e.g. `PUBLIC_TURNSTILE_SITE_KEY` |
| `.env.example` | `blog-src/.env.example` | **Yes** | Template with placeholders for both the public var above *and* the worker secrets below (one combined template file — verified by reading it) |
| `.dev.vars` | repo root (same directory as `wrangler.jsonc`) | No (gitignored) | Worker secrets for local `wrangler dev`: `TURNSTILE_SECRET`, `FE_API_KEY`, `CONTACT_FROM`, `CONTACT_TO` |

No separate `.dev.vars.example` is tracked — `blog-src/.env.example` is the
only checked-in template, and its comment block tells you which of its
values belong in `.dev.vars` instead of `.env`. To bootstrap:

```bash
cp blog-src/.env.example blog-src/.env   # fill in PUBLIC_TURNSTILE_SITE_KEY for local Astro dev
# then, separately, at repo root, hand-create .dev.vars with:
#   TURNSTILE_SECRET=...
#   FE_API_KEY=...
#   CONTACT_FROM=...
#   CONTACT_TO=...
```

You only need `.dev.vars` if you're running `npm run worker:dev`
(covered by `resumesite-run-and-operate`). Building and testing do not
require any of these secrets.

## 5. Traps (in order of how often they bite)

1. **Two `node_modules`, two lockfiles.** Root `package-lock.json` and
   `blog-src/package-lock.json` are independent. `npm ci` at root does NOT
   install `blog-src`'s deps. Forgetting the second `npm ci` is the #1 cause
   of "works in CI, fails locally" (or vice versa) confusion.
2. **`npm run build` deletes files before it starts.** Stage 1
   (`find blog-src/src -name 'CLAUDE.md' -delete`) is real and unconditional
   — it will delete an untracked `CLAUDE.md` you dropped under `blog-src/src`
   for scratch notes, with no confirmation. Nothing tracked is at risk today,
   but do not casually run `npm run build` as a "let's see what happens"
   command, and never leave an agent-authored `CLAUDE.md` under
   `blog-src/src` between sessions.
3. **`npm run build` also writes `dist/` at repo root**, overwriting whatever
   was there. This is why the outer instructions for this whole skill-authoring
   task forbid running it — it mutates tracked-adjacent state outside your
   sandbox.
4. **The vitest "Proxy environment variables detected" warning is benign.**
   Confirmed by an actual `npm test` run (2026-07-05): the warning prints,
   then the suite runs and passes normally. It is not a sign of
   misconfiguration; do not chase it.
5. **`fingerprint-assets.mjs` fails loudly (exit 1) if it rewrites zero
   references.** If you restructure `blog-src/public/css/` or `public/js/`
   (rename a directory, change how `<link>`/`<script>` tags reference them),
   this stage is your canary — a silent zero means the regex in stage 4 no
   longer matches your new HTML/asset layout.
6. **A local `npm run build` does not replicate the CI `site` job in full.**
   CI additionally runs `npx vitest run --project site` (the build-output
   smoke tests in `tests/site/build-output.test.ts`, which self-skip when
   `dist/` is absent) and a Lighthouse audit. If you want to actually
   exercise those locally after building, run
   `npx vitest run --project site` yourself; don't assume `npm run build`
   succeeding means the site job would pass.

## 6. Clean-room checklist (fresh clone → green baseline)

```bash
git clone https://github.com/mlaplante/resumesite.git
cd resumesite
node -v                          # expect v22 or newer

npm ci
cd blog-src && npm ci && cd ..

npm test                         # see expected output below
npm run typecheck                # see expected output below
npm run lint                      # expect clean exit, no output
```

**Verified baselines (2026-07-05, all green, re-run in this session to
confirm):**
- `npm test` → `Test Files 6 passed | 1 skipped (7)`; `Tests 328 passed | 20 skipped (348)`; ~0.5s. The 1 skipped file is
  `tests/site/build-output.test.ts` — it self-skips without a `dist/`
  directory and only asserts for real inside the CI `site` job, after a real
  `npm run build`.
- `npm run typecheck` → `0 errors, 0 warnings, 12 hints (49 files)`. The
  hints are benign Astro `is:inline` notices on
  `<script type="application/ld+json">` blocks (e.g. in
  `blog/tags/[tag].astro`) — expected, not a regression.
- `npm run lint` → no output, clean.

If you need to also validate a real build locally (rarely necessary — CI's
`site` job is the source of truth, and this repo's build/discipline rules
route real merges through PR + green CI, not local builds):

```bash
npm run build                    # writes dist/ at repo root — mutates working tree
npx vitest run --project site    # now exercises the previously-skipped smoke tests
```

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of this worktree (branch `skills`)
plus one live `npm test` run. Re-verify anything below before trusting it on
a later date — these are the exact commands used to produce each claim above.

| Claim | Re-verify with |
|---|---|
| Root install/build scripts, exact `build` command text | `cat package.json` (`.scripts`) |
| Site scripts (`astro dev/build/preview`) | `cat blog-src/package.json` (`.scripts`) |
| No `.nvmrc`, no `engines` field | `find . -maxdepth 3 -iname '.nvmrc'` and `grep -n engines package.json blog-src/package.json` |
| Node version CI actually pins | `grep -n 'node-version' .github/workflows/ci.yml` |
| Two-lockfile install order CI uses | `sed -n '1,120p' .github/workflows/ci.yml` (see `test` and `site` jobs) |
| No tracked `CLAUDE.md` under `blog-src/src` | `git ls-files blog-src/src \| grep -i 'CLAUDE\.md$'` (expect empty) |
| `purge-css.mjs` targets + safelist | `cat blog-src/scripts/purge-css.mjs` |
| `fingerprint-assets.mjs` behavior + exit-1 guard, and its true location | `cat blog-src/scripts/fingerprint-assets.mjs`; confirm root `scripts/` has no such file via `ls scripts/` |
| `outDir`, `output`, `build.format`, `assetsInlineLimit` | `cat blog-src/astro.config.mjs` |
| Secrets layout (`.env`, `.env.example`, `.dev.vars`) | `cat blog-src/.env.example`; `cat .gitignore` (search "Local secrets"); `cat wrangler.jsonc` (confirms `.dev.vars` sits next to it at repo root) |
| Test/typecheck/lint baselines | `npm test`, `npm run typecheck`, `npm run lint` (re-run and diff against the numbers above) |
