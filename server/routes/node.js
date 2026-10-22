import { Router } from 'express';
import { store, NODE_ID, NODE_NAME, NODE_IP, WS_PORT, PEER_URL, addLog, wsRefs } from '../store.js';

const router = Router();

router.get('/api/node', (req, res) => {
  const adapter = store.adapter;
  let adapterInfo = null;
  if (adapter) {
    const status = adapter.authStatus();
    adapterInfo = {
      mode: adapter.mode,
      ready: adapter.isReady(),
      nodeUrl: adapter.nodeUrl ?? null,
      authenticated: status.authenticated,
      expiresInSeconds: status.expiresInSeconds,
      subjectDid: status.subjectDid,
    };
  }
  res.json({
    nodeId: NODE_ID,
    nodeName: NODE_NAME,
    nodeIp: NODE_IP,
    wsPort: WS_PORT,
    peerConnected: store.peerConnected,
    orgCount: store.orgs.length,
    peerOrgCount: store.peerOrgs.length,
    adapter: adapterInfo,
  });
});

router.get('/api/node/discover', (req, res) => {
  if (!PEER_URL) return res.json([]);
  const peerWsPort = parseInt(PEER_URL.match(/:(\d+)/)?.[1] || '0');
  const peerHttpPort = peerWsPort - 10;
  res.json([{ id: NODE_ID === 'alpha' ? 'beta' : 'alpha', name: NODE_ID === 'alpha' ? 'Node Beta' : 'Node Alpha', ip: `127.0.0.1:${peerHttpPort}`, wsUrl: PEER_URL, connected: store.peerConnected }]);
});

router.post('/api/node/connect', (req, res) => {
  if (store.peerConnected) return res.json({ success: true, message: 'Already connected' });
  wsRefs.connectToPeer();
  setTimeout(() => res.json({ success: store.peerConnected, message: store.peerConnected ? 'Connected \u2014 organisations now discoverable' : 'Connection attempt sent. Peer may not be online yet.' }), 2500);
});

router.post('/api/node/disconnect', (req, res) => {
  if (wsRefs.peerWs) { const old = wsRefs.peerWs; wsRefs.peerWs = null; old.close(); }
  if (wsRefs.peerInWs) { const old = wsRefs.peerInWs; wsRefs.peerInWs = null; old.close(); }
  store.peerConnected = false; store.peerOrgs = [];
  wsRefs.broadcastToClients({ type: 'PEER_STATUS', connected: false, peerOrgs: [] });
  addLog('network', 'Peer Disconnected', 'System', 'P2P connection terminated. Peer organisations no longer visible.');
  res.json({ success: true });
});

export default router;
