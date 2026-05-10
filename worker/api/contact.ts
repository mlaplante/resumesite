import type { Env } from '../index';

const THANK_YOU = '/thank-you/';
// Rate limit: at most this many submissions from one IP within the window.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Strip CR/LF and other control characters that could be used to inject
// extra email headers downstream when name/email are interpolated into
// replyTo / subject / body.
const stripControl = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');

// Stricter email validation than \S+@\S+\.\S+ — requires a 2+ char TLD,
// rejects whitespace, multiple @, leading/trailing dots, etc.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

export async function handleContact(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectTo = (path: string) => Response.redirect(url.origin + path, 303);

  // Same-origin enforcement: the browser sends Origin on POST, and a legitimate
  // form submission from this site will match. This blocks naive cross-site
  // forms even before Turnstile runs.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
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
    return new Response('Invalid submission', { status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';

  if (ip) {
    const since = Date.now() - RATE_LIMIT_WINDOW_MS;
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE ip = ?1 AND ts > ?2'
    ).bind(ip, since).first<{ n: number }>();
    if (recent && recent.n >= RATE_LIMIT_MAX) {
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
  const tsJson = (await tsRes.json()) as { success: boolean };
  if (!tsJson.success) return new Response('Challenge failed', { status: 403 });

  await env.DB.prepare(
    'INSERT INTO submissions (name, email, message, ip, ts) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(name, email, message, ip, Date.now()).run();

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
  } else {
    console.log('ForwardEmail sent ok', mailRes.status);
  }

  return redirectTo(THANK_YOU);
}
