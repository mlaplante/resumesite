# Michael LaPlante - Personal Portfolio & Resume Website

[![Cloudflare Cache Purge](https://github.com/mlaplante/resumesite/actions/workflows/purge-cloudflare-cache.yml/badge.svg?branch=master)](https://github.com/mlaplante/resumesite/actions/workflows/purge-cloudflare-cache.yml)

A modern, fully Astro-powered personal portfolio and security consulting website for Michael LaPlante. The entire site (portfolio + blog) is built as a single Astro 6 project, served from Cloudflare Workers with a D1-backed contact form, Turnstile bot challenge, and ForwardEmail delivery. Blog drafts are AI-assisted via Anthropic Claude / Google Gemini / GitHub Models, gated behind human review.

**Live Site:** [michaellaplante.com](https://michaellaplante.com)

## Features

- **Unified Astro Build**: Entire site (portfolio + blog) built as a single Astro 6 project
- **Cloudflare Workers Runtime**: Static assets + a Worker that handles `/api/contact` (D1 storage, Turnstile, ForwardEmail)
- **Responsive Design**: Works seamlessly across desktop, tablet, and mobile
- **Blog with Taxonomy**: Category and tag pages, RSS feed, related posts, dark mode, in-page reading progress
- **AI-Assisted Drafts**: Anthropic / Gemini / GitHub Models integrations for generating blog post drafts
- **Automated Publishing**: GitHub Actions workflows to draft, promote, and deploy posts
- **Performance Optimized**: Self-hosted assets, immutable cache headers for hashed bundles, CSS-only effects
- **Security Hardened**: CSP, HSTS, X-Frame-Options, and Permissions-Policy headers served via the Cloudflare `_headers` file
- **SEO**: Auto-generated sitemap, canonical URLs, structured data (Person, WebSite, BlogPosting, BreadcrumbList), RSS feed, llms.txt + llms-full.txt
- **Analytics**: Umami self-hosted analytics + Cloudflare Insights

## Technology Stack

| Layer        | Technologies |
|--------------|--------------|
| **Framework**| Astro 6, HTML5, CSS3, TypeScript |
| **Content**  | Markdown content collections with Zod-validated schemas |
| **Styling**  | Scoped Astro styles, Bootstrap (self-hosted, PurgeCSS-trimmed), Linea & Ionicons |
| **Runtime**  | Cloudflare Workers + D1 (`/api/contact` form backend) |
| **Hosting**  | Cloudflare (static assets + Worker via `wrangler deploy`) |
| **CDN**      | Cloudflare |
| **Captcha**  | Cloudflare Turnstile |
| **Email**    | ForwardEmail.net API |
| **CI/CD**    | GitHub Actions (blog drafts, publishing, cache purge) |
| **AI**       | Anthropic Claude API / Google Gemini / GitHub Models |
| **Node**     | Node.js 22+ |

## Project Structure

```
resumesite/
├── blog-src/                       # Astro project (entire site)
│   ├── astro.config.mjs            # Astro configuration
│   ├── package.json                # Site dependencies
│   ├── scripts/
│   │   └── purge-css.mjs           # Post-build PurgeCSS pass on Bootstrap
│   ├── public/
│   │   ├── _headers                # Cloudflare response headers (CSP/HSTS/cache)
│   │   ├── css/                    # Portfolio stylesheets
│   │   ├── js/                     # Portfolio JavaScript
│   │   └── fonts/                  # Icon and custom fonts
│   └── src/
│       ├── components/
│       │   ├── BaseHead.astro      # Shared <head> meta/OG/canonical/favicons
│       │   └── NewsletterSignup.astro
│       ├── content/
│       │   ├── posts/              # Published blog posts (Markdown)
│       │   └── drafts/             # Draft posts (not built)
│       ├── content.config.ts       # Content collection schema (Zod)
│       ├── config.ts               # SITE_URL / DEFAULT_OG_IMAGE constants
│       ├── layouts/
│       │   ├── SiteLayout.astro    # Shared layout for main pages
│       │   └── BlogLayout.astro    # Blog post layout
│       ├── pages/                  # Astro routes
│       ├── styles/blog.css         # Blog-specific styles
│       └── utils/
│           ├── readTime.ts         # Word count / reading time
│           └── format.ts           # Shared date formatting
├── worker/                         # Cloudflare Worker for /api/contact
│   ├── index.ts                    # Router
│   ├── api/contact.ts              # Contact form handler (D1 + Turnstile + ForwardEmail)
│   └── schema.sql                  # D1 table + indexes
├── scripts/                        # AI blog draft generators
│   ├── lib/blog-post.js            # Shared mode/dedupe/frontmatter logic
│   ├── generate-post.js            # Anthropic Claude
│   ├── generate-post-gemini.js     # Google Gemini
│   └── generate-post-gh-models.js  # GitHub Models
├── wrangler.jsonc                  # Cloudflare Worker config (D1 binding, assets)
├── package.json                    # Root npm scripts (delegates to blog-src/)
└── .github/workflows/
    ├── generate-blog-post.yml      # AI draft generation
    ├── publish-blog-post.yml       # Draft-to-post promotion
    └── purge-cloudflare-cache.yml  # CDN cache invalidation
```

## Getting Started

### Prerequisites

- **Node.js 22+** (required for Astro 6)
- Git
- A Cloudflare account with `wrangler` configured (for Worker development / deployment)

### Installation

```bash
git clone https://github.com/mlaplante/resumesite.git
cd resumesite
npm install
cd blog-src && npm install && cd ..
```

### Development

```bash
# Astro dev server (static site only)
npm run dev

# Preview the production build
npm run build && npm run preview

# Worker dev (binds D1; requires .dev.vars with TURNSTILE_SECRET, FE_API_KEY, etc.)
npm run worker:dev

# Type-check the Astro project
npm run typecheck
```

The Astro dev server runs at `http://localhost:4321`. The Worker dev server runs the static site + `/api/contact` together.

### Environment Variables

Public site env vars go in `blog-src/.env`; Worker secrets are stored via `wrangler secret put NAME` (or `.dev.vars` locally). See `blog-src/.env.example` for the full list.

| Variable                     | Used by    | Notes                                  |
|------------------------------|------------|----------------------------------------|
| `PUBLIC_TURNSTILE_SITE_KEY`  | Astro      | Public site key for Turnstile widget   |
| `TURNSTILE_SECRET`           | Worker     | Secret key for siteverify              |
| `FE_API_KEY`                 | Worker     | ForwardEmail.net API key               |
| `CONTACT_FROM`               | Worker     | Sender address for outgoing email      |
| `CONTACT_TO`                 | Worker     | Destination inbox for form submissions |

## Blog

The blog lives at [michaellaplante.com/blog](https://michaellaplante.com/blog).

### Commands

| Command                         | Description |
|---------------------------------|-------------|
| `npm run dev`                   | Start Astro dev server with hot reload |
| `npm run build`                 | Build entire site to `dist/` (includes PurgeCSS pass) |
| `npm run preview`               | Preview the built site locally |
| `npm run typecheck`             | Run `astro check` for TS / content-schema validation |
| `npm run worker:dev`            | Run Wrangler dev (Worker + assets together) |
| `npm run worker:deploy`         | Deploy the Worker + assets to Cloudflare |
| `npm run blog:draft:git`        | Generate a draft from recent git history (Anthropic) |
| `npm run blog:draft:topic`      | Generate a draft on a given topic (Anthropic) |

### Writing a Post

1. Create a Markdown file in `blog-src/src/content/drafts/` (or use `npm run blog:draft:topic "Your topic"`)
2. Add frontmatter: `title`, `date`, `category`, `tags`, `excerpt` (optionally `updated`, `image`)
3. Review and edit the draft
4. Move to `blog-src/src/content/posts/` when ready
5. Commit and push — Cloudflare deploys and the cache-purge workflow runs automatically

### Categories

- `dev-session` — Development session recaps and technical walkthroughs
- `thought-leadership` — Industry trends, opinions, and insights
- `project-update` — Reserved for git-log-derived posts (auto-categorized by the AI draft pipeline)

## Deployment

The site deploys to **Cloudflare** as a Worker plus static assets:

1. Build emits the static site into `dist/` (configured via `astro.config.mjs`)
2. `wrangler deploy` uploads the Worker (`worker/index.ts`) and the assets directory together
3. The Worker handles `/api/contact`; everything else is served from the bound `ASSETS` fetcher
4. The `purge-cloudflare-cache.yml` workflow fires on pushes to `master` to invalidate the edge cache

### GitHub Actions Workflows

| Workflow                       | Trigger              | Purpose |
|--------------------------------|----------------------|---------|
| `generate-blog-post.yml`       | Manual / scheduled   | Generate AI blog drafts via Gemini (opens a PR) |
| `publish-blog-post.yml`        | PR merge (label-gated) | Move drafts → posts on merge |
| `purge-cloudflare-cache.yml`   | Post-push to master  | Invalidate Cloudflare CDN cache |

### Custom Domain

DNS for `michaellaplante.com` is managed through Cloudflare.

## Contributing

This is a personal portfolio website. If you find bugs or have suggestions:

1. Open an issue describing the problem or suggestion
2. Fork, branch, and submit a pull request

## License

Copyright LaPlante Web Development 2006-2026. All rights reserved.

## Contact

**Michael LaPlante**

- **Website**: [michaellaplante.com](https://michaellaplante.com)
- **GitHub**: [@mlaplante](https://github.com/mlaplante)
