import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { SITE_URL } from '../config';

// JSON Feed 1.1 — https://www.jsonfeed.org/version/1.1/
// Companion to /blog/rss.xml for readers that prefer JSON.
export async function GET(_context: APIContext) {
  const posts = (await getCollection('posts')).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: "Michael LaPlante's Blog",
    home_page_url: `${SITE_URL}/blog/`,
    feed_url: `${SITE_URL}/feed.json`,
    description: 'Thoughts on security, engineering, and building things.',
    language: 'en-US',
    authors: [{ name: 'Michael LaPlante', url: SITE_URL }],
    items: posts.map((post) => ({
      id: `${SITE_URL}/blog/${post.id}/`,
      url: `${SITE_URL}/blog/${post.id}/`,
      title: post.data.title,
      summary: post.data.excerpt,
      content_text: post.data.excerpt,
      date_published: post.data.date.toISOString(),
      date_modified: (post.data.updated ?? post.data.date).toISOString(),
      tags: [post.data.category, ...post.data.tags],
    })),
  };

  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      'Content-Type': 'application/feed+json; charset=utf-8',
    },
  });
}
