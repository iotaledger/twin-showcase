import { WebSocketServer, WebSocket } from 'ws';
import { store, wsRefs, NODE_ID, NODE_NAME, NODE_IP, PEER_URL, PORT, addLog, addNotification } from './store.js';
import { consignmentToUnece } from './twin/unece.js';

// Node-authoritative cross-node: when a consignment is shared TO this node,
// replicate it onto THIS node's Auditable Item Graph so the recipient reads it
// from its own /api/consignments (node = source of truth), not just the
// in-memory copy. Idempotent at the call site (only on a consignment new to
// this node). Best-effort: the in-memory push already updated the UI.
async function replicateConsignmentToNode(consignment) {
  if (!consignment?.ucr || !store.adapter || store.adapter.mode === 'simulated' || typeof store.adapter.createAigVertex !== 'function') return;
  try {
    // Idempotency against the NODE (not just in-memory): the node persists
    // across demo restarts, so a re-share after a restart — where the
    // in-memory `isNewToNode` guard has been reset — must not create a second
    // vertex for the same UCR.
    if (typeof store.adapter.findConsignmentVertexIdByUcr === 'function') {
      const existing = await store.adapter.findConsignmentVertexIdByUcr(consignment.ucr);
      if (existing) return; // already federated to this node
    }
    const annotation = consignmentToUnece(consignment); // carries the demo flat blob + the original id
    await store.adapter.createAigVertex({ annotationObject: annotation, aliases: [{ id: consignment.ucr, aliasFormat: 'urn:moit:ucr' }] });
    addLog('network', 'Consignment Received', 'System', `${consignment.ucr} federated to this node and stored in its ledger (AIG).`);
  } catch (e) {
    console.warn(`[${NODE_NAME}] cross-node AIG replicate failed for ${consignment.ucr}: ${e.message}`);
  }
}

const clients = new Set();

function broadcastToClients(msg) {
  const d = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(d); });
}

function syncOrgsToPeer() {
  const w = [wsRefs.peerWs, wsRefs.peerInWs].find(w => w?.readyState === WebSocket.OPEN);
  if (w) w.send(JSON.stringify({ type: 'ORG_UPDATE', orgs: store.orgs.map(o => ({ id: o.id, name: o.name, role: o.role, did: o.did, verified: o.verified, nodeId: NODE_ID, nodeName: NODE_NAME })) }));
}

function connectToPeer() {
  if (!PEER_URL || wsRefs.peerWs?.readyState === WebSocket.OPEN || wsRefs.peerInWs?.readyState === WebSocket.OPEN) return;
  try {
    const ws = new WebSocket(PEER_URL + '/peer');
    wsRefs.peerWs = ws;
    ws.on('open', () => {
      store.peerConnected = true;
      ws.send(JSON.stringify({ type: 'HANDSHAKE', nodeId: NODE_ID, nodeName: NODE_NAME, nodeIp: NODE_IP, orgs: store.orgs.map(o => ({ id: o.id, name: o.name, role: o.role, did: o.did, verified: o.verified, nodeId: NODE_ID, nodeName: NODE_NAME })) }));
      addLog('network', 'Peer Connected', 'System', `P2P handshake completed with peer at ${PEER_URL}. Organisations now discoverable.`);
      broadcastToClients({ type: 'PEER_STATUS', connected: true });
    });
    ws.on('message', d => handlePeerMsg(JSON.parse(d.toString())));
    ws.on('close', () => { if (wsRefs.peerWs !== ws) return; store.peerConnected = false; store.peerOrgs = []; broadcastToClients({ type: 'PEER_STATUS', connected: false, peerOrgs: [] }); });
    ws.on('error', () => {});
  } catch (e) {}
}

function handlePeerIn(ws) {
  wsRefs.peerInWs = ws;
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.type === 'HANDSHAKE') {
      store.peerOrgs = m.orgs || [];
      store.peerConnected = true;
      broadcastToClients({ type: 'PEER_STATUS', connected: true, peerOrgs: store.peerOrgs });
      ws.send(JSON.stringify({ type: 'ORG_DIRECTORY', orgs: store.orgs.map(o => ({ id: o.id, name: o.name, role: o.role, did: o.did, verified: o.verified, nodeId: NODE_ID, nodeName: NODE_NAME })) }));
      addLog('network', 'Peer Connected', 'System', 'Inbound P2P connection accepted. Peer orgs now discoverable.');
    } else {
      handlePeerMsg(m);
    }
  });
  ws.on('close', () => { if (wsRefs.peerInWs !== ws) return; wsRefs.peerInWs = null; store.peerConnected = false; store.peerOrgs = []; broadcastToClients({ type: 'PEER_STATUS', connected: false, peerOrgs: [] }); });
}

function handlePeerMsg(m) {
  switch (m.type) {
    case 'HANDSHAKE': store.peerOrgs = m.orgs || []; store.peerConnected = true; broadcastToClients({ type: 'PEER_STATUS', connected: true, peerOrgs: store.peerOrgs }); break;
    case 'ORG_DIRECTORY': case 'ORG_UPDATE': store.peerOrgs = m.orgs || []; broadcastToClients({ type: 'PEER_ORGS', peerOrgs: store.peerOrgs }); break;
    case 'LEDGER_ENTRY': if (!store.ledgerLog.some(e => e.id === m.entry.id)) { store.ledgerLog.unshift(m.entry); broadcastToClients({ type: 'LEDGER_UPDATE', log: store.ledgerLog }); } break;
    case 'SHARE_CONSIGNMENT': {
      // T-311: the incoming consignment carries originNode (set by the
      // creator's POST /api/consignments). The push below preserves it
      // verbatim, so the receiver knows it holds a peer-owned copy.
      const { consignment, documents, permissions, docPermissions } = m;
      const isNewToNode = !store.consignments.some(c => c.id === consignment.id);
      if (isNewToNode) store.consignments.push(consignment);
      // Make the recipient node the source of truth for the shared consignment:
      // store it in this node's AIG so it's readable from this node's own API.
      if (isNewToNode) replicateConsignmentToNode(consignment);
      for (const doc of documents) { if (!store.documents.some(d => d.id === doc.id)) store.documents.push(doc); }
      if (permissions) store.permissions[consignment.id] = { ...store.permissions[consignment.id], ...permissions };
      if (docPermissions) { for (const [did, p] of Object.entries(docPermissions)) { store.docPermissions[did] = { ...store.docPermissions[did], ...p }; } }
      // T-325: a consignment was shared WITH this node — raise a persistent bell
      // notification. This peer message is the RELIABLE per-share signal: the DSP
      // poll only catches consignments NEW to this node's AIG, so a re-share of
      // one already present would never notify. addNotification dedups by
      // consignmentId, so the parallel DSP-poll path won't double-notify.
      if (consignment.originNode && consignment.originNode !== NODE_ID) {
        addNotification({
          kind: 'consignment-received',
          ucr: consignment.ucr ?? consignment.id,
          consignmentId: consignment.id,
          fromNode: consignment.originNode,
          docCount: Array.isArray(documents) ? documents.length : 0,
        });
      }
      broadcastToClients({ type: 'DATA_SYNC' }); break;
    }
    case 'UPLOAD_DOCUMENT': {
      // T-245: peer uploaded a doc on a consignment we previously shared
      // (or that was shared with us). Add to local store and refresh UI.
      // T-311: the document carries notarizationNode (set by the writer's
      // POST /api/documents). Preserved verbatim so verify/proof are gated
      // cross-node.
      const { consignmentId, document } = m;
      if (!document?.id) break;
      const existingDoc = store.documents.find(d => d.id === document.id);
      if (!existingDoc) {
        store.documents.push(document);
        const c = store.consignments.find(cs => cs.id === consignmentId);
        if (c) c.documentCount = store.documents.filter(d => d.consignmentId === consignmentId).length;
      } else {
        // T-312: a re-sent UPLOAD_DOCUMENT carries the proof fields the
        // writer backfilled after the proof anchored. `receipt.objectId` is
        // what verifyCrossNodeProof's IOTA on-chain fallback needs to verify
        // this peer-owned copy. Merge those fields without clobbering local state.
        if (document.receipt) existingDoc.receipt = document.receipt;
        if (document.proofExplorerUrl) existingDoc.proofExplorerUrl = document.proofExplorerUrl;
        if (document.proofVerified) existingDoc.proofVerified = document.proofVerified;
      }
      broadcastToClients({ type: 'DATA_SYNC' }); break;
    }
    case 'REVOKE_CONSIGNMENT': {
      const { consignmentId } = m;
      const docs = store.documents.filter(d => d.consignmentId === consignmentId);
      store.consignments = store.consignments.filter(c => c.id !== consignmentId);
      store.documents = store.documents.filter(d => d.consignmentId !== consignmentId);
      delete store.permissions[consignmentId];
      docs.forEach(d => delete store.docPermissions[d.id]);
      delete store.financePermissions[consignmentId];
      broadcastToClients({ type: 'DATA_SYNC' }); break;
    }
  }
}

// ── T-324: DSP-native recipient ingestion ───────────────────────────────────
// In docker / hosted mode a consignment shared Alpha->Beta is delivered over the
// Dataspace Protocol: the sender's notify hits the recipient node's
// CorridorDataspaceApp.handleActivity, which writes the consignment into THIS
// node's Auditable Item Graph (see twin/dataspace-app.mjs). The node and the
// demo server are separate processes, so the demo server polls its node for
// newly ingested consignments and surfaces them to the browser via DATA_SYNC —
// no WebSocket peer channel needed for the file exchange.
//
// This poll currently runs ALONGSIDE the WS SHARE_CONSIGNMENT path (dedup by
// id/UCR makes them safe to coexist: whichever lands first wins, the other
// skips). Once DSP delivery is confirmed sole-sufficient, the WS ingestion is
// gated to `simulated` and this becomes the only recipient path in docker.
let recipientPollTimer = null;

async function pollInboundShares() {
  if (!store.adapter || store.adapter.mode === 'simulated' || typeof store.adapter.listConsignments !== 'function') return;
  try {
    const nodeConsignments = await store.adapter.listConsignments();
    let added = 0;
    for (const c of nodeConsignments ?? []) {
      if (!c?.id && !c?.ucr) continue;
      const exists = store.consignments.some(x => x.id === c.id || (c.ucr && x.ucr === c.ucr));
      if (exists) continue;
      // "Foreign" = created on another node and delivered here over DSP (vs this
      // node's own consignments the poll also surfaces on first read). Only a
      // foreign arrival is a "received" event worth a ledger entry + a toast.
      const isForeign = c.originNode && c.originNode !== NODE_ID;
      store.consignments.push(c);
      added++;
      if (isForeign) {
        addLog('network', 'Consignment Received', 'System', `${c.ucr ?? c.id} received from ${c.originNode} via the Dataspace Protocol and stored on this node's ledger (AIG).`);
        // Persistent bell notification (acknowledged from the UI). addNotification
        // broadcasts CONSIGNMENT_RECEIVED with the full payload.
        const docCount = typeof c.documentCount === 'number'
          ? c.documentCount
          : store.documents.filter(d => d.consignmentId === c.id).length;
        addNotification({
          kind: 'consignment-received',
          ucr: c.ucr ?? c.id,
          consignmentId: c.id,
          fromNode: c.originNode,
          docCount,
        });
      }
    }
    if (added > 0) broadcastToClients({ type: 'DATA_SYNC' });
  } catch {
    // best-effort: the node may be briefly unreachable; next tick retries.
  }
}

export function startRecipientPoll(intervalMs = 5000) {
  if (recipientPollTimer || !store.adapter || store.adapter.mode === 'simulated') return;
  recipientPollTimer = setInterval(() => { pollInboundShares().catch(() => {}); }, intervalMs);
  if (typeof recipientPollTimer.unref === 'function') recipientPollTimer.unref();
}

/**
 * Attach WebSocket server to the HTTP server and wire up wsRefs.
 */
export function setupWebSocket(httpServer) {
  // Wire refs so route modules can access WS functions
  wsRefs.broadcastToClients = broadcastToClients;
  wsRefs.connectToPeer = connectToPeer;
  wsRefs.syncOrgsToPeer = syncOrgsToPeer;

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/peer') {
      handlePeerIn(ws);
    } else {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'NODE_INFO', nodeId: NODE_ID, nodeName: NODE_NAME }));
    }
  });

  // T-324: start the DSP-native recipient ingestion poll (docker / hosted only;
  // no-op in simulated). Surfaces consignments delivered to this node over DSP.
  startRecipientPoll();
}
