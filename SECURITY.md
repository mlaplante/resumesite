# Security Policy

Thanks for helping keep [michaellaplante.com](https://michaellaplante.com) and
its users safe.

## Reporting a Vulnerability

If you believe you've found a security issue in this repository or the live
site, please report it privately rather than opening a public issue.

Preferred channels, in order:

1. **GitHub** — open a [private security advisory](https://github.com/mlaplante/resumesite/security/advisories/new)
   (Security → Advisories → "Report a vulnerability").
2. **Contact form** — <https://michaellaplante.com/#contact>

The site also publishes a machine-readable policy per
[RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) at
<https://michaellaplante.com/.well-known/security.txt>.

Please include enough detail to reproduce the issue (affected URL or file,
steps, and impact). A proof of concept is appreciated but not required.

## Scope

In scope:

- The Cloudflare Worker and `/api/contact` backend (`worker/`)
- The Astro site build and its content/output (`blog-src/`)
- The CI/CD workflows and AI draft-generation scripts (`.github/`, `scripts/`)

Out of scope:

- Reports from automated scanners with no demonstrated impact
- Missing security headers already covered by `blog-src/public/_headers`
- Denial-of-service / volumetric testing against the live site
- Social engineering, physical attacks, or third-party services
  (Cloudflare, ForwardEmail, Buttondown, Cal.com) — report those to the
  respective vendor

## Disclosure

This is a personal site, so there's no formal SLA, but I aim to acknowledge
reports within a few days. Please give a reasonable window to remediate before
any public disclosure.
