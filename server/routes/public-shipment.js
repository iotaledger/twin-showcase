// T-4V04 — public, unauthenticated SHIPMENT view (border-officer / truck-driver
// checkpoint). Scanning the shipment QR lands here.
//
// This is the document-level public verify (T-4V03) lifted one scope up: a
// read-only, no-login view of ONE consignment's curated border dossier.
//
// Disclosure rules (decision 1 + KB caveats):
//   - bearer capability: whoever holds the id sees the curated view. Curated,
//     NOT the literal app dashboard.
//   - INCLUDE: parties, goods + HS, customs value, origin + evidence chain,
//     the customs/declaration facts, the document list with per-document
//     verification state (+ explorer link, + /verify/:docId deep-link), and
//     the channel/clearance status.
//   - EXCLUDE: finance/payments, ledger/internal notes, unit-level pricing,
//     and ANY other consignment's data (cross-consignment isolation).
import { Router } from 'express';
import { store, NODE_ID, NODE_NAME } from '../store.js';
import { buildPreclearance } from './customs.js';
import { makeTransportPass } from '../generators/transport-pass.js';
import { getConfig } from '../config.js';
import { docPublicAccess, canViewContent, isPublicListed } from '../lib/doc-access.js';

const router = Router();

// Curate the preclearance view model down to the public border view. Reuses
// buildPreclearance (consignment facts + documents-with-verification + channel
// + origin) and drops anything importer-internal or sensitive.
function buildShipmentView(c) {
  const pc = buildPreclearance(c); // { consignment, dossier, channel, documents, draftDeclaration }
  const cust = pc.consignment.customs ?? {};
  return {
    status: 'found',
    node: NODE_ID,
    nodeName: NODE_NAME,
    shipment: {
      id: pc.consignment.id,
      ucr: pc.consignment.ucr,
      status: pc.consignment.status,
      exporter: pc.consignment.exporter,
      importer: pc.consignment.importer,
      fromCountry: pc.consignment.fromCountry,
      toCountry: pc.consignment.toCountry,
      product: c.product ?? null,
      hsCode: c.hsCode ?? null,
      quantity: c.quantity ?? null,
      // Aggregate customs value only — NEVER unit-level pricing (KB caveat 1).
      customsValue: (c.totalValue != null && c.currency)
        ? { value: c.totalValue, currency: c.currency }
        : null,
      vessel: c.vessel ?? null,
      destinationPort: c.destinationPort ?? null,
      errorType: pc.consignment.errorType ?? null,
      // Curated customs/declaration facts (no finance).
      customs: {
        declarationNo: cust.declarationNo ?? null,
        declarationType: cust.declarationType ?? null,
        customsOffice: cust.customsOffice ?? null,
        channel: cust.channel ?? null,
        channelReason: cust.channelReason ?? null,
        releasedAt: cust.releasedAt ?? null,
        eCo: cust.eCo ?? null,
        logistics: cust.logistics ?? null,
        destination: cust.destination ?? null,
      },
    },
    originComposition: pc.consignment.originComposition ?? null,
    dossier: pc.dossier,
    channel: pc.channel,
    // Per-document public access policy (per documentTypes.publicAccess):
    //   - drop 'none' docs entirely
    //   - tag each with publicAccess + contentAvailable so the page knows
    //     whether to offer a "View document" action ('content') or keep it
    //     verification-only ('verify').
    documents: pc.documents
      .filter(d => isPublicListed(d.docType))
      .map(d => {
        const access = docPublicAccess(d.docType);
        const blob = store.documents.find(x => x.id === d.id)?.fileBase64;
        return {
          ...d,
          publicAccess: access,
          contentAvailable: access === 'content' && Boolean(blob),
          contentUrl: access === 'content' && blob
            ? `/api/public/shipment/${pc.consignment.id}/document/${d.id}?node=${NODE_ID}`
            : null,
        };
      }),
  };
}

router.get('/api/public/shipment/:id', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) {
    return res.status(404).json({ status: 'unknown', error: 'No shipment with this id on this node', node: NODE_ID });
  }
  res.json(buildShipmentView(c));
});

// Printable Transport Pass PDF for a shipment. Public on purpose — it is the
// driver's carryable artifact and contains only the same curated facts as the
// page, plus the QR. (No auth: matches the public verify surface.)
router.get('/api/public/shipment/:id/pass', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'No shipment with this id on this node' });
  const docs = store.documents.filter(d => d.consignmentId === c.id);
  const verifiedCount = docs.filter(d => d.proofVerified || (store.adapter?.mode === 'simulated' && c.customs?.dossierVerified)).length;
  const pdf = makeTransportPass(c, {
    nodeId: NODE_ID,
    docCount: docs.length,
    verifiedCount,
    corridorName: getConfig()?.corridor?.name ?? 'Trade Corridor',
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="transport-pass-${c.ucr}.pdf"`);
  res.send(Buffer.from(pdf, 'base64'));
});

// Public document CONTENT — the border dossier the owner made inspectable by
// minting the shipment QR. Gated by the per-document-type access policy:
// serves the blob ONLY for docs whose documentTypes.publicAccess is 'content'
// AND that belong to THIS shipment. Everything else (verify/none types, finance,
// other consignments) is refused. The blob is the node-stored content mirrored
// into the demo store; in production the BFF fetches it from the node's
// blob-storage by documentManagementId.
router.get('/api/public/shipment/:id/document/:docId', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'No shipment with this id on this node' });
  const doc = store.documents.find(d => d.id === req.params.docId);
  // Cross-consignment isolation: the doc must belong to THIS shipment.
  if (!doc || doc.consignmentId !== c.id) return res.status(404).json({ error: 'Document not part of this shipment' });
  // Access policy: content is disclosed only for 'content' doc types.
  if (!canViewContent(doc.docType)) {
    return res.status(403).json({ error: 'Content not publicly disclosed for this document type', publicAccess: docPublicAccess(doc.docType) });
  }
  if (!doc.fileBase64) return res.status(404).json({ error: 'Document content not available on this node' });
  const isXml = doc.filename?.endsWith('.xml') || doc.format === 'XML';
  res.setHeader('Content-Type', isXml ? 'application/xml' : 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename ?? doc.reference ?? doc.id}"`);
  res.send(Buffer.from(doc.fileBase64, 'base64'));
});

export default router;
