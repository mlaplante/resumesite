import type { Env } from '../index';

const THANK_YOU = '/thank-you/';
const CONTACT_ERROR = '/contact-error/';
// Rate limit: at most this many submissions from one IP within the window.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Submissions older than this are purged opportunistically on each accepted request.
const RETENTION_MS = 90 * 86400000;

// Strip CR/LF and other control characters that could be used to inject
// extra email headers downstream when name/email are interpolated into
// replyTo / subject / body.
const stripControl = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');

// Stricter email validation than \S+@\S+\.\S+ — requires a 2+ char TLD,
// rejects whitespace, multiple @, leading/trailing dots, etc.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

export async function handleContact(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const redirectTo = (path: string) => Response.redirect(url.origin + path, 303);

  // Same-origin enforcement: the browser sends Origin on POST, and a legitimate
  // form submission from this site will match. This blocks naive cross-site
  // forms even before Turnstile runs.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    console.warn('contact: rejected on origin mismatch', { origin, expected: url.origin });
    return new Response('Forbidden', { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (form.get('bot-field')) return redirectTo(THANK_YOU);

  const name = stripControl(String(form.get('name') ?? '').trim()).slice(0, 200);
  const email = stripControl(String(form.get('email') ?? '').trim()).slice(0, 200);
  const message = String(form.get('message') ?? '').trim().slice(0, 5000);
  const token = String(form.get('cf-turnstile-response') ?? '');

  if (!name || !message || !EMAIL_RE.test(email)) {
    console.warn('contact: rejected on validation', { hasName: !!name, hasMessage: !!message, emailOk: EMAIL_RE.test(email) });
    return new Response('Invalid submission', { status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';

  if (ip) {
    const since = Date.now() - RATE_LIMIT_WINDOW_MS;
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE ip = ?1 AND ts > ?2'
    ).bind(ip, since).first<{ n: number }>();
    if (recent && recent.n >= RATE_LIMIT_MAX) {
      console.warn('contact: rejected on rate limit', { ip, recent: recent.n });
      return new Response('Too many submissions; please try again later.', {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
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
    return new Response('Challenge failed', { status: 403 });
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

  const mailBody = new URLSearchParams({
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
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: mailBody.toString(),
  });

  if (!mailRes.ok) {
    const errBody = await mailRes.text();
    console.error('ForwardEmail failed', mailRes.status, 'from=', env.CONTACT_FROM, 'body-len=', mailBody.toString().length, 'err=', errBody);
    // Submission is still recorded in D1 as a backstop. Redirect to a styled
    // error page so the submitter knows the message didn't go through.
    return redirectTo(CONTACT_ERROR);
  }
  console.log('ForwardEmail sent ok', mailRes.status);

  return redirectTo(THANK_YOU);
}
