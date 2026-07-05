---
name: resumesite-failure-archaeology
description: Settled-history chronicle for resumesite (michaellaplante.com — Astro 6 + Cloudflare Worker + D1). Load this when asked "why was X reverted", "did we already try View Transitions / ClientRouter", "history of the contact-form origin bug", "why does the blog cadence say 3x/week vs daily", "were on-page contact diagnostics ever added", "has this been tried before", or before re-proposing: enabling Astro ClientRouter/View Transitions, loosening the contact-form Origin check, re-adding on-page diagnostic query params to /contact-error/, or increasing the AI blog-draft cadence without dedupe guards. Also load when reviewing a PR that touches worker/api/contact.ts, blog-src/src/layouts/*.astro, .github/workflows/generate-blog-post.yml, or scripts/lib/blog-post.js and you want to know what already blew up there. This is a read-only historical archive, not live triage — for a symptom happening right now, use resumesite-debugging-playbook instead.
---

# resumesite Failure Archaeology

A chronicle of the resumesite repo's confirmed incidents: what broke, why (as far as
the record shows), what fixed it, and what NOT to re-try. Every entry below is backed
by a commit SHA you can `git show` yourself. Where the record is silent on the "why,"
that is stated explicitly — this skill does not speculate.

**Use this to avoid re-fighting settled battles.** If you're about to propose "let's
add View Transitions back" or "let's loosen the contact form's Origin check for
convenience," read the matching entry first.

**When NOT to use this skill:** if something is broken *right now*, go to
`resumesite-debugging-playbook` for live triage. Come back here only to check whether
today's symptom is a repeat of a settled incident. For the AI blog-draft cadence knobs
and dedupe thresholds as *current config*, see `resumesite-config-and-flags`; this
skill covers the incident that produced them. For the PR/CI gate that governs how any
fix in this file must land, see `resumesite-change-control` — nothing here authorizes
skipping it.

---

## F1 — Contact form same-origin bypass (missing `Origin` header slipped through)

| Field | Detail |
|---|---|
| **Symptom** | The contact endpoint's cross-site guard could be bypassed simply by omitting the `Origin` header — a cross-site form submission with no `Origin` at all passed the check. |
| **Root cause** | The guard was written as `if (origin && origin !== url.origin) { …403… }`. The `origin &&` short-circuit meant: only reject when an Origin header IS present and wrong. A request with **no** Origin header (easy to craft outside a browser, or from certain cross-site contexts) skipped the check entirely. |
| **Evidence** | Guard **introduced** in `dda5a6c` "security: harden worker, workflow, and tooling (#86)" (2026-05-10). Guard **fixed** in `c06885b` "chore: cleanup root scripts, docs, and stale Netlify references (#98)" (2026-05-16) — six days later, and notably landed inside a commit *labeled as a chore*, not a security fix. Confirm both ends yourself: `git log -S "if (origin && origin !== url.origin)" --oneline -- worker/api/contact.ts`. |
| **Fix (current state, `worker/api/contact.ts`)** | `const origin = request.headers.get('Origin'); if (origin !== url.origin) { … 403 … }` — strict equality, no short-circuit, so a missing/null Origin now fails the check same as a mismatched one. The in-code comment names the old bug explicitly: *"Reject anything else — including requests with NO Origin — to close the cross-site form bypass that the prior `if (origin && ...)` left open."* |
| **Status** | Fixed and current. User-confirmed as a high-cost incident. |
| **Lesson** | (1) `if (x && x !== y)` is a classic "absence bypasses the check" bug shape — treat any conditional-guard-with-a-truthiness-prefix as suspect when the field being checked can legitimately be absent from an attacker's request. (2) A load-bearing security fix was shipped inside a commit titled as routine cleanup — don't assume a commit's stated intent covers everything it touched; read the diff, not just the subject line, when auditing security-sensitive files. |

---

## F2 — Astro ClientRouter (View Transitions) added, then reverted

| Field | Detail |
|---|---|
| **Symptom** | Cross-layout client-side navigations (SiteLayout ↔ BlogLayout, e.g. portfolio page to a blog post) sometimes rendered blank content, and some navigations hung requiring a hard refresh. |
| **Root cause — stated directly in the revert commit, not inferred** | Commit `8fbdad6`'s message: *"View Transitions caused blank content on some cross-layout navigations (SiteLayout ↔ BlogLayout) and hangs that required a hard refresh. Viewport prefetch already covers most of the perceived-speed benefit, and the PurgeCSS reduction remains the meaningful win."* This is the recorded reason — quote it, don't paraphrase past it. |
| **Evidence** | Added in `ce52c19` "perf: enable Astro View Transitions in site and blog layouts" (2026-04-20) — added `<ClientRouter />` to `blog-src/src/layouts/SiteLayout.astro` and `BlogLayout.astro` for SPA-like navigation. Reverted in `8fbdad6` "revert: remove Astro ClientRouter from layouts" — same day, 2026-04-20 (both commits landed within minutes of each other per `git log`). |
| **Status** | Reverted, and stayed reverted as of 2026-07-05 (`grep -r ClientRouter blog-src/src` returns nothing). User-confirmed as costly. |
| **Lesson** | Astro's `<ClientRouter />` does full-page-morph client routing across two structurally different layouts on this site (SiteLayout for the portfolio, BlogLayout for the blog) — that specific cross-layout transition is the failure mode, not View Transitions in general within a single layout. **Do not re-propose ClientRouter without first testing the SiteLayout↔BlogLayout hop specifically**, and note the two "wins" the revert commit says already cover most of the perceived benefit: viewport prefetch (already in place) and the PurgeCSS build-size reduction. If re-attempting, this is a behavior change to shared layouts — route it through `resumesite-change-control` (PR + green CI, including Lighthouse) same as any other layout change. |

---

## F3 — AI-draft duplicates and mis-titled posts (cadence cut, then restored once guarded)

| Field | Detail |
|---|---|
| **Symptom** | The daily AI blog-draft pipeline published **four exact-duplicate posts** and **four posts whose extracted title was a stray line of code** (e.g. a literal `"Define the Lambda function"` as the H1), three of which were also topic duplicates of existing posts. Volume outpaced human review — bad drafts got merged instead of caught. |
| **Root cause** | Two independent gaps, per the commit body: (1) similarity scoring alone wasn't a hard gate — "an embedding outage degrades to lexical Jaccard, and nothing re-checked at write time," so degraded similarity checks let exact duplicates through; (2) the `TITLE:` directive the LLM emitted was sometimes not a title at all (a stray code line), and nothing cross-checked it against the post body's actual heading. |
| **Evidence — the whole arc is in one squash-merge commit** `d7233b6` "Refactor dark mode to data-theme attribute and add blog search (#181)" (2026-07-03), which bundles several unrelated sub-changes; the relevant ones by its own sub-headers: <br>• *"content: remove duplicate/junk AI posts, add 301 redirects"* — cleanup of the four exact-duplicate and four mis-titled posts, with 301s via a Workers-assets `_redirects` file. <br>• *"pipeline: hard duplicate guard, H1 title reconciliation, tag generation"* — added `findExactDuplicate()` (slug match across any date prefix, plus case-insensitive title match) enforced unconditionally before write and in the topic picker; cross-checks the `TITLE:` directive against the body's opening H1/H2 and lets the heading win on bad disagreement; emits a real `TAGS:` line instead of always writing `tags: []`. <br>• *"blog: 3x/week draft cadence, CI guards for duplicates and missing tags"* — dropped the cron from daily to Mon/Wed/Fri (`0 8 * * 1,3,5`) in `.github/workflows/generate-blog-post.yml`, and made the content tests fail on any repeated title, date-less slug, or empty tags (for posts dated after 2026-07-04). |
| **Cadence restored** | `a1b69c6` "blog: restore daily draft cadence (#189)" (2026-07-05) reverted the cron back to `0 8 * * *` (daily). Its own comment states the reasoning: *"The duplicate/mis-title problems that once justified a 3x/week cadence are now caught by the pipeline's hard duplicate guard, H1 title reconciliation, and the CI content tests, so daily drafting is safe again."* |
| **Status** | Fixed and current: daily cadence, `findExactDuplicate()` unconditional guard, `SEMANTIC_THRESHOLD` (default 0.85) + `DUPLICATE_THRESHOLD` (0.5) lexical fallback, all in `scripts/lib/blog-post.js` (verified present at these lines as of 2026-07-05: `DUPLICATE_THRESHOLD = 0.5`, `SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD ?? 0.85)`, `findExactDuplicate(...)`). User-confirmed as costly. |
| **Lesson** | A similarity *score* is not a hard gate by itself, especially when its input (embeddings) can silently degrade to a weaker fallback (lexical Jaccard) on an API outage — always pair a soft/threshold check with an unconditional exact-match guard (slug + case-insensitive title) that runs regardless of which similarity mode was used. Don't trust an LLM's own `TITLE:` directive without cross-checking it against the content it actually produced. See `resumesite-blog-quality-campaign` for the current dedupe/cadence mechanics as living config, not incident history. |

---

## F4 — Contact-form on-page diagnostics added, then reverted once root cause found

| Field | Detail |
|---|---|
| **Symptom** | Contact-form emails were failing to send via ForwardEmail (the transactional mail API), and the operator couldn't tell why without `wrangler tail` access. |
| **Dead end tried first** | `66eb2dc` "explicit form-urlencoded header and diagnostic logging for forwardemail" (2026-04-16) — set an explicit `Content-Type: application/x-www-form-urlencoded` header and added diagnostic logging. This did **not** fix delivery; it was itself a wrong hypothesis. Later, on-page diagnostics were layered on top (upstream status/request-id/error surfaced via redirect query params onto `/contact-error/`, `#100` "fix(contact-error): show upstream status/error on-page instead of headers-only") so the operator could see the failure without server access at all. |
| **Actual root cause** | ForwardEmail's API rejected the form-urlencoded body; it needed **JSON**. Fixed in `7c55554` "fix(worker): send ForwardEmail body as JSON + log upstream request id (#99)" (2026-05-16) — changed `mailBody` from `URLSearchParams` to `JSON.stringify(...)` and the request's `Content-Type` to `application/json`. |
| **Evidence (revert)** | `aa88de8` "revert(contact): drop on-page diagnostic surfacing now that root cause is known (#101)" (2026-05-16, same day as the #99 fix) — removed the `<details id="diag">` block and its inline script from `blog-src/src/pages/contact-error.astro`, and stopped appending `?s=…&rid=…&e=…` (upstream status/request-id/error) onto the `/contact-error/` redirect from `worker/api/contact.ts`. |
| **Status** | Reverted and current — no on-page diagnostics exist today. Confirmed in git; the user did **not** flag this one as high-cost (unlike F1/F2/F3), so weight it as a normal fix-forward-then-clean-up cycle, not a major incident. |
| **Lesson** | Diagnostic scaffolding (query-param-surfaced upstream errors on a public page) is a reasonable *temporary* debugging aid but is also a minor information-disclosure surface (upstream status codes/error bodies visible to anyone who can see the redirect) — remove it once the underlying cause is fixed and confirmed, don't leave it running as a permanent feature. Also: when a fix doesn't resolve the symptom (the form-urlencoded header attempt didn't), that's a signal to change the request format hypothesis (form vs JSON), not just add more logging around the same wrong request shape. |

---

## Migrations (context, not failures — do not treat these as incidents)

These were deliberate, planned changes, not bugs. Listed so you don't mistake old
references (Netlify config, DeployHQ FTP deploy, static HTML pages) for something
broken that needs fixing.

| Migration | Landed | Evidence | Design doc |
|---|---|---|---|
| Static HTML → unified Astro project | 2026-04-05 | `a6d88b5` "Migrate entire site to unified Astro project" | `docs/archive/2026-04-05-astro-migration-design.md` |
| DeployHQ (FTP) → GitHub Actions | 2026-03-22 (published as a blog post the same day) | `40bd6fe` "feat: publish blog post on replacing DeployHQ with GitHub Actions"; `97356c4` "ci: add GitHub Actions FTP deployment workflow" | — |
| Netlify → Cloudflare (Pages Functions, then unified Worker) | 2026-04-16 through 2026-05-16 | `67759ef` "add cloudflare pages functions for contact form" → `4b398e1` "switch from pages functions to unified worker model" → `e249201` "publish netlify->cloudflare migration post and turnstile styling" (2026-04-16) → `b86f9ba` "remove netlify config now that site runs on cloudflare workers" → `c06885b` "chore: cleanup root scripts, docs, and stale Netlify references (#98)" (2026-05-16, the same commit that fixed F1) | — |
| SavvyCal-inspired blog redesign | 2026-03-23 | (see design docs) | `docs/archive/2026-03-23-blog-redesign-plan.md`, `docs/archive/2026-03-23-blog-redesign-design.md` |

Also seen in history but **not** an incident: `20eadde` "Shift blog drafts toward
technical deep dives for 2 weeks" (explicitly marked "TEMP — revert after
2026-04-26" in its own commit body) was a deliberate temporary content steer, not a
bug fix — don't confuse it with F3. Likewise `2181b72` "revert" is a 2015-dated,
one-line `index.html` change from the pre-Astro static-site era, unrelated to any
entry above.

---

## Quick lookup: "has this been tried / has this broken before?"

| If you're about to... | Check | Then... |
|---|---|---|
| Add `<ClientRouter />` / View Transitions back to layouts | F2 | Test the SiteLayout↔BlogLayout hop specifically before proposing again |
| Relax the contact form's `Origin` check "just for testing" | F1 | Don't — this exact shape (`if (origin && ...)`) was the vulnerability |
| Add on-page error detail (status codes, request IDs) to a public page | F4 | Treat as temporary; plan its removal once root cause is confirmed |
| Increase blog-draft cadence beyond current, or disable a dedupe guard | F3 | Verify `findExactDuplicate()` and the CI content tests still run — cadence was only safely restored because those guards exist |

---

## Provenance and maintenance

Compiled 2026-07-05 from direct `git log`/`git show` inspection of this repo
(branch `skills`). Every SHA above was confirmed with `git show <sha>` at authoring
time. Re-verify if this file is suspected stale:

- **F1** (verify both the vulnerable and fixed guard, and that only one fix landed):
  `git log -S "if (origin && origin !== url.origin)" --oneline -- worker/api/contact.ts`
  — should show exactly `dda5a6c` (introduced) and `c06885b` (fixed). Confirm the
  current guard: `grep -n "Origin" worker/api/contact.ts`.
- **F2** (verify the revert reason still reads as quoted above):
  `git show 8fbdad6` and `git show ce52c19`.
- **F3** (verify cadence and guard are both still current):
  `git log -1 --format='%B' a1b69c6`; confirm current cron:
  `grep -A1 "cron:" .github/workflows/generate-blog-post.yml`; confirm guard still
  present: `grep -n "findExactDuplicate\|SEMANTIC_THRESHOLD\|DUPLICATE_THRESHOLD" scripts/lib/blog-post.js`.
- **F4** (verify no diagnostics have crept back in):
  `grep -rn "diag" blog-src/src/pages/contact-error.astro` (should be empty) and
  `grep -n "rid=\|params.set" worker/api/contact.ts` (should be empty).
- **Migrations table**: `git log --oneline --all -i --grep=netlify | tail -5` and
  `git log -1 --format='%ad %s' --date=short a6d88b5` to reconfirm dates.

If any re-verify command above disagrees with this file, the live repo wins — update
this file's affected row and note the discrepancy in the PR that changes it (per
`resumesite-change-control`).
