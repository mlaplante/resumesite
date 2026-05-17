# Blog Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the blog listing page as a 2-column card grid and add a sticky TOC sidebar to article detail pages, inspired by savvycal.com/articles/.

**Architecture:** Update three Astro files (listing page, detail page, shared CSS) and widen the BlogLayout max-width to accommodate the TOC sidebar. All changes are CSS/HTML — no new dependencies. TOC is generated client-side from heading elements.

**Tech Stack:** Astro 6, CSS (no preprocessor), vanilla JS for TOC generation and scroll-spy

---

### Task 1: Widen BlogLayout for TOC Sidebar

**Files:**
- Modify: `blog-src/src/styles/blog.css:49-54` (`.blog-content` rule)
- Modify: `blog-src/src/layouts/BlogLayout.astro:73-75` (content wrapper)

**Step 1: Update blog.css — widen max-width and adjust content area**

In `blog-src/src/styles/blog.css`, change `.blog-content` max-width from `720px` to `1080px` to accommodate the article + TOC side-by-side. The individual pages will constrain their own content widths.

```css
/* ===== Content Area ===== */
.blog-content {
  max-width: 1080px;
  margin: 0 auto;
  padding: 48px 20px 80px;
}
```

**Step 2: Commit**

```bash
git add blog-src/src/styles/blog.css
git commit -m "feat: widen blog content area for TOC sidebar layout"
```

---

### Task 2: Redesign Listing Page — 2-Column Grid with Simplified Cards

**Files:**
- Modify: `blog-src/src/pages/index.astro` (entire file — template + styles + script)

**Step 1: Replace the listing page template**

Replace the post-list section and card markup. Key changes:
- Cards go in a 2-column CSS grid
- Remove tags from cards
- Add read time calculation per post
- Simplify card structure: date, category, title, excerpt, read time

```astro
---
import { getCollection } from 'astro:content';
import BlogLayout from '../layouts/BlogLayout.astro';

const posts = (await getCollection('posts')).sort(
  (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
);

const categories = ['all', ...new Set(posts.map((p) => p.data.category))];
---

<BlogLayout title="Blog" description="Thoughts on security, engineering, and building things.">
  <div class="listing-wrapper">
    <h1>Blog</h1>
    <p class="blog-subtitle">Thoughts on security, engineering, and building things.</p>

    <div class="search-box">
      <input type="text" id="blog-search" placeholder="Search posts..." autocomplete="off" />
    </div>

    <div class="category-filter">
      {categories.map((cat) => (
        <button class="filter-btn" data-category={cat}>
          {cat === 'all' ? 'All' : cat.replace(/-/g, ' ')}
        </button>
      ))}
    </div>

    {posts.length === 0 && <p class="no-posts">No posts yet. Check back soon.</p>}

    <div class="post-grid">
      {posts.map((post) => {
        const wordCount = post.body?.split(/\s+/).length ?? 0;
        const readTime = Math.max(1, Math.ceil(wordCount / 250));
        return (
          <a href={`${import.meta.env.BASE_URL}/${post.id}/`} class="post-card" data-category={post.data.category}>
            <div class="post-card-meta">
              <time datetime={post.data.date.toISOString()}>
                {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
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
  </div>
</BlogLayout>
```

**Step 2: Replace the styles block**

```css
<style>
  .listing-wrapper {
    max-width: 720px;
    margin: 0 auto;
  }

  @media (min-width: 768px) {
    .listing-wrapper {
      max-width: 900px;
    }
  }

  .blog-subtitle {
    font-family: 'Poppins', sans-serif;
    font-size: 16px;
    color: #6b7280;
    margin-bottom: 32px;
    font-weight: 400;
  }

  .search-box {
    margin-bottom: 20px;
  }

  #blog-search {
    width: 100%;
    padding: 12px 16px;
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    color: #1a1a1a;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  #blog-search::placeholder {
    color: #9ca3af;
  }

  #blog-search:focus {
    border-color: #2980b9;
    box-shadow: 0 0 0 3px rgba(41, 128, 185, 0.1);
  }

  .category-filter {
    display: flex;
    gap: 8px;
    margin-bottom: 32px;
    flex-wrap: wrap;
  }

  .filter-btn {
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 16px;
    border: 1px solid #e5e7eb;
    border-radius: 100px;
    background: transparent;
    cursor: pointer;
    color: #6b7280;
    transition: all 0.2s;
    text-transform: capitalize;
  }

  .filter-btn:hover {
    border-color: #2980b9;
    color: #2980b9;
  }

  .filter-btn.active {
    background: #2980b9;
    color: #fff;
    border-color: #2980b9;
  }

  .post-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
  }

  @media (min-width: 768px) {
    .post-grid {
      grid-template-columns: 1fr 1fr;
    }
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

  .dot-sep {
    color: #d1d5db;
  }

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

  .no-posts {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    color: #9ca3af;
    text-align: center;
    padding: 60px 0;
    grid-column: 1 / -1;
  }

  /* Dark mode */
  @media (prefers-color-scheme: dark) {
    #blog-search { border-color: #334155; color: #f1f5f9; background: #1e293b; }
    #blog-search::placeholder { color: #64748b; }
    #blog-search:focus { border-color: #1a5276; box-shadow: 0 0 0 3px rgba(26, 82, 118, 0.2); }
    .blog-subtitle { color: #94a3b8; }
    .filter-btn { border-color: #334155; color: #94a3b8; }
    .filter-btn:hover { border-color: #1a5276; color: #60a5fa; }
    .filter-btn.active { background: #1a5276; border-color: #1a5276; color: #fff; }
    .post-card { background: #1e293b; border-color: #334155; }
    .post-card:hover { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); border-color: #475569; }
    .post-card h2 { color: #f1f5f9; }
    .post-card p { color: #94a3b8; }
    .post-card-meta { color: #64748b; }
    .dot-sep { color: #475569; }
    .category-badge { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
    .no-posts { color: #64748b; }
  }
</style>
```

**Step 3: Keep the existing script block** (category filter + search logic — same functionality, just update the selector from `.post-card` to `.post-card` within `.post-grid`)

The existing script block works as-is since it queries `.filter-btn` and `.post-card` selectors which remain the same.

**Step 4: Commit**

```bash
git add blog-src/src/pages/index.astro
git commit -m "feat: redesign blog listing as 2-column grid with simplified cards"
```

---

### Task 3: Redesign Article Detail Page with TOC Sidebar

**Files:**
- Modify: `blog-src/src/pages/[slug].astro` (entire file — add TOC sidebar + scroll-spy)

**Step 1: Replace the article detail page**

Key changes:
- Wrap article + TOC in a 2-column flexbox layout
- Add a `<aside>` for TOC that gets populated client-side from h2/h3 headings
- Add scroll-spy JS to highlight current heading in TOC
- On mobile, TOC sits above the article

```astro
---
import { getCollection, render } from 'astro:content';
import BlogLayout from '../layouts/BlogLayout.astro';

export async function getStaticPaths() {
  const posts = await getCollection('posts');
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}

const { post } = Astro.props;
const { Content } = await render(post);

const wordCount = post.body?.split(/\s+/).length ?? 0;
const readTime = Math.max(1, Math.ceil(wordCount / 250));
---

<BlogLayout title={post.data.title} description={post.data.excerpt} ogType="article">
  <div class="article-layout">
    <div class="article-main">
      <article>
        <h1>{post.data.title}</h1>
        <div class="blog-meta">
          <time datetime={post.data.date.toISOString()}>
            {post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </time>
          <span class="dot-sep">&middot;</span>
          <span>{readTime} min read</span>
          <span class="dot-sep">&middot;</span>
          <span class="category">{post.data.category.replace(/-/g, ' ')}</span>
        </div>
        <Content />
      </article>
      <div class="blog-footer">
        <a href={import.meta.env.BASE_URL}>&larr; Back to all posts</a>
      </div>
    </div>
    <aside class="toc-sidebar">
      <div class="toc-container">
        <h2 class="toc-title">Table of Contents</h2>
        <nav class="toc-nav" id="toc-nav"></nav>
      </div>
    </aside>
  </div>
</BlogLayout>

<style>
  .article-layout {
    display: flex;
    gap: 48px;
    align-items: flex-start;
  }

  .article-main {
    flex: 1;
    min-width: 0;
    max-width: 680px;
  }

  .toc-sidebar {
    display: none;
    width: 260px;
    flex-shrink: 0;
  }

  @media (min-width: 960px) {
    .toc-sidebar {
      display: block;
    }
  }

  .toc-container {
    position: sticky;
    top: 80px;
  }

  .toc-title {
    font-family: 'Poppins', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    margin: 0 0 16px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border: none;
    padding: 0;
  }

  .toc-nav :global(a) {
    display: block;
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    color: #6b7280;
    text-decoration: none;
    padding: 4px 0 4px 12px;
    border-left: 2px solid #e5e7eb;
    line-height: 1.5;
    transition: all 0.2s;
  }

  .toc-nav :global(a:hover) {
    color: #2980b9;
  }

  .toc-nav :global(a.active) {
    color: #2980b9;
    border-left-color: #2980b9;
    font-weight: 500;
  }

  .toc-nav :global(a.toc-h3) {
    padding-left: 24px;
    font-size: 12px;
  }

  .blog-meta .dot-sep {
    color: #d1d5db;
  }

  /* Dark mode */
  @media (prefers-color-scheme: dark) {
    .toc-title { color: #e2e8f0; }
    .toc-nav :global(a) { color: #94a3b8; border-left-color: #334155; }
    .toc-nav :global(a:hover) { color: #60a5fa; }
    .toc-nav :global(a.active) { color: #60a5fa; border-left-color: #60a5fa; }
    .blog-meta .dot-sep { color: #475569; }
  }
</style>

<script>
  // Generate TOC from article headings
  function buildTOC() {
    const article = document.querySelector('.article-main article');
    const tocNav = document.getElementById('toc-nav');
    if (!article || !tocNav) return;

    const headings = article.querySelectorAll('h2, h3');
    if (headings.length === 0) {
      const sidebar = document.querySelector('.toc-sidebar') as HTMLElement;
      if (sidebar) sidebar.style.display = 'none';
      return;
    }

    headings.forEach((heading, i) => {
      // Ensure heading has an id for linking
      if (!heading.id) {
        heading.id = `heading-${i}`;
      }

      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent || '';
      if (heading.tagName === 'H3') {
        link.classList.add('toc-h3');
      }
      tocNav.appendChild(link);
    });

    // Scroll-spy: highlight current section
    const tocLinks = tocNav.querySelectorAll('a');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            tocLinks.forEach((link) => {
              link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
            });
          }
        });
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    headings.forEach((heading) => observer.observe(heading));
  }

  buildTOC();
</script>
```

**Step 2: Commit**

```bash
git add blog-src/src/pages/[slug].astro
git commit -m "feat: add 2-column article layout with sticky TOC sidebar"
```

---

### Task 4: Update Shared Blog CSS for Cleaner Typography

**Files:**
- Modify: `blog-src/src/styles/blog.css`

**Step 1: Update article heading styles**

Remove the h2 bottom border, refine spacing and typography to be cleaner:

- `.blog-content article h2`: remove `border-bottom` and `padding-bottom`, keep the rest
- `.blog-meta`: switch from Roboto Mono to Poppins for consistency, add `.dot-sep` styles
- `.blog-content article h2` dark mode: remove `border-bottom-color`

In `blog.css`, replace the article h2 rule:

```css
.blog-content article h2 {
  font-size: 26px;
  font-weight: 700;
  margin-top: 48px;
  margin-bottom: 16px;
  color: #1a1a1a;
  letter-spacing: -0.3px;
}
```

Update `.blog-meta`:

```css
.blog-meta {
  font-family: 'Poppins', sans-serif;
  font-size: 14px;
  color: #6b7280;
  margin-bottom: 32px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.blog-meta .category {
  background: rgba(41, 128, 185, 0.08);
  color: #2980b9;
  padding: 3px 10px;
  border-radius: 100px;
  font-size: 12px;
  text-transform: capitalize;
  font-weight: 500;
}
```

In the dark mode section, update h2 dark (remove border-bottom-color line) and category:

```css
.blog-content article h2 {
  color: #e2e8f0;
}

.blog-meta .category {
  background: rgba(96, 165, 250, 0.1);
  color: #60a5fa;
}
```

**Step 2: Commit**

```bash
git add blog-src/src/styles/blog.css
git commit -m "feat: clean up blog typography — remove h2 borders, refine meta styles"
```

---

### Task 5: Build and Verify

**Step 1: Run the Astro build**

```bash
cd /Users/mlaplante/Sites/resumesite && npm run build:blog
```

Expected: Clean build with no errors.

**Step 2: Visual verification**

Open `http://localhost:8765/blog/` in browser and check:
- [ ] 2-column grid on desktop, 1-column on mobile
- [ ] Cards show date, read time, title, excerpt, category badge
- [ ] Category filter pills work
- [ ] Search works
- [ ] Dark mode looks correct

Open an article page and check:
- [ ] Article content on left, TOC sidebar on right
- [ ] TOC populates from headings
- [ ] TOC is sticky when scrolling
- [ ] Scroll-spy highlights current heading
- [ ] TOC hidden on mobile
- [ ] Dark mode looks correct

**Step 3: Commit build output**

```bash
git add blog/
git commit -m "build: regenerate blog with redesigned layout"
```

---

### Task 6: Final Polish Pass

After visual review, fix any spacing, color, or alignment issues discovered during verification. This is a visual task — compare against the SavvyCal reference and adjust.

Common things to check:
- Card padding and spacing feel balanced
- Typography hierarchy is clear
- TOC doesn't overlap content at any viewport width
- Category badge colors are consistent between listing and detail pages
- Hover states feel smooth

**Commit any fixes:**

```bash
git add -A
git commit -m "fix: polish blog redesign spacing and alignment"
```
