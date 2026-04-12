#!/usr/bin/env node

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DRAFTS_DIR = join(import.meta.dirname, '..', 'blog-src', 'src', 'content', 'drafts');

function getGitLog(days = 7) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    return execSync(`git log --since="${since}" --oneline --no-merges`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function generatePost({ mode, topic, days }) {
  const client = new Anthropic();

  let prompt;
  if (mode === 'git') {
    const log = getGitLog(days);
    if (!log.trim()) {
      console.error('No git activity found in the last', days, 'days.');
      process.exit(1);
    }
    // TEMP content focus — revert after 2026-04-26
    prompt = `You are writing a blog post for Michael LaPlante's tech blog. Based on this recent git activity, write an engaging technical deep dive about what was built or fixed. Focus on the "why" and interesting technical decisions, not just listing commits. Include meaningful code snippets, architecture details, or configuration examples. Keep the emphasis on hands-on engineering — avoid making AI the primary topic.

Git log:
${log}

Write the post in Markdown. Do NOT include frontmatter — I will add that separately.`;
  } else {
    // TEMP content focus — revert after 2026-04-26
    prompt = `You are writing a blog post for Michael LaPlante's tech blog. Write an engaging, technically detailed post about the following topic. Michael is an SVP of Information Security and Operations with 15+ years of experience. Include code snippets, configuration examples, or architecture diagrams where relevant. Focus on hands-on engineering depth — avoid making AI the primary topic.

Topic: ${topic}

Write the post in Markdown. Do NOT include frontmatter — I will add that separately.`;
  }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = message.content[0].text;
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1] : topic || 'Untitled Post';
  const slug = slugify(title);
  const date = new Date().toISOString().split('T')[0];
  const category = mode === 'git' ? 'project-update' : 'thought-leadership';

  const excerpt = content
    .replace(/^#.+\n+/, '')
    .replace(/[#*`\[\]]/g, '')
    .trim()
    .slice(0, 150)
    .trim() + '...';

  const frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
category: "${category}"
tags: []
excerpt: "${excerpt.replace(/"/g, '\\"')}"
---`;

  const fullPost = `${frontmatter}\n\n${content}`;

  mkdirSync(DRAFTS_DIR, { recursive: true });
  const filename = `${date}-${slug}.md`;
  const filepath = join(DRAFTS_DIR, filename);
  writeFileSync(filepath, fullPost);

  console.log(`Draft saved to: blog-src/src/content/drafts/${filename}`);
  console.log('Review, edit, then move to blog-src/src/content/posts/ to publish.');
}

// Parse CLI args
const args = process.argv.slice(2);
const mode = args[0] || 'git'; // 'git' or 'topic'
const topic = args.slice(1).join(' ');
const days = 7;

if (mode === 'topic' && !topic) {
  console.error('Usage: node scripts/generate-post.js topic "Your topic here"');
  process.exit(1);
}

generatePost({ mode, topic, days });
