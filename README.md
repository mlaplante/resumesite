# Michael LaPlante - Personal Portfolio & Resume Website

[![Deploy via FTP](https://github.com/mlaplante/resumesite/actions/workflows/deploy.yml/badge.svg)](https://github.com/mlaplante/resumesite/actions/workflows/deploy.yml)

A modern, responsive personal portfolio website showcasing Michael LaPlante's professional experience, skills, and services as a Software Engineer, VP of Technology, and Chief Security Officer. Includes an Astro-powered blog subsection with AI-assisted draft generation.

🌐 **Live Site:** [michaellaplante.com](https://michaellaplante.com)

## 📋 Table of Contents

- [About](#about)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Blog](#blog)
- [Deployment](#deployment)
- [Sections Overview](#sections-overview)
- [Analytics & Tracking](#analytics--tracking)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## 🎯 About

This website serves as a comprehensive digital resume and portfolio for Michael LaPlante, highlighting over 15 years of professional experience in software engineering, web design, and technology leadership. The site is designed to:

- **Showcase Professional Experience**: Display a detailed timeline of career progression from Web Designer to SVP of Information Security and Operations
- **Highlight Technical Skills**: Present expertise across multiple programming languages, frameworks, and design tools
- **Present Services**: Communicate available consulting and development services
- **Enable Contact**: Provide an easy way for potential clients and collaborators to get in touch
- **Demonstrate Expertise**: Serve as a live example of front-end development and UX design capabilities
- **Share Knowledge**: Blog subsection for technical writing and thought leadership

## ✨ Features

- **Responsive Design**: Fully responsive layout that works seamlessly across desktop, tablet, and mobile devices
- **Modern UI/UX**: Clean, professional interface with smooth animations and transitions
- **Animated Sections**: Scroll-based animations using AOS (Animate On Scroll) library
- **Interactive Navigation**: Smooth scrolling navigation with mobile-friendly hamburger menu
- **Skills Visualization**: Progress bars showing proficiency levels in various technologies
- **Professional Timeline**: Chronological display of work experience with detailed descriptions
- **Blog Subsection**: Astro-powered static blog with category filtering and dark mode support
- **AI-Assisted Drafts**: Claude API integration for generating blog post drafts from git history or topics
- **Contact Form Integration**: Embedded Typeform for easy communication
- **Performance Optimized**: Preloader for smooth initial page load
- **SEO Optimized**: Meta tags and structured content for search engine visibility
- **Analytics Integration**: Custom analytics tracking and Google Analytics integration
- **Social Media Links**: Direct links to professional social media profiles

## 🛠 Technology Stack

### Frontend Framework & Libraries
- **HTML5**: Semantic markup structure
- **CSS3**: Modern styling with custom properties
- **Bootstrap 3**: Responsive grid system and components
- **JavaScript/jQuery**: Interactive functionality and DOM manipulation

### Blog
- **Astro 6**: Static site generator for the blog subsection
- **Content Collections**: Type-safe Markdown content management
- **Node.js 22+**: Required for Astro 6

### UI Components & Effects
- **AOS (Animate On Scroll)**: Scroll-triggered animations
- **Owl Carousel**: Touch-enabled carousels
- **Waves**: Material Design ripple effects
- **Linea Icons**: Line-style icon set
- **Ionicons**: Icon font library

### Third-Party Integrations
- **Typeform**: Contact form integration
- **Google Analytics**: User tracking and analytics
- **Custom Analytics**: Self-hosted analytics solution
- **Cloudinary**: Image hosting and optimization
- **Anthropic Claude API**: Blog draft generation

### Development & Deployment
- **GitHub Actions**: Automated FTP deployment on push to master
- **SamKirkland/FTP-Deploy-Action**: Incremental FTP uploads (only changed files)
- **Git**: Version control
- **Custom Domain**: michaellaplante.com

## 📁 Project Structure

```
resumesite/
│
├── index.html                 # Main portfolio HTML file
├── README.md                  # This file
├── CNAME                      # Custom domain configuration
├── package.json               # NPM scripts for build & blog
│
├── .github/workflows/         # CI/CD
│   └── deploy.yml             # GitHub Actions FTP deployment
│
├── blog-src/                  # Blog source (Astro project)
│   ├── astro.config.mjs       # Astro configuration
│   ├── package.json           # Blog dependencies
│   └── src/
│       ├── content/
│       │   ├── posts/         # Published blog posts (Markdown)
│       │   └── drafts/        # Draft posts (not built)
│       ├── content.config.ts  # Content collection schema
│       ├── layouts/           # Astro layout components
│       ├── pages/             # Blog pages (index, [slug])
│       └── styles/            # Blog-specific CSS
│
├── blog/                      # Built blog output (deployed)
│
├── scripts/                   # Utilities
│   └── generate-post.js       # AI blog draft generator
│
├── css/                       # Portfolio stylesheets
│   ├── style.css              # Main custom styles
│   ├── linea.css              # Linea icons styles
│   ├── ionicons.min.css       # Ionicons styles
│   ├── waves.min.css          # Waves effect styles
│   ├── owl.carousel.css       # Carousel styles
│   └── aos.css                # Animation on scroll styles
│
├── js/                        # Portfolio JavaScript
│   ├── script.js              # Main custom JavaScript
│   ├── jquery.min.js          # jQuery library
│   ├── smooth-scroll.min.js   # Smooth scrolling
│   ├── jquery.shuffle.min.js  # Shuffle plugin
│   ├── waves.min.js           # Material waves effect
│   ├── owl.carousel.min.js    # Carousel functionality
│   ├── validator.min.js       # Form validation
│   └── aos.js                 # Animate on scroll
│
├── bootstrap/                 # Bootstrap framework
├── fonts/                     # Icon and custom fonts
└── img/                       # Image assets
```

## 🚀 Getting Started

### Prerequisites

- **Node.js 22+** (required for Astro 6)
- A modern web browser
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/mlaplante/resumesite.git
   cd resumesite
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd blog-src && npm install && cd ..
   ```

3. **Run locally**

   For the main portfolio site:
   ```bash
   npm run serve
   ```

   For the blog in development mode:
   ```bash
   npm run blog:dev
   ```

4. **View the site** at `http://localhost:3000` (serve) or `http://localhost:4321` (Astro dev)

## 📝 Blog

The blog lives at [michaellaplante.com/blog](https://michaellaplante.com/blog) and is built with Astro as a static subsection of the main site.

### Blog Commands

| Command | Description |
|---------|-------------|
| `npm run blog:dev` | Start Astro dev server with hot reload |
| `npm run blog:build` | Build blog to `blog/` output directory |
| `npm run blog:preview` | Preview the built blog locally |
| `npm run blog:draft:git` | Generate a draft from recent git history |
| `npm run blog:draft:topic` | Generate a draft on a given topic |

### Writing a Post

1. Create a Markdown file in `blog-src/src/content/drafts/` (or use `npm run blog:draft:topic`)
2. Add frontmatter: `title`, `date`, `category`, `tags`, `excerpt`
3. Review and edit the draft
4. Move to `blog-src/src/content/posts/` when ready
5. Run `npm run blog:build` to generate static HTML
6. Commit and push — GitHub Actions handles deployment

### Categories

- `dev-session` — Development session recaps and technical walkthroughs
- `thought-leadership` — Industry trends, opinions, and insights

## 🚢 Deployment

This site is automatically deployed via **GitHub Actions** whenever changes are pushed to the `master` branch. The workflow:

1. Checks out the repository
2. Installs Node.js 22 and blog dependencies
3. Builds the Astro blog to the `blog/` directory
4. Deploys all site files to the FTP server (only changed files are uploaded)

The deployment status badge at the top of this README shows the current state.

### FTP Configuration

FTP credentials are stored as GitHub repository secrets:

| Secret | Description |
|--------|-------------|
| `FTP_SERVER` | FTP hostname |
| `FTP_USERNAME` | FTP username |
| `FTP_PASSWORD` | FTP password |
| `FTP_SERVER_DIR` | Remote directory (must end with `/`) |

### Custom Domain

The site uses a custom domain configured via the `CNAME` file. DNS is configured to point `michaellaplante.com` to the hosting server.

## 📄 Sections Overview

### Home
- Eye-catching hero section with personal photo
- Name and title introduction
- Clean, minimalist design

### About Me
- Professional summary and introduction
- Background and experience overview
- Social media links (Facebook, Twitter, GitHub)

### Fun Facts
- Statistical highlights (clients served, languages mastered, speaking sessions)
- Visual representation of achievements
- Engaging metrics display

### Services
- **Programming**: Custom software development
- **Creative**: Design and UX services
- **Consulting**: Technology consulting and strategy
- **SEO**: Search engine optimization services

### Skills
- Visual skill bars showing proficiency levels
- Technologies covered:
  - Adobe Design Suite (99%)
  - HTML/CSS/Sass (99%)
  - JavaScript (98%)
  - jQuery (100%)
  - React (90%)
  - Angular (90%)
  - TypeScript (90%)

### Experience
- Detailed chronological timeline of professional positions
- Company names, titles, and date ranges
- Comprehensive job descriptions
- Covers 15+ years of experience from 2010 to present
- Notable positions:
  - Proforma - SVP of Information Security and Operations (2026-Present)
  - Proforma - Vice President of Technology (2022-2026)
  - FireEye - Senior Web Engineer (2015-2019)
  - And more...

### Blog
- Technical articles and development session recaps
- Category filtering and tag support
- Dark mode support matching the main site
- AI-assisted draft generation

### Contact
- Embedded Typeform for easy communication
- Streamlined contact process
- Professional inquiry handling

## 📊 Analytics & Tracking

The site implements multiple analytics solutions:

1. **Custom Analytics**: Self-hosted analytics via `laplantedevanalytics.netlify.app`
   - Website ID: `1432237e-7cf8-4b54-9b2d-2f8f5bde6e7c`

2. **Google Analytics**:
   - Tracking ID: `G-8NYWNGQRKS`
   - Comprehensive user behavior tracking

## 🤝 Contributing

This is a personal portfolio website. However, if you find bugs or have suggestions for improvements:

1. Open an issue describing the problem or suggestion
2. If you'd like to contribute code:
   - Fork the repository
   - Create a feature branch (`git checkout -b feature/improvement`)
   - Make your changes
   - Test thoroughly
   - Commit your changes (`git commit -am 'Add improvement'`)
   - Push to the branch (`git push origin feature/improvement`)
   - Open a Pull Request

## 📝 License

Copyright © LaPlante Web Development 2006-2026. All rights reserved.

This is a personal portfolio website. Please do not copy or redistribute without permission.

## 📧 Contact

**Michael LaPlante**

- **Website**: [michaellaplante.com](https://michaellaplante.com)
- **GitHub**: [@mlaplante](https://github.com/mlaplante)
- **Twitter**: [@laplantewebdev](https://twitter.com/laplantewebdev)
- **Facebook**: [Laplante.Michael](https://www.facebook.com/Laplante.Michael)

For professional inquiries, please use the contact form on the website.

---

**Built with ❤️ by Michael LaPlante**
