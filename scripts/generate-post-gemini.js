#!/usr/bin/env node

/**
 * Blog post generator using Google Gemini API (free tier).
 *
 * Usage:
 *   node scripts/generate-post-gemini.js git          # from recent git activity
 *   node scripts/generate-post-gemini.js topic "..."  # on a specific topic
 *   node scripts/generate-post-gemini.js auto         # AI picks a topic
 *
 * Environment:
 *   GEMINI_API_KEY  - required
 *   GEMINI_MODEL    - optional, defaults to "gemini-2.5-flash"
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const DRAFTS_DIR = join(import.meta.dirname, '..', 'blog-src', 'src', 'content', 'drafts');
const POSTS_DIR = join(import.meta.dirname, '..', 'blog-src', 'src', 'content', 'posts');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function callGemini({ system, user, maxTokens = 2500, temperature = 0.7 }) {
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

  const delays = [2000, 5000, 15000, 30000];
  let lastErr = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const res = await fetch(API_URL, {
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

    lastErr = `${res.status}: ${await res.text()}`;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === delays.length) break;
    const wait = delays[attempt];
    console.warn(`Gemini API ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})...`);
    await new Promise(r => setTimeout(r, wait));
  }

  console.error(`Gemini API error ${lastErr}`);
  process.exit(1);
}

async function pickTopic(existingTitles) {
  const titleList = existingTitles.length
    ? `\nExisting posts (do NOT repeat these topics):\n${existingTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const content = await callGemini({
    system: 'You suggest blog post topics for a tech blog by an SVP of Information Security and Operations. Respond with ONLY a single topic title, nothing else.',
    // TEMP content focus — revert after 2026-04-26
    user: `Suggest one fresh, specific blog post topic focused on technical deep dives and hands-on code. Good areas: infrastructure automation, debugging techniques, performance optimization, DevOps tooling, security engineering (code-level), architecture patterns, or systems programming. AVOID topics primarily about AI, LLMs, or machine learning. Pick something timely and practical that a technical audience would find valuable.${titleList}`,
    maxTokens: 100,
  });

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

  const content = await callGemini({ system: systemPrompt, user: userPrompt });

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
  console.error('Usage: node scripts/generate-post-gemini.js topic "Your topic here"');
  process.exit(1);
}

generatePost({ mode, topic, days });
