import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

const posts = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: "./src/content/posts", exclude: ["**/CLAUDE.md"] }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    category: z.enum(["project-update", "thought-leadership", "dev-session"]),
    tags: z.array(z.string()),
    excerpt: z.string(),
  }),
});

export const collections = { posts };
