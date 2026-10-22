// T-4V04 (WP3) — "Transport Pass" PDF.
//
// A dedicated one-page shipment summary built so a driver can carry it and an
// officer at a checkpoint can (a) eyeball the human-readable facts to confirm
// the paper matches the truck, then (b) scan the prominent QR to open the
// public, no-login shipment dossier. NOT the QR bolted onto a Bill of Lading
// (UX decision 3): the B/L may be uploaded/peer-owned/absent and its scope is
// the document, not the shipment.
//
// Built like server/generators/pdf.js — a raw single-page content stream with
// the QR drawn as vector rects (qrPdfOps), no image XObjects. Print-grade QR:
// larger module area + error-correction 'Q' (~25% damage tolerance) + an
// explicit quiet zone, pure black on white (never themed).
import { qrPdfOps, buildShipmentUrl } from '../qr.js';
import { buildSinglePagePdf, escapePdfText } from './pdf-core.js';

function textBlock(x, y, size, lines, leading = 14) {
  const body = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n');
  return `BT\n/F1 ${size} Tf\n${x} ${y} Td\n${leading} TL\n${body}\nET`;
}

function fmtMoney(c) {
  if (c?.totalValue == null || !c?.currency) return '';
  return `${c.currency} ${Number(c.totalValue).toLocaleString('en-US')}`;
}

/**
 * Build the Transport Pass PDF for a flat consignment record `c`.
 * @param {object} c       the consignment (store/flat shape)
 * @param {object} opts    { nodeId, docCount, verifiedCount, corridorName }
 * @returns {string} base64-encoded PDF
 */
export function makeTransportPass(c, opts = {}) {
  const { nodeId = 'alpha', docCount = 0, verifiedCount = 0, corridorName = 'Trade Corridor', generatedAt = '' } = opts;
  const verifyUrl = buildShipmentUrl({
    id: c.id, ucr: c.ucr, exporter: c.exporter, importer: c.importer,
    fromCountry: c.fromCountry, toCountry: c.toCountry, nodeId,
  });

  // Helvetica (base-14) renders the PDF content stream as single-byte glyphs,
  // so EVERY string here must be ASCII — a multibyte char (·, —, →) shows as
  // mojibake ("´•"). Use ASCII separators throughout; the route uses "->".
  const DASH = '  -  ';
  const oc = c.originComposition;
  const originLine = c.fromCountry
    ? `${c.fromCountry}${oc?.localContentPercent != null ? `${DASH}${oc.localContentPercent}% local content` : ''}`
    : '';
  const channel = c.customs?.channel ? c.customs.channel.toUpperCase() : null;

  // ── QR, top-right, print-grade ──────────────────────────────────────
  // page 612x792; QR ~108pt (~38mm), EC 'Q'. Sits in the top-right corner;
  // the two-column block starts BELOW its bottom edge so nothing overlaps it.
  const QR_SIZE = 108;
  const QR_X = 540 - QR_SIZE;        // right margin 72 → right edge 540
  const QR_TOP = 752;
  const QR_Y = QR_TOP - QR_SIZE;     // bottom-left = 644
  const { ops: qrOps } = qrPdfOps(verifyUrl, { x: QR_X, y: QR_Y, size: QR_SIZE, errorCorrectionLevel: 'Q' });
  const qrCaption = textBlock(QR_X, QR_Y - 11, 7, ['Scan for full shipment dossier', 'public, no account needed'], 9);

  // ── Header band (left; stays clear of the QR column at x>=432) ───────
  const header =
    textBlock(72, 748, 9, ['TWIN TRADE CORRIDOR']) + '\n' +
    textBlock(72, 726, 20, ['TRANSPORT PASS']) + '\n' +
    textBlock(72, 710, 9, [corridorName]);
  // Thin rule under the header, stopping before the QR column.
  const rule = `q 0.6 0.6 0.6 rg 72 698 336 0.8 re f Q`;

  // ── Identity (left; short text, clear of the QR) ────────────────────
  const identity =
    textBlock(72, 680, 15, [`UCR  ${c.ucr ?? ''}`]) + '\n' +
    textBlock(72, 662, 11, [c.fromCountry && c.toCountry ? `${c.fromCountry}  ->  ${c.toCountry}` : '']);

  // ── Two-column human-readable block (starts below the QR bottom) ─────
  const leftX = 72, rightX = 320;
  // Start below the QR caption (its 2nd line sits at ~QR_Y-20) so the right
  // column header never collides with "...no account needed".
  const colTop = 606;
  const left = textBlock(leftX, colTop, 10, [
    'EXPORTER / CONSIGNOR', c.exporter ?? '-', '',
    'GOODS', `${c.product ?? '-'}${c.hsCode ? `  (HS ${c.hsCode})` : ''}`, '',
    'QUANTITY', c.quantity ?? '-', '',
    'ORIGIN', originLine || '-',
  ], 14);
  const right = textBlock(rightX, colTop, 10, [
    'IMPORTER / CONSIGNEE', c.importer ?? '-', '',
    'CUSTOMS VALUE', fmtMoney(c) || '-', '',
    'STATUS / CHANNEL', `${c.status ?? '-'}${channel ? `${DASH}${channel}` : ''}`, '',
    'DOSSIER', `${docCount} document${docCount === 1 ? '' : 's'} (${verifiedCount} verified)`,
  ], 14);

  // ── Footer ──────────────────────────────────────────────────────────
  const footer = textBlock(72, 96, 8, [
    `Issued by node ${nodeId}${generatedAt ? `${DASH}${generatedAt}` : ''}`,
    'Verified provenance, not email. Anyone may verify this shipment without an account.',
  ], 11);

  const stream = `${header}\n${rule}\n${identity}\n${left}\n${right}\n${qrOps}\n${qrCaption}\n${footer}`;
  return buildSinglePagePdf(stream);
}
