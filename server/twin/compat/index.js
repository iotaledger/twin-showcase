// ─────────────────────────────────────────────────────────────────────────
// TWIN node compatibility layer — single source of truth + inventory for
// every version-specific shim the demo carries to work with a given
// `twinfoundation/twin-node` image.
//
// WHY THIS EXISTS
// Each shim below compensates for a quirk, gap, or bug of ONE node version.
// Left scattered across the adapter, scripts, utils, and docker-compose, they
// are invisible and expensive to revisit at upgrade time. Centralising them
// here means: when the node moves toward 1.0, you open THIS file, walk the
// `SHIMS` inventory, delete what upstream fixed, adjust the rest — and the
// application code (which imports the constants/functions below) does not
// change. You pay the upgrade in one place, not five.
//
// HOW TO UPGRADE THE NODE
//   1. Bump the image tag in docker-compose.twin.yml + NODE_COMPAT_VERSION below.
//   2. Walk SHIMS: for each, test whether `removeWhen` is now satisfied.
//   3. Delete obsolete shims here; their consumers fail loudly (import error)
//      so nothing silently keeps a dead workaround.
//   4. Run `npm test` + the org-attestation smoke test.
//
// IMPORT SAFETY: this module is pure — only the `crypto` builtin, no imports
// from the server (store/express) — so BOTH the server and the `scripts/twin/*`
// scripts can import it without pulling in the app.
// ─────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';

// The node image this code's shims are written against. Keep in sync with the
// `image:` tag in docker-compose.twin.yml. The version-assert below warns when
// the running node reports a different version.
export const NODE_COMPAT_VERSION = '0.9.0';

// ── Inventory ──────────────────────────────────────────────────────────────
// The complete list of version-specific compensations. `kind`:
//   in-process — implemented in this module (the adapter/utils call into it)
//   infra      — runs outside the demo server (container / CLI); registered
//                here for visibility, but its code physically lives elsewhere
//                (the container boundary prevents importing this module)
//   parameter  — a magic number/rule sourced from here
export const SHIMS = [
  {
    id: 'jsonld-context-loader',
    kind: 'infra',
    compensates: 'schema.twindev.org JSON-LD contexts return 404, so the node drops the on-chain reference (verifiableStorageId / immutableReceipt.objectId) during JSON-LD compaction of immutable-proof responses, breaking the IOTA Explorer deep-link and leaving documents stuck on "Writing on Ledger". T-323: on next.48 the field can be emitted under a different twindev base, so the shim now serves a base-aware @vocab context (matched to each requested twindev url) instead of a single common/ context, recovering the term whatever base next.48 uses.',
    location: 'twin/jsonld-fix.mjs — mounted into the node container via NODE_OPTIONS=--import (docker-compose.twin.yml). Self-contained by necessity: it runs inside the node runtime and cannot import this module.',
    removeWhen: 'schema.twindev.org serves the contexts again, or the node bundles them locally.',
  },
  {
    id: 'cli-mnemonic-did',
    kind: 'infra',
    compensates: 'REST `POST /identity` accepts only a namespace, not a mnemonic, so a REST-created org DID has no wallet — NFT minting then fails with secretNotFound `<orgDID>/mnemonic`.',
    location: 'scripts/twin/wallets.mjs (provision-orgs + anchor) via CLI `identity-create --mnemonic`.',
    removeWhen: 'the REST surface gains a vault-secret write (or identity-create-with-mnemonic).',
  },
  {
    id: 'bootstrap-completeness',
    kind: 'infra',
    compensates: 'the legacy `node-admin-user` feature provisioned the auth-signing key, blob-encryption key, param-encryption key (next.48 URL transformer), immutable-proof-assertion VM, and user-admin scope implicitly; the granular CLI chain must do each explicitly or login / notarization / minting break.',
    location: 'scripts/twin/wallets.mjs (anchor) — composes the VM + VAULT_KEY constants from this module.',
    removeWhen: 'the node bootstrap provisions these explicitly (or documents the required set).',
  },
  {
    id: 'immutable-proof-shape',
    kind: 'in-process',
    compensates: 'the on-chain anchor reference (verifiableStorageId / immutableReceipt.objectId) moves around the immutable-proof object across node versions, so a fixed path does not find it.',
    location: 'this module — normalizeImmutableProof(); server/utils.js wrappers delegate to it.',
    removeWhen: 'the node returns a stable, documented receipt shape.',
  },
  {
    id: 'password-policy',
    kind: 'in-process',
    compensates: "the node's PasswordValidator requires >=16 chars + upper/lower/special AND rejects any run of 3+ identical chars (/(.)\\1{2,}/, validation.repeatedCharacters).",
    location: 'this module — genPolicyPassword(); used by server/adapter/docker.js and scripts/twin/wallets.mjs.',
    removeWhen: 'the policy is relaxed or made configurable.',
  },
  {
    id: 'org-funding-floor',
    kind: 'parameter',
    compensates: 'each on-chain DID/VM/mint op reserves a 1-IOTA gas budget, so a wallet holding exactly 1 IOTA fails ("does not have enough coins to form a balance of 1000000000"). Actual spend is ~0.03 IOTA.',
    location: 'this module — ORG_FUNDING_IOTA_DEFAULT; scripts/twin/wallets.mjs (provision-orgs).',
    removeWhen: 'gas budgeting no longer pre-reserves a full IOTA per op.',
  },
  {
    id: 'immutable-proof-notarization-gate',
    kind: 'infra',
    compensates: 'next.48 wires the immutable-proof component to a notarizationConnector. Because the demo enables the dataspace (TWIN_DATASPACE_ENABLED=true) the immutable-proof component is required, so the engine aborts at start with "Instance type not found for notarizationConnector" unless a connector is registered. Setting TWIN_NOTARIZATION_CONNECTOR=iota registers it, reusing the shared IOTA dltConfig (same as verifiable-storage and nft).',
    location: 'twin/alpha/node.env + twin/beta/node.env (TWIN_NOTARIZATION_CONNECTOR=iota).',
    removeWhen: 'the node stops coupling immutable-proof to a notarization connector, or auto-registers a default.',
  },
  {
    id: 'tenant-additive',
    kind: 'parameter',
    compensates: 'twin-node next.48 removed `node-set-tenant` and the node-wide tenant binding. Every tenant, the node tenant and each per-org tenant alike, is resolved per request from its `x-api-key`. Tenants are created with `tenant-create` only; there is no pinning step. next.63 (node next.53 "organization identifiers") then made `tenant-create --organization-id=<did>` REQUIRED: each tenant is bound to an organization DID. wallets.mjs passes the node/org DID; in provision-orgs this forces identity-create to run BEFORE tenant-create so the DID exists.',
    location: 'scripts/twin/wallets.mjs — anchor (node tenant) + provision-orgs (per-org tenants); documented in authentication-architecture.md §3.',
    removeWhen: 'n/a — correct node behaviour on next.48/next.63+; recorded to explain the auth model.',
  },
];

// ── Version assert ───────────────────────────────────────────────────────────
// The node root `GET /` returns e.g. "TWIN Node - 0.0.3-next.40".
export function parseNodeVersion(rootResponseText) {
  if (typeof rootResponseText !== 'string') return null;
  const m = rootResponseText.match(/TWIN Node\s*-\s*([0-9][\w.\-]*)/i);
  return m ? m[1] : null;
}

// Compare the running node version to NODE_COMPAT_VERSION and warn (never
// throw — a version drift should be loud, not demo-breaking). Returns a small
// result object so callers/tests can inspect it.
export function assertNodeCompat(reportedVersion, { logger = console } = {}) {
  const target = NODE_COMPAT_VERSION;
  if (!reportedVersion) {
    logger.warn?.(`[twin-compat] could not read the TWIN node version; shims target ${target}. If you changed the node image, review server/twin/compat/.`);
    return { ok: false, reported: null, target };
  }
  if (reportedVersion !== target) {
    logger.warn?.(`[twin-compat] ⚠ node version drift: running ${reportedVersion}, shims target ${target}. Review server/twin/compat/ (${SHIMS.length} shims) — some may be obsolete or need updating.`);
    return { ok: false, reported: reportedVersion, target };
  }
  logger.log?.(`[twin-compat] TWIN node ${reportedVersion} matches compat target (${SHIMS.length} shims active).`);
  return { ok: true, reported: reportedVersion, target };
}

// ── Verification-method + vault-key identifiers (the magic strings) ──────────
// Centralised so a rename can't drift between the adapter (REST createDid) and
// the bootstrap/provisioning scripts (CLI). Each flow composes the SET it needs
// from these names — the sets legitimately differ (REST createDid provisions 2,
// the anchor/provision chain provisions 3).
export const VM = {
  ORG_ASSERTION: 'org-assertion',
  ATTESTATION_ASSERTION: 'attestation-assertion',
  IMMUTABLE_PROOF_ASSERTION: 'immutable-proof-assertion',
};

export const VAULT_KEY = {
  // BlobStorageService encrypts every blob with this symmetric key under the
  // uploader's org identity (TWIN_BLOB_STORAGE_ENABLE_ENCRYPTION=true).
  BLOB_ENCRYPTION: { id: 'blob-encryption', type: 'ChaCha20Poly1305' },
  // EntityStorageAuthenticationService signs login JWTs with this key.
  AUTH_SIGNING: { id: 'auth-signing', type: 'Ed25519' },
  // T-323: next.48 URL transformer encrypts the tenant token with this key
  // under the node DID (TWIN_URL_TRANSFORMER_ENCRYPTION_KEY_ID, default
  // `param-encryption`). bootstrap-legacy creates it; the granular chain must too.
  PARAM_ENCRYPTION: { id: 'param-encryption', type: 'ChaCha20Poly1305' },
};

// ── Per-org funding floor (org-funding-floor shim) ───────────────────────────
export const ORG_FUNDING_IOTA_DEFAULT = 2n; // >1: each on-chain op reserves a 1-IOTA gas budget.

// ── Password policy (password-policy shim) ───────────────────────────────────
// Generate a password that satisfies the node policy: the "Org+…!Demo" frame
// covers length + char classes; the random hex body occasionally produces a
// 3-run, so regenerate until the repeated-characters rule passes too.
export function genPolicyPassword() {
  let password;
  do {
    password = 'Org+' + crypto.randomBytes(12).toString('hex') + '!Demo';
  } while (/(.)\1{2,}/.test(password));
  return password;
}

// ── Immutable-proof shape normalization (immutable-proof-shape shim) ─────────
// Walk an object and return the first value at any nesting level whose key
// matches `target`. The on-chain reference hides at different depths across
// node versions, hence the deep walk. (Also re-exported from server/utils.js
// for back-compat; the utils tests import it from there.)
export function findFirstByKey(obj, target) {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = findFirstByKey(item, target);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === target) return v;
    const nested = findFirstByKey(v, target);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// Normalise an immutable-proof VC into a flat, version-stable shape:
//   { verifiableStorageId, notarizationId, proofIntegrity,
//     receipt: { objectId, network, epoch, digest, smartContractId } | null }
// `receipt` is null when no on-chain anchor is present yet (TWIN signs async).
// server/utils.js builds extractImmutableReceipt() + explorerUrlFromImmutableProof()
// on top of this, keeping the (stable) Explorer URL formatting there.
//
// next.48 (T-323): the on-chain anchor moved from verifiableStorageId (a
// verifiable-storage object) to a notarization reference carried on the proof,
// of the form "notarization:iota:0x<objectId>". The base-aware jsonld-fix shim
// keeps this term through JSON-LD compaction; here we surface it and derive the
// on-chain objectId into `receipt` so the existing Explorer URL builder and the
// cross-node verify (both read `receipt.objectId`) keep working unchanged.
export function normalizeImmutableProof(proof) {
  const raw = findFirstByKey(proof, 'immutableReceipt');
  const verifiableStorageId = findFirstByKey(proof, 'verifiableStorageId') ?? null;
  const notarizationId = findFirstByKey(proof, 'notarizationId') ?? null;
  const proofIntegrity = findFirstByKey(proof, 'proofIntegrity') ?? null;
  let receipt = (raw && typeof raw === 'object')
    ? {
        objectId: typeof raw.objectId === 'string' ? raw.objectId : null,
        network: typeof raw.network === 'string' ? raw.network : null,
        epoch: typeof raw.epoch === 'number' ? raw.epoch : null,
        digest: typeof raw.digest === 'string' ? raw.digest : null,
        smartContractId: typeof raw.smartContractId === 'string' ? raw.smartContractId : null,
      }
    : null;
  // next.48: no verifiable-storage receipt, but a notarizationId carries the
  // on-chain objectId. Derive a minimal receipt so downstream code is unchanged.
  if (!receipt && typeof notarizationId === 'string') {
    const m = notarizationId.match(/(0x[0-9a-f]+)/i);
    if (m) receipt = { objectId: m[1], network: 'testnet', epoch: null, digest: null, smartContractId: null };
  }
  return { verifiableStorageId, notarizationId, proofIntegrity, receipt };
}
