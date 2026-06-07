import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getSortedPosts } from '../../utils/posts';
import { BLOG_TITLE, BLOG_DESCRIPTION } from '../../config';

export async function GET(context: APIContext) {
  const posts = await getSortedPosts();

  return rss({
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    site: context.site!.toString(),
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.excerpt,
      link: `/blog/${post.id}/`,
      categories: [post.data.category, ...post.data.tags],
    })),
  });
}
