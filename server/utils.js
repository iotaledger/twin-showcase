import crypto from 'crypto';
import { normalizeImmutableProof } from './twin/compat/index.js';

// `findFirstByKey` and the immutable-proof shape tolerance now live in the
// TWIN compat layer (server/twin/compat) — they compensate for the on-chain
// reference moving around the proof object across node versions. Re-exported
// here for back-compat (the utils tests import it from this path).
export { findFirstByKey } from './twin/compat/index.js';

export const genId = () => crypto.randomBytes(8).toString('hex');
export const genHash = () => '0x' + crypto.randomBytes(16).toString('hex');
export const genDID = () => 'did:iota:0x' + crypto.randomBytes(12).toString('hex');
export const now = () => new Date().toISOString();

// Real SHA-256 of a Buffer or Uint8Array, returned as `0x`-prefixed hex.
// Used to compute the content hash that goes into the notarization metadata.
export const sha256OfBuffer = (buffer) =>
  '0x' + crypto.createHash('sha256').update(buffer).digest('hex');

// Derive an IOTA Explorer URL for a DID. The Explorer's /identity/ path
// renders the DID document in human-readable form (verification methods,
// services, controller), unlike /object/<hex> which only shows the raw
// on-chain object. Input format: "did:iota:<network>:0x<hex>" (newer
// TWIN) or "did:iota:0x<hex>" (older, no network). Returns null when the
// input is missing or doesn't look like an IOTA DID.
export const iotaExplorerUrlFromDid = (did, network = 'testnet') => {
  if (typeof did !== 'string' || !did.startsWith('did:iota:')) return null;
  // The Explorer accepts the DID with `:` replaced by `-`. The network
  // suffix in the query string still needs the real word (testnet/mainnet);
  // extract it from the DID when present, else fall back to the parameter.
  const parts = did.split(':');
  const networkFromDid = (parts.length === 4 && /^(testnet|mainnet|devnet)$/i.test(parts[2])) ? parts[2] : network;
  const slug = did.replace(/:/g, '-');
  return `https://explorer.iota.org/identity/${slug}?network=${networkFromDid}`;
};

// Derive an IOTA Explorer URL for an on-chain object referenced by a TWIN
// verifiableStorageId. Format: "verifiable:iota:0x<network>:0x<object-hex>".
// The last `:` segment is the object hex used by the Explorer's /object/ path.
// Returns null when the input is missing or malformed.
export const iotaExplorerUrlFromVerifiableStorageId = (vsid, network = 'testnet') => {
  if (typeof vsid !== 'string') return null;
  const m = vsid.match(/(0x[0-9a-f]+)$/i);
  if (!m) return null;
  return `https://explorer.iota.org/object/${m[1]}?network=${network}`;
};

// Derive an IOTA Explorer URL from a TWIN attestation id. Format:
// "attestation:nft:<base64-of-nft-urn>" where the inner URN is
// "nft:iota:<network>:<smartContractId>:<objectId>". The Explorer points
// at the object hex (last segment of the URN). Returns null on bad input.
export const iotaExplorerUrlFromAttestationId = (attestationId) => {
  if (typeof attestationId !== 'string') return null;
  const m = attestationId.match(/^attestation:nft:(.+)$/);
  if (!m) return null;
  let urn;
  try { urn = Buffer.from(m[1], 'base64').toString('utf8'); }
  catch { return null; }
  // urn = "nft:iota:testnet:0x<smartContract>:0x<object>"
  const parts = urn.split(':');
  const objectId = parts[parts.length - 1];
  const network = parts[2] || 'testnet';
  if (!/^0x[0-9a-f]+$/i.test(objectId)) return null;
  return `https://explorer.iota.org/object/${objectId}?network=${network}`;
};

// Derive an IOTA Explorer URL from a TWIN immutable-proof VC, regardless of
// where the on-chain reference lives in the response shape. Tries, in order:
//   1. any `verifiableStorageId` field (recent TWIN: nested under `proof`)
//   2. an `immutableReceipt.objectId` (+ `network`) — same data, different
//      packaging in newer TWIN versions
// Returns null when neither is present.
export const explorerUrlFromImmutableProof = (proof) => {
  const { verifiableStorageId, receipt } = normalizeImmutableProof(proof);
  if (verifiableStorageId) return iotaExplorerUrlFromVerifiableStorageId(verifiableStorageId);
  if (receipt && typeof receipt.objectId === 'string') {
    const network = receipt.network ?? 'testnet';
    return `https://explorer.iota.org/object/${receipt.objectId}?network=${network}`;
  }
  return null;
};

// Extract the immutableReceipt + verifiableStorageId + proofIntegrity from an
// immutable-proof VC into a flat, UI-friendly shape. Returns null when no
// on-chain anchor is present in the proof yet (TWIN signing is async — initial
// proof responses have an empty `proof` field).
//
// proofIntegrity is the envelope hash that TWIN actually anchors on chain
// ("sha256-<base64>"). It is the cryptographic link between the file
// fingerprint embedded in the envelope and the on-chain anchor.
export const extractImmutableReceipt = (proof) => {
  const { verifiableStorageId, proofIntegrity, receipt } = normalizeImmutableProof(proof);
  if (!receipt) {
    if (verifiableStorageId || proofIntegrity) return { verifiableStorageId, proofIntegrity };
    return null;
  }
  return { verifiableStorageId, proofIntegrity, ...receipt };
};
export const escXml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
