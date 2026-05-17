# Site Improvements: Tags, Categories, 404, Sitemap & Asset Cleanup

**Date:** 2026-04-05
**Status:** Approved
**Approach:** Single branch, all changes together

## Summary

Four improvements to michaellaplante.com shipped as one batch:

1. Tag and category pages for the blog (SEO + navigation)
2. Site-wide 404 page (main site style)
3. Sitemap deduplication (remove static, keep auto-generated)
4. Dead asset cleanup + Waves.js CSS replacement

---

## 1. Tag & Category Pages

### New Files

- `src/pages/blog/category/[category].astro` — one page per category
- `src/pages/blog/tags/[tag].astro` — one page per tag

### Behavior

- `getStaticPaths()` queries all posts via `getCollection('posts')`, extracts unique categories/tags, generates a static page for each.
- Each page reuses the existing post card grid layout from `[...page].astro` — same card markup, same styles.
- Page heading format: "Category: Cloud Security" or "Tag: zero-trust".
- Posts sorted by date descending. No pagination initially (unlikely to exceed 10 posts per tag/category at current volume).
- Wrapped in `BlogLayout` with proper OG meta. Title and description auto-generated from taxonomy name + post count.

### Structured Data

- `BreadcrumbList` schema on each page:
  - Category: Home > Blog > Category > [name]
  - Tag: Home > Blog > Tags > [name]

### Navigation Integration

- Blog listing page (`[...page].astro`): category filter buttons become `<a>` links to `/blog/category/[cat]` in addition to the existing client-side JS filtering (progressive enhancement).
- Individual post pages (`[slug].astro`): tags render as clickable links to `/blog/tags/[tag]`.
- Category badges on post cards link to `/blog/category/[cat]`.

---

## 2. Site-wide 404 Page

### New File

- `src/pages/404.astro` — Astro automatically serves this for all unmatched routes.

### Design

- Uses `SiteLayout` to match the main site aesthetic (homepage/uses style).
- Content: large "404" heading, "Page not found" message, brief helpful text.
- Links to: Home (`/`), Blog (`/blog/`), Contact (`/#contact`).
- Scoped styles: Poppins font family, `#2980b9` accent color, dark mode via `prefers-color-scheme`.
- `noindex` meta tag — no reason to index a 404 page.

### Existing blog/404.astro

- Stays as-is. It only serves `/blog/404` direct visits; Astro's root `404.astro` handles actual missing routes site-wide.

---

## 3. Sitemap Cleanup

### Delete

- `public/sitemap.xml` — static file with only 3 hardcoded URLs (home, uses, blog). Outdated and conflicts with the auto-generated sitemap.

### Keep

- `@astrojs/sitemap` integration in `astro.config.mjs` — auto-generates a complete sitemap including all blog posts and the new tag/category pages.

### Update

- `public/robots.txt` — currently references both `sitemap.xml` and `blog/sitemap-index.xml`. Update to point only to the `@astrojs/sitemap`-generated `sitemap-index.xml` at the site root.

---

## 4. Asset Cleanup & Waves.js Replacement

### Files to Delete (unused — never loaded or no markup references them)

| File | Reason unused |
|------|--------------|
| `public/js/jquery.min.js` | No page loads it |
| `public/js/jquery.shuffle.min.js` | No page loads it |
| `public/js/smooth-scroll.min.js` | No page loads it |
| `public/js/validator.min.js` | No page loads it |
| `public/js/aos.js` | No page loads it; `script.js` handles `data-aos` natively via IntersectionObserver |
| `public/css/aos.css` | No page loads it; AOS styles already exist in `style.css` (lines 969-989) |
| `public/css/owl.carousel.css` | Loaded by index.astro and uses.astro but no owl-carousel markup exists in any page |

### Files to Delete and Replace

| File | Replacement |
|------|------------|
| `public/js/waves.min.js` | CSS-only ripple effect |
| `public/css/waves.min.css` | CSS-only ripple effect |

### CSS Ripple Implementation

Add to `public/css/style.css`:
- CSS `::after` pseudo-element on `.btn-custom` and `.menu li > a` (same selectors Waves targeted)
- `@keyframes ripple` animation (scale + fade out)
- Elements need `position: relative; overflow: hidden` to contain the ripple

Update `public/js/script.js`:
- Replace `initRipples()` function — instead of checking for `Waves` global, add click event listeners to ripple-target elements
- On click: create a `<span>` at click coordinates, apply ripple class, remove after animation completes (~600ms)

### Page Updates

| Page | Changes |
|------|---------|
| `index.astro` | Remove `<link>` for `owl.carousel.css` and `waves.min.css`, remove `<script>` for `waves.min.js` |
| `uses.astro` | Remove `<link>` for `owl.carousel.css` and `waves.min.css`, remove `<script>` for `waves.min.js` |
| `thank-you.astro` | Verify no dead references (currently only loads `script.js`) |

---

## Out of Scope

- Pagination on tag/category pages (not needed at current post volume)
- Tag cloud or related categories sidebar (can be added later)
- Dark mode toggle for main site pages (separate effort)
- jQuery full replacement (already done — `script.js` is vanilla)
- Blog search improvements (client-side search already exists on listing page)
