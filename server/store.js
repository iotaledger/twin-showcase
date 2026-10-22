import { WebSocket } from 'ws';
import { genId, genHash, now } from './utils.js';
import { loadConfig, getConfig } from './config.js';
import { loadSeedStateForNode } from './seed-state.js';
import { iotaExplorerUrlFromDid } from './utils.js';
import { getAttestingAuthority } from './identity-helpers.js';

// Load corridor config before store init (must happen before getConfig() calls)
loadConfig();

// ── CLI args & env ──
const args = process.argv.slice(2).reduce((a, c) => { const [k, v] = c.replace('--', '').split('='); a[k] = v; return a; }, {});
export const PORT     = parseInt(process.env.PORT     || args.port || '4000');
export const WS_PORT  = parseInt(process.env.WS_PORT  || args.ws   || '4010');
export const NODE_ID  = process.env.NODE_ID   || args.id   || 'alpha';
export const NODE_NAME= process.env.NODE_NAME || args.name || 'Node Alpha';
export const PEER_URL = process.env.PEER_URL  || args.peer || null;
export const NODE_IP  = `127.0.0.1:${PORT}`;

// T-303: file persistence removed. The ledger now lives in:
//   - simulated mode → store.ledgerLog (in-memory, reset on restart)
//   - docker/hosted   → AIS on the TWIN node (durable, signed) + an
//                       in-memory cache mirrored via shadow-write
// Stale `data/ledger-{nodeId}.json` files on disk are harmless and can be
// deleted manually.

// ── Store init ──
// Hydrate org state from data/seed-state.json when the seeder has populated
// the corresponding TWIN nodes. Without this, `npm run twin:seed` mints DIDs
// on testnet but the demo UI still shows every org as unregistered (because
// initOrgs would default everything to did=null), forcing the user to click
// "Register DID" again and create a second on-chain identity.
function initOrgs() {
  const cfgOrgs = getConfig()?.nodes?.[NODE_ID]?.orgs;
  if (!cfgOrgs) return [];
  const seedState = loadSeedStateForNode(NODE_ID, getConfig()?.corridor?.id);
  const seededOrgs = seedState?.orgs ?? {};

  let hydrated = 0;
  const orgs = cfgOrgs.map(o => {
    const seed = seededOrgs[o.id];
    if (!seed?.did) {
      return { ...o, did: null, verified: false, regNumber: null };
    }
    hydrated++;
    // The seeder doesn't carry a regNumber (the UI register flow is the
    // only place validateCredential runs). Synthesize one so the UI has
    // something to show for the "registered" badge — clearly marked
    // SEED- to flag its provenance.
    // T-247: always recompute explorerUrl from the DID at hydration time
    // so old seed-state entries (with the previous /object/ URL format)
    // pick up the human-readable /identity/ format without requiring a
    // re-seed.
    const explorerUrl = iotaExplorerUrlFromDid(seed.did) ?? seed.explorerUrl ?? null;
    return {
      ...o,
      did: seed.did,
      explorerUrl,
      verificationMethodId: seed.verificationMethodId ?? null,
      // T-316: tenantApiKey is present when the org was provisioned as its
      // own TWIN tenant (wallets.mjs provision-orgs). The per-org attestation
      // client logs in against that tenant, so its api-key must ride along.
      // Absent for REST-provisioned orgs (one-tenant-per-node) — the adapter
      // falls back to the node tenant key.
      twinCredentials: (seed.email && seed.password)
        ? { email: seed.email, password: seed.password, tenantApiKey: seed.tenantApiKey ?? null }
        : null,
      verified: true,
      regNumber: `SEED-${o.id.toUpperCase()}`,
      attestedBy: getAttestingAuthority(o),
    };
  });
  if (hydrated > 0) {
    console.log(`[${NODE_NAME}] Hydrated ${hydrated}/${cfgOrgs.length} orgs from data/seed-state.json`);
  }
  return orgs;
}

export const store = {
  orgs: initOrgs(),
  consignments: [], documents: [], permissions: {}, docPermissions: {},
  payments: [], letterOfCredits: [], smartContracts: [], financePermissions: {},
  ledgerLog: [],
  // T-325: persistent inbound-share notifications (the header bell inbox). Held
  // server-side so they survive a client reload / WS reconnect; acknowledged via
  // /api/notifications/:id/ack.
  notifications: [],
  // T-218: ODRL policy stubs generated alongside each in-memory grant. Keyed
  // by `${consignmentId}:${recipientOrgId}` so revoke() can delete the matching
  // entry. Phase 3 (T-304) replaces these with real /rights-management calls.
  odrlPolicies: {},
  peerOrgs: [], peerConnected: false,
  adapter: null, // ITwinAdapter instance, set at server startup (T-209)
  // T-303: AIS stream id for this server session. Lazily created by
  // ensureAisStream() on first addLog/seedLog in docker mode. The
  // /api/ledger read path uses listAisEntries(undefined) which spans all
  // streams (this session's + prior sessions'), so the streamId is only
  // needed for writes.
  aisStreamId: null,
};

// ── WebSocket references (set by ws.js) ──
export const wsRefs = {
  peerWs: null,
  peerInWs: null,
  broadcastToClients: () => {},
  connectToPeer: () => {},
  syncOrgsToPeer: () => {},
};

// ── Ledger helpers ──
export function addLog(type, action, actor, details, extra = {}) {
  const entry = { id: genId(), timestamp: now(), hash: genHash(), type, action, actor, details, ...extra };
  store.ledgerLog.unshift(entry);
  wsRefs.broadcastToClients({ type: 'LEDGER_UPDATE', log: store.ledgerLog });
  const activePeer = [wsRefs.peerWs, wsRefs.peerInWs].find(w => w?.readyState === WebSocket.OPEN);
  if (store.peerConnected && activePeer) activePeer.send(JSON.stringify({ type: 'LEDGER_ENTRY', entry }));
  // T-303: shadow-write to AIS in docker/hosted mode. Fire-and-forget so
  // the in-memory broadcast above stays synchronous and TWIN slowness
  // doesn't block the API request that triggered the log.
  shadowWriteToAis(entry);
  return entry;
}

// T-325: append a persistent inbound-share notification and push it to clients.
// `partial` carries the share detail (ucr, consignmentId, fromNode, docCount, …).
export function addNotification(partial) {
  // Dedup: don't stack multiple unacked notifications for the same consignment
  // (the WS-share signal and the DSP poll can both fire for one share).
  if (partial.consignmentId && store.notifications.some(n => !n.acked && n.consignmentId === partial.consignmentId)) {
    return null;
  }
  const entry = { id: genId(), ts: now(), acked: false, ...partial };
  store.notifications.unshift(entry);
  wsRefs.broadcastToClients({ type: 'CONSIGNMENT_RECEIVED', notification: entry });
  return entry;
}

// T-417: mirror a freshly-created/updated document to the peer node over the
// P2P channel (the recipient's store gains the doc). Best-effort: silently
// drops when no peer socket is open (a later SHARE_CONSIGNMENT replays state).
// The blob never rides the wire. The CALLER decides whether the consignment is
// shared cross-node; this owns the socket-find + send + blob-strip that was
// copy-pasted across documents.js (x2) and customs.js.
export function mirrorDocumentToPeer(consignmentId, doc) {
  const peerSock = [wsRefs.peerWs, wsRefs.peerInWs].find(w => w?.readyState === WebSocket.OPEN);
  if (!peerSock) return false;
  // Carry the blob over the demo P2P channel so the peer can OPEN the doc
  // (download / XML view), not just see its metadata. (The DSP path stays
  // metadata-only; the WS channel is the demo's file-delivery mechanism.)
  peerSock.send(JSON.stringify({
    type: 'UPLOAD_DOCUMENT',
    consignmentId,
    document: doc,
  }));
  return true;
}

export function seedLog(type, action, actor, details, timestamp) {
  if (store.ledgerLog.some(e => e.details === details)) return;
  const entry = { id: genId(), timestamp, hash: genHash(), type, action, actor, details };
  store.ledgerLog.push(entry);
  // T-303: also stream seeded entries to AIS so the audit trail is the
  // same across restarts. Dedup against AIS is best-effort (the demo
  // accepts the small risk of duplicate seed entries across re-seeds in
  // exchange for keeping the seed flow synchronous + simple).
  shadowWriteToAis(entry);
}

// ── AIS helpers (T-303) ─────────────────────────────────────────────

// Cache the in-flight stream-creation promise so concurrent addLog calls
// at boot don't each fire a parallel POST /ais.
let aisStreamPromise = null;

async function ensureAisStream() {
  if (!store.adapter || store.adapter.mode === 'simulated') return null;
  if (store.aisStreamId) return store.aisStreamId;
  if (!aisStreamPromise) {
    aisStreamPromise = (async () => {
      try {
        const result = await store.adapter.createAisStream({
          annotationObject: {
            '@context': 'https://schema.org',
            '@type': 'Dataset',
            name: `Ledger stream for ${NODE_NAME}`,
            identifier: `twin:ledger:${NODE_ID}`,
            dateCreated: now(),
            ...(getConfig()?.corridor?.id ? { keywords: [getConfig().corridor.id] } : {}),
          },
        });
        if (result?.aisStreamId) {
          store.aisStreamId = result.aisStreamId;
          console.log(`[${NODE_NAME}] AIS stream initialised: ${result.aisStreamId}`);
        }
        return store.aisStreamId;
      } catch (e) {
        console.warn(`[${NODE_NAME}] AIS stream init failed: ${e.message}`);
        aisStreamPromise = null; // allow retry on next call
        return null;
      }
    })();
  }
  return aisStreamPromise;
}

function shadowWriteToAis(entry) {
  if (!store.adapter || store.adapter.mode === 'simulated') return;
  (async () => {
    try {
      const streamId = await ensureAisStream();
      if (!streamId) return;
      const reservedKeys = new Set(['id', 'timestamp', 'hash', 'type', 'action', 'actor', 'details']);
      const metadata = Object.fromEntries(
        Object.entries(entry).filter(([k]) => !reservedKeys.has(k))
      );
      const entryObject = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        ledgerType: entry.type,
        action: entry.action,
        actor: entry.actor,
        details: entry.details,
        timestamp: entry.timestamp,
        ledgerHash: entry.hash,
        ...(Object.keys(metadata).length > 0 ? { additionalProperty: metadata } : {}),
      };
      await store.adapter.appendAisEntry(streamId, entryObject);
    } catch (e) {
      console.warn(`[${NODE_NAME}] AIS append failed: ${e.message}`);
    }
  })();
}

// Round-trip an AIS entry back to the demo's ledger entry shape. Used by
// /api/ledger and hydrateLedgerFromAis().
export function aisEntryToLedger(aisEntry) {
  // next.48: the AIS entry list compacts under the `schema:` vocab — the entry
  // body is `schema:entryObject` and its fields are `schema:action`/`schema:details`/
  // `schema:ledgerHash`/… Accept both plain and schema:-prefixed so /api/ledger
  // (the Analytics view) is populated instead of empty.
  const obj = aisEntry?.['schema:entryObject'] ?? aisEntry?.entryObject;
  if (!obj) return null;
  const f = (k) => obj[k] ?? obj[`schema:${k}`];
  return {
    id: aisEntry.id,
    timestamp: f('timestamp') ?? aisEntry.dateCreated ?? null,
    hash: f('ledgerHash') ?? null,
    type: f('ledgerType') ?? 'system',
    action: f('action') ?? 'AIS Entry',
    actor: f('actor') ?? 'System',
    details: f('details') ?? '',
    ...(f('additionalProperty') ?? {}),
    aisEntryId: aisEntry.id,
  };
}

// Boot-time helper: pull recent AIS entries into the in-memory cache so
// the WS LEDGER_UPDATE broadcast (which sends store.ledgerLog) carries
// prior-session events too. Called from server/index.js after warmUp.
// Best-effort: a slow/unreachable TWIN node doesn't block server start.
export async function hydrateLedgerFromAis(limit = 200) {
  if (!store.adapter || store.adapter.mode === 'simulated') return 0;
  try {
    const result = await store.adapter.listAisEntries(undefined, { limit });
    const mapped = (result?.entries ?? []).map(aisEntryToLedger).filter(Boolean);
    let added = 0;
    const seenDetails = new Set(store.ledgerLog.map(e => e.details));
    for (const entry of mapped) {
      if (!seenDetails.has(entry.details)) {
        store.ledgerLog.push(entry);
        seenDetails.add(entry.details);
        added++;
      }
    }
    store.ledgerLog.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    if (added > 0) console.log(`[${NODE_NAME}] Hydrated ${added} ledger entries from AIS`);
    return added;
  } catch (e) {
    console.warn(`[${NODE_NAME}] AIS hydration failed: ${e.message}`);
    return 0;
  }
}

// ── ODRL policy hydration (T-304) ───────────────────────────────────
//
// Boot-time helper: replay ODRL policies stored on the TWIN node back into
// store.permissions / store.docPermissions / store.odrlPolicies so a
// docker-mode restart preserves the cross-node shares that survived in the
// signed policy administration point. The policy uid follows the format
// emitted by buildOdrlPolicy in routes/permissions.js:
//   urn:moit:policy:<consignmentId>:<recipientOrgId>
// permission[].target is one of:
//   urn:moit:consignment:<consignmentId>   (full-share)
//   urn:moit:document:<documentId>         (selective-share)
// permission[].assignee is either the recipient org's DID or
//   urn:moit:org:<recipientOrgId> when the org has no DID yet.
//
// Returns the number of (consignment, recipient) pairs hydrated.

function parsePolicyUid(uid) {
  if (typeof uid !== 'string') return null;
  const m = uid.match(/^urn:moit:policy:([^:]+):(.+)$/);
  if (!m) return null;
  return { consignmentId: m[1], recipientOrgId: m[2] };
}

function parsePermissionTargets(permission) {
  if (!Array.isArray(permission)) return { consignmentTargets: new Set(), docTargets: new Set() };
  const consignmentTargets = new Set();
  const docTargets = new Set();
  for (const p of permission) {
    const t = typeof p?.target === 'string' ? p.target : null;
    if (!t) continue;
    let m;
    if ((m = t.match(/^urn:moit:consignment:(.+)$/))) consignmentTargets.add(m[1]);
    else if ((m = t.match(/^urn:moit:document:(.+)$/))) docTargets.add(m[1]);
  }
  return { consignmentTargets, docTargets };
}

function resolveAssigneeToOrgId(permission) {
  // Try every permission entry to find a hint about the recipient org.
  if (!Array.isArray(permission)) return null;
  for (const p of permission) {
    const a = typeof p?.assignee === 'string' ? p.assignee : null;
    if (!a) continue;
    const urnMatch = a.match(/^urn:moit:org:(.+)$/);
    if (urnMatch) return urnMatch[1];
    if (a.startsWith('did:')) {
      const byDid =
        store.orgs.find(o => o.did === a)
        ?? store.peerOrgs.find(o => o.did === a);
      if (byDid?.id) return byDid.id;
    }
  }
  return null;
}

export async function hydratePermissionsFromOdrl(limit = 200) {
  if (!store.adapter || store.adapter.mode === 'simulated') return 0;
  try {
    const result = await store.adapter.queryOdrlPolicies({ limit });
    const policies = Array.isArray(result?.policies) ? result.policies : [];
    if (policies.length === 0) return 0;

    let hydrated = 0;
    for (const policy of policies) {
      if (!policy || typeof policy !== 'object') continue;
      // Policy id from the TWIN node — must be preserved so revoke can
      // call deleteOdrlPolicy(twinPolicyId) without re-querying.
      const twinPolicyId =
        policy.id ?? policy['@id'] ?? policy.policyId ?? policy.uid ?? null;

      // Use uid to recover (consignmentId, recipientOrgId). Falls back to
      // assignee parsing for the recipient when uid is non-standard.
      const fromUid = parsePolicyUid(policy.uid ?? policy.policyId);
      const permission = policy.permission ?? [];
      const { consignmentTargets, docTargets } = parsePermissionTargets(permission);
      const consignmentId =
        fromUid?.consignmentId
        ?? (consignmentTargets.size > 0 ? consignmentTargets.values().next().value : null);
      const recipientOrgId =
        fromUid?.recipientOrgId
        ?? resolveAssigneeToOrgId(permission);

      if (!consignmentId || !recipientOrgId) continue;

      if (!store.permissions[consignmentId]) store.permissions[consignmentId] = {};
      if (!store.permissions[consignmentId][recipientOrgId]) {
        store.permissions[consignmentId][recipientOrgId] = 'viewer';
      }

      if (docTargets.size > 0) {
        for (const docId of docTargets) {
          if (!store.docPermissions[docId]) store.docPermissions[docId] = {};
          if (!store.docPermissions[docId][recipientOrgId]) {
            store.docPermissions[docId][recipientOrgId] = 'viewer';
          }
        }
      }

      const odrlKey = `${consignmentId}:${recipientOrgId}`;
      store.odrlPolicies[odrlKey] = {
        ...policy,
        ...(twinPolicyId ? { twinPolicyId } : {}),
      };
      hydrated++;
    }
    if (hydrated > 0) {
      console.log(`[${NODE_NAME}] Hydrated ${hydrated} ODRL policy/policies from TWIN PAP`);
    }
    return hydrated;
  } catch (e) {
    console.warn(`[${NODE_NAME}] ODRL hydration failed: ${e.message}`);
    return 0;
  }
}

// ── Federated catalogue hydration (T-306) ──────────────────────────
//
// Boot-time helper: discover peer-node orgs via the TWIN node's DCAT
// catalogue. The catalogue federates across TWIN_DATASPACE_PEER_NODES so
// a single query returns datasets from this node + every configured peer.
// Replaces the legacy WS ORG_DIRECTORY handshake when the catalogue has
// data; when empty/unreachable the WS path (server/ws.js) still populates
// store.peerOrgs as a fallback.

function dcatOrgToPeer(dataset) {
  if (!dataset || typeof dataset !== 'object') return null;
  const type = dataset['@type'] ?? dataset.type ?? null;
  const typed =
    type === 'Organization'
    || (Array.isArray(type) && type.includes('Organization'));
  if (!typed) return null;

  const publisher = (typeof dataset.publisher === 'object' && dataset.publisher) || {};
  const id =
    dataset.identifier
    ?? dataset['@id']
    ?? publisher.identifier
    ?? null;
  if (!id) return null;

  // Skip orgs that live on this node — we only want true peers here.
  if (typeof id === 'string' && store.orgs.some(o => o.id === id)) return null;

  return {
    id,
    name: dataset.title ?? dataset.name ?? publisher.name ?? id,
    role: dataset.role ?? publisher.role ?? null,
    did: dataset.did ?? publisher.did ?? null,
    verified: dataset.verified ?? Boolean(dataset.did ?? publisher.did),
    nodeId: dataset.providerNodeId ?? dataset.nodeId ?? null,
    nodeName: dataset.providerNodeName ?? dataset.nodeName ?? null,
  };
}

export async function hydratePeerOrgsFromCatalog() {
  if (!store.adapter || store.adapter.mode === 'simulated') return 0;
  try {
    const result = await store.adapter.queryFederatedCatalog({ type: 'Organization' });
    const datasets = Array.isArray(result?.datasets) ? result.datasets : [];
    if (datasets.length === 0) return 0;

    const mapped = datasets.map(dcatOrgToPeer).filter(Boolean);
    if (mapped.length === 0) return 0;

    // Merge into store.peerOrgs: catalogue entries win by id over any
    // WS-discovered entries that landed earlier in the same boot.
    const byId = new Map(store.peerOrgs.map(o => [o.id, o]));
    for (const peer of mapped) byId.set(peer.id, peer);
    store.peerOrgs = Array.from(byId.values());
    store.peerConnected = store.peerOrgs.length > 0;

    console.log(`[${NODE_NAME}] Hydrated ${mapped.length} peer org(s) from federated catalogue`);
    return mapped.length;
  } catch (e) {
    console.warn(`[${NODE_NAME}] Federated catalogue hydration failed: ${e.message}`);
    return 0;
  }
}
