import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/node', () => {
  it('returns node info', async () => {
    const res = await request(app).get('/api/node');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodeId');
    expect(res.body).toHaveProperty('nodeName');
    expect(res.body).toHaveProperty('nodeIp');
    expect(res.body).toHaveProperty('peerConnected');
    expect(res.body).toHaveProperty('orgCount');
  });

  it('exposes adapter status (T-210)', async () => {
    const res = await request(app).get('/api/node');
    expect(res.body).toHaveProperty('adapter');
    expect(res.body.adapter).toMatchObject({
      mode: 'simulated',
      ready: true,
      authenticated: true,
      expiresInSeconds: null,
      subjectDid: null,
    });
  });
});

describe('GET /api/node/discover', () => {
  it('returns discoverable peers', async () => {
    const res = await request(app).get('/api/node/discover');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/node/disconnect', () => {
  it('disconnects and resets peer state', async () => {
    store.peerConnected = true;
    store.peerOrgs = [{ id: 'test' }];
    const res = await request(app).post('/api/node/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(store.peerConnected).toBe(false);
    expect(store.peerOrgs).toEqual([]);
  });
});
