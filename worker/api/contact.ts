import type { Env } from '../index';

const THANK_YOU = '/thank-you/';
const CONTACT_ERROR = '/contact-error/';
// Rate limit: at most this many submissions from one IP within the window.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Submissions older than this are purged opportunistically on each accepted request.
const RETENTION_MS = 90 * 86_400_000;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 200;
const MAX_MESSAGE_LEN = 5000;

// Strip CR/LF and other control characters that could be used to inject
// extra email headers downstream when name/email are interpolated into
// replyTo / subject / body.
const stripControl = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');

// Stricter email validation than \S+@\S+\.\S+ — requires a 2+ char TLD,
// rejects whitespace, multiple @, leading/trailing dots, etc.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

const NO_STORE: HeadersInit = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function plain(status: number, body: string, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE, ...extra },
  });
}

export async function handleContact(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const redirectTo = (path: string) =>
    new Response(null, { status: 303, headers: { Location: url.origin + path, ...NO_STORE } });

  // Same-origin enforcement: every modern browser sends `Origin` on POST.
  // A legitimate form submission from this site matches `url.origin`.
  // Reject anything else — including requests with NO Origin — to close the
  // cross-site form bypass that the prior `if (origin && ...)` left open.
  const origin = request.headers.get('Origin');
  if (origin !== url.origin) {
    console.warn('contact: rejected on origin mismatch', { origin, expected: url.origin });
    return plain(403, 'Forbidden');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return plain(400, 'Bad request');
  }

  if (form.get('bot-field')) return redirectTo(THANK_YOU);

  const name = stripControl(String(form.get('name') ?? '').trim()).slice(0, MAX_NAME_LEN);
  const email = stripControl(String(form.get('email') ?? '').trim()).slice(0, MAX_EMAIL_LEN);
  const message = String(form.get('message') ?? '').trim().slice(0, MAX_MESSAGE_LEN);
  const token = String(form.get('cf-turnstile-response') ?? '');

  if (!name || !message || !EMAIL_RE.test(email)) {
    console.warn('contact: rejected on validation', { hasName: !!name, hasMessage: !!message, emailOk: EMAIL_RE.test(email) });
    return plain(400, 'Invalid submission');
  }

  if (!token) {
    console.warn('contact: rejected on missing turnstile token');
    return plain(403, 'Challenge missing');
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';

  if (ip) {
    const since = Date.now() - RATE_LIMIT_WINDOW_MS;
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE ip = ?1 AND ts > ?2'
    ).bind(ip, since).first<{ n: number }>();
    if (recent && recent.n >= RATE_LIMIT_MAX) {
      console.warn('contact: rejected on rate limit', { ip, recent: recent.n });
      return plain(429, 'Too many submissions; please try again later.', {
        'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
      });
    }
  }

  const tsBody = new FormData();
  tsBody.set('secret', env.TURNSTILE_SECRET);
  tsBody.set('response', token);
  if (ip) tsBody.set('remoteip', ip);

  const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: tsBody,
  });
  const tsJson = (await tsRes.json()) as { success: boolean; 'error-codes'?: string[] };
  if (!tsJson.success) {
    console.warn('contact: rejected on turnstile', { errors: tsJson['error-codes'] });
    return plain(403, 'Challenge failed');
  }

  await env.DB.prepare(
    'INSERT INTO submissions (name, email, message, ip, ts) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(name, email, message, ip, Date.now()).run();

  // Opportunistic retention purge — kept off the response path via waitUntil.
  // Cloudflare's free Workers plan caps cron triggers per account, so we
  // piggy-back on accepted submissions instead of using a scheduled handler.
  const retentionCutoff = Date.now() - RETENTION_MS;
  ctx.waitUntil(
    env.DB.prepare('DELETE FROM submissions WHERE ts < ?1').bind(retentionCutoff).run()
      .catch(err => console.error('retention purge failed:', err))
  );

  const mailBody = JSON.stringify({
    from: env.CONTACT_FROM,
    to: env.CONTACT_TO,
    replyTo: `${name} <${email}>`,
    subject: `Contact form: ${name}`,
    text: `From: ${name} <${email}>\nIP: ${ip}\n\n${message}`,
  });

  const mailRes = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.FE_API_KEY + ':'),
      'Content-Type': 'application/json',
    },
    body: mailBody,
  });

  if (!mailRes.ok) {
    const errBody = await mailRes.text();
    const requestId = mailRes.headers.get('X-Request-Id') ?? '';
    console.error('ForwardEmail failed', mailRes.status, 'request-id=', requestId, 'body-len=', mailBody.length, 'err=', errBody);
    // Submission is still recorded in D1 as a backstop.
    return new Response(null, {
      status: 303,
      headers: { Location: url.origin + CONTACT_ERROR, ...NO_STORE },
    });
  }
  console.log('ForwardEmail sent ok', mailRes.status);

  return redirectTo(THANK_YOU);
}
