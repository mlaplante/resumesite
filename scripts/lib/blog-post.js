// Shared helpers for the AI blog-post generators (Anthropic / Gemini / GitHub Models).
//
// Each provider script only needs to:
//   1. Implement an async `generate({ system, user })` that returns Markdown.
//   2. Call `runGenerator({ argv, providerName, generate, supportsAuto })`.
//
// Everything else — git log gathering, topic selection, dedupe, frontmatter,
// collision-safe file naming — lives here so the three scripts can't drift.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const POSTS_DIR = join(here, '..', '..', 'blog-src', 'src', 'content', 'posts');
const EMBEDDING_CACHE_PATH = join(here, '..', '.embeddings-cache.json');

export const DEFAULT_DAYS = 7;
// Tokens overlap >= this fraction of the combined significant vocabulary → treat as duplicate.
export const DUPLICATE_THRESHOLD = 0.5;
// Cosine similarity threshold for semantic embedding-based duplicate detection.
// Empirically: ~0.85 catches "X with eBPF" vs "X with Istio" but not unrelated
// posts. Tune via SEMANTIC_THRESHOLD env var.
export const SEMANTIC_THRESHOLD = Number(process.env.SEMANTIC_THRESHOLD ?? 0.85);
const PICK_TOPIC_MAX_ATTEMPTS = 4;

export const SYSTEM_PROMPT =
  `You are a skilled technical writer for Michael LaPlante's blog. Michael is an SVP of Information Security and Operations with 15+ years of experience. Write engaging, practical posts that share real insight. Use a professional but approachable tone. Include concrete examples and actionable takeaways. Focus on technical deep dives with meaningful code snippets, configuration examples, and hands-on engineering detail. Avoid making AI or machine learning the primary topic — keep the emphasis on code, infrastructure, and practical engineering.`;

// --- Temporary content focus (requested 2026-06-28) -----------------------
// For 45 days the daily auto-generated posts are steered toward cybersecurity
// and the governance of AI within cybersecurity. This is date-gated so the
// topic picker and writer prompts automatically revert to the defaults above
// once the window closes — no manual cleanup needed even though generation is
// fully automated by the GitHub Actions cron.
export const FOCUS_UNTIL = '2026-08-12'; // 45 days from 2026-06-28, inclusive

export function focusActive(today = new Date().toISOString().slice(0, 10)) {
  return today <= FOCUS_UNTIL;
}

const FOCUS_SYSTEM_PROMPT =
  `You are a skilled technical writer for Michael LaPlante's blog. Michael is an SVP of Information Security and Operations with 15+ years of experience. Write engaging, practical posts that share real insight. Use a professional but approachable tone. Include concrete examples and actionable takeaways. Focus on technical deep dives with meaningful detail. Center every post on cybersecurity — threat detection and response, secure architecture, incident response, identity and access management, cryptography in practice, vulnerability management, and cloud/infrastructure security — or on the governance of AI within security: AI risk management, model and data governance, securing AI/ML systems, and emerging AI security regulation and frameworks (e.g. NIST AI RMF, ISO/IEC 42001, the EU AI Act). When AI appears, frame it through a security and governance lens rather than as a general AI/ML tutorial. Include concrete examples, configuration, or commands where they illustrate the point.`;

// Returns the system prompt active for `today`, honoring the temporary focus.
export function activeSystemPrompt(today) {
  return focusActive(today) ? FOCUS_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

export const TOPIC_PICKER_SYSTEM =
  'You suggest blog post topics for a tech blog by an SVP of Information Security and Operations. Respond with ONLY a single topic title, nothing else.';

export function topicPickerPrompt(exclusions, today) {
  const list = exclusions.length
    ? `\nAlready covered (do NOT repeat these topics or anything semantically similar — pick something in a genuinely different area):\n${exclusions.map(t => `- ${t}`).join('\n')}`
    : '';
  if (focusActive(today)) {
    return `Suggest one fresh, specific blog post topic about cybersecurity, or about the governance of AI within cybersecurity. Good cybersecurity areas: threat detection and response, secure system and network architecture, identity and access management, cryptography in practice, vulnerability and patch management, cloud and container security, security operations, and application security engineering. Good AI-governance areas: AI risk management frameworks (e.g. NIST AI RMF, ISO/IEC 42001), securing AI/ML pipelines and models, governing AI use within security programs, AI-driven threat detection oversight, and emerging AI security regulation. Keep the emphasis on security and governance rather than general AI/ML tutorials. Pick something timely and practical that a technical, security-minded audience would find valuable.${list}`;
  }
  return `Suggest one fresh, specific blog post topic focused on technical deep dives and hands-on code. Good areas: infrastructure automation, debugging techniques, performance optimization, DevOps tooling, security engineering (code-level), architecture patterns, or systems programming. AVOID topics primarily about AI, LLMs, or machine learning. Pick something timely and practical that a technical audience would find valuable.${list}`;
}

// Both user prompts share the same title-format instructions so every provider
// emits a parseable, well-formed title on the first non-empty line.
const TITLE_FORMAT_INSTRUCTIONS = [
  'Output exactly this structure:',
  '  Line 1: `TITLE: <your title>` — a clear, human-readable title in Title Case.',
  '            No slashes, no file extensions, no code identifiers. 4–14 words.',
  '  Line 2: blank',
  '  Line 3+: the post body in Markdown, starting with a single `# <title>` heading.',
  'Do NOT include YAML frontmatter; the toolchain adds it.',
].join('\n');

export function gitUserPrompt(log) {
  return `Based on this recent git activity, write an engaging blog post about what was built or fixed. Focus on the "why" and interesting technical decisions.\n\nGit log:\n${log}\n\n${TITLE_FORMAT_INSTRUCTIONS}`;
}

export function topicUserPrompt(topic) {
  return `Write an engaging, informative blog post about the following topic.\n\nTopic: ${topic}\n\n${TITLE_FORMAT_INSTRUCTIONS}`;
}

export function getGitLog(days = DEFAULT_DAYS) {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
    // execFileSync with an argv array: nothing is ever interpreted by a shell.
    return execFileSync('git', ['log', `--since=${since}`, '--oneline', '--no-merges'], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// Read the frontmatter of every published post and draft. Returns a richer
// shape than `getExistingPostTitles` so semantic comparisons can use the
// excerpt as well as the title.
export function getExistingPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const files = readdirSync(POSTS_DIR).map(f => join(POSTS_DIR, f));
  return files
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(f, 'utf-8');
      const title = content.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? null;
      const excerpt = content.match(/^excerpt:\s*"?(.+?)"?\s*$/m)?.[1] ?? '';
      return title ? { title, excerpt, file: f } : null;
    })
    .filter(Boolean);
}

export function getExistingPostTitles() {
  return getExistingPosts().map(p => p.title);
}

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// File extensions / code identifiers that a title must NOT end with, and
// patterns that strongly suggest the LLM regurgitated a code identifier
// instead of a human title (e.g. `templates/k8srequiredlabels.yaml`).
const FILE_EXTENSIONS = /\.(?:yaml|yml|json|md|markdown|html?|xml|toml|ini|css|scss|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|c|h|cpp|hpp|java|kt|swift|sql|conf|env|lock|dockerfile)$/i;
const STRIPPABLE_WRAPPERS = /^[\s"'`*_#\-:>]+|[\s"'`*_#\-:>]+$/g;

export function isValidTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  // Plausible length: ban very short ("AWS Side") and very long (rambling) outputs.
  if (t.length < 12 || t.length > 160) return false;
  // No path separators — file paths shouldn't become article titles.
  if (/[\/\\]/.test(t)) return false;
  // No file extension suffix.
  if (FILE_EXTENSIONS.test(t)) return false;
  // Must contain at least one letter and at least one space (multi-word).
  if (!/[A-Za-z]/.test(t) || !/\s/.test(t)) return false;
  // No leading "title:" / "TITLE:" / "Topic:" residue from prompt confusion.
  if (/^(?:title|topic|heading|subject)\s*:/i.test(t)) return false;
  // Doesn't look like a code identifier (snake_case, kebab-case dominated, dotted).
  // Reject if 75%+ of words are lowercase with underscores/dots/dashes-only.
  const words = t.split(/\s+/);
  const codey = words.filter(w => /[._]/.test(w) || (/^[a-z0-9-]+$/.test(w) && w.length > 6)).length;
  if (codey / words.length >= 0.75) return false;
  return true;
}

// Try, in order:
//   1. An explicit `TITLE: <title>` line near the top of the document.
//   2. The first H1 heading.
// Both candidates are stripped of common Markdown wrappers (backticks, *, _)
// and passed through `isValidTitle` so a bad LLM output (file path, snake_case
// identifier, slash-bearing code) is rejected.
export function extractTitle(content) {
  if (typeof content !== 'string') return null;

  // 1. TITLE: directive on its own line — search only the first ~20 lines so
  //    a later log/code block that mentions "TITLE:" doesn't accidentally win.
  const head = content.split('\n', 20).join('\n');
  const titleDirective = head.match(/^\s*TITLE:\s*(.+?)\s*$/m);
  if (titleDirective) {
    const cleaned = titleDirective[1].replace(STRIPPABLE_WRAPPERS, '');
    if (isValidTitle(cleaned)) return cleaned;
  }

  // 2. First H1 heading — but only if it sits at the top-level, not inside a
  //    fenced code block. We track fence state line by line.
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+)$/);
    if (m) {
      const cleaned = m[1].replace(STRIPPABLE_WRAPPERS, '');
      if (isValidTitle(cleaned)) return cleaned;
      // First H1 was malformed — don't fall through to subsequent ones either,
      // since downstream H1s are unusual in well-formed posts and likely also
      // bogus.
      return null;
    }
  }
  return null;
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

// === Semantic dedupe ========================================================
//
// Lexical Jaccard misses near-duplicates that only differ in surface tokens
// ("Zero-Trust Segmentation with eBPF" vs "Zero-Trust Segmentation with
// Istio"). The semantic path embeds both the candidate and every existing
// post (title + excerpt) and uses cosine similarity instead.
//
// Embeddings are cached on disk keyed by SHA-256 of the input text, so a
// daily run only embeds the new candidate (~1 API call) instead of all 70+
// posts again.

function loadEmbeddingCache() {
  try {
    return JSON.parse(readFileSync(EMBEDDING_CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveEmbeddingCache(cache) {
  try {
    writeFileSync(EMBEDDING_CACHE_PATH, JSON.stringify(cache));
  } catch (err) {
    console.warn('Could not persist embedding cache:', err.message);
  }
}

function textKey(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Combine a post's title and excerpt into one embedding input. Excerpt may be
// missing (older drafts) — fall back gracefully.
function postText(post) {
  const excerpt = post.excerpt ? `\n\n${post.excerpt}` : '';
  return `${post.title}${excerpt}`;
}

// Get the embedding for `text`, hitting the on-disk cache first.
export async function getEmbedding(text, embed, cache) {
  const key = textKey(text);
  if (cache[key]) return cache[key];
  const vec = await embed(text);
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('Embedding function returned a non-vector');
  }
  cache[key] = vec;
  return vec;
}

// Find the most semantically similar existing post to `candidate`.
//   candidate:    { title, excerpt? }
//   existing:     Array<{ title, excerpt? }>
//   embed:        async (text) => number[]
// Returns { score, title }. Persists the cache on completion.
export async function findMostSimilarSemantic(candidate, existing, embed) {
  if (typeof embed !== 'function') {
    throw new TypeError('findMostSimilarSemantic requires an `embed` function');
  }
  const cache = loadEmbeddingCache();
  let best = { score: 0, title: null };
  try {
    const candVec = await getEmbedding(postText(candidate), embed, cache);
    for (const post of existing) {
      const vec = await getEmbedding(postText(post), embed, cache);
      const score = cosine(candVec, vec);
      if (score > best.score) best = { score, title: post.title };
    }
  } finally {
    saveEmbeddingCache(cache);
  }
  return best;
}

// Pick a candidate topic from the LLM, retrying up to N times if it duplicates
// an existing post. When an `embed` adapter is supplied, dedupe is done via
// embedding cosine similarity (catches "with eBPF" vs "with Istio" rewrites);
// without it, falls back to lexical Jaccard.
export async function pickUniqueTopic(generate, existingPosts, embed) {
  // Tolerate either a list of titles (legacy) or a list of { title, excerpt }.
  const posts = existingPosts.map(p => (typeof p === 'string' ? { title: p, excerpt: '' } : p));
  const titles = posts.map(p => p.title);
  const rejected = [];

  for (let i = 0; i < PICK_TOPIC_MAX_ATTEMPTS; i++) {
    const candidate = (
      await generate({
        system: TOPIC_PICKER_SYSTEM,
        user: topicPickerPrompt([...titles, ...rejected]),
        maxTokens: 100,
      })
    ).trim().replace(/^["']|["']$/g, '');

    const { score, title: similarTo, mode } = await scoreSimilarity(
      { title: candidate, excerpt: '' },
      posts,
      embed,
    );
    const threshold = mode === 'semantic' ? SEMANTIC_THRESHOLD : DUPLICATE_THRESHOLD;

    if (score < threshold) {
      if (i > 0) console.log(`Accepted unique topic on attempt ${i + 1}.`);
      return candidate;
    }
    console.warn(
      `Rejected candidate "${candidate}" — ${(score * 100).toFixed(0)}% ${mode} similarity to existing "${similarTo}".`,
    );
    rejected.push(candidate);
  }
  throw new Error(`Could not find a sufficiently unique topic after ${PICK_TOPIC_MAX_ATTEMPTS} attempts.`);
}

// Pick the best similarity signal we can compute. If embedding fails (rate
// limit, transient error), fall back to lexical Jaccard so the pipeline
// degrades gracefully instead of aborting.
async function scoreSimilarity(candidate, posts, embed) {
  if (typeof embed === 'function') {
    try {
      const { score, title } = await findMostSimilarSemantic(candidate, posts, embed);
      return { score, title, mode: 'semantic' };
    } catch (err) {
      console.warn(`Semantic similarity failed (${err.message}); falling back to lexical.`);
    }
  }
  const { score, title } = findMostSimilar(candidate.title, posts.map(p => p.title));
  return { score, title, mode: 'lexical' };
}

// Strip the leading `TITLE: ...` directive and any immediately-following
// blank line so it doesn't leak into the published post body.
export function stripTitleDirective(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/^\s*TITLE:\s*.+?(?:\r?\n\s*\r?\n|\r?\n|$)/, '');
}

export function makeExcerpt(content) {
  const text = stripTitleDirective(content)
    .replace(/^#.+\n+/, '')
    .replace(/[#*`\[\]]/g, '')
    .trim();
  let sliced = text.slice(0, 150);
  // If the 150-char cut lands mid-word, back up to the last word boundary so
  // the ellipsis never splits a word (which also trips the CI spell check).
  if (/\S/.test(text[150] ?? '') && /\s\S+$/.test(sliced)) {
    sliced = sliced.replace(/\s+\S+$/, '');
  }
  return sliced.trim() + '...';
}

// Optionally groups a post into a multi-part series. When `series` is supplied
// the lines are emitted as real frontmatter; otherwise a commented hint is left
// so a human reviewer can opt the draft into a series at publish time. The hint
// is a YAML comment, so it's ignored by the content-collection schema either way.
export function buildFrontmatter({ title, date, category, excerpt, series, seriesOrder }) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const seriesLines = series
    ? `series: "${esc(series)}"\nseriesOrder: ${Number.isFinite(seriesOrder) ? seriesOrder : 1}\n`
    : `# series: ""      # optional: set the same value on every part of a multi-part series\n# seriesOrder: 1   # this post's position within that series\n`;
  return `---
title: "${esc(title)}"
date: ${date}
category: "${category}"
tags: []
${seriesLines}excerpt: "${esc(excerpt)}"
---`;
}

export function writePostCollisionSafe({ slug, date, content }) {
  mkdirSync(POSTS_DIR, { recursive: true });
  let filename = `${date}-${slug}.md`;
  let filepath = join(POSTS_DIR, filename);
  for (let n = 2; existsSync(filepath); n++) {
    filename = `${date}-${slug}-${n}.md`;
    filepath = join(POSTS_DIR, filename);
  }
  writeFileSync(filepath, content);
  return { filename, filepath };
}

// Run the standard mode-dispatched flow used by every provider:
//   - 'git' — use recent git log; falls back to 'auto' when there's no activity.
//   - 'auto' — pick a fresh topic, then write a post.
//   - 'topic' — write on the supplied topic.
//
// Providers may pass an `embed` adapter (async fn that returns an embedding
// vector for a string). When supplied, dedupe is done semantically; otherwise
// the cheap lexical Jaccard check is used.
export async function runGenerator({ argv, providerName, generate, embed, supportsAuto = true }) {
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
    const existing = getExistingPosts();
    topic = await pickUniqueTopic(generate, existing, embed);
    console.log(`Auto-selected topic: ${topic}`);
    mode = 'topic';
  }

  if (mode === 'topic') {
    userPrompt = topicUserPrompt(topic);
  }

  // Try once, and if the LLM emits an unparseable / file-path-style title,
  // give it one more shot with a stronger nudge before giving up.
  let content = await generate({ system: activeSystemPrompt(), user: userPrompt });
  let title = extractTitle(content);
  if (!title) {
    console.warn('First response had no parseable title; retrying with stricter instructions.');
    content = await generate({
      system: activeSystemPrompt(),
      user: `${userPrompt}\n\nIMPORTANT: Your previous response did not begin with a "TITLE: ..." line. Start your response with exactly:\nTITLE: <a clear, human-readable title in Title Case, with no slashes, no file extensions, and no code identifiers>`,
    });
    title = extractTitle(content);
  }
  if (!title) {
    console.error('Refusing to write post: could not extract a valid title from the LLM response.');
    process.exit(1);
  }

  // Final guard against duplicates the LLM may have drifted into, even when
  // the originally-picked topic was unique. Uses the post body's excerpt to
  // give the semantic check more signal than the title alone.
  if (supportsAuto && !fromGit) {
    const existing = getExistingPosts();
    const excerpt = makeExcerpt(content);
    const { score, title: similarTo, mode: simMode } = await scoreSimilarity(
      { title, excerpt },
      existing,
      embed,
    );
    const threshold = simMode === 'semantic' ? SEMANTIC_THRESHOLD : DUPLICATE_THRESHOLD;
    if (score >= threshold) {
      console.error(
        `Refusing to write duplicate post. Generated title "${title}" is ${(score * 100).toFixed(0)}% ${simMode} similarity to existing "${similarTo}".`,
      );
      process.exit(1);
    }
  }

  const slug = slugify(title);
  const date = new Date().toISOString().split('T')[0];
  const category = fromGit ? 'project-update' : 'thought-leadership';
  const body = stripTitleDirective(content);
  const excerpt = makeExcerpt(body);
  const frontmatter = buildFrontmatter({ title, date, category, excerpt });
  const fullPost = `${frontmatter}\n\n${body}`;

  const { filename, filepath } = writePostCollisionSafe({ slug, date, content: fullPost });
  console.log(`Post saved: blog-src/src/content/posts/${filename}`);
  return { filename, filepath, title };
}
