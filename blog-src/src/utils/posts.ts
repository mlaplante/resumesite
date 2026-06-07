// Shared post-collection helpers. Keeps the "newest first" ordering in one
// place so listing, feeds, search index, and the homepage can't drift out of
// sync on how posts are sorted.
import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

// Comparator: most recent `date` first. Use directly when sorting an
// already-filtered subset (category / tag / series pages).
export const byDateDesc = (a: Post, b: Post): number =>
  b.data.date.valueOf() - a.data.date.valueOf();

// All published posts, newest first.
export async function getSortedPosts(): Promise<Post[]> {
  return (await getCollection('posts')).sort(byDateDesc);
}
