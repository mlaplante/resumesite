import type { APIContext } from 'astro';
import { getSortedPosts } from '../utils/posts';
import { SITE_URL, AUTHOR_NAME, BLOG_TITLE, BLOG_DESCRIPTION } from '../config';

// JSON Feed 1.1 — https://www.jsonfeed.org/version/1.1/
// Companion to /blog/rss.xml for readers that prefer JSON.
export async function GET(_context: APIContext) {
  const posts = await getSortedPosts();

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: BLOG_TITLE,
    home_page_url: `${SITE_URL}/blog/`,
    feed_url: `${SITE_URL}/feed.json`,
    description: BLOG_DESCRIPTION,
    language: 'en-US',
    authors: [{ name: AUTHOR_NAME, url: SITE_URL }],
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
