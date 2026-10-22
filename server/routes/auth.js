import { Router } from 'express';
import { store, NODE_ID, NODE_NAME, NODE_IP } from '../store.js';
import { issueSession, clearSession } from '../middleware/session.js';

const router = Router();

router.post('/api/login', (req, res) => {
  const org = store.orgs.find(o => o.username === req.body.username && o.password === req.body.password);
  if (!org) return res.status(401).json({ error: 'Invalid credentials' });
  // T-410: issue the httpOnly session cookie that gates state-mutating routes.
  // Same-origin requests (the demo, incl. via the proxy) send it automatically.
  issueSession(res, org);
  // Never expose: password (user login) or twinCredentials (per-org TWIN
  // service-account credentials kept server-side for signing).
  res.json({ org: { ...org, password: undefined, twinCredentials: undefined }, nodeId: NODE_ID, nodeName: NODE_NAME, nodeIp: NODE_IP });
});

router.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

export default router;
