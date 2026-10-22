import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/orgs', () => {
  it('returns list of orgs without passwords', async () => {
    const res = await request(app).get('/api/orgs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const org of res.body) {
      expect(org).not.toHaveProperty('password');
      expect(org).toHaveProperty('id');
      expect(org).toHaveProperty('name');
    }
  });
});

describe('GET /api/orgs/all', () => {
  it('returns local orgs with nodeId', async () => {
    const res = await request(app).get('/api/orgs/all');
    expect(res.status).toBe(200);
    expect(res.body[0]).toHaveProperty('local', true);
    expect(res.body[0]).toHaveProperty('nodeId');
  });
});

describe('PUT /api/orgs/:id', () => {
  it('updates org name', async () => {
    const orgId = store.orgs[0].id;
    const originalName = store.orgs[0].name;
    const res = await request(app)
      .put(`/api/orgs/${orgId}`)
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    // Restore
    store.orgs = store.orgs.map(o => o.id === orgId ? { ...o, name: originalName } : o);
  });
});

describe('POST /api/orgs/:id/register', () => {
  it('registers a DID for valid credential', async () => {
    const orgId = store.orgs[0].id;
    const res = await request(app)
      .post(`/api/orgs/${orgId}/register`)
      .send({ regNumber: 'VN-DKKD-123456' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('did');
    expect(res.body.did).toMatch(/^did:iota:0x/);
    expect(res.body.verified).toBe(true);
    // Simulated adapter returns empty explorerUrl -> persisted as null (T-209)
    expect(res.body).toHaveProperty('explorerUrl', null);
    // verificationMethodId is the assertion VM provisioned alongside the DID (T-211)
    expect(res.body).toHaveProperty('verificationMethodId', 'org-assertion');
  });

  it('rejects short registration number', async () => {
    const orgId = store.orgs[0].id;
    const res = await request(app)
      .post(`/api/orgs/${orgId}/register`)
      .send({ regNumber: 'AB' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('failStep', 0);
  });
});

describe('POST /api/orgs/validate-credential', () => {
  it('validates a valid credential', async () => {
    const res = await request(app)
      .post('/api/orgs/validate-credential')
      .send({ regNumber: 'VN-DKKD-999999' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});
