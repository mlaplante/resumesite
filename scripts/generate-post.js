#!/usr/bin/env node

/**
 * Blog post generator using the Anthropic Claude API.
 *
 * Usage:
 *   node scripts/generate-post.js git           # from recent git activity
 *   node scripts/generate-post.js topic "..."   # on a specific topic
 *
 * The Claude transport (Opus 5.5 -> Sonnet 5.5 fallback, stop-reason
 * enforcement) lives in scripts/lib/anthropic.js. The daily workflow uses
 * scripts/generate-post-chain.js, which adds Gemini as a final fallback.
 *
 * Environment:
 *   ANTHROPIC_API_KEY  - required (read by the SDK)
 */

import { runGenerator } from './lib/blog-post.js';
import { generate } from './lib/anthropic.js';

runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post.js',
  generate,
  // The Anthropic generator is invoked manually by a human, so we keep
  // `git` and `topic` behavior identical to the original — no `auto` fallback.
  supportsAuto: false,
});
