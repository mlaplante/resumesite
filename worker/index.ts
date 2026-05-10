import { handleContact } from './api/contact';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FE_API_KEY: string;
  TURNSTILE_SECRET: string;
  CONTACT_FROM: string;
  CONTACT_TO: string;
}

// Submissions older than this are purged on the scheduled trigger.
const RETENTION_DAYS = 90;

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

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM submissions WHERE ts < ?1').bind(cutoff).run()
        .then(r => console.log('retention purge:', r.meta?.changes ?? 0, 'rows older than', new Date(cutoff).toISOString()))
        .catch(err => console.error('retention purge failed:', err))
    );
  },
} satisfies ExportedHandler<Env>;
