import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../worker/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ASSETS: Fetcher;
    TURNSTILE_SECRET: string;
    FE_API_KEY: string;
    CONTACT_FROM: string;
    CONTACT_TO: string;
  }
}

const SITE = 'https://example.com';

// Mirror of worker/schema.sql. Kept inline because the Workers sandbox
// can't read the host filesystem — keep the two in sync by hand when the
// schema changes.
const TEST_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    ip TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_ts ON submissions (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_ip_ts ON submissions (ip, ts DESC)`,
];

// Apply the D1 schema once before any test runs; tests share the same
// miniflare-backed D1 instance for the duration of the run.
beforeAll(async () => {
  for (const stmt of TEST_SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM submissions').run();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Helper: build a contact-form POST request with sensible defaults.
function makeContactRequest(overrides: {
  origin?: string | null;
  fields?: Record<string, string>;
  ip?: string | null;
} = {}): Request {
  const body = new FormData();
  body.set('name', 'Test User');
  body.set('email', 'test@example.com');
  body.set('message', 'Hello there, this is a test message.');
  body.set('cf-turnstile-response', 'valid-token');
  if (overrides.fields) {
    for (const [k, v] of Object.entries(overrides.fields)) {
      body.set(k, v);
    }
  }
  const headers = new Headers();
  if (overrides.origin !== null) {
    headers.set('Origin', overrides.origin ?? SITE);
  }
  if (overrides.ip !== undefined) {
    if (overrides.ip !== null) headers.set('CF-Connecting-IP', overrides.ip);
  } else {
    headers.set('CF-Connecting-IP', '203.0.113.5');
  }
  return new Request(`${SITE}/api/contact`, {
    method: 'POST',
    headers,
    body,
  });
}

// Stub the outbound fetches that the worker makes:
//   - Turnstile siteverify  → ok by default
//   - ForwardEmail send     → ok by default
// Pass overrides to simulate failures of individual upstreams.
function stubUpstreams(opts: {
  turnstile?: boolean | 'network-error' | 'malformed';
  forwardEmail?: { ok: boolean; status?: number; body?: string } | 'network-error';
} = {}) {
  const turnstile = opts.turnstile ?? true;
  const feRes = opts.forwardEmail ?? { ok: true };
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      if (turnstile === 'network-error') throw new TypeError('fetch failed: connection refused');
      if (turnstile === 'malformed') return new Response('<html>gateway error</html>', { status: 502 });
      return new Response(JSON.stringify({ success: turnstile, 'error-codes': turnstile ? [] : ['invalid-input-response'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('api.forwardemail.net/v1/emails')) {
      if (feRes === 'network-error') throw new TypeError('fetch failed: connection refused');
      return new Response(feRes.body ?? (feRes.ok ? '{"id":"abc123"}' : '{"error":"bad"}'), {
        status: feRes.status ?? (feRes.ok ? 200 : 400),
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('contact form: origin enforcement', () => {
  it('rejects POSTs with a mismatched Origin', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ origin: 'https://attacker.example.org' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects POSTs with no Origin header at all', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest({ origin: null }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('accepts POSTs with a matching Origin', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/`);
  });
});

describe('contact form: input validation', () => {
  it('redirects to /contact-error/ when name is missing', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ fields: { name: '' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('redirects to /contact-error/ when email is malformed', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ fields: { email: 'not-an-email' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('redirects to /contact-error/ when message is empty', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ fields: { message: '   ' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('strips control characters from name and email before persisting', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    await worker.fetch(
      makeContactRequest({
        fields: {
          name: 'Mallory\nBcc: x@evil.com',
          email: 'mallory@example.com',
        },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare('SELECT name FROM submissions LIMIT 1').first<{ name: string }>();
    expect(row?.name).toBe('MalloryBcc: x@evil.com');
    expect(row?.name).not.toContain('\n');
  });
});

describe('contact form: turnstile', () => {
  it('redirects to /contact-error/ when no token is supplied', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ fields: { 'cf-turnstile-response': '' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('redirects to /contact-error/ when siteverify returns success:false', async () => {
    stubUpstreams({ turnstile: false });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('fails closed (redirect, no stored row) when siteverify is unreachable', async () => {
    stubUpstreams({ turnstile: 'network-error' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('fails closed when siteverify returns a non-JSON body', async () => {
    stubUpstreams({ turnstile: 'malformed' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });
});

describe('contact form: honeypot', () => {
  it('redirects bot-field-filled submissions to thank-you without touching upstream', async () => {
    const fetchSpy = stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({ fields: { 'bot-field': 'imabot' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/`);
    expect(fetchSpy).not.toHaveBeenCalled();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('contact form: rate limit', () => {
  it('rejects the 6th request from one IP inside the window', async () => {
    stubUpstreams();
    for (let i = 0; i < 5; i++) {
      const ctx = createExecutionContext();
      const ok = await worker.fetch(makeContactRequest(), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(ok.status).toBe(303);
      expect(ok.headers.get('Location')).toBe(`${SITE}/thank-you/`);
    }
    const ctx = createExecutionContext();
    const limited = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(limited.status).toBe(303);
    expect(limited.headers.get('Location')).toBe(`${SITE}/contact-error/`);
  });

  it('does not rate-limit when CF-Connecting-IP is absent', async () => {
    stubUpstreams();
    for (let i = 0; i < 10; i++) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(makeContactRequest({ ip: null }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/`);
    }
  });
});

describe('contact form: ForwardEmail upstream failure', () => {
  it('keeps the D1 row but redirects to /contact-error/', async () => {
    stubUpstreams({ forwardEmail: { ok: false, status: 502, body: '{"error":"upstream"}' } });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
    const row = await env.DB.prepare(
      'SELECT email FROM submissions WHERE email = ?1',
    ).bind('test@example.com').first();
    expect(row).not.toBeNull();
  });

  it('keeps the D1 row and redirects when ForwardEmail is unreachable', async () => {
    stubUpstreams({ forwardEmail: 'network-error' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
    const row = await env.DB.prepare(
      'SELECT email FROM submissions WHERE email = ?1',
    ).bind('test@example.com').first();
    expect(row).not.toBeNull();
  });
});

describe('router', () => {
  it('returns 405 for non-POST on /api/contact', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${SITE}/api/contact`, { method: 'GET' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('POST');
    expect(res.headers.get('Allow')).toContain('OPTIONS');
  });

  it('responds 204 to OPTIONS preflight', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${SITE}/api/contact`, { method: 'OPTIONS' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Allow')).toContain('POST');
  });
});
