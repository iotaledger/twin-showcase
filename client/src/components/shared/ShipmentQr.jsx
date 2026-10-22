import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { QrCode, Printer, Info, ExternalLink } from 'lucide-react';
import { buildClientShipmentUrl } from '../../utils/qr';
import Modal from './Modal';

// T-4V04 — shipment-level QR, modeled on VerifyQr (T-4V03) one scope up:
// scanning it opens the public read-only border view of ONE consignment.
// Shown wherever a viewer already has the consignment in scope (consignment
// detail, Customs Desk detail, dashboard) — gated only by the existing
// permission/canSee check (decision 4: anyone with access may mint; export
// customs is the expected primary user).
// The URL builder + UTF-8-safe encoder live in utils/qr.js (shared with VerifyQr).

export default function ShipmentQr({ consignment: c, nodeId }) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState(null);
  const url = buildClientShipmentUrl(c, nodeId);
  const passUrl = `${window.location.origin}/api/public/shipment/${encodeURIComponent(c.id)}/pass?node=${nodeId}`;

  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [open, url]);

  return (
    <>
      <button className="btn btn-s btn-sm" title="Show shipment QR — scan to open the full shipment dossier (public, no account needed)" onClick={() => setOpen(true)}>
        <QrCode style={{ width: 11, height: 11 }} /> Shipment QR
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Scan for shipment dossier" showClose width={420}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            UCR {c.ucr}{c.fromCountry && c.toCountry ? ` — ${c.fromCountry} → ${c.toCountry}` : ''}. Any phone camera opens the public shipment view. No account required.
          </div>
          {dataUrl
            ? <img src={dataUrl} alt={`Shipment dossier QR for UCR ${c.ucr}`} style={{ width: 280, height: 280, imageRendering: 'pixelated' }} />
            : <div className="empty">Generating…</div>}
          {/* Clickable: opens the same public shipment dossier the QR resolves
              to (full URL incl. the offline fragment payload) in a new tab —
              for opening the record without a phone. */}
          <a href={url} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--accent, #2563eb)', marginTop: 8, wordBreak: 'break-all', fontFamily: 'var(--mono)', textDecoration: 'underline' }}>
            <ExternalLink style={{ width: 12, height: 12, flexShrink: 0 }} />
            {url.split('#')[0]}
          </a>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
            <a href={passUrl} target="_blank" rel="noreferrer" className="btn btn-p btn-sm" style={{ textDecoration: 'none' }}>
              <Printer style={{ width: 12, height: 12 }} /> Print transport pass
            </a>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 12, padding: '8px 10px', background: '#f8fafc', border: '1px solid var(--card-border)', borderRadius: 8, textAlign: 'left' }}>
            <Info style={{ width: 13, height: 13, color: 'var(--text-muted)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              This link is a <strong>bearer capability</strong>: anyone holding it sees this shipment's curated dossier (no finance, no other shipments). In production it can be made time-boxed and revocable.
            </span>
          </div>
        </div>
      </Modal>
    </>
  );
}
