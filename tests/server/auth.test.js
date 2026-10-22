import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../helpers/setup.js';

const app = createApp();

describe('POST /api/login', () => {
  it('returns org and node info on valid credentials', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'lotusbay', password: 'demo' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('org');
    expect(res.body.org).toHaveProperty('id');
    expect(res.body.org).toHaveProperty('name');
    expect(res.body.org).not.toHaveProperty('password');
    expect(res.body).toHaveProperty('nodeId');
    expect(res.body).toHaveProperty('nodeName');
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'lotusbay', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 on unknown username', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'nonexistent', password: 'demo' });
    expect(res.status).toBe(401);
  });
});
