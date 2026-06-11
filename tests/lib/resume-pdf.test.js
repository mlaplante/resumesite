import { describe, it, expect } from 'vitest';

import { renderResumePdf } from '../../blog-src/src/utils/resumePdf.ts';
import { profile, experience } from '../../blog-src/src/data/resume.ts';

describe('renderResumePdf', () => {
  it('produces a structurally valid PDF', async () => {
    const pdf = await renderResumePdf();

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-32).toString('latin1')).toContain('%%EOF');
    // Embedded fonts alone are tens of KB — a tiny file means rendering bailed.
    expect(pdf.length).toBeGreaterThan(20_000);
  });

  it('carries the résumé data in the document', async () => {
    const pdf = await renderResumePdf();
    const raw = pdf.toString('latin1');

    // Page streams are deflate-compressed, but the Info dictionary is not —
    // it proves the document was built from the shared resume.ts module.
    expect(raw).toContain(profile.name);
    expect(raw).toContain(profile.title);

    // One content stream per page; the full work history needs > 1 page.
    const pages = raw.match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(experience.length).toBeGreaterThan(0);
  });
});
