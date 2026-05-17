#!/usr/bin/env node

/**
 * Blog post generator using Google Gemini API (free tier).
 *
 * Usage:
 *   node scripts/generate-post-gemini.js git           # from recent git activity
 *   node scripts/generate-post-gemini.js topic "..."   # on a specific topic
 *   node scripts/generate-post-gemini.js auto          # AI picks a topic
 *
 * Environment:
 *   GEMINI_API_KEY        - required
 *   GEMINI_MODEL          - optional, defaults to "gemini-2.5-flash"
 *   GEMINI_EMBED_MODEL    - optional, defaults to "text-embedding-004"
 *   SEMANTIC_THRESHOLD    - optional, cosine cutoff for dedupe (default 0.85)
 */

import { runGenerator } from './lib/blog-post.js';

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.0-flash,gemini-2.5-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);
const MODELS = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter(m => m !== PRIMARY_MODEL)];
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';
const apiUrlFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const embedUrlFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [2000, 5000];

async function generate({ system, user, maxTokens = 2500, temperature = 0.7 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      // Disable Gemini 2.5 Flash "thinking" so reasoning tokens don't eat the output budget.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let lastErr = '';
  for (const model of MODELS) {
    console.log(`Calling Gemini model: ${model}`);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await fetch(apiUrlFor(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
        if (text) return text;
        console.error('Gemini API returned no text. Full response:', JSON.stringify(data));
        process.exit(1);
      }

      lastErr = `[${model}] ${res.status}: ${await res.text()}`;

      // Non-retryable errors (e.g., 400 bad request, 401/403 auth) — fail fast.
      if (!RETRYABLE_STATUS.has(res.status)) {
        console.error(`Gemini API error ${lastErr}`);
        process.exit(1);
      }

      if (attempt === RETRY_DELAYS.length) {
        console.warn(`[${model}] retries exhausted, trying next fallback model...`);
        break;
      }

      const wait = RETRY_DELAYS[attempt];
      console.warn(`[${model}] ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  console.error(`All Gemini models exhausted. Last error: ${lastErr}`);
  process.exit(1);
}

// Embedding adapter: a tiny single-shot fetch — no retry, no fallback to a
// different embedding model, since `findMostSimilarSemantic` already falls
// back to lexical Jaccard if this throws.
async function embed(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const res = await fetch(embedUrlFor(EMBED_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('embed response missing values');
  }
  return values;
}

runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post-gemini.js',
  generate,
  embed,
  supportsAuto: true,
});
