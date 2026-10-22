import React, { useState, useRef, useEffect } from 'react';
import { Bell, Check, ArrowRight, Network } from 'lucide-react';
import { useNode } from '../context/NodeContext';

// T-325: persistent inbound-share notification bell + inbox dropdown.
// Layer 2 of the notification model (the transient toast is Layer 1). The list
// is server-backed (rehydrated on load), so a notification survives reloads
// until the operator acknowledges it. UX spec:
// docs/ux/cross-node-share-notification-spec.md
function relTime(ts) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(ts).toLocaleDateString();
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function NotificationBell({ onView }) {
  const { notifications, ackNotification, ackAllNotifications } = useNode();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const count = notifications.length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const handleView = (n) => {
    setOpen(false);
    ackNotification(n.id);            // opening fulfils the notification
    onView?.({ id: n.consignmentId, ucr: n.ucr });
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="hdr-bell"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(o => !o)}
      >
        <Bell size={18} />
        {count > 0 && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, lineHeight: 1, color: '#fff',
            background: 'var(--accent, #FF7200)', borderRadius: 999,
          }}>{count > 9 ? '9+' : count}</span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Inbound shares" style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 360, maxWidth: '90vw',
          maxHeight: '70vh', overflowY: 'auto', zIndex: 50,
          background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, rgba(0,0,0,0.1))',
          borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid var(--card-border, rgba(0,0,0,0.08))',
          }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>Inbound shares</span>
            {count >= 2 && (
              <button onClick={ackAllNotifications} style={{
                fontSize: 11, fontWeight: 600, color: 'var(--accent, #FF7200)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}>Acknowledge all</button>
            )}
          </div>

          {count === 0 ? (
            <div style={{ padding: '20px 14px', fontSize: 12.5, color: 'var(--text-muted, #6b7280)', textAlign: 'center' }}>
              No new shares. Inbound consignments will appear here.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {notifications.map((n) => {
                const from = cap(n.fromNode);
                const docs = typeof n.docCount === 'number'
                  ? ` ${n.docCount} document${n.docCount === 1 ? '' : 's'} included.` : '';
                return (
                  <li key={n.id} style={{ padding: '11px 12px', borderBottom: '1px solid var(--card-border, rgba(0,0,0,0.06))' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <Network size={14} style={{ marginTop: 2, color: 'var(--accent, #FF7200)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                          Consignment {n.ucr} shared with you
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted, #6b7280)', marginTop: 2 }}>
                          {from ? `Node ${from} shared this consignment over the Dataspace Protocol.` : 'Shared over the Dataspace Protocol.'}{docs}
                        </div>
                        <div title={n.ts ? new Date(n.ts).toLocaleString() : ''} style={{ fontSize: 10.5, color: 'var(--text-muted, #9ca3af)', marginTop: 3 }}>
                          {relTime(n.ts)}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button className="btn btn-p" style={{ fontSize: 11, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => handleView(n)}>
                            View consignment <ArrowRight size={12} />
                          </button>
                          <button className="btn btn-s" style={{ fontSize: 11, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => ackNotification(n.id)}>
                            <Check size={12} /> Acknowledge
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
