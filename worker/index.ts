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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method === 'POST') return handleContact(request, env, ctx);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ALLOW_HEADERS });
      return new Response('Method not allowed', { status: 405, headers: ALLOW_HEADERS });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
