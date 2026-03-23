import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

const posts = defineCollection({
  loader: glob({ pattern: '**/[^_A-Z]*.md', base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    category: z.string(),
    tags: z.array(z.string()),
    excerpt: z.string(),
  }),
});

export const collections = { posts };
