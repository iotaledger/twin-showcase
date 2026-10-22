// T-4V03: background anchor backfill.
//
// Seeded (and freshly uploaded) documents get a proofId immediately, but the
// TWIN node signs + indexes the on-chain proof ASYNCHRONOUSLY. On a slow
// testnet this routinely exceeds the seed's wait window (observed up to
// ~220 s), so the doc lands in seed-state.json with a proofId but no
// proofExplorerUrl/receipt. NotarizationBadge then shows "Writing to ledger"
// FOREVER, because nothing re-polls after boot — only a manual per-doc
// "Verify on ledger" click would backfill it.
//
// This poller re-fetches the proof for every locally-anchored pending doc
// until the explorer link / receipt lands, then updates the in-memory store
// and refreshes connected clients — turning "Writing to ledger" into
// "On ledger" automatically, no user action. By the time the demo server
// boots, the testnet has usually finished signing, so most pending docs
// resolve on the first pass.
import { store, wsRefs, NODE_ID, NODE_NAME } from './store.js';
import { explorerUrlFromImmutableProof, extractImmutableReceipt } from './utils.js';

const POLL_INTERVAL_MS = 15_000;
const MAX_DURATION_MS = 20 * 60_000; // stop after 20 min — a proof still
                                     // missing by then won't resolve by polling.

// Locally-anchored, has a proof, but the on-chain link hasn't landed yet.
// Skips simulated docs (no real proof) and peer-anchored docs (verified via
// the cross-node path, not this node's getImmutableProof).
function isPending(doc) {
  return !!doc.proofId
    && !doc.proofExplorerUrl
    && !!doc.notarizationMode && doc.notarizationMode !== 'simulated'
    && !(doc.notarizationNode && doc.notarizationNode !== NODE_ID);
}

export function startAnchorBackfill() {
  if (!store.adapter || store.adapter.mode === 'simulated') return;
  if (!store.documents.some(isPending)) return;

  const deadline = Date.now() + MAX_DURATION_MS;
  let timer = null;

  const tick = async () => {
    const pending = store.documents.filter(isPending);
    if (pending.length === 0 || Date.now() > deadline) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    let updated = 0;
    for (const doc of pending) {
      try {
        const proof = await store.adapter.getImmutableProof(doc.proofId);
        const url = explorerUrlFromImmutableProof(proof);
        const r = extractImmutableReceipt(proof);
        if (url || r?.verifiableStorageId) {
          if (url) doc.proofExplorerUrl = url;
          if (r) doc.receipt = r;
          updated++;
        }
      } catch { /* transient (node busy / not yet signed) — retry next tick */ }
    }
    if (updated > 0) {
      console.log(`[${NODE_NAME}] anchor-backfill: ${updated} document(s) now on ledger`);
      wsRefs.broadcastToClients({ type: 'DATA_SYNC' });
    }
  };

  const remaining = store.documents.filter(isPending).length;
  console.log(`[${NODE_NAME}] anchor-backfill: ${remaining} document(s) pending anchor — polling every ${POLL_INTERVAL_MS / 1000}s`);
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  tick().catch(() => {}); // first pass immediately
}
