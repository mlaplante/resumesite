---
name: resumesite-diagnostics-and-tooling
description: How to MEASURE resumesite instead of eyeballing it — the diagnostic tools, their exact invocation commands, and how to read their output. Load this when asked to "run lighthouse", "check accessibility score", "why did the site job fail on Lighthouse", "run typecheck", "what does astro check hint mean", "run the tests", "what does vitest --project mean here", "interpret this console.warn about semantic/lexical similarity", "audit the blog for duplicate titles", "how many tests should pass", or when you see CI failing on the `site` job's Lighthouse step, an `astro check` result you're unsure is a real regression, or a `Rejected candidate "..." — NN% semantic/lexical similarity` warning from the blog-draft pipeline and need to know if it's a false positive. Covers Lighthouse CI (thresholds, audited pages, what blocks vs. warns), the 3 vitest projects (worker/lib/site) and their current baselines, `npm run typecheck`'s expected hint count, and the dedupe similarity scoring in `scripts/lib/blog-post.js`. Ships a read-only `scripts/dedupe-audit.mjs` tool. Do NOT use this to fix a diagnosed problem (see resumesite-debugging-playbook) or to decide what bar a change must clear to merge (see resumesite-validation-and-qa) — this skill only owns measurement and tool output interpretation.
---

# resumesite Diagnostics and Tooling

Everything here is a **read-only measurement**: run it, read the output, decide what it means. It does not fix anything and does not gate merges by itself — see **resumesite-validation-and-qa** for the acceptance bar and **resumesite-change-control** for the PR/CI gate that actually blocks a merge. This skill exists so you stop eyeballing "looks fine" and instead run the tool that measures the specific thing you're worried about.

All baselines below were captured **2026-07-05** on a clean checkout of this worktree (branch `skills`). Re-verify commands are in "Provenance and maintenance" at the bottom — numbers drift as posts/tests are added.

## 1. Lighthouse (performance/accessibility/SEO/best-practices gate)

Config: `lighthouserc.json` (repo root). CI step: `.github/workflows/ci.yml`, job `site`, step "Lighthouse audit" — runs **after** `npm run build` and after the `site` vitest project, from the repo root (not `blog-src/`).

### Exact commands (CI and local repro)

```bash
# 1. Build the real dist/ first — Lighthouse audits static files, not a dev server.
npm run build          # from repo root; see resumesite-build-and-env for what this does

# 2. Collect Lighthouse runs against dist/, then assert against the thresholds.
npx --yes @lhci/cli@0.15.x collect
npx --yes @lhci/cli@0.15.x assert
```

`@lhci/cli@0.15.x` is pinned to that exact CI-verified major/minor line (`.github/workflows/ci.yml`) — don't silently float to a different major.

**Never run `npm run build` speculatively just to try Lighthouse** — it deletes any `blog-src/src/**/CLAUDE.md` files and overwrites `dist/`. Only do this in a scratch/worktree checkout, never mid-task in a shared working tree unless you were explicitly asked to build.

### What `collect` audits (`lighthouserc.json`)

```json
"staticDistDir": "./dist",
"url": [
  "http://localhost/index.html",
  "http://localhost/blog/index.html",
  "http://localhost/blog/hello-world/index.html",
  "http://localhost/services/index.html",
  "http://localhost/resume/index.html"
],
"numberOfRuns": 1
```

Five pages, one run each (not averaged over multiple runs — a flaky single run can trip a `warn`-level category; don't over-react to a single perf/SEO/BP miss, re-run once before concluding it's real).

### Thresholds — READ THIS BEFORE PANICKING ABOUT A RED "site" JOB

```json
"categories:accessibility":   ["error", { "minScore": 0.9 }],
"categories:performance":     ["warn",  { "minScore": 0.8 }],
"categories:best-practices":  ["warn",  { "minScore": 0.9 }],
"categories:seo":             ["warn",  { "minScore": 0.9 }]
```

| Category | Level | Effect |
|---|---|---|
| accessibility | `error` | **Only category that fails the CI job.** Any of the 5 pages scoring < 0.90 → `lhci assert` exits non-zero → `site` job red → PR blocked. |
| performance | `warn` | Printed as a warning; job stays green even below 0.8. |
| best-practices | `warn` | Same — warning only, below 0.9 doesn't fail. |
| seo | `warn` | Same — warning only, below 0.9 doesn't fail. |

So: if CI is red on the Lighthouse step, it is almost certainly **accessibility** on one of those 5 pages. Don't waste time chasing a performance regression unless you're using Lighthouse for its actual "warn" signal deliberately (e.g. investigating a real perf complaint — see resumesite-measurement-toolkit for that lane).

### How to find WHICH page and WHICH audit failed

`lhci assert` prints a per-assertion result table to stdout — look for the line where `categories:accessibility` shows `expected >= 0.9` next to a `found <value>` below 0.9, and note which of the 5 URLs it's attached to. `lhci collect` (run immediately before `assert`) writes one Lighthouse Result (LHR) JSON+HTML report per URL/run into `.lighthouseci/` in the working directory (gitignored, not uploaded as a CI artifact in this repo — `ci.yml` has no upload-artifact step for it). To see the actual failing audits (which specific a11y check — contrast, alt text, aria-*, etc.), open the `.lighthouseci/lhr-*.report.html` for that URL locally (`open .lighthouseci/lhr-*.report.html` on macOS) and read the "Accessibility" section — it lists each failed audit by name with the DOM node(s) responsible.
**UNVERIFIED (not run end-to-end this session — doing so requires a full `npm run build`, which this task avoided per instructions):** the exact stdout format of `lhci assert`'s failure table and the exact default output directory name may vary slightly by `@lhci/cli` version; if `.lighthouseci/` isn't where you expect, check the `lhci collect` stdout, which prints the report paths it wrote.

## 2. `npm run typecheck` as a diagnostic

Command: `npm run typecheck` → root package.json runs `cd blog-src && npx astro check`.

**Baseline (verified 2026-07-05, clean checkout, `npm ci` in both root and `blog-src`):**

```
Result (49 files):
- 0 errors
- 0 warnings
- 12 hints
```

The 12 hints are all `astro(4000)` notices on `<script type="application/ld+json" set:html={...} />` blocks (JSON-LD structured data), e.g.:

```
src/pages/blog/[slug].astro:102:13 - warning astro(4000): This script will be
treated as if it has the `is:inline` directive because it contains an
attribute. ...
```

Despite astro's own line printing the word "warning", `astro check`'s own summary line buckets these as **hints**, not warnings — the `Result (49 files):` line is the one that matters, and it separately reports `0 warnings` alongside `12 hints`. These 12 are **expected and benign** — they come from every page that emits a JSON-LD `<script>` for SEO (post pages, category/tag/series listing pages), and astro's script-processing pipeline always treats scripts with any attribute (here, `type="application/ld+json"`) as `is:inline`, which is the intended behavior. See **resumesite-astro-reference** for the full "why" on this pattern (assetsInlineLimit/CSP interaction).

**How to tell a real regression from the benign baseline:** any `error` in the summary is always real. A jump in warnings from 0, or a hint count that changed for a reason OTHER than "I added/removed a JSON-LD script block", is worth investigating — diff the `astro check` output against this baseline rather than assuming a new hint is fine.

## 3. `npm test` (vitest) as a diagnostic

Command: `npm test` → `vitest run` (root `vitest.config.ts` defines 3 projects — see `vitest.config.ts`).

**Baseline (verified 2026-07-05, clean checkout, both `npm ci`s done):**

```
Test Files  6 passed | 1 skipped (7)
     Tests  328 passed | 20 skipped (348)
```

| Project | What it exercises | Environment |
|---|---|---|
| `worker` | `tests/worker/**/*.test.ts` — contact form + asset routing, inside a **real Cloudflare Workers runtime** (`@cloudflare/vitest-pool-workers`, miniflare-backed) with a D1 binding pointed at `test-contact-submissions` (never touches prod D1). | Workers sandbox |
| `lib` | `tests/lib/**/*.test.js` — `scripts/lib/blog-post.js` (dedupe/frontmatter/naming), `resume-pdf`, `search` utils. Plain Node because these tests need real filesystem + crypto APIs unavailable in the Workers sandbox. | Node |
| `site` | `tests/site/**/*.test.ts` — `content.test.ts` (frontmatter schema checks, always runs) + `build-output.test.ts` (production build smoke test). | Node |

**The 1 skipped file / 20 skipped tests are entirely `tests/site/build-output.test.ts`.** It self-skips (`describe.skipIf(!hasDist)`) whenever `dist/` doesn't exist — i.e. every local `npm test` that hasn't just run `npm run build`. It only actually asserts in CI's `site` job, which runs it right after `npm run build`. **A plain local `npm test` skipping 20 tests is normal, not a gap** — don't chase it unless you've built first and it's still skipping.

**Run one project only:**

```bash
npx vitest run --project worker   # contact form / D1 / Turnstile / rate-limit tests
npx vitest run --project lib      # blog-post.js dedupe, resume-pdf, search utils
npx vitest run --project site     # frontmatter checks; build-output smoke tests IF dist/ exists
```

This is the fastest way to isolate which layer a regression is in (e.g. touched `worker/api/contact.ts` → run `--project worker` only instead of the whole suite).

## 4. Dedupe scoring — reading the AI draft pipeline's similarity warnings

`scripts/lib/blog-post.js` rejects a candidate blog topic/title in two independent passes (topic pick, and a final post-generation guard) and logs to console when it does. Two log shapes to recognize:

```
Rejected candidate "<title>" — exact duplicate of existing "<title>".
Rejected candidate "<title>" — 87% semantic similarity to existing "<title>".
Rejected candidate "<title>" — 62% lexical similarity to existing "<title>".
```

| Log says | Meaning | Threshold that triggered it |
|---|---|---|
| `exact duplicate` | Case-insensitive title match OR slug match (any date prefix) — never threshold-dependent, always a hard reject. | n/a |
| `NN% semantic similarity` | Candidate + existing (title+excerpt) were embedded and compared by cosine similarity. This is the **primary** dedupe path when an `embed` adapter is available. | `SEMANTIC_THRESHOLD`, default **0.85**, env-tunable (see resumesite-config-and-flags) |
| `NN% lexical similarity` | Jaccard token-overlap on titles only (stopword-filtered, tokens >2 chars). Used **only** when no `embed` adapter is passed, or the embedding call itself failed (rate limit, network) — the pipeline logs `Semantic similarity failed (...); falling back to lexical.` right before this. | `DUPLICATE_THRESHOLD` = **0.5** |

**How to tell if a rejection is a false positive:** a lexical rejection at ~50-55% is much weaker evidence of an actual duplicate than a semantic rejection at 85%+ — Jaccard only sees shared words, so two genuinely different posts that both say "Automating X with Kubernetes and GitOps" can lexically collide well above 0.5 without being duplicates. Read both titles yourself before assuming the rejection was correct; when in doubt, check `getExistingPosts()` output for the flagged title's actual excerpt.

The embedding cache lives at `scripts/.embeddings-cache.json` (gitignored, keyed by SHA-256 of `title\n\nexcerpt`) so a daily draft run only pays for one new embedding call, not all ~111 posts. A cold/missing cache file is expected after a fresh clone — it rebuilds automatically, it is not a bug.

## 5. Shipped tool: `scripts/dedupe-audit.mjs`

A read-only script under this skill's own `scripts/` directory:

```
.claude/skills/resumesite-diagnostics-and-tooling/scripts/dedupe-audit.mjs
```

It imports `getExistingPosts`, `findMostSimilar`, and `DUPLICATE_THRESHOLD` directly from `scripts/lib/blog-post.js` (the real pipeline module) so its scoring can never silently drift from the actual dedupe logic — it is not a reimplementation, it calls the same `tokenize()`/`jaccard()` code path used at generation time. It makes **no network or embedding calls** and **writes nothing** — it only reads `blog-src/src/content/posts/*.md` frontmatter and prints a report.

Run it from the repo root:

```bash
node .claude/skills/resumesite-diagnostics-and-tooling/scripts/dedupe-audit.mjs [topN]
```

`topN` (optional, default 15) controls how many of the closest pairs to print.

**Verified output** (run 2026-07-05, 111 published posts):

```
Scanned 111 posts (6105 pairs).
Lexical DUPLICATE_THRESHOLD (scripts/lib/blog-post.js) = 0.5 — the pipeline only
falls back to this when semantic embedding is unavailable.

Top 15 closest title pairs by Jaccard similarity:

87.5%  "Automating Zero-Downtime Database Migrations with GitOps and Kubernetes"
       <-> "Automating Zero-Downtime Database Schema Migrations with GitOps and
       Kubernetes"  <-- AT/ABOVE lexical duplicate threshold
...
14 pair(s) at/above the lexical duplicate threshold (0.5).
```

### How to interpret its output

- **This audits ONLY lexical (Jaccard) similarity** — it does not call an embedding API, so it cannot reproduce the pipeline's primary semantic-similarity dedupe path. A pair scoring high here is a candidate worth a human look, not proof the pipeline would have rejected it (the pipeline's real gate is semantic at 0.85, and semantic can rate two lexically-similar titles as unrelated, or vice versa).
- Pairs at/above `DUPLICATE_THRESHOLD` (0.5) in the report are titles that share more than half their significant vocabulary (stopwords excluded) — worth reading both excerpts before deciding whether they're actually distinct posts (e.g. "...with GitOps and Kubernetes" vs "...with Blue-Green Deployment in Kubernetes" are usually genuinely different angles despite lexical overlap).
- Use it as a periodic content-health check ("are we repeating ourselves"), not as a pre-publish gate — the real gate already runs automatically inside `scripts/generate-post.js` on every draft.

## When NOT to use this skill

- To **fix** something this skill helped you diagnose → **resumesite-debugging-playbook** (symptom → cause → fix tables).
- To decide the **acceptance bar** for merging a change (what must pass, what's advisory) → **resumesite-validation-and-qa**.
- To understand **why** an invariant exists (e.g. why CSP has no `unsafe-inline`, why the D1 test binding is separate) → **resumesite-architecture-contract**.
- To look up a **threshold/env var's current value** without the interpretation context → **resumesite-config-and-flags** (the knob catalog; this skill cross-references it rather than duplicating it).
- For the actual mechanics of building/running the site → **resumesite-build-and-env** / **resumesite-run-and-operate**.

## Provenance and maintenance

Captured 2026-07-05 on branch `skills`, clean checkout, after `npm ci` (root) and `npm ci` (blog-src).

Re-verify commands (run these if any number in this file looks stale):

| Fact | Re-verify with |
|---|---|
| Lighthouse thresholds / audited URLs | `cat lighthouserc.json` |
| Lighthouse CLI version pin | `grep -n '@lhci/cli' .github/workflows/ci.yml` |
| Lighthouse CI invocation order | `sed -n '72,115p' .github/workflows/ci.yml` |
| typecheck hint count / file count | `npm run typecheck` (from repo root) |
| test suite pass/skip counts | `npm test` (from repo root) |
| per-project test composition | `cat vitest.config.ts` |
| `SEMANTIC_THRESHOLD` / `DUPLICATE_THRESHOLD` current values | `grep -n 'THRESHOLD' scripts/lib/blog-post.js` |
| dedupe-audit.mjs still matches the real algorithm | `node .claude/skills/resumesite-diagnostics-and-tooling/scripts/dedupe-audit.mjs` (imports `scripts/lib/blog-post.js` directly — if that module's exports change, this script's import line needs updating too) |
| current published post count | `ls blog-src/src/content/posts | wc -l` |
