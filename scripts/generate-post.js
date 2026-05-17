#!/usr/bin/env node

/**
 * Blog post generator using the Anthropic Claude API.
 *
 * Usage:
 *   node scripts/generate-post.js git           # from recent git activity
 *   node scripts/generate-post.js topic "..."   # on a specific topic
 *
 * Environment:
 *   ANTHROPIC_API_KEY  - required (read by the SDK)
 */

import Anthropic from '@anthropic-ai/sdk';
import { runGenerator } from './lib/blog-post.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const client = new Anthropic();

async function generate({ system, user, maxTokens = 2000 }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  // The SDK guarantees `content[0]` is a content block; for our text-only
  // prompts the first block is always text.
  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

runGenerator({
  argv: process.argv,
  providerName: 'scripts/generate-post.js',
  generate,
  // The Anthropic generator is invoked manually by a human, so we keep
  // `git` and `topic` behavior identical to the original — no `auto` fallback.
  supportsAuto: false,
});
