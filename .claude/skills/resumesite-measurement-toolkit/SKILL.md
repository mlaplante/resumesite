---
name: resumesite-measurement-toolkit
description: Method and worked examples for PROVING a claim about resumesite instead of asserting it — how to read the Lighthouse CI gate (error vs warn), how the blog dedupe pipeline derives its 0.85 cosine-similarity threshold from data (with the actual code comments and test quoted), how tests/site/build-output.test.ts proves the build produced real artifacts (not just files that exist), and the general "predict the number before you run it" discipline with a worked 328/348 example. Load this when asked "how do we know this is actually better/faster/more accessible", "why is the dedupe threshold 0.85", "what does cosine similarity vs Jaccard mean here", "how do I know the build actually worked, not just that it didn't crash", "prove this test count / score / claim", "is a passing test enough evidence", or before writing a new measurement/verification check for this repo. Do NOT use for exact CLI invocation and current pass/fail baselines (see resumesite-diagnostics-and-tooling), the merge-bar checklist and test inventory (see resumesite-validation-and-qa), the PR/CI gating rules (see resumesite-change-control), the AI-draft content campaign (see resumesite-blog-quality-campaign), or the general reasoning discipline for trusting a number (see resumesite-evidence-and-methodology) — this skill owns the underlying MEASUREMENT METHOD and its worked derivations, not the commands, the checklist, or the philosophy.
---

# resumesite Measurement Toolkit

This is the "prove it, don't eyeball it" toolkit for resumesite (michaellaplante.com — Astro 6 static
site + Cloudflare Worker + D1). Every recipe below follows the same shape: **method → when to reach
for it → exact commands → how to read the output → a worked example already sitting in this repo.**

The one rule that ties all four recipes together, stated up front so you internalize it before reading
the recipes:

> **A passing self-written check is evidence that the check ran — not evidence that your claim is
> true.** `expect(existsSync(file)).toBe(true)` proves a file is present at that path. It does NOT
> prove the file is a valid PDF, a non-empty search index, or a real Lighthouse pass. If you want the
> stronger claim, the check has to assert the stronger thing. See Recipe 3 for how this repo actually
> does that. The reasoning discipline behind this bar (why an eyeballed diff isn't evidence, when a
> claim needs a citation) is owned by `resumesite-evidence-and-methodology` — this skill only shows the
> mechanics of writing checks that clear that bar.

---

## Recipe 1 — Measuring accessibility/performance regressions with Lighthouse CI

**Method.** Lighthouse CI (`@lhci/cli`) runs real Lighthouse audits against the *built* `dist/`
output and asserts numeric thresholds per category. Verified from `lighthouserc.json` (repo root):

```json
{
  "ci": {
    "collect": {
      "staticDistDir": "./dist",
      "url": [
        "http://localhost/index.html",
        "http://localhost/blog/index.html",
        "http://localhost/blog/hello-world/index.html",
        "http://localhost/services/index.html",
        "http://localhost/resume/index.html"
      ],
      "numberOfRuns": 1
    },
    "assert": {
      "assertions": {
        "categories:accessibility": ["error", { "minScore": 0.9 }],
        "categories:performance": ["warn", { "minScore": 0.8 }],
        "categories:best-practices": ["warn", { "minScore": 0.9 }],
        "categories:seo": ["warn", { "minScore": 0.9 }]
      }
    }
  }
}
```

**When to use.** Any change that touches layout, images, fonts, third-party scripts, `_headers`, or
anything rendered on the home page / blog index / a post page / services / résumé — the five pages
above are the only ones actually audited. A change to a page NOT in that list (e.g. `/uses/`,
`/privacy/`) gets zero Lighthouse coverage; don't claim a Lighthouse-verified a11y score for it.

**Exact commands** (this is what CI's `site` job runs, in order — see `.github/workflows/ci.yml`):
```bash
cd blog-src && npm run build        # NOT `npm run build` from root mid-session — see note below
cd .. && npx lhci autorun --config=lighthouserc.json
```
UNVERIFIED — check the exact `lhci` invocation flags in `.github/workflows/ci.yml` before copying
verbatim into a script; the fact above is paraphrased from the fact-sheet, not re-read line-by-line
from the workflow YAML in this session.

**Never run `npm run build` yourself to test this** — it deletes files under `blog-src/src` and
writes `dist/`. If you need a real Lighthouse number, that's CI's job on a PR; locally, reason from
the config's thresholds instead of fabricating a score.

**How to read the output.** `numberOfRuns: 1` — a single run per URL, so a borderline score can be
noisy; do not treat one run as statistically definitive, only as this PR's gate result.
- `categories:accessibility` is the **only** `"error"` assertion. Score `< 0.90` on ANY of the 5 URLs
  **fails the `site` CI job — the PR cannot merge.**
- `performance`, `best-practices`, and `seo` are `"warn"`. A score under 0.80 / 0.90 / 0.90
  respectively is **visible in the CI log but does not fail the check.** This is a real trap: a
  performance regression that tanks Core Web Vitals will NOT block a merge by itself. Someone has to
  actually read the warn output — CI going green is not proof performance held steady.

**Worked example (do not fabricate a number).** There is no Lighthouse score committed anywhere in
this repo to quote — verified via `git ls-files | grep -i lighthouse`, which returns only
`lighthouserc.json` itself (no cached report, no badge value). So the correct worked example is
conditional on the gate, not a specific historical score:
- If `/index.html` scores accessibility `0.89` → the `site` job **fails**, PR blocked, regardless of
  how good performance/SEO look.
- If the same build scores performance `0.75` (a real regression from, say, an unoptimized hero
  image) → the job **still passes**; the drop only shows up as a warn line in the CI log.
This is the practical meaning of "accessibility is the only category that blocks": a change that
visibly slows the site can still merge green. Don't read a green `site` job as "no perf regression" —
read it as "no a11y regression under 0.90"; for what the tool prints for a live number, see
`resumesite-diagnostics-and-tooling`.

---

## Recipe 2 — Deriving a dedupe similarity threshold from data, not from a guess

**Method.** The AI blog-draft pipeline (`scripts/lib/blog-post.js`) has to decide "is this new draft
too similar to an existing post?" It uses two different similarity measures and picks a threshold for
each — and the file's own comments document *why* those numbers, not just what they are. Quoting
`scripts/lib/blog-post.js` lines 21–27 verbatim:

```js
export const DEFAULT_DAYS = 7;
// Tokens overlap >= this fraction of the combined significant vocabulary → treat as duplicate.
export const DUPLICATE_THRESHOLD = 0.5;
// Cosine similarity threshold for semantic embedding-based duplicate detection.
// Empirically: ~0.85 catches "X with eBPF" vs "X with Istio" but not unrelated
// posts. Tune via SEMANTIC_THRESHOLD env var.
export const SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD ?? 0.85);
```

**The two measures, in plain terms:**
- **Jaccard similarity** (`jaccard()`, lines 282–287) — a *lexical* measure. Tokenize both titles into
  sets of significant words (lowercased, stripped of a stopword list, `length > 2`; see `STOPWORDS`
  lines 266–271), then divide the size of the intersection by the size of the union:
  `intersection / (a.size + b.size - intersection)`. It only sees surface words. "Zero-Trust
  Segmentation with eBPF" vs "Zero-Trust Segmentation with Istio" shares 3 of 4 significant tokens —
  Jaccard scores it fairly high (lexical overlap), which is actually the easy case; Jaccard's blind
  spot is a rewrite that changes ALL the surface words but keeps the same idea.
- **Cosine similarity** (`cosine()`, lines 330–340) — a *semantic* measure over embedding vectors
  (`dot(a,b) / (|a| * |b|)`). Two titles that share zero literal words but mean the same thing (e.g. a
  rewrite that swaps every noun) still land close together in embedding space, so cosine catches what
  Jaccard structurally cannot.
- The pipeline **prefers semantic** when an `embed` adapter is available (`scoreSimilarity()`, lines
  438–449) and **falls back to lexical Jaccard** when embedding fails or isn't wired up — a graceful
  degradation, not a silent skip: `pickUniqueTopic` still runs, just with the weaker signal.

**Why 0.85, and how you'd re-derive it instead of guessing.** The comment states the threshold was
picked empirically against a concrete pair ("eBPF" vs "Istio" rewrites of the same post idea) and
tuned to sit above real near-duplicates but below genuinely different posts. You do not have to take
the comment on faith — it is backed by an actual test. `tests/lib/blog-post.test.js` lines 311–328:

```js
it('matches the post with the closest embedding vector', async () => {
  const embed = async (text) => {
    if (text.includes('eBPF')) return [1, 0.9, 0.1, 0.2];
    if (text.includes('Istio')) return [0.95, 0.95, 0.05, 0.15];
    if (text.includes('Cast Iron')) return [0.1, 0.2, 1, 0.8];
    return [0, 0, 0, 0];
  };
  const result = await findMostSimilarSemantic(
    { title: 'Zero Trust with eBPF', excerpt: '' },
    [{ title: 'Zero Trust with Istio', excerpt: '' }, { title: 'Cooking with Cast Iron', excerpt: '' }],
    embed,
  );
  expect(result.title).toBe('Zero Trust with Istio');
  expect(result.score).toBeGreaterThan(SEMANTIC_THRESHOLD);   // > 0.85
});
```
The eBPF/Istio vectors (`[1,0.9,0.1,0.2]` vs `[0.95,0.95,0.05,0.15]`) cosine to roughly 0.996 — well
above 0.85 — while the Cast Iron vector (`[0.1,0.2,1,0.8]`) is nearly orthogonal to both, scoring near
0. That's the entire claim made concrete: same-idea rewrite clears 0.85, unrelated topic doesn't come
close. This test is your regression guard on the threshold itself — if a future change to the cosine
math or the threshold breaks this assertion, you'll know before it ships, not after a real duplicate
post gets published.

**If you need to re-tune the threshold on real (not synthetic) posts:** sample the actual pairwise
similarity distribution across the ~70+ real posts in `blog-src/src/content/posts/` — that requires a
live embedding call per post, so it is not something to script blind here. That sampling tool
(`dedupe-audit`) is owned by `resumesite-diagnostics-and-tooling`; load that skill to run it and read
its histogram output. This skill's job stops at "here is the method and the proof it currently works,"
not "here is a live audit of today's corpus."

**When to use this recipe.** Before changing `SEMANTIC_THRESHOLD` or `DUPLICATE_THRESHOLD` (env-tunable,
see `resumesite-config-and-flags` for the tunable's operational meaning), before trusting a
`console.warn` about similarity as either a false positive or a real catch, or before adding a new
similarity measure to the pipeline.

---

## Recipe 3 — Proving the build actually produced its artifacts (not assuming it did)

**Method.** `tests/site/build-output.test.ts` is a smoke test that runs against a *real* `dist/`
directory after `npm run build` — it self-skips (`describe.skipIf(!hasDist)`) when `dist/` doesn't
exist, so a plain local `npm test` never blocks on it; only CI's `site` job (which builds first) makes
it actually assert. This is the difference between "the build didn't crash" and "the build produced
the specific artifacts the site depends on" — OG images, the résumé PDF, the search index, the RSS/JSON
feeds, `_headers`. A crash-free build and a *correct* build are different claims; this test targets the
second.

**Exact commands:**
```bash
cd blog-src && npm run build   # or: npm run build from repo root (root script cd's into blog-src)
cd .. && npx vitest run --project site
```

**How to read the output — and why "file exists" isn't the same claim as "artifact is real."** Read
the actual assertions (verified, `tests/site/build-output.test.ts`):
- Lines 15–36: a flat list of **16 required paths** (`index.html`, `resume.pdf`, `blog/rss.xml`,
  `feed.json`, `sitemap-index.xml`, `_headers`, etc.), each checked with a plain
  `expect(existsSync(...)).toBe(true)`. This is the *weak* claim — "a file is at this path" — and it's
  appropriate here because these are unstructured pass-through/generated files where existence is most
  of what matters.
- Lines 38–42 (home page): does NOT stop at existence. It reads the file and asserts
  `html.toContain('<title')` AND `html.length > 1000` — because an Astro build that emits a 12-byte
  error stub would still pass an `existsSync` check.
- Lines 44–49 (OG images): asserts `dist/og` exists AND that the `.png` file list inside it is
  non-empty (`pngs.length > 0`) — proving at least one per-post OG card actually rendered, not just
  that the directory was created.
- Lines 51–55 (résumé PDF): the strongest example in the file. It doesn't just check the file exists —
  it reads the first 5 bytes and asserts they equal the literal string `%PDF-` (the real PDF magic
  number), AND asserts the file is `> 20_000` bytes. A zero-byte or truncated PDF would pass an
  `existsSync` check and fail both of these.
- Lines 57–63 (search index): parses `blog/search.json` as JSON and asserts it's an array with
  `length > 0` — proving the index is populated, not just present and syntactically valid.

**Worked example — predicting the skip count before running.** The file has exactly **16** entries in
the `required` array (one `it.each` test per entry) **plus 4** standalone `it(...)` blocks (home page,
OG cards, PDF, search index) = **20 tests total** in this one file. You can predict that number by
reading the file — no build needed. Verified 2026-07-05: `npm test` reports this file as the sole
`1 skipped` file (of 7), contributing exactly `20` to the `20 skipped` count in `328 passed | 20
skipped (348)`. That match (count the assertions in the source → compare to the runner's skip count)
is Recipe 4 in miniature, worked concretely.

**When to use.** Before claiming "the build works" in a PR description, a postmortem, or a status
update — "CI's `test` job is green" only proves the 328 non-build-dependent tests pass; it says nothing
about `dist/` unless the `site` job also ran and this file's 20 assertions were live, not skipped. For
the full inventory of what each test file guarantees (this one included), see
`resumesite-validation-and-qa`.

---

## Recipe 4 — "Predict the number before you run it"

**Method.** State the exact number you expect — a test count, a score, a similarity value — in
writing, from reading source, BEFORE you execute anything. Then run the command and diff your
prediction against the actual output. A match is corroborating evidence your mental model of the code
is correct. A mismatch is the most valuable signal you'll get all day — it means either your model of
the code is wrong, or the environment differs from what you assumed (stale deps, uncommitted change,
skipped file). Either way, investigate the mismatch before trusting the number.

**Worked example — the 328/348 baseline (verified 2026-07-05, re-run live in this session):**
1. **Predict:** `tests/site/build-output.test.ts` self-skips without `dist/` (see Recipe 3) — with no
   local build present, its 20 tests should be skipped, not passed or failed. The other 6 test files
   (`worker/contact.test.ts`, `worker/assets.test.ts`, `lib/blog-post.test.js`, `lib/resume-pdf.test.js`,
   `lib/search.test.js`, `site/content.test.ts`) should all run and pass. So: predict **7 test files**
   (6 run + 1 fully-skipped), and some total pass count with **exactly 20 skipped**.
2. **Run:**
   ```bash
   npm test
   ```
3. **Observe (this session, 2026-07-05):**
   ```
   Test Files  6 passed | 1 skipped (7)
        Tests  328 passed | 20 skipped (348)
   ```
   Matches the prediction exactly: 7 files, 1 fully skipped, 20 skipped tests. `328 + 20 = 348` total
   collected.

**A second, smaller worked example** in the same run: `tests/lib/blog-post.test.js` alone, re-run in
isolation this session —
```bash
npx vitest run --project lib tests/lib/blog-post.test.js
```
reported **56 passed / 0 failed** (2026-07-05). If you'd read the `describe` blocks first (14 top-level
groups covering `slugify`, `isValidTitle`, `extractTitle`, `stripTitleDirective`, `extractFirstHeading`,
`reconcileTitle`, `extractTags`, `findExactDuplicate`, `makeExcerpt`, `buildFrontmatter`,
`findMostSimilar`, `findMostSimilarSemantic`, `pickUniqueTopic`, and the threshold sanity checks) you
could tally the `it(...)` blocks and predict 56 before running — the exercise is mechanical once you
accept the discipline of counting before executing.

**Why this matters more than it looks.** The habit catches two failure modes cheaply: (a) you
misremember what a file does (the prediction is wrong, the run is right — your model was stale), and
(b) the environment is broken in a way a "just run it and see" workflow would silently accept (the
prediction is right, the run disagrees — something changed). Neither failure mode is visible if you
only ever look at output after the fact with no prior commitment to what it should say.

---

## When NOT to use this skill

| You need... | Use instead |
|---|---|
| The exact CLI invocation for `lhci`, `vitest --project X`, `astro check`, and today's live baselines | `resumesite-diagnostics-and-tooling` |
| To interpret a `Rejected candidate "..." — NN% semantic/lexical similarity` warning in a live run, or run the dedupe-audit sampling tool | `resumesite-diagnostics-and-tooling` |
| The full test-file inventory and what each one guarantees, or "is X tested" | `resumesite-validation-and-qa` |
| The merge-bar checklist / PR gating rules | `resumesite-change-control` |
| The general reasoning discipline for when a claim needs evidence at all | `resumesite-evidence-and-methodology` |
| The AI blog-draft content campaign itself (cadence, focus window, review flow) | `resumesite-blog-quality-campaign` |
| `SEMANTIC_THRESHOLD` / `DUPLICATE_THRESHOLD` as configuration knobs (env var name, how to set it) | `resumesite-config-and-flags` |

This skill never tells you to skip CI or merge without the green checks above — it only teaches how to
generate a number worth trusting in the first place. Gating itself is `resumesite-change-control`'s job.

---

## Provenance and maintenance

Compiled 2026-07-05 against branch `skills` in this worktree. Re-verify anything below before relying
on it in a future session — these are exactly the facts most likely to drift.

| Fact | Re-verify with |
|---|---|
| `npm test` baseline: 328 passed / 20 skipped (348), 6 files passed / 1 skipped (7) | `npm test` |
| `tests/lib/blog-post.test.js` alone: 56 passed | `npx vitest run --project lib tests/lib/blog-post.test.js` |
| `build-output.test.ts` has 16 `required[]` paths + 4 standalone tests = 20 | `grep -c "^\s*'" tests/site/build-output.test.ts` (count the required-array entries) and re-read the file for standalone `it(...)` blocks |
| Lighthouse thresholds (a11y error@0.90; perf/BP/seo warn@0.80/0.90/0.90) and the 5 audited URLs | `cat lighthouserc.json` |
| No historical Lighthouse score is committed in this repo | `git ls-files \| grep -i lighthouse` (expect only `lighthouserc.json`) |
| `SEMANTIC_THRESHOLD` default 0.85, `DUPLICATE_THRESHOLD` 0.5, and the eBPF/Istio/Cast-Iron test vectors | `sed -n '20,27p' scripts/lib/blog-post.js` and `sed -n '304,328p' tests/lib/blog-post.test.js` |
| Cosine/Jaccard implementations | `sed -n '282,287p;330,340p' scripts/lib/blog-post.js` |
| `npm run typecheck` / `npm run lint` current state (not re-verified in depth for this skill — see `resumesite-diagnostics-and-tooling` for the authoritative current baseline) | `npm run typecheck`, `npm run lint` |

If any re-verify command above disagrees with this file, the command wins — update the table, not your
memory of it.
