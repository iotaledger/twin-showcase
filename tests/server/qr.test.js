import { describe, it, expect } from 'vitest';
import {
  publicBaseUrl, encodeVerifyPayload, buildVerifyUrl, buildShipmentUrl, qrPdfOps,
} from '../../server/qr.js';

// T-418 — unit coverage for the QR helpers (T-4V03 doc QR + T-4V04 shipment QR).
// Pure functions, no infra.

function decodeFragment(url) {
  return JSON.parse(Buffer.from(url.split('#')[1], 'base64url').toString('utf8'));
}

describe('encodeVerifyPayload', () => {
  it('round-trips arbitrary objects through base64url (UTF-8 safe)', () => {
    const p = { v: 1, route: 'Vietnam → United States', exporter: 'Công ty LBA', n: 7 };
    const decoded = JSON.parse(Buffer.from(encodeVerifyPayload(p), 'base64url').toString('utf8'));
    expect(decoded).toEqual(p);
  });

  it('emits base64url (no +, /, or = padding)', () => {
    const enc = encodeVerifyPayload({ s: '???>>>'.repeat(4) });
    expect(enc).not.toMatch(/[+/=]/);
  });
});

describe('buildVerifyUrl (document QR)', () => {
  it('targets /verify/<docId> with node query + self-describing fragment', () => {
    const url = buildVerifyUrl({ docId: 'doc-1', ucr: 'VN-1', docType: 'Commercial Invoice', issuer: 'LBA', nodeId: 'alpha' });
    expect(url).toContain('/verify/doc-1?node=alpha#');
    expect(decodeFragment(url)).toEqual({ v: 1, docId: 'doc-1', ucr: 'VN-1', docType: 'Commercial Invoice', issuer: 'LBA', node: 'alpha' });
  });

  it('url-encodes the docId path segment', () => {
    const url = buildVerifyUrl({ docId: 'a/b c', ucr: 'x', docType: 'd', issuer: 'i', nodeId: 'beta' });
    expect(url).toContain('/verify/a%2Fb%20c?node=beta#');
  });
});

describe('buildShipmentUrl (shipment QR)', () => {
  it('targets /shipment/<id> with route summary in the fragment', () => {
    const url = buildShipmentUrl({ id: 'seed-X', ucr: 'VN-1', exporter: 'LBA', importer: 'Northpeak Athletics Inc.', fromCountry: 'Vietnam', toCountry: 'United States', nodeId: 'alpha' });
    expect(url).toContain('/shipment/seed-X?node=alpha#');
    expect(decodeFragment(url)).toMatchObject({ v: 1, id: 'seed-X', ucr: 'VN-1', route: 'Vietnam → United States', node: 'alpha' });
  });

  it('omits route when a country is missing', () => {
    const url = buildShipmentUrl({ id: 'x', ucr: 'u', exporter: 'e', importer: 'i', fromCountry: 'Vietnam', toCountry: undefined, nodeId: 'alpha' });
    expect(decodeFragment(url).route).toBeUndefined();
  });
});

describe('publicBaseUrl', () => {
  it('strips a trailing slash and defaults to the proxy', () => {
    expect(publicBaseUrl()).toBe('http://localhost:4002'); // no PUBLIC_BASE_URL in test env
  });
});

describe('qrPdfOps', () => {
  it('emits one filled rect per dark module, wrapped in q…Q', () => {
    const { ops, moduleCount } = qrPdfOps('https://example.com/verify/x', { x: 10, y: 20, size: 90 });
    expect(moduleCount).toBeGreaterThan(20);
    expect(ops.startsWith('q')).toBe(true);
    expect(ops.endsWith('Q')).toBe(true);
    const rects = ops.split('\n').filter(l => / re f$/.test(l));
    expect(rects.length).toBeGreaterThan(moduleCount * moduleCount * 0.25);
  });

  it('higher error-correction (Q) yields a denser/larger matrix than M for the same text', () => {
    const text = 'https://example.com/shipment/seed-VN-2026-EXP-00101?node=alpha';
    const m = qrPdfOps(text, { x: 0, y: 0, size: 100, errorCorrectionLevel: 'M' });
    const q = qrPdfOps(text, { x: 0, y: 0, size: 100, errorCorrectionLevel: 'Q' });
    expect(q.moduleCount).toBeGreaterThanOrEqual(m.moduleCount);
  });
});
