/**
 * T-222 — End-to-end smoke against running TWIN nodes (docker mode).
 *
 * Drives the same HTTP code path the demo UI hits to:
 *   1. Resolve an existing DID via /api/orgs/:id (T-212 enrichment)
 *   2. Anchor a brand-new document via the adapter (T-215/T-216 notarization)
 *   3. Verify the on-chain proof carries the SAME sha256 we submitted
 *      and that verify() eventually returns verified=true
 *
 * Performance gates (relaxed from the original spec per the 2026-05-22
 * Impact Analysis to account for REST round-trip):
 *   - Notarization round-trip target: < 10 s (soft; warn but don't fail)
 *   - Total flow target:              < 30 s (hard)
 *
 * Notes on scope vs the original T-222 spec:
 *   - "Org registration creates real did:iota" — covered by
 *     did-resolvability.test.js and exercised here by reading a seeded org's
 *     DID through /api/orgs/:id. The register-from-scratch path burns a
 *     fresh IOTA identity per test run, so it's not appropriate for a
 *     suite that runs on every npm test.
 *   - "Cross-node share Alpha → Beta via WebSocket" — out of scope here;
 *     the WS sync is a frontend-driven flow tested manually. T-2V06 in the
 *     backlog covers a dedicated cross-border test.
 *   - "IOTA Explorer verification" — sanity-checked via the explorerUrl
 *     present on the org payload (built deterministically from the DID hex);
 *     hitting the explorer.iota.org page from a test would make this suite
 *     depend on a third-party UI.
 *
 * Auto-skips when the TWIN Node at http://localhost:3000 is unreachable, so
 * `npm test` works whether or not the docker stack is up. To force-run:
 *
 *   npm run twin:up
 *   npm test -- docker-e2e
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { store } from '../../server/store.js';
import { createAndInitAdapter } from '../../server/adapter/index.js';
import { DockerAdapter } from '../../server/adapter/docker.js';
import orgRoutes from '../../server/routes/orgs.js';
import documentRoutes from '../../server/routes/documents.js';
import consignmentRoutes from '../../server/routes/consignments.js';

const ALPHA_URL       = process.env.TWIN_ALPHA_URL      || 'http://localhost:3000';
const ALPHA_EMAIL     = process.env.TWIN_ALPHA_EMAIL    || 'admin@alpha';
const ALPHA_PASSWORD  = process.env.TWIN_ALPHA_PASSWORD || 'TwinAlpha#2026!Demo';

const NOTARIZATION_TARGET_MS = 10_000;
const VERIFY_TIMEOUT_MS      = 60_000;
const VERIFY_INTERVAL_MS     = 3_000;
const TOTAL_FLOW_BUDGET_MS   = 30_000;

let TWIN_AVAILABLE = false;
let SIMULATED_ADAPTER;
let app;

beforeAll(async () => {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${ALPHA_URL}/health`, { signal: ac.signal });
    clearTimeout(t);
    TWIN_AVAILABLE = r.ok;
  } catch { TWIN_AVAILABLE = false; }
  SIMULATED_ADAPTER = store.adapter;

  if (TWIN_AVAILABLE) {
    try {
      store.adapter = await createAndInitAdapter('docker', 'alpha');
      await store.adapter.warmUp();
    } catch (e) {
      console.warn('[T-222] docker adapter init failed; skipping E2E:', e.message);
      TWIN_AVAILABLE = false;
    }
  }
  app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(orgRoutes);
  app.use(consignmentRoutes);
  app.use(documentRoutes);
});

describe('T-222 docker mode end-to-end', () => {
  // skipIf evaluates at test registration (module load), before beforeAll
  // runs the probe, so TWIN_AVAILABLE would always be false there. Skip
  // inside the test body instead.
  it(
    'flow: org resolved via HTTP → doc anchored on-chain → proof verified',
    async (ctx) => {
      if (!TWIN_AVAILABLE) return ctx.skip();
      const totalStart = Date.now();

      // ── Step 1: resolve a seeded org through the HTTP layer (T-212) ─────
      const list = (await request(app).get('/api/orgs')).body;
      const org = list.find(o => o.did);
      if (!org) {
        // No org has a DID — seed-state.json is missing or for a different
        // corridor than CONFIG_FILE. Skip rather than fail (the alternative
        // is calling adapter.createDid() here, which burns faucet tokens on
        // every test run). Document the gap clearly.
        console.warn(
          '[T-222] no seeded org with a DID found. To run this test:\n' +
          '  CONFIG_FILE=configs/<corridor>.json npm run twin:seed -- --reset-state\n' +
          '  CONFIG_FILE=configs/<corridor>.json npm test -- docker-e2e',
        );
        return ctx.skip();
      }

      const enrichRes = await request(app).get(`/api/orgs/${org.id}`);
      expect(enrichRes.status).toBe(200);
      expect(enrichRes.body.did).toBe(org.did);
      expect(enrichRes.body.didResolution).toBeDefined();
      expect(enrichRes.body.didResolution.resolvable).toBe(true);
      expect(enrichRes.body.didResolution.assertionMethodCount).toBeGreaterThan(0);
      expect(org.explorerUrl, 'org carries the IOTA Explorer link').toMatch(
        // T-247: switched from /object/<hex> to /identity/<did-with-hyphens>
        // (human-readable DID document view).
        /explorer\.iota\.org\/identity\/did-iota-(testnet|mainnet|devnet)-0x[0-9a-f]+\?network=(testnet|mainnet|devnet)/,
      );

      // ── Step 2: anchor a fresh document via the docker adapter ──────────
      const payload = Buffer.from(`T-222 e2e payload ${Date.now()}\n${crypto.randomUUID()}\n`);
      const sha256 = '0x' + crypto.createHash('sha256').update(payload).digest('hex');
      const docId = `e2e-${Date.now()}`;

      const t0 = Date.now();
      const storeResult = await store.adapter.storeDocument(payload, {
        documentId: docId,
        documentCode: 'unece:DocumentCodeList#380', // commercial invoice
        filename: `${docId}.txt`,
        contentType: 'text/plain',
        sha256,
        title: `T-222 e2e ${docId}`,
        creator: { name: 'T-222 suite' },
        createAttestation: false, // attestation requires per-org credentials; not in scope here
      });
      const storeMs = Date.now() - t0;
      expect(storeResult.documentManagementId).toMatch(/^aig:[0-9a-f]+$/);
      expect(storeResult.hash).toBe(sha256);
      if (storeMs > NOTARIZATION_TARGET_MS) {
        console.warn(`[T-222] storeDocument took ${storeMs}ms (target ${NOTARIZATION_TARGET_MS}ms)`);
      }

      // ── Step 3: anchor an immutable proof and poll until verified ───────
      const envelope = {
        '@type': 'DigitalDocument',
        identifier: docId,
        contentSize: payload.length,
        sha256,
      };
      const proof = await store.adapter.createImmutableProof(envelope);
      expect(proof.proofId).toMatch(/^immutable-proof:[0-9a-f]+$/);

      const verifyStart = Date.now();
      let verified = false;
      while (Date.now() - verifyStart < VERIFY_TIMEOUT_MS) {
        try {
          verified = await store.adapter.verifyImmutableProof(proof.proofId);
          if (verified) break;
        } catch (e) {
          // Transient — keep polling until budget expires.
        }
        await new Promise(r => setTimeout(r, VERIFY_INTERVAL_MS));
      }
      expect(verified, `proof ${proof.proofId} verified within ${VERIFY_TIMEOUT_MS}ms`).toBe(true);

      // ── Step 4: total-flow budget ───────────────────────────────────────
      const totalMs = Date.now() - totalStart;
      expect(totalMs).toBeLessThan(TOTAL_FLOW_BUDGET_MS);

      console.log(`[T-222] flow ok: storeDocument=${storeMs}ms verify=${Date.now() - verifyStart}ms total=${totalMs}ms`);
    },
    TOTAL_FLOW_BUDGET_MS + 30_000, // vitest timeout
  );

  it('adapter.authStatus exposes the admin DID after warmUp', (ctx) => {
    if (!TWIN_AVAILABLE) return ctx.skip();
    const status = store.adapter.authStatus();
    expect(status.authenticated).toBe(true);
    expect(status.subjectDid).toMatch(/^did:iota:testnet:0x[0-9a-f]+$/);
    expect(status.expiresInSeconds).toBeGreaterThan(0);
  });
});

// Restore the simulated adapter so any test file loaded after this one
// (helpers/setup.js et al.) sees the adapter it expects.
import { afterAll } from 'vitest';
afterAll(() => { if (SIMULATED_ADAPTER) store.adapter = SIMULATED_ADAPTER; });
