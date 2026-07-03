// Pure logic behind the blog listing's client-side search/filter UI
// (pages/blog/[...page].astro). Kept DOM-free so the unit tests in
// tests/lib/search.test.ts can exercise it in plain Node.

// Shape of one entry in the build-time /blog/search.json index.
export interface IndexedPost {
  title: string;
  excerpt: string;
  category: string;
  tags: string[];
  url: string;
  dateShort: string;
  dateISO: string;
  readTime: number;
}

// Escapes for BOTH element and attribute contexts. The DOM-based
// textContent/innerHTML trick does not escape quotes, which would let a
// value containing `"` break out of an attribute like data-category.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Full-archive filter: category must match (unless 'all'), and every post
// field is searched case-insensitively when a query is present.
export function filterPosts(posts: IndexedPost[], query: string, category: string): IndexedPost[] {
  const q = query.toLowerCase().trim();
  return posts.filter((post) => {
    const matchesCat = category === 'all' || post.category === category;
    if (!matchesCat) return false;
    if (!q) return true;
    const haystack = [post.title, post.excerpt, post.category, ...post.tags].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// Renders one post card as an HTML string for the search-results grid.
// `scopeAttr` is the page's Astro scoped-style attribute (data-astro-cid-*):
// the listing's card styles are compiled to `.post-card[data-astro-cid-*]`,
// so dynamically injected markup must carry the same attribute or it renders
// completely unstyled.
export function renderPostCard(post: IndexedPost, scopeAttr = ''): string {
  const scope = scopeAttr ? ` ${scopeAttr}` : '';
  return `
    <a href="${escapeHtml(post.url)}" class="post-card" data-category="${escapeHtml(post.category)}"${scope}>
      <div class="post-card-meta"${scope}>
        <time datetime="${escapeHtml(post.dateISO)}"${scope}>${escapeHtml(post.dateShort)}</time>
        <span class="dot-sep"${scope}>&middot;</span>
        <span${scope}>${Number(post.readTime) || 1} min read</span>
      </div>
      <h2${scope}>${escapeHtml(post.title)}</h2>
      <p${scope}>${escapeHtml(post.excerpt)}</p>
      <span class="category-badge"${scope}>${escapeHtml(post.category.replace(/-/g, ' '))}</span>
    </a>`;
}

// Status line under the search box, e.g. `3 results for "ebpf" across the
// whole blog` or `12 posts in dev-session`.
export function describeResults(count: number, query: string, category: string): string {
  const q = query.trim();
  if (count === 0) return 'No posts found.';
  const noun = q ? `result${count === 1 ? '' : 's'} for “${q}”` : `post${count === 1 ? '' : 's'}`;
  const where = category === 'all' ? 'across the whole blog' : `in ${category.replace(/-/g, ' ')}`;
  return `${count} ${noun} ${where}`;
}
