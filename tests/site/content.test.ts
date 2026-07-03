import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirrors the build-time content-collection schema (blog-src/src/content.config.ts)
// so authoring mistakes surface in a fast `npm test` run instead of only at the
// full `astro build`. The glob loader skips files whose names start with `_` or
// an uppercase letter (drafts / CLAUDE.md), so apply the same filter here.
const POSTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../blog-src/src/content/posts',
);

function postFiles(): string[] {
  return readdirSync(POSTS_DIR).filter(
    (f) => f.endsWith('.md') && /^[^_A-Z]/.test(f),
  );
}

// Extract a single scalar frontmatter value (handles optional surrounding
// quotes). Returns null when the key is absent or commented out.
function frontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (/^\s*#/.test(line)) continue; // skip commented-out hints
    const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return fields;
}

const files = postFiles();

describe('blog content frontmatter', () => {
  it('has at least one published post', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has valid frontmatter', (file) => {
    const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
    const fm = frontmatter(raw);

    // Required fields (schema: title, date, category, excerpt).
    for (const key of ['title', 'date', 'category', 'excerpt'] as const) {
      expect(fm[key], `${file}: missing "${key}"`).toBeTruthy();
    }

    // Lengths match the Zod schema bounds.
    expect(fm.title.length, `${file}: title too long`).toBeLessThanOrEqual(200);
    expect(fm.excerpt.length, `${file}: excerpt too long`).toBeLessThanOrEqual(
      300,
    );

    // Category is a lowercase-hyphenated slug.
    expect(fm.category, `${file}: category not slug-cased`).toMatch(
      /^[a-z0-9-]+$/,
    );

    // Date parses to a real calendar date.
    expect(
      Number.isNaN(new Date(fm.date).getTime()),
      `${file}: unparseable date "${fm.date}"`,
    ).toBe(false);

    // updated, when present, is not before date.
    if (fm.updated) {
      expect(
        new Date(fm.updated).getTime(),
        `${file}: updated precedes date`,
      ).toBeGreaterThanOrEqual(new Date(fm.date).getTime());
    }
  });

  it('has unique slugs (filenames)', () => {
    const slugs = files.map((f) => f.replace(/\.md$/, ''));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // The AI pipeline once published the same post twice under different date
  // prefixes (2026-05-03-x.md / 2026-05-13-x.md) — treat any repeat of the
  // date-less slug or the title as a duplicate.
  it('has unique slugs ignoring the date prefix', () => {
    const bare = files.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    const dupes = bare.filter((s, i) => bare.indexOf(s) !== i);
    expect(dupes, `duplicate posts: ${dupes.join(', ')}`).toEqual([]);
  });

  it('has unique titles', () => {
    const titles = files.map(
      (f) => frontmatter(readFileSync(join(POSTS_DIR, f), 'utf8')).title?.toLowerCase() ?? '',
    );
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes, `duplicate titles: ${dupes.join(', ')}`).toEqual([]);
  });

  // Posts published after this date must ship with tags — the draft pipeline
  // now generates them, and empty tags mean the review checklist was skipped.
  // Older posts are grandfathered in rather than backfilled.
  const TAGS_REQUIRED_AFTER = '2026-07-04';

  it.each(files)('%s has tags when recent enough to require them', (file) => {
    const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
    const fm = frontmatter(raw);
    if (fm.date <= TAGS_REQUIRED_AFTER) return;
    expect(fm.tags, `${file}: posts dated after ${TAGS_REQUIRED_AFTER} must have at least one tag`).toMatch(
      /\[\s*".+"\s*\]|\[\s*'.+'\s*\]/,
    );
  });
});
