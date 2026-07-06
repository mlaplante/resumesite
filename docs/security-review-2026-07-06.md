# OWASP Security Review — 2026-07-06

Full-application review of resumesite (michaellaplante.com) mapped to the
OWASP Top 10 (2021). Scope: the Cloudflare Worker (`worker/`), the Astro
site and its headers (`blog-src/`), the CI/CD workflows (`.github/`), and
the AI draft-generation scripts (`scripts/`) — matching the in-scope list
in `SECURITY.md`.

**Verdict: the application is in strong shape.** One low-severity code-level
hardening was found and fixed in this review (Reply-To display-name quoting,
see "Fix applied"). Everything else is either already mitigated or a
documented, accepted residual risk.

## Top 10 mapping

| Category | Status | Evidence |
|---|---|---|
| A01 Broken Access Control | ✅ Pass | No auth surface (static site). `/api/contact` enforces same-origin — rejecting requests with a *missing* `Origin` too (`worker/api/contact.ts`) — and strict method routing (POST/OPTIONS only, else 405). |
| A02 Cryptographic Failures | ✅ Pass | HSTS `max-age=31536000; includeSubDomains; preload` + `upgrade-insecure-requests` in `blog-src/public/_headers`. Secrets live in Worker env bindings / GitHub secrets, never in the repo; gitleaks runs in CI. |
| A03 Injection | ✅ Pass (1 hardening applied) | All D1 queries parameterized. Email templates escape all five HTML-significant chars; client-side search escapes for both element *and* attribute contexts (`blog-src/src/utils/search.ts`). Control chars stripped from name/email closes email header injection. Scripts use `execFileSync` with argv arrays (no shell). Fixed: Reply-To display-name is now RFC 5322-quoted (below). |
| A04 Insecure Design | ✅ Pass | Defense-in-depth on the contact flow: honeypot, Turnstile verified **fail-closed** with a 10s upstream timeout, per-IP rate limit counted on *attempts* (not accepted submissions), body cap enforced on the actual stream (not just `Content-Length`), 90-day retention purge, and delayed-delivery acknowledgement that avoids duplicate resubmissions. |
| A05 Security Misconfiguration | ✅ Pass | Strict CSP: `script-src` without `'unsafe-inline'`, paired with `assetsInlineLimit: 0` (load-bearing pairing — see architecture contract §2.1). `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `object-src 'none'`, `base-uri 'self'`. API responses are `no-store`. |
| A06 Vulnerable Components | ✅ Pass (1 accepted low) | Root project: 0 vulnerabilities. `blog-src`: 2 low — esbuild (via Astro's pinned version) "arbitrary file read when running the development server **on Windows**". Dev-server-only, never runs in production (site is static, built on Linux CI); waits on an upstream Astro bump via Dependabot. CodeQL + Dependabot (auto-merge limited to minor/patch; majors human-reviewed). |
| A07 Identification & Auth Failures | ✅ N/A | No accounts, sessions, or credentials anywhere in the app. Turnstile handles bot identification and fails closed. |
| A08 Software & Data Integrity | ✅ Pass | Every GitHub Action pinned to a full commit SHA; zizmor lints the workflows themselves; Dependabot auto-merge checks `user.login` (not `github.actor`) and skips any group containing a major bump. AI-generated blog drafts land as PRs for human review, never direct-to-master. |
| A09 Logging & Monitoring | ✅ Pass | Every contact-flow rejection emits one structured `console.warn` with the reason; Cloudflare Worker observability enabled in `wrangler.jsonc`. |
| A10 SSRF | ✅ Pass | The Worker's only outbound fetches are to two constant URLs (Turnstile siteverify, ForwardEmail API). No user-controlled URL is ever fetched; the stale-asset fallback only re-fetches the internal `ASSETS` binding with a regex-derived path. |

## Fix applied in this review

**Reply-To display-name quoting** (`worker/api/contact.ts`): the owner
notification set `replyTo: `${name} <${email}>`` with the user-supplied name
unquoted. Control characters were already stripped (so no header injection),
and the payload travels as JSON to ForwardEmail's API (not raw SMTP) — but a
crafted name such as `x <attacker@evil.com>,` could make the address list
parse as two mailboxes, smuggling a second reply address. The name is now
wrapped in an RFC 5322 quoted-string with `"` and `\` stripped, making it
inert display text. Covered by a new regression test in
`tests/worker/contact.test.ts`.

Impact was low (the sender already controls the `email` field outright), but
the fix is cheap and closes the parsing ambiguity.

## Accepted residual risks (no action taken)

1. **esbuild low advisory** (A06 above) — dev-only, Windows-only, fixed
   upstream whenever Astro bumps its esbuild; Dependabot will deliver it.
2. **`style-src 'unsafe-inline'`** — required by Astro's inlined scoped
   styles. CSS injection is far lower impact than script injection, and
   `script-src` remains strict. Revisit if Astro's CSP/hashing support
   matures.
3. **Opportunistic retention purge** — submissions older than 90 days are
   purged on accepted requests, not on a schedule (free-plan cron cap;
   documented trade-off in the code and architecture contract §3).
4. **Optional headers not set** — `Cross-Origin-Opener-Policy` /
   `Cross-Origin-Resource-Policy` would add marginal isolation, but with no
   auth, no popups, and no sensitive cross-origin state, they buy little
   here. Candidates if the site ever gains authenticated features.

## Verification

- `npm run lint` — clean
- `npm run typecheck` — 0 errors, 0 warnings, 12 hints (expected baseline)
- `npm test` — 329 passed, 20 skipped (baseline 328 + 1 new test)
- `npm audit` — root: 0 vulnerabilities; blog-src: 2 low (accepted, above)
