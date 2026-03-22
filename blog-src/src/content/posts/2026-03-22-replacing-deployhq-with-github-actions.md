---
title: "Ditching DeployHQ: Free FTP Deployments with GitHub Actions"
date: 2026-03-22
category: "dev-session"
tags: ["github-actions", "ftp", "ci-cd", "deployment", "astro"]
excerpt: "How I replaced a paid deployment service with a free GitHub Actions workflow that builds my Astro blog and deploys to FTP in 20 seconds."
---

I've been using DeployHQ to push my portfolio site to shared hosting via FTP. It worked fine — until the free plan limitations started getting in the way. Limited deployments per day, restrictions on build steps, and the constant nudge to upgrade. For a personal site that just needs to push static files over FTP, it felt like overkill.

So I replaced it with a GitHub Actions workflow in about 15 minutes.

## The Setup

My site is a static portfolio with an Astro-powered blog subsection. The build process is straightforward: install dependencies, build the blog, then upload everything to the FTP server. DeployHQ handled this, but GitHub Actions can do the same thing for free — with 2,000 minutes per month on private repos and unlimited minutes on public ones.

Here's the workflow I landed on:

```yaml
name: Deploy via FTP
on:
  push:
    branches: [master]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install blog dependencies
        run: cd blog-src && npm ci
      - name: Build blog
        run: npm run blog:build
      - name: Deploy via FTP
        uses: SamKirkland/FTP-Deploy-Action@v4.3.6
        with:
          server: ${{ secrets.FTP_SERVER }}
          username: ${{ secrets.FTP_USERNAME }}
          password: ${{ secrets.FTP_PASSWORD }}
          server-dir: ${{ secrets.FTP_SERVER_DIR }}
          exclude: |
            **/.git*
            **/.git*/**
            node_modules/**
            blog-src/**
            docs/**
            scripts/**
            .claude/**
            package.json
            package-lock.json
            netlify.toml
```

The key piece is [SamKirkland/FTP-Deploy-Action](https://github.com/SamKirkland/FTP-Deploy-Action), which tracks uploaded files via a `.ftp-deploy-sync-state.json` file on the server. After the initial full upload, subsequent deploys only push changed files — keeping things fast.

## Two Gotchas

**Version tags matter.** I initially referenced the action as `@v4`, which seems like it should resolve to the latest v4.x release. It didn't. GitHub couldn't find the tag at all. The fix was using the exact version: `@v4.3.6`. Minor thing, but it'll cost you a failed run if you don't know.

**Node.js version requirements.** Astro 6 requires Node.js 22+, but `actions/setup-node` defaults to whatever's on the runner (Node 20 currently). The build fails with a clear error message, but it's easy to miss if you're not watching. Setting `node-version: 22` explicitly solved it.

Both issues took one commit each to fix, and the third run went green — build and deploy in 20 seconds total.

## Why Not Netlify?

I actually have a `netlify.toml` in the repo from an earlier experiment. But my hosting is traditional shared hosting with FTP access, and I didn't want to migrate. Sometimes the simplest path is just automating what you already have rather than re-platforming.

## The Result

Every push to master now triggers a full build-and-deploy cycle. No service limits, no monthly caps, no account to manage. The FTP credentials live in GitHub Secrets, the workflow file lives in the repo, and the whole thing is version-controlled alongside the code it deploys.

For anyone else stuck on a limited deployment service for FTP hosting: GitHub Actions is the move. It took three commits to get right, and now I don't think about deployments at all.
