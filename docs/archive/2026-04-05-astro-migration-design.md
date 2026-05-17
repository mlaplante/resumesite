# Full Astro Migration + Site Optimizations

## Date: 2026-04-05

## Goal
Migrate the entire resumesite into a unified Astro project, eliminating HTML duplication, consolidating analytics on Umami, and adding deployment optimizations.

## Approach: Option C — Full Migration, Preserve Existing Assets

Migrate index.html, uses/, and thank-you/ into Astro pages using shared layouts, but keep existing CSS/JS/fonts as static assets rather than rewriting them. Blog URLs at /blog/* are preserved.

## Changes

### 1. Restructure Astro Project
- Change `outDir` to repo root (`.`) or `dist/`
- Change `base` from `/blog` to `/`
- Move css/, js/, fonts/, favicon files into Astro's `public/`
- Blog pages live under `src/pages/blog/`

### 2. Shared Layouts
- `SiteLayout.astro` — nav, footer, favicons, Umami analytics, SEO meta
- `BlogLayout.astro` — extends or sits alongside SiteLayout for blog pages
- Both share: favicon block, analytics script, dark mode toggle

### 3. Pages
- `src/pages/index.astro` — homepage (converted from index.html)
- `src/pages/uses.astro` — uses page
- `src/pages/thank-you.astro` — form thank-you page
- `src/pages/blog/[...page].astro` — blog listing (moved from root)
- `src/pages/blog/[slug].astro` — blog post (moved from root)
- `src/pages/blog/about.astro`, `blog/404.astro`, `blog/rss.xml.ts`

### 4. Analytics Consolidation
- Remove Google Analytics (gtag.js) from all pages
- Keep Umami only (already in blog, add to site pages)

### 5. Cloudflare Cache Purge
- Add GitHub Action triggered on Netlify deploy-succeeded or on push to master
- Calls Cloudflare purge API using repo secret

### 6. Workflow Hardening
- Pin Node version in generate-blog-post.yml

### 7. CSP + Performance
- Remove GA and Cloudflare Insights from CSP
- Add `<link rel="preconnect">` for cdn.jsdelivr.net, res.cloudinary.com
- Add RSS autodiscovery to main site nav

### 8. Netlify Config
- Update build command to build from unified Astro project
- Update publish directory

## URL Preservation
- `/` — homepage (same)
- `/uses/` — uses page (same)
- `/blog/` — blog listing (same)
- `/blog/slug/` — blog posts (same)
- `/thank-you/` — form redirect (same)

## Risks
- jQuery and legacy JS libraries need to work within Astro pages (use `is:inline` scripts)
- AOS animations depend on specific DOM structure
- Contact form uses Netlify Forms (needs `data-netlify` attribute preserved)
- Blog internal links using `import.meta.env.BASE_URL` need updating from `/blog` to `/blog`
