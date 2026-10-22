import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/config', () => {
  it('returns corridor configuration', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('corridor');
    expect(res.body.corridor).toHaveProperty('id');
    expect(res.body.corridor).toHaveProperty('name');
  });

  it('excludes passwords and sensitive data', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body).not.toHaveProperty('nodes');
    expect(res.body).not.toHaveProperty('consignments');
    expect(res.body.credentials).not.toHaveProperty('blacklisted');
  });
});
