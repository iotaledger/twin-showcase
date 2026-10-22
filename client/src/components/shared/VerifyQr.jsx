import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { QrCode, ExternalLink } from 'lucide-react';
import { buildClientVerifyUrl } from '../../utils/qr';
import Modal from './Modal';

// T-4V03 (WP4) — on-screen verification QR. Generated PDFs already carry the
// QR printed in the page; this modal renders the same URL big enough to scan
// straight off a projector, and covers uploaded documents whose binary we
// cannot modify ("print verification slip" = print this modal).
// The URL builder + UTF-8-safe encoder live in utils/qr.js (shared with ShipmentQr).

export default function VerifyQr({ doc, nodeId }) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState(null);
  const url = buildClientVerifyUrl(doc, nodeId);

  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [open, url]);

  return (
    <>
      <button className="btn btn-s btn-sm" title="Show verification QR (scannable by anyone, no account needed)" onClick={() => setOpen(true)}>
        <QrCode style={{ width: 11, height: 11 }} /> QR
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Scan to verify" showClose width={420}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            {doc.title ?? doc.docType} — any phone camera opens the public verification page. No account required.
          </div>
          {dataUrl
            ? <img src={dataUrl} alt="Verification QR" style={{ width: 280, height: 280, imageRendering: 'pixelated' }} />
            : <div className="empty">Generating…</div>}
          {/* Clickable too: opens the same public verification page the QR
              resolves to (full URL incl. the offline fragment payload) in a
              new tab — for presenting without a phone. */}
          <a href={url} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--accent, #2563eb)', marginTop: 8, wordBreak: 'break-all', fontFamily: 'var(--mono)', textDecoration: 'underline' }}>
            <ExternalLink style={{ width: 12, height: 12, flexShrink: 0 }} />
            {url.split('#')[0]}
          </a>
        </div>
      </Modal>
    </>
  );
}
