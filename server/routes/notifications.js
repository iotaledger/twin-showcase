import { Router } from 'express';
import { store, wsRefs, NODE_NAME } from '../store.js';

// T-325: persistent inbound-share notifications (the header bell inbox). The
// list lives server-side (store.notifications) so it survives a client reload /
// WS reconnect; the WS CONSIGNMENT_RECEIVED push is the real-time channel, this
// GET is rehydration on load. Acknowledge removes a notification from the
// unacked set (the bell badge), per the UX spec.
const router = Router();

// GET unacked by default; ?all=true returns the full history.
router.get('/api/notifications', (req, res) => {
  const all = req.query.all === 'true';
  res.json(store.notifications.filter(n => all || !n.acked));
});

router.post('/api/notifications/:id/ack', (req, res) => {
  const n = store.notifications.find(x => x.id === req.params.id);
  if (n) n.acked = true;
  wsRefs.broadcastToClients?.({ type: 'NOTIFICATIONS_CHANGED' });
  res.json({ ok: Boolean(n) });
});

router.post('/api/notifications/ack-all', (_req, res) => {
  let acked = 0;
  for (const n of store.notifications) { if (!n.acked) { n.acked = true; acked++; } }
  wsRefs.broadcastToClients?.({ type: 'NOTIFICATIONS_CHANGED' });
  res.json({ ok: true, acked, node: NODE_NAME });
});

export default router;
