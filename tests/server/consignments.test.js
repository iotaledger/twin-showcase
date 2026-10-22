import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/consignments', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('returns consignments for authorized org', async () => {
    const res = await request(app).get('/api/consignments?orgId=org1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('ucr');
    expect(res.body[0]).toHaveProperty('product');
  });

  it('returns empty for unauthorized org', async () => {
    const res = await request(app).get('/api/consignments?orgId=unknown-org');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/consignments', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('creates a new consignment', async () => {
    const res = await request(app)
      .post('/api/consignments')
      .send({ ucr: 'TEST-UCR-001', creatorOrgId: 'org1', description: 'Test goods' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.ucr).toBe('TEST-UCR-001');
    expect(res.body.status).toBe('Draft');
  });

  it('returns 400 for unknown org', async () => {
    const res = await request(app)
      .post('/api/consignments')
      .send({ ucr: 'TEST-UCR-002', creatorOrgId: 'nonexistent' });
    expect(res.status).toBe(400);
  });
});
