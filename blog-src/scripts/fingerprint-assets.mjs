import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Content-hash the non-fingerprinted public assets (css/, js/) and rewrite
// every reference in the built HTML, so /css/* and /js/* can be served with
// Cache-Control: immutable. Runs after purge-css.mjs, which finalizes the CSS
// content the hashes are derived from. The unhashed originals are kept: the
// Worker falls back to them when a stale page requests a hash from a previous
// deploy (see worker/index.ts).
const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../dist');

const HASH_LENGTH = 10;
const renames = new Map();

for (const dir of ['css', 'js']) {
  for (const file of await readdir(join(distDir, dir))) {
    if (!/\.(css|js)$/.test(file)) continue;
    const content = await readFile(join(distDir, dir, file));
    const hash = createHash('sha256').update(content).digest('hex').slice(0, HASH_LENGTH);
    const hashed = file.replace(/\.(css|js)$/, `.${hash}.$1`);
    await copyFile(join(distDir, dir, file), join(distDir, dir, hashed));
    renames.set(`/${dir}/${file}`, `/${dir}/${hashed}`);
  }
}

const patterns = [...renames].map(([from, to]) => ({
  // Attribute-scoped so a path mentioned in page text is never rewritten.
  regex: new RegExp(`((?:href|src)=")${from.replaceAll('.', '\\.')}(")`, 'g'),
  replacement: `$1${to}$2`,
}));

let rewrittenFiles = 0;
let rewrittenRefs = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      let out = html;
      for (const { regex, replacement } of patterns) {
        rewrittenRefs += (out.match(regex) ?? []).length;
        out = out.replace(regex, replacement);
      }
      if (out !== html) {
        await writeFile(path, out);
        rewrittenFiles++;
      }
    }
  }
}

await walk(distDir);

const fmt = (b) => `${(b / 1024).toFixed(1)}KB`;
for (const [from, to] of renames) {
  const size = (await stat(join(distDir, to))).size;
  console.log(`  ${from.padEnd(40)} → ${to.padEnd(50)} ${fmt(size).padStart(8)}`);
}
console.log(`  rewrote ${rewrittenRefs} reference(s) across ${rewrittenFiles} HTML file(s)`);

if (rewrittenRefs === 0) {
  console.error('fingerprint-assets: no references rewritten — HTML/asset layout changed?');
  process.exit(1);
}
