import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

// T-4V03 (WP3) — system-to-system verification API (token auth).

const app = createApp();
const TOKEN = 'demo-customs-integration';

beforeEach(() => {
  resetStore();
  seedStore();
});

describe('auth', () => {
  it('rejects calls without the service token', async () => {
    const res = await request(app).get('/api/verify/consignment/VN-2026-EXP-00101');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await request(app)
      .get('/api/verify/consignment/VN-2026-EXP-00101')
      .set('x-service-token', 'nope');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/verify/consignment/:ref', () => {
  it('resolves by UCR with per-document verification + recommendation', async () => {
    const res = await request(app)
      .get('/api/verify/consignment/VN-2026-EXP-00101')
      .set('x-service-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.declarationNo).toMatch(/^\d{12}$/);
    expect(res.body.documents.length).toBeGreaterThan(3);
    for (const d of res.body.documents) {
      expect(d).toHaveProperty('sha256');
      expect(d).toHaveProperty('anchored');
      expect(d).toHaveProperty('issuerName');
    }
    expect(res.body.channelRecommendation.recommended).toBe('green');
    expect(res.body.channelRecommendation.decisionOwner).toContain('customs authority');
  });

  it('resolves by customs declaration number too', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00104');
    const res = await request(app)
      .get(`/api/verify/consignment/${c.customs.declarationNo}`)
      .set('x-service-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ucr).toBe('VN-2026-EXP-00104');
    expect(res.body.dossier.dossierVerified).toBe(false);
    expect(res.body.channelRecommendation.recommended).toBe('yellow');
  });

  it('404s an unknown ref', async () => {
    const res = await request(app)
      .get('/api/verify/consignment/NOPE-123')
      .set('x-service-token', TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/verify/document', () => {
  it('finds a registered document by sha256', async () => {
    const doc = store.documents.find(d => d.hash);
    const res = await request(app)
      .post('/api/verify/document')
      .set('x-service-token', TOKEN)
      .send({ sha256: doc.hash });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.docId).toBe(doc.id);
  });

  it('verifies an uploaded file by hashing it server-side; tampered bytes come back unknown', async () => {
    const doc = store.documents.find(d => d.fileBase64 && d.filename?.endsWith('.pdf'));
    const original = Buffer.from(doc.fileBase64, 'base64');

    const ok = await request(app)
      .post('/api/verify/document')
      .set('x-service-token', TOKEN)
      .attach('file', original, doc.filename);
    expect(ok.body.found).toBe(true);
    expect(ok.body.docId).toBe(doc.id);

    const tampered = Buffer.concat([original, Buffer.from(' ')]);
    const bad = await request(app)
      .post('/api/verify/document')
      .set('x-service-token', TOKEN)
      .attach('file', tampered, doc.filename);
    expect(bad.body.found).toBe(false);
    expect(bad.body.verdict).toBe('unknown');
  });

  it('400s when no identifier is provided', async () => {
    const res = await request(app)
      .post('/api/verify/document')
      .set('x-service-token', TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('OpenAPI', () => {
  it('serves the spec without auth (docs are public)', async () => {
    const res = await request(app).get('/api/verify/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/verify/consignment/{ref}']).toBeTruthy();
  });
});
