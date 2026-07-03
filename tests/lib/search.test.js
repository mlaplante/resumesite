import { describe, it, expect } from 'vitest';

import {
  escapeHtml,
  filterPosts,
  renderPostCard,
  describeResults,
} from '../../blog-src/src/utils/search.ts';

const post = (overrides = {}) => ({
  title: 'Securing Kubernetes with eBPF',
  excerpt: 'A hands-on guide to runtime security.',
  category: 'dev-session',
  tags: ['kubernetes', 'ebpf'],
  url: '/blog/2026-05-01-securing-kubernetes-with-ebpf/',
  dateShort: 'May 1, 2026',
  dateISO: '2026-05-01T00:00:00.000Z',
  readTime: 7,
  ...overrides,
});

describe('escapeHtml', () => {
  it('escapes element and attribute breakouts', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a "quoted" \'value\' & more')).toBe('a &quot;quoted&quot; &#39;value&#39; &amp; more');
  });
  it('passes plain text through unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('filterPosts', () => {
  const posts = [
    post(),
    post({ title: 'Zero Trust with Istio', category: 'thought-leadership', tags: ['istio'] }),
    post({ title: 'Debugging Go Latency', category: 'dev-session', tags: ['golang', 'pprof'] }),
  ];

  it('returns everything for empty query + all categories', () => {
    expect(filterPosts(posts, '', 'all')).toHaveLength(3);
  });

  it('filters by category alone', () => {
    const out = filterPosts(posts, '', 'dev-session');
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.category === 'dev-session')).toBe(true);
  });

  it('matches query case-insensitively across title, excerpt, category, and tags', () => {
    expect(filterPosts(posts, 'ISTIO', 'all')).toHaveLength(1);
    expect(filterPosts(posts, 'pprof', 'all')[0].title).toBe('Debugging Go Latency');
    expect(filterPosts(posts, 'hands-on', 'all').length).toBeGreaterThan(0);
  });

  it('combines query and category', () => {
    expect(filterPosts(posts, 'ebpf', 'thought-leadership')).toHaveLength(0);
    expect(filterPosts(posts, 'ebpf', 'dev-session')).toHaveLength(1);
  });

  it('trims surrounding whitespace from the query', () => {
    expect(filterPosts(posts, '  istio  ', 'all')).toHaveLength(1);
  });
});

describe('renderPostCard', () => {
  it('escapes malicious content in every interpolated field', () => {
    const html = renderPostCard(
      post({
        title: '<script>alert(1)</script>',
        excerpt: '"onmouseover="alert(1)',
        category: 'x" onclick="alert(1)',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"onmouseover="');
    expect(html).not.toContain('onclick="alert');
  });

  it('stamps the Astro scoped-style attribute on every element', () => {
    const html = renderPostCard(post(), 'data-astro-cid-a7wiyce3');
    const tagCount = (html.match(/<(?:a|div|time|span|h2|p)[\s>]/g) ?? []).length;
    const scopedCount = (html.match(/data-astro-cid-a7wiyce3/g) ?? []).length;
    expect(scopedCount).toBe(tagCount);
  });

  it('falls back to 1 min read for a bogus readTime', () => {
    expect(renderPostCard(post({ readTime: NaN }))).toContain('1 min read');
  });
});

describe('describeResults', () => {
  it('reports no matches', () => {
    expect(describeResults(0, 'x', 'all')).toBe('No posts found.');
  });
  it('describes query matches across the archive', () => {
    expect(describeResults(3, 'ebpf', 'all')).toBe('3 results for “ebpf” across the whole blog');
    expect(describeResults(1, 'ebpf', 'all')).toBe('1 result for “ebpf” across the whole blog');
  });
  it('describes category-only filtering', () => {
    expect(describeResults(12, '', 'dev-session')).toBe('12 posts in dev session');
  });
});
