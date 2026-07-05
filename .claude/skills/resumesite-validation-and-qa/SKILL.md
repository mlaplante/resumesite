---
name: resumesite-validation-and-qa
description: What counts as evidence on resumesite (michaellaplante.com — Astro 6 + Cloudflare Worker + D1), the exact merge-bar checklist (lint clean, typecheck 0 errors, npm test 328 passed/20 skipped, site build succeeds, build-output smoke passes, Lighthouse accessibility >= 0.90), the 3 vitest projects (worker/lib/site) and why `tests/site/build-output.test.ts` shows "1 skipped" locally, the golden/certified test inventory (what contact.test.ts, assets.test.ts, blog-post.test.js, resume-pdf.test.js, search.test.js, content.test.ts, build-output.test.ts each guarantee), and how to add a new test (which project it belongs in, file naming, that new behavior needs a test before merge). Load this when asked "is 20 skipped tests a problem", "where does this test belong", "what does npm test actually verify", "why did build-output.test.ts not run", "is this claim backed by a test", "what's NOT tested here", or before writing/reviewing a test file. NOT for running the tools (npm test / npx vitest / Lighthouse invocation mechanics) — see resumesite-diagnostics-and-tooling. NOT for the PR/merge gating rules themselves — see resumesite-change-control. NOT for the reasoning discipline behind trusting a number — see resumesite-evidence-and-methodology. This skill owns "what is evidence" + "the test inventory", not the mechanics or the rules.
---

# resumesite: Validation & QA — what counts as evidence

This is the definition of "tested" on this repo: the merge-bar checklist, the
three vitest projects, what each test file actually guarantees, and how to add
a test without breaking the existing structure. Baselines below were verified
live against the repo on **2026-07-05** — re-run the commands in
"Provenance and maintenance" if they look stale.

**Not this skill:**
- How to invoke lint/typecheck/test/build/Lighthouse and read their output →
  `resumesite-diagnostics-and-tooling`.
- Whether a PR is allowed to merge, who reviews it, CSP/dependency/workflow
  rules → `resumesite-change-control`. This skill does not authorize skipping
  any of that — every check below is a change-control input, not a substitute
  for it.
- How to reason about whether a claim/number is trustworthy in general →
  `resumesite-evidence-and-methodology`.
- Debugging a specific failing check → `resumesite-debugging-playbook`.

## 1. The evidence bar to merge (2026-07-05 baseline)

A change is "evidenced" only when all of these are true. This mirrors the
`ci.yml` jobs (`lint`, `test`, `site`) verbatim — nothing here is invented.

| # | Check | Command | Expected result (verified 2026-07-05) |
|---|---|---|---|
| 1 | Lint clean | `npm run lint` (root `eslint .`, flat config) | No output / "ESLint: No issues found" |
| 2 | Typecheck | `cd blog-src && npx astro check` (root: `npm run typecheck`) | **0 errors, 0 warnings, 12 hints (49 files)**. Hints are benign `astro(4000)` `is:inline` notices on `<script type="application/ld+json">` blocks (e.g. `blog/tags/[tag].astro:44`) — not a regression if the count matches. |
| 3 | Unit/integration tests green | `npm test` (root `vitest run`) | **Test Files: 6 passed \| 1 skipped (7). Tests: 328 passed \| 20 skipped (348).** |
| 4 | Site build succeeds | `npm run build` (deletes stray `blog-src/src/**/CLAUDE.md`, `astro build`, PurgeCSS, asset fingerprinting) | Exits 0; produces `dist/`. This build ALSO validates every post/draft's frontmatter against the Zod schema — a bad frontmatter value fails the build, not just a test. |
| 5 | Build-output smoke passes | `npx vitest run --project site` (run **after** step 4, so `dist/` exists) | All assertions in `tests/site/build-output.test.ts` pass — no longer skipped once `dist/` is present. |
| 6 | Lighthouse accessibility gate | `npx --yes @lhci/cli@0.15.x collect && npx --yes @lhci/cli@0.15.x assert` (`lighthouserc.json`) | `categories:accessibility` >= **0.90** is a hard **error** (fails the job). `performance` >= 0.8, `best-practices` >= 0.9, `seo` >= 0.9 only **warn** — they do not block. |

These six map onto the three `ci.yml` jobs: `lint` = row 1; `test` = row 3;
`site` = rows 2, 4, 5, 6 in that order (typecheck → build → smoke → Lighthouse).
"Green CI" (the phrase `resumesite-change-control` uses for the merge bar)
means all three jobs pass, i.e. all six rows above are true.

A number claimed in a PR description ("tests still pass", "a11y unaffected")
is not evidence until it's one of these six — reproduced from a real run, not
recalled from memory or a previous PR.

## 2. The 3 vitest projects (why `vitest.config.ts` splits them)

`vitest.config.ts` defines **three projects** under a single `vitest run` /
`npm test` invocation:

| Project | `include` glob | Environment | Why separate |
|---|---|---|---|
| `worker` | `tests/worker/**/*.test.ts` | Real Cloudflare **Workers runtime** via `@cloudflare/vitest-pool-workers` (`cloudflareTest`), `singleWorker: true`, wired to `wrangler.jsonc`, with a **miniflare-backed D1** database named `test-contact-submissions` (never the real prod D1) and stub bindings (`TURNSTILE_SECRET`, `FE_API_KEY`, `CONTACT_FROM`, `CONTACT_TO`), `compatibilityFlags: ['nodejs_compat']` | Exercises the actual Worker (`worker/index.ts`) end-to-end, including real D1 SQL, inside the same runtime it deploys to — not a Node approximation. |
| `lib` | `tests/lib/**/*.test.js` | plain Node (`environment: 'node'`) | Tests import filesystem (`node:fs`) and crypto (SHA-256 embedding cache) APIs unavailable inside the Workers sandbox. This is also why these test files import TS modules straight from `blog-src/src/utils/*.ts` — they need `blog-src`'s own `node_modules` (pdfkit, wawoff2) and its `tsconfig` `extends` chain, hence CI's separate `npm ci` inside `blog-src` before `npm test`. |
| `site` | `tests/site/**/*.test.ts` | plain Node | Content/build invariants — see below. |

**Why the `site` project shows "1 skipped" on a plain local `npm test`:**
`tests/site/build-output.test.ts` opens with
`const hasDist = existsSync(DIST); describe.skipIf(!hasDist)(...)`. Its 20
`it`/`it.each` cases self-skip as a whole file whenever `dist/` doesn't exist
— which is the normal state on a fresh checkout or any local run that hasn't
run `npm run build`. **This is expected, not broken.** It only actually
asserts inside CI's `site` job, which runs `npm run build` first (see table
row 5). `tests/site/content.test.ts`, by contrast, has no such guard — it
reads `blog-src/src/content/posts/*.md` directly off disk and **always
runs**, locally and in CI, regardless of whether `dist/` exists.

Do not read "20 skipped" as a coverage gap or a broken suite. It means "no
`dist/` was present when this run started."

## 3. The golden/certified test inventory — what each file guarantees

Treat these as the certified contract for their subsystem. If you're about to
touch the code a row covers, read the row's test file before you start —
it's the executable spec.

| File | Guarantees |
|---|---|
| `tests/worker/contact.test.ts` (~21K, largest file) | **Origin enforcement**: any `Origin` not exactly `url.origin` — including a *missing* `Origin` header — is `403` (this is the fix for the F1 cross-site-bypass incident; see `resumesite-failure-archaeology`). **Input validation**: non-allowlisted `Content-Type` → `415`; oversized body → `413` both via declared `Content-Length` *and* via the real stream cap (`readBodyCapped`) so a client can't lie about length; empty/malformed name/email/message → redirect to `/contact-error/`; control characters (e.g. `\n` for header injection) are stripped from name/email before persisting. **Turnstile**: missing token, `success:false`, a network error, and a non-JSON siteverify response all fail *closed* (redirect, and — for the network/malformed cases — no D1 row is written). **Honeypot**: `bot-field` filled → silent redirect to `/thank-you/`, upstream `fetch` never called, no row stored. **Rate limit**: the 6th POST from one IP inside the window → `/contact-error/`; a *missing* `CF-Connecting-IP` is never rate-limited; **failed Turnstile attempts count toward the limit** (so failing the challenge on purpose can't be used to hammer siteverify/D1 for free) — verified by asserting the 6th request is rejected *before* any upstream `fetch` fires. **ForwardEmail failure**: mail-send failure or unreachable upstream still keeps the D1 row and redirects to `/thank-you/?delivery=delayed` rather than losing the submission. **Branded emails**: owner notification and sender auto-reply each assert `to`/`from`/`replyTo` routing, brand color `#3F51B5` present, and that HTML injection in name/message (`<script>`, angle brackets) is escaped in the rendered email. **Router**: non-POST → `405` with `Allow` header; `OPTIONS` → `204`. |
| `tests/worker/assets.test.ts` | Fingerprinted-asset fallback logic: serves an existing hashed asset (`/css/style.0123456789.css`) directly; falls back to the unhashed asset (`/css/style.css`) when the fingerprint in the URL is stale, for both CSS and JS; 404s when neither the hashed nor unhashed path exists; 404s for ordinary missing paths that were never fingerprinted at all. Uses a **stubbed** `ASSETS` fetcher (fixed path→body map), not a real `dist/`, so this runs without a build. |
| `tests/lib/blog-post.test.js` (~16K, second-largest) | The full AI blog-draft pipeline's guard rails, unit by unit: `slugify`, `isValidTitle` (rejects file paths, extensions, too-short/too-long, code-identifier-heavy, single-word, empty/nullish, and titles that start with their own `"Title:"` residue), `extractTitle`/`extractFirstHeading`/`reconcileTitle` (TITLE: directive vs. first H1, ignoring headings inside fenced code blocks, picking the *body* heading when the directive is an unrelated stray code line), `stripTitleDirective`, `extractTags` (dedupe, cap at 6), `findExactDuplicate` (slug/title collision against real files on disk via a temp dir, case-insensitive, ignoring date prefix), `makeExcerpt` (150-char cut that never breaks mid-word, strips `**`/`` ` ``/`[...]`), `buildFrontmatter` (quote-escaping, tags as YAML list, series emitted as a commented *hint* when absent vs. real frontmatter when supplied), `findMostSimilar` (lexical Jaccard) and `findMostSimilarSemantic` (cosine over injected embed function, on-disk embedding **cache** keyed by SHA-256 verified to avoid recomputation, and a hard throw when the embed function returns a non-array), and `pickUniqueTopic` (retries on a near-duplicate, retries on lexical fallback if `embed` throws, still rejects an **exact** title/slug repeat even when similarity scoring would have passed it, and throws after `PICK_TOPIC_MAX_ATTEMPTS` is exhausted). `DUPLICATE_THRESHOLD`/`SEMANTIC_THRESHOLD` are asserted to be sane (0,1) bounds, not their exact values (those are documented, with drift risk, in `resumesite-config-and-flags`). |
| `tests/lib/resume-pdf.test.js` | `renderResumePdf()` produces a structurally valid PDF: starts with `%PDF-`, ends with `%%EOF`, is > 20,000 bytes (a tiny file means rendering silently bailed), contains the *actual* `profile.name`/`profile.title` from `blog-src/src/data/resume.ts` (proving it was built from the shared data module, not stale/hardcoded text), and has >= 2 `/Type /Page` objects (the full work history needs more than one page). |
| `tests/lib/search.test.js` | `escapeHtml` neutralizes `<`, `"`, `'`, `&`; `filterPosts` matches case-insensitively across title/excerpt/category/tags and combines a text query with a category filter; `renderPostCard` escapes malicious content in every interpolated field (title/excerpt/category) and stamps the Astro scoped-style attribute (`data-astro-cid-*`) onto *every* rendered element, verified by counting tags vs. scoped-attribute occurrences; `describeResults` produces the exact human-readable copy for 0/1/N results and category-only vs. query filtering. This is the client-side blog search UI's logic, tested outside a browser. |
| `tests/site/content.test.ts` | **Always runs** (no dist/ dependency). Mirrors the Zod schema in `blog-src/src/content.config.ts` against every real file in `blog-src/src/content/posts/` (applying the same `[^_A-Z]` glob-loader filter the site build uses, so `_partials`/`CLAUDE.md`-style files are excluded the same way). Asserts: required fields present (`title`, `date`, `category`, `excerpt`); `title` <= 200 chars, `excerpt` <= 300 chars; `category` is a lowercase-hyphenated slug; `date` parses to a real calendar date; `updated` (if present) is not before `date`; slugs (filenames) are unique both as-is and with the date prefix stripped (this literal scenario — the same post published twice under two date prefixes — happened once per an in-file comment, driving this specific check); titles are unique case-insensitively; and — for posts dated after **2026-07-04** — `tags` must be a non-empty YAML list (older posts are grandfathered, not backfilled). |
| `tests/site/build-output.test.ts` | **Self-skips whole-file when `dist/` is absent** (see §2). When it runs (post-build, in CI's `site` job), asserts a fixed list of paths exist under `dist/`: `index.html`, `resume/index.html`, `resume.pdf`, `services/index.html`, `uses/index.html`, `privacy/index.html`, `404.html`, `blog/index.html`, `blog/about/index.html`, `blog/rss.xml`, `blog/search.json`, `feed.json`, `sitemap-index.xml`, `llms-full.txt`, `robots.txt`, `_headers`; that the home page is non-trivial (`<title` present, > 1000 chars); that at least one OG PNG exists under `dist/og/`; that `resume.pdf` in `dist/` is a real (`%PDF-` header) file > 20,000 bytes; and that `dist/blog/search.json` parses as a non-empty JSON array. This is the last line of defense against a build that "succeeds" (exit 0) but silently omits a route or renders a blank artifact. |

## 4. How to add a test

1. **Decide which project it belongs in** (this decision is load-bearing —
   putting a test in the wrong project either can't reach the API it needs,
   or unnecessarily pays for a Workers-runtime boot):
   | New behavior is in... | Goes in | Naming |
   |---|---|---|
   | The Cloudflare Worker (`worker/index.ts`, `worker/api/*.ts`, `worker/email/*.ts`) — anything that needs the real Workers runtime, D1, or Worker routing | `tests/worker/` | `*.test.ts` |
   | A shared JS/TS library used outside the Worker (`scripts/lib/*.js`, or an Astro-side util in `blog-src/src/utils/*.ts` that plain Node can import) | `tests/lib/` | `*.test.js` (even though it may import a `.ts` module — see §2) |
   | A content-collection/frontmatter invariant, or a "the production build must emit X" invariant | `tests/site/` | `*.test.ts` |
2. **Match the file's existing conventions** — the `worker` project tests
   build requests with a small local helper (see `makeContactRequest` /
   `stubUpstreams` in `contact.test.ts`) and stub upstream `fetch` calls
   (Turnstile siteverify, ForwardEmail) rather than hitting the network; the
   D1 schema is duplicated by hand inside `contact.test.ts` as
   `TEST_SCHEMA_STATEMENTS` because the Workers sandbox can't read
   `worker/schema.sql` off the host filesystem — **if you change
   `worker/schema.sql`, update that inline copy too, or the tests silently
   drift from the real schema.**
3. **New behavior needs a passing test before merge.** This isn't a style
   preference — it's the same PR + green-CI bar as everything else; see
   `resumesite-change-control` for how that's enforced. A behavior change
   with no corresponding new/updated test in one of these three projects is
   not evidenced, regardless of how confident the PR description sounds.
4. Run `npm test` (root) to confirm your new test and the rest of the suite
   both pass, and re-check the total against §1 row 3 — a new test changes
   the "328 passed" number, so update anything that quotes it (including,
   if relevant, this skill — see Provenance below).

## 5. What is NOT covered (honest gaps)

- **No end-to-end browser test.** There is no Playwright/Cypress/Puppeteer
  anywhere in the repo (verified: no such dependency in either
  `package.json`). Nothing here drives a real browser against the live site
  or a preview server; `tests/site/build-output.test.ts` only inspects the
  static `dist/` files on disk.
- **Lighthouse `numberOfRuns: 1` is noisy.** `lighthouserc.json` runs each
  audited URL exactly once — there's no averaging across runs, so a
  borderline accessibility score can flip pass/fail between CI runs on the
  same code. Treat a single failing Lighthouse run near the 0.90 boundary as
  worth a re-run before treating it as a real regression.
- **No visual regression testing.** Nothing screenshots or diffs rendered
  pages; a CSS change that doesn't break an assertion above (frontmatter,
  required routes, Lighthouse categories) can still visually break the site
  undetected by this test suite.
- **Coverage is behavioral, not exhaustive.** The inventory in §3 is what is
  *actually* asserted, not a claim that every code path in `worker/`,
  `scripts/lib/`, or `blog-src/src/utils/` is exercised.

## Provenance and maintenance

Compiled 2026-07-05 against the `skills` worktree of resumesite. Re-verify
anything below before trusting it in a future session — these are exactly
the numbers that drift as the repo grows:

| Fact | Re-verify with |
|---|---|
| `npm test` totals (328 passed / 20 skipped, 6 files passed / 1 skipped) | `npm test` (root) |
| `npm run typecheck` (0 errors / 0 warnings / 12 hints / 49 files) | `cd blog-src && npx astro check` |
| `npm run lint` clean | `npm run lint` |
| The 3 vitest projects and their `include` globs | `cat vitest.config.ts` |
| `tests/site/build-output.test.ts` self-skip condition | `grep -n "skipIf\|hasDist" tests/site/build-output.test.ts` |
| Required `dist/` paths list | `grep -n "const required" -A 20 tests/site/build-output.test.ts` |
| Tags-required-after date gate (currently 2026-07-04) | `grep -n "TAGS_REQUIRED_AFTER" tests/site/content.test.ts` |
| Lighthouse thresholds / audited URLs | `cat lighthouserc.json` |
| CI job structure that these checks mirror | `cat .github/workflows/ci.yml` |
| No e2e/visual-regression tooling present | `grep -iE "playwright|cypress|puppeteer|percy|chromatic" package.json blog-src/package.json` (expect no matches) |
