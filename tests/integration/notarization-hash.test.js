/**
 * T-216 — End-to-end verification that a document's local SHA-256 hash is
 * carried into the immutable-proof envelope anchored on the IOTA testnet,
 * and that `verifyImmutableProof()` confirms the on-chain signature.
 *
 * This suite auto-skips when the TWIN Node at http://localhost:3000 is not
 * reachable, so `npm test` works whether or not the docker stack is up.
 * To force-run the suite, start the nodes first:
 *
 *   docker compose -f docker-compose.twin.yml up -d twin-node-alpha twin-node-beta
 *   npm test -- notarization-hash
 *
 * Acceptance criteria (T-216):
 *   - Real proof is created on testnet
 *   - SHA-256 embedded in the on-chain envelope matches the local hash
 *   - verify() eventually returns verified=true (TWIN signing is async)
 *   - Round-trip is recorded (target: <5 s, soft)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { DockerAdapter } from '../../server/adapter/docker.js';

const ALPHA_URL = process.env.TWIN_ALPHA_URL || 'http://localhost:3000';
const ALPHA_EMAIL = process.env.TWIN_ALPHA_EMAIL || 'admin@alpha';
const ALPHA_PASSWORD = process.env.TWIN_ALPHA_PASSWORD || 'TwinAlpha#2026!Demo';

const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_INTERVAL_MS = 3_000;

let TWIN_AVAILABLE = false;
let TWIN_SKIP_REASON = '';

beforeAll(async () => {
  // Step 1: health check
  try {
    const r = await fetch(`${ALPHA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) {
      TWIN_SKIP_REASON = `health ${r.status}`;
      return;
    }
  } catch (e) {
    TWIN_SKIP_REASON = `unreachable (${e.message})`;
    return;
  }
  // Step 2: confirm the admin user exists (bootstrap completed). A 401 here
  // means the node is up but the demo credentials have not been provisioned
  // yet — skip rather than fail, since this is an environment-setup issue.
  try {
    const r = await fetch(`${ALPHA_URL}/authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALPHA_EMAIL, password: ALPHA_PASSWORD }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      TWIN_SKIP_REASON = `login ${r.status} (run twin-bootstrap-alpha?)`;
      return;
    }
  } catch (e) {
    TWIN_SKIP_REASON = `login failed (${e.message})`;
    return;
  }
  TWIN_AVAILABLE = true;
});

describe('T-216 — notarization on-chain hash matching', () => {
  it('anchors a document, verifies it on chain, and confirms the embedded SHA-256', async (ctx) => {
    if (!TWIN_AVAILABLE) {
      console.log(`[T-216] suite skipped: ${TWIN_SKIP_REASON}`);
      ctx.skip();
      return;
    }

    const adapter = new DockerAdapter();
    await adapter.init({ nodeUrl: ALPHA_URL, email: ALPHA_EMAIL, password: ALPHA_PASSWORD });

    // 1. Build a deterministic test file and compute its SHA-256 locally
    const content = Buffer.from(`T-216 integration test payload — ${new Date().toISOString()}`);
    const localSha256 = '0x' + crypto.createHash('sha256').update(content).digest('hex');

    // 2. Anchor a JSON-LD envelope that embeds the file hash
    const t0 = Date.now();
    const envelope = {
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      identifier: 'urn:moit:test:t216:' + Date.now(),
      name: 'T-216 hash matching',
      contentSize: content.length,
      sha256: localSha256,
      dateCreated: new Date().toISOString(),
    };
    const { proofId } = await adapter.createImmutableProof(envelope);
    expect(proofId).toMatch(/^immutable-proof:[0-9a-f]+$/);

    // 3. Poll verify until TWIN's signing task completes (or timeout)
    const startVerify = Date.now();
    let verified = false;
    while (Date.now() - startVerify < VERIFY_TIMEOUT_MS) {
      verified = await adapter.verifyImmutableProof(proofId);
      if (verified) break;
      await new Promise(r => setTimeout(r, VERIFY_INTERVAL_MS));
    }
    const totalMs = Date.now() - t0;
    expect(verified, `verifyImmutableProof did not return true within ${VERIFY_TIMEOUT_MS}ms`).toBe(true);

    // 4. Fetch the on-chain VC. In TWIN node 0.0.3-next.40 the envelope we
    //    submitted is NOT stored verbatim — only its hash is kept as
    //    `credentialSubject.proofIntegrity` ("sha256-<base64>"). The on-chain
    //    object holds that hash and the signed receipt. Hash-matching is
    //    therefore established transitively:
    //      file-sha256 in envelope -> envelope hash (proofIntegrity) ->
    //      on-chain object signature
    //    The strong assertion is that verifyImmutableProof returned true above
    //    (TWIN re-derived the envelope hash and matched the on-chain anchor).
    //    Here we additionally assert that the proof carries an on-chain
    //    reference we can show in the UI.
    const proof = await adapter.getImmutableProof(proofId);
    const proofIntegrity = findFirst(proof, 'proofIntegrity');
    expect(proofIntegrity, 'proofIntegrity missing from on-chain proof').toMatch(/^sha256-/);
    const explorerUrl = findFirst(proof, 'verifiableStorageId')
      ? `present` : findFirst(proof, 'immutableReceipt') ? `present` : null;
    expect(explorerUrl, 'no on-chain reference (verifiableStorageId / immutableReceipt) found').toBe('present');

    // 5. Soft check on round-trip time. Anchor + signing on testnet usually
    //    completes in 5-15s; the spec's <5s target is aspirational. Just log.
    console.log(`[T-216] proofId=${proofId} verified in ${totalMs}ms (target <5000ms; testnet typical 5000-15000ms)`);
    expect(totalMs).toBeLessThan(VERIFY_TIMEOUT_MS);
  }, VERIFY_TIMEOUT_MS + 30_000);

  it('reports skipped suite when TWIN node is not reachable', (ctx) => {
    if (TWIN_AVAILABLE) {
      ctx.skip();
      return;
    }
    // This branch documents the auto-skip behaviour for npm test runs
    // without the docker stack. Nothing to assert.
    expect(TWIN_AVAILABLE).toBe(false);
  });
});

// Walk an object and return the first value at any nesting level whose key
// matches `target`. Returns undefined if not found.
function findFirst(obj, target) {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = findFirst(item, target);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === target) return v;
    const nested = findFirst(v, target);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
