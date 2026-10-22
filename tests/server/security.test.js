import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeaders, corsPolicy, rateLimitEnabled } from '../../server/middleware/security.js';

// T-407 — the hardening middleware. Asserts it adds safe headers + credentialed
// CORS WITHOUT the traffic-affecting features that would break the infra/UI.

function app() {
  const a = express();
  a.use(securityHeaders());
  a.use(corsPolicy());
  a.get('/x', (_req, res) => res.json({ ok: true }));
  return a;
}

describe('securityHeaders (helmet)', () => {
  it('adds safe headers but NO CSP (the inline-style UI must keep working)', async () => {
    const res = await request(app()).get('/x');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
    // CSP / COEP / CORP are intentionally OFF for infra + UI compatibility.
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
  });
});

describe('corsPolicy', () => {
  it('reflects the request origin and allows credentials (never a wildcard)', async () => {
    const res = await request(app()).get('/x').set('Origin', 'https://demo.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://demo.example');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('rate limiting', () => {
  it('is OFF by default (no RATE_LIMIT_ENABLED) so Traefik traffic is never throttled', () => {
    expect(rateLimitEnabled()).toBe(false);
  });
});
