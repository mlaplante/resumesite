import { handleContact } from './api/contact';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FE_API_KEY: string;
  TURNSTILE_SECRET: string;
  CONTACT_FROM: string;
  CONTACT_TO: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method === 'POST') return handleContact(request, env);
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
