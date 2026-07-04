import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';

const SITE = 'https://example.com';

// The ASSETS binding is stubbed rather than served from dist/ because the CI
// test job runs without a production build. The stub emulates the assets
// layer: a fixed set of paths exist, everything else 404s.
function stubAssets(existing: Record<string, string>) {
  return {
    fetch: (request: Request) => {
      const { pathname } = new URL(request.url);
      const body = existing[pathname];
      return Promise.resolve(
        body === undefined ? new Response('Not found', { status: 404 }) : new Response(body, { status: 200 })
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

  it('404s when the unhashed fallback does not exist either', async () => {
    const response = await get('/css/removed.0123456789.css', assets);
    expect(response.status).toBe(404);
  });

  it('404s for missing paths that are not fingerprinted', async () => {
    const response = await get('/css/missing.css', assets);
    expect(response.status).toBe(404);
  });
});
