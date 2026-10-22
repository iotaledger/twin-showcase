import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';
import { buildShipmentUrl, encodeVerifyPayload } from '../../server/qr.js';
import { consignmentToUnece, flatFromAigVertex } from '../../server/twin/unece.js';

// T-4V04 — public shipment view, transport pass, QR, and the customs-block
// AIG round-trip (WP1b).

const app = createApp();

beforeEach(() => {
  resetStore();
  seedStore();
});

describe('shipment QR url', () => {
  it('builds /shipment/<id> with a self-describing offline fragment', () => {
    const url = buildShipmentUrl({ id: 'seed-X', ucr: 'VN-2026-EXP-00101', exporter: 'LBA', importer: 'Northpeak Athletics Inc.', fromCountry: 'Vietnam', toCountry: 'United States', nodeId: 'alpha' });
    expect(url).toContain('/shipment/seed-X?node=alpha#');
    const decoded = JSON.parse(Buffer.from(url.split('#')[1], 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ v: 1, id: 'seed-X', ucr: 'VN-2026-EXP-00101', route: 'Vietnam → United States', node: 'alpha' });
  });
});

describe('GET /api/public/shipment/:id', () => {
  it('returns the curated border dossier with no auth', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/public/shipment/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('found');
    expect(res.body.shipment.ucr).toBe('VN-2026-EXP-00101');
    expect(res.body.shipment.exporter).toBeTruthy();
    expect(res.body.shipment.hsCode).toBeTruthy();
    expect(res.body.shipment.customs.declarationNo).toMatch(/^\d{12}$/);
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(res.body.documents.length).toBeGreaterThan(0);
    for (const d of res.body.documents) {
      expect(d).toHaveProperty('notarization');
      expect(d).toHaveProperty('docType');
    }
  });

  it('NEVER exposes finance/payment data', async () => {
    // Seed a payment + LC so finance exists in the store for this consignment.
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/public/shipment/${c.id}`);
    const flat = JSON.stringify(res.body).toLowerCase();
    expect(flat).not.toContain('payment');
    expect(flat).not.toContain('letterofcredit');
    expect(flat).not.toContain('paidamount');
    expect(flat).not.toContain('lcnumber');
    // No unit-level pricing key.
    expect(flat).not.toContain('unitprice');
  });

  it('cross-consignment isolation: a shipment id only ever returns that shipment', async () => {
    const a = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const b = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00102');
    const resA = await request(app).get(`/api/public/shipment/${a.id}`);
    expect(resA.body.shipment.ucr).toBe('VN-2026-EXP-00101');
    const flatA = JSON.stringify(resA.body);
    expect(flatA).not.toContain('VN-2026-EXP-00102');
    expect(flatA).not.toContain(b.id);
  });

  it('unknown id returns the typed not-found state', async () => {
    const res = await request(app).get('/api/public/shipment/forged-shipment-id');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('unknown');
  });
});

describe('GET /api/public/shipment/:id/pass', () => {
  it('returns a PDF transport pass carrying the QR and human-readable facts', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/public/shipment/${c.id}/pass`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const body = res.body.toString('latin1');
    expect(body.startsWith('%PDF')).toBe(true);
    expect(body).toContain('TRANSPORT PASS');
    expect(body).toContain(' re f');        // vector QR present
    expect(body).toContain('VN-2026-EXP-00101');
  });

  it('404 on unknown id', async () => {
    const res = await request(app).get('/api/public/shipment/nope/pass');
    expect(res.status).toBe(404);
  });
});

describe('WP1b — customs block round-trips through the AIG vertex', () => {
  it('consignmentToUnece → flatFromAigVertex preserves the customs block', () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    expect(c.customs?.declarationNo).toBeTruthy(); // precondition: seed carries it

    const annotation = consignmentToUnece(c);
    // Simulate the node's AIG vertex envelope (annotationObject + aliases).
    const vertex = { id: 'aig:test', annotationObject: annotation, aliases: [{ id: c.ucr, aliasFormat: 'urn:moit:ucr' }] };
    const back = flatFromAigVertex(vertex);

    expect(back.ucr).toBe(c.ucr);
    expect(back.customs).toBeTruthy();
    expect(back.customs.declarationNo).toBe(c.customs.declarationNo);
    expect(back.customs.channel).toBe(c.customs.channel);
    expect(back.customs.eCo?.ref).toBe(c.customs.eCo?.ref);
    expect(back.customs.logistics?.containerNo).toBe(c.customs.logistics?.containerNo);
    // Origin composition survives too (the border view needs it).
    expect(back.originComposition?.localContentPercent).toBe(c.originComposition?.localContentPercent);
  });
});

describe('GET /api/public/shipment/:id/document/:docId — per-type content access policy', () => {
  it('serves CONTENT for a content-policy doc that belongs to the shipment', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const co = store.documents.find(d => d.consignmentId === c.id && d.docType === 'Export Certificate of Origin');
    const res = await request(app).get(`/api/public/shipment/${c.id}/document/${co.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf|xml/);
  });

  it('REFUSES content for the Commercial Invoice (verify-only by default)', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const inv = store.documents.find(d => d.consignmentId === c.id && d.docType === 'Commercial Invoice');
    const res = await request(app).get(`/api/public/shipment/${c.id}/document/${inv.id}`);
    expect(res.status).toBe(403);
    expect(res.body.publicAccess).toBe('verify');
  });

  it('REFUSES content for a verify-only doc type (Bill of Material)', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    // seed a Bill of Material doc on this consignment
    store.documents.push({ id: 'bom-x', consignmentId: c.id, docType: 'Bill of Material', title: 'BoM', filename: 'bom.xml', format: 'XML', fileBase64: Buffer.from('<x/>').toString('base64') });
    const res = await request(app).get(`/api/public/shipment/${c.id}/document/bom-x`);
    expect(res.status).toBe(403);
    expect(res.body.publicAccess).toBe('verify');
  });

  it('cross-consignment isolation: a doc from another shipment is refused', async () => {
    const a = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const b = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00102');
    const bDoc = store.documents.find(d => d.consignmentId === b.id);
    const res = await request(app).get(`/api/public/shipment/${a.id}/document/${bDoc.id}`);
    expect(res.status).toBe(404);
  });

  it('the shipment view tags content docs with contentAvailable + contentUrl, verify docs without', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/public/shipment/${c.id}`);
    // A content-policy doc (Certificate of Origin) carries a content URL.
    const co = res.body.documents.find(d => d.docType === 'Export Certificate of Origin');
    expect(co.publicAccess).toBe('content');
    expect(co.contentAvailable).toBe(true);
    expect(co.contentUrl).toContain(`/api/public/shipment/${c.id}/document/`);
    // A verify-only doc (Commercial Invoice) is listed but exposes no content.
    const inv = res.body.documents.find(d => d.docType === 'Commercial Invoice');
    expect(inv.publicAccess).toBe('verify');
    expect(inv.contentAvailable).toBe(false);
    expect(inv.contentUrl).toBeNull();
  });
});
