---
title: "Building a Blog Subsection in One Session with Astro and Claude"
date: 2026-03-22
category: "dev-session"
tags: ["astro", "static-site", "ai-assisted", "blog"]
excerpt: "How I went from zero to a fully functional blog subsection — designed, built, and styled — in a single AI-assisted development session."
---

I've had a resume site running for years — plain HTML, CSS, Bootstrap, deployed via FTP to shared hosting. No build tools, no frameworks. It works. But I wanted a blog, and I wanted it to feel native to the existing site without rewriting everything.

Here's how I built it in a single session using Astro and Claude Code.

## The Constraint: FTP Deployment

The biggest design constraint was deployment. My hosting is traditional shared hosting with FTP. No Netlify builds, no Vercel edge functions. Whatever I built needed to output plain static HTML files that I could drop into a `/blog` directory alongside my existing site.

This ruled out most "just add a blog" solutions. I needed a static site generator that could output to a subdirectory with the right base path, and whose output was completely self-contained.

## Why Astro

Astro was the right fit for a few reasons:

- **Zero JavaScript by default** — the output is pure HTML and CSS, just like my existing site
- **Markdown content collections** — write posts in Markdown, get type-safe frontmatter validation
- **Configurable output directory** — `outDir: '../blog'` puts the built files exactly where I need them

The key config ended up being surprisingly simple:

```javascript
export default defineConfig({
  outDir: '../blog',
  base: '/blog',
  output: 'static',
  build: { format: 'directory' },
});
```

The `base: '/blog'` setting ensures all internal links are prefixed correctly, so the blog works as a subsection of the main site without any routing tricks.

## Architecture: Source vs. Output

I structured the project with a clear separation:

- `blog-src/` — the Astro project (source code, templates, content)
- `blog/` — the built output (static HTML, deployed via FTP)

The source lives in the repo but never gets deployed. Only the `blog/` output goes to the server. This keeps the deployment story identical to the rest of the site — just FTP the files.

## Content Collections with a Drafts Workflow

Astro's content collections gave me a clean way to manage posts with validated frontmatter:

```
blog-src/src/content/
  posts/     ← published, included in builds
  drafts/    ← work-in-progress, excluded from builds
```

Each post has typed frontmatter — title, date, category, tags, excerpt — which Astro validates at build time. No more silent failures from a misspelled field.

## Matching the Existing Design

The trickiest part was making the blog feel like it belongs on the same site. I pulled in the same Bootstrap version, the same font stack, and wrote custom CSS that mirrors the resume site's color palette and spacing.

One gotcha: Astro scopes styles to individual components by default. My `blog.css` wasn't applying to child components until I added the `is:global` directive to the layout's style tag. Small thing, but it would have been a frustrating debug without knowing Astro's scoping model.

## Dark Mode

The resume site supports `prefers-color-scheme`, so the blog needed to as well. I built the dark mode using a slate color palette that provides good contrast without feeling like a different site. The code syntax highlighting uses Shiki's `github-light` and `github-dark` themes, which switch automatically.

## Auto-Generation Pipeline

The most interesting part of the setup is the draft generation pipeline. I built a `/blog-draft` skill for Claude Code that can summarize a development session and produce a Markdown draft with proper frontmatter. There's also a standalone Node.js script (`scripts/generate-post.js`) that calls the Claude API directly for topic-based generation.

The workflow is intentionally semi-automated: AI generates drafts, but nothing gets published without human review. Drafts land in the `drafts/` directory, and I manually move them to `posts/` when they're ready.

## What I Learned

**Astro is excellent for bolt-on subsections.** The ability to set a custom `outDir` and `base` path means you can add Astro to any existing site without touching the original files.

**FTP deployment isn't a limitation if your build output is clean.** Static site generators that produce directory-based output work perfectly with traditional hosting.

**AI-assisted development changes the economics of side projects.** This entire blog — architecture design, implementation, styling, dark mode, content pipeline — came together in one session. The cost of adding features to personal projects has dropped dramatically.

The blog is live at [/blog](/blog). More posts to come.
