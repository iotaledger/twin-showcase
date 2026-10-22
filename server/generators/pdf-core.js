// Shared raw-PDF assembly for the document generators (pdf.js, transport-pass.js).
//
// The demo builds PDFs as a single-page raw content stream (no pdf-lib / no
// image XObjects) so a QR can be drawn as vector rects and the output stays
// deterministic — same input, same bytes, which is load-bearing: a seeded
// document's sha256 is computed on these exact bytes. Keep this the ONE place
// the envelope lives so the two generators can't drift.

// Escape the characters that are syntactically significant inside a PDF text
// string literal: `(`, `)` and the escape char `\`. (Glyph text must be ASCII —
// base-14 Helvetica renders the stream as single-byte glyphs; callers keep
// their strings ASCII.)
export function escapePdfText(s) {
  return String(s ?? '').replace(/[()\\]/g, '\\$&');
}

// Wrap a prepared content stream in a one-page A-portrait (612x792) PDF using
// Helvetica as /F1, and return it base64-encoded. Deterministic.
export function buildSinglePagePdf(stream) {
  const streamLen = Buffer.byteLength(stream, 'utf8');
  const pdf =
    `%PDF-1.4\n` +
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n` +
    `4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n` +
    `5 0 obj<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj\n` +
    `xref\n0 6\n0000000000 65535 f \n` +
    `trailer<</Size 6/Root 1 0 R>>\nstartxref\n0\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8').toString('base64');
}
