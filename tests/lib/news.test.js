import { describe, it, expect } from 'vitest';

import { parseFeed, selectRecent, toPlainText, fetchRecentNews } from '../../scripts/lib/news.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Wednesday, October 21, 2026 Security Releases]]></title>
    <link>https://nodejs.org/en/blog/vulnerability/october-2026-security-releases</link>
    <description>&lt;p&gt;Fixes a &lt;b&gt;Brotli&lt;/b&gt; RCE &amp;amp; nine more.&lt;/p&gt;</description>
    <pubDate>Wed, 21 Oct 2026 22:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Old news</title>
    <link>https://example.com/old</link>
    <pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>PHP 8.5.12 Released!</title>
    <link rel="alternate" href="https://www.php.net/releases/8_5_12.php"/>
    <published>2026-10-21T12:00:00+00:00</published>
    <summary type="html">Security release.</summary>
  </entry>
</feed>`;

describe('toPlainText', () => {
  it('strips CDATA, tags (including entity-encoded ones) and control chars', () => {
    expect(toPlainText('<![CDATA[<b>Hi</b>]]>', 100)).toBe('Hi');
    expect(toPlainText('&lt;script&gt;x&lt;/script&gt; ok\u0007', 100)).toBe('x ok');
  });

  it('caps length on a word boundary', () => {
    expect(toPlainText('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});

describe('parseFeed', () => {
  it('parses RSS items', () => {
    const [first] = parseFeed(RSS);
    expect(first).toEqual({
      title: 'Wednesday, October 21, 2026 Security Releases',
      summary: 'Fixes a Brotli RCE & nine more.',
      link: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
      date: '2026-10-21',
    });
  });

  it('parses Atom entries with href links', () => {
    expect(parseFeed(ATOM)).toEqual([
      { title: 'PHP 8.5.12 Released!', summary: 'Security release.', link: 'https://www.php.net/releases/8_5_12.php', date: '2026-10-21' },
    ]);
  });

  it('drops non-http links and tolerates garbage', () => {
    const [item] = parseFeed('<item><title>X Y</title><link>javascript:alert(1)</link></item>');
    expect(item.link).toBe('');
    expect(parseFeed(null)).toEqual([]);
  });
});

describe('selectRecent', () => {
  const now = Date.parse('2026-10-24T08:00:00Z');

  it('keeps the last week, newest first, de-duplicated by title', () => {
    const items = [
      { title: 'A', date: '2026-10-20' },
      { title: 'B', date: '2026-10-23' },
      { title: 'a', date: '2026-10-19' },
      { title: 'Old', date: '2026-10-01' },
      { title: 'Undated', date: null },
    ];
    expect(selectRecent(items, { now }).map(i => i.title)).toEqual(['B', 'A']);
  });
});

describe('fetchRecentNews', () => {
  const now = Date.parse('2026-10-24T08:00:00Z');

  it('merges feeds and skips ones that fail', async () => {
    const fetchImpl = async (url) => {
      if (url === 'bad') throw new Error('timeout');
      if (url === '500') return { ok: false, status: 500 };
      return { ok: true, text: async () => (url === 'rss' ? RSS : ATOM) };
    };
    const items = await fetchRecentNews({ feeds: ['rss', 'bad', '500', 'atom'], fetchImpl, now });
    expect(items.map(i => i.title).sort()).toEqual([
      'PHP 8.5.12 Released!',
      'Wednesday, October 21, 2026 Security Releases',
    ]);
  });

  it('returns [] when no feeds are configured', async () => {
    expect(await fetchRecentNews({ feeds: [], fetchImpl: async () => { throw new Error('unused'); } })).toEqual([]);
  });
});
