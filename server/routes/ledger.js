import { Router } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { store, aisEntryToLedger } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

const router = Router();

// T-303: ledger comes from AIS in docker/hosted mode (authoritative,
// durable, signed) with the in-memory cache as fallback for the rare
// case where the TWIN node is unreachable. Simulated mode returns the
// in-memory ledger directly.
router.get('/api/ledger', async (req, res) => {
  if (!store.adapter || store.adapter.mode === 'simulated') {
    return res.json(store.ledgerLog);
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const result = await store.adapter.listAisEntries(undefined, { limit });
    const entries = (result?.entries ?? []).map(aisEntryToLedger).filter(Boolean);
    entries.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    res.json(entries);
  } catch (e) {
    console.warn(`/api/ledger AIS read failed (${e.message}); falling back to in-memory cache.`);
    res.json(store.ledgerLog);
  }
});

router.get('/api/peer/orgs', (req, res) => {
  if (!store.peerConnected) return res.json([]);
  let orgs = store.peerOrgs;
  if (req.query.q) orgs = orgs.filter(o => o.name.toLowerCase().includes(req.query.q.toLowerCase()));
  res.json(orgs);
});

// SPA fallback
router.get('*', (req, res) => {
  const f = path.join(publicDir, 'index.html');
  existsSync(f) ? res.sendFile(f) : res.status(404).json({ error: 'Build first' });
});

export default router;
