import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  slugify,
  isValidTitle,
  extractTitle,
  stripTitleDirective,
  makeExcerpt,
  buildFrontmatter,
  findMostSimilar,
  findMostSimilarSemantic,
  pickUniqueTopic,
  DUPLICATE_THRESHOLD,
  SEMANTIC_THRESHOLD,
} from '../../scripts/lib/blog-post.js';

describe('slugify', () => {
  it('lowercases and dashes the input', () => {
    expect(slugify('Hello, World! 2026')).toBe('hello-world-2026');
  });
  it('trims leading and trailing separators', () => {
    expect(slugify('--Foo--')).toBe('foo');
  });
});

describe('isValidTitle', () => {
  it('accepts a normal multi-word title', () => {
    expect(isValidTitle('Implementing Zero-Trust Network Segmentation with eBPF')).toBe(true);
  });
  it('rejects file paths', () => {
    expect(isValidTitle('templates/k8srequiredlabels.yaml')).toBe(false);
  });
  it('rejects file extensions even without slash', () => {
    expect(isValidTitle('My great config.yaml')).toBe(false);
  });
  it('rejects too-short titles', () => {
    expect(isValidTitle('AWS Side')).toBe(false);
  });
  it('rejects code-identifier-heavy titles', () => {
    expect(isValidTitle('snake_case dotted.thing kebab-words long-thing')).toBe(false);
  });
  it('rejects single-word titles', () => {
    expect(isValidTitle('Engineering')).toBe(false);
  });
  it('rejects empty / nullish input', () => {
    expect(isValidTitle('')).toBe(false);
    expect(isValidTitle(null)).toBe(false);
    expect(isValidTitle(undefined)).toBe(false);
  });
  it('rejects very long titles', () => {
    expect(isValidTitle('A'.repeat(200))).toBe(false);
  });
  it('rejects titles that start with their own label residue', () => {
    expect(isValidTitle('Title: Things About Things')).toBe(false);
  });
});

describe('extractTitle', () => {
  it('prefers an explicit TITLE: directive', () => {
    const content = 'TITLE: A Clear Useful Title\n\n# Some Other Heading\n\nBody';
    expect(extractTitle(content)).toBe('A Clear Useful Title');
  });

  it('falls back to the first H1 when TITLE directive is absent', () => {
    expect(extractTitle('# A Practical Guide to eBPF Tracing\n\nBody')).toBe(
      'A Practical Guide to eBPF Tracing',
    );
  });

  it('returns null when the first H1 is a bogus file path', () => {
    expect(extractTitle('# templates/k8srequiredlabels.yaml\n\nBody')).toBeNull();
  });

  it('ignores H1s inside fenced code blocks', () => {
    const content = 'Some intro\n\n```\n# inside fence\n```\n\n# Actual Heading For This Post\n\nBody';
    expect(extractTitle(content)).toBe('Actual Heading For This Post');
  });

  it('strips wrapping backticks / asterisks from a valid title', () => {
    expect(extractTitle('# `My Great Post Title Here`\n\nBody')).toBe('My Great Post Title Here');
  });

  it('returns null when an explicit TITLE directive is invalid AND no good fallback exists', () => {
    expect(extractTitle('TITLE: foo.yaml\n\n# bar.yml\n\nbody')).toBeNull();
  });

  it('returns null on non-string input', () => {
    expect(extractTitle(null)).toBeNull();
    expect(extractTitle(42)).toBeNull();
  });
});

describe('stripTitleDirective', () => {
  it('removes the leading TITLE: line and the blank line after', () => {
    const out = stripTitleDirective('TITLE: A Good Title\n\n# A Good Title\n\nBody');
    expect(out).toBe('# A Good Title\n\nBody');
  });
  it('leaves content unchanged when no TITLE: directive is present', () => {
    expect(stripTitleDirective('# Heading\n\nBody')).toBe('# Heading\n\nBody');
  });
});

describe('makeExcerpt', () => {
  it('skips the H1 and trims to 150 chars + ellipsis', () => {
    const body = '# Title\n\nThis is the body of the post. '.repeat(20);
    const ex = makeExcerpt(body);
    expect(ex.endsWith('...')).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(155);
    expect(ex.startsWith('This is the body')).toBe(true);
  });
  it('strips a TITLE: directive before computing', () => {
    const body = 'TITLE: Foo Bar Baz Qux\n\n# Foo Bar Baz Qux\n\nReal body content here.';
    expect(makeExcerpt(body)).toBe('Real body content here....');
  });
  it('never cuts mid-word at the 150-char limit', () => {
    const body = '# Title\n\n' + 'supercalifragilistic '.repeat(20);
    const ex = makeExcerpt(body);
    expect(ex.endsWith('supercalifragilistic...')).toBe(true);
  });
  it('strips common markdown punctuation', () => {
    const body = '# Title\n\n**Bold** and `code` and [link](http://x) text';
    expect(makeExcerpt(body)).not.toContain('**');
    expect(makeExcerpt(body)).not.toContain('`');
    expect(makeExcerpt(body)).not.toContain('[');
  });
});

describe('buildFrontmatter', () => {
  it('escapes double quotes in title and excerpt', () => {
    const fm = buildFrontmatter({
      title: 'A "quoted" Title',
      date: '2026-05-17',
      category: 'thought-leadership',
      excerpt: 'It "works"',
    });
    expect(fm).toContain('title: "A \\"quoted\\" Title"');
    expect(fm).toContain('excerpt: "It \\"works\\""');
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('---')).toBe(true);
  });

  it('emits a commented series hint when no series is supplied', () => {
    const fm = buildFrontmatter({
      title: 'A Post',
      date: '2026-05-17',
      category: 'thought-leadership',
      excerpt: 'Body',
    });
    expect(fm).toContain('# series:');
    expect(fm).toContain('# seriesOrder:');
    // The hint must be a YAML comment, never active frontmatter.
    expect(fm).not.toMatch(/^series:/m);
  });

  it('emits real series frontmatter when a series is supplied', () => {
    const fm = buildFrontmatter({
      title: 'A Post',
      date: '2026-05-17',
      category: 'thought-leadership',
      excerpt: 'Body',
      series: 'Zero Trust Deep Dive',
      seriesOrder: 2,
    });
    expect(fm).toMatch(/^series: "Zero Trust Deep Dive"$/m);
    expect(fm).toMatch(/^seriesOrder: 2$/m);
    expect(fm).not.toContain('# series:');
  });
});

describe('findMostSimilar (lexical Jaccard)', () => {
  it('returns the highest-overlap existing title and its score', () => {
    const result = findMostSimilar('Securing Kubernetes with eBPF', [
      'Zero Trust Network Segmentation',
      'Securing Kubernetes with eBPF Advanced Patterns',
      'GitOps Patterns',
    ]);
    expect(result.title).toBe('Securing Kubernetes with eBPF Advanced Patterns');
    expect(result.score).toBeGreaterThan(0.5);
  });
  it('returns score 0 for completely disjoint sets', () => {
    const result = findMostSimilar('Cooking with Cast Iron', ['Quantum Cryptography 101']);
    expect(result.score).toBe(0);
  });
});

describe('findMostSimilarSemantic (cosine of provided embeddings)', () => {
  // Cleanup the on-disk embeddings cache between runs.
  const cachePath = join(process.cwd(), 'scripts', '.embeddings-cache.json');
  afterEach(() => {
    if (existsSync(cachePath)) rmSync(cachePath);
  });

  it('matches the post with the closest embedding vector', async () => {
    const embed = async (text) => {
      if (text.includes('eBPF')) return [1, 0.9, 0.1, 0.2];
      if (text.includes('Istio')) return [0.95, 0.95, 0.05, 0.15];
      if (text.includes('Cast Iron')) return [0.1, 0.2, 1, 0.8];
      return [0, 0, 0, 0];
    };
    const result = await findMostSimilarSemantic(
      { title: 'Zero Trust with eBPF', excerpt: '' },
      [
        { title: 'Zero Trust with Istio', excerpt: '' },
        { title: 'Cooking with Cast Iron', excerpt: '' },
      ],
      embed,
    );
    expect(result.title).toBe('Zero Trust with Istio');
    expect(result.score).toBeGreaterThan(SEMANTIC_THRESHOLD);
  });

  it('caches embeddings to avoid recomputing', async () => {
    let calls = 0;
    const embed = async () => {
      calls++;
      return [0.1, 0.2, 0.3, 0.4];
    };
    const posts = [{ title: 'Post One', excerpt: '' }, { title: 'Post Two', excerpt: '' }];
    await findMostSimilarSemantic({ title: 'Candidate', excerpt: '' }, posts, embed);
    const firstRun = calls;
    expect(firstRun).toBe(3); // candidate + 2 existing
    await findMostSimilarSemantic({ title: 'Candidate', excerpt: '' }, posts, embed);
    // All three texts already cached — no new calls.
    expect(calls).toBe(firstRun);
  });

  it('throws when embed returns a non-array', async () => {
    await expect(
      findMostSimilarSemantic(
        { title: 'Anything Anywhere', excerpt: '' },
        [{ title: 'Other', excerpt: '' }],
        async () => null,
      ),
    ).rejects.toThrow(/Embedding function returned a non-vector/);
  });
});

describe('pickUniqueTopic', () => {
  it('returns a fresh candidate on the first try when it is not a duplicate', async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      return 'A Brand New Topic About Quantum Networking';
    };
    const topic = await pickUniqueTopic(generate, ['Cloud Security Basics']);
    expect(topic).toBe('A Brand New Topic About Quantum Networking');
    expect(calls).toBe(1);
  });

  it('retries when the LLM picks a near-duplicate (lexical mode)', async () => {
    const responses = [
      'Zero Trust Network Segmentation', // duplicate of existing
      'A Completely Different Topic About Quantum Networking', // unique
    ];
    let i = 0;
    const generate = async () => responses[i++];
    const topic = await pickUniqueTopic(generate, ['Zero Trust Network Segmentation Strategies']);
    expect(topic).toBe('A Completely Different Topic About Quantum Networking');
    expect(i).toBe(2);
  });

  it('throws after the retry budget is exhausted', async () => {
    const generate = async () => 'Zero Trust Network Segmentation';
    await expect(
      pickUniqueTopic(generate, ['Zero Trust Network Segmentation Patterns']),
    ).rejects.toThrow(/Could not find a sufficiently unique topic/);
  });

  it('falls back from semantic to lexical if embed throws', async () => {
    let embedCalls = 0;
    const embed = async () => {
      embedCalls++;
      throw new Error('rate limited');
    };
    let genCalls = 0;
    const generate = async () => {
      genCalls++;
      return 'A Fresh Unrelated Topic Title';
    };
    const topic = await pickUniqueTopic(generate, [{ title: 'Old Thing', excerpt: '' }], embed);
    expect(topic).toBe('A Fresh Unrelated Topic Title');
    // embed was attempted (1 candidate try) but the function still completed.
    expect(embedCalls).toBeGreaterThanOrEqual(1);
    expect(genCalls).toBe(1);
  });
});

describe('DUPLICATE_THRESHOLD / SEMANTIC_THRESHOLD constants', () => {
  it('have sane defaults', () => {
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(0);
    expect(DUPLICATE_THRESHOLD).toBeLessThan(1);
    expect(SEMANTIC_THRESHOLD).toBeGreaterThan(0);
    expect(SEMANTIC_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
