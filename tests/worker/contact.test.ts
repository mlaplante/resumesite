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
  `CREATE TABLE IF NOT EXISTS contact_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contact_attempts_ip_ts ON contact_attempts (ip, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_contact_attempts_ts ON contact_attempts (ts DESC)`,
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
  await env.DB.prepare('DELETE FROM contact_attempts').run();
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
  it('rejects unsupported content types before parsing the body', async () => {
    stubUpstreams();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${SITE}/api/contact`, {
        method: 'POST',
        headers: {
          Origin: SITE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test User' }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(415);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects oversized form posts before parsing the body', async () => {
    stubUpstreams();
    const body = new FormData();
    body.set('name', 'Test User');
    body.set('email', 'test@example.com');
    body.set('message', 'x'.repeat(40 * 1024));
    body.set('cf-turnstile-response', 'valid-token');

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${SITE}/api/contact`, {
        method: 'POST',
        headers: {
          Origin: SITE,
          'Content-Length': String(40 * 1024),
        },
        body,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
  });

  it('rejects an oversized streamed body even without a Content-Length header', async () => {
    stubUpstreams();
    // Chunked upload: no Content-Length for the header check to trust — only
    // the stream cap can catch it.
    const payload = new TextEncoder().encode('name=Test&message=' + 'x'.repeat(40 * 1024));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${SITE}/api/contact`, {
        method: 'POST',
        headers: {
          Origin: SITE,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: stream,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
  });

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

  it('counts failed Turnstile attempts toward the rate limit', async () => {
    // Five attempts that all fail the challenge...
    stubUpstreams({ turnstile: false });
    for (let i = 0; i < 5; i++) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(makeContactRequest(), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
    }
    // ...then a sixth with a valid token is still rejected: the limit is on
    // attempts, so failing the challenge can't be used to retry for free.
    const fetchSpy = stubUpstreams({ turnstile: true });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/contact-error/`);
    // Rate limit fired before any upstream call.
    expect(fetchSpy).not.toHaveBeenCalled();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('contact form: ForwardEmail upstream failure', () => {
  it('keeps the D1 row and acknowledges receipt with a delayed-delivery note', async () => {
    stubUpstreams({ forwardEmail: { ok: false, status: 502, body: '{"error":"upstream"}' } });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/?delivery=delayed`);
    const row = await env.DB.prepare(
      'SELECT email FROM submissions WHERE email = ?1',
    ).bind('test@example.com').first();
    expect(row).not.toBeNull();
  });

  it('keeps the D1 row and acknowledges receipt when ForwardEmail is unreachable', async () => {
    stubUpstreams({ forwardEmail: 'network-error' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/?delivery=delayed`);
    const row = await env.DB.prepare(
      'SELECT email FROM submissions WHERE email = ?1',
    ).bind('test@example.com').first();
    expect(row).not.toBeNull();
  });
});

describe('contact form: branded emails', () => {
  // A fetch stub that also captures the JSON bodies POSTed to ForwardEmail so
  // the tests can assert on the rendered notification and auto-reply.
  function stubAndCapture() {
    const mails: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true, 'error-codes': [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('api.forwardemail.net/v1/emails')) {
        if (init?.body) mails.push(JSON.parse(String(init.body)));
        return new Response('{"id":"abc123"}', { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    return mails;
  }

  it('sends the owner notification as branded HTML with a plain-text part', async () => {
    const mails = stubAndCapture();
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);

    const notification = mails.find(m => String(m.subject).startsWith('Contact form:'));
    expect(notification).toBeDefined();
    // Goes to the owner, reply routes back to the sender. The display-name is
    // quoted (RFC 5322) so a crafted name can't smuggle a second address.
    expect(notification!.to).toBe(env.CONTACT_TO);
    expect(notification!.replyTo).toBe('"Test User" <test@example.com>');
    // Branded HTML: the site's Indigo primary and the sender's details.
    expect(String(notification!.html)).toContain('#3F51B5');
    expect(String(notification!.html)).toContain('New contact form submission');
    expect(String(notification!.html)).toContain('test@example.com');
    // Still ships a text/plain alternative for non-HTML clients.
    expect(String(notification!.text)).toContain('Hello there, this is a test message.');
  });

  it('sends a branded thank-you auto-reply back to the sender', async () => {
    const mails = stubAndCapture();
    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);

    const autoReply = mails.find(m => String(m.subject).includes('Thanks for reaching out'));
    expect(autoReply).toBeDefined();
    // Delivered to the person who filled out the form...
    expect(autoReply!.to).toBe('test@example.com');
    // ...from the site address, with replies routed to the owner.
    expect(autoReply!.from).toBe(env.CONTACT_FROM);
    expect(autoReply!.replyTo).toBe(env.CONTACT_TO);
    // Warm, branded, and on-message.
    expect(String(autoReply!.html)).toContain('#3F51B5');
    expect(String(autoReply!.html)).toContain('Thanks for reaching out, Test');
    expect(String(autoReply!.text)).toContain("I'll be in touch soon");
  });

  it('escapes HTML in the sender name/message so the notification can\'t be injected', async () => {
    const mails = stubAndCapture();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({
        fields: { name: 'Evil <b>Name</b>', message: '<script>alert(1)</script>' },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);

    const notification = mails.find(m => String(m.subject).startsWith('Contact form:'));
    expect(notification).toBeDefined();
    const html = String(notification!.html);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Evil &lt;b&gt;Name&lt;/b&gt;');
  });

  it('quotes the Reply-To display-name so a crafted name can\'t smuggle an address', async () => {
    const mails = stubAndCapture();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      makeContactRequest({
        // Without quoting, this parses as TWO addresses: attacker@evil.com
        // and "spoof" <test@example.com>. Quoted, it's inert display text.
        fields: { name: 'x <attacker@evil.com>, "spoof' },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);

    const notification = mails.find(m => String(m.subject).startsWith('Contact form:'));
    expect(notification).toBeDefined();
    // The whole name lands inside one quoted-string (inner `"` stripped), and
    // the only mailbox in the list is the sender's real address.
    expect(notification!.replyTo).toBe('"x <attacker@evil.com>, spoof" <test@example.com>');
  });

  it('does not block the redirect on an auto-reply failure', async () => {
    // Turnstile ok; ForwardEmail: first call (auto-reply, fired via waitUntil)
    // fails, second call (owner notification) succeeds. The user still gets the
    // clean thank-you page.
    let feCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('siteverify')) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('forwardemail')) {
        feCalls++;
        if (feCalls === 1) throw new TypeError('fetch failed');
        return new Response('{"id":"ok"}', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = createExecutionContext();
    const res = await worker.fetch(makeContactRequest(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${SITE}/thank-you/`);
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
