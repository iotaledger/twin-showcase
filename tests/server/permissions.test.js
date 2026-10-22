import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/permissions/:consignmentId', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('returns permissions for a consignment', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app).get(`/api/permissions/${cId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('org1', 'owner');
  });

  it('returns empty object for unknown consignment', async () => {
    const res = await request(app).get('/api/permissions/nonexistent');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

describe('POST /api/permissions/share', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('shares a consignment with another org', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/permissions/share')
      .send({
        consignmentId: cId,
        recipientOrgId: 'org2',
        recipientOrgName: 'Test Org',
        sharerOrgName: 'Owner Org',
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(store.permissions[cId]).toHaveProperty('org2', 'viewer');
  });
});

describe('POST /api/permissions/revoke', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
    // Pre-share
    const cId = store.consignments[0].id;
    store.permissions[cId]['org2'] = 'viewer';
  });

  it('revokes access from an org', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/permissions/revoke')
      .send({
        consignmentId: cId,
        recipientOrgId: 'org2',
        recipientOrgName: 'Test Org',
        revokerOrgName: 'Owner Org',
      });
    expect(res.status).toBe(200);
    expect(store.permissions[cId]).not.toHaveProperty('org2');
  });
});
