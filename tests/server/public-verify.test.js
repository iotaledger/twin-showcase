import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';
import { qrPdfOps, buildVerifyUrl, encodeVerifyPayload } from '../../server/qr.js';
import { sha256OfBuffer } from '../../server/utils.js';

// T-4V03 (WP4) — public no-auth verification + QR generation.

const app = createApp();

beforeEach(() => {
  resetStore();
  seedStore();
});

describe('QR generation', () => {
  it('builds a verify URL with a self-describing base64url fragment', () => {
    const url = buildVerifyUrl({ docId: 'doc-1', ucr: 'VN-2026-EXP-00101', docType: 'Commercial Invoice', issuer: 'LBA', nodeId: 'alpha' });
    expect(url).toContain('/verify/doc-1?node=alpha#');
    const frag = url.split('#')[1];
    const decoded = JSON.parse(Buffer.from(frag, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ v: 1, docId: 'doc-1', ucr: 'VN-2026-EXP-00101', docType: 'Commercial Invoice', issuer: 'LBA', node: 'alpha' });
  });

  it('renders the QR as filled PDF rects (vector, no images)', () => {
    const { ops, moduleCount } = qrPdfOps('https://example.com/verify/x', { x: 476, y: 56, size: 96 });
    expect(moduleCount).toBeGreaterThan(20);
    const rects = ops.split('\n').filter(l => / re f$/.test(l));
    expect(rects.length).toBeGreaterThan(moduleCount * moduleCount * 0.3); // dark modules ≈ half the grid
    expect(ops.startsWith('q')).toBe(true);
    expect(ops.endsWith('Q')).toBe(true);
  });

  it('seeded PDFs embed the QR rects and hash the final bytes (no circularity)', () => {
    const doc = store.documents.find(d => d.filename?.endsWith('.pdf'));
    expect(doc).toBeTruthy();
    const buf = Buffer.from(doc.fileBase64, 'base64');
    expect(buf.toString('latin1')).toContain(' re f');           // vector QR present
    expect(buf.toString('latin1')).toContain('Scan to verify');  // caption present
    expect(doc.hash).toBe(sha256OfBuffer(buf));                  // hash = final bytes, QR included
  });

  it('encodeVerifyPayload round-trips through base64url', () => {
    const p = { v: 1, docId: 'a/b+c' };
    const decoded = JSON.parse(Buffer.from(encodeVerifyPayload(p), 'base64url').toString('utf8'));
    expect(decoded).toEqual(p);
  });
});

describe('GET /api/public/verify/:docId', () => {
  it('returns integrity metadata without auth and without the blob or business data', async () => {
    const doc = store.documents.find(d => d.docType === 'Export Certificate of Origin');
    const res = await request(app).get(`/api/public/verify/${doc.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('found');
    expect(res.body.document.docType).toBe('Export Certificate of Origin');
    expect(res.body.document.issuer).toContain('Certificate of Origin Office (Vietnam)');
    expect(res.body.document.ucr).toMatch(/^VN-2026-EXP-/);
    expect(res.body.integrity.sha256).toMatch(/^(0x)?[0-9a-f]{64}$/);
    // Metadata ONLY — never the content, never the values/parties.
    const flat = JSON.stringify(res.body);
    expect(res.body.document.fileBase64).toBeUndefined();
    expect(flat).not.toContain('"totalValue"');
    expect(flat).not.toContain('Northpeak');
  });

  it('unknown id returns the typed red state', async () => {
    const res = await request(app).get('/api/public/verify/forged-doc-id');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('unknown');
  });
});
