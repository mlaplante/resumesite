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

  it('ships the security headers in the global _headers block', () => {
    const lines = readFileSync(join(DIST, '_headers'), 'utf8').split('\n');
    const start = lines.indexOf('/*');
    expect(start, '_headers has no global /* block').toBeGreaterThanOrEqual(0);
    let end = lines.findIndex((l, i) => i > start && l !== '' && !/^\s/.test(l));
    if (end === -1) end = lines.length;
    const globalBlock = lines.slice(start + 1, end).join('\n');
    for (const header of [
      'X-Frame-Options: DENY',
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy: same-origin',
      'X-Permitted-Cross-Domain-Policies: none',
    ]) {
      expect(globalBlock).toContain(header);
    }
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

  // Post bodies are Markdown, and the renderer passes raw HTML through
  // verbatim. Most posts are drafted by an LLM from fetched news text, so a
  // prompt-injected `<meta http-equiv=refresh>`, `<style>` overlay, or `<form>`
  // would otherwise ride a routine draft PR onto the live site. The CSP blocks
  // script execution, off-site frames and off-site form posts, but not
  // redirects or restyling — so no post may render active markup at all.
  // Checked on the built page (not the Markdown source) because fenced and
  // inline code is entity-escaped by then: any literal tag left is a real one.
  it('renders no active HTML inside any post body', () => {
    const FORBIDDEN_TAG =
      /<(script|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|option|base|meta|link|style|svg|math|audio|video|source|track|dialog|template|slot|portal|marquee)\b/i;
    const EVENT_ATTR = /<[^>]*\son[a-z]+\s*=/i;
    const SCRIPT_URL = /<[^>]*\s(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*(?:javascript|vbscript|data):/i;

    const blogDir = join(DIST, 'blog');
    const offenders: string[] = [];
    let checked = 0;
    for (const slug of readdirSync(blogDir)) {
      const file = join(blogDir, slug, 'index.html');
      if (!existsSync(file)) continue;
      const html = readFileSync(file, 'utf8');
      // The post body sits between the inline TOC and the end of <article>;
      // listing/category pages have no inline TOC and are skipped.
      const tocAt = html.indexOf('id="toc-inline-nav"');
      if (tocAt === -1) continue;
      const start = html.indexOf('</details>', tocAt);
      const end = html.lastIndexOf('</article>');
      expect(start, `${slug}: post body start not found`).toBeGreaterThan(-1);
      expect(end, `${slug}: post body end not found`).toBeGreaterThan(start);
      // GFM task lists (`- [ ] item`) render as exactly this inert checkbox —
      // the one form control a post body may legitimately contain.
      const body = html.slice(start, end).replaceAll('<input type="checkbox" disabled>', '');
      checked++;
      const hit = body.match(FORBIDDEN_TAG) ?? body.match(EVENT_ATTR) ?? body.match(SCRIPT_URL);
      if (hit) offenders.push(`${slug}: ${hit[0].slice(0, 80)}`);
    }
    expect(checked, 'no post pages were inspected — body markers changed?').toBeGreaterThan(0);
    expect(offenders, `active HTML rendered in post bodies:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('builds a populated client-side search index', () => {
    const index = JSON.parse(
      readFileSync(join(DIST, 'blog/search.json'), 'utf8'),
    );
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
  });
});
