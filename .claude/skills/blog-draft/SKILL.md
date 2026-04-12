---
name: blog-draft
description: Generate a blog post draft from the current Claude Code session. Use when asked to "draft a blog post", "write a blog post", or "blog about this session".
---

# Blog Draft Generator

Generate a Markdown blog draft from the current session and save it to the drafts folder.

## Process

1. Summarize what was accomplished in this session
2. Identify the most interesting technical decisions, problems solved, or patterns used
3. Write an engaging blog post in Markdown targeting a technical audience
4. Save to `blog-src/src/content/drafts/` with proper frontmatter

## Frontmatter Template

The draft must include this frontmatter:

```yaml
---
title: "Descriptive Title"
date: YYYY-MM-DD
category: "dev-session"
tags: ["relevant", "tags"]
excerpt: "One sentence summary..."
---
```

## Content Focus (temporary — expires 2026-04-26)

For the next two weeks, prioritize **technical deep dives and code-focused content**:
- Favor topics like architecture decisions, debugging war stories, infrastructure automation, performance optimization, code patterns, DevOps tooling, and hands-on engineering walkthroughs
- **Avoid AI-centric topics** (no posts primarily about AI, LLMs, or machine learning — mentioning AI incidentally is fine)
- Include meaningful code snippets, configuration examples, or CLI commands whenever possible

## Guidelines

- Write in first person from Michael's perspective
- Focus on the "why" — what problem was being solved and why the approach was chosen
- Include code snippets where they illustrate interesting decisions
- Keep it concise: 500-1000 words
- Use a conversational but professional tone
- File naming: `YYYY-MM-DD-descriptive-slug.md`
- Save to: `blog-src/src/content/drafts/`
- Remind the user to review and move to `blog-src/src/content/posts/` when ready to publish
