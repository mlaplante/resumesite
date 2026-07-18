import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';

const SITE = 'https://example.com';

// The ASSETS binding is stubbed rather than served from dist/ because the CI
// test job runs without a production build. The stub emulates the assets
// layer: a fixed set of paths exist, everything else 404s. Like production,
// the _headers path rules are attached to every response under the asset
// prefixes — including 404s, which is exactly the poisoning the worker must
// undo (an immutable-cached 404 breaks that URL in the browser for a year).
const IMMUTABLE = 'public, max-age=31536000, immutable';
function stubAssets(existing: Record<string, string>) {
  return {
    fetch: (request: Request) => {
      const { pathname } = new URL(request.url);
      const body = existing[pathname];
      const headers = /^\/(?:css|js|_astro2?)\//.test(pathname)
        ? { 'Cache-Control': IMMUTABLE, 'CDN-Cache-Control': IMMUTABLE }
        : undefined;
      return Promise.resolve(
        body === undefined
          ? new Response('Not found', { status: 404, headers })
          : new Response(body, { status: 200, headers })
      );
    },
  } as unknown as Fetcher;
}

async function get(path: string, assets: Fetcher) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${SITE}${path}`), { ...env, ASSETS: assets }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('fingerprinted asset fallback', () => {
  const assets = stubAssets({
    '/css/style.css': 'current css',
    '/css/style.0123456789.css': 'hashed css',
    '/js/script.js': 'current js',
  });

  it('serves an existing fingerprinted asset directly', async () => {
    const response = await get('/css/style.0123456789.css', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hashed css');
    expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE);
  });

  it('falls back to the unhashed asset for a stale fingerprint', async () => {
    const response = await get('/css/style.ffffffffff.css', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current css');
  });

  it('falls back for stale fingerprinted js', async () => {
    const response = await get('/js/script.abcdef0123.js', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current js');
  });

  it('serves fallbacks with a short lifetime, not the immutable header', async () => {
    const response = await get('/css/style.ffffffffff.css', assets);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, max-age=300, must-revalidate');
  });

  it('404s when the unhashed fallback does not exist either', async () => {
    const response = await get('/css/removed.0123456789.css', assets);
    expect(response.status).toBe(404);
  });

  it('404s for missing paths that are not fingerprinted', async () => {
    const response = await get('/css/missing.css', assets);
    expect(response.status).toBe(404);
  });

  it('never lets a 404 out with a cacheable lifetime', async () => {
    for (const path of ['/css/missing.css', '/css/removed.0123456789.css', '/js/gone.abcdef0123.js']) {
      const response = await get(path, assets);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('CDN-Cache-Control')).toBeNull();
    }
  });
});

describe('astro bundle asset fallback', () => {
  const assets = stubAssets({
    '/_astro2/BlogLayout.CBvvIjZz.css': 'current blog css',
    '/_astro2/page.BivElXX4.js': 'current page js',
    '/_astro-manifest.json': JSON.stringify({
      'BlogLayout.css': '/_astro2/BlogLayout.CBvvIjZz.css',
      'page.js': '/_astro2/page.BivElXX4.js',
    }),
  });

  it('serves an existing astro asset directly', async () => {
    const response = await get('/_astro2/BlogLayout.CBvvIjZz.css', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current blog css');
  });

  it('resolves a stale astro css hash through the manifest', async () => {
    const response = await get('/_astro2/BlogLayout.OLDHASH1.css', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current blog css');
  });

  it('resolves a stale astro js hash through the manifest', async () => {
    const response = await get('/_astro2/page.AAAAAAAA.js', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current page js');
  });

  it('resolves legacy /_astro URLs from pre-rename cached HTML', async () => {
    const response = await get('/_astro/BlogLayout.CBvvIjZz.css', assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('current blog css');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
  });

  it('serves manifest fallbacks with a short lifetime, not the immutable header', async () => {
    const response = await get('/_astro2/BlogLayout.OLDHASH1.css', assets);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
  });

  it('404s for a base name the manifest does not know', async () => {
    const response = await get('/_astro2/unknown.BBBBBBBB.css', assets);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s when the manifest itself is missing', async () => {
    const bare = stubAssets({});
    const response = await get('/_astro2/BlogLayout.OLDHASH1.css', bare);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
