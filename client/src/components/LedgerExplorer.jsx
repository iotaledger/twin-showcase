import React, { useState } from 'react';
import { useNode } from '../context/NodeContext';
import { Activity, Fingerprint, FileText, Shield, Wifi, Database } from 'lucide-react';

const ICONS = { identity: Fingerprint, document: FileText, permission: Shield, network: Wifi };
const COLORS = {
  identity: { bg: '#fefce8', border: '#f59e0b', text: '#a16207' },
  document: { bg: '#f0fdf4', border: '#22c55e', text: '#166534' },
  permission: { bg: '#eff6ff', border: '#3b82f6', text: '#1e40af' },
  network: { bg: '#f8fafc', border: '#94a3b8', text: '#475569' },
};

export default function LedgerExplorer() {
  const { ledgerLog } = useNode();
  const [filter, setFilter] = useState('all');

  const filtered = filter === 'all' ? ledgerLog : ledgerLog.filter(e => e.type === filter);
  const counts = {
    all: ledgerLog.length,
    identity: ledgerLog.filter(e => e.type === 'identity').length,
    document: ledgerLog.filter(e => e.type === 'document').length,
    permission: ledgerLog.filter(e => e.type === 'permission').length,
    network: ledgerLog.filter(e => e.type === 'network').length,
  };

  const filterButtons = [
    { k: 'all', l: 'All Events', I: Database },
    { k: 'identity', l: 'Identity', I: Fingerprint },
    { k: 'document', l: 'Documents', I: FileText },
    { k: 'permission', l: 'Permissions', I: Shield },
    { k: 'network', l: 'Network', I: Wifi },
  ];

  return (
    <div className="stack">
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Analytics</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>IOTA Mainnet — all events are cryptographically anchored</div>
      </div>

      {/* Stat cards */}
      <div className="analytics-filters">
        {filterButtons.map(f => (
          <div
            key={f.k}
            className="stat-card"
            onClick={() => setFilter(f.k)}
            style={{ cursor: 'pointer', border: filter === f.k ? '2px solid var(--nav-bg)' : '1px solid var(--card-border)', padding: '16px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <f.I style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)' }}>{f.l}</span>
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: filter === f.k ? 'var(--nav-bg)' : 'var(--text-primary)' }}>{counts[f.k]}</div>
          </div>
        ))}
      </div>

      {/* Ledger */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Activity style={{ width: 16, height: 16, color: 'var(--amber)' }} />
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Immutable Ledger</h3>
          <span className="pill pill-g" style={{ marginLeft: 4 }}>{filtered.length} records</span>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {filtered.length === 0 ? (
            <div className="empty">No events yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filtered.map((e, i) => {
                const c = COLORS[e.type] || COLORS.network;
                const Icon = ICONS[e.type] || Database;
                return (
                  <div key={e.id} style={{ display: 'flex', gap: 12, padding: '11px 14px', background: c.bg, borderLeft: `3px solid ${c.border}`, borderRadius: '0 8px 8px 0', opacity: 0, animation: `fadeIn .2s ${i * 0.015}s forwards` }}>
                    <div style={{ minWidth: 70 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#94a3b8' }}>{new Date(e.timestamp).toLocaleTimeString()}</div>
                      <Icon style={{ width: 14, height: 14, color: c.border, marginTop: 5 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                        <span style={{ fontSize: 9, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', color: c.text }}>{e.type}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{e.action}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{e.details}</div>
                      {e.did && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#16a34a', marginTop: 3 }}>DID: {e.did}</div>}
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
                        Hash: {e.hash?.slice(0, 20)}... · Actor: {e.actor}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
