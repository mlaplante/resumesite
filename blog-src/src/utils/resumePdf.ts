// Renders the downloadable /resume.pdf at build time from the same
// src/data/resume.ts module that powers the homepage and the /resume page —
// the PDF can never drift from the on-site résumé. pdfkit draws the document
// directly (no headless browser), so it runs anywhere the Astro build runs.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { decompress } from 'wawoff2';
import { profile, summary, stats, skills, experience, certifications } from '../data/resume';

// Walk up to the project's public/ dir instead of using a fixed relative
// path: Astro's prerender step rebundles this module into
// .astro/.prerender/chunks/, so import.meta.url's depth differs between the
// source tree (vitest) and the build.
function findPublicDir(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(resolve(dir, 'public/fonts/poppins'))) return resolve(dir, 'public');
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate public/fonts/poppins above ' + start);
    dir = parent;
  }
}

const PUBLIC = findPublicDir(dirname(fileURLToPath(import.meta.url)));

// Brand palette, mirroring the .resume-* styles on /resume.
const NAVY = '#1a5276';
const HEADING = '#111827';
const BODY = '#374151';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

// pdfkit needs TTF; the site ships WOFF2, so decompress at build time the
// same way the OG image generator does (see pages/og/[slug].png.ts, including
// the fresh-Buffer copy that keeps the WASM-owned bytes stable).
function freshBuffer(u8: Uint8Array): Buffer {
  const buf = Buffer.alloc(u8.length);
  buf.set(u8);
  return buf;
}

let fontCache: { regular: Buffer; semibold: Buffer; bold: Buffer } | null = null;

// Decompress strictly one at a time, copying each result before starting the
// next: wawoff2's WASM memory can grow (detaching earlier views) when calls
// overlap, which surfaces as fontkit "Unknown font format" errors.
async function loadFonts() {
  if (fontCache) return fontCache;
  const ttf = async (weight: string) =>
    freshBuffer(await decompress(readFileSync(`${PUBLIC}/fonts/poppins/poppins-${weight}.woff2`)));
  fontCache = {
    regular: await ttf('400'),
    semibold: await ttf('600'),
    bold: await ttf('700'),
  };
  return fontCache;
}

export async function renderResumePdf(): Promise<Buffer> {
  const fonts = await loadFonts();

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 54, bottom: 54, left: 58, right: 58 },
    info: {
      Title: `${profile.name} — Résumé`,
      Author: profile.name,
      Subject: profile.title,
    },
  });
  doc.registerFont('body', fonts.regular);
  doc.registerFont('semibold', fonts.semibold);
  doc.registerFont('bold', fonts.bold);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolvePdf) => {
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
  });

  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Start a new page early rather than splitting a heading or a job header
  // from the content beneath it.
  const ensureSpace = (needed: number) => {
    if (doc.y + needed > bottom()) doc.addPage();
  };

  const sectionHeading = (title: string) => {
    ensureSpace(70);
    doc
      .font('bold')
      .fontSize(10)
      .fillColor(NAVY)
      .text(title.toUpperCase(), left, doc.y, { characterSpacing: 1.5 });
    const y = doc.y + 4;
    doc.moveTo(left, y).lineTo(left + contentWidth, y).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.y = y + 10;
  };

  // ── Header ────────────────────────────────────────────────────────────
  doc.font('bold').fontSize(24).fillColor(HEADING).text(profile.name, left, doc.y);
  doc.moveDown(0.15);
  doc.font('semibold').fontSize(11).fillColor(NAVY).text(profile.title, { characterSpacing: 0.3 });
  doc.moveDown(0.4);

  const linkedin = profile.links.find((l) => l.label === 'LinkedIn');
  const contactParts = [profile.email, profile.website, ...(linkedin ? [linkedin.url] : [])];
  doc.font('body').fontSize(9).fillColor(MUTED).text(contactParts.join('   ·   '));

  const ruleY = doc.y + 10;
  doc.moveTo(left, ruleY).lineTo(left + contentWidth, ruleY).lineWidth(1.4).strokeColor(NAVY).stroke();
  doc.y = ruleY + 18;

  // ── Summary ───────────────────────────────────────────────────────────
  sectionHeading('Summary');
  for (const para of summary) {
    doc.font('body').fontSize(9.5).fillColor(BODY).text(para, { lineGap: 2.4 });
    doc.moveDown(0.5);
  }
  doc.moveDown(0.4);

  // ── Highlights ────────────────────────────────────────────────────────
  sectionHeading('Highlights');
  stats.forEach((stat, i) => {
    const last = i === stats.length - 1;
    doc.font('semibold').fontSize(10).fillColor(NAVY).text(`${stat.value} `, { continued: true });
    doc
      .font('body')
      .fillColor(MUTED)
      .text(`${stat.label}${last ? '' : '    ·    '}`, { continued: !last });
  });
  doc.moveDown(0.9);

  // ── Areas of Expertise ────────────────────────────────────────────────
  sectionHeading('Areas of Expertise');
  for (const skill of skills) {
    ensureSpace(26);
    doc
      .font('semibold')
      .fontSize(9.5)
      .fillColor(HEADING)
      .text(`${skill.name}  `, { continued: true, lineGap: 1.6 });
    doc.font('body').fillColor(MUTED).text(`— ${skill.description}`);
    doc.moveDown(0.25);
  }
  doc.moveDown(0.65);

  // ── Certifications (only when actually held — see data/resume.ts) ────
  if (certifications.length > 0) {
    sectionHeading('Certifications');
    for (const cert of certifications) {
      ensureSpace(20);
      doc.font('semibold').fontSize(9.5).fillColor(HEADING).text(cert.name, { continued: true });
      doc
        .font('body')
        .fillColor(MUTED)
        .text(`  ·  ${cert.issuer}${cert.year ? `  ·  ${cert.year}` : ''}`);
      doc.moveDown(0.25);
    }
    doc.moveDown(0.65);
  }

  // ── Experience ────────────────────────────────────────────────────────
  sectionHeading('Experience');
  for (const job of experience) {
    ensureSpace(56);
    const headY = doc.y;
    doc.font('body').fontSize(8.5);
    const dateWidth = doc.widthOfString(job.date) + 4;
    doc.fillColor(MUTED).text(job.date, left, headY + 1.5, { width: contentWidth, align: 'right' });

    doc.y = headY;
    doc
      .font('semibold')
      .fontSize(10.5)
      .fillColor(HEADING)
      .text(job.role, left, headY, { width: contentWidth - dateWidth - 10, continued: true });
    doc.font('body').fillColor(NAVY).text(`  ·  ${job.company}`);

    doc.moveDown(0.2);
    doc
      .font('body')
      .fontSize(9)
      .fillColor(BODY)
      .text(job.description, left, doc.y, { width: contentWidth, lineGap: 1.8 });
    doc.moveDown(0.75);
  }

  doc.end();
  return finished;
}
