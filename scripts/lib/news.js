// Recent security-news headlines for the auto topic picker.
//
// With 200+ published posts, an ungrounded "suggest a fresh topic" prompt keeps
// converging on the same evergreen deep-dives, and the dedupe guard rightly
// rejects all of them (2026-10-24: four candidates at 88-89% semantic
// similarity, run failed). Anchoring candidates to things that actually
// happened this week makes them new by construction.
//
// Feed content is untrusted third-party text. It is only ever used as prompt
// *data* for a draft that a human reviews in a PR, and it is stripped to plain
// text and length-capped here before it reaches a prompt.
//
// Environment:
//   NEWS_FEEDS  - optional, comma-separated RSS/Atom URLs overriding the defaults
//                 (set to an empty string to disable news grounding entirely)

export const DEFAULT_NEWS_FEEDS = [
  'https://feeds.feedburner.com/TheHackersNews',
  'https://www.bleepingcomputer.com/feed/',
  'https://www.cisa.gov/cybersecurity-advisories/all.xml',
  'https://nodejs.org/en/feed/vulnerability.xml',
  'https://www.php.net/feed.atom',
];

export const NEWS_MAX_AGE_DAYS = 7;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS = 25;
const MAX_TITLE_LEN = 200;
const MAX_SUMMARY_LEN = 400;

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Reduce feed markup to a single line of plain text: unwrap CDATA, drop tags
// and entities (twice each — feeds often entity-encode their HTML, and
// sometimes double-encode it), strip control chars.
export function toPlainText(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(decodeEntities(s));
  s = s.replace(/<[^>]*>/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen).replace(/\s+\S*$/, '')}…`;
  return s;
}

function tag(block, name) {
  return block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';
}

// Parse RSS 2.0 <item> or Atom <entry> blocks. A tiny regex parser is enough
// for headline/summary/link/date, and keeps the generator dependency-free.
export function parseFeed(xml) {
  if (typeof xml !== 'string') return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks
    .map(block => {
      const title = toPlainText(tag(block, 'title'), MAX_TITLE_LEN);
      const summary = toPlainText(
        tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
        MAX_SUMMARY_LEN,
      );
      const link =
        toPlainText(tag(block, 'link'), 500) ||
        block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] ||
        '';
      const dateRaw = toPlainText(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'), 100);
      const time = Date.parse(dateRaw);
      return {
        title,
        summary,
        link: /^https?:\/\//.test(link) ? link : '',
        date: Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10),
      };
    })
    .filter(item => item.title);
}

// Keep items from the last `maxAgeDays`, newest first, de-duplicated by title
// (the same story is often syndicated across several feeds).
export function selectRecent(items, { now = Date.now(), maxAgeDays = NEWS_MAX_AGE_DAYS, limit = MAX_ITEMS } = {}) {
  const cutoff = new Date(now - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set();
  return items
    .filter(i => i.date && i.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(i => {
      const key = i.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function configuredFeeds() {
  if (process.env.NEWS_FEEDS === undefined) return DEFAULT_NEWS_FEEDS;
  return process.env.NEWS_FEEDS.split(',').map(s => s.trim()).filter(Boolean);
}

// Fetch every feed in parallel. Any feed that errors, times out, or returns
// junk is skipped; total failure returns [] and the picker falls back to
// evergreen topics, so news is an enhancement and never a new way to fail.
export async function fetchRecentNews({ feeds = configuredFeeds(), fetchImpl = globalThis.fetch, now } = {}) {
  if (!feeds.length || typeof fetchImpl !== 'function') return [];
  const results = await Promise.allSettled(
    feeds.map(async url => {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'michaellaplante.com blog-draft bot' },
      });
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return parseFeed(await res.text());
    }),
  );
  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.warn(`News feed skipped (${feeds[i]}): ${r.reason?.message ?? r.reason}`);
  });
  return selectRecent(items, { now });
}
