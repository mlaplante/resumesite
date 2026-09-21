#!/usr/bin/env node

/**
 * Repair blog posts that were published mid-sentence.
 *
 * Until the generator started checking Gemini's `finishReason`, a response cut
 * short by the output-token cap came back as HTTP 200 with partial text and was
 * published as-is. 65 of the first 190 posts shipped that way — all of them
 * long technical pieces whose code examples ran past the old 2500-token budget.
 *
 * This script finds those posts, trims each back to a clean seam, and asks the
 * model to write the ending. The result has to pass `findTruncation` itself, so
 * a repair that comes back short is skipped rather than written.
 *
 * Usage:
 *   node scripts/repair-truncated-posts.js --list
 *   node scripts/repair-truncated-posts.js --dry-run --limit 3
 *   node scripts/repair-truncated-posts.js --limit 10
 *   node scripts/repair-truncated-posts.js --only 2026-06-15-demystifying-ioctl-...md
 *
 * Environment:
 *   GEMINI_API_KEY - required (except for --list)
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { POSTS_DIR, findTruncation } from './lib/blog-post.js';
import { generate } from './lib/gemini.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};

const LIST_ONLY = has('--list');
const DRY_RUN = has('--dry-run');
const LIMIT = Number(valueOf('--limit', Infinity));
// Jump one post to the front of the queue — for when a reader reports a
// specific post rather than waiting for the batch to reach it.
const ONLY = valueOf('--only', null);

const REPAIR_SYSTEM = [
  'You are finishing a half-written technical blog post for a senior security engineer.',
  'The text you are given was cut off mid-flow by a token limit. Write only the ending.',
  '',
  'Rules:',
  '- Continue seamlessly from the final line. Do not repeat, restate or summarise any text you were given.',
  '- Do not re-emit the title, the frontmatter, or any heading that already appears.',
  '- If a fenced code block is still open, finish that code and close it with a ``` line.',
  '- Match the existing voice, formatting and depth exactly.',
  '- Finish the section in progress, then close the post with a short conclusion of 2-4 sentences.',
  '- End on a complete sentence. Output raw Markdown only, with no commentary about this task.',
].join('\n');

// Cut the trailing partial line so the model resumes from a clean seam. A body
// truncated mid-token ("class_create(THIS_") gives it nothing to work with;
// dropping that line does. An unclosed ``` is deliberately left open — the
// prompt asks the model to finish and close the code block.
function trimToCleanSeam(body) {
  const lines = body.replace(/\s+$/, '').split('\n');
  if (lines.length > 1) lines.pop();
  return lines.join('\n').replace(/\s+$/, '');
}

function splitFrontmatter(raw) {
  const match = raw.match(/^---\n[\s\S]*?\n---\n/);
  return match
    ? { frontmatter: match[0], body: raw.slice(match[0].length) }
    : { frontmatter: '', body: raw };
}

function titleOf(frontmatter) {
  return frontmatter.match(/^title:\s*"(.*)"$/m)?.[1] ?? '(untitled)';
}

function findTruncatedPosts() {
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md') && /^[^_A-Z]/.test(f))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
      const { frontmatter, body } = splitFrontmatter(raw);
      return { file, frontmatter, body, reason: findTruncation(body) };
    })
    .filter((p) => p.reason);
}

async function repair(post) {
  const seam = trimToCleanSeam(post.body);
  const title = titleOf(post.frontmatter);

  const continuation = await generate({
    system: REPAIR_SYSTEM,
    user: `The post is titled "${title}". Here is everything written so far. Write only what comes next.\n\n${seam}`,
    temperature: 0.6,
  });

  const tail = continuation.replace(/^\s*\n+/, '').replace(/\s+$/, '');

  // How the two halves join depends on where the cut landed. Inside an open
  // code block the continuation is more code, so it belongs on the very next
  // line; in prose it starts a new block and needs a blank line, or Markdown
  // welds it onto the seam's last paragraph.
  const insideCodeBlock = (seam.match(/^\s*```/gm) || []).length % 2 !== 0;
  const body = `${seam}${insideCodeBlock ? '\n' : '\n\n'}${tail}\n`;

  const stillBroken = findTruncation(body);
  if (stillBroken) throw new Error(`repair still truncated: ${stillBroken}`);

  return `${post.frontmatter}${body}`;
}

let truncated = findTruncatedPosts();

if (ONLY) {
  const match = truncated.filter((p) => p.file === ONLY);
  if (match.length === 0) {
    console.error(`"${ONLY}" is not in the truncated set (already fine, or no such post).`);
    process.exit(1);
  }
  truncated = match;
}

if (truncated.length === 0) {
  console.log('No truncated posts found.');
  process.exit(0);
}

console.log(`Found ${truncated.length} truncated post(s).`);

if (LIST_ONLY) {
  for (const p of truncated) console.log(`  ${p.file}\n      ${p.reason}`);
  process.exit(0);
}

const batch = truncated.slice(0, LIMIT);
console.log(`Repairing ${batch.length} of them${DRY_RUN ? ' (dry run)' : ''}.\n`);

let repaired = 0;
const failures = [];

for (const post of batch) {
  console.log(`- ${post.file}\n    ${post.reason}`);
  try {
    const content = await repair(post);
    const added = content.length - (post.frontmatter.length + post.body.length);
    if (DRY_RUN) {
      console.log(`    would add ~${added} chars\n`);
    } else {
      writeFileSync(join(POSTS_DIR, post.file), content);
      console.log(`    repaired (+${added} chars)\n`);
    }
    repaired++;
  } catch (err) {
    console.warn(`    SKIPPED: ${err.message}\n`);
    failures.push(post.file);
  }
}

console.log(`Done: ${repaired} repaired, ${failures.length} skipped.`);
if (failures.length) console.log(`Skipped: ${failures.join(', ')}`);
// Skipped posts are left untouched and stay in the truncated set, so a later
// run picks them up again. Only a total wipeout is worth failing the job over.
if (repaired === 0) process.exit(1);
