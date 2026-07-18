import { handleContact } from './api/contact';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FE_API_KEY: string;
  TURNSTILE_SECRET: string;
  CONTACT_FROM: string;
  CONTACT_TO: string;
}

const ALLOW_HEADERS: HeadersInit = {
  Allow: 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// Fingerprinted asset produced by blog-src/scripts/fingerprint-assets.mjs,
// e.g. /css/style.4c1f0b9a2e.css. Captures the unhashed path so a hash from
// a previous deploy (referenced by CDN-cached HTML) can fall back to the
// current copy instead of 404ing.
const HASHED_ASSET = /^(\/(?:css|js)\/.+)\.[0-9a-f]{10}(\.(?:css|js))$/;

// Astro/Vite bundle asset, e.g. /_astro/BlogLayout.CBvvIjZz.css. There is no
// unhashed original for these, so a stale hash is resolved through
// /_astro-manifest.json (written by blog-src/scripts/astro-manifest.mjs),
// which maps the stable base name to the current build's file.
const ASTRO_ASSET = /^\/_astro\/(.+)\.[A-Za-z0-9_-]{8}(\.(?:css|js))$/;

// The assets layer attaches _headers path rules (max-age=31536000, immutable
// for /css, /js, /_astro) to 404 responses too. A 404 cached as immutable
// poisons that URL in the browser for a year — and fingerprinted URLs never
// change while the file's content is unchanged, so the client never recovers
// on its own. No 404 may leave this worker with a cacheable lifetime.
function uncacheable(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('CDN-Cache-Control');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Fallback responses bridge stale cached HTML to the current build, but they
// are served under the *stale* URL — they must not inherit the current
// asset's immutable header, or the bridge content gets pinned for a year.
function bridged(response: Response): Response {
  if (!response.ok) return uncacheable(response);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
  headers.set('CDN-Cache-Control', 'public, max-age=300, must-revalidate');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method === 'POST') return handleContact(request, env, ctx);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ALLOW_HEADERS });
      return new Response('Method not allowed', { status: 405, headers: ALLOW_HEADERS });
    }

    const response = await env.ASSETS.fetch(request);

    if (response.status === 404) {
      const stale = url.pathname.match(HASHED_ASSET);
      if (stale) {
        const current = new URL(stale[1] + stale[2], url);
        return bridged(await env.ASSETS.fetch(new Request(current, request)));
      }

      const astro = url.pathname.match(ASTRO_ASSET);
      if (astro) {
        const manifestRes = await env.ASSETS.fetch(new Request(new URL('/_astro-manifest.json', url)));
        if (manifestRes.ok) {
          const manifest = (await manifestRes.json()) as Record<string, string>;
          const current = manifest[astro[1] + astro[2]];
          if (current) return bridged(await env.ASSETS.fetch(new Request(new URL(current, url), request)));
        }
      }

      return uncacheable(response);
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
