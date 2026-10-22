import { describe, it, expect } from 'vitest';
import { buildSinglePagePdf, escapePdfText } from '../../server/generators/pdf-core.js';

// T-420 — the shared raw-PDF envelope + text escaper (used by pdf.js + transport-pass.js).

describe('escapePdfText', () => {
  it('escapes the PDF string-literal metacharacters ( ) and backslash', () => {
    expect(escapePdfText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
  });
  it('coerces null/undefined to empty string', () => {
    expect(escapePdfText(undefined)).toBe('');
    expect(escapePdfText(null)).toBe('');
  });
});

describe('buildSinglePagePdf', () => {
  it('wraps a stream in a valid one-page PDF with the correct /Length', () => {
    const out = Buffer.from(buildSinglePagePdf('BT /F1 11 Tf ET'), 'base64').toString('latin1');
    expect(out.startsWith('%PDF-1.')).toBe(true);
    expect(out).toContain('/BaseFont/Helvetica');
    expect(out).toContain(`<</Length ${Buffer.byteLength('BT /F1 11 Tf ET', 'utf8')}>>`);
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
  });
  it('is deterministic', () => {
    expect(buildSinglePagePdf('x')).toBe(buildSinglePagePdf('x'));
  });
});
