---
name: resumesite-blog-quality-campaign
description: Executable campaign runbook for the AI blog-draft QUALITY problem on resumesite (michaellaplante.com) — near-duplicate posts, off-topic drift, weak/file-path-shaped titles, thin content. Load this when asked to "fix the AI drafts", "tune the dedupe threshold", "the blog pipeline is generating duplicates", "why did it accept/reject this topic", "improve blog-post quality", "SEMANTIC_THRESHOLD", "DUPLICATE_THRESHOLD", "PICK_TOPIC_MAX_ATTEMPTS", when you see a console line `Rejected candidate "..." — NN% semantic/lexical similarity` or `Could not find a sufficiently unique topic after 4 attempts`, or `Refusing to write duplicate post`, or when reviewing/changing scripts/lib/blog-post.js, scripts/generate-post.js, scripts/generate-post-gemini.js, or .github/workflows/generate-blog-post.yml. Gives numbered phases with EXPECTED numbers and branch gates, a ranked solution menu with a theory-before-code obligation per item, explicit wrong-path fences, and a test-first validation/promotion protocol. Do NOT use this for day-to-day drafting or frontmatter/voice questions (see resumesite-content-and-writing), for interpreting a single diagnostic run or the dedupe-audit tool itself (see resumesite-diagnostics-and-tooling), for the underlying "how do we know 0.85 is right" measurement method (see resumesite-measurement-toolkit), or for the PR/merge gate mechanics (see resumesite-change-control). This is the hard-problem campaign, not a lookup table.
---

# resumesite: AI Blog-Draft Quality Campaign

Baselines in this file were verified live against the repo on **2026-07-05** (branch
`skills`). Re-run the commands in "Provenance and maintenance" before trusting a number
that looks stale.

## 0. The problem, stated precisely

The AI blog-draft pipeline (`scripts/lib/blog-post.js`, shared by `scripts/generate-post.js`
[Anthropic] and `scripts/generate-post-gemini.js` [Gemini, used by CI]) has produced, at
different points in its history, four distinct quality failures:

1. **Near-duplicate posts** — same topic, different surface wording (e.g. "...with eBPF" vs
   "...with Istio"), or the same idea published twice under slightly different titles.
2. **Off-topic drift** — auto-picked topics wandering away from the site's declared voice
   (an SVP of Information Security's technical blog), or away from the temporary
   cybersecurity/AI-governance focus window (expires **2026-08-12**, see §3).
3. **Weak or malformed titles** — the LLM emitting a file path, a code identifier, or a
   stray line from the prompt instead of a human title.
4. **Thin depth** — generated content that reads as generic filler rather than a real
   technical deep-dive. **No automated check for this exists today** — it is caught only by
   human PR review. Treat any "depth score" as unverified/candidate until a real metric is
   built (see `resumesite-measurement-toolkit` for the "predict before you measure"
   discipline that a new metric must follow).

Failures #1–#3 are actively defended in code (§1–§2 below). Failure #4 is not — call this
out plainly in any change-control writeup rather than implying it's covered.

## 1. Which command exercises which guard (read this before "reproducing" anything)

This is the single most important fact this skill adds on top of the source: **the two
provider scripts do NOT exercise the same guards**, and the manually-run npm scripts do
**not** exercise the pipeline's semantic dedupe at all.

| Entry point | Provider | `embed` adapter passed? | Initial topic dedupe (`pickUniqueTopic`, up to 4 attempts) | Final post re-score guard | Exact title/slug guard | Title extract + reconcile |
|---|---|---|---|---|---|---|
| `npm run blog:draft:git` (`generate-post.js git`) | Anthropic | No | N/A — git mode never calls `pickUniqueTopic` | **No** — gated on `fromGit === false`; git mode sets `fromGit = true` | Yes | Yes |
| `npm run blog:draft:topic` (`generate-post.js topic "..."`) | Anthropic | No | N/A — mode is set to `'topic'` directly, `pickUniqueTopic` never runs | **No** — gated on `supportsAuto`, and `generate-post.js` passes `supportsAuto: false` | Yes | Yes |
| CI cron / `workflow_dispatch mode=auto` (`generate-post-gemini.js auto`) | Gemini | Yes | **Yes** — semantic (cosine ≥ `SEMANTIC_THRESHOLD`, default 0.85) with lexical Jaccard (`DUPLICATE_THRESHOLD` 0.5) fallback if embedding fails | **Yes** | Yes | Yes |
| `workflow_dispatch mode=topic` (`generate-post-gemini.js topic "..."`) | Gemini | Yes | No — an explicit topic skips `pickUniqueTopic` | **Yes** | Yes | Yes |
| `workflow_dispatch mode=git` (`generate-post-gemini.js git`) | Gemini | Yes | N/A (git mode) | **No** (`fromGit = true`) | Yes | Yes |

Verified by tracing `runGenerator()` in `scripts/lib/blog-post.js`: the `pickUniqueTopic`
call only happens inside `if (mode === 'auto')`; the final re-score guard is
`if (supportsAuto && !fromGit)`; `generate-post.js` calls `runGenerator({ ..., supportsAuto:
false })` and never passes an `embed` function; `generate-post-gemini.js` calls it with
`supportsAuto: true` and a real Gemini `embed` adapter.

**Consequence:** the manual `npm run blog:draft:*` commands can and will write a lexically-
or semantically-near-duplicate post — only an *exact* (case-insensitive title, or slug)
repeat is ever rejected on those commands. The full multi-layer defense this skill is
about exists **only** in the Gemini path that CI actually runs on cron. Any quality
investigation must center on `generate-post-gemini.js` and the `auto`/`topic`-with-
`pickUniqueTopic` paths, not on `blog:draft:*`.

Also note: `npm run blog:draft:*` **writes a real file** into
`blog-src/src/content/posts/` and needs `ANTHROPIC_API_KEY`. Do not run it yourself to
"test" something — it mutates the working tree and costs API tokens for a nondeterministic
result. Use the deterministic Phase 1 reproduction below instead.

## 2. Current defenses, in the order they fire (`scripts/lib/blog-post.js`)

1. **Exact duplicate guard** (`findExactDuplicate`) — case-insensitive title match OR slug
   match against any `YYYY-MM-DD-<slug>(-N)?.md` in `blog-src/src/content/posts/`, checked
   both when picking a topic and as the absolute last line of defense right before
   `writePostCollisionSafe`. Never threshold-dependent — always fires.
2. **Semantic similarity** (`findMostSimilarSemantic`) — embeds candidate `title + excerpt`
   and every existing post's `title + excerpt`, cosine similarity, reject if
   `>= SEMANTIC_THRESHOLD` (env-tunable, default **0.85**). Embeddings are cached on disk at
   `scripts/.embeddings-cache.json` (gitignored — **do not commit it**) keyed by SHA-256 of
   the input text, so a daily run embeds only the new candidate, not all 111 posts.
3. **Lexical Jaccard fallback** (`findMostSimilar`, `DUPLICATE_THRESHOLD = 0.5`) — used only
   when no `embed` adapter is supplied, or the embed call throws (rate limit, transient
   error). Degrades gracefully instead of aborting the run.
4. **Topic-pick retries** — `pickUniqueTopic` tries up to `PICK_TOPIC_MAX_ATTEMPTS = 4`
   candidates before throwing `Could not find a sufficiently unique topic after 4
   attempts.` (auto mode only).
5. **Title extraction + reconciliation** — `extractTitle` prefers a `TITLE:` directive,
   falls back to the first H1 outside code fences; `isValidTitle` rejects file paths, file
   extensions, single-word titles, code-identifier-heavy strings, and `Title:`-residue.
   If no valid title comes back, one retry is issued with a stricter prompt. Then
   `reconcileTitle` cross-checks the extracted title against the body's opening H1/H2 via
   lexical Jaccard and **prefers the heading when they disagree (score < 0.3)** — this is
   what fixed the real published failure title *"Define the Lambda function"* over a body
   headed *"Taming the Fire: Automating Incident Response with Serverless and IaC."*
6. **Final excerpt re-score** — after generation, `makeExcerpt(content)` is re-scored against
   existing posts (same semantic/lexical logic) before the file is written — catches drift
   the LLM introduced after the topic was picked. Gated on `supportsAuto && !fromGit` (see
   §1 table).
7. **Exact-repeat last line** — `findExactDuplicate` runs again on the final title/slug
   immediately before `writePostCollisionSafe`; `process.exit(1)` refuses to write.

## 3. The content-focus date-gate (do not confuse with a quality bug)

`FOCUS_UNTIL = '2026-08-12'` in `scripts/lib/blog-post.js`. While `focusActive(today)` is
true, `activeSystemPrompt()` and `topicPickerPrompt()` steer every auto/topic-mode draft
toward cybersecurity + AI-governance-in-security topics (NIST AI RMF, ISO/IEC 42001, EU AI
Act framing). After that date both functions revert to the general `SYSTEM_PROMPT`
("Avoid making AI the primary topic") automatically — no manual cleanup needed. **If a
post published after 2026-08-12 still reads as security/AI-governance-focused, that is a
content decision, not a pipeline bug** — check the git-committed date of `FOCUS_UNTIL`
first, don't assume the gate silently failed.

There is currently **no test** covering `focusActive`, `activeSystemPrompt`, or
`topicPickerPrompt` in `tests/lib/blog-post.test.js` (verified: `grep -n "focusActive"
tests/lib/blog-post.test.js` returns no match, 2026-07-05). Any change to focus-window
behavior (Menu item B below) must add that coverage — see §6.

## 4. Numbered campaign phases

### Phase 0 — Baseline (read-only, run this first)

```bash
# Count published posts
ls blog-src/src/content/posts/*.md | wc -l

# Run the lexical dedupe audit owned by resumesite-diagnostics-and-tooling
# (imports findMostSimilar/getExistingPosts directly from scripts/lib/blog-post.js
# so it can never drift from the real lexical fallback's scoring).
node .claude/skills/resumesite-diagnostics-and-tooling/scripts/dedupe-audit.mjs 20
```

**Observed 2026-07-05** (date-stamp this — it will drift as new posts publish):
- 111 published posts, 6105 pairs scored.
- 14 pairs at/above the lexical `DUPLICATE_THRESHOLD` (0.5); closest pair **87.5%**
  ("Automating Zero-Downtime Database Migrations with GitOps and Kubernetes" vs "...
  Schema Migrations..."), next closest 77.8%, then a cluster in the 45–70% range.
- **Zero exact (case-insensitive title or slug) duplicates** — confirms guard #1 in §2 is
  holding.

**Read this number correctly — do not over-conclude:** `dedupe-audit.mjs` scores **lexical
Jaccard only**. The live pipeline's primary gate is **semantic** cosine similarity at 0.85
(§2 item 2); lexical is only its fallback. A lexical hit on a *published* post does **not**
by itself prove the semantic guard failed — it may mean: the semantic score for that pair
was genuinely below 0.85 (two posts can share many words and still be about different
enough things), the post predates the semantic guard (semantic dedupe landed in commit
`12340b2`, "semantic dedupe + strict title extraction"), or a human merged it deliberately
past a warning. **There is no committed tool today that computes the *semantic* score
distribution across all 111 posts** — building one would cost ~111 embedding API calls
(one-time; results could be cached in `scripts/.embeddings-cache.json` the same way the
live pipeline does). Treat that as an open/candidate step (see Menu A), not something
this phase already gives you.

**Gate:**
- If Phase 0 shows exact duplicates → guard #1 (§2) is broken; that is a regression in
  `findExactDuplicate`/`writePostCollisionSafe`, file it as a bug against
  `resumesite-debugging-playbook`, not a tuning problem.
- If Phase 0 shows a lexical cluster but zero exact dupes (the actual 2026-07-05 state) →
  proceed to Phase 1 to determine whether the *semantic* guard is under- or
  over-permissive, since lexical alone can't tell you that.

### Phase 1 — Reproduce dedupe behavior deterministically (test-level, not a live CLI run)

Do **not** attempt to reproduce a bad draft by actually running `blog:draft:topic` or
`blog:draft:git` — per §1, neither exercises semantic dedupe, both cost API tokens, and
both write a real file into `blog-src/src/content/posts/`. The deterministic, free,
repeatable reproduction is a unit test against `pickUniqueTopic` /
`findMostSimilarSemantic`, exactly as the existing tests in `tests/lib/blog-post.test.js`
already do with a mocked `embed` function.

**Predict before you run** (the discipline `resumesite-measurement-toolkit` documents in
general — apply it here):

- Given two title+excerpt pairs whose mocked embed vectors are near-identical (cosine
  ≈ 0.95, e.g. `[1, 0.9, 0.1, 0.2]` vs `[0.95, 0.95, 0.05, 0.15]` — this is literally the
  eBPF/Istio fixture already in `findMostSimilarSemantic` tests), predict: **rejected**,
  because `0.95 > SEMANTIC_THRESHOLD (0.85)`.
- Given two vectors with cosine clearly below 0.85 (e.g. orthogonal-ish vectors), predict:
  **accepted**.
- Run `npm test -- tests/lib/blog-post.test.js` and confirm the existing
  `findMostSimilarSemantic` / `pickUniqueTopic` describe blocks already assert exactly
  this (they do, as of 2026-07-05 — see the `'matches the post with the closest embedding
  vector'` and `'retries when the LLM picks a near-duplicate (lexical mode)'` cases).

**Gate:**
- If a new scenario you construct is **ACCEPTED** when your prediction said it should be
  **REJECTED** → the threshold is effectively too low for that class of near-duplicate, or
  the `embed` adapter you're testing against doesn't separate the two well → branch to
  **Menu A**.
- If a scenario you know to be genuinely distinct is **REJECTED** → too high / over-eager →
  branch to **Menu A** (same knob, opposite direction — show both distributions before
  moving it either way).
- If the LLM's raw output has no parseable `TITLE:` line, or the extracted title contains a
  slash or file extension → branch to **Menu C** (title extraction/reconciliation), not
  Menu A — this is a different failure class from duplication.
- If the *topic itself* is on-brand technically but off the temporary focus window (not
  security/AI-governance while `focusActive()` is true) → branch to **Menu B**.

**Optional, higher-cost, real-artifact repro (only if you must see the live path fire):**
`npm run blog:draft:topic "<paste an exact existing post title from Phase 0>"` will exercise
guard #1 (`findExactDuplicate`) with a real LLM call, since generate-post.js always checks
exact duplicates. This costs `ANTHROPIC_API_KEY` tokens, is not deterministic (the LLM may
paraphrase the title so an exact match doesn't trigger), and — if the guard doesn't fire —
**writes a real file** into `blog-src/src/content/posts/` that you must `git checkout --
blog-src/src/content/posts/` (or `git clean`) to discard before doing anything else. Prefer
Phase 1's test-level repro; only reach for this if you specifically need to demonstrate the
guard to someone live.

## 5. Ranked solution menu — theory obligation + fence for every item

Each item requires predicting the expected metric shift **before** touching code, per
`resumesite-measurement-toolkit`'s "predict the number before you run it" rule.

### A. Tune `SEMANTIC_THRESHOLD` (env-tunable, default 0.85)

- **Theory obligation:** you must show the *semantic* score distribution across a
  representative sample of post pairs (not the lexical one from `dedupe-audit.mjs`) before
  changing the number. No such tool is committed today — building one means calling the
  same `embed` adapter `generate-post-gemini.js` uses across pairs and reusing/extending
  `scripts/.embeddings-cache.json`'s cache-by-SHA256 pattern so you don't re-embed 111
  posts on every run. This is real, uncommitted work — label it candidate/open, and route
  it through `resumesite-diagnostics-and-tooling` (a new audit script) or
  `resumesite-measurement-toolkit` (the method), not this file.
- **Predict first:** state the false-accept rate (near-dupes slipping through) and
  false-reject rate (unique topics rejected) you expect to change, and by how much, before
  moving the number.
- **Fence:** do **not** tune by vibes. If you cannot show the distribution, you have not
  earned the right to change this constant. Env-override for a single run
  (`SEMANTIC_THRESHOLD=0.80 npm run blog:draft:topic ...`) is fine for local experiments;
  changing the *default* in `scripts/lib/blog-post.js` is a behavior change requiring a
  test (§6) and a PR.

### B. Improve the topic prompt / focus steering

- **Theory obligation:** measure the off-topic rate on a real sample (e.g., pull the last
  N auto-generated draft PR titles and classify against the active system prompt's stated
  domain) before rewording `TOPIC_PICKER_SYSTEM`, `topicPickerPrompt`, `SYSTEM_PROMPT`, or
  `FOCUS_SYSTEM_PROMPT`.
- **Fence:** do **not** overfit any change to the temporary focus window — `FOCUS_UNTIL`
  expires **2026-08-12**, after which `activeSystemPrompt`/`topicPickerPrompt` revert to
  the general prompts automatically (§3). A prompt tweak must be tested (or at least
  manually reasoned through) against **both** `focusActive(true)` and `focusActive(false)`
  branches — today neither branch has any test coverage at all (verified: no match for
  `focusActive` in `tests/lib/blog-post.test.js`), so this is also an opportunity to close
  that gap, not just tweak prose.

### C. Strengthen title extraction / reconciliation

- **Theory obligation:** identify the exact malformed-title shape you're fixing (file path,
  code identifier, stray directive residue, H1/H2 mismatch) and write a failing test in
  `tests/lib/blog-post.test.js` against `isValidTitle` / `extractTitle` /
  `extractFirstHeading` / `reconcileTitle` **before** touching the regex or logic. The test
  file already has rich coverage here (`isValidTitle`, `extractTitle`, `reconcileTitle`
  describe blocks) — extend it, don't bypass it.
- **Fence:** no silent regex changes without a test proving the new case is caught **and**
  the existing valid-title cases (`'Implementing Zero-Trust Network Segmentation with
  eBPF'`, etc.) still pass. `FILE_EXTENSIONS` and the "75%+ codey words" heuristic in
  `isValidTitle` are both empirically tuned — changing either without new test cases risks
  silently regressing the other.

### D. Persist / warm the embedding cache in CI

- **Theory obligation:** confirm the actual cost being solved. Today
  `scripts/.embeddings-cache.json` is disk-only and **gitignored by design** (verified in
  `.gitignore`), and each CI run is a fresh GitHub-hosted runner — so the cache is cold on
  every scheduled run regardless of how many posts exist. The pipeline's own comment
  already accounts for this: a daily run only ever embeds the *new candidate*, not the
  existing 111 posts, because `getExistingPosts()` re-embeds each existing post once via
  the cache-by-content-hash pattern and unchanged posts hash identically run to run — so
  the real avoided cost is re-embedding the **candidate across its own `pickUniqueTopic`
  retries within a single run**, not the whole corpus. Quantify actual embedding API calls
  saved (e.g. via `actions/cache` keyed on... note the file changes every run since new
  posts get added, so a naive `actions/cache` key would go stale immediately) before
  proposing CI-level persistence.
- **Fence:** the cache is gitignored **by design** — do not commit
  `scripts/.embeddings-cache.json` to "warm" it. If you add CI caching, use a build/CI
  cache mechanism (e.g. `actions/cache`) scoped to `.github/workflows/generate-blog-post.yml`,
  not a tracked file, and get it reviewed as a CI/workflow change under
  `resumesite-change-control`'s "Build / CI / deps" bucket (SHA-pinned actions, extra
  scrutiny).

### Known wrong paths — fenced explicitly, do not do these

- **Do not disable dedupe to "unblock" the pipeline.** Every layer in §2 exists because a
  specific real failure (see `resumesite-failure-archaeology`'s F3) once forced the cadence
  down to 3×/week; disabling any layer to clear a backlog reintroduces that failure mode.
- **Do not auto-publish to clear a draft-PR queue.** The daily workflow already opens a PR
  and stops (`.github/workflows/generate-blog-post.yml`); merging is a human act. Adding
  any auto-merge step for blog-draft PRs is a `resumesite-change-control` violation (drafts
  are explicitly human-reviewed, see its "Content-only" bucket).
- **Do not raise `SEMANTIC_THRESHOLD` to 0.99 "to stop rejections."** That defeats the
  guard's purpose (a threshold that high accepts almost everything) and is exactly the
  "tune by vibes" move Menu A's fence forbids. If rejections are too frequent, that's a
  Phase 1 investigation (show the distribution), not a knob-max move.
- **Do not add an inline `<script>` to any preview/diagnostic page to debug this.** Not
  related to CSP mechanically, but the same discipline applies: any new page/diagnostic
  surface added to chase this problem goes through the same review bar as everything else
  — see `resumesite-architecture-contract` on the no-`'unsafe-inline'` CSP invariant if the
  investigation tempts you toward a quick inline-script debug page.

## 6. Validation + promotion protocol

Any change coming out of this campaign must, before merge:

1. **Add or extend a `tests/lib/blog-post.test.js` case that predicts the new behavior**
   — not just re-asserts the old one. If you tuned `SEMANTIC_THRESHOLD`, add a case at the
   new boundary; if you changed a prompt, add/extend a `focusActive` test (§3); if you
   changed title extraction, add the specific malformed-title shape you were fixing.
2. **Keep `npm test` green.** Baseline as of 2026-07-05: `Test Files 6 passed | 1 skipped
   (7); Tests 328 passed | 20 skipped (348)`. Your change should raise the passed count
   (new test) and must not reduce it. The 1 skipped file/20 skipped tests are
   `tests/site/build-output.test.ts`, which self-skips without a `dist/` — see
   `resumesite-validation-and-qa`, unrelated to this campaign.
3. **Go through a PR.** No skill here authorizes pushing straight to `master` or skipping
   CI — route every change through `resumesite-change-control`. A `scripts/lib/blog-post.js`
   / provider-script / workflow change is "Site code" or "Build / CI / deps" in that
   skill's classification table, not "Content-only."
4. **Promotion = merged only when the metric moved as predicted.** If Phase 1's prediction
   was "this scenario should flip from accepted to rejected," the merged PR's test must
   assert exactly that, and (if the change affects the live corpus) a Phase 0 re-run after
   merge should show the predicted shift in the audit's numbers — re-run
   `dedupe-audit.mjs` and compare against the 2026-07-05 baseline in §4.

Cross-reference `resumesite-evidence-and-methodology` for the general reasoning discipline
behind trusting a "the fix worked" claim, and `resumesite-measurement-toolkit` for the
worked "predict before you measure" examples this protocol is built on.

## When NOT to use this skill

- **Day-to-day blog writing, frontmatter, voice, or "how do I publish a draft"** → use
  `resumesite-content-and-writing`.
- **Interpreting a single diagnostic run's output, or the `dedupe-audit.mjs` tool's own
  mechanics** → use `resumesite-diagnostics-and-tooling` (it owns the tool this campaign's
  Phase 0 calls).
- **"Why is 0.85 the number" as a general measurement-method question, not a live tuning
  decision** → use `resumesite-measurement-toolkit`.
- **The PR/merge gate itself (branch protection, SHA-pinning, what counts as a passing
  check)** → use `resumesite-change-control`.
- **A non-blog problem entirely** (contact form, CSP, build pipeline, D1) — this campaign
  doesn't apply; see `resumesite-architecture-contract`, `resumesite-cloudflare-reference`,
  or `resumesite-debugging-playbook` depending on the symptom.

## Provenance and maintenance

Verified 2026-07-05 against branch `skills` by direct file read + live command runs (not
just the digest). Re-verify anything below that has drifted:

| Fact | Re-verify with |
|---|---|
| Post count / lexical dedupe distribution (111 posts, 14 pairs ≥0.5, top 87.5%) | `node .claude/skills/resumesite-diagnostics-and-tooling/scripts/dedupe-audit.mjs 20` |
| `SEMANTIC_THRESHOLD` default (0.85) / `DUPLICATE_THRESHOLD` (0.5) / `PICK_TOPIC_MAX_ATTEMPTS` (4) | `grep -n "SEMANTIC_THRESHOLD\|DUPLICATE_THRESHOLD\|PICK_TOPIC_MAX_ATTEMPTS" scripts/lib/blog-post.js` |
| `FOCUS_UNTIL` date-gate (2026-08-12) | `grep -n "FOCUS_UNTIL" scripts/lib/blog-post.js` |
| No test covers `focusActive`/`activeSystemPrompt`/`topicPickerPrompt` | `grep -n "focusActive\|activeSystemPrompt\|topicPickerPrompt" tests/lib/blog-post.test.js` (expect no match — if this now matches, update §3/§5-B) |
| Which command passes `embed` / `supportsAuto` (the §1 table) | `grep -n "supportsAuto\|embed" scripts/generate-post.js scripts/generate-post-gemini.js` |
| `npm test` baseline (328 passed / 20 skipped) | `npm test` |
| Embedding cache path + gitignore status | `grep -n "embeddings-cache" .gitignore scripts/lib/blog-post.js` |
| Daily cron schedule / default mode | `grep -n "cron:\|default:" .github/workflows/generate-blog-post.yml` |
