export function getReadTime(body: string | undefined): number {
  const wordCount = body?.split(/\s+/).length ?? 0;
  return Math.max(1, Math.ceil(wordCount / 250));
}

export function getWordCount(body: string | undefined): number {
  return body?.split(/\s+/).length ?? 0;
}
