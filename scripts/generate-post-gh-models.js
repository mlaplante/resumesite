#!/usr/bin/env node

/**
 * Blog post generator using GitHub Models API.
 * Designed for use in GitHub Actions with GITHUB_TOKEN authentication.
 *
 * Usage:
 *   node scripts/generate-post-gh-models.js git          # from recent git activity
 *   node scripts/generate-post-gh-models.js topic "..."  # on a specific topic
 *   node scripts/generate-post-gh-models.js auto         # AI picks a topic
 *
 * Environment:
 *   GITHUB_TOKEN  - required, provided automatically in Actions
 *   GH_MODEL      - optional, defaults to "openai/gpt-4.1"
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const DRAFTS_DIR = join(import.meta.dirname, '..', 'blog-src', 'src', 'content', 'drafts');
const POSTS_DIR = join(import.meta.dirname, '..', 'blog-src', 'src', 'content', 'posts');
const API_URL = 'https://models.github.ai/inference/chat/completions';
const MODEL = process.env.GH_MODEL || 'openai/gpt-4.1';

function getGitLog(days = 7) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    return execSync(`git log --since="${since}" --oneline --no-merges`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function getExistingPostTitles() {
  try {
    const files = [
      ...readdirSync(POSTS_DIR).map(f => join(POSTS_DIR, f)),
      ...readdirSync(DRAFTS_DIR).map(f => join(DRAFTS_DIR, f)),
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

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function callGitHubModels(messages) {
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
      messages,
      max_tokens: 2500,
      temperature: 0.7,
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

async function pickTopic(existingTitles) {
  const titleList = existingTitles.length
    ? `\nExisting posts (do NOT repeat these topics):\n${existingTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const content = await callGitHubModels([
    {
      role: 'system',
      content: 'You suggest blog post topics for a tech blog by an SVP of Information Security and Operations. Respond with ONLY a single topic title, nothing else.',
    },
    {
      role: 'user',
      // TEMP content focus — revert after 2026-04-26
      content: `Suggest one fresh, specific blog post topic focused on technical deep dives and hands-on code. Good areas: infrastructure automation, debugging techniques, performance optimization, DevOps tooling, security engineering (code-level), architecture patterns, or systems programming. AVOID topics primarily about AI, LLMs, or machine learning. Pick something timely and practical that a technical audience would find valuable.${titleList}`,
    },
  ]);

  return content.trim().replace(/^["']|["']$/g, '');
}

async function generatePost({ mode, topic, days }) {
  // TEMP content focus — revert after 2026-04-26
  const systemPrompt = `You are a skilled technical writer for Michael LaPlante's blog. Michael is an SVP of Information Security and Operations with 15+ years of experience. Write engaging, practical posts that share real insight. Use a professional but approachable tone. Include concrete examples and actionable takeaways. Focus on technical deep dives with meaningful code snippets, configuration examples, and hands-on engineering detail. Avoid making AI or machine learning the primary topic — keep the emphasis on code, infrastructure, and practical engineering.`;

  let userPrompt;
  if (mode === 'git') {
    const log = getGitLog(days);
    if (!log.trim()) {
      console.log('No recent git activity. Falling back to auto topic.');
      mode = 'auto';
    } else {
      userPrompt = `Based on this recent git activity, write an engaging blog post about what was built or fixed. Focus on the "why" and interesting technical decisions.\n\nGit log:\n${log}\n\nWrite in Markdown. Do NOT include frontmatter.`;
    }
  }

  if (mode === 'auto') {
    const existingTitles = getExistingPostTitles();
    topic = await pickTopic(existingTitles);
    console.log(`Auto-selected topic: ${topic}`);
    mode = 'topic';
  }

  if (mode === 'topic') {
    userPrompt = `Write an engaging, informative blog post about the following topic.\n\nTopic: ${topic}\n\nWrite in Markdown. Do NOT include frontmatter.`;
  }

  const content = await callGitHubModels([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

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

  console.log(`Draft saved: blog-src/src/content/drafts/${filename}`);
  return { filename, title, filepath };
}

// --- CLI ---
const args = process.argv.slice(2);
const mode = args[0] || 'auto';
const topic = args.slice(1).join(' ');
const days = 7;

if (mode === 'topic' && !topic) {
  console.error('Usage: node scripts/generate-post-gh-models.js topic "Your topic here"');
  process.exit(1);
}

generatePost({ mode, topic, days });
