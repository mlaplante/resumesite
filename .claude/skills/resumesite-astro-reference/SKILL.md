---
name: resumesite-astro-reference
description: Conceptual/domain reference for HOW and WHY the Astro side of resumesite is built — content collections and the glob loader pattern `**/[^_A-Z]*.md`, the Zod schema in blog-src/src/content.config.ts (excerpt max 300, title max 200), output:'static' + build.format:'directory' (why URLs are /path/ directories), why vite.build.assetsInlineLimit is 0 and how that ties to the CSP script-src (no 'unsafe-inline'), the `is:inline` / astro(4000) hints astro check reports on `<script type="application/ld+json">` blocks, the build-time asset pipeline (satori+resvg OG PNGs, pdfkit résumé PDF, PurgeCSS, fingerprint-assets.mjs) and why it must run in that exact order, shiki dual-theme code highlighting, and the sitemap/RSS/JSON-Feed surfaces. Load this skill when asked "why does astro check show hints", "why is assetsInlineLimit 0", "how are OG images generated", "why do post URLs end in a slash / have a trailing directory", "what does the glob loader exclude and why", "why is excerpt capped at 300 chars", "how does the résumé PDF get built", or when touching astro.config.mjs, content.config.ts, scripts/purge-css.mjs, scripts/fingerprint-assets.mjs, pages/og/[slug].png.ts, pages/resume.pdf.ts, or utils/schema.ts. This is a conceptual/architecture-theory skill, not a runbook — for actually invoking the build see resumesite-build-and-env; for the Worker/edge side see resumesite-cloudflare-reference; for writing post content see resumesite-content-and-writing.
---

# Astro Domain Reference (resumesite)

Conceptual knowledge for the Astro half of this repo — the "why", not the "how to run it". This skill exists because a mid-level engineer who knows generic Astro will still get several things here wrong: the whole site (not just the blog) lives under `blog-src/`, the CSP forces an unusual Vite setting, and several build-time steps have a load-bearing order.

Everything below is verified against the source files named. Re-verify commands are in **Provenance and maintenance** at the end — this file drifts as the code does.

## 0. Where things live (one-time orientation)

`blog-src/` is misleadingly named: it is **the entire Astro site** (portfolio + résumé + blog), not just the blog. Config file: `blog-src/astro.config.mjs`. Content schema: `blog-src/src/content.config.ts`. Post-build scripts run from repo root: `blog-src/scripts/purge-css.mjs` and `blog-src/scripts/fingerprint-assets.mjs` (both resolve `../../dist` relative to their own file location, i.e. the repo-root `dist/`, since Astro's `outDir` is `../dist` relative to `blog-src/`).

> Correction to a prior draft note: `fingerprint-assets.mjs` lives at **`blog-src/scripts/fingerprint-assets.mjs`**, not at repo-root `scripts/fingerprint-assets.mjs`. The root `scripts/` directory holds only the AI blog-draft generator tooling (`generate-post*.js`, `lib/blog-post.js`, `backfill-updated.js`) — that is a different, unrelated `scripts/` folder. Verify: `find . -iname 'fingerprint-assets.mjs'`.

## 1. Content collections: the glob loader pattern

`blog-src/src/content.config.ts`:

```ts
const posts = defineCollection({
  loader: glob({ pattern: '**/[^_A-Z]*.md', base: "./src/content/posts" }),
  schema: z.object({ ... }),
});
```

Decode the pattern `**/[^_A-Z]*.md` piece by piece:

| Fragment | Meaning |
|---|---|
| `**/` | any nesting depth under `src/content/posts` |
| `[^_A-Z]` | the **first character of the filename** must NOT be `_` and must NOT be an uppercase letter A-Z |
| `*.md` | rest of the filename, must end `.md` |

Why this specific exclusion exists, concretely:
- **Leading `_`** excludes conventional "private/partial" files (e.g. a future `_partials/` or `_draft-notes.md`) from ever being treated as a published post.
- **Leading uppercase letter** excludes `README.md`, `CLAUDE.md`, `CHANGELOG.md` — any documentation file someone might (accidentally or deliberately) drop next to posts. This is why `npm run build`'s `find blog-src/src -name 'CLAUDE.md' -delete` step is a belt-and-braces cleanup, not the only protection: even if a `CLAUDE.md` were left in `src/content/posts/`, the glob would already skip it because it starts with an uppercase `C`.
- A normal post filename (`2026-07-05-my-post.md`) starts with a digit, so it always matches.

`src/content/drafts/` is a **separate directory** not covered by this loader at all (the loader's `base` is `./src/content/posts` only) — drafts never get parsed as a collection, so an invalid/incomplete draft can't break `astro check` or the content-schema build validation. That's what lets the daily AI blog-draft generator write incomplete drafts safely (see `resumesite-content-and-writing` / the `blog-draft` skill).

## 2. The Zod schema (`content.config.ts`)

| Field | Type/constraint | Why |
|---|---|---|
| `title` | `string().min(1).max(200)` | Rendered in `<title>`, OG title, JSON-LD headline — 200 is a generous hard stop against a runaway AI-drafted title. |
| `date` | `z.coerce.date()` | Frontmatter is YAML/string; coerced to `Date` for sorting/formatting. |
| `updated` | `z.coerce.date().optional()`, defaults to `date` when omitted | Used by blog post JSON-LD (`dateModified`) and by `feed.json.ts` (`date_modified`) when present. |
| `category` | `string().min(1)` | Required, no cap — used for OG image sub-line and taxonomy pages. |
| `tags` | `array(string()).default([])` | Optional; empty array default so posts don't need a `tags:` key. |
| `excerpt` | `string().min(1).max(300)` | **Rendered directly as the meta description AND the OG description** (see `BaseHead.astro` props default and every page passing `description={post.data.excerpt}`-style props). 300 chars is comfortably inside search-snippet and OG-description display limits — this is a *rendering* constraint, not an arbitrary style preference. Also flows into RSS `<description>` and JSON Feed `summary`/`content_text`. |
| `image` | `string().optional()` | Falls back to `DEFAULT_OG_IMAGE` (`config.ts`) when absent. |
| `series` / `seriesOrder` | `string().min(1).optional()` / `number().optional()` | Posts sharing the same `series` string are cross-linked and get a `/blog/series/<slug>` index, ordered by `seriesOrder` ascending then `date`. |

If you need to raise `title` or `excerpt` caps, this is the only file to touch — but check every consumer first (`BaseHead.astro`, `og/[slug].png.ts`'s satori card layout which truncates titles >160 chars independently, `rss.xml.ts`, `feed.json.ts`).

## 3. `output`, `build.format`, `outDir` (astro.config.mjs)

```js
export default defineConfig({
  site: 'https://michaellaplante.com',
  outDir: '../dist',
  base: '/',
  output: 'static',
  build: { format: 'directory' },
  prefetch: { defaultStrategy: 'viewport' },
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
  integrations: [sitemap()],
  ...
});
```

- **`output: 'static'`** — the whole site prerenders to static HTML at build time. There is no Astro SSR runtime in production; the only dynamic behavior is the separate Cloudflare Worker handling `/api/contact` (see `resumesite-cloudflare-reference`). API-route files like `og/[slug].png.ts` and `resume.pdf.ts` still run at **build time** via `getStaticPaths`, not per-request.
- **`build.format: 'directory'`** — every page emits as `path/index.html` rather than `path.html`. This is why URLs like `/blog/hello-world/` are directories with a trailing slash, not `.html` files — it's why `lighthouserc.json` audits `/blog/hello-world/index.html` on disk but the served, canonical URL is `/blog/hello-world/`.
- **`outDir: '../dist'`** — relative to `blog-src/` (Astro's cwd during `cd blog-src && astro build`), so the build output lands at repo-root `dist/`, sibling to `blog-src/` — not nested inside it. Both post-build scripts (`purge-css.mjs`, `fingerprint-assets.mjs`) resolve `../../dist` from their own file path (`blog-src/scripts/`) to land on the same directory.
- **`prefetch.defaultStrategy: 'viewport'`** — Astro prefetches the target of any `<a>` link once it scrolls into the viewport, speeding up perceived navigation on listing/pagination pages.
- **`image.service` = sharp** — this is Astro's own `<Image>`/`<Picture>` component pipeline for any authored images. It is a **separate mechanism** from the OG PNG generator (§5), which hand-builds SVG via satori and rasterizes with `@resvg/resvg-js` directly — it does not go through Astro's image service at all.
- **`integrations: [sitemap()]`** — `@astrojs/sitemap` (`^3.7.3` in `blog-src/package.json` as of 2026-07-05), zero extra config; emits `sitemap-index.xml` / `sitemap-0.xml` at build time from the final route list.

## 4. Why `vite.build.assetsInlineLimit: 0` — and the CSP it protects

```js
vite: {
  build: {
    // Never inline bundled <script> blocks into the HTML. Required for the
    // strict CSP in public/_headers (script-src without 'unsafe-inline'):
    // with the default 4KB limit, small page scripts get embedded as inline
    // <script type="module"> and would be blocked.
    assetsInlineLimit: 0,
  },
},
```

Vite's default `assetsInlineLimit` is 4096 bytes: any bundled asset (including small compiled `<script type="module">` chunks) under that size gets base64-inlined directly into the HTML instead of emitted as a separate file. `blog-src/public/_headers` sets a strict CSP with **no `'unsafe-inline'` in `script-src`** (allowlisted origins only: self, the Umami analytics host, Cloudflare Insights, Cloudflare Turnstile, Cal.com). An inlined `<script>` has no external `src`, so the CSP would silently block it in any browser that enforces CSP — the script just never runs, with no build-time error. Setting `assetsInlineLimit: 0` forces every script to ship as its own external file (which the CSP's `'self'` origin then permits).

**CRITICAL INVARIANT** (verified in `blog-src/public/_headers` + this comment): if you ever add `'unsafe-inline'` back to `script-src`, or if you remove/raise `assetsInlineLimit`, you must change the *other* half too or the site breaks silently — Lighthouse/CI won't catch a CSP-blocked script (browsers just drop it and log a console warning; there's no build failure). Changing the CSP itself is a deliberate, reviewed change — treat any new script origin or CSP relaxation as a change-control decision (see `resumesite-change-control`), not something this skill authorizes.

## 5. The `is:inline` hints from `astro check` — what they are, and when they'd actually bite

Run 2026-07-05: `npm run typecheck` → **0 errors, 0 warnings, 12 hints (49 files)**. Of those 12, **9** are Astro's `astro(4000)` "is:inline" notice; the other **3** are unrelated legacy-JS notices inside `public/js/` (verified — see below). This is a slightly more precise breakdown than a quick read of the summary line suggests, since `astro check`'s per-line annotations all print the word "warning" even for diagnostics it buckets as "hints" in the final tally.

The 9 `astro(4000)` hints, all reading:
> "This script will be treated as if it has the `is:inline` directive because it contains an attribute. Therefore, features that require processing (e.g. using TypeScript or npm packages in the script) are unavailable. ... Add the `is:inline` directive explicitly to silence this hint."

Locations (verified 2026-07-05 via `npm run typecheck`):
`BaseHead.astro:66` (`<script defer src="/js/analytics.js">`), `pages/index.astro:19` and `:43` (two `<script type="application/ld+json">` blocks), `pages/services.astro:108`, `pages/blog/[slug].astro:102` and `:103` (two JSON-LD blocks), `pages/blog/category/[category].astro:39`, `pages/blog/series/[series].astro:50`, `pages/blog/tags/[tag].astro:44`.

**Why this is benign, and the mechanism:** Astro treats a `<script>` tag as implicitly `is:inline` (i.e. shipped byte-for-byte, unprocessed) the moment it has *any attribute at all* — `src=`, `defer`, `type="application/ld+json"`, or `set:html={...}`. All 9 flagged tags are exactly the kind of script that should never be processed:
- JSON-LD blocks (`<script type="application/ld+json" set:html={safeJsonLdString} />`) are static structured-data payloads, not executable script — Astro's TS/npm-import bundling is irrelevant to them.
- `<script defer src="/js/analytics.js">` and the `theme.js` load in `BaseHead.astro` reference classic, hand-authored files already living in `blog-src/public/js/` (verified: these are **classic scripts, not ES modules** — see directory map) — they were never meant to go through Astro's Vite bundling pipeline.

**When it would actually bite:** if someone converts one of these blocks to *need* Astro's processing — e.g. adding a TypeScript import or an npm package inside a `<script>` that still carries `src=`/`type=`/`set:html`/`defer` — Astro will silently skip bundling it (per the hint text) and ship the script unprocessed, which will likely throw a syntax/module-resolution error in the browser with no build-time signal. The fix in that case is to either (a) keep the JSON-LD/classic-script pattern as-is (recommended — don't add processing requirements to these), or (b) add the explicit `is:inline` directive to acknowledge and silence the hint once you've confirmed no processing is actually needed.

The other 3 hints are unrelated and live in plain (non-Astro) JS under `public/js/`, not in this pipeline:
- `public/js/cal-embed.js:27` — `ts(80002)`: "This constructor function may be converted to a class declaration" (a TS-server style suggestion on `var api = function () { p(api, arguments); };`).
- `public/js/theme.js:51-52` — `ts(6385)`/`ts(6387)`: `MediaQueryList.addListener` is deprecated (kept intentionally for older Safari — see the adjacent `/* older Safari */` comment in that file).

None of these 12 hints fail CI (`ci.yml`'s `site` job runs `npm run build`, not `astro check`, and `typecheck` isn't gated in CI as a separate required job the way `lint`/`test`/`site` are — re-verify this if you're relying on it, see Provenance).

## 6. Build-time asset generation: OG images, résumé PDF, PurgeCSS, fingerprinting — and why the order is fixed

Root `npm run build` (verified, `package.json`):
```
find blog-src/src -name 'CLAUDE.md' -delete
  && cd blog-src && npm run build        # = astro build
  && node scripts/purge-css.mjs
  && node scripts/fingerprint-assets.mjs
```

The three build-adjacent steps run in this order for a real dependency reason each:

1. **`astro build`** — prerenders every page/route, including the two build-time asset-generator API routes:
   - **`pages/og/[slug].png.ts`** — for every post (`getStaticPaths` iterates `getCollection('posts')`), hand-builds a satori "virtual DOM" node (`type`/`props`/`key` shape, no React dependency), decompresses the site's Poppins WOFF2 fonts to TTF via `wawoff2` (satori needs TTF, the site ships WOFF2), rasterizes the resulting SVG to a 1200×630 PNG with `@resvg/resvg-js`, and returns it with `Cache-Control: public, max-age=604800, immutable`. Notable gotcha fixed in code: font bytes are copied into a **fresh `Buffer`** (`freshBuffer()`) before use — without that copy, Astro's Vite bundler was observed to hand satori a corrupted view of the WASM-owned `Uint8Array` across the prerender boundary, producing "Unsupported OpenType signature" errors. Title text is truncated at 160 chars (well under satori's ~1500-char soft cap) purely to avoid overflowing the fixed-height card.
   - **`pages/resume.pdf.ts`** — calls `renderResumePdf()` (`src/utils/resumePdf.ts`), which draws the résumé directly with `pdfkit` (no headless browser) from the **same** `src/data/resume.ts` module (`profile`, `summary`, `stats`, `skills`, `experience`, `certifications`) that powers the on-site `/resume` page — the PDF cannot drift from the rendered page because there's only one data source. Same WOFF2→TTF decompress-and-fresh-copy pattern as the OG generator (three weights: regular/semibold/bold), plus a documented ordering constraint: fonts are decompressed **strictly one at a time, copying each result before starting the next** — overlapping `wawoff2` calls can grow its WASM memory and detach earlier views, surfacing as fontkit "Unknown font format" errors. `findPublicDir()` walks up from the module's own directory to locate `public/fonts/poppins`, because Astro's prerender step re-bundles this module into `.astro/.prerender/chunks/` at a different depth than the source tree (where vitest imports it directly) — a fixed relative path would only work in one of the two contexts.
   
   After this step, `dist/` has full HTML + the *original, un-purged* Bootstrap CSS (`bootstrap.min.css`, `bootstrap-reboot.min.css`, `bootstrap-grid.min.css`, `bootstrap-utilities.min.css`) plus `style.css`.

2. **`scripts/purge-css.mjs`** (`blog-src/scripts/purge-css.mjs`) — **must run after `astro build`** because PurgeCSS's input is the *final rendered HTML*: it globs `dist/**/*.html` as its content source and strips any CSS rule whose selector doesn't appear anywhere in that HTML, for exactly these 5 files: `css/bootstrap-reboot.min.css`, `css/bootstrap-grid.min.css`, `css/bootstrap-utilities.min.css`, `css/bootstrap.min.css`, `css/style.css`. It carries a `safelist` (`standard` array + `deep` regex list including `/^fade/`, `/^show/`, `/^modal/`) for classes that are only ever added/removed at runtime by `public/js/script.js` (e.g. `dark-mode`, `aos-animate`, Bootstrap's `show`/`collapsing`/`fade` state classes) and would otherwise never appear in static HTML and get purged away. Logs a per-file before/after size and percentage reduction.

3. **`scripts/fingerprint-assets.mjs`** (`blog-src/scripts/fingerprint-assets.mjs`) — **must run after `purge-css.mjs`**, per its own header comment ("Runs after purge-css.mjs, which finalizes the CSS content the hashes are derived from"): it SHA-256-hashes the *actual final bytes* of every file under `dist/css/` and `dist/js/`, copies each to a new `name.<10-hex-chars>.ext` filename (originals are **kept**, not moved — the Worker falls back to the unhashed original when a stale cached page requests a hash from a previous deploy), then walks every `.html` file in `dist/` rewriting `href="..."`/`src="..."` references (attribute-scoped regex, so a path merely *mentioned* in page text is never touched) to point at the hashed name. If it hashed CSS *before* PurgeCSS ran, the hash would be derived from pre-purge (different, larger) bytes that don't match what's actually shipped — wasted work at best, a cache/identity mismatch at worst. The script hard-fails (`process.exit(1)`) if zero references got rewritten, as a canary for "the HTML/asset layout changed and this script no longer knows how to find them."

Fingerprinted, long-TTL immutable Cache-Control is what lets `/css/*`/`/js/*` be cached aggressively at the edge without invalidation headaches — see `resumesite-cloudflare-reference` for the Worker-side fallback behavior and `_headers` cache rules.

## 7. shiki, sitemap, RSS/JSON Feed (lighter-weight surfaces)

- **shiki** (dual-theme code highlighting) — configured in `astro.config.mjs`'s `markdown.shikiConfig`: `themes: { light: 'github-light', dark: 'github-dark' }`, `wrap: true`. Astro renders **both** themes' styling into the output and toggles between them via CSS driven by the site's dark-mode class (paired with `public/js/theme.js`, the blocking inline script in `BaseHead.astro` that stamps `data-theme` on `<html>` before first paint to avoid a light-mode flash). `shiki` itself is a transitive dependency of Astro (`^4.0.2` per `blog-src/package-lock.json` as of 2026-07-05), not a direct one — don't expect to find it in `blog-src/package.json`'s own dependency list.
- **`@astrojs/sitemap`** (`^3.7.3`) — zero-config integration; emits `sitemap-index.xml`/`sitemap-*.xml` at build time.
- **`blog-src/src/pages/blog/rss.xml.ts`** — uses `@astrojs/rss` (`^4.0.18`); item fields map `title`/`date`→`pubDate`/`excerpt`→`description`/`category + tags`→`categories`, link is `/blog/<post.id>/`.
- **`blog-src/src/pages/feed.json.ts`** — hand-rolled JSON Feed 1.1 (`https://jsonfeed.org/version/1.1/`), a companion surface for readers that prefer JSON over RSS. Uses `post.data.updated ?? post.data.date` for `date_modified` — the one place the schema's `updated` fallback is consumed explicitly in code (besides JSON-LD `dateModified` on post pages).

## 8. JSON-LD injection safety (`utils/schema.ts`) — read alongside §5

`safeJsonLd()` is the function every `<script type="application/ld+json" set:html={...}>` block in §5 depends on. Plain `JSON.stringify` does not escape `<`, `>`, or `&`, so a post `title`/`tag`/`excerpt` containing a literal `</script>` or `<!--` sequence could break out of the script context (HTML/script injection) — since post frontmatter can originate from an **AI-generated draft**, this is not a theoretical input. `safeJsonLd()` escapes `<` `>` `&` to their `\uXXXX` forms (still valid, equivalent inside a JSON string; inert as markup) plus the U+2028/U+2029 line separators (legal in JSON strings, illegal as raw unescaped characters in JS source, and historically a source of parser divergence bugs). `breadcrumbList()` builds the `BreadcrumbList` schema.org object consumed by every taxonomy/post page's JSON-LD block.

## When NOT to use this skill

- Actually **invoking** `npm run build`/`dev`/`preview`, dependency install traps, or the two-`npm ci` requirement → `resumesite-build-and-env`.
- The Cloudflare Worker, `wrangler.jsonc`, D1, `_headers` cache-control *values* (this skill covers only the CSP/`assetsInlineLimit` invariant, not the full header set) → `resumesite-cloudflare-reference`.
- Writing/editing actual blog post content, frontmatter conventions for authors, the AI draft-generation pipeline/dedupe logic → `resumesite-content-and-writing` and the existing `blog-draft` skill.
- Lighthouse thresholds, `astro check`/`eslint`/`vitest` as pass/fail gates, CI job structure → `resumesite-validation-and-qa` / `resumesite-diagnostics-and-tooling`.
- Changing the CSP, the content-focus date-gate, or any other tunable → confirm the exact current value in `resumesite-config-and-flags`, and route any actual change through `resumesite-change-control` (PR + green CI) — this skill only explains why the current values are what they are.

## Provenance and maintenance

Compiled 2026-07-05 from direct inspection of: `blog-src/astro.config.mjs`, `blog-src/src/content.config.ts`, `blog-src/scripts/purge-css.mjs`, `blog-src/scripts/fingerprint-assets.mjs`, `blog-src/src/pages/og/[slug].png.ts`, `blog-src/src/pages/resume.pdf.ts`, `blog-src/src/utils/schema.ts`, `blog-src/src/utils/resumePdf.ts`, `blog-src/src/components/BaseHead.astro`, `blog-src/src/pages/blog/tags/[tag].astro`, `blog-src/src/pages/blog/rss.xml.ts`, `blog-src/src/pages/feed.json.ts`, `blog-src/package.json`, `package.json`, plus a live `npm run typecheck` run.

Re-verify commands (run from repo root):
- Glob-loader pattern and schema caps: `grep -n "loader:\|min(\|max(" blog-src/src/content.config.ts`
- `assetsInlineLimit` / CSP invariant still paired: `grep -n assetsInlineLimit blog-src/astro.config.mjs` and `grep -n "script-src" blog-src/public/_headers`
- `is:inline` hint count/locations (drifts whenever pages change): `npm run typecheck 2>&1 | grep -c "astro(4000)"` for the is:inline subset, and `npm run typecheck 2>&1 | tail -5` for the full "N errors, N warnings, N hints" summary.
- Build script order: `grep -n '"build"' package.json blog-src/package.json`
- `fingerprint-assets.mjs` actual location (previously mis-recorded as root `scripts/`): `find . -iname 'fingerprint-assets.mjs'`
- Dependency versions (`astro`, `@astrojs/sitemap`, `@astrojs/rss`, `satori`, `@resvg/resvg-js`, `pdfkit`, `wawoff2`, `purgecss`, transitive `shiki`): `grep -E '"(astro|@astrojs/(sitemap|rss)|satori|@resvg/resvg-js|pdfkit|wawoff2|purgecss)"' blog-src/package.json` and `grep -n '"shiki"' blog-src/package-lock.json`
