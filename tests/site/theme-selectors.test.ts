import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Dark mode on this site is a manual toggle: public/js/theme.js stamps
// `data-theme="dark|light"` on <html> (following the OS preference only until
// the visitor picks one), and every stylesheet keys off that attribute. A
// `@media (prefers-color-scheme: dark)` block in page CSS silently ignores
// the toggle — the tags page shipped that way for months — so forbid it in
// every <style> block and stylesheet under blog-src/src. The <meta
// name="theme-color" media=...> hints in BaseHead are HTML, not CSS, and are
// deliberately left alone.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../blog-src/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(astro|css)$/.test(name) ? [full] : [];
  });
}

function styleSource(file: string): string {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return raw;
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}

const files = walk(SRC);

describe('theme selectors', () => {
  it('finds stylesheets to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => f.slice(SRC.length + 1)))(
    '%s keys dark mode off [data-theme], not prefers-color-scheme',
    (rel) => {
      expect(styleSource(join(SRC, rel))).not.toMatch(/prefers-color-scheme\s*:\s*dark/);
    },
  );
});
