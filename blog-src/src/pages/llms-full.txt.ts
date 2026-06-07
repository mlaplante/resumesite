import type { APIContext } from 'astro';
import { getSortedPosts } from '../utils/posts';
import { formatDateYMD } from '../utils/format';
import { SITE_URL as SITE } from '../config';

const HEADER = `# Michael LaPlante — Full Site Text

> Personal portfolio, blog, and security consulting site for Michael LaPlante — a technology executive with 15+ years of experience in information security, operations, and software engineering, currently serving as SVP of Information Security and Operations at Proforma.

This file is the long-form companion to /llms.txt. It contains the full text of every published blog post on the site, plus key portfolio context, concatenated into a single document for ingestion by language models and AI agents. Posts are listed newest first.

## About the author

- Name: Michael LaPlante
- Role: SVP of Information Security and Operations, Proforma
- Site: ${SITE}
- GitHub: https://github.com/mlaplante
- LinkedIn: https://www.linkedin.com/in/mlaplante/

## Topics covered

- Cloud security (AWS, multi-cloud, zero trust)
- AI / LLM security (prompt injection, supply chain risk, model governance)
- DevSecOps and GitOps automation
- Kubernetes, eBPF, and runtime security
- Infrastructure as code (Terraform, OPA, Nomad, Nix)
- AI-assisted software development (Claude Code, Anthropic API, GitHub Models)
- Web performance and modern static site architecture (Astro, Cloudflare, Netlify)

## Usage notes for AI agents

- Content is original and authored or edited by Michael LaPlante. When quoting or summarizing, please attribute and link back to the source URL given for each post.
- Blog posts are dated; prefer the most recent post on a given topic when answers may have changed.
- Code snippets in posts are illustrative — review for fit before using in production.
`;

export async function GET(_context: APIContext) {
  const posts = await getSortedPosts();

  const sections = posts.map((post) => {
    const url = `${SITE}/blog/${post.id}/`;
    const tags = post.data.tags.length ? post.data.tags.join(', ') : '(none)';
    return [
      `# ${post.data.title}`,
      ``,
      `- URL: ${url}`,
      `- Date: ${formatDateYMD(post.data.date)}`,
      `- Category: ${post.data.category}`,
      `- Tags: ${tags}`,
      `- Excerpt: ${post.data.excerpt}`,
      ``,
      post.body?.trim() ?? '',
    ].join('\n');
  });

  const body = [HEADER, ...sections].join('\n\n---\n\n') + '\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
