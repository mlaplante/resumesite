// Branded email templates for the contact flow.
//
// Two emails share one brand-styled shell (see `shell()`), so the owner
// notification and the sender auto-reply stay visually consistent with
// michaellaplante.com — Material Indigo (#3F51B5), Poppins headings, a
// Roboto Mono accent label, and the site's own footer identity.
//
// Everything is table-based with inline styles because that is the only
// layout that renders reliably across email clients (Gmail, Outlook, Apple
// Mail, mobile). Web fonts can't be relied on in email, so Poppins / Roboto
// Mono lead a web-safe fallback stack and degrade gracefully.

export interface ContactDetails {
  name: string;
  email: string;
  message: string;
  ip: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Brand tokens — mirror of blog-src/public/css/style.css. Centralized here so
// both templates draw from one palette.
const BRAND = {
  primary: '#3F51B5', // Material Indigo — the site's primary accent
  primaryDark: '#303F9F',
  ink: '#202020', // near-black used for body text and dark surfaces
  muted: '#808080',
  pageBg: '#F1F1F1',
  cardBg: '#FFFFFF',
  border: '#E0E0E0',
  sans: "'Poppins', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'Roboto Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

const SITE_URL = 'https://michaellaplante.com';
const OWNER_NAME = 'Michael LaPlante';
const OWNER_TITLE = 'SVP of Information Security and Operations';
const LINKEDIN_URL = 'https://www.linkedin.com/in/mlaplante/';
const GITHUB_URL = 'https://github.com/mlaplante';

// Escape the five HTML-significant characters so user-supplied name / email /
// message can't inject markup into the notification email.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Preserve author line breaks when dropping a plain-text message into HTML.
function nl2br(s: string): string {
  return esc(s).replace(/\r?\n/g, '<br />');
}

const year = new Date().getFullYear();

// The shared brand shell. `preheader` is the hidden inbox-preview snippet;
// `title` is the Roboto Mono accent label above the heading; `bodyHtml` is the
// already-escaped inner content of the white card.
function shell(opts: { preheader: string; accent: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${esc(OWNER_NAME)}</title>
</head>
<body style="margin:0; padding:0; background:${BRAND.pageBg}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent; font-size:1px; line-height:1px;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">
        <!-- Header -->
        <tr>
          <td style="background:${BRAND.primary}; border-radius:12px 12px 0 0; padding:28px 32px;">
            <a href="${SITE_URL}" style="text-decoration:none;">
              <span style="display:block; font-family:${BRAND.sans}; font-size:20px; font-weight:700; color:#FFFFFF; letter-spacing:0.5px;">${esc(OWNER_NAME)}</span>
              <span style="display:block; margin-top:4px; font-family:${BRAND.mono}; font-size:11px; font-weight:400; color:#C5CAE9; text-transform:lowercase; letter-spacing:2px;">${esc(OWNER_TITLE)}</span>
            </a>
          </td>
        </tr>
        <!-- Body card -->
        <tr>
          <td style="background:${BRAND.cardBg}; padding:36px 32px 32px; border-left:1px solid ${BRAND.border}; border-right:1px solid ${BRAND.border};">
            <p style="margin:0 0 6px; font-family:${BRAND.mono}; font-size:11px; font-weight:500; color:${BRAND.primary}; text-transform:lowercase; letter-spacing:2px;">${esc(opts.accent)}</p>
            ${opts.bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:${BRAND.ink}; border-radius:0 0 12px 12px; padding:24px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:${BRAND.sans}; font-size:13px; color:#B0B0B0; line-height:1.6;">
                  <a href="${SITE_URL}" style="color:#FFFFFF; text-decoration:none; font-weight:600;">michaellaplante.com</a>
                  &nbsp;&middot;&nbsp;
                  <a href="${LINKEDIN_URL}" style="color:#C5CAE9; text-decoration:none;">LinkedIn</a>
                  &nbsp;&middot;&nbsp;
                  <a href="${GITHUB_URL}" style="color:#C5CAE9; text-decoration:none;">GitHub</a>
                </td>
              </tr>
              <tr>
                <td style="padding-top:12px; font-family:${BRAND.mono}; font-size:11px; color:${BRAND.muted}; letter-spacing:0.5px;">
                  Copyright &copy; LaPlante Web Development 2006&ndash;${year}.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Reusable button (bulletproof-ish VML-free anchor button).
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;">
    <tr>
      <td style="border-radius:6px; background:${BRAND.primary};">
        <a href="${href}" style="display:inline-block; padding:12px 24px; font-family:${BRAND.sans}; font-size:14px; font-weight:600; color:#FFFFFF; text-decoration:none; border-radius:6px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

// -------------------------------------------------------------------------
// Owner notification: sent to CONTACT_TO when a submission comes in.
// -------------------------------------------------------------------------
export function renderNotificationEmail(d: ContactDetails): RenderedEmail {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid ${BRAND.border}; font-family:${BRAND.mono}; font-size:11px; color:${BRAND.muted}; text-transform:uppercase; letter-spacing:1px; width:88px; vertical-align:top;">${esc(label)}</td>
      <td style="padding:10px 0; border-bottom:1px solid ${BRAND.border}; font-family:${BRAND.sans}; font-size:15px; color:${BRAND.ink}; vertical-align:top;">${value}</td>
    </tr>`;

  const bodyHtml = `
    <h1 style="margin:0 0 18px; font-family:${BRAND.sans}; font-size:22px; font-weight:700; color:${BRAND.ink};">New contact form submission</h1>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
      ${row('From', esc(d.name))}
      ${row('Email', `<a href="mailto:${esc(d.email)}" style="color:${BRAND.primary}; text-decoration:none;">${esc(d.email)}</a>`)}
      ${row('IP', esc(d.ip || 'unknown'))}
    </table>
    <p style="margin:0 0 8px; font-family:${BRAND.mono}; font-size:11px; color:${BRAND.muted}; text-transform:uppercase; letter-spacing:1px;">Message</p>
    <div style="padding:16px 18px; background:${BRAND.pageBg}; border-left:3px solid ${BRAND.primary}; border-radius:4px; font-family:${BRAND.sans}; font-size:15px; line-height:1.65; color:${BRAND.ink};">${nl2br(d.message)}</div>
    ${button(`mailto:${esc(d.email)}?subject=${encodeURIComponent('Re: your message')}`, 'Reply to ' + esc(d.name))}`;

  const html = shell({
    preheader: `New message from ${d.name}`,
    accent: 'contact form',
    bodyHtml,
  });

  const text = [
    'New contact form submission',
    '',
    `From:  ${d.name}`,
    `Email: ${d.email}`,
    `IP:    ${d.ip || 'unknown'}`,
    '',
    'Message:',
    d.message,
    '',
    '—',
    `${OWNER_NAME} · ${SITE_URL}`,
  ].join('\n');

  return { subject: `Contact form: ${d.name}`, html, text };
}

// -------------------------------------------------------------------------
// Auto-reply: sent back to the person who submitted the form.
// -------------------------------------------------------------------------
export function renderAutoReplyEmail(d: Pick<ContactDetails, 'name'>): RenderedEmail {
  // Use the first name only for a warmer greeting; fall back to the full
  // string if there's no whitespace to split on.
  const firstName = d.name.trim().split(/\s+/)[0] || 'there';

  const bodyHtml = `
    <h1 style="margin:0 0 16px; font-family:${BRAND.sans}; font-size:22px; font-weight:700; color:${BRAND.ink};">Thanks for reaching out, ${esc(firstName)}!</h1>
    <p style="margin:0 0 16px; font-family:${BRAND.sans}; font-size:15px; line-height:1.7; color:${BRAND.ink};">
      Your message has landed safely in my inbox. I read every note personally, and I'll be in touch soon &mdash; usually within a business day or two.
    </p>
    <p style="margin:0 0 24px; font-family:${BRAND.sans}; font-size:15px; line-height:1.7; color:${BRAND.ink};">
      In the meantime, feel free to explore recent writing and work, or connect with me directly.
    </p>
    ${button(SITE_URL + '/blog/', 'Read the blog')}
    <p style="margin:24px 0 0; font-family:${BRAND.sans}; font-size:15px; line-height:1.7; color:${BRAND.ink};">
      Talk soon,<br />
      <strong style="color:${BRAND.ink};">${esc(OWNER_NAME)}</strong><br />
      <span style="font-family:${BRAND.mono}; font-size:12px; color:${BRAND.muted}; letter-spacing:0.5px;">${esc(OWNER_TITLE)}</span>
    </p>`;

  const html = shell({
    preheader: "Thanks for reaching out — I'll be in touch soon.",
    accent: 'thank you',
    bodyHtml,
  });

  const text = [
    `Thanks for reaching out, ${firstName}!`,
    '',
    "Your message has landed safely in my inbox. I read every note personally, and I'll be in touch soon — usually within a business day or two.",
    '',
    'In the meantime, feel free to explore recent writing and work:',
    `${SITE_URL}/blog/`,
    '',
    'Talk soon,',
    OWNER_NAME,
    OWNER_TITLE,
    '',
    '—',
    SITE_URL,
  ].join('\n');

  return {
    subject: "Thanks for reaching out — I'll be in touch soon",
    html,
    text,
  };
}
