#!/usr/bin/env node

/**
 * Scan every post in blog-src/src/content/posts/ and report which ones
 * have a meaningful post-publish content edit (any commit later than the
 * frontmatter `date:` AND that commit's diff modifies content rather than
 * just being the initial import/move).
 *
 * In --apply mode, the script writes an `updated: YYYY-MM-DD` line into
 * the frontmatter of any matching post.
 *
 * Usage:
 *   node scripts/backfill-updated.js              # dry-run report
 *   node scripts/backfill-updated.js --apply      # rewrite frontmatter
 *
 * The "significant edit" heuristic:
 *   - Skip the first commit that touched the file (treats it as the import).
 *   - Skip commits whose patch is purely a rename / `git mv` (zero +/- lines
 *     inside the file body).
 *   - The most recent commit that survives both filters wins.
 *
 * That eliminates the false positives from the bulk-import / publish flow
 * where every old post shows a synthetic ~35-day delta between its
 * frontmatter date and its first git commit.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');
const POSTS_DIR = join(REPO_ROOT, 'blog-src', 'src', 'content', 'posts');

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { raw: m[0], body: content.slice(m[0].length), data: out };
}

// Find the most recent commit that touched `file` with non-trivial content
// changes, ignoring renames and the original import commit.
function lastContentCommit(file) {
  const rel = relative(REPO_ROOT, file);
  const log = execSync(
    `git log --follow --diff-filter=M --pretty=format:%H%x09%ai -- "${rel}"`,
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  ).trim();
  if (!log) return null;
  // First line is the most recent modify commit. (We already excluded adds
  // and renames via --diff-filter=M.)
  const [hash, isoDate] = log.split('\n')[0].split('\t');
  return { hash, date: isoDate.split(' ')[0] };
}

function rewriteFrontmatter(raw, addedKey, addedValue) {
  // Insert `updated: ...` right after the `date:` line; if `updated:` is
  // already present, replace its value instead of duplicating the key.
  if (/^updated:/m.test(raw)) {
    return raw.replace(/^updated:.*$/m, `${addedKey}: ${addedValue}`);
  }
  return raw.replace(/^(date:.*)$/m, `$1\n${addedKey}: ${addedValue}`);
}

const APPLY = process.argv.includes('--apply');
const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
const changes = [];

for (const filename of files) {
  const fullPath = join(POSTS_DIR, filename);
  const content = readFileSync(fullPath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm || !fm.data.date) continue;

  const publishDate = String(fm.data.date).slice(0, 10);
  const commit = lastContentCommit(fullPath);
  if (!commit) continue;

  // Only flag posts whose latest content edit is at least 1 day after
  // the publish date in frontmatter.
  if (commit.date <= publishDate) continue;

  changes.push({ filename, publishDate, updated: commit.date, hash: commit.hash });

  if (APPLY) {
    const newRaw = rewriteFrontmatter(fm.raw, 'updated', commit.date);
    writeFileSync(fullPath, newRaw + fm.body);
  }
}

if (changes.length === 0) {
  console.log('No posts qualify for an `updated:` backfill.');
  process.exit(0);
}

console.log(`${APPLY ? 'Applied' : 'Would apply'} updated: to ${changes.length} posts:`);
for (const c of changes) {
  console.log(`  ${c.filename}`);
  console.log(`    published: ${c.publishDate}    last edit: ${c.updated}    (${c.hash.slice(0, 8)})`);
}
if (!APPLY) {
  console.log('\nRe-run with --apply to write the changes.');
}
