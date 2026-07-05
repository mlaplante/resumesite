---
name: resumesite-change-control
description: The gate for every behavior-changing task on the resumesite repo (michaellaplante.com — Astro 6 + Cloudflare Worker + D1 personal site). Load this BEFORE merging any change, opening a PR, touching CI/CD workflows, editing worker/api/contact.ts, editing blog-src/public/_headers or astro.config.mjs vite settings, bumping a dependency, or publishing an AI-generated blog draft. Also load when you see or are about to cause: a direct push to master, a Dependabot major-version PR, a CSP script-src edit without a matching assetsInlineLimit check, a merge with red/skipped CI, or a question like "can I skip the PR", "is this safe to merge", "who reviews this", "what does green CI mean here", "how do drafts get published", "why is this action pinned to a SHA". Owns the RULES and the merge bar, not the mechanics of running checks (see resumesite-validation-and-qa) or the reasoning discipline behind claims (see resumesite-evidence-and-methodology).
---

# resumesite Change Control

This is a solo-owned personal site (Michael LaPlante, `michaellaplante.com`) that is nonetheless run with
real production discipline: PR-only history (~189 PRs at last check, 2026-07-05), branch-protected CI,
SHA-pinned Actions, a hardened contact-form Worker, and an unattended daily AI blog-draft pipeline. The
automation is exactly why the gate matters — nobody is manually double-checking the daily cron job, so the
gate has to catch mistakes by itself.

**If you are about to merge, deploy, or auto-publish anything on this repo, this skill is the checklist.**

## 1. Classify the change first

Every change falls into one of four buckets. Pick the widest bucket that applies (e.g. a post that also
edits `astro.config.mjs` is "site code", not "content-only").

| Change type | Examples | Required gate | Extra scrutiny |
|---|---|---|---|
| **Content-only** | New/edited file in `blog-src/src/content/posts/` or `content/drafts/`; frontmatter edits | Full `ci.yml`: `lint` + `test` (content schema/dedupe tests in `tests/site/content.test.ts`) + `site` job (`npm run build` validates **every** post/draft's frontmatter) | If AI-generated: human review before merge — see §4. Never merge with an open dedupe/schema failure. |
| **Site code** | `.astro` components/pages, `src/utils/*.ts`, `astro.config.mjs`, `src/styles`, `public/css`/`public/js` | Full `ci.yml`: `lint` + `test` + `site` (typecheck + build + `vitest --project site` + Lighthouse) | Any new `<script>` tag, external origin, or change to `vite.build.assetsInlineLimit` → CSP rule (§3, rule 3) applies. Update `blog-src/public/_headers` in the **same PR**. |
| **Worker / security surface** | `worker/**`, `worker/schema.sql`, `blog-src/public/_headers`, Turnstile/rate-limit/retention constants in `worker/api/contact.ts` | Full `ci.yml` (`test` job runs the real-Workers-runtime `worker` vitest project against Miniflare D1) + manual review against `SECURITY.md` scope | Never touch prod D1 or real secrets from dev/CI (rule 4). Consider whether CodeQL (`codeql.yml`) or gitleaks (`gitleaks.yml`) needs a fresh look. |
| **Build / CI / deps** | `package.json`/`package-lock.json` (either root or `blog-src/`), `.github/workflows/*.yml`, `.github/dependabot.yml`, `wrangler.jsonc` | Workflow YAML changes additionally run `lint-workflows.yml` (actionlint + zizmor); dependency bumps go through the policy in §5 | Third-party Actions must stay pinned to full commit SHAs (rule 6). Major bumps are human-reviewed, never auto-merged (rule 5). |

For "what does green actually mean" and "how do I run these checks locally," see **resumesite-validation-and-qa**.
For "how do I decide whether a claim/number in a PR description is trustworthy," see **resumesite-evidence-and-methodology**.

## 2. The non-negotiable path

**PR-only to master, green CI, human merge. No exceptions carved out here.**

```
branch → commit → push → open PR → CI (lint + test + site) green → human merge → deploy
```

Verified from `git log --oneline`: commit history is essentially 100% PR-squash-merged, e.g. `a1b69c6 blog:
restore daily draft cadence (#189)`, `0c9b31b Allow COSE acronym in spell check (#187)` — commit messages
carry the PR number. `ci.yml` runs on both `pull_request` and `push: branches: [master]`, with
`concurrency: cancel-in-progress: true` so a newer push supersedes an in-flight run rather than racing it.

This skill does not grant an exception to this path for any reason — not "it's just a typo fix," not "it's
just a content change," not "the AI wrote it so it's already reviewed." If a task would have you push
directly to `master` or merge with a failing/skipped required check, stop and use the PR path instead.

## 3. The six discipline rules

These six rules are **derived from observed practice** (commit history, workflow comments, and code
comments in the repo) — **not a written policy document, and not confirmed word-for-word by the owner** in
the material available to this skill's author. Treat them as binding defaults for any AI agent working this
repo, but if a task seems to require breaking one, say so explicitly and ask the owner rather than silently
complying or silently refusing.

### Rule 1 — PR-only to master; nothing is pushed directly.
- **Rationale:** a single human maintainer plus multiple unattended automations (daily blog drafts,
  Dependabot) means the PR is the only checkpoint where a bad change gets a second look — human or CI.
- **Evidence:** PR-numbered commit history (see §2); `dependabot-auto-merge.yml`'s own comment: "GitHub only
  completes the merge once every required check on the PR passes... relies on branch protection requiring
  the CI workflow"; README's Deployment section explicitly tells the owner to "enable **Allow auto-merge**...
  and add branch protection on `master` requiring the CI checks, or the merge will happen without waiting
  for them."
- **UNVERIFIED:** whether branch protection is *currently* switched on for `master` is a GitHub repository
  **Settings** toggle, not a file in this checkout — it cannot be confirmed by reading the repo. If you need
  certainty before relying on "CI blocks the merge," check GitHub → Settings → Branches, or ask the owner.

### Rule 2 — AI-generated blog content never auto-publishes; a human gate sits between draft and live.
- **Rationale:** F3 (see resumesite-failure-archaeology) — the pipeline once forced a 3×/week cadence after
  duplicate/mis-titled drafts got published; the fix was multi-layer dedupe **plus** a mandatory human
  review step before anything goes live.
- **Evidence, and a correction worth internalizing** — there are **two distinct pipelines**, and they use
  the human gate differently. Don't assume "it's in `drafts/`" means "it's not live," and don't assume
  "it's in `posts/`" means "it's live" — check whether a PR is open or merged instead:
  - **(a) Automated daily pipeline** — `.github/workflows/generate-blog-post.yml` runs on cron `0 8 * * *`
    (UTC) or manual `workflow_dispatch`, invoking `node scripts/generate-post-gemini.js`. Verified in
    `scripts/lib/blog-post.js` (`POSTS_DIR = .../blog-src/src/content/posts`, `writeFileSync(filepath,
    content)` at line ~503) and in the workflow itself (`git add blog-src/src/content/posts/`): **this path
    writes the finished post file directly into `content/posts/`, not `content/drafts/`.** The workflow then
    opens a PR labeled `blog-draft` against `master`. The PR body says outright: *"the post is written
    directly into `posts/`, so merging this PR publishes and deploys it to the site. Close the PR without
    merging to discard."* For this path, the human gate **is** the PR-merge decision — there is no
    drafts→posts move to do.
  - **(b) Manual/local pipeline** — the sibling skill `.claude/skills/blog-draft/SKILL.md` (invoked by a
    human inside a Claude Code session) writes into `blog-src/src/content/drafts/` and explicitly reminds
    the user to "review and move to `blog-src/src/content/posts/` when ready to publish." `content/drafts/`
    is never built: `blog-src/src/content.config.ts`'s loader only globs `./src/content/posts` with pattern
    `**/[^_A-Z]*.md`, so nothing in `drafts/` reaches the site regardless of PR state.
  - The fact-sheet's own §8/§13 characterization of rule 2 describes only path (b) — path (a), the one that
    actually runs unattended every day, does not use `drafts/` at all. This SKILL.md is the corrected
    version; if another doc in this repo implies all AI drafts land in `drafts/` first, this file wins.
- **Net rule, regardless of path:** never merge a `blog-draft`-labeled PR without reading the post. Never
  hand-edit around the PR gate (e.g. commit a finished AI draft straight to `master`) to "save a step."

### Rule 3 — Never relax the CSP without touching the matching Vite setting in the same change.
- **Rationale:** `blog-src/public/_headers`' `Content-Security-Policy` has **no `'unsafe-inline'`** in
  `script-src` (verified, line 7: `script-src 'self' https://laplantedevanalytics.netlify.app
  https://static.cloudflareinsights.com https://challenges.cloudflare.com https://app.cal.com`). Astro would
  otherwise inline small `<script type="module">` blocks below its default inlining threshold as literal
  inline `<script>` tags — which that CSP then blocks. That's why `astro.config.mjs` sets
  `vite.build.assetsInlineLimit: 0` (verified, line 27) to force everything out to a separate hashed file
  instead. The two settings are a matched pair; changing one without the other breaks the site **silently**
  — no build error, just a broken script at runtime that only shows up in the browser console/CSP report.
- **Action:** any PR that edits `script-src` in `_headers` or edits `vite.build` in `astro.config.mjs` must
  edit both together (or justify explicitly why not). Any new external script origin (analytics, Cal.com,
  Turnstile, etc.) is a deliberate, reviewed allowlist addition — not a default-permit.

### Rule 4 — Never touch production D1 or real secrets from dev, tests, or CI.
- **Rationale:** the contact-form Worker (`worker/api/contact.ts`) is a real, internet-facing endpoint with
  a live database of names/emails/messages; test tooling must be structurally incapable of touching it.
- **Evidence:** `vitest.config.ts`'s `worker` project binds a **separate** D1 database id,
  `'test-contact-submissions'` (not the production binding from `wrangler.jsonc`), plus fake bindings
  (`TURNSTILE_SECRET: 'test-turnstile-secret'`, `FE_API_KEY: 'test-fe-api-key'`,
  `CONTACT_FROM: 'test@example.com'`, `CONTACT_TO: 'inbox@example.com'`). `.gitignore` excludes `.env`,
  `.env.*` (except `.env.example`), `.dev.vars`, `.dev.vars.*` — secrets live only in local untracked files
  or Cloudflare/GitHub Actions secrets, never in git. `gitleaks.yml` scans history on every PR/push;
  `codeql.yml` and `lint-workflows.yml` (actionlint + zizmor) catch a different class of issue (template
  injection / permission smells in workflow YAML) but reinforce the same "no ambient trust" posture.

### Rule 5 — Dependency major-version bumps are always human-reviewed; minor/patch may auto-merge.
- **Rationale:** minor/patch bumps are low-risk and high-volume; gating every one on a human would just
  train the owner to rubber-stamp, which defeats the point of review. Majors are where breaking changes
  live, so they're deliberately excluded from automation.
- **Evidence:** `.github/dependabot.yml` groups every ecosystem (root npm, `blog-src` npm, GitHub Actions)
  into a `minor-and-patch` group and a separate `majors` group, with a 7-day `cooldown` before a release is
  even considered (lets a bad release get yanked/patched first). `dependabot-auto-merge.yml` only fires
  `gh pr merge --auto --squash` when `steps.metadata.outputs.update-type` is
  `version-update:semver-minor` or `version-update:semver-patch` — anything else (i.e. any major, including
  one hiding inside a grouped PR: *"for grouped PRs, `update-type` reports the highest bump in the group, so
  a group containing any major update is skipped"*) is left untouched for a human to merge manually. The
  workflow also checks `github.event.pull_request.user.login == 'dependabot[bot]'` (not `github.actor`) so a
  human re-running the workflow on a Dependabot PR can't be mistaken for Dependabot itself.
- **Action:** never manually force-merge a Dependabot PR flagged as major without actually reading the
  changelog/breaking-changes for that bump.

### Rule 6 — Third-party GitHub Actions are pinned to full commit SHAs, never tags.
- **Rationale:** a moved or compromised tag (e.g. someone re-pointing `v7` after a supply-chain compromise)
  can inject arbitrary code into a workflow — and several of these workflows hold `contents: write` /
  `pull-requests: write`. Pinning to a SHA makes that class of attack require a new commit in this repo,
  which itself needs review.
- **Evidence:** every workflow read for this skill pins the same way, e.g.
  `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0`,
  `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0`,
  `dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3.1.0` — always full 40-char SHA
  with a `# vX.Y.Z` trailing comment for human readability. `.github/dependabot.yml`'s
  `package-ecosystem: github-actions` entry keeps these SHAs current by opening PRs that bump the SHA and
  the comment together.
- **Action:** never add a third-party Action pinned only to a tag or branch (`@v4`, `@main`, etc.) in a PR
  you write or review. If Dependabot bumps a SHA, the trailing version comment must move with it (this is
  what Dependabot does automatically for `github-actions`; a hand-edit should preserve the same format).

## 4. The merge bar — what "green CI" means (2026-07-05 baseline)

`ci.yml` runs three jobs on every PR and on push to `master`, `concurrency`-guarded so a newer push cancels
an in-flight run:

| Job | What it runs | Current baseline (2026-07-05) |
|---|---|---|
| `lint` | `npm ci` (root) → `npm run lint` (ESLint flat config) | clean, no output |
| `test` | `npm ci` (root + `blog-src`) → `npm test` (3 vitest projects: `worker`, `lib`, `site`) | **328 passed, 20 skipped, of 348 total**, across 6 passed + 1 skipped test file. The 1 skipped file is `tests/site/build-output.test.ts` — it self-skips when `dist/` doesn't exist locally and only asserts for real inside the `site` job below (after `npm run build`). |
| `site` | `npm ci` (`blog-src`) → `npm run typecheck` → `npm run build` → `npm ci` (root) → `npx vitest run --project site` → Lighthouse (`@lhci/cli@0.15.x collect` + `assert`) | typecheck: 0 errors, 0 warnings, 12 hints (benign Astro `is:inline` notices); build succeeds; Lighthouse gate below |

Lighthouse (`lighthouserc.json`, audits `/index.html`, `/blog/index.html`, `/blog/hello-world/index.html`,
`/services/index.html`, `/resume/index.html`, `numberOfRuns: 1`):

| Category | Assertion | Blocks the job? |
|---|---|---|
| `categories:accessibility` | `minScore: 0.9` | **Yes — `error` level. This is the only category that fails CI.** |
| `categories:performance` | `minScore: 0.8` | No — `warn` only |
| `categories:best-practices` | `minScore: 0.9` | No — `warn` only |
| `categories:seo` | `minScore: 0.9` | No — `warn` only |

**"Green" = all three `ci.yml` jobs pass, and accessibility ≥ 0.90 in the Lighthouse assert step.**
Performance/best-practices/SEO warnings do not block a merge on their own, but don't wave off a warning
regression without at least reading it — see resumesite-evidence-and-methodology on how to reason about
a metric drop before dismissing it.

For the mechanics of running each of these locally (exact commands, how to interpret `astro check` hints,
how the `site` test project self-skips, how to invoke Lighthouse against a local build) see
**resumesite-validation-and-qa** — that skill owns the "how," this skill owns the "is this good enough to
merge."

## 5. Dependency policy summary

| Bump type | Path | Human touches it? |
|---|---|---|
| Minor/patch (grouped by ecosystem: root npm, `blog-src` npm, GitHub Actions) | `dependabot.yml` groups it into one PR per ecosystem per week (Monday), 7-day cooldown, `dependabot-auto-merge.yml` squash-merges once `ci.yml` is green | No, unless it fails CI |
| Major (any package, including inside a grouped PR where any member is major) | Opened as its own PR, `dependabot-auto-merge.yml` explicitly skips it (`update-type` check) | **Yes, always** |
| GitHub Actions SHA bumps | Same Dependabot flow, PR updates the SHA and the `# vX.Y.Z` comment together | Follows the same minor/patch-vs-major split above |

## 6. AI-draft publication path (summary — see rule 2 for the full detail and the correction)

```
Automated:  cron 08:00 UTC daily → generate-post-gemini.js → file written straight into
            content/posts/ → PR opened, labeled blog-draft → HUMAN reads + merges (or
            closes to discard) → merge = publish + deploy

Manual:     human invokes blog-draft skill in a session → file written into
            content/drafts/ (never built) → HUMAN moves file into content/posts/ →
            commit goes through the normal PR path (rule 1) → merge = publish + deploy
```

Either way: **never** merge a `blog-draft` PR unread, and never bypass the PR to get a post live faster.

## 7. When NOT to use this skill

- To learn **how** to run lint/typecheck/test/build/Lighthouse locally, or interpret their output in detail
  → **resumesite-validation-and-qa**.
- To learn the reasoning discipline for promoting a claim, benchmark, or metric from "observed once" to
  "trustworthy" → **resumesite-evidence-and-methodology**.
- To understand *why* a past incident happened in full detail (F1 origin bypass, F2 ClientRouter revert, F3
  duplicate drafts, F4 diagnostics revert) → **resumesite-failure-archaeology**. This skill cites those
  incidents only as evidence for the rules above; it doesn't re-derive them.
- To find the exact config knob/env var for something (e.g. `SEMANTIC_THRESHOLD`, `CAL_LINK`,
  `RATE_LIMIT_MAX`) → **resumesite-config-and-flags**.
- To understand the Astro/Worker architecture itself (why `blog-src/` is the whole site, how the content
  collection loader works) → **resumesite-architecture-contract** / **resumesite-astro-reference** /
  **resumesite-cloudflare-reference**.

This skill does not teach you *how* to satisfy the gate — it teaches you *what the gate is* and *why it
exists*. If a rule here seems to block a change you believe is correct, that is a signal to raise it with
the owner, not a signal to route around the PR/CI path.

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of this repo at
`/Users/mlaplante/.supacode/repos/resumesite/skills` (branch `skills`), plus one real toolchain run. Facts
here will drift; re-verify with these commands before trusting a number in this file more than a few months
old:

| Fact | Re-verify with |
|---|---|
| PR-numbered commit history / rule 1 evidence | `git log --oneline -30` — check messages end in `(#NNN)` |
| Branch protection actually enabled (UNVERIFIED above) | GitHub → repo Settings → Branches (not visible from a checkout) |
| Test baseline (328/348, 1 file skipped) | `npm ci && cd blog-src && npm ci && cd .. && npm test` |
| Typecheck baseline (0 errors, 12 hints) | `cd blog-src && npm ci && npx astro check` |
| Lint baseline (clean) | `npm ci && npm run lint` |
| Lighthouse thresholds / audited URLs | `cat lighthouserc.json` |
| CI job structure | `cat .github/workflows/ci.yml` |
| Dependabot grouping/cooldown | `cat .github/dependabot.yml` |
| Auto-merge condition (minor/patch only) | `cat .github/workflows/dependabot-auto-merge.yml` |
| Daily draft pipeline writes to `posts/` not `drafts/` | `grep -n "POSTS_DIR\|writeFileSync" scripts/lib/blog-post.js`; `grep -n "content/posts" .github/workflows/generate-blog-post.yml` |
| Content-collection loader excludes `drafts/` | `cat blog-src/src/content.config.ts` (loader `base` is `./src/content/posts` only) |
| CSP has no `unsafe-inline` in `script-src` | `grep -n "script-src" blog-src/public/_headers` |
| `assetsInlineLimit: 0` still set | `grep -n "assetsInlineLimit" blog-src/astro.config.mjs` |
| Test D1 isolation | `grep -n "d1Databases\|test-contact-submissions" vitest.config.ts` |
| Actions pinned to SHAs | `grep -rn "uses: .*@[0-9a-f]\{40\}" .github/workflows/` |
| F2 ClientRouter revert root cause | `git show 8fbdad6 --format=%B -s` |
| F4 diagnostics revert | `git show aa88de8 --format=%B -s` |

Known gaps in this skill (do not fill from memory — confirm with the owner or a live GitHub check):
- Whether branch protection on `master` is actually switched on right now (repo Settings, not a file).
- Whether "Allow auto-merge" is enabled in repo settings (same caveat — README just instructs the owner to
  turn it on, it isn't a file this skill can inspect).
