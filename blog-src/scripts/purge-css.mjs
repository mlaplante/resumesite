import { PurgeCSS } from 'purgecss';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../dist');

const targets = [
  'css/bootstrap-reboot.min.css',
  'css/bootstrap-grid.min.css',
  'css/bootstrap-utilities.min.css',
  'css/bootstrap.min.css',
];

// Classes mutated at runtime by /js/script.js that aren't present in rendered HTML.
const safelist = {
  standard: [
    'dark-mode', 'aos-animate', 'white-btn', 'show-menu',
    'ripple-target', 'ripple', 'used',
    'pink', 'green', 'blue', 'teal', 'blue-grey', 'default', 'purple',
    'show', 'active', 'fade', 'collapsing', 'collapsed',
  ],
  deep: [/^fade/, /^show/, /^modal/],
};

const fmt = (b) => `${(b / 1024).toFixed(1)}KB`;

for (const rel of targets) {
  const cssPath = resolve(distDir, rel);
  const before = (await stat(cssPath)).size;

  const result = await new PurgeCSS().purge({
    content: [`${distDir}/**/*.html`],
    css: [cssPath],
    safelist,
    variables: true,
  });

  await writeFile(cssPath, result[0].css);
  const after = (await stat(cssPath)).size;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`  ${rel.padEnd(40)} ${fmt(before).padStart(8)} → ${fmt(after).padStart(8)}  (-${pct}%)`);
}
