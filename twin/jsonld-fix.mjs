// In-process JSON-LD context resolver — restores the on-chain reference
// (`verifiableStorageId` / `immutableReceipt.objectId`, and on next.48 any
// notarization reference) in immutable-proof REST responses.
//
// TWIN-COMPAT: this is the `jsonld-context-loader` shim, registered in the
// inventory at server/twin/compat/index.js (SHIMS). It is self-contained on
// purpose — it is mounted into the TWIN node CONTAINER via NODE_OPTIONS=--import
// and runs in the node's runtime, so it cannot import the compat module (a
// container-boundary constraint). When the node version changes, review BOTH
// this file and the compat inventory entry. removeWhen: schema.twindev.org
// contexts resolve again (or the node bundles them).
//
// WHY: GET /immutable-proof/:id runs JsonLdProcessor.compact(). The on-chain
// reference terms are defined in the TWIN JSON-LD contexts under
// https://schema.twindev.org/, whose URLs return 404. Unresolvable context →
// compaction silently drops the terms → the demo's explorerUrlFromImmutableProof()
// returns null (badge stuck on "Writing to ledger", seed poll times out).
//
// HOW: preload via NODE_OPTIONS=--import in the node runtime. We install a
// custom JSON-LD document loader that returns a context for any
// schema.twindev.org URL and delegates everything else to the default loader.
//
// next.48 change (T-323): the immutable-proof shape moved. On next.40 the
// on-chain reference lived under .../common/, so a single fixed context with
// terms under common/ round-tripped them. On next.48 the field can be emitted
// under a DIFFERENT twindev base (e.g. .../immutable-proof/ or a notarization
// context). A context whose terms are pinned to common/ no longer matches that
// IRI, so compaction drops it again.
//
// The robust fix is base-aware: for each requested twindev URL we serve a
// context whose `@vocab` (and explicit known terms) match THAT url's base.
// Then any term in a document expanded under that base compacts back to its
// short key, regardless of which twindev base next.48 chose. The proof's
// @context lists several twindev URLs (immutable-proof/, common/, ...), and we
// serve a base-matched @vocab for each, so the field round-trips no matter
// where it lives. @vocab only affects twindev terms; w3.org / w3id.org
// contexts still delegate to the default loader.
//
// Read-path only: no re-anchoring; already-anchored proofs expose the field on
// the next GET.
import { JsonLdProcessor } from '@twin.org/data-json-ld';

// Known short keys the demo reads off the immutable-proof + receipt. Pinned to
// the requested base alongside @vocab as belt-and-suspenders.
const TERMS = [
  'verifiableStorageId',
  'immutableReceipt',
  'objectId',
  'network',
  'epoch',
  'digest',
  'smartContractId',
  'proofIntegrity',
  // next.48 notarization-backed reference candidates.
  'notarizationId',
  'notarization',
];

// Derive the context base from a twindev URL: everything up to and including
// the final '/'. e.g. https://schema.twindev.org/immutable-proof/  ->  same.
function baseOf(url) {
  if (url.endsWith('/')) return url;
  const i = url.lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : url;
}

const baseLoader = JsonLdProcessor.getDocumentLoader();

JsonLdProcessor.setDocumentLoader(async (url) => {
  if (typeof url === 'string' && url.includes('schema.twindev.org/')) {
    const base = baseOf(url);
    // @vocab matched to this url's base makes every term emitted under this
    // base round-trip to its short key on compaction. Explicit terms pin the
    // known fields to the same base in case the document mixes bases.
    const ctx = { '@version': 1.1, '@vocab': base };
    for (const t of TERMS) ctx[t] = base + t;
    return { documentUrl: url, document: { '@context': ctx }, contextUrl: null };
  }
  return baseLoader(url);
});

console.log('[jsonld-fix] installed schema.twindev.org JSON-LD loader (base-aware on-chain reference recovery, next.48)');
