import { describe, it, expect, beforeEach } from 'vitest';
import { resetStore } from '../helpers/setup.js';
import { store, NODE_ID } from '../../server/store.js';
import { liveVerifyDoc } from '../../server/lib/verification.js';

// Covers the cross-node routing of liveVerifyDoc (the fix that lets the public
// verify page / API verify a proof anchored on a DIFFERENT node — e.g. beta
// opening an alpha-anchored doc). The test harness adapter is simulated, whose
// verifyCrossNodeProof reports "unavailable", so we assert the ROUTING:
// same-node → verifyImmutableProof; cross-node → verifyCrossNodeProof.
beforeEach(() => { resetStore(); });

describe('liveVerifyDoc', () => {
  it('returns {verified:null} when the doc has no proof', async () => {
    expect(await liveVerifyDoc({ id: 'd', proofId: null })).toEqual({ verified: null, error: null });
  });

  it('takes the SAME-node path for a locally-anchored proof', async () => {
    let called = null;
    store.adapter = { verifyImmutableProof: async () => { called = 'same'; return true; }, verifyCrossNodeProof: async () => { called = 'cross'; return { verified: false }; } };
    const r = await liveVerifyDoc({ id: 'd', proofId: 'p1', notarizationNode: NODE_ID });
    expect(called).toBe('same');
    expect(r.verified).toBe(true);
  });

  it('takes the CROSS-node path when the proof was anchored elsewhere', async () => {
    let called = null;
    store.adapter = { verifyImmutableProof: async () => { called = 'same'; return true; }, verifyCrossNodeProof: async () => { called = 'cross'; return { verified: true, source: 'iota-testnet' }; } };
    const r = await liveVerifyDoc({ id: 'd', proofId: 'p1', notarizationNode: 'some-other-node', receipt: { objectId: '0xABC' } });
    expect(called).toBe('cross');
    expect(r.verified).toBe(true);
  });

  it('cross-node unavailable → verified null, adapter detail sanitized (T-425)', async () => {
    store.adapter = { verifyCrossNodeProof: async () => ({ verified: false, detail: 'no chain' }) };
    const r = await liveVerifyDoc({ id: 'd', proofId: 'p1', notarizationNode: 'other' });
    // T-425: the raw adapter detail must never leak to public callers; it is
    // logged server-side and reported as a single safe, generic message.
    expect(r).toEqual({ verified: null, error: 'Live check unavailable' });
  });
});
