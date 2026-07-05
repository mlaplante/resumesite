---
name: resumesite-content-and-writing
description: Content stewardship for resumesite (michaellaplante.com) — house voice for blog posts, the frontmatter contract (title/date/category/excerpt/tags, optional updated/image/series/seriesOrder) enforced by blog-src/src/content.config.ts, the posts/ vs drafts/ split, file naming YYYY-MM-DD-slug.md, the docs/archive/ snapshot convention, keeping README.md's command table accurate, and the public-positioning surfaces (RSS, JSON Feed, llms.txt, llms-full.txt, security.txt, OG cards, sitemap/JSON-LD). Load this when asked to "write a blog post", "draft a post", "what category should this be", "what's the frontmatter format", "how do I publish a draft", "is this docs/archive file supposed to be updated", "update the README", "what goes in llms.txt", "does this post need an updated: field", or when reviewing an AI-generated or human-written post for voice/structure/frontmatter correctness before it goes into a PR. Also covers the temporary cybersecurity + AI-governance content focus that expires 2026-08-12. Do NOT use this for the generator pipeline's dedupe/embedding mechanics or provider scripts (see resumesite-blog-quality-campaign) or for Zod schema internals / glob-loader mechanics (see resumesite-astro-reference) — this skill owns the words and the editorial/publishing conventions, not the pipeline code or schema plumbing.
---

# resumesite Content and Writing

This is the skill for **the content of record**: what a blog post must say, how it must be shaped, where it
lives before and after publishing, and what the site's public-facing "about this content" surfaces (feeds,
`llms.txt`, `security.txt`) must claim. It does not cover the generator scripts' internals (dedupe,
embeddings, provider adapters — see `resumesite-blog-quality-campaign`) or the Zod schema plumbing (see
`resumesite-astro-reference`). It does not grant any exception to the PR-and-green-CI gate — see
`resumesite-change-control` for that.

## 1. House voice

Every post — human-written or AI-drafted — is written in **first person as Michael LaPlante**, SVP of
Information Security and Operations (currently at Proforma), 15+ years of experience. Verified identity
strings, shared across the site so they don't drift (`blog-src/src/config.ts`, `blog-src/public/llms.txt`,
`blog-src/src/pages/llms-full.txt.ts`):

- `AUTHOR_NAME = 'Michael LaPlante'`
- `BLOG_TITLE = "Michael LaPlante's Blog"`
- `BLOG_DESCRIPTION = 'Thoughts on security, engineering, and building things.'`

Tone and content rules, verified from `scripts/lib/blog-post.js`'s `SYSTEM_PROMPT` (the prompt every AI
provider script shares) and cross-checked against real posts:

- Practical technical deep dives, not marketing copy: "include concrete examples and actionable takeaways,"
  "meaningful code snippets, configuration examples, and hands-on engineering detail."
- Professional but approachable — not academic, not clickbait.
- Focus on the **why**: what problem was being solved and why that approach was chosen (this is explicit in
  both `SYSTEM_PROMPT` and the `blog-draft` skill's guidelines).
- The general-mode prompt explicitly says "Avoid making AI or machine learning the primary topic" — that
  instruction is itself **superseded** while the temporary focus below is active.

### The temporary content focus (date-gated, expires 2026-08-12)

`scripts/lib/blog-post.js` defines:

```js
export const FOCUS_UNTIL = '2026-08-12'; // 45 days from 2026-06-28
export function focusActive(today = new Date().toISOString().slice(0, 10)) {
  return today <= FOCUS_UNTIL;
}
```

While `focusActive()` is true (today is 2026-07-05, so **the focus is currently active**), every AI
provider script uses `FOCUS_SYSTEM_PROMPT` instead of `SYSTEM_PROMPT`, and the topic picker
(`topicPickerPrompt`) steers auto-picked topics the same way. The mandate: center posts on **cybersecurity**
(threat detection and response, secure architecture, incident response, IAM, cryptography in practice,
vulnerability management, cloud/infrastructure security) or on **AI governance within security** (NIST AI
RMF, ISO/IEC 42001, EU AI Act framing, securing AI/ML pipelines, governing AI use in security programs) —
framing AI through a security/governance lens, never as a general AI/ML tutorial.

**This reverts automatically** — `activeSystemPrompt(today)` just falls back to the general `SYSTEM_PROMPT`
once `today > FOCUS_UNTIL`. Nobody has to edit code or flip a flag on 2026-08-13. If you're writing or
reviewing a post after that date and it's still narrowly cyber/AI-governance-only, that's a content choice,
not a pipeline requirement — check `date -u +%F` against `2026-08-12` before assuming the gate is still
open. The interactive `blog-draft` skill (`.claude/skills/blog-draft/SKILL.md`) carries an identical,
independently-worded note — the two must be kept in sync if this date or scope ever changes (see
`resumesite-config-and-flags`, which owns `FOCUS_UNTIL` as a tunable knob).

## 2. Frontmatter contract

Enforced by the Zod schema in `blog-src/src/content.config.ts` (schema internals, glob pattern, and why
`drafts/` isn't validated → `resumesite-astro-reference`). The contract itself, verified 2026-07-05:

| Field | Required? | Constraint | Notes |
|---|---|---|---|
| `title` | yes | 1–200 chars | Plain string; becomes `<h1>`, `<title>`, OG title. |
| `date` | yes | coercible to `Date` | `YYYY-MM-DD` in practice. |
| `updated` | no | coercible to `Date` | Defaults to `date` when omitted. Used by JSON-LD `dateModified`, RSS/JSON-Feed `date_modified`. See §4 for how it gets backfilled. |
| `category` | yes | non-empty string | Free-form — the schema does **not** enforce an enum (`z.string().min(1)`). Conventions in use, verified via `grep -h '^category:' blog-src/src/content/posts/*.md \| sort \| uniq -c` on 2026-07-05: `thought-leadership` (103), `dev-session` (6), `career` (2, hand-authored — not part of the documented three-category convention but valid against the schema). |
| `tags` | no | array of strings, default `[]` | Kebab-case by convention (the AI pipeline's `extractTags()` lowercases and slugifies, max 6). |
| `excerpt` | yes | 1–300 chars | **This is the OG/meta description** — rendered into `<meta name="description">` and social cards. Keep it a real sentence, not a truncation artifact; don't invent metrics or claims here that the post body doesn't support. |
| `image` | no | string (path/URL) | Overrides the auto-generated OG card at `/og/<slug>.png`. Omit to use the automatic card. |
| `series` | no | non-empty string | Posts sharing the same `series` value link together on a `/blog/series/<slug>` index, ordered by `seriesOrder` then date. **Zero posts currently use this** (verified: `grep -l '^series:' blog-src/src/content/posts/*.md` → empty, 2026-07-05) — it's a schema feature, not yet an exercised convention. |
| `seriesOrder` | no | number | Only meaningful alongside `series`. |

Category conventions by origin (who writes it, and what category it gets), verified against
`scripts/lib/blog-post.js` line ~609 and real post frontmatter:

- **`project-update`** — assigned automatically when a post is generated from git history (`mode === 'git'`
  in the pipeline). Reserved for git-log-derived posts; README documents it the same way.
- **`thought-leadership`** — assigned automatically for `auto`/`topic` mode pipeline posts (the overwhelming
  majority of the corpus today: 103/111 posts).
- **`dev-session`** — the category the interactive `blog-draft` skill's frontmatter template hardcodes for
  session-recap posts written inside a Claude Code conversation.
- Anything else (e.g. `career`) is a human choosing a category by hand outside either automated path — the
  schema allows it, but it's not one of the three documented conventions above. If you're hand-authoring a
  post that isn't a dev-session recap, prefer one of the three unless there's a real reason not to.

### File naming and location

- Filename: `YYYY-MM-DD-slug.md`, where `slug` is the kebab-case title (the pipeline's `slugify()`:
  lowercase, non-alphanumeric runs collapsed to `-`, leading/trailing `-` stripped).
- **Published** posts live in `blog-src/src/content/posts/` — this is the only directory the content
  collection's glob loader (`**/[^_A-Z]*.md`) reads, so anything here is built and public once merged.
- **Unpublished** drafts from the interactive `blog-draft` skill live in `blog-src/src/content/drafts/` —
  this directory is not covered by the loader at all, so an incomplete/invalid draft can't break `astro
  check` or the build. As of 2026-07-05 this directory doesn't currently exist in the tree (no draft is
  pending) — it's created on demand.
- Collision handling: the automated pipeline's `writePostCollisionSafe()` appends `-2`, `-3`, ... to the
  filename (not the slug inside frontmatter) if `date-slug.md` already exists on disk the same day.

## 3. Publishing path — two distinct pipelines, don't conflate them

There are **two different mechanisms** that produce a post, and they hit the human gate at different
points. Full authoritative detail (including the corrected record vs. an earlier draft understanding) lives
in `resumesite-change-control` §Rule 2 — read that before touching either pipeline's output. Summary for
content-authoring purposes:

1. **Automated daily pipeline** (`scripts/generate-post*.js` via `.github/workflows/generate-blog-post.yml`,
   cron `0 8 * * *` UTC, or `npm run blog:draft:git` / `npm run blog:draft:topic` locally) — `runGenerator()`
   in `scripts/lib/blog-post.js` writes the finished Markdown **directly into
   `blog-src/src/content/posts/`**, not into `drafts/`. In CI this lands as a PR labeled `blog-draft`
   against `master` — **merging that PR is what publishes it.** Closing the PR without merging discards it.
   There is no drafts→posts move for this path.
2. **Interactive session pipeline** (`.claude/skills/blog-draft/SKILL.md`, invoked inside a Claude Code
   conversation) — writes into `blog-src/src/content/drafts/` with the `dev-session` category, and
   explicitly reminds the user to review and move the file into `blog-src/src/content/posts/` when ready.

**Never auto-publish either way.** Whichever path produced the post, a human reads it before it goes live —
either by reviewing the `blog-draft`-labeled PR before merging, or by reviewing the draft file before moving
it into `posts/` and opening a PR for that move. Change-control's PR-and-green-CI gate (see
`resumesite-change-control` §2) applies to both; this skill does not carve out an exception.

### Backfilling `updated:`

`scripts/backfill-updated.js` scans git history per post and, in `--apply` mode, writes an `updated:
YYYY-MM-DD` line into frontmatter for any post with a real post-publish content edit (it explicitly skips
the first/import commit and pure-rename commits to avoid false positives from the bulk-import history).

```bash
node scripts/backfill-updated.js          # dry-run report — safe, read-only
node scripts/backfill-updated.js --apply  # rewrites frontmatter in-place
```

As of 2026-07-05, **zero published posts have an `updated:` field** (verified: `grep -l '^updated:'
blog-src/src/content/posts/*.md` → empty) — this script exists but hasn't been run/applied against the
current corpus, or every post's edits so far were filtered out as import/rename noise. Don't assume any post
has been through this pass; check before claiming a post's `updated` date is accurate.

## 4. `docs/archive/` — snapshots, not living docs

`docs/archive/README.md` states the convention directly: these are "historical planning/design documents
that captured one-shot migrations or redesigns. They reflect the state of the repo at the time the work
landed and are kept here for context, not as living documentation." Current contents (verified 2026-07-05):

| File | Landed | Notes |
|---|---|---|
| `2026-03-23-blog-redesign-plan.md` | 2026-03 | SavvyCal-inspired blog redesign (executed) |
| `2026-03-23-blog-redesign-design.md` | 2026-03 | Design spec paired with the plan |
| `2026-04-05-astro-migration-design.md` | 2026-04 | Astro 6 unified-build migration (executed) |
| `2026-04-05-site-improvements-plan.md` | 2026-04 | Tags, categories, sitemap cleanup, etc. (executed) |
| `2026-04-05-site-improvements-design.md` | 2026-04 | Spec paired with the plan above |

**Rule: do not edit an existing archive file to reflect new reality.** If you do new migration/redesign
work, write a *new* dated doc (`YYYY-MM-DD-<topic>-plan.md` / `-design.md`, matching the existing naming),
and let the old one stand as a record of what was true when it landed. The root `README.md` is where current
architecture is documented (the archive README says so explicitly: "For the current architecture, see the
root `README.md`").

## 5. Keeping `README.md` accurate

`README.md` is the front door — verified sections relevant to content work (as of 2026-07-05, `README.md`
§"Blog", lines ~166–220):

- A **Commands** table (`npm run dev`, `build`, `preview`, `typecheck`, `lint`, `test`, `test:watch`,
  `worker:dev`, `worker:deploy`, `blog:draft:git`, `blog:draft:topic`) that must match root `package.json`
  scripts. If you add/rename/remove an npm script, update this table in the same PR.
- A **Writing a Post** numbered walkthrough and a **Categories** list. Keep these consistent with §2/§3
  above — if the frontmatter contract or publishing path changes, this section drifts unless updated
  alongside it.
- An **AI draft dedupe** paragraph describing the embedding/Jaccard fallback — that's
  `resumesite-blog-quality-campaign`'s territory in depth; README only needs a correct summary.

Treat a stale README the same as a stale test: if your change makes a documented command, path, or category
wrong, fix the README in the same PR (change-control classifies README-only edits as **content-only** per
its bucket table, still gated by the standard PR path).

## 6. Public positioning surfaces

These are the site's machine- and crawler-facing claims about itself. Each is a real, served endpoint — get
them wrong and an external reader (search engine, feed reader, or LLM crawler) sees stale or false claims
about the site.

| Surface | File | What it must stay true to |
|---|---|---|
| Sitemap | `@astrojs/sitemap` integration (astro.config.mjs) | Auto-generated at build; no manual upkeep. |
| JSON-LD + canonical + OG meta | `blog-src/src/components/BaseHead.astro` (per `resumesite-astro-reference`) | Pulls `title`/`excerpt`/`date`/`updated`/`image` straight from frontmatter — a bad excerpt or missing image shows up here. |
| RSS | `blog-src/src/pages/blog/rss.xml.ts` | Uses `BLOG_TITLE`/`BLOG_DESCRIPTION` from `config.ts` and per-post `title`/`date`/`excerpt`/`category`/`tags` — nothing to hand-maintain, but a post's frontmatter feeds it directly. |
| JSON Feed | `blog-src/src/pages/feed.json.ts` | JSON Feed 1.1 (`https://www.jsonfeed.org/version/1.1/`). Same source fields as RSS, plus `date_modified` from `updated ?? date`. Feed identity (`AUTHOR_NAME`, `BLOG_TITLE`, `BLOG_DESCRIPTION`, `SITE_URL`) is centralized in `blog-src/src/config.ts` — edit there, not per-page, so RSS/JSON-Feed/head meta can't drift apart. |
| `/llms.txt` | `blog-src/public/llms.txt` (static file) | Hand-maintained curated summary: author identity, core pages, blog taxonomy (**currently lists only `dev-session` and `thought-leadership`** — `career` and `project-update` aren't mentioned; update this file if the category mix shifts meaningfully), a "Selected posts" list, and "Topics covered." **This is a static file, not generated** — if core pages, taxonomy, or the author's role changes, this file goes stale silently. Re-check it whenever `config.ts` identity strings or the category conventions change. |
| `/llms-full.txt` | `blog-src/src/pages/llms-full.txt.ts` (generated at request time) | Concatenates every published post's full body + frontmatter, newest first, behind a fixed header describing usage norms ("attribute and link back," "prefer the most recent post," "code snippets are illustrative — review for fit before using in production"). Generated from live content — nothing to hand-maintain here besides the header text and the "Topics covered" list, which is duplicated by hand between this file and `llms.txt` (keep them in sync if topics change). |
| `/.well-known/security.txt` | `blog-src/public/.well-known/security.txt` (RFC 9116) | Static. Has an `Expires:` field — verified currently `2027-06-06T00:00:00.000Z`. **Renew this before it expires** or security researchers' tooling may treat the policy as stale/invalid. `Contact:` currently points at `https://michaellaplante.com/#contact`. |
| OG social cards | `blog-src/src/pages/og/[slug].png.ts` (satori + resvg, per `resumesite-astro-reference`) | Auto-generated 1200×630 PNG per post from `title`/`category`/`date`; override via frontmatter `image:`. |

Cache headers for these paths are set in `blog-src/public/_headers` (e.g. `/llms.txt` — 1-day edge TTL,
`/llms-full.txt` — 1-hour edge TTL with stale-while-revalidate, `/.well-known/security.txt` — 1-day edge
TTL) — if you change how often a surface's content changes, check whether its cache TTL in `_headers` still
makes sense (that file is otherwise `resumesite-cloudflare-reference`/`resumesite-architecture-contract`
territory for the security-header rules; this skill only owns the content-freshness angle).

### What must be true before you claim it

Both `/llms.txt` and `/llms-full.txt` explicitly promise readers (including AI agents) that content is
"original and authored or edited by Michael LaPlante" and that code snippets are "illustrative — review for
fit before using in production." Do not let a post assert a metric, an incident outcome, or a production
result that didn't actually happen — the AI-generated pipeline writes engaging prose by design, and an
unverified claim in a published post is a false public claim under Michael's byline, not a harmless flourish.
If a draft (from either pipeline) contains a suspiciously specific number, benchmark, or "we did X in
production" claim that isn't backed by the git history or a real source, flag it in review rather than
letting it merge as-is.

## 7. When NOT to use this skill

| If you need... | Use instead |
|---|---|
| Dedupe/embedding mechanics, provider adapter scripts, the topic-picker retry logic | `resumesite-blog-quality-campaign` |
| Zod schema internals, the glob loader pattern, why `drafts/` isn't validated | `resumesite-astro-reference` |
| Whether a change needs a PR / what CI must pass / the two-pipeline publish-gate ruling in full | `resumesite-change-control` |
| `FOCUS_UNTIL`, `SEMANTIC_THRESHOLD`, and other tunable defaults as a flat catalog | `resumesite-config-and-flags` |
| Why a security header or CSP rule exists | `resumesite-architecture-contract` / `resumesite-cloudflare-reference` |
| Debugging a build failure caused by bad frontmatter | `resumesite-debugging-playbook` |

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of: `.claude/skills/blog-draft/SKILL.md`,
`scripts/lib/blog-post.js`, `blog-src/src/content.config.ts`, `blog-src/src/config.ts`,
`docs/archive/README.md`, `blog-src/src/pages/blog/rss.xml.ts`, `blog-src/src/pages/feed.json.ts`,
`blog-src/src/pages/llms-full.txt.ts`, `blog-src/public/_headers`, `blog-src/public/llms.txt`,
`blog-src/public/.well-known/security.txt`, `README.md`, `scripts/backfill-updated.js`,
`.claude/skills/resumesite-change-control/SKILL.md`, `.claude/skills/resumesite-astro-reference/SKILL.md`,
and a live scan of `blog-src/src/content/posts/*.md` frontmatter (111 posts).

Re-verify commands (run these again if this file feels stale):

```bash
# Is the content-focus date gate still active?
date -u +%F   # compare against FOCUS_UNTIL below
grep -n "FOCUS_UNTIL" scripts/lib/blog-post.js

# Category mix — has a new convention emerged, or has `career` grown?
grep -h '^category:' blog-src/src/content/posts/*.md | sort | uniq -c

# Has anyone started using series/seriesOrder or updated yet?
grep -l '^series:' blog-src/src/content/posts/*.md | wc -l
grep -l '^updated:' blog-src/src/content/posts/*.md | wc -l

# Does drafts/ exist right now (a draft is pending review)?
ls blog-src/src/content/drafts/ 2>&1

# Are README's command table and llms.txt's category list still accurate?
grep -n "npm run" package.json
grep -n "Category:" blog-src/public/llms.txt

# security.txt renewal date
grep -n "Expires:" blog-src/public/.well-known/security.txt
```

If any file disagrees with what's written above, the file wins — update this SKILL.md and bump this
provenance date.
