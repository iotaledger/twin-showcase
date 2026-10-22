// T-4V03 (WP4) — verification QR for trade documents.
//
// The QR encodes a public verification URL with a base64url payload in the
// URL FRAGMENT. The fragment is never sent to the server (offline-readable
// by any scanner app), and is self-describing: docId, UCR, docType, issuer
// and node, so an officer with no connectivity still sees what the document
// claims to be. Integrity facts (sha256, anchor, verified state) come from
// the public verify endpoint — deliberately NOT from the QR, because the
// QR is printed INSIDE the PDF whose bytes are hashed (a payload carrying
// the PDF hash would be circular).
import QRCode from 'qrcode';

// Where scanned QRs land. The proxy (port 4002) routes `?node=` to the right
// demo server, so one public hostname serves both corridor sides. Override
// with PUBLIC_BASE_URL when tunnelling (e.g. https://demo.example.com).
export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:4002').replace(/\/+$/, '');
}

export function encodeVerifyPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function buildVerifyUrl({ docId, ucr, docType, issuer, nodeId }) {
  const payload = encodeVerifyPayload({ v: 1, docId, ucr, docType, issuer, node: nodeId });
  return `${publicBaseUrl()}/verify/${encodeURIComponent(docId)}?node=${nodeId}#${payload}`;
}

// T-4V04 (WP3/WP4) — shipment-level QR. Same shape as the document QR, one
// scope up: scanning it opens the public read-only border view of ONE
// consignment. The fragment carries the offline-readable summary (ucr,
// parties, route, node) so the pass is meaningful even with the server
// unreachable. Disclosure model (decision 1): the consignment id in the URL
// is the bearer capability — no signed/expiring token in the demo; the
// public page documents that expiry+revocation is the production extension.
export function buildShipmentUrl({ id, ucr, exporter, importer, fromCountry, toCountry, nodeId }) {
  const payload = encodeVerifyPayload({
    v: 1, id, ucr, exporter, importer,
    route: fromCountry && toCountry ? `${fromCountry} → ${toCountry}` : undefined,
    node: nodeId,
  });
  return `${publicBaseUrl()}/shipment/${encodeURIComponent(id)}?node=${nodeId}#${payload}`;
}

/**
 * Render a QR as raw-PDF vector operations (one filled `re` rectangle per
 * dark module) — the seed PDF generator builds documents as a raw content
 * stream with no image support, and vector rects need no XObject/Flate
 * machinery. Returns ops + geometry so the caller can place a caption.
 *
 * x/y are PDF user-space coords of the QR's BOTTOM-LEFT corner.
 */
export function qrPdfOps(text, { x, y, size = 96, errorCorrectionLevel = 'M' } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / n;
  const ops = ['q', '0 0 0 rg'];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!data[row * n + col]) continue;
      // PDF y-axis grows upward; QR rows grow downward.
      const rx = (x + col * cell).toFixed(2);
      const ry = (y + (n - 1 - row) * cell).toFixed(2);
      ops.push(`${rx} ${ry} ${cell.toFixed(2)} ${cell.toFixed(2)} re f`);
    }
  }
  ops.push('Q');
  return { ops: ops.join('\n'), moduleCount: n, size };
}
