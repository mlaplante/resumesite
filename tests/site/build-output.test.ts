import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Smoke-tests the actual production build. Run after `npm run build` (CI does
// this in the "Astro typecheck + build" job); when `dist/` is absent — e.g. a
// plain local `npm test` — the whole suite is skipped so it never blocks.
const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dist');
const hasDist = existsSync(DIST);

describe.skipIf(!hasDist)('production build output', () => {
  // Key routes / endpoints that must always ship. A broken page or renamed
  // route shows up here instead of as a silent 404 in production.
  const required = [
    'index.html',
    'resume/index.html',
    'resume.pdf',
    'services/index.html',
    'uses/index.html',
    'privacy/index.html',
    '404.html',
    'blog/index.html',
    'blog/about/index.html',
    'blog/rss.xml',
    'blog/search.json',
    'feed.json',
    'sitemap-index.xml',
    'llms-full.txt',
    'robots.txt',
    '_headers',
  ];

  it.each(required)('emits %s', (rel) => {
    expect(existsSync(join(DIST, rel)), `dist/${rel} is missing`).toBe(true);
  });

  it('renders a non-trivial home page', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('<title');
    expect(html.length).toBeGreaterThan(1000);
  });

  it('generates a per-post Open Graph card for every post', () => {
    const ogDir = join(DIST, 'og');
    expect(existsSync(ogDir), 'dist/og is missing').toBe(true);
    const pngs = readdirSync(ogDir).filter((f) => f.endsWith('.png'));
    expect(pngs.length).toBeGreaterThan(0);
  });

  it('produces a real (non-empty) PDF résumé', () => {
    const pdf = readFileSync(join(DIST, 'resume.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(statSync(join(DIST, 'resume.pdf')).size).toBeGreaterThan(20_000);
  });

  it('builds a populated client-side search index', () => {
    const index = JSON.parse(
      readFileSync(join(DIST, 'blog/search.json'), 'utf8'),
    );
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
  });
});
