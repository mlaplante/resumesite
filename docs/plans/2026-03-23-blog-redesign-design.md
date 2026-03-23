# Blog Redesign — SavvyCal-Inspired Clean Layout

**Date**: 2026-03-23
**Status**: Approved
**Reference**: https://savvycal.com/articles/

## Overview

Redesign the blog listing and article detail pages to match the clean, content-focused aesthetic of SavvyCal's articles section. Focus on improved readability, 2-column grid listing, and a sticky Table of Contents sidebar on article pages.

## Listing Page (`/blog/`)

- **Layout**: 2-column responsive grid (1-col on mobile breakpoint)
- **Header**: Keep "Blog" title + subtitle + search bar
- **Category filters**: Keep filter bar, restyle as cleaner pills
- **Simplified cards**: Remove tags from cards. Each card shows:
  - Date + category badge
  - Bold title (larger than current)
  - Excerpt text
  - Read time
- **Card style**: Minimal — no heavy borders or backgrounds. Use subtle separators or whitespace. Gentle hover lift effect
- **Typography**: Larger, bolder titles. Clean sans-serif throughout

## Article Detail Page (`/blog/[slug]/`)

- **2-column layout**: Article content (~65% left) + sticky TOC sidebar (~35% right)
- **TOC sidebar**:
  - Auto-generated from h2/h3 headings in the article
  - Sticky positioned so it scrolls with the reader
  - Highlights current section based on scroll position
- **Article styling**:
  - Wider reading area within the 2-col layout
  - Cleaner heading hierarchy (remove h2 bottom borders)
  - More breathing room between sections
- **Mobile**: TOC collapses above article content or is hidden

## Navigation

- **No changes** — keep the existing blue gradient sticky nav for brand identity

## Dark Mode

- Full dark mode support maintained across all new components
- TOC sidebar styled for dark mode
- Grid cards styled for dark mode

## What Stays the Same

- Search functionality (text input filtering)
- Category filter functionality (button-based)
- RSS feed link in nav
- About page link in nav
- All OG/meta tag infrastructure
- BlogLayout wrapper component structure

## Files to Modify

- `blog-src/src/pages/index.astro` — grid layout, simplified cards, restyled filters
- `blog-src/src/pages/[slug].astro` — 2-col layout with TOC sidebar
- `blog-src/src/styles/blog.css` — updated base styles, TOC styles, grid styles
- `blog-src/src/layouts/BlogLayout.astro` — may need wider max-width for TOC layout
