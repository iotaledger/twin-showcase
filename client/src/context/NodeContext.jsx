import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';
import { toastBridge } from '../components/Toast';

const Ctx = createContext();

export function NodeProvider({ children }) {
  const [user, setUser] = useState(null);
  const [nodeInfo, setNodeInfo] = useState(null);
  const [peerConnected, setPeerConnected] = useState(false);
  const [peerOrgs, setPeerOrgs] = useState([]);
  const [ledgerLog, setLedgerLog] = useState([]);
  const [notifications, setNotifications] = useState([]); // T-325: inbound-share bell inbox (unacked)
  const [refreshKey, setRefreshKey] = useState(0);
  const wsRef = useRef(null);

  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password);
    setUser(data.org);
    setNodeInfo({ nodeId: data.nodeId, nodeName: data.nodeName, nodeIp: data.nodeIp });
    return data;
  }, []);
  const logout = useCallback(() => {
    api.logout().catch(() => {}); // clear the httpOnly session cookie (best-effort)
    setUser(null); setNodeInfo(null); setPeerConnected(false); setPeerOrgs([]);
  }, []);

  useEffect(() => {
    if (!user) return;
    // Derive WebSocket URL from the page origin so tunnels (ngrok, cloudflared etc.) work.
    // Locally: ws://localhost:4000 or ws://localhost:4001
    // Via tunnel: wss://abc.trycloudflare.com (same host, same port, upgraded to WS)
    // On Vercel (serverless): WebSocket is unavailable — polling fallback handles updates.
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname;
    const wsPort = window.location.port ? `:${window.location.port}` : '';
    let ws;
    try {
      ws = new WebSocket(`${wsProtocol}//${wsHost}${wsPort}`);
      wsRef.current = ws;
      ws.onerror = () => {}; // silently fall back to polling
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'PEER_STATUS') { setPeerConnected(msg.connected); if (msg.peerOrgs) setPeerOrgs(msg.peerOrgs); if (!msg.connected) setPeerOrgs([]); }
        else if (msg.type === 'PEER_ORGS') setPeerOrgs(msg.peerOrgs);
        else if (msg.type === 'LEDGER_UPDATE') setLedgerLog(msg.log);
        else if (msg.type === 'CONSIGNMENT_RECEIVED') {
          // T-324/T-325: a consignment was delivered to THIS node over the
          // Dataspace Protocol (not created here). Two layers: a transient toast
          // (peek) + a persistent bell notification (acknowledged from the UI).
          const n = msg.notification;
          if (n) {
            setNotifications(prev => prev.some(x => x.id === n.id) ? prev : [n, ...prev]);
            const from = n.fromNode ? n.fromNode.charAt(0).toUpperCase() + n.fromNode.slice(1) : null;
            const docs = typeof n.docCount === 'number' ? ` ${n.docCount} document${n.docCount === 1 ? '' : 's'}.` : '';
            toastBridge.show({
              variant: 'success',
              title: 'Consignment shared with you',
              body: `${n.ucr ?? 'A consignment'}${from ? ` from Node ${from}` : ''}.${docs}`,
            });
          }
          refresh();
        }
        else if (msg.type === 'NOTIFICATIONS_CHANGED') {
          api.getNotifications().then(setNotifications).catch(() => {});
        }
        else if (msg.type === 'DATA_SYNC') refresh();
      };
    } catch (e) { /* serverless — polling only */ }
    api.getLedger().then(setLedgerLog).catch(() => {});
    api.getNotifications().then(setNotifications).catch(() => {}); // rehydrate the bell on load / reconnect
    api.getNode().then(info => { setPeerConnected(info.peerConnected); setNodeInfo(prev => ({ ...prev, ...info })); }).catch(() => {});
    return () => ws?.close();
  }, [user, refresh]);

  // Poll peer status
  useEffect(() => {
    if (!user) return;
    const iv = setInterval(() => {
      api.getNode().then(i => setPeerConnected(i.peerConnected)).catch(() => {});
      api.searchPeerOrgs('').then(setPeerOrgs).catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [user]);

  // Re-fetch the logged-in org whenever refreshKey bumps, so the user
  // object stays in sync with server-side changes (e.g. DID registration
  // adds did/verified/explorerUrl). Without this the upload gate would
  // keep showing "no DID" after a successful Register DID.
  useEffect(() => {
    if (!user) return;
    api.getOrgs().then(list => {
      const me = list.find(o => o.id === user.id);
      if (me) setUser(prev => ({ ...prev, ...me }));
    }).catch(() => {});
  }, [refreshKey, user?.id]);

  // Pending-anchor poller: when a doc is uploaded in docker/hosted mode but
  // its on-chain reference (`proofExplorerUrl`) isn't yet populated, TWIN is
  // still finalising the signing asynchronously (~5-15s). We poll
  // `POST /api/documents/:id/verify` every 4s for each pending doc, fire a
  // toast when the URL appears, and give up after 2 minutes.
  const pendingAnchorsRef = useRef(new Map()); // docId -> { title, startedAt }
  const [pendingTick, setPendingTick] = useState(0); // bumps to trigger the poller effect

  const trackPendingAnchor = useCallback((docId, title) => {
    if (!docId) return;
    pendingAnchorsRef.current.set(docId, { title: title ?? docId, startedAt: Date.now() });
    setPendingTick(t => t + 1);
  }, []);

  useEffect(() => {
    if (pendingAnchorsRef.current.size === 0) return;
    let cancelled = false;
    const tick = async () => {
      const now = Date.now();
      const entries = Array.from(pendingAnchorsRef.current.entries());
      for (const [docId, meta] of entries) {
        if (cancelled) return;
        if (now - meta.startedAt > 120_000) {
          pendingAnchorsRef.current.delete(docId);
          toastBridge.show({
            variant: 'warning',
            title: 'Anchor still pending',
            body: `'${truncate(meta.title, 30)}' hasn't been finalised on testnet yet. Open the doc and click Verify to check again.`,
          });
          continue;
        }
        try {
          const result = await api.verifyDocument(docId);
          if (result?.proofExplorerUrl) {
            pendingAnchorsRef.current.delete(docId);
            toastBridge.show({
              variant: 'success',
              title: 'Anchor ready on IOTA',
              body: `'${truncate(meta.title, 30)}' is now verifiable on the public ledger.`,
              action: { label: 'View on Explorer', href: result.proofExplorerUrl },
            });
            refresh();
          }
        } catch { /* keep polling */ }
      }
      if (!cancelled && pendingAnchorsRef.current.size > 0) {
        setTimeout(() => { if (!cancelled) setPendingTick(t => t + 1); }, 4000);
      }
    };
    tick();
    return () => { cancelled = true; };
  }, [pendingTick, refresh]);

  // T-325: acknowledge a bell notification (optimistic; server is the source of truth).
  const ackNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    api.ackNotification(id).catch(() => {});
  }, []);
  const ackAllNotifications = useCallback(() => {
    setNotifications([]);
    api.ackAllNotifications().catch(() => {});
  }, []);

  return (
    <Ctx.Provider value={{ user, nodeInfo, peerConnected, peerOrgs, ledgerLog, notifications, ackNotification, ackAllNotifications, refreshKey, login, logout, refresh, trackPendingAnchor }}>
      {children}
    </Ctx.Provider>
  );
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function useNode() { return useContext(Ctx); }
