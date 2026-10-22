import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/documents', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('returns documents for a consignment', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app).get(`/api/documents?orgId=org1&consignmentId=${cId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // fileBase64 should be stripped from response
    for (const doc of res.body) {
      expect(doc.fileBase64).toBeUndefined();
    }
  });
});

describe('POST /api/documents', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('creates a document for a consignment', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Test Document')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.title).toBe('Test Document');
  });

  it('attaches an adapter-issued proofId and notarization metadata (T-214)', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Notarized')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('hello notarization'), 'note.txt');
    expect(res.status).toBe(200);
    // Real SHA-256 of the uploaded content (64 hex chars), not a random 16-byte hash
    expect(res.body.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.body.fileSize).toBe(Buffer.from('hello notarization').length);
    // Simulated adapter returns a sim proof id; field is populated, not null
    expect(res.body.proofId).toMatch(/^immutable-proof:sim-/);
    expect(res.body.notarizationMode).toBe('simulated');
    expect(res.body.notarizationError).toBeNull();
    expect(res.body.proofVerified).toBe(false);
    // Simulated proof has no on-chain verifiableStorageId -> no Explorer URL
    expect(res.body.proofExplorerUrl).toBeNull();
  });

  it('also stores the blob via the document-management composite (T-215)', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Composite stored')
      .field('docType', 'Commercial Invoice')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('binary blob'), 'inv.pdf');
    expect(res.status).toBe(200);
    expect(res.body.documentManagementId).toMatch(/^aig:sim-/);
    expect(res.body.documentStorageError).toBeNull();
  });

  it('skips storeDocument when no file is attached (metadata-only doc)', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Metadata only')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1');
    expect(res.status).toBe(200);
    expect(res.body.documentManagementId).toBeNull();
    expect(res.body.documentStorageError).toBeNull();
  });
});

describe('POST /api/documents/:id/verify', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('verifies a notarized document via the adapter', async () => {
    const cId = store.consignments[0].id;
    const created = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Verify me')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('verifiable bytes'), 'v.txt');
    const res = await request(app).post(`/api/documents/${created.body.id}/verify`);
    expect(res.status).toBe(200);
    // Simulated adapter always confirms verified=true
    expect(res.body).toMatchObject({ verified: true, proofId: created.body.proofId });
    expect(res.body.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // proofExplorerUrl is null for simulated (no on-chain anchor to link to)
    expect(res.body.proofExplorerUrl).toBeNull();
  });

  it('returns 400 when the document has no proof', async () => {
    const cId = store.consignments[0].id;
    const created = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'No proof')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('x'), 'x.txt');
    // Hard-clear the proofId to simulate a notarization failure on create
    const doc = store.documents.find(d => d.id === created.body.id);
    doc.proofId = null;
    const res = await request(app).post(`/api/documents/${created.body.id}/verify`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no proof/i);
  });

  it('returns 404 for an unknown document', async () => {
    const res = await request(app).post('/api/documents/nope/verify');
    expect(res.status).toBe(404);
  });

  it('T-311+T-312: returns 409 with verificationSource=unavailable on peer-anchored docs in simulated mode', async () => {
    const cId = store.consignments[0].id;
    const created = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Peer-anchored')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('peer bytes'), 'p.txt');
    // Simulate a doc whose proof lives on the peer's chain (as if propagated
    // via UPLOAD_DOCUMENT from beta). In simulated mode T-312's
    // verifyCrossNodeProof returns source='unavailable' since neither DSP
    // nor the on-chain receipt is reachable, so the route still 409s — just
    // with the new structured body.
    const doc = store.documents.find(d => d.id === created.body.id);
    doc.notarizationNode = 'beta';
    const res = await request(app).post(`/api/documents/${created.body.id}/verify`);
    expect(res.status).toBe(409);
    expect(res.body.notarizationNode).toBe('beta');
    expect(res.body.verificationSource).toBe('unavailable');
    expect(res.body.error).toMatch(/cross-node/i);
  });
});

describe('GET /api/documents/:id/proof', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('T-311: returns 409 when proof was anchored on a peer node', async () => {
    const cId = store.consignments[0].id;
    const created = await request(app)
      .post('/api/documents')
      .field('consignmentId', cId)
      .field('title', 'Peer-anchored')
      .field('docType', 'General')
      .field('creatorOrgId', 'org1')
      .attach('file', Buffer.from('peer bytes'), 'p.txt');
    const doc = store.documents.find(d => d.id === created.body.id);
    doc.notarizationNode = 'beta';
    const res = await request(app).get(`/api/documents/${created.body.id}/proof`);
    expect(res.status).toBe(409);
    expect(res.body.notarizationNode).toBe('beta');
  });
});

describe('GET /api/documents/:id/download', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('downloads an existing document', async () => {
    const doc = store.documents[0];
    const res = await request(app).get(`/api/documents/${doc.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('returns 404 for nonexistent document', async () => {
    const res = await request(app).get('/api/documents/nonexistent/download');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/documents/:id/xml', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('returns XML content for XML documents', async () => {
    const xmlDoc = store.documents.find(d => d.filename?.endsWith('.xml'));
    if (!xmlDoc) return; // skip if no XML docs
    const res = await request(app).get(`/api/documents/${xmlDoc.id}/xml`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(res.body.content).toContain('<?xml');
  });
});
