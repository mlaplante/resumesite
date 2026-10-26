#!/usr/bin/env node

/**
 * Blog post generator used by the daily workflow: Anthropic first, Gemini last.
 *
 * Usage:
 *   node scripts/generate-post-chain.js git           # from recent git activity
 *   node scripts/generate-post-chain.js topic "..."   # on a specific topic
 *   node scripts/generate-post-chain.js auto          # AI picks a topic
 *
 * Text generation tries Claude Opus 5.5, then Claude Sonnet 5.5 (see
 * scripts/lib/anthropic.js), then the existing Gemini chain (see
 * scripts/lib/gemini.js). Embeddings for semantic dedupe always come from
 * Gemini — Anthropic has no embeddings endpoint — so the dedupe signal is the
 * same whichever provider wrote the post.
 *
 * Environment:
 *   ANTHROPIC_API_KEY  - optional; without it the run goes straight to Gemini
 *   GEMINI_API_KEY     - required (embeddings + final fallback)
 *   GITHUB_OUTPUT      - optional; when set, `provider` and `model` are written
 *                        to it so the workflow can attribute the draft
 */

import { appendFileSync } from 'node:fs';
import { runGenerator } from './lib/blog-post.js';
import { createGenerate as createAnthropicGenerate } from './lib/anthropic.js';
import { generate as geminiGenerate, embed } from './lib/gemini.js';
import { createProviderChain } from './lib/provider-chain.js';

let anthropicModel = null;
const anthropicGenerate = createAnthropicGenerate({ onServed: (model) => { anthropicModel = model; } });

// Without a key every Anthropic model fails identically, so don't spend two
// doomed requests finding that out.
const providers = [{ name: 'gemini', generate: geminiGenerate }];
if (process.env.ANTHROPIC_API_KEY) {
  providers.unshift({ name: 'anthropic', generate: anthropicGenerate, currentModel: () => anthropicModel });
} else {
  console.warn('ANTHROPIC_API_KEY is not set; generating with Gemini only.');
}

const chain = createProviderChain(providers);

const result = await runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post-chain.js',
  generate: chain.generate,
  embed,
  supportsAuto: true,
});

const served = chain.lastServed();
if (result && served) {
  console.log(`Draft written by ${served.provider}${served.model ? ` (${served.model})` : ''}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `provider=${served.provider}\nmodel=${served.model ?? ''}\n`,
    );
  }
}
