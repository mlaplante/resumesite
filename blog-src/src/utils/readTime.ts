const WORDS_PER_MINUTE = 250;

export function getWordCount(body: string | undefined): number {
  return body?.split(/\s+/).length ?? 0;
}

// Split once when a caller already has the word count (the post page shows
// both figures) instead of re-tokenising the same body.
export function readTimeFromWordCount(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

export function getReadTime(body: string | undefined): number {
  return readTimeFromWordCount(getWordCount(body));
}
