import type { APIRoute } from 'astro';
import { renderResumePdf } from '../utils/resumePdf';

// Prerendered at build time into dist/resume.pdf — the downloadable twin of
// the /resume page, generated from the same src/data/resume.ts module.
export const GET: APIRoute = async () => {
  const pdf = await renderResumePdf();
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="Michael-LaPlante-Resume.pdf"',
    },
  });
};
