// URL-safe slug from an arbitrary label (series names, etc.). Mirrors the
// slugify in scripts/lib/blog-post.js so routes and links stay in sync.
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
