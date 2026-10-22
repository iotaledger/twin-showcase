import { Router } from 'express';
import { getConfig } from '../config.js';
import { store, NODE_ID, NODE_NAME, addLog, wsRefs } from '../store.js';
import { getAttestingAuthority } from '../identity-helpers.js';

const router = Router();

// ── Credential validation ──
const cfg = getConfig();
const BLACKLISTED = cfg?.credentials?.blacklisted ?? [];
const EXPIRED = cfg?.credentials?.expired ?? [];
const SUSPENDED = cfg?.credentials?.suspended ?? [];

function validateCredential(regNumber) {
  const n = (regNumber || '').toUpperCase().trim();
  if (n.length < 6) return { valid: false, reason: 'Registration number too short (minimum 6 characters)', failStep: 0 };
  if (BLACKLISTED.includes(n)) return { valid: false, reason: 'Registration number is on the DENIED list \u2014 organisation not recognised by any registry', failStep: 1 };
  if (n.startsWith('X') || n.startsWith('0')) return { valid: false, reason: 'Invalid prefix \u2014 number not found in any recognised national or international registry', failStep: 1 };
  if (EXPIRED.includes(n)) return { valid: false, reason: 'Registration has EXPIRED \u2014 licence is no longer active. Organisation must renew before DID issuance.', failStep: 2 };
  if (SUSPENDED.includes(n)) return { valid: false, reason: 'Registration is SUSPENDED \u2014 organisation is under regulatory review. DID issuance blocked.', failStep: 2 };
  const prefix = n.split('-')[0];
  const typeMap = cfg?.credentials?.registrationTypes ?? {};
  return { valid: true, type: typeMap[prefix] || 'National Registration Number', formatted: n };
}

function syncOrgsToPeer() { wsRefs.syncOrgsToPeer(); }

// ── Routes ──
// Never expose: password (user login) or twinCredentials (server-side
// per-org TWIN service-account credentials provisioned at DID register).
const PUBLIC = (o) => ({ ...o, password: undefined, twinCredentials: undefined });

// T-212: in-memory cache of TWIN /identity/{did} resolutions. The DID document
// rarely changes, so a 5-minute TTL avoids hitting the TWIN node on every
// /api/orgs request (the demo UI polls regularly). Cache miss or expiry
// triggers a fresh resolveDid(); a failure leaves the cache empty so the next
// request retries instead of serving stale "unresolvable" forever.
const DID_RESOLVE_TTL_MS = 5 * 60 * 1000;
const didResolveCache = new Map(); // did -> { resolvable, assertionMethodCount, fetchedAt }

async function getDidResolutionMetadata(did) {
  if (!did) return null;
  const adapter = store.adapter;
  // Simulated mode short-circuits — there is no real on-chain document to
  // resolve, so report a synthetic "resolvable" stub instead of forcing the
  // caller to special-case adapter.mode.
  if (!adapter || adapter.mode === 'simulated') {
    return { resolvable: true, assertionMethodCount: null, simulated: true, fetchedAt: Date.now() };
  }
  const cached = didResolveCache.get(did);
  if (cached && (Date.now() - cached.fetchedAt) < DID_RESOLVE_TTL_MS) {
    return cached;
  }
  try {
    const doc = await adapter.resolveDid(did);
    const am = Array.isArray(doc?.assertionMethod) ? doc.assertionMethod.length : 0;
    const vm = Array.isArray(doc?.verificationMethod) ? doc.verificationMethod.length : 0;
    const meta = { resolvable: true, assertionMethodCount: am + vm, fetchedAt: Date.now() };
    didResolveCache.set(did, meta);
    return meta;
  } catch (e) {
    // Don't cache failures: a transient TWIN outage shouldn't pin the org as
    // unresolvable for 5 minutes. The caller still gets a flag for this turn.
    return { resolvable: false, error: e.message, fetchedAt: Date.now() };
  }
}

async function enrichOrg(o) {
  const base = PUBLIC(o);
  if (!o.did) return base;
  const meta = await getDidResolutionMetadata(o.did);
  return meta ? { ...base, didResolution: meta } : base;
}

router.get('/api/orgs', (req, res) => res.json(store.orgs.map(PUBLIC)));

router.get('/api/orgs/all', (req, res) => {
  const local = store.orgs.map(o => ({ ...PUBLIC(o), nodeId: NODE_ID, nodeName: NODE_NAME, local: true }));
  const remote = store.peerConnected ? store.peerOrgs.map(o => ({ ...o, local: false })) : [];
  res.json([...local, ...remote]);
});

// T-212: single org with live DID resolution metadata. Kept as a separate
// endpoint (not enriched on /api/orgs) so the org list stays cheap; UI calls
// this only when the user opens an org's detail/identity panel.
router.get('/api/orgs/:id', async (req, res) => {
  const org = store.orgs.find(o => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  res.json(await enrichOrg(org));
});

router.put('/api/orgs/:id', (req, res) => {
  store.orgs = store.orgs.map(o => o.id === req.params.id ? { ...o, name: req.body.name ?? o.name, role: req.body.role ?? o.role } : o);
  const org = store.orgs.find(o => o.id === req.params.id);
  if (org) syncOrgsToPeer();
  res.json(PUBLIC(org));
});

router.post('/api/orgs/:id/register', async (req, res) => {
  const v = validateCredential(req.body.regNumber);
  if (!v.valid) return res.status(400).json({ error: v.reason, failStep: v.failStep });
  const org0 = store.orgs.find(o => o.id === req.params.id);
  if (!org0) return res.status(404).json({ error: 'Org not found' });

  let didResult;
  try {
    didResult = await store.adapter.createDid();
  } catch (e) {
    return res.status(502).json({ error: 'TWIN Node unavailable', mode: store.adapter?.mode, detail: e.message });
  }

  // T-1b: provision a TWIN user account bound to this DID, so subsequent
  // attestations made by this org are signed by the org's identity rather
  // than the node admin's. The credentials are kept server-side only and
  // never returned to the frontend.
  let twinCredentials = null;
  try {
    twinCredentials = await store.adapter.provisionOrgUser({ orgId: req.params.id, did: didResult.did });
  } catch (e) {
    // Non-fatal: the DID is real and usable for the immutable proof flow;
    // attestation-as-org will simply be skipped at upload time.
    console.warn(`[orgs] provisionOrgUser failed for ${req.params.id}: ${e.message}`);
  }

  const attestedBy = getAttestingAuthority(org0);
  store.orgs = store.orgs.map(o => o.id === req.params.id ? {
    ...o,
    regNumber: v.formatted,
    did: didResult.did,
    explorerUrl: didResult.explorerUrl || null,
    verificationMethodId: didResult.verificationMethodId || null,
    twinCredentials,        // SERVER-SIDE ONLY: { email, password } or null
    verified: true,
    attestedBy,
  } : o);
  const org = store.orgs.find(o => o.id === req.params.id);
  addLog('identity', 'DID Issued', org.name, `DID created for ${org.name} (${v.type}: ${v.formatted}). Attested by ${attestedBy}. Anchored on the ledger.`, { did: didResult.did, attestedBy, explorerUrl: didResult.explorerUrl || null, verificationMethodId: didResult.verificationMethodId || null });
  syncOrgsToPeer();
  res.json({ ...org, password: undefined, twinCredentials: undefined });
});

router.post('/api/orgs/validate-credential', (req, res) => {
  const v = validateCredential(req.body.regNumber);
  if (v.valid && req.body.orgId) {
    const org = store.orgs.find(o => o.id === req.body.orgId);
    if (org) v.attestedBy = getAttestingAuthority(org);
  }
  res.json(v);
});

export default router;
