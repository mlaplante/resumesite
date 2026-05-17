#!/usr/bin/env node

/**
 * Blog post generator using GitHub Models API.
 * Designed for use in GitHub Actions with GITHUB_TOKEN authentication.
 *
 * Usage:
 *   node scripts/generate-post-gh-models.js git           # from recent git activity
 *   node scripts/generate-post-gh-models.js topic "..."   # on a specific topic
 *   node scripts/generate-post-gh-models.js auto          # AI picks a topic
 *
 * Environment:
 *   GITHUB_TOKEN   - required, provided automatically in Actions
 *   GH_MODEL       - optional, defaults to "openai/gpt-4.1"
 *   GH_EMBED_MODEL - optional, defaults to "openai/text-embedding-3-small"
 */

import { runGenerator } from './lib/blog-post.js';

const API_URL = 'https://models.github.ai/inference/chat/completions';
const EMBED_URL = 'https://models.github.ai/inference/embeddings';
const MODEL = process.env.GH_MODEL || 'openai/gpt-4.1';
const EMBED_MODEL = process.env.GH_EMBED_MODEL || 'openai/text-embedding-3-small';

async function generate({ system, user, maxTokens = 2500, temperature = 0.7 }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`GitHub Models API error ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function embed(text) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN missing');
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('embed response missing values');
  }
  return vec;
}

runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post-gh-models.js',
  generate,
  embed,
  supportsAuto: true,
});
