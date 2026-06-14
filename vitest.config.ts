import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Two projects so the Worker tests run inside a real Cloudflare Workers
// runtime (miniflare-backed) with D1 bindings, while the shared blog-post
// lib tests run in plain Node — they exercise filesystem and crypto APIs
// that aren't available inside the Workers sandbox.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            singleWorker: true,
            wrangler: {
              configPath: './wrangler.jsonc',
            },
            miniflare: {
              // The real binding lives in wrangler.jsonc; supply a separate
              // database id here so tests never touch the production D1.
              d1Databases: {
                DB: 'test-contact-submissions',
              },
              bindings: {
                TURNSTILE_SECRET: 'test-turnstile-secret',
                FE_API_KEY: 'test-fe-api-key',
                CONTACT_FROM: 'test@example.com',
                CONTACT_TO: 'inbox@example.com',
              },
              compatibilityFlags: ['nodejs_compat'],
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['tests/worker/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'lib',
          include: ['tests/lib/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        // Site-level checks: content frontmatter validation (always runs) and
        // production build-output smoke tests (self-skip when dist/ is absent,
        // so they only assert in the CI build job that runs `npm run build`).
        test: {
          name: 'site',
          include: ['tests/site/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
