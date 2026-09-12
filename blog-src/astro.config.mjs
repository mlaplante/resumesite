import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Per-post <lastmod> for the sitemap, read straight from frontmatter
// (`updated`, falling back to `date`). astro:content isn't importable here, and
// git history is unreliable on the shallow clones CI/Workers Builds use, so
// frontmatter is the one source that's honest on every build path. Pages
// without a known modification date simply omit lastmod, which crawlers
// prefer over a build timestamp that changes on every deploy.
const POSTS_DIR = new URL('./src/content/posts/', import.meta.url);
const postLastmod = new Map();
for (const file of readdirSync(POSTS_DIR)) {
  if (!file.endsWith('.md') || /^[_A-Z]/.test(file)) continue;
  const head = readFileSync(new URL(file, POSTS_DIR), 'utf8').slice(0, 2000);
  const pick = (key) => head.match(new RegExp(`^${key}:\\s*["']?(\\d{4}-\\d{2}-\\d{2})`, 'm'))?.[1];
  const date = pick('updated') ?? pick('date');
  if (date) postLastmod.set(`/blog/${file.slice(0, -3)}/`, date);
}

// Utility/error pages that must never be advertised to crawlers. The contact
// outcome pages also pass `noindex` to their layout; the 404 pages rely on the
// real HTTP 404 status instead (Lighthouse's SEO gate penalises noindex).
const SITEMAP_EXCLUDE = new Set(['/404', '/404/', '/blog/404/', '/contact-error/', '/thank-you/']);

export default defineConfig({
  site: 'https://michaellaplante.com',
  outDir: '../dist',
  base: '/',
  output: 'static',
  build: {
    format: 'directory',
    // Prerender several routes at once. Page rendering is mostly CPU-bound and
    // single-threaded, but the OG card route awaits sharp's PNG encode on the
    // libuv threadpool, so overlapping routes hides that wait.
    concurrency: 4,
    // Renamed from the default _astro to rotate every bundle URL: clients and
    // the CDN edge cached 404s for /_astro/* URLs as immutable (the _headers
    // path rule used to apply to 404s too), and vite's content hashes
    // regenerate the same URLs, so poisoned caches never recovered. Bump the
    // suffix if URL rotation is ever needed again; keep ASTRO_ASSET in
    // worker/index.ts and scripts/astro-manifest.mjs in sync.
    assets: '_astro2',
    // Emit page CSS as <style> in the HTML instead of render-blocking <link>s.
    // scripts/inline-critical.mjs does the same for the hand-written /css/*
    // files, so no page has a stylesheet request on its critical path.
    inlineStylesheets: 'always',
  },
  prefetch: {
    defaultStrategy: 'viewport',
  },
  image: {
    service: {
      entrypoint: 'astro/assets/services/sharp',
    },
  },
  integrations: [
    sitemap({
      filter: (page) => !SITEMAP_EXCLUDE.has(new URL(page).pathname),
      serialize(item) {
        const lastmod = postLastmod.get(new URL(item.url).pathname);
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
    // Finalize dist as part of `astro build` itself — PurgeCSS, CSS/JS
    // minification, asset fingerprinting + HTML ref rewriting, and the /_astro
    // fallback manifest.
    // This used to live only in the repo-root `npm run build` chain, but
    // anything that runs a bare `astro build` and deploys (automation, CI)
    // then shipped unfingerprinted HTML, which browsers resolved against
    // immutable-cached stale /css/* content. Keeping it here means every
    // build path produces the finished dist.
    {
      name: 'finalize-dist',
      hooks: {
        'astro:build:done': async () => {
          await import('./scripts/purge-css.mjs');
          await import('./scripts/minify-assets.mjs');
          await import('./scripts/inline-critical.mjs');
          await import('./scripts/fingerprint-assets.mjs');
          await import('./scripts/astro-manifest.mjs');
        },
      },
    },
  ],
  vite: {
    build: {
      // Never inline bundled <script> blocks into the HTML. Required for the
      // strict CSP in public/_headers (script-src without 'unsafe-inline'):
      // with the default 4KB limit, small page scripts get embedded as inline
      // <script type="module"> and would be blocked. The one inline script the
      // site does ship (theme.js, embedded by scripts/inline-critical.mjs) is
      // allowlisted by sha256 hash, not by relaxing the policy.
      assetsInlineLimit: 0,
    },
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-default',
      },
      wrap: true,
    },
  },
});
