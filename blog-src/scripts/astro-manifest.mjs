import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Astro/Vite emit content-hashed assets under /_astro2 (e.g.
// BlogLayout.CBvvIjZz.css; the directory name is set by build.assets in
// astro.config.mjs). Unlike /css and /js there is no unhashed original
// to fall back to, so CDN-cached HTML from a previous deploy 404s on them and
// whole pages render unstyled. This writes dist/_astro-manifest.json mapping
// each stable base name ("BlogLayout.css") to the current hashed path; the
// Worker consults it when an /_astro or /_astro2 request 404s. Runs after
// the build.

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../dist');
const astroDir = join(distDir, '_astro2');

// <base>.<8-char vite hash>.<ext> — keep in sync with ASTRO_ASSET in worker/index.ts.
const HASHED = /^(.+)\.[A-Za-z0-9_-]{8}(\.(?:css|js))$/;

const manifest = {};
const ambiguous = new Set();
for (const file of await readdir(astroDir)) {
  const m = file.match(HASHED);
  if (!m) continue;
  const base = m[1] + m[2];
  if (base in manifest) {
    // Two current files share a base (e.g. chunk-split 404.css) — a stale
    // request for that base is ambiguous, so leave it out of the fallback.
    ambiguous.add(base);
    continue;
  }
  manifest[base] = `/_astro2/${file}`;
}
for (const base of ambiguous) delete manifest[base];

await writeFile(join(distDir, '_astro-manifest.json'), JSON.stringify(manifest));
console.log(
  `_astro-manifest.json: ${Object.keys(manifest).length} entries` +
    (ambiguous.size ? `, ${ambiguous.size} ambiguous base(s) skipped: ${[...ambiguous].join(', ')}` : ''),
);
