import { transform } from 'esbuild';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Minify the hand-written public assets (css/, js/) in place. Runs after
// purge-css.mjs (so the purged CSS is what gets minified) and before
// fingerprint-assets.mjs (so the content hashes are derived from the final
// bytes and the unhashed fallbacks the Worker serves are minified too).
// The Bootstrap files are already minified upstream; esbuild is a no-op on
// them apart from a few bytes.
const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../dist');

// public/js/*.js are classic (non-module) scripts written in ES5-ish style
// and loaded on every page; keep esbuild from rewriting them into syntax the
// sources never used.
const TARGET = 'es2018';

const fmt = (b) => `${(b / 1024).toFixed(1)}KB`;

for (const dir of ['css', 'js']) {
  for (const file of await readdir(join(distDir, dir))) {
    const match = /\.(css|js)$/.exec(file);
    if (!match) continue;
    const path = join(distDir, dir, file);
    const before = (await stat(path)).size;
    const source = await readFile(path, 'utf8');
    const { code } = await transform(source, {
      loader: match[1],
      minify: true,
      target: TARGET,
      // Preserve /*! ... */ license banners only; everything else is dropped.
      legalComments: 'inline',
    });
    await writeFile(path, code);
    const after = (await stat(path)).size;
    const pct = before ? ((1 - after / before) * 100).toFixed(1) : '0.0';
    console.log(`  ${`${dir}/${file}`.padEnd(40)} ${fmt(before).padStart(8)} → ${fmt(after).padStart(8)}  (-${pct}%)`);
  }
}
