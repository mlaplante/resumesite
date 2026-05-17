import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

const posts = defineCollection({
  loader: glob({ pattern: '**/[^_A-Z]*.md', base: "./src/content/posts" }),
  schema: z.object({
    title: z.string().min(1).max(200),
    date: z.coerce.date(),
    // Optional last-modified date; used by blog post structured data and RSS
    // when present. Defaults to `date` when omitted.
    updated: z.coerce.date().optional(),
    category: z.string().min(1),
    tags: z.array(z.string()).default([]),
    // Excerpt is rendered as the meta description / OG description — keep it
    // search-snippet-sized.
    excerpt: z.string().min(1).max(300),
    // Optional explicit hero image; falls back to DEFAULT_OG_IMAGE.
    image: z.string().optional(),
  }),
});

export const collections = { posts };
