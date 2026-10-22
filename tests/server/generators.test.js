import { describe, it, expect, beforeAll } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { makeSeedPdf } from '../../server/generators/pdf.js';
import { makeTransportPass } from '../../server/generators/transport-pass.js';
import { makeSeedXml } from '../../server/generators/xml.js';
import { buildVerifyUrl } from '../../server/qr.js';

// T-418 — smoke coverage for the document/transport-pass/XML generators
// (T-4V03/T-4V04). They build raw PDFs/XML deterministically, so we can assert
// validity, QR presence, ASCII-safety, and byte-determinism without a browser.

beforeAll(() => { loadConfig(); }); // default corridor (vietnam-us-customs)

function pdfBytes(b64) { return Buffer.from(b64, 'base64'); }

describe('makeSeedPdf', () => {
  const args = ['Commercial Invoice', 'INV-1', 'LBA', 'VN-1', '2026-03-10', 'LBA', 'Northpeak Athletics Inc.', 'Vietnam', 'United States'];

  it('emits a valid single-page PDF', () => {
    const buf = pdfBytes(makeSeedPdf(...args));
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.')).toBe(true);
    expect(s).toContain('%%EOF');
  });

  it('embeds the verification QR as vector rects only when a verifyUrl is given', () => {
    const without = pdfBytes(makeSeedPdf(...args)).toString('latin1');
    expect(without).not.toContain(' re f');
    const withQr = pdfBytes(makeSeedPdf(...args, {
      verifyUrl: buildVerifyUrl({ docId: 'd1', ucr: 'VN-1', docType: 'Commercial Invoice', issuer: 'LBA', nodeId: 'alpha' }),
    })).toString('latin1');
    expect(withQr).toContain(' re f');
    expect(withQr).toContain('Scan to verify');
  });

  it('is deterministic (same inputs → identical bytes, so seed-time == serve-time hash)', () => {
    expect(makeSeedPdf(...args)).toBe(makeSeedPdf(...args));
  });
});

describe('makeTransportPass', () => {
  const c = {
    id: 'seed-VN-1', ucr: 'VN-2026-EXP-00107', exporter: 'Garment 10 Corporation JSC',
    importer: 'Northpeak Athletics Inc.', fromCountry: 'Vietnam', toCountry: 'United States',
    product: "Boys' Knit Jackets (Cotton Blend)", hsCode: '6101.20', quantity: '9,000 pcs',
    totalValue: 98000, currency: 'USD', status: 'Customs', customs: { channel: 'red' },
    originComposition: { localContentPercent: 58 },
  };

  it('emits a valid PDF with the full header, QR rects, and human-readable facts', () => {
    const s = pdfBytes(makeTransportPass(c, { nodeId: 'alpha', docCount: 5, verifiedCount: 0, corridorName: 'Vietnam Export Corridor - Customs Perspective' })).toString('latin1');
    expect(s.startsWith('%PDF-1.')).toBe(true);
    expect(s).toContain('TRANSPORT PASS');
    expect(s).toContain('VN-2026-EXP-00107');
    expect(s).toContain(' re f');                 // QR vector present
    expect(s).toContain('Scan for full shipment dossier');
  });

  it('is ASCII-only inside text blocks (no Helvetica mojibake from ·/—/→)', () => {
    const s = pdfBytes(makeTransportPass(c, { nodeId: 'alpha', docCount: 5, verifiedCount: 0 })).toString('latin1');
    // The multibyte UTF-8 lead byte 0xC2/0xE2 must not appear inside the text stream.
    expect(s.includes('Â')).toBe(false);
    expect(s).toContain('Vietnam  ->  United States'); // route uses ASCII arrow
  });
});

describe('makeSeedXml', () => {
  // makeSeedXml derives quantity/transport vars up front, so it expects a full
  // consignment record (as the seed always provides). Use a complete one.
  const m = { ucr: 'VN-1', invoiceRef: 'INV-1', declRef: 'ED-1', product: 'Polo', hsCode: '6105.10',
    quantity: '24,000 pcs', totalValue: 168000, currency: 'USD', exporter: 'LBA', importer: 'Northpeak Athletics Inc.',
    fromCountry: 'Vietnam', toCountry: 'United States', originPort: 'Ho Chi Minh City', destinationPort: 'LA',
    vessel: 'MV X', shipDate: '2026-03-10', incoterms: 'FOB' };

  it('produces well-formed XML for an Export Declaration', () => {
    const xml = makeSeedXml('Export Declaration', m, 'ED-1');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<CustomsDeclaration>');
    expect(xml).toContain('VN-1');
  });

  it('returns null for a docType with no XML template', () => {
    expect(makeSeedXml('Packing List', m, 'PL-1')).toBeNull();
  });
});
