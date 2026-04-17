import type { Env } from '../index';

const THANK_YOU = '/thank-you/';

export async function handleContact(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const redirectTo = (path: string) => Response.redirect(url.origin + path, 303);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (form.get('bot-field')) return redirectTo(THANK_YOU);

  const name = String(form.get('name') ?? '').trim().slice(0, 200);
  const email = String(form.get('email') ?? '').trim().slice(0, 200);
  const message = String(form.get('message') ?? '').trim().slice(0, 5000);
  const token = String(form.get('cf-turnstile-response') ?? '');

  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response('Invalid submission', { status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';

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

  const mailRes = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.FE_API_KEY + ':'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.CONTACT_FROM,
      to: env.CONTACT_TO,
      replyTo: `${name} <${email}>`,
      subject: `Contact form: ${name}`,
      text: `From: ${name} <${email}>\nIP: ${ip}\n\n${message}`,
    }),
  });

  if (!mailRes.ok) {
    console.error('ForwardEmail failed', mailRes.status, await mailRes.text());
  }

  return redirectTo(THANK_YOU);
}
