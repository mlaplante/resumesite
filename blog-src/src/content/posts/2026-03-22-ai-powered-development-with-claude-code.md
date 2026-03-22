---
title: "What Happens When You Let AI Drive Your Dev Workflow for a Day"
date: 2026-03-22
category: "dev-session"
tags: ["claude-code", "ai-development", "astro", "github-actions", "automation"]
excerpt: "I spent a Saturday building a blog, automating deployments, fixing dark mode bugs, and writing this post — all through conversation with Claude Code."
---

I've been using Claude Code as my primary development tool for a few weeks now, and today was the kind of session that shows what AI-assisted development actually looks like in practice. Not the polished demo version — the real, messy, iterative version where things break and you fix them in real time.

Here's everything that happened in a single Saturday afternoon.

## Building a Blog From Scratch

My portfolio site at [michaellaplante.com](https://michaellaplante.com) has been a static HTML site for years. I wanted to add a blog without migrating the whole thing to a framework. The constraint: it deploys via FTP to shared hosting. No serverless functions, no SSR.

Claude and I landed on Astro as a static site generator for just the `/blog` subsection. The main site stays as-is — plain HTML, CSS, jQuery. The blog builds separately into a `blog/` directory that gets deployed alongside everything else.

In about 30 minutes we had:
- An Astro project scaffolded in `blog-src/`
- Content collections with typed frontmatter
- A listing page with category filtering
- Individual post pages with estimated read time
- Styling that matches the existing resume site's aesthetic
- Dark mode support

We also built a draft generation system using the Claude API — a Node.js script that can generate blog post drafts from git history or arbitrary topics. There's even a Claude Code skill (`/blog-draft`) that generates drafts from the current conversation session. Meta? Yes. Useful? Also yes.

## Replacing DeployHQ with GitHub Actions

My site was using DeployHQ for FTP deployments. The free plan was limiting — restricted builds per day, limited build steps. Since I'm already on GitHub, we switched to GitHub Actions with the `SamKirkland/FTP-Deploy-Action`.

This took three commits to get right:

1. **First attempt** — used `@v4` as the version tag. GitHub couldn't resolve it. Had to use the exact version `@v4.3.6`.
2. **Second attempt** — Astro 6 requires Node.js 22+, but we had `node-version: 20`. Clear error message, easy fix.
3. **Third attempt** — clean build, successful FTP deploy in 20 seconds.

Then we optimized it further:

```yaml
- name: Check for blog changes
  id: blog-changes
  run: |
    if git diff --name-only HEAD~1 HEAD | grep -q '^blog-src/'; then
      echo "changed=true" >> "$GITHUB_OUTPUT"
    else
      echo "changed=false" >> "$GITHUB_OUTPUT"
    fi
```

Now the workflow skips the entire Node.js setup and Astro build when only portfolio files change. Non-blog deploys are just checkout + FTP upload.

## The Dark Mode Menu Bug

This was the most interesting debugging session. The mobile menu flyout was showing white-on-white text in dark mode. Sounds simple, but the root cause was non-obvious.

The menu uses a CSS `::after` pseudo-element as its background — a 960x960px circle with `border-radius: 50%` that scales from 0 to 1 when the menu opens, creating an expanding circle animation. The `.menu` element has `overflow: hidden`, which clips the circle into a rectangle.

The dark mode CSS was setting `background` on `.menu` itself, but the actual visible background was the `::after` pseudo-element sitting behind it (with `z-index: -1`). In light mode, `.menu` has `background: transparent`, so the white circle shows through. We needed to theme the pseudo-element directly:

```css
body.dark-mode .menu:after {
  background: #1a1a1a !important;
}
```

A good reminder that when debugging visual issues, the element you *see* isn't always the element you need to *style*.

## The AI Development Loop

What struck me about this session wasn't any individual task — it was the rhythm. The workflow looked like:

1. Describe what I want
2. Claude writes the code
3. I review and approve
4. If something breaks, share a screenshot or error
5. Claude diagnoses and fixes
6. Repeat

The dark mode bug is a perfect example. I said "the menu is white on white," shared a screenshot, and Claude traced it through the CSS cascade to find the pseudo-element issue. No Stack Overflow, no DevTools spelunking on my part. Just a conversation.

Is it perfect? No. The FTP action version tag thing cost an extra commit. The first dark mode fix didn't fully work. But the feedback loop is so fast that iteration is essentially free.

## What Shipped

By the end of the afternoon:
- A full Astro blog subsection with three published posts
- AI-powered draft generation via Claude API
- Automated FTP deployments via GitHub Actions (replacing a paid service)
- Dark mode menu bug fixed
- Updated project README documenting everything

All through conversation. All committed, pushed, and deployed automatically.

That's the thing about AI-assisted development that's hard to convey until you experience it — it's not that each individual task is impossible without AI. It's that the aggregate throughput of a focused afternoon becomes unreasonable.
