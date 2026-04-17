# Michael LaPlante - Personal Portfolio & Resume Website

[![Netlify Status](https://api.netlify.com/api/v1/badges/cc82aa66-21cb-4624-b987-153e08d064cd/deploy-status)](https://app.netlify.com/projects/laplanteresume)

[!Cloudflare Status](https://img.shields.io/endpoint?url=https://cloudflare-pages-badges.laplantewebdevelopment.workers.dev/?projectName=resumesite)

A modern, fully Astro-powered personal portfolio and security consulting website for Michael LaPlante. Features a unified build pipeline, blog with category/tag taxonomy, AI-assisted draft generation, and automated Netlify deployment with Cloudflare CDN.

**Live Site:** [michaellaplante.com](https://michaellaplante.com)

## Features

- **Unified Astro Build**: Entire site (portfolio + blog) built as a single Astro 6 project
- **Responsive Design**: Works seamlessly across desktop, tablet, and mobile
- **Blog with Taxonomy**: Category and tag pages, RSS feed, related posts, dark mode
- **AI-Assisted Drafts**: Claude API integration for generating blog post drafts via GitHub Actions
- **Automated Publishing**: GitHub Actions workflow to promote drafts and publish posts
- **Performance Optimized**: Self-hosted assets, Cloudinary images, immutable cache headers, CSS-only effects
- **Security Hardened**: CSP, HSTS, X-Frame-Options, and Permissions-Policy headers via Netlify
- **SEO**: Auto-generated sitemap, structured breadcrumb data, meta tags, RSS feed
- **Cloudflare CDN**: Automated cache purging on deploy via GitHub Actions
- **Analytics**: Umami self-hosted analytics + Cloudflare Insights

## Technology Stack

| Layer | Technologies |
|-------|-------------|
| **Framework** | Astro 6, HTML5, CSS3, JavaScript |
| **Content** | Markdown content collections with type-safe schemas |
| **Styling** | Scoped Astro styles, Bootstrap (self-hosted), Linea & Ionicons |
| **Hosting** | Netlify (auto-deploy on push to `master`) |
| **CDN** | Cloudflare |
| **Images** | Cloudinary (transformation & optimization) |
| **CI/CD** | GitHub Actions (blog drafts, publishing, cache purge) |
| **AI** | Anthropic Claude API (blog draft generation) |
| **Runtime** | Node.js 22+ |

## Project Structure

```
resumesite/
├── blog-src/                    # Astro project (entire site)
│   ├── astro.config.mjs         # Astro configuration
│   ├── package.json             # Site dependencies
│   ├── public/                  # Static assets (css, js, fonts, favicons)
│   │   ├── css/                 # Portfolio stylesheets
│   │   ├── js/                  # Portfolio JavaScript
│   │   └── fonts/               # Icon and custom fonts
│   └── src/
│       ├── content/
│       │   ├── posts/           # Published blog posts (Markdown)
│       │   └── drafts/          # Draft posts (not built)
│       ├── content.config.ts    # Content collection schema
│       ├── layouts/
│       │   ├── SiteLayout.astro # Shared layout for main pages
│       │   └── BlogLayout.astro # Blog post layout
│       ├── pages/
│       │   ├── index.astro      # Homepage
│       │   ├── uses.astro       # Uses page
│       │   ├── thank-you.astro  # Thank you page
│       │   ├── 404.astro        # Site-wide 404
│       │   └── blog/            # Blog pages
│       │       ├── [...page].astro    # Blog listing (paginated)
│       │       ├── [slug].astro       # Individual post
│       │       ├── category/          # Category pages
│       │       ├── tags/              # Tag pages
│       │       ├── about.astro        # Blog about page
│       │       ├── 404.astro          # Blog 404
│       │       └── rss.xml.ts         # RSS feed
│       └── styles/
│           └── blog.css         # Blog-specific styles
├── scripts/                     # Utilities
│   └── generate-post.js         # AI blog draft generator
├── netlify.toml                 # Netlify build & header config
├── package.json                 # Root NPM scripts
└── .github/workflows/
    ├── generate-blog-post.yml   # AI draft generation
    ├── publish-blog-post.yml    # Draft-to-post promotion
    └── purge-cloudflare-cache.yml # CDN cache invalidation
```

## Getting Started

### Prerequisites

- **Node.js 22+** (required for Astro 6)
- Git

### Installation

```bash
git clone https://github.com/mlaplante/resumesite.git
cd resumesite
npm install
cd blog-src && npm install && cd ..
```

### Development

```bash
# Full site with hot reload (Astro dev server)
npm run blog:dev

# Preview production build locally
npm run blog:build && npm run blog:preview
```

The dev server runs at `http://localhost:4321`.

## Blog

The blog lives at [michaellaplante.com/blog](https://michaellaplante.com/blog).

### Commands

| Command | Description |
|---------|-------------|
| `npm run blog:dev` | Start Astro dev server with hot reload |
| `npm run blog:build` | Build entire site to `dist/` |
| `npm run blog:preview` | Preview the built site locally |
| `npm run blog:draft:git` | Generate a draft from recent git history |
| `npm run blog:draft:topic` | Generate a draft on a given topic |

### Writing a Post

1. Create a Markdown file in `blog-src/src/content/drafts/` (or use `npm run blog:draft:topic`)
2. Add frontmatter: `title`, `date`, `category`, `tags`, `excerpt`
3. Review and edit the draft
4. Move to `blog-src/src/content/posts/` when ready
5. Commit and push — Netlify builds and deploys automatically

### Categories

- `dev-session` — Development session recaps and technical walkthroughs
- `thought-leadership` — Industry trends, opinions, and insights

## Deployment

The site deploys automatically to **Netlify** on every push to `master`:

1. Netlify installs dependencies and builds the Astro project
2. Output in `dist/` is deployed with optimized CSS/JS/image processing
3. GitHub Actions triggers Cloudflare cache purge post-deploy

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `generate-blog-post.yml` | Manual / scheduled | Generate AI blog drafts via Claude API |
| `publish-blog-post.yml` | Manual | Promote drafts to published posts |
| `purge-cloudflare-cache.yml` | Post-deploy | Invalidate Cloudflare CDN cache |

### Custom Domain

DNS for `michaellaplante.com` is managed through Cloudflare, pointing to Netlify.

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
