import { createHash } from 'node:crypto';
import { PurgeCSS } from 'purgecss';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Take every render-blocking request off the critical path by embedding it in
// the HTML:
//
//   * <link rel="stylesheet" href="/css/*.css">  →  <style>…</style>
//     (Astro's own per-page CSS is already inlined via build.inlineStylesheets.)
//     The shared Bootstrap/style.css bundles are purged per page on the way in,
//     so a page only carries the rules its own markup can match — the global
//     purge-css.mjs pass keeps everything any page uses, which is 3-4x more
//     than most pages need once the bytes ride along in every document.
//   * <script src="/js/theme.js">                →  <script>…</script>
//     The theme bootstrap has to run before first paint (no light-mode flash),
//     so it was a blocking external request on every page. Inline, it needs a
//     CSP hash: the script-src in dist/_headers gets 'sha256-…' of the exact
//     inlined bytes appended, so the policy keeps rejecting every other inline
//     script (still no 'unsafe-inline').
//
// On simulated mobile this removes a full round trip (plus connection setup)
// between the document and first paint. Runs after purge-css.mjs and
// minify-assets.mjs (so the embedded CSS/JS is the final, minified bytes) and
// before fingerprint-assets.mjs (the tags it rewrites are the unhashed ones).
// The /css and /js files stay in dist untouched: the Worker still serves them
// as a fallback for HTML cached before this step existed.
const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../../dist');

const THEME_SRC = '/js/theme.js';
const THEME_TAG = `<script src="${THEME_SRC}"></script>`;

// Same runtime-toggled classes purge-css.mjs protects (keep the two in sync).
const safelist = {
  standard: [
    'dark-mode', 'js-anim', 'aos-animate', 'white-btn', 'show-menu',
    'ripple-target', 'ripple', 'used',
    'pink', 'green', 'blue', 'teal', 'blue-grey', 'default', 'purple',
    'show', 'active', 'fade', 'collapsing', 'collapsed',
  ],
  deep: [/^fade/, /^show/, /^modal/],
};
// fonts.css is left whole: its @font-face rules are referenced from Astro's
// inlined page CSS, which the purger never sees.
const PURGE = new Set([
  '/css/style.css',
  '/css/bootstrap.min.css',
  '/css/bootstrap-grid.min.css',
  '/css/bootstrap-reboot.min.css',
  '/css/bootstrap-utilities.min.css',
]);

const cssSource = new Map();
async function readCss(href) {
  if (!cssSource.has(href)) {
    let text = await readFile(join(distDir, href), 'utf8');
    // fonts.css points at ../fonts/… relative to /css/; once the rules live in
    // the page they resolve against the page URL, so make them root-relative.
    text = text.replace(/url\((['"]?)(\.\.?\/[^'")]+)\1\)/g, (_, q, rel) => {
      const abs = new URL(rel, `https://resolve.invalid${href}`).pathname;
      return `url(${q}${abs}${q})`;
    });
    cssSource.set(href, text);
  }
  return cssSource.get(href);
}

let purgedBytes = 0;
async function inlineCss(href, html) {
  let css = await readCss(href);
  if (PURGE.has(href)) {
    const [result] = await new PurgeCSS().purge({
      content: [{ raw: html, extension: 'html' }],
      css: [{ raw: css }],
      safelist,
      // Custom properties feed Astro's inlined styles too; never strip them.
      variables: false,
    });
    purgedBytes += css.length - result.css.length;
    css = result.css;
  }
  return `<style>${css}</style>`;
}

const themeJs = await readFile(join(distDir, THEME_SRC), 'utf8');
if (themeJs.includes('</script')) throw new Error('inline-critical: theme.js contains "</script"; cannot inline safely');
const themeTag = `<script>${themeJs}</script>`;
const themeHash = createHash('sha256').update(themeJs, 'utf8').digest('base64');

// Any <link …href="/css/…"…> — stylesheets get inlined, style preloads dropped.
const LINK = /<link\b[^>]*\bhref="(\/css\/[^"]+\.css)"[^>]*>/g;
const MODULE_SCRIPT = /<script type="module" src="\/_astro2\/[^"]+"(?![^>]*fetchpriority)[^>]*>/g;

let files = 0;
let inlinedLinks = 0;
let inlinedScripts = 0;
let droppedPreloads = 0;
let bytes = 0;
let deprioritized = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.name.endsWith('.html')) continue;
    const html = await readFile(path, 'utf8');
    let out = html;

    if (out.includes(THEME_TAG)) {
      out = out.replace(THEME_TAG, themeTag);
      inlinedScripts++;
    }

    // Purge against the page as it will ship (theme script already inline, so
    // the tokens it toggles — data-theme, dark-mode — count as "used").
    const replacements = [];
    for (const match of out.matchAll(LINK)) {
      const [tag, href] = match;
      if (/\brel="stylesheet"/.test(tag)) {
        replacements.push([tag, await inlineCss(href, out)]);
        inlinedLinks++;
      } else if (/\brel="preload"/.test(tag) && /\bas="style"/.test(tag)) {
        replacements.push([tag, '']);
        droppedPreloads++;
      }
    }
    for (const [from, to] of replacements) out = out.replace(from, to);

    // Astro's bundled module scripts (prefetch runtime, blog search, per-page
    // enhancements) are deferred by nature but Chrome still requests them at
    // High priority, which Lighthouse models as render-blocking. Nothing on
    // first paint depends on them, so let them queue behind fonts and images.
    out = out.replace(MODULE_SCRIPT, (tag) => {
      deprioritized++;
      return tag.replace('<script ', '<script fetchpriority="low" ');
    });

    if (out !== html) {
      await writeFile(path, out);
      files++;
      bytes += out.length - html.length;
    }
  }
}

await walk(distDir);

// Register the inlined theme script with the CSP.
const headersPath = join(distDir, '_headers');
const headers = await readFile(headersPath, 'utf8');
const scriptSrc = /(Content-Security-Policy:[^\n]*\bscript-src 'self')/g;
const hits = headers.match(scriptSrc)?.length ?? 0;
if (hits !== 1) {
  console.error(`inline-critical: expected exactly one "script-src 'self'" in _headers, found ${hits}`);
  process.exit(1);
}
await writeFile(headersPath, headers.replace(scriptSrc, `$1 'sha256-${themeHash}'`));

console.log(
  `  inline-critical: ${inlinedLinks} stylesheet link(s) + ${inlinedScripts} theme script(s) inlined, ` +
    `${droppedPreloads} style preload(s) dropped across ${files} HTML file(s) (+${(bytes / 1024).toFixed(0)}KB raw)`,
);
console.log(`  inline-critical: ${deprioritized} module script tag(s) marked fetchpriority="low"; per-page purge dropped ${(purgedBytes / 1024).toFixed(0)}KB of shared CSS in total`);
console.log(`  inline-critical: CSP script-src += 'sha256-${themeHash}'`);

if (inlinedScripts === 0 || inlinedLinks === 0) {
  console.error('inline-critical: nothing inlined — HTML/asset layout changed?');
  process.exit(1);
}
