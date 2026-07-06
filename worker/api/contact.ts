import type { Env } from '../index';
import { renderNotificationEmail, renderAutoReplyEmail } from '../email/templates';

const THANK_YOU = '/thank-you/';
// Email delivery failed but the submission is safely stored — tell the sender
// it was received rather than bouncing them to the error page (which invites
// a duplicate resubmission).
const THANK_YOU_DELAYED = '/thank-you/?delivery=delayed';
const CONTACT_ERROR = '/contact-error/';
// Rate limit: at most this many attempts from one IP within the window.
// Counted against contact_attempts — every POST that reaches the Turnstile
// check — so failing the challenge repeatedly can't be used to hammer
// siteverify and D1 for free.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Submissions older than this are purged opportunistically on each accepted request.
const RETENTION_MS = 90 * 86_400_000;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 200;
const MAX_MESSAGE_LEN = 5000;
const MAX_FORM_BYTES = 32 * 1024;
// Cap time spent waiting on Turnstile / ForwardEmail so a hung upstream
// can't stall the request until the platform kills it.
const UPSTREAM_TIMEOUT_MS = 10_000;

// Strip CR/LF and other control characters that could be used to inject
// extra email headers downstream when name/email are interpolated into
// replyTo / subject / body.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const stripControl = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');

// Stricter email validation than \S+@\S+\.\S+ — requires a 2+ char TLD,
// rejects whitespace, multiple @, leading/trailing dots, etc.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

// Display-name for the notification's Reply-To, quoted per RFC 5322 with `"`
// and `\` stripped. Without quoting, a crafted name like `x <a@evil.com>,`
// could smuggle a second address into the address list ForwardEmail parses.
const quoteDisplayName = (s: string) => `"${s.replace(/[\\"]/g, '')}"`;

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

// Read the request body with a hard byte cap. The Content-Length header is
// client-controlled and absent on chunked uploads, so the cap has to be
// enforced on the actual stream. Returns null when the cap is exceeded.
async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    total += read.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buf;
}

const FORWARDEMAIL_URL = 'https://api.forwardemail.net/v1/emails';

interface MailPayload {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

// Single point of contact with ForwardEmail. Both the owner notification and
// the sender auto-reply go through here so auth, timeout, and the JSON shape
// stay in one place. The AbortSignal caps how long a hung upstream can stall
// the caller.
function sendMail(env: Env, payload: MailPayload): Promise<Response> {
  return fetch(FORWARDEMAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.FE_API_KEY + ':'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

export async function handleContact(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const redirectTo = (path: string) =>
    new Response(null, { status: 303, headers: { Location: url.origin + path, ...NO_STORE } });
  // Log-and-bounce helper: every rejection path emits one structured warning
  // and lands the user on the friendly error page.
  const reject = (reason: string, details?: Record<string, unknown>) => {
    console.warn(`contact: rejected on ${reason}`, details ?? {});
    return redirectTo(CONTACT_ERROR);
  };

  // Same-origin enforcement: every modern browser sends `Origin` on POST.
  // A legitimate form submission from this site matches `url.origin`.
  // Reject anything else — including requests with NO Origin — to close the
  // cross-site form bypass that the prior `if (origin && ...)` left open.
  const origin = request.headers.get('Origin');
  if (origin !== url.origin) {
    console.warn('contact: rejected on origin mismatch', { origin, expected: url.origin });
    return plain(403, 'Forbidden');
  }

  const contentType = request.headers.get('Content-Type') ?? '';
  if (
    !contentType.startsWith('application/x-www-form-urlencoded') &&
    !contentType.startsWith('multipart/form-data')
  ) {
    return plain(415, 'Unsupported media type');
  }

  // Fast reject on the declared size, then enforce the same cap on the real
  // stream — Content-Length is client-controlled and absent on chunked bodies.
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > MAX_FORM_BYTES) {
    console.warn('contact: rejected on body size', { contentLength, max: MAX_FORM_BYTES });
    return plain(413, 'Payload too large');
  }
  const rawBody = await readBodyCapped(request, MAX_FORM_BYTES);
  if (rawBody === null) {
    console.warn('contact: rejected on body size (stream cap)', { max: MAX_FORM_BYTES });
    return plain(413, 'Payload too large');
  }

  let form: FormData;
  try {
    form = await new Response(rawBody, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return plain(400, 'Bad request');
  }

  if (form.get('bot-field')) return redirectTo(THANK_YOU);

  const name = stripControl(String(form.get('name') ?? '').trim()).slice(0, MAX_NAME_LEN);
  const email = stripControl(String(form.get('email') ?? '').trim()).slice(0, MAX_EMAIL_LEN);
  const message = String(form.get('message') ?? '').trim().slice(0, MAX_MESSAGE_LEN);
  const token = String(form.get('cf-turnstile-response') ?? '');

  if (!name || !message || !EMAIL_RE.test(email)) {
    return reject('validation', { hasName: !!name, hasMessage: !!message, emailOk: EMAIL_RE.test(email) });
  }

  if (!token) {
    return reject('missing turnstile token');
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';

  if (ip) {
    const now = Date.now();
    const since = now - RATE_LIMIT_WINDOW_MS;
    // Count *attempts*, not accepted submissions — otherwise a client that
    // keeps failing Turnstile gets unlimited free runs at siteverify.
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM contact_attempts WHERE ip = ?1 AND ts > ?2'
    ).bind(ip, since).first<{ n: number }>();
    if (recent && recent.n >= RATE_LIMIT_MAX) {
      return reject('rate limit', { ip, recent: recent.n });
    }
    await env.DB.prepare(
      'INSERT INTO contact_attempts (ip, ts) VALUES (?1, ?2)'
    ).bind(ip, now).run();
    // Attempts only matter within the rate-limit window; prune the old ones
    // on every recorded attempt so the table can't grow unbounded even if no
    // submission is ever accepted.
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM contact_attempts WHERE ts < ?1').bind(since).run()
        .catch(err => console.error('attempt purge failed:', err))
    );
  }

  const tsBody = new FormData();
  tsBody.set('secret', env.TURNSTILE_SECRET);
  tsBody.set('response', token);
  if (ip) tsBody.set('remoteip', ip);

  // Fail closed: a siteverify outage, timeout, or malformed response means we
  // could not verify the human — bounce to the error page instead of letting
  // the exception surface as an opaque 500 (or worse, skipping verification).
  let tsJson: { success: boolean; 'error-codes'?: string[] };
  try {
    const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: tsBody,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    tsJson = (await tsRes.json()) as { success: boolean; 'error-codes'?: string[] };
  } catch (err) {
    return reject('turnstile verify error', { error: String(err) });
  }
  if (!tsJson.success) {
    return reject('turnstile', { errors: tsJson['error-codes'] });
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

  // Fire the branded thank-you auto-reply to the sender as a best-effort side
  // task. It rides on ctx.waitUntil so a slow or failing send never delays the
  // user's redirect or downgrades their acknowledgement — the auto-reply is a
  // courtesy, not part of the delivery guarantee. replyTo points back at the
  // owner so a reply from the sender still lands in the right inbox. Gated
  // behind Turnstile + the per-IP rate limit above, which bounds any use of
  // this as a reflector toward a spoofed address.
  const autoReply = renderAutoReplyEmail({ name });
  ctx.waitUntil(
    sendMail(env, {
      from: env.CONTACT_FROM,
      to: email,
      replyTo: env.CONTACT_TO,
      subject: autoReply.subject,
      html: autoReply.html,
      text: autoReply.text,
    })
      .then(res => {
        if (!res.ok) console.error('auto-reply failed', res.status);
        else console.log('auto-reply sent ok', res.status);
      })
      .catch(err => console.error('auto-reply fetch failed:', String(err))),
  );

  // The owner notification is the delivery that matters — its failure is what
  // decides whether the sender sees the delayed-delivery acknowledgement.
  const notification = renderNotificationEmail({ name, email, message, ip });
  let mailRes: Response;
  try {
    mailRes = await sendMail(env, {
      from: env.CONTACT_FROM,
      to: env.CONTACT_TO,
      replyTo: `${quoteDisplayName(name)} <${email}>`,
      subject: notification.subject,
      html: notification.html,
      text: notification.text,
    });
  } catch (err) {
    // The submission is safely recorded in D1 — acknowledge receipt instead
    // of showing an error that would prompt a duplicate resubmission.
    console.error('ForwardEmail fetch failed:', String(err));
    return redirectTo(THANK_YOU_DELAYED);
  }

  if (!mailRes.ok) {
    const errBody = await mailRes.text();
    const requestId = mailRes.headers.get('X-Request-Id') ?? '';
    console.error('ForwardEmail failed', mailRes.status, 'request-id=', requestId, 'err=', errBody);
    // The submission is safely recorded in D1 — acknowledge receipt.
    return redirectTo(THANK_YOU_DELAYED);
  }
  console.log('ForwardEmail sent ok', mailRes.status);

  return redirectTo(THANK_YOU);
}
