// Shared document-verification helpers used by the public verify page
// (public-verify.js), the public shipment view (via customs preclearance),
// and the system-to-system verify API (verify-api.js). Centralised so the
// "verify a proof live, resolve the issuer org" logic lives in one place
// instead of being copied per route.
import { store, NODE_ID } from '../store.js';

// T-425: public surfaces must never see raw node/connector errors. Live-check
// failures are logged server-side and reported to callers as a single safe,
// generic string. `verified` is unchanged so verify-api.js and documents.js
// keep working.
const SAFE_LIVE_ERROR = 'Live check unavailable';
function logLiveFailure(doc, detail) {
  console.warn(`[verify] live check failed for doc ${doc?.id ?? '?'} (proof ${doc?.proofId ?? '?'}): ${detail}`);
}

// Live-verify a document's immutable proof against the node, in place.
// Only attempts when the proof was anchored on THIS node (cross-node proofs
// are resolved elsewhere). Mutates the doc's cached verification state and
// returns { verified, error }:
//   verified: true|false from the node, or null when not attempted/failed
//   error:    the failure message, or null
export async function liveVerifyDoc(doc) {
  if (!doc?.proofId) return { verified: null, error: null };
  // Cross-node proof: the document was anchored on ANOTHER node (e.g. opened
  // from beta for an alpha-anchored doc — the A4 cross-border case). Verify via
  // the federated immutable-proof or directly on the IOTA chain using
  // receipt.objectId — no node-of-origin or account required. (docker/hosted
  // only; simulated has no real chain and returns unavailable.)
  if (doc.notarizationNode && doc.notarizationNode !== NODE_ID) {
    try {
      const r = await store.adapter.verifyCrossNodeProof({
        proofId: doc.proofId,
        notarizationNode: doc.notarizationNode,
        receipt: doc.receipt ?? null,
      });
      if (r?.verified) {
        doc.proofVerified = true;
        doc.lastVerifiedAt = new Date().toISOString();
        return { verified: true, error: null };
      }
      if (r?.detail) logLiveFailure(doc, `cross-node: ${r.detail}`);
      return { verified: null, error: r?.detail ? SAFE_LIVE_ERROR : null };
    } catch (e) {
      logLiveFailure(doc, e.message);
      return { verified: null, error: SAFE_LIVE_ERROR };
    }
  }
  // Same-node proof.
  try {
    const verified = await store.adapter.verifyImmutableProof(doc.proofId);
    doc.proofVerified = verified;
    doc.lastVerifiedAt = new Date().toISOString();
    return { verified, error: null };
  } catch (e) {
    logLiveFailure(doc, e.message);
    return { verified: null, error: SAFE_LIVE_ERROR };
  }
}

// Resolve the issuing organisation for a document (local orgs, then peer orgs,
// then the creator org) — used to surface the issuer DID on verification views.
export function resolveIssuerOrg(doc) {
  return store.orgs.find(o => o.name === doc.issuer)
    ?? store.peerOrgs.find(o => o.name === doc.issuer)
    ?? store.orgs.find(o => o.id === doc.creatorOrgId)
    ?? null;
}
