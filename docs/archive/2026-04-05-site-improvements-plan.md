# Site Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tag/category pages, site-wide 404, fix sitemap duplication, clean up dead assets, and replace Waves.js with CSS ripples.

**Architecture:** All work happens in `blog-src/`. New dynamic routes for tags and categories reuse the existing post card grid pattern. Dead JS/CSS files are removed, Waves.js is replaced with a CSS+vanilla JS ripple. Static sitemap is deleted in favor of auto-generated one.

**Tech Stack:** Astro 6.1.3, TypeScript, CSS, vanilla JS

**Spec:** `docs/superpowers/specs/2026-04-05-site-improvements-design.md`

---

### Task 1: Category Pages

**Files:**
- Create: `blog-src/src/pages/blog/category/[category].astro`

- [ ] **Step 1: Create the category page**

Create `blog-src/src/pages/blog/category/[category].astro`:

```astro
---
import type { GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import BlogLayout from '../../../layouts/BlogLayout.astro';
import { SITE_URL } from '../../../config';
import { getReadTime } from '../../../utils/readTime';

export const getStaticPaths = (async () => {
  const posts = await getCollection('posts');
  const categories = [...new Set(posts.map((p) => p.data.category))];
  return categories.map((category) => ({
    params: { category },
    props: {
      category,
      posts: posts
        .filter((p) => p.data.category === category)
        .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf()),
    },
  }));
}) satisfies GetStaticPaths;

const { category, posts } = Astro.props;
const displayName = category.replace(/-/g, ' ');
const siteUrl = SITE_URL;

const breadcrumbSchema = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": siteUrl },
    { "@type": "ListItem", "position": 2, "name": "Blog", "item": `${siteUrl}/blog/` },
    { "@type": "ListItem", "position": 3, "name": displayName, "item": `${siteUrl}/blog/category/${category}/` },
  ],
});
---

<BlogLayout
  title={`Category: ${displayName}`}
  description={`${posts.length} post${posts.length === 1 ? '' : 's'} in ${displayName}.`}
>
  <Fragment slot="head">
    <script type="application/ld+json" set:html={breadcrumbSchema} />
  </Fragment>
  <div class="listing-wrapper">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="breadcrumb-sep">/</span>
      <a href="/blog/">Blog</a>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">{displayName}</span>
    </nav>

    <h1>Category: <span class="taxonomy-name">{displayName}</span></h1>
    <p class="taxonomy-count">{posts.length} post{posts.length === 1 ? '' : 's'}</p>

    <div class="post-grid">
      {posts.map((post) => {
        const readTime = getReadTime(post.body);
        return (
          <a href={`/blog/${post.id}/`} class="post-card" data-category={post.data.category}>
            <div class="post-card-meta">
              <time datetime={post.data.date.toISOString()}>
                {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
              </time>
              <span class="dot-sep">&middot;</span>
              <span>{readTime} min read</span>
            </div>
            <h2>{post.data.title}</h2>
            <p>{post.data.excerpt}</p>
            <span class="category-badge">{post.data.category.replace(/-/g, ' ')}</span>
          </a>
        );
      })}
    </div>

    <div class="back-link">
      <a href="/blog/">&larr; All posts</a>
    </div>
  </div>
</BlogLayout>

<style>
  .listing-wrapper {
    max-width: 720px;
    margin: 0 auto;
  }

  @media (min-width: 768px) {
    .listing-wrapper { max-width: 900px; }
  }

  .breadcrumbs {
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    color: #9ca3af;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .breadcrumbs a {
    color: #6b7280;
    text-decoration: none;
    transition: color 0.2s;
  }

  .breadcrumbs a:hover { color: #2980b9; }

  .breadcrumb-sep { color: #d1d5db; }

  .breadcrumb-current {
    color: #374151;
    font-weight: 500;
    text-transform: capitalize;
  }

  h1 {
    font-family: 'Poppins', sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #111827;
    margin: 0 0 4px;
  }

  .taxonomy-name { text-transform: capitalize; }

  .taxonomy-count {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    color: #6b7280;
    margin-bottom: 32px;
  }

  .post-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
  }

  @media (min-width: 768px) {
    .post-grid { grid-template-columns: 1fr 1fr; }
  }

  .post-card {
    display: flex;
    flex-direction: column;
    padding: 24px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    text-decoration: none;
    transition: all 0.2s;
  }

  .post-card:hover {
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
    border-color: #d1d5db;
    transform: translateY(-2px);
  }

  .post-card h2 {
    font-family: 'Poppins', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: #111827;
    margin: 8px 0;
    line-height: 1.35;
    letter-spacing: -0.2px;
  }

  .post-card p {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    color: #6b7280;
    margin: 0;
    line-height: 1.6;
    flex: 1;
  }

  .post-card-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    color: #9ca3af;
    font-weight: 400;
  }

  .dot-sep { color: #d1d5db; }

  .category-badge {
    display: inline-block;
    margin-top: 14px;
    font-family: 'Poppins', sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: #2980b9;
    background: rgba(41, 128, 185, 0.08);
    padding: 4px 10px;
    border-radius: 100px;
    text-transform: capitalize;
    width: fit-content;
  }

  .back-link {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid #e5e7eb;
  }

  .back-link a {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    font-weight: 500;
    color: #2980b9;
    text-decoration: none;
  }

  .back-link a:hover { opacity: 0.7; }

  @media (prefers-color-scheme: dark) {
    h1 { color: #f1f5f9; }
    .taxonomy-count { color: #94a3b8; }
    .breadcrumbs a { color: #94a3b8; }
    .breadcrumbs a:hover { color: #60a5fa; }
    .breadcrumb-sep { color: #475569; }
    .breadcrumb-current { color: #e2e8f0; }
    .post-card { background: #1e293b; border-color: #334155; }
    .post-card:hover { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); border-color: #475569; }
    .post-card h2 { color: #f1f5f9; }
    .post-card p { color: #94a3b8; }
    .post-card-meta { color: #64748b; }
    .dot-sep { color: #475569; }
    .category-badge { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
    .back-link { border-top-color: #334155; }
    .back-link a { color: #60a5fa; }
  }
</style>
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes. New routes like `/blog/category/dev-session/` appear in output.

- [ ] **Step 3: Commit**

```bash
git add blog-src/src/pages/blog/category/
git commit -m "feat: add category pages with post grid and breadcrumb schema"
```

---

### Task 2: Tag Pages

**Files:**
- Create: `blog-src/src/pages/blog/tags/[tag].astro`

- [ ] **Step 1: Create the tag page**

Create `blog-src/src/pages/blog/tags/[tag].astro`:

```astro
---
import type { GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import BlogLayout from '../../../layouts/BlogLayout.astro';
import { SITE_URL } from '../../../config';
import { getReadTime } from '../../../utils/readTime';

export const getStaticPaths = (async () => {
  const posts = await getCollection('posts');
  const tagMap = new Map<string, typeof posts>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(post);
    }
  }
  return [...tagMap.entries()].map(([tag, tagPosts]) => ({
    params: { tag },
    props: {
      tag,
      posts: tagPosts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf()),
    },
  }));
}) satisfies GetStaticPaths;

const { tag, posts } = Astro.props;
const siteUrl = SITE_URL;

const breadcrumbSchema = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": siteUrl },
    { "@type": "ListItem", "position": 2, "name": "Blog", "item": `${siteUrl}/blog/` },
    { "@type": "ListItem", "position": 3, "name": `Tag: ${tag}`, "item": `${siteUrl}/blog/tags/${tag}/` },
  ],
});
---

<BlogLayout
  title={`Tag: ${tag}`}
  description={`${posts.length} post${posts.length === 1 ? '' : 's'} tagged "${tag}".`}
>
  <Fragment slot="head">
    <script type="application/ld+json" set:html={breadcrumbSchema} />
  </Fragment>
  <div class="listing-wrapper">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="breadcrumb-sep">/</span>
      <a href="/blog/">Blog</a>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">{tag}</span>
    </nav>

    <h1>Tag: <span class="taxonomy-name">{tag}</span></h1>
    <p class="taxonomy-count">{posts.length} post{posts.length === 1 ? '' : 's'}</p>

    <div class="post-grid">
      {posts.map((post) => {
        const readTime = getReadTime(post.body);
        return (
          <a href={`/blog/${post.id}/`} class="post-card" data-category={post.data.category}>
            <div class="post-card-meta">
              <time datetime={post.data.date.toISOString()}>
                {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
              </time>
              <span class="dot-sep">&middot;</span>
              <span>{readTime} min read</span>
            </div>
            <h2>{post.data.title}</h2>
            <p>{post.data.excerpt}</p>
            <div class="post-card-tags">
              {post.data.tags.map((t) => (
                <a href={`/blog/tags/${t}/`} class="tag-badge">{t}</a>
              ))}
            </div>
          </a>
        );
      })}
    </div>

    <div class="back-link">
      <a href="/blog/">&larr; All posts</a>
    </div>
  </div>
</BlogLayout>

<style>
  .listing-wrapper {
    max-width: 720px;
    margin: 0 auto;
  }

  @media (min-width: 768px) {
    .listing-wrapper { max-width: 900px; }
  }

  .breadcrumbs {
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    color: #9ca3af;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .breadcrumbs a {
    color: #6b7280;
    text-decoration: none;
    transition: color 0.2s;
  }

  .breadcrumbs a:hover { color: #2980b9; }
  .breadcrumb-sep { color: #d1d5db; }

  .breadcrumb-current {
    color: #374151;
    font-weight: 500;
  }

  h1 {
    font-family: 'Poppins', sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #111827;
    margin: 0 0 4px;
  }

  .taxonomy-name { color: #2980b9; }

  .taxonomy-count {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    color: #6b7280;
    margin-bottom: 32px;
  }

  .post-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
  }

  @media (min-width: 768px) {
    .post-grid { grid-template-columns: 1fr 1fr; }
  }

  .post-card {
    display: flex;
    flex-direction: column;
    padding: 24px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    text-decoration: none;
    transition: all 0.2s;
  }

  .post-card:hover {
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
    border-color: #d1d5db;
    transform: translateY(-2px);
  }

  .post-card h2 {
    font-family: 'Poppins', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: #111827;
    margin: 8px 0;
    line-height: 1.35;
    letter-spacing: -0.2px;
  }

  .post-card p {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    color: #6b7280;
    margin: 0;
    line-height: 1.6;
    flex: 1;
  }

  .post-card-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    color: #9ca3af;
    font-weight: 400;
  }

  .dot-sep { color: #d1d5db; }

  .post-card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 14px;
  }

  .tag-badge {
    font-family: 'Poppins', sans-serif;
    font-size: 11px;
    font-weight: 500;
    color: #2980b9;
    background: rgba(41, 128, 185, 0.08);
    padding: 3px 8px;
    border-radius: 100px;
    text-decoration: none;
    transition: all 0.2s;
  }

  .tag-badge:hover {
    background: rgba(41, 128, 185, 0.15);
  }

  .back-link {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid #e5e7eb;
  }

  .back-link a {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    font-weight: 500;
    color: #2980b9;
    text-decoration: none;
  }

  .back-link a:hover { opacity: 0.7; }

  @media (prefers-color-scheme: dark) {
    h1 { color: #f1f5f9; }
    .taxonomy-name { color: #60a5fa; }
    .taxonomy-count { color: #94a3b8; }
    .breadcrumbs a { color: #94a3b8; }
    .breadcrumbs a:hover { color: #60a5fa; }
    .breadcrumb-sep { color: #475569; }
    .breadcrumb-current { color: #e2e8f0; }
    .post-card { background: #1e293b; border-color: #334155; }
    .post-card:hover { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); border-color: #475569; }
    .post-card h2 { color: #f1f5f9; }
    .post-card p { color: #94a3b8; }
    .post-card-meta { color: #64748b; }
    .dot-sep { color: #475569; }
    .tag-badge { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
    .tag-badge:hover { background: rgba(96, 165, 250, 0.2); }
    .back-link { border-top-color: #334155; }
    .back-link a { color: #60a5fa; }
  }
</style>
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes. New routes like `/blog/tags/claude-code/` appear in output.

- [ ] **Step 3: Commit**

```bash
git add blog-src/src/pages/blog/tags/
git commit -m "feat: add tag pages with post grid and breadcrumb schema"
```

---

### Task 3: Link Tags on Post Pages

**Files:**
- Modify: `blog-src/src/pages/blog/[slug].astro:103-113` (blog meta section)

- [ ] **Step 1: Add tag links below the blog meta**

In `blog-src/src/pages/blog/[slug].astro`, find the blog meta section (around line 103-113). After the closing `</div>` of `.blog-meta`, add a tags section. Replace this block:

```astro
        <div class="blog-meta">
          <time datetime={post.data.date.toISOString()}>
            {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
          </time>
          <span class="dot-sep">&middot;</span>
          <span>{readTime} min read</span>
          <span class="dot-sep">&middot;</span>
          <span class="category">{post.data.category.replace(/-/g, ' ')}</span>
        </div>
```

With:

```astro
        <div class="blog-meta">
          <time datetime={post.data.date.toISOString()}>
            {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
          </time>
          <span class="dot-sep">&middot;</span>
          <span>{readTime} min read</span>
          <span class="dot-sep">&middot;</span>
          <a href={`/blog/category/${post.data.category}/`} class="category">{post.data.category.replace(/-/g, ' ')}</a>
        </div>
        <div class="post-tags">
          {post.data.tags.map((tag) => (
            <a href={`/blog/tags/${tag}/`} class="tag-link">{tag}</a>
          ))}
        </div>
```

- [ ] **Step 2: Add styles for the tag links**

In the same file's `<style>` block, before the `/* Dark mode */` comment, add:

```css
  /* Post tags */
  .post-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
    margin-bottom: 24px;
  }

  .tag-link {
    font-family: 'Poppins', sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: #2980b9;
    background: rgba(41, 128, 185, 0.08);
    padding: 4px 12px;
    border-radius: 100px;
    text-decoration: none;
    transition: all 0.2s;
  }

  .tag-link:hover {
    background: rgba(41, 128, 185, 0.15);
  }
```

And inside the `@media (prefers-color-scheme: dark)` block, add:

```css
    .tag-link { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
    .tag-link:hover { background: rgba(96, 165, 250, 0.2); }
```

- [ ] **Step 3: Make the category in blog meta a link**

In the same file's `<style>` block, find any `.category` styles. The `.category` span is inside `.blog-meta` — since it's now an `<a>` tag, ensure it has proper link styling. Add to the existing styles (before dark mode):

```css
  .blog-meta .category {
    color: #6b7280;
    text-decoration: none;
    text-transform: capitalize;
    transition: color 0.2s;
  }

  .blog-meta .category:hover {
    color: #2980b9;
  }
```

And in dark mode:

```css
    .blog-meta .category { color: #94a3b8; }
    .blog-meta .category:hover { color: #60a5fa; }
```

- [ ] **Step 4: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add blog-src/src/pages/blog/\[slug\].astro
git commit -m "feat: add clickable tag and category links on blog posts"
```

---

### Task 4: Link Category Badges on Blog Listing

**Files:**
- Modify: `blog-src/src/pages/blog/[...page].astro:54` (category badge) and `blog-src/src/pages/blog/[...page].astro:64` (category badge in card)

- [ ] **Step 1: Make category badges link to category pages**

In `blog-src/src/pages/blog/[...page].astro`, find the post card template (around line 54). The category badge at line 64 is currently a `<span>`. Change it to a link. Find:

```astro
            <span class="category-badge">{post.data.category.replace(/-/g, ' ')}</span>
```

Replace with:

```astro
            <a href={`/blog/category/${post.data.category}/`} class="category-badge" onclick="event.stopPropagation();">{post.data.category.replace(/-/g, ' ')}</a>
```

Note: `event.stopPropagation()` prevents the parent `<a>` card's click from interfering since the card itself is a link.

- [ ] **Step 2: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add blog-src/src/pages/blog/\[...page\].astro
git commit -m "feat: link category badges to category pages on blog listing"
```

---

### Task 5: Site-wide 404 Page

**Files:**
- Create: `blog-src/src/pages/404.astro`

- [ ] **Step 1: Create the 404 page**

Create `blog-src/src/pages/404.astro`:

```astro
---
import SiteLayout from '../layouts/SiteLayout.astro';
---

<SiteLayout title="404 - Page Not Found" description="The page you're looking for doesn't exist.">
  <Fragment slot="head">
    <meta name="robots" content="noindex" />
    <link rel="preload" href="/css/fonts.css" as="style" />
    <link rel="stylesheet" type="text/css" href="/css/fonts.css" />
    <link rel="stylesheet" type="text/css" href="/css/style.css" />
  </Fragment>
  <div class="not-found">
    <h1>404</h1>
    <p class="not-found-message">Page not found</p>
    <p class="not-found-description">The page you're looking for doesn't exist or has been moved.</p>
    <div class="not-found-links">
      <a href="/">Home</a>
      <a href="/blog/">Blog</a>
      <a href="/#contact">Contact</a>
    </div>
  </div>
</SiteLayout>

<style>
  .not-found {
    text-align: center;
    padding: 120px 20px;
    min-height: 80vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .not-found h1 {
    font-family: 'Poppins', sans-serif;
    font-size: 96px;
    font-weight: 700;
    color: #d1d5db;
    margin: 0;
    line-height: 1;
  }

  .not-found-message {
    font-family: 'Poppins', sans-serif;
    font-size: 24px;
    font-weight: 600;
    color: #374151;
    margin: 16px 0 8px;
  }

  .not-found-description {
    font-family: 'Poppins', sans-serif;
    font-size: 16px;
    color: #6b7280;
    margin: 0 0 40px;
  }

  .not-found-links {
    display: flex;
    gap: 16px;
  }

  .not-found-links a {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    font-weight: 600;
    color: #2980b9;
    text-decoration: none;
    padding: 10px 24px;
    border: 2px solid #2980b9;
    border-radius: 8px;
    transition: all 0.2s;
  }

  .not-found-links a:hover {
    background: #2980b9;
    color: #fff;
  }

  @media (prefers-color-scheme: dark) {
    .not-found h1 { color: #334155; }
    .not-found-message { color: #e2e8f0; }
    .not-found-description { color: #94a3b8; }
    .not-found-links a { color: #60a5fa; border-color: #60a5fa; }
    .not-found-links a:hover { background: #1a5276; border-color: #1a5276; color: #fff; }
  }
</style>
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes. A `404.html` appears in the output directory.

- [ ] **Step 3: Commit**

```bash
git add blog-src/src/pages/404.astro
git commit -m "feat: add site-wide 404 page with main site styling"
```

---

### Task 6: Sitemap Cleanup

**Files:**
- Delete: `blog-src/public/sitemap.xml`
- Modify: `blog-src/public/robots.txt`

- [ ] **Step 1: Delete the static sitemap**

```bash
rm blog-src/public/sitemap.xml
```

- [ ] **Step 2: Update robots.txt**

Replace the contents of `blog-src/public/robots.txt` with:

```
User-agent: *
Allow: /

Sitemap: https://michaellaplante.com/sitemap-index.xml
```

This points to the `@astrojs/sitemap`-generated sitemap index, which includes all pages (including the new tag/category pages).

- [ ] **Step 3: Verify the build generates sitemaps correctly**

Run: `cd blog-src && npm run build 2>&1 | grep -i sitemap`
Expected: Output shows sitemap generation. Check that `../dist/sitemap-index.xml` exists after build.

Run: `cat ../dist/sitemap-index.xml 2>/dev/null | head -10`
Expected: XML sitemap index referencing sitemap-0.xml (or similar).

- [ ] **Step 4: Commit**

```bash
git add -u blog-src/public/sitemap.xml blog-src/public/robots.txt
git commit -m "fix: remove static sitemap, update robots.txt to use auto-generated sitemap"
```

---

### Task 7: Remove Dead JS/CSS Files

**Files:**
- Delete: `blog-src/public/js/jquery.min.js`
- Delete: `blog-src/public/js/jquery.shuffle.min.js`
- Delete: `blog-src/public/js/smooth-scroll.min.js`
- Delete: `blog-src/public/js/validator.min.js`
- Delete: `blog-src/public/js/aos.js`
- Delete: `blog-src/public/css/aos.css`
- Delete: `blog-src/public/css/owl.carousel.css`
- Modify: `blog-src/src/pages/index.astro:85` (remove owl.carousel.css link)
- Modify: `blog-src/src/pages/uses.astro:33` (remove owl.carousel.css link)

- [ ] **Step 1: Delete unused JS files**

```bash
rm blog-src/public/js/jquery.min.js blog-src/public/js/jquery.shuffle.min.js blog-src/public/js/smooth-scroll.min.js blog-src/public/js/validator.min.js blog-src/public/js/aos.js
```

- [ ] **Step 2: Delete unused CSS files**

```bash
rm blog-src/public/css/aos.css blog-src/public/css/owl.carousel.css
```

- [ ] **Step 3: Remove owl.carousel.css link from index.astro**

In `blog-src/src/pages/index.astro`, find and remove this line (around line 85):

```html
    <link rel="stylesheet" type="text/css" href="/css/owl.carousel.css">
```

- [ ] **Step 4: Remove owl.carousel.css link from uses.astro**

In `blog-src/src/pages/uses.astro`, find and remove this line (around line 33):

```html
    <link rel="stylesheet" type="text/css" href="/css/owl.carousel.css">
```

- [ ] **Step 5: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes without errors. No warnings about missing files.

- [ ] **Step 6: Commit**

```bash
git add -u blog-src/public/js/ blog-src/public/css/ blog-src/src/pages/index.astro blog-src/src/pages/uses.astro
git commit -m "cleanup: remove unused jQuery, AOS, Owl Carousel, and other dead assets"
```

---

### Task 8: Replace Waves.js with CSS Ripple

**Files:**
- Delete: `blog-src/public/js/waves.min.js`
- Delete: `blog-src/public/css/waves.min.css`
- Modify: `blog-src/public/css/style.css` (add ripple CSS)
- Modify: `blog-src/public/js/script.js:163-168` (replace initRipples function)
- Modify: `blog-src/src/pages/index.astro:84,625` (remove waves refs)
- Modify: `blog-src/src/pages/uses.astro:32,256` (remove waves refs)

- [ ] **Step 1: Add CSS ripple styles to style.css**

In `blog-src/public/css/style.css`, at the end of the file (before any final closing bracket), add:

```css
/*========================================
  CSS Ripple Effect (replaces Waves.js)
==========================================*/
.ripple-target {
  position: relative;
  overflow: hidden;
}

.ripple-target .ripple {
  position: absolute;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  transform: scale(0);
  animation: ripple-effect 0.6s ease-out;
  pointer-events: none;
}

@keyframes ripple-effect {
  to {
    transform: scale(4);
    opacity: 0;
  }
}
```

- [ ] **Step 2: Replace initRipples in script.js**

In `blog-src/public/js/script.js`, replace the entire `initRipples` function (lines 163-168):

Find:

```javascript
	function initRipples() {
		if (typeof Waves !== 'undefined') {
			Waves.attach('.btn-custom, .menu li > a', 'waves-classic');
			Waves.init();
		}
	}
```

Replace with:

```javascript
	function initRipples() {
		var targets = document.querySelectorAll('.btn-custom, .menu li > a');
		targets.forEach(function(el) {
			el.classList.add('ripple-target');
			el.addEventListener('click', function(e) {
				var rect = el.getBoundingClientRect();
				var ripple = document.createElement('span');
				ripple.classList.add('ripple');
				var size = Math.max(rect.width, rect.height);
				ripple.style.width = ripple.style.height = size + 'px';
				ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
				ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
				el.appendChild(ripple);
				ripple.addEventListener('animationend', function() {
					ripple.remove();
				});
			});
		});
	}
```

- [ ] **Step 3: Delete Waves files**

```bash
rm blog-src/public/js/waves.min.js blog-src/public/css/waves.min.css
```

- [ ] **Step 4: Remove Waves references from index.astro**

In `blog-src/src/pages/index.astro`, remove these two lines:

Line ~84 (CSS):
```html
    <link rel="stylesheet" type="text/css" href="/css/waves.min.css">
```

Line ~625 (JS):
```html
  <script is:inline defer src="/js/waves.min.js"></script>
```

- [ ] **Step 5: Remove Waves references from uses.astro**

In `blog-src/src/pages/uses.astro`, remove these two lines:

Line ~32 (CSS):
```html
    <link rel="stylesheet" type="text/css" href="/css/waves.min.css">
```

Line ~256 (JS):
```html
  <script is:inline src="/js/waves.min.js"></script>
```

- [ ] **Step 6: Verify the build succeeds**

Run: `cd blog-src && npm run build 2>&1 | tail -20`
Expected: Build completes without errors.

- [ ] **Step 7: Commit**

```bash
git add -u blog-src/public/js/ blog-src/public/css/ blog-src/src/pages/index.astro blog-src/src/pages/uses.astro
git add blog-src/public/css/style.css blog-src/public/js/script.js
git commit -m "feat: replace Waves.js with CSS-only ripple effect"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Full build**

Run: `cd blog-src && npm run build 2>&1 | tail -30`
Expected: Clean build with no errors or warnings.

- [ ] **Step 2: Verify generated routes**

Run: `ls ../dist/blog/category/ 2>/dev/null`
Expected: Directories for each category (e.g., `ai-security/`, `cloud-security/`, `dev-session/`).

Run: `ls ../dist/blog/tags/ 2>/dev/null | head -20`
Expected: Directories for each tag (e.g., `claude-code/`, `git/`, `security/`).

Run: `ls ../dist/404.html 2>/dev/null`
Expected: File exists.

Run: `cat ../dist/robots.txt`
Expected: Points to `sitemap-index.xml` only (no `sitemap.xml` or `blog/sitemap-index.xml`).

- [ ] **Step 3: Verify no dead asset references remain**

Run: `grep -r 'waves\|owl.carousel\|jquery\|aos\.js\|aos\.css' blog-src/src/pages/ 2>/dev/null`
Expected: No matches (all references removed).

- [ ] **Step 4: Verify sitemap includes new pages**

Run: `cat ../dist/sitemap-0.xml 2>/dev/null | grep -c 'category\|tags'`
Expected: Non-zero count — tag and category pages are in the sitemap.
