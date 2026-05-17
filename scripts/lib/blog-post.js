// Shared helpers for the AI blog-post generators (Anthropic / Gemini / GitHub Models).
//
// Each provider script only needs to:
//   1. Implement an async `generate({ system, user })` that returns Markdown.
//   2. Call `runGenerator({ argv, providerName, generate, supportsAuto })`.
//
// Everything else — git log gathering, topic selection, dedupe, frontmatter,
// collision-safe file naming — lives here so the three scripts can't drift.

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const DRAFTS_DIR = join(here, '..', '..', 'blog-src', 'src', 'content', 'drafts');
export const POSTS_DIR = join(here, '..', '..', 'blog-src', 'src', 'content', 'posts');

export const DEFAULT_DAYS = 7;
// Tokens overlap >= this fraction of the combined significant vocabulary → treat as duplicate.
export const DUPLICATE_THRESHOLD = 0.5;
const PICK_TOPIC_MAX_ATTEMPTS = 4;

export const SYSTEM_PROMPT =
  `You are a skilled technical writer for Michael LaPlante's blog. Michael is an SVP of Information Security and Operations with 15+ years of experience. Write engaging, practical posts that share real insight. Use a professional but approachable tone. Include concrete examples and actionable takeaways. Focus on technical deep dives with meaningful code snippets, configuration examples, and hands-on engineering detail. Avoid making AI or machine learning the primary topic — keep the emphasis on code, infrastructure, and practical engineering.`;

export const TOPIC_PICKER_SYSTEM =
  'You suggest blog post topics for a tech blog by an SVP of Information Security and Operations. Respond with ONLY a single topic title, nothing else.';

export function topicPickerPrompt(exclusions) {
  const list = exclusions.length
    ? `\nAlready covered (do NOT repeat these topics or anything semantically similar — pick something in a genuinely different area):\n${exclusions.map(t => `- ${t}`).join('\n')}`
    : '';
  return `Suggest one fresh, specific blog post topic focused on technical deep dives and hands-on code. Good areas: infrastructure automation, debugging techniques, performance optimization, DevOps tooling, security engineering (code-level), architecture patterns, or systems programming. AVOID topics primarily about AI, LLMs, or machine learning. Pick something timely and practical that a technical audience would find valuable.${list}`;
}

export function gitUserPrompt(log) {
  return `Based on this recent git activity, write an engaging blog post about what was built or fixed. Focus on the "why" and interesting technical decisions.\n\nGit log:\n${log}\n\nWrite in Markdown. Do NOT include frontmatter.`;
}

export function topicUserPrompt(topic) {
  return `Write an engaging, informative blog post about the following topic.\n\nTopic: ${topic}\n\nWrite in Markdown. Do NOT include frontmatter.`;
}

export function getGitLog(days = DEFAULT_DAYS) {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
    return execSync(`git log --since="${since}" --oneline --no-merges`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

export function getExistingPostTitles() {
  try {
    const files = [
      ...readdirSync(POSTS_DIR).map(f => join(POSTS_DIR, f)),
      ...(existsSync(DRAFTS_DIR) ? readdirSync(DRAFTS_DIR).map(f => join(DRAFTS_DIR, f)) : []),
    ];
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = readFileSync(f, 'utf-8');
        const match = content.match(/^title:\s*"?(.+?)"?\s*$/m);
        return match ? match[1] : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Small English stopword set — enough to stop "the/and/with" from inflating similarity.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'with', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'being', 'been', 'how', 'what', 'why', 'when', 'where', 'which',
  'your', 'my', 'our', 'their', 'its', 'using', 'use', 'via', 'as', 'that', 'this', 'these', 'those',
  'it', 'we', 'you', 'they', 'vs', 'into', 'out', 'up', 'down', 'about', 'over', 'under',
]);

function tokenize(title) {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function findMostSimilar(title, existingTitles) {
  const a = tokenize(title);
  let best = { score: 0, title: null };
  for (const existing of existingTitles) {
    const score = jaccard(a, tokenize(existing));
    if (score > best.score) best = { score, title: existing };
  }
  return best;
}

export async function pickUniqueTopic(generate, existingTitles) {
  const rejected = [];
  for (let i = 0; i < PICK_TOPIC_MAX_ATTEMPTS; i++) {
    const candidate = (
      await generate({
        system: TOPIC_PICKER_SYSTEM,
        user: topicPickerPrompt([...existingTitles, ...rejected]),
        maxTokens: 100,
      })
    ).trim().replace(/^["']|["']$/g, '');

    const similar = findMostSimilar(candidate, existingTitles);
    if (similar.score < DUPLICATE_THRESHOLD) {
      if (i > 0) console.log(`Accepted unique topic on attempt ${i + 1}.`);
      return candidate;
    }
    console.warn(
      `Rejected candidate "${candidate}" — ${(similar.score * 100).toFixed(0)}% similar to existing "${similar.title}".`
    );
    rejected.push(candidate);
  }
  throw new Error(`Could not find a sufficiently unique topic after ${PICK_TOPIC_MAX_ATTEMPTS} attempts.`);
}

export function makeExcerpt(content) {
  return content
    .replace(/^#.+\n+/, '')
    .replace(/[#*`\[\]]/g, '')
    .trim()
    .slice(0, 150)
    .trim() + '...';
}

export function buildFrontmatter({ title, date, category, excerpt }) {
  const esc = (s) => s.replace(/"/g, '\\"');
  return `---
title: "${esc(title)}"
date: ${date}
category: "${category}"
tags: []
excerpt: "${esc(excerpt)}"
---`;
}

export function writeDraftCollisionSafe({ slug, date, content }) {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  let filename = `${date}-${slug}.md`;
  let filepath = join(DRAFTS_DIR, filename);
  for (let n = 2; existsSync(filepath) || existsSync(join(POSTS_DIR, filename)); n++) {
    filename = `${date}-${slug}-${n}.md`;
    filepath = join(DRAFTS_DIR, filename);
  }
  writeFileSync(filepath, content);
  return { filename, filepath };
}

// Run the standard mode-dispatched flow used by every provider:
//   - 'git' — use recent git log; falls back to 'auto' when there's no activity.
//   - 'auto' — pick a fresh topic, then write a post.
//   - 'topic' — write on the supplied topic.
export async function runGenerator({ argv, providerName, generate, supportsAuto = true }) {
  const args = argv.slice(2);
  let mode = args[0] || (supportsAuto ? 'auto' : 'git');
  const topicArg = args.slice(1).join(' ');

  if (mode === 'topic' && !topicArg) {
    console.error(`Usage: node ${providerName} topic "Your topic here"`);
    process.exit(1);
  }

  let topic = topicArg;
  let userPrompt;
  // The category depends on whether we sourced content from real git activity
  // vs. anything else. Track that here so the post-auto-fallback reassignment
  // of `mode` doesn't lose the signal.
  let fromGit = false;

  if (mode === 'git') {
    const log = getGitLog(DEFAULT_DAYS);
    if (!log.trim()) {
      if (!supportsAuto) {
        console.error('No git activity found in the last', DEFAULT_DAYS, 'days.');
        process.exit(1);
      }
      console.log('No recent git activity. Falling back to auto topic.');
      mode = 'auto';
    } else {
      userPrompt = gitUserPrompt(log);
      fromGit = true;
    }
  }

  if (mode === 'auto') {
    const existing = getExistingPostTitles();
    topic = await pickUniqueTopic(generate, existing);
    console.log(`Auto-selected topic: ${topic}`);
    mode = 'topic';
  }

  if (mode === 'topic') {
    userPrompt = topicUserPrompt(topic);
  }

  const content = await generate({ system: SYSTEM_PROMPT, user: userPrompt });

  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1] : topic || 'Untitled Post';

  // Final guard against semantic duplicates the LLM may have drifted into.
  if (supportsAuto && !fromGit) {
    const existing = getExistingPostTitles();
    const similar = findMostSimilar(title, existing);
    if (similar.score >= DUPLICATE_THRESHOLD) {
      console.error(
        `Refusing to write duplicate post. Generated title "${title}" is ${(similar.score * 100).toFixed(0)}% similar to existing "${similar.title}".`
      );
      process.exit(1);
    }
  }

  const slug = slugify(title);
  const date = new Date().toISOString().split('T')[0];
  const category = fromGit ? 'project-update' : 'thought-leadership';
  const excerpt = makeExcerpt(content);
  const frontmatter = buildFrontmatter({ title, date, category, excerpt });
  const fullPost = `${frontmatter}\n\n${content}`;

  const { filename, filepath } = writeDraftCollisionSafe({ slug, date, content: fullPost });
  console.log(`Draft saved: blog-src/src/content/drafts/${filename}`);
  return { filename, filepath, title };
}
