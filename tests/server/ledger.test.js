import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

const app = createApp();

describe('GET /api/ledger', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('returns ledger log entries', async () => {
    const res = await request(app).get('/api/ledger');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('type');
    expect(res.body[0]).toHaveProperty('action');
    expect(res.body[0]).toHaveProperty('timestamp');
  });

  it('T-303: simulated mode returns in-memory ledger (no AIS round-trip)', async () => {
    // store.adapter.mode === 'simulated' in tests; /api/ledger should
    // serve store.ledgerLog directly without calling listAisEntries().
    const inMemory = store.ledgerLog.length;
    const res = await request(app).get('/api/ledger');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(inMemory);
  });
});

describe('T-303: AIS helpers', () => {
  it('aisEntryToLedger round-trips an AIS entry to the demo ledger shape', async () => {
    const { aisEntryToLedger } = await import('../../server/store.js');
    const ais = {
      id: 'entry:0xabc',
      dateCreated: '2026-05-27T10:00:00Z',
      entryObject: {
        '@context': 'https://schema.org',
        '@type': 'Event',
        ledgerType: 'document',
        action: 'Document Anchored',
        actor: 'Lotus Bay Apparel',
        details: 'Anchored doc on UCR-X',
        timestamp: '2026-05-27T10:00:00Z',
        ledgerHash: '0xdeadbeef',
        additionalProperty: { proofId: 'p1', aigVertexId: 'v1' },
      },
    };
    expect(aisEntryToLedger(ais)).toEqual({
      id: 'entry:0xabc',
      timestamp: '2026-05-27T10:00:00Z',
      hash: '0xdeadbeef',
      type: 'document',
      action: 'Document Anchored',
      actor: 'Lotus Bay Apparel',
      details: 'Anchored doc on UCR-X',
      proofId: 'p1',
      aigVertexId: 'v1',
      aisEntryId: 'entry:0xabc',
    });
  });

  it('aisEntryToLedger returns null for a malformed entry', async () => {
    const { aisEntryToLedger } = await import('../../server/store.js');
    expect(aisEntryToLedger(null)).toBeNull();
    expect(aisEntryToLedger({})).toBeNull();
    expect(aisEntryToLedger({ id: 'x' })).toBeNull();
  });

  it('hydrateLedgerFromAis is a no-op in simulated mode', async () => {
    const { hydrateLedgerFromAis } = await import('../../server/store.js');
    const before = store.ledgerLog.length;
    const added = await hydrateLedgerFromAis();
    expect(added).toBe(0);
    expect(store.ledgerLog.length).toBe(before);
  });
});

describe('GET /api/peer/orgs', () => {
  it('returns empty when not connected', async () => {
    store.peerConnected = false;
    const res = await request(app).get('/api/peer/orgs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns peer orgs when connected', async () => {
    store.peerConnected = true;
    store.peerOrgs = [{ id: 'peer1', name: 'Peer Org', role: 'Test' }];
    const res = await request(app).get('/api/peer/orgs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Peer Org');
    // Cleanup
    store.peerConnected = false;
    store.peerOrgs = [];
  });

  it('filters peer orgs by query', async () => {
    store.peerConnected = true;
    store.peerOrgs = [
      { id: 'p1', name: 'Alpha Corp', role: 'Test' },
      { id: 'p2', name: 'Beta Inc', role: 'Test' },
    ];
    const res = await request(app).get('/api/peer/orgs?q=alpha');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Alpha Corp');
    store.peerConnected = false;
    store.peerOrgs = [];
  });
});
