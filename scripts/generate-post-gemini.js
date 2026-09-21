#!/usr/bin/env node

/**
 * Blog post generator using Google Gemini API (free tier).
 *
 * Usage:
 *   node scripts/generate-post-gemini.js git           # from recent git activity
 *   node scripts/generate-post-gemini.js topic "..."   # on a specific topic
 *   node scripts/generate-post-gemini.js auto          # AI picks a topic
 *
 * The Gemini transport (model fallback chain, retries, finish-reason
 * enforcement) lives in scripts/lib/gemini.js.
 */

import { runGenerator } from './lib/blog-post.js';
import { generate, embed } from './lib/gemini.js';

runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post-gemini.js',
  generate,
  embed,
  supportsAuto: true,
});
