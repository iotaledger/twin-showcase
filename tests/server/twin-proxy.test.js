// T-315 (redesigned) — transparent proxy to the TWIN node verification API.
// In the test env the adapter is simulated (no node), so the proxy reports
// 503 for in-scope calls and 404 for out-of-scope ones. The real pass-through
// (forwarding auth headers to the node, serving the node's filtered spec) is
// exercised in docker mode and was validated manually at implementation time.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../helpers/setup.js';

const app = createApp();

describe('TWIN verification proxy (/twin)', () => {
  it('openapi.json is 503 in simulated mode (no node to fetch the spec from)', async () => {
    const res = await request(app).get('/twin/openapi.json');
    expect(res.status).toBe(503);
  });

  it('serves the Swagger UI shell', async () => {
    const res = await request(app).get('/twin/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('in-scope path (immutable-proof) is 503 in simulated mode (no node)', async () => {
    const res = await request(app).get('/twin/immutable-proof/immutable-proof:abc/verify');
    expect(res.status).toBe(503);
  });

  it('demo-session is 503 in simulated mode (no node to mint a token)', async () => {
    const res = await request(app).get('/twin/demo-session');
    expect(res.status).toBe(503);
  });

  it('out-of-scope path is rejected with 404 + the allowed list', async () => {
    const res = await request(app).get('/twin/identity/did:iota:testnet:0xabc');
    expect(res.status).toBe(404);
    expect(res.body.allowed).toEqual(
      expect.arrayContaining(['/authentication/*', '/immutable-proof/*', '/verifiable/*']),
    );
  });
});
