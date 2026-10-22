import { describe, it, expect, beforeEach } from 'vitest';
import { resetStore } from '../helpers/setup.js';
import { dossierState, simulateChannel, CHANNEL_BASE_RATES } from '../../server/routes/customs.js';
import { store } from '../../server/store.js';

// T-418 — direct unit tests for the pure channel-simulation logic (the A2
// "verified data sharpens the risk engine, never criticizes it" rule). These
// are exercised via the endpoints in customs.test.js; here we pin the decision
// table at the function level so a refactor can't silently change the framing.

beforeEach(() => { resetStore(); });

const base = {
  id: 'c1', ucr: 'VN-1', customs: { channel: 'yellow' },
};

describe('CHANNEL_BASE_RATES', () => {
  it('are the published H1-2024 channeling rates', () => {
    expect(CHANNEL_BASE_RATES).toEqual({ green: 66.0, yellow: 30.3, red: 3.4 });
  });
});

describe('dossierState', () => {
  it('falls back to the seeded customs.dossierVerified flag when no docs carry live proofs', () => {
    const c = { ...base, customs: { ...base.customs, dossierVerified: true } };
    const st = dossierState(c);
    expect(st.dossierVerified).toBe(true);
    expect(st.liveVerified).toBe(false); // no required docs with proofId in the store
  });
});

describe('simulateChannel', () => {
  it('a verified dossier with no problems would earn GREEN (and flags the improvement on a yellow)', () => {
    const c = { ...base, customs: { channel: 'yellow', dossierVerified: true } };
    const sim = simulateChannel(c, dossierState(c));
    expect(sim.simulatedChannel).toBe('green');
    expect(sim.wouldImproveIfVerified).toBe(true);
  });

  it('a data inconsistency (errorType) does NOT improve with verification — provenance proves integrity, not content', () => {
    const c = { ...base, errorType: 'HS Code Mismatch', customs: { channel: 'yellow', dossierVerified: true } };
    const sim = simulateChannel(c, dossierState(c));
    expect(sim.simulatedChannel).toBe('yellow');
    expect(sim.wouldImproveIfVerified).toBe(false);
  });

  it('an origin-evidence gap does NOT improve with verification', () => {
    const c = { ...base, customs: { channel: 'red', dossierVerified: true }, originComposition: { evidenceIncomplete: true } };
    const sim = simulateChannel(c, dossierState(c));
    expect(sim.simulatedChannel).toBe('red');
    expect(sim.wouldImproveIfVerified).toBe(false);
  });

  it('an unverified dossier keeps its seeded channel but is flagged as improvable', () => {
    const c = { ...base, customs: { channel: 'yellow', dossierVerified: false } };
    const sim = simulateChannel(c, dossierState(c));
    expect(sim.simulatedChannel).toBe('yellow');
    expect(sim.wouldImproveIfVerified).toBe(true);
  });

  it('an already-green verified dossier stays green and is not flagged as improvable', () => {
    const c = { ...base, customs: { channel: 'green', dossierVerified: true } };
    const sim = simulateChannel(c, dossierState(c));
    expect(sim.simulatedChannel).toBe('green');
    expect(sim.wouldImproveIfVerified).toBe(false);
  });
});
