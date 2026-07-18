# Visual identity upgrade — "Executive Security Brief"

Goal: make michaellaplante.com visually distinctive ("pop") without changing content,
information architecture, framework, or backend. CSS + markup-level redesign only.

## Design tokens (the contract — derive everything from these)

Palette:
- `--ink: #0A1528` — deep navy-black. Hero, footer, dark-mode ground.
- `--ink-2: #122240` — raised surfaces on ink.
- `--paper: #F4F6F9` — cool light ground (NOT cream/beige).
- `--surface: #FFFFFF` — cards on paper.
- `--slate: #46566E` — secondary text on light.
- `--signal: #E2A33C` — amber accent. Used SPARINGLY: eyebrows, active states, CTA, hover accents, timeline dots. Never large fills except the primary CTA button.
- `--signal-deep: #B57A1E` — amber for text on light backgrounds (contrast ≥ 4.5:1).
- Grid lines on ink: `rgba(122, 152, 205, 0.10)`.

Type:
- Display: **Space Grotesk** (weights 500, 700) — self-hosted woff2 already at
  `blog-src/public/fonts/space-grotesk/` with @font-face in `public/css/fonts.css`
  (coordinator adds these before you start; verify they exist, do not download anything).
  Used for: h1/h2/h3, hero name, stat numbers, blog post titles, section headings.
- Body: keep **Poppins** exactly as-is (the build-time resume PDF depends on these files — do NOT remove or rename anything under `fonts/poppins/`).
- Utility/mono: keep **Roboto Mono** for eyebrows, nav, meta labels, the stat readout strip.
- Scale: fluid `clamp()` for display sizes; hero name ~ `clamp(2.75rem, 7vw, 5.5rem)`, tight letter-spacing (-0.02em) on Space Grotesk headings.

Shared plumbing:
- Define tokens once per stylesheet entry point: a `:root { }` block at the top of
  `blog-src/public/css/style.css` (portfolio) and `blog-src/src/styles/blog.css` (blog).
  Keep the two blocks textually identical with a comment `/* KEEP IN SYNC with <other file> */`.
- Dark mode: the site already has a theme toggle (`public/js/theme.js`, presumably `data-theme` or class on html). Find the existing dark-mode mechanism and map tokens for both themes. Dark mode ground = `--ink`, cards = `--ink-2`, accent stays `--signal`.
- Focus: global visible `:focus-visible` ring using `--signal`, 2px offset.
- Motion: every animation wrapped in `@media (prefers-reduced-motion: no-preference)`. The site recently shipped a fix so pages never render blank if scroll-animation JS fails — preserve that behavior (elements must be visible by default without JS).

## Signature element (the one memorable thing)

**Hero as a briefing cover** on the portfolio homepage (`src/pages/index.astro` + `public/css/style.css`):
- Replace the blue gradient with `--ink` ground plus a faint blueprint grid
  (CSS `background-image: linear-gradient(...) , linear-gradient(...)` hairlines, ~48px cells, using the grid-line rgba above) and one slow, subtle radial "radar sweep" — a CSS `conic-gradient` layer rotating over ~24s at very low opacity (≤ 0.06), disabled under reduced motion. CSS only, no canvas, no new JS.
- Above the name, a mono eyebrow line in `--signal`, styled like a dossier label, e.g.
  `MICHAEL LA PLANTE / SVP, INFORMATION SECURITY & OPERATIONS` (reuse existing copy; do not invent new claims).
- Name set huge in Space Grotesk 700. Keep the headshot but reframe: smaller, offset, with a thin `--signal` ring/offset-border instead of centered-circle-above-name.
- CTAs: primary "Schedule a consultation" = solid `--signal` on ink (ink text), secondary "View résumé" = outlined, quiet.
- **Stat readout strip** docked at the hero's bottom edge: the existing by-the-numbers stats ($800M / 15+ / 70+ / 500+) as a single horizontal mono-labeled strip — numbers in Space Grotesk, labels in Roboto Mono uppercase, thin separators, hairline top border in grid-line color. Remove/slim the old "by the numbers" section so the data isn't duplicated (keep the section if it holds copy the strip can't, otherwise delete it).

Everything else stays quiet and disciplined — the hero is the one bold move.

## Supporting refinements

Portfolio page (`index.astro`, `style.css`):
1. Section eyebrows (`about me`, `consulting services`, …): Roboto Mono uppercase in `--signal-deep`, preceded by a short 24px hairline; section headings in Space Grotesk.
2. Cards (consulting services, areas of expertise): remove the uniform hairline-border-on-white look. Use `--surface` with a soft shadow token, 8px radius, a 2px top rule that is transparent by default and becomes `--signal` on hover, plus a subtle translateY(-2px) lift (desktop hover only; guard with `@media (hover: hover)`).
3. Experience timeline: `--signal` dots, hairline connector in grid-line color, company names in Space Grotesk 500, dates in Roboto Mono.
4. Contact section + footer: footer on `--ink` to bookend the hero, mono meta text.
5. Buttons/links globally: consistent underline animation (background-size trick or ::after scaleX) on text links; consistent button states (hover, active, focus-visible).

Blog (`src/styles/blog.css`, `src/layouts/BlogLayout.astro`, `src/components/blog/*`):
6. Nav bar: `--ink` background (it's already dark blue) with mono links; active link underlined in `--signal`.
7. Blog index: first (newest) post gets a **featured card** treatment — larger, on `--ink` with light text and `--signal` category chip. Remaining cards match the portfolio card language (top-rule hover, shadow token). Post titles in Space Grotesk.
8. Post page: title in Space Grotesk, meta line in mono, reading-progress bar recolored to `--signal`.
9. The services cross-promo card on the blog index: restyle onto `--ink-2`/dark with `--signal` accent so it stands apart from post cards.

## Constraints (hard)

- No new runtime JS beyond trivial class toggles; prefer CSS-only. No canvas, no external scripts, no CDN anything — CSP is strict and all assets are self-hosted.
- Do not touch: worker/, scripts/generate-post.js, GitHub workflows, resume.pdf.ts, resume data module semantics, `fonts/poppins/*`.
- `public/_headers` CSP must not need changes (self-hosted assets only).
- PurgeCSS runs post-build over the css files (`blog-src/scripts/purge-css.mjs`); if you add classes only referenced from JS, add them to its `safelist`.
- Dark mode parity for every change; test both themes.
- Mobile: everything must hold at 390px (hero name wraps, stat strip wraps to 2×2 grid, cards stack).
- Keep Lighthouse-friendly: font-display swap, no layout shift from the new display font (set sensible fallback stack: `'Space Grotesk', 'Poppins', system-ui, sans-serif`).

## Task order (commit after each; if sandbox blocks the commit, continue and list exact `git add` files per pending commit at the end)

1. tokens + @font-face + focus ring (both stylesheets) — no visual change yet beyond focus.
2. Hero briefing-cover redesign + stat readout strip.
3. Portfolio sections: eyebrows, cards, timeline, footer/contact.
4. Blog: nav, featured card, card language, post page, promo card.
5. Global link/button micro-interactions + dark-mode + reduced-motion + 390px audit pass.

## Verification (each task)

- `npm run typecheck` (astro check), `npm run lint`, `npm test` from repo root.
  If a test invocation is blocked by the sandbox, try targeted test files; if still blocked, continue implementing — the coordinator verifies outside the sandbox.
- `npm run build` must succeed (includes PurgeCSS + fingerprinting).
- Do not `git add -f` anything gitignored.
