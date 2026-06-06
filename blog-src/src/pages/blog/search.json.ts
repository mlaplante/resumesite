import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getReadTime } from '../../utils/readTime';
import { formatDateShort } from '../../utils/format';

// Static search index for the blog listing page. The listing only paginates
// 10 posts at a time, so the in-page filter can't see the rest of the archive
// — this endpoint exposes every post (title/excerpt/tags/category) so the
// search box can match across the whole blog client-side. Same-origin fetch,
// so it stays within the site CSP (connect-src 'self').
export const GET: APIRoute = async () => {
  const posts = (await getCollection('posts'))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .map((post) => ({
      title: post.data.title,
      excerpt: post.data.excerpt,
      category: post.data.category,
      tags: post.data.tags,
      url: `/blog/${post.id}/`,
      dateShort: formatDateShort(post.data.date),
      dateISO: post.data.date.toISOString(),
      readTime: getReadTime(post.body),
    }));

  return new Response(JSON.stringify(posts), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
};
