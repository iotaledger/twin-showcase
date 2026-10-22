/**
 * T-316 — Per-org attestation smoke test.
 *
 * Proves the whole T-316 premise end-to-end against a live TWIN node: an org
 * provisioned by `wallets.mjs provision-orgs` (its own tenant + funded wallet +
 * seed-bound DID + `<orgDID>/mnemonic` in the vault) can mint the standard
 * attestation NFT, signed by and owned by its OWN DID — not the node admin's.
 *
 * Auto-skips unless BOTH hold, so `npm test` works whether or not the docker
 * stack is up and whether or not orgs have been provisioned:
 *   1. The TWIN node at http://localhost:3000 is reachable.
 *   2. data/tenant-state.json has at least one provisioned org under
 *      orgs.alpha (i.e. `npm run twin:provision-orgs` has run).
 *
 * To force-run:
 *   npm run twin:up
 *   npm run twin:provision-orgs        # provisions per-org tenants/wallets/DIDs
 *   npm test -- org-attestation
 *
 * Acceptance criteria (T-316):
 *   - POST /attestation as a seeded org succeeds (standard NFT minted) — no
 *     mintingFailed / secretNotFound.
 *   - The attestation is owned by the org's OWN DID (per-org attribution).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll } from 'vitest';
import { DockerAdapter } from '../../server/adapter/docker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALPHA_URL = process.env.TWIN_ALPHA_URL || 'http://localhost:3000';
const ALPHA_EMAIL = process.env.TWIN_ALPHA_EMAIL || 'admin@alpha';
const ALPHA_PASSWORD = process.env.TWIN_ALPHA_PASSWORD || 'TwinAlpha#2026!Demo';

let AVAILABLE = false;
let SKIP_REASON = '';
let NODE_API_KEY;        // alpha node tenant key (for adapter.init)
let PROVISIONED_ORG;     // { orgId, orgDid, tenantApiKey, email, password }

function readTenantState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tenant-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

beforeAll(async () => {
  const ts = readTenantState();
  if (!ts) { SKIP_REASON = 'no data/tenant-state.json'; return; }
  NODE_API_KEY = ts?.nodes?.alpha?.tenantApiKey;

  const alphaOrgs = ts?.orgs?.alpha ?? {};
  const candidates = Object.entries(alphaOrgs)
    .filter(([, o]) => o?.orgDid && o?.email && o?.password && o?.tenantApiKey)
    .map(([orgId, o]) => ({ orgId, ...o }));
  if (candidates.length === 0) { SKIP_REASON = 'no provisioned org under orgs.alpha (run twin:provision-orgs)'; return; }

  // Pick the first org that actually logs in. tenant-state.json can carry
  // STALE entries — e.g. an org left behind after a twin:reset (its tenant no
  // longer exists on the freshly-anchored node) — so don't trust the first
  // entry blindly; probe until one authenticates with its own tenant key.
  let lastErr = 'none reachable';
  for (const c of candidates) {
    try {
      const r = await fetch(`${ALPHA_URL}/authentication/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': c.tenantApiKey },
        body: JSON.stringify({ email: c.email, password: c.password }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) { PROVISIONED_ORG = c; AVAILABLE = true; return; }
      lastErr = `org ${c.orgId} login ${r.status}`;
    } catch (e) {
      lastErr = `TWIN unreachable (${e.message})`;
      break; // a network error won't get better on the next candidate
    }
  }
  SKIP_REASON = `no provisioned org could log in (${lastErr})`;
});

describe('T-316 — per-org attestation mints under the org tenant', () => {
  it('mints the standard NFT, owned by the org DID, via the org tenant key', async (ctx) => {
    if (!AVAILABLE) {
      console.log(`[T-316] suite skipped: ${SKIP_REASON}`);
      ctx.skip();
      return;
    }

    const adapter = new DockerAdapter();
    // Init with node admin creds + node tenant key (the self-heal path may use
    // the admin client); the attestation itself goes through the org client.
    await adapter.init({ nodeUrl: ALPHA_URL, email: ALPHA_EMAIL, password: ALPHA_PASSWORD, apiKey: NODE_API_KEY });

    const envelope = {
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      identifier: `t316-smoke-${PROVISIONED_ORG.orgId}`,
      name: 'T-316 smoke attestation',
      sha256: '0x' + 'a'.repeat(64),
    };

    const { attestationId } = await adapter.createAttestationAs(
      {
        orgId: PROVISIONED_ORG.orgId,
        email: PROVISIONED_ORG.email,
        password: PROVISIONED_ORG.password,
        did: PROVISIONED_ORG.orgDid,
        tenantApiKey: PROVISIONED_ORG.tenantApiKey,
      },
      envelope,
    );

    // The standard attestation-service is NFT-backed in this node image.
    expect(attestationId).toMatch(/^attestation:nft:/);

    // Confirm on-chain attribution: the attestation is owned by the org DID.
    const enc = encodeURIComponent(attestationId);
    const res = await fetch(`${ALPHA_URL}/attestation/${enc}`, {
      headers: {
        'x-api-key': PROVISIONED_ORG.tenantApiKey,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ownerIdentity).toBe(PROVISIONED_ORG.orgDid);
    expect(body.verified).toBe(true);
  }, 60_000);

  it('reports skipped suite when prerequisites are absent', (ctx) => {
    if (!AVAILABLE) { console.log(`[T-316] ${SKIP_REASON}`); ctx.skip(); return; }
    expect(PROVISIONED_ORG.orgDid).toMatch(/^did:iota:/);
  });
});
