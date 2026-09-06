import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://michaellaplante.com',
  outDir: '../dist',
  base: '/',
  output: 'static',
  build: {
    format: 'directory',
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
    sitemap(),
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
