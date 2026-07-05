---
name: resumesite-evidence-and-methodology
description: The reasoning discipline behind trusting a result on resumesite (michaellaplante.com) — not the checklist, not the rules, the *why*. Load this when you are about to change a threshold/prompt/config and want to know how much evidence is enough; when a self-test or one green run "passed" and you're tempted to call it done; when deciding whether to adopt, keep, or roll back an experiment (a feature flag, a date-gated prompt, a tuned constant); when writing or reviewing a design doc that proposes several options; when a fix "worked" and you want to adversarially check whether it actually explains every observed symptom, not just the one you were staring at; or when asked "is this evidence enough", "what should we expect to see if this fix is right", "should we keep or revert this experiment", "where do good ideas come from here", "why did we revert X", or "how do we know FOCUS_UNTIL is safe to leave alone". Distinct from resumesite-validation-and-qa, which owns the concrete merge-bar checklist and test inventory (lint/typecheck/328-tests/Lighthouse) — this skill owns the judgment that decides whether a passing number should be trusted at all. Distinct from resumesite-change-control, which owns the PR/CI *rules*. Distinct from resumesite-measurement-toolkit, which owns *how to measure*. Distinct from resumesite-blog-quality-campaign, which owns the AI-draft-duplicates problem specifically — this skill uses that campaign only as a worked example of the discipline.
---

# Evidence and Methodology

The house rule for turning a hunch into an accepted change on this repo. If you
only remember one sentence: **a passing self-test is not evidence — CI green,
a predicted number that actually moved, and a human review are.**

This is a reasoning-discipline skill, not a checklist. For the literal merge
bar (which commands, which thresholds, which test files) see
`resumesite-validation-and-qa`. For the PR/branch-protection rules themselves,
see `resumesite-change-control`. For how to run the measurement tools, see
`resumesite-measurement-toolkit`. This skill is what tells you *whether to
trust what those tools just told you*.

## 1. The evidence bar

A change is not accepted because "it worked once" or because you wrote a
script that prints PASS. It is accepted when **all three** hold:

1. **One mechanism explains every observation — including the negatives.**
   If your explanation for a bug predicts symptom A but the system also shows
   symptom B, and your explanation is silent on B or contradicts it, your
   explanation is wrong or incomplete. Don't ship a fix for a story that only
   covers the part you looked at first.
2. **CI is green** (lint, typecheck, `npm test`, the `site` build/typecheck/
   Lighthouse job — see `resumesite-validation-and-qa` for the exact bar and
   current baseline numbers; this skill deliberately does not restate them
   here so they can't drift out of sync in two places).
3. **The metric you predicted before touching anything actually moved**, in
   the direction and magnitude you wrote down beforehand (see §2). A fix
   that passes CI but didn't move the number you said it would move is not
   yet explained — go find out why before merging.

A worked example of "one mechanism, not two stories" from this repo's own
dedupe guard (`scripts/lib/blog-post.js`): the comment above
`findExactDuplicate` explicitly reasons about a case where the *primary*
mechanism (similarity scoring) can fail —

> "Similarity scoring (lexical/semantic) can be defeated by an embedding
> outage or a threshold miss, but an exact repeat is always detectable: ...
> Returns the conflicting filename/title, or null when the post is unique."

That's the discipline in miniature: the author didn't stop at "the semantic
check passed," they asked "what happens when the semantic check itself is
wrong or unavailable," and added an unconditional fallback (`findExactDuplicate`,
checked immediately before every write) that can't be defeated by a scoring
miss. One mechanism (semantic/lexical similarity) explains the common case;
a second, independent mechanism (exact title/slug match) covers the case
where the first one is silent or degraded.

## 2. Hypothesis-predicts-numbers-before-running

Before you change a threshold, a prompt, or a config value, **write down the
number you expect to see, and why**, before you run anything. Then compare.
If reality doesn't match your written prediction, you don't yet understand
the system well enough to accept the change — even if the run "looks fine."

The canonical in-repo example of a number that was pre-committed with its
justification is `SEMANTIC_THRESHOLD` in `scripts/lib/blog-post.js`:

```js
// Cosine similarity threshold for semantic embedding-based duplicate detection.
// Empirically: ~0.85 catches "X with eBPF" vs "X with Istio" but not unrelated
// posts. Tune via SEMANTIC_THRESHOLD env var.
export const SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD ?? 0.85);
```

That comment is a hypothesis, not a magic number: *at 0.85, near-duplicate
rewrites get rejected, unrelated topics don't.* If you ever tune this
threshold, the correct procedure is:

1. Before changing it, list the specific candidate/existing-post pairs (real
   or constructed) you expect to land on each side of the new threshold —
   which should now be rejected that weren't, and which should now pass that
   were previously (wrongly) rejected.
2. Change the value (env var `SEMANTIC_THRESHOLD`, or the code default).
3. Re-run the dedupe path against those pairs and confirm the scores land
   where you predicted. A threshold change that "passes the test suite" but
   that you can't explain against concrete pairs is not validated — you got
   lucky, or the test suite doesn't cover the case you actually changed.
4. Only then treat the new value as evidence-backed, and land it via a PR
   with the reasoning in the commit message (see `resumesite-change-control`
   for the PR mechanics; see `resumesite-measurement-toolkit` for how to
   actually run the similarity scorer / dedupe audit tooling).

The same discipline applies to Lighthouse thresholds, test-count deltas, or
any other number you're about to make load-bearing: **write the expectation
first, in the PR description or a comment, then run the thing.**

## 3. The idea lifecycle: flag → measure → adopt or retire

Every non-trivial change here should be able to answer: *how does this get
undone if it's wrong, and who decides?* The repo's answer is a three-stage
lifecycle:

**Stage 1 — Gate behind a flag or a date, not a permanent commit.**
The canonical example is the content-focus experiment in
`scripts/lib/blog-post.js`:

```js
// --- Temporary content focus (requested 2026-06-28) -----------------------
// For 45 days the daily auto-generated posts are steered toward cybersecurity
// and the governance of AI within cybersecurity. This is date-gated so the
// topic picker and writer prompts automatically revert to the defaults above
// once the window closes — no manual cleanup needed even though generation is
// fully automated by the GitHub Actions cron.
export const FOCUS_UNTIL = '2026-08-12'; // 45 days from 2026-06-28, inclusive
```

As of **2026-07-05** (today), `focusActive()` returns `true` — the experiment
is live, with roughly 38 days left before it auto-reverts. Notice what makes
this a *good* experiment design: nobody has to remember to revert it. The
window closes itself, on a date already written into the code, with **zero
manual cleanup** even though the thing it's steering (`generate-blog-post.yml`,
a daily unattended cron) runs with no human in the loop. If you build a
time-boxed experiment on this repo, copy this shape: a `*_UNTIL` constant, a
pure `xActive(today)` predicate so it's independently testable, and a
comment stating the request date and the review-of-effect plan — not a
TODO to "remember to turn this off."

**Stage 2 — Measure.** Let the flag run, then look at the predicted metric
(§2) — did draft topics actually shift toward the intended focus, did the
duplicate-rejection rate change, did Lighthouse move. Use
`resumesite-measurement-toolkit` for the mechanics of collecting that
number.

**Stage 3 — Adopt or retire.**
- **Adopt**: land it as a normal change via PR with green CI and, if it's new
  behavior, a test (`resumesite-change-control` for the gate,
  `resumesite-validation-and-qa` for what "needs a test" means here).
- **Retire**: remove it and *write down why*, in the commit message or the
  code comment. **A documented retirement is a successful use of the
  scientific method, not a failed change** — you formed a hypothesis, tested
  it in production, and got a clean, legible negative result. That is exactly
  as valuable as a clean positive result, and costs a lot less than leaving
  an unexplained dead flag in the codebase.

Two commits in this repo are clean, correctly-documented retirements — full
story lives in `resumesite-failure-archaeology`, but the shape is worth
internalizing here:

- **`8fbdad6` — "revert: remove Astro ClientRouter from layouts."** Added,
  observed to misbehave, removed with the mechanism named in the commit body:
  > "View Transitions caused blank content on some cross-layout navigations
  > (SiteLayout ↔ BlogLayout) and hangs that required a hard refresh.
  > Viewport prefetch already covers most of the perceived-speed benefit, and
  > the PurgeCSS reduction remains the meaningful win."

  Notice the shape: not just "it broke," but *which* interaction broke it,
  *and* an acknowledgment of what value was already being captured elsewhere
  — so the retirement doesn't read as "we lost the win," it reads as "we
  already had most of the win via a different, safer mechanism."
- **`aa88de8` (#101) — "revert(contact): drop on-page diagnostic surfacing
  now that root cause is known."** A temporary diagnostic (surfacing
  upstream error detail on the contact-error page) was added specifically to
  chase a bug, and removed once the bug was understood — the textbook
  add-instrumentation → learn → remove-instrumentation loop. Keeping
  debug-only surface area around after its job is done is its own kind of
  drift; this repo treats "we don't need this anymore" as a change worth
  making, not something to leave "just in case."

Do not confuse a **retirement** with a **tightening**. The contact-form
Origin check (`c06885b`) was not an idea that got tried and rolled back — it
was the same mechanism, made stricter once its gap was found (see §4). Filing
that under "retired ideas" would misdescribe it; it belongs under adversarial
refutation, below.

## 4. Adversarial refutation: try to break your own explanation before merging

This repo's security posture (pinned Action SHAs, CodeQL, gitleaks, strict
CSP with no `'unsafe-inline'`) is really one instance of a broader habit:
**before you merge a fix, assign yourself to attack it.** Don't ask "does
this pass the test I wrote for the case I already knew about" — ask "what
input or state did I not consider, and does my fix survive it?"

The clearest in-repo example is the contact-form Origin check. An early
version read:

```ts
if (origin && origin !== url.origin) {
  return new Response('Forbidden', { status: 403 });
}
```

That guard passes every test where a legitimate browser sends a matching
`Origin` header. It fails silently against an attacker who simply omits the
`Origin` header — `origin` is falsy, the `&&` short-circuits, the request
sails through. Someone came back and adversarially asked "what if `Origin` is
missing entirely, not just wrong?" — and tightened the check (commit
`c06885b`, current code comment):

> "Reject anything else — including requests with NO Origin — to close the
> cross-site form bypass that the prior `if (origin && ...)` left open."

The dedupe fallback quoted in §1 is the same move applied to a non-security
mechanism: "what if the thing I'm relying on (the embedding call) is down or
wrong" → add a mechanism that doesn't share that failure mode.

**Practical rubric before you merge anything nontrivial here:**
- What's the falsy/missing/empty/malformed input your happy-path test
  doesn't cover?
- If your fix depends on an external call (embeddings API, Turnstile
  siteverify, ForwardEmail) failing in a *specific* way, what does it do
  when that call fails in a *different* way (timeout vs. 4xx vs. malformed
  body)?
- Does your explanation account for every symptom that was reported, or
  only the one you reproduced first?

## 5. Where good ideas have historically come from here

When you're looking for the next thing worth improving, these are the
patterns that have actually paid off in this repo — use them as the places
to look, not just as history:

- **Dogfooding.** The AI blog-draft pipeline's `git` mode
  (`getGitLog` in `scripts/lib/blog-post.js`) literally drafts blog posts
  from the project's own recent commit log — the tool that automates the
  site's content generation is fed by the site's own development activity.
  When you want a new automation idea, ask "can this system observe and use
  its own operational history the way the draft pipeline already does?"
- **Security incidents driving hardening, not just patches.** The Origin
  bypass (§4) didn't just get a one-line fix — the same commit era
  (`dda5a6c`, `a625860`, `c06885b`) added rate limiting, control-character
  stripping, stricter email validation, and structured rejection logging.
  A single found gap is a prompt to sweep the whole surface for the same
  *class* of gap, not just the one instance.
- **Performance/quality audits driving targeted fixes.** `5e95f16` — "Fix
  Lighthouse accessibility and best-practices audits (#185)," landed
  2026-07-04 — is a recent, concrete example: Lighthouse's `site` CI job
  found real accessibility/best-practices regressions and the fix touched
  `style.css`, `analytics.js`, `turnstile.js`, `BaseHead.astro`, and
  `index.astro` in one pass. The audit *found* the work; nobody had to guess
  where to look. See `resumesite-measurement-toolkit` for running Lighthouse
  yourself.
- **Migrations forcing an explicit options analysis.** The design docs under
  `docs/archive/` are not just historical trivia — they show the expected
  shape of a nontrivial change proposal on this repo. E.g.
  `docs/archive/2026-04-05-astro-migration-design.md` names its choice
  explicitly as **"Approach: Option C — Full Migration, Preserve Existing
  Assets"** (implying — and the repo's convention is — that alternative
  options were weighed, not just the one that got picked), and states a
  `## Risks` section up front. `docs/archive/2026-04-05-site-improvements-design.md`
  is headed `**Status:** Approved` before any of its four bundled changes
  landed. If you're proposing a similarly large change, write it up the same
  way: name the approach as a chosen option among alternatives, list risks
  explicitly, and get it to an "Approved" state before writing code — these
  are snapshots (`docs/archive/README.md` calls them "historical... not living
  documentation"), so don't expect to update them, but do match their shape
  for your own proposal.

## When NOT to use this skill

| If you need... | Use instead |
|---|---|
| The literal merge-bar checklist (lint/typecheck/test counts/Lighthouse thresholds) | `resumesite-validation-and-qa` |
| The PR/branch-protection/CI *rules themselves* | `resumesite-change-control` |
| How to actually run a measurement (Lighthouse, dedupe-audit, vitest) | `resumesite-measurement-toolkit` |
| The specific AI-draft-duplicates problem and its dedupe mechanics | `resumesite-blog-quality-campaign` |
| The full story of a specific past incident (F1/F2/F4 in detail) | `resumesite-failure-archaeology` |
| Fixing something broken right now | `resumesite-debugging-playbook` |

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of this repo (branch `skills`).
Re-verify anything below if it might have drifted:

- **`FOCUS_UNTIL` still active / its exact date**: `grep -n "FOCUS_UNTIL" /Users/mlaplante/.supacode/repos/resumesite/skills/scripts/lib/blog-post.js` — as of 2026-07-05 the value is `'2026-08-12'` and `focusActive()` returns true for today. Once past 2026-08-12, the "currently active" framing in §3 is stale and should say "expired, reverted automatically" instead.
- **`SEMANTIC_THRESHOLD` default**: `grep -n "SEMANTIC_THRESHOLD" /Users/mlaplante/.supacode/repos/resumesite/skills/scripts/lib/blog-post.js` — verified default `0.85` on 2026-07-05.
- **The exact-duplicate fallback comment**: `sed -n '125,147p' /Users/mlaplante/.supacode/repos/resumesite/skills/scripts/lib/blog-post.js`.
- **F1 commit (Origin tightening)**: `git -C /Users/mlaplante/.supacode/repos/resumesite/skills show c06885b -- worker/api/contact.ts` — current guard is `sed -n '110,120p' worker/api/contact.ts`.
- **F2 commit (ClientRouter revert)**: `git -C /Users/mlaplante/.supacode/repos/resumesite/skills show 8fbdad6`.
- **F4 commit (contact diagnostics revert, #101)**: `git -C /Users/mlaplante/.supacode/repos/resumesite/skills show aa88de8`.
- **Lighthouse-audit-driven fix (§5)**: `git -C /Users/mlaplante/.supacode/repos/resumesite/skills show --stat 5e95f16` — landed 2026-07-04 as PR #185; re-check this is still the most recent example, or swap in a newer one.
- **Design-doc convention (§5)**: `ls /Users/mlaplante/.supacode/repos/resumesite/skills/docs/archive/` and read `docs/archive/README.md`, which states these are snapshots, not living docs.
