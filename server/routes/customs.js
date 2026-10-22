// T-4V03 (WP1) — customs-perspective routes.
//
// Three surfaces:
//   GET  /api/customs/queue                     officer declaration queue (export
//                                               side) / pre-clearance inbox (import
//                                               side), with verification-driven
//                                               channel simulation
//   GET  /api/consignments/:id/preclearance    aggregated view model: dossier +
//                                               per-document verification state +
//                                               draft import declaration with
//                                               per-field source provenance
//   POST /api/consignments/:id/import-declaration
//                                               "Accept pre-lodged data" → creates
//                                               the Import Declaration (Draft) doc
//   POST /api/consignments/:id/request-correction
//                                               importer-side bounce-back, logged on
//                                               the (cross-node replicated) ledger
//
// Gating is config-driven via the org's `customsDeskRole` field
// (exportCustoms | importCustoms | importer) — no hardcoded org names, so the
// corridor stays swappable. Channeling language follows the call-prep rule
// (hypothesis A2): verified data SHARPENS the authority's risk engine; the
// demo never frames the channel decision as wrong — decisions stay with the
// authority.
import { Router } from 'express';
import { genId, now, sha256OfBuffer } from '../utils.js';
import { store, addLog, mirrorDocumentToPeer, NODE_ID } from '../store.js';
import { getConfig } from '../config.js';
import { makeSeedPdf } from '../generators/pdf.js';
import { buildVerifyUrl } from '../qr.js';

const router = Router();

// Published H1 2024 export channeling rates — displayed as reference base
// rates, never recomputed (the real rates are the authority's own number).
export const CHANNEL_BASE_RATES = { green: 66.0, yellow: 30.3, red: 3.4 };

function findOrg(orgId) {
  return store.orgs.find(o => o.id === orgId) ?? null;
}

function deskRole(org) {
  return org?.customsDeskRole ?? null;
}

// ── Dossier verification state ─────────────────────────────────────────
// Live notarization evidence (docs carrying a TWIN proof) beats the seeded
// flag; the seeded `customs.dossierVerified` covers simulated mode where
// seed documents carry no real proofs.
export function dossierState(c) {
  const docTypes = getConfig()?.documentTypes ?? {};
  const docs = store.documents.filter(d => d.consignmentId === c.id);
  const required = docs.filter(d => docTypes[d.docType]?.requiresNotarization);
  const anchored = required.filter(d => d.proofId);
  const liveVerified = required.length > 0 && anchored.length === required.length;
  const dossierVerified = liveVerified || (c.customs?.dossierVerified ?? false);
  return {
    docCount: docs.length,
    requiredCount: required.length,
    anchoredCount: anchored.length,
    dossierVerified,
    liveVerified,
  };
}

// What the verification-driven simulation recommends for this declaration.
// Verified dossier + no data inconsistency + complete origin evidence → the
// risk engine has everything it needs to keep the declaration green. Data
// problems (HS mismatch) or evidence gaps (missing input C/O) keep their
// channel regardless of notarization — provenance proves integrity, not
// content (the false-content fraud layer needs source-side evidence).
export function simulateChannel(c, state) {
  const seeded = c.customs?.channel ?? 'yellow';
  const evidenceGap = c.originComposition?.evidenceIncomplete === true;
  if (c.errorType || evidenceGap) {
    return { simulatedChannel: seeded, wouldImproveIfVerified: false };
  }
  if (state.dossierVerified) {
    return { simulatedChannel: 'green', wouldImproveIfVerified: seeded !== 'green' };
  }
  return { simulatedChannel: seeded, wouldImproveIfVerified: seeded !== 'green' };
}

function queueRow(c) {
  const state = dossierState(c);
  const sim = simulateChannel(c, state);
  return {
    id: c.id,
    ucr: c.ucr,
    declarationNo: c.customs?.declarationNo ?? null,
    declarationType: c.customs?.declarationType ?? null,
    customsOffice: c.customs?.customsOffice ?? null,
    traderTaxCode: c.customs?.traderTaxCode ?? null,
    declaredAt: c.customs?.declaredAt ?? c.createdAt,
    releasedAt: c.customs?.releasedAt ?? null,
    channel: c.customs?.channel ?? null,
    channelReason: c.customs?.channelReason ?? null,
    inspectionResult: c.customs?.inspectionResult ?? null,
    exporter: c.exporter,
    importer: c.importer,
    product: c.product,
    hsCode: c.hsCode,
    totalValue: c.totalValue,
    currency: c.currency,
    toCountry: c.toCountry,
    status: c.status,
    errorType: c.errorType ?? null,
    eCo: c.customs?.eCo ?? null,
    destination: c.customs?.destination ?? null,
    logistics: c.customs?.logistics ?? null,
    originNode: c.originNode ?? null,
    dossier: state,
    ...sim,
  };
}

// ── Officer queue / pre-clearance inbox ────────────────────────────────
router.get('/api/customs/queue', (req, res) => {
  const org = findOrg(req.query.orgId);
  const role = deskRole(org);
  if (!role) return res.status(403).json({ error: 'Customs Desk is limited to orgs with a customsDeskRole' });

  let list;
  if (role === 'exportCustoms') {
    // The export authority sees every declaration filed on its own node —
    // the queue IS its declaration system view, not a permission grant.
    list = store.consignments.filter(c => (c.originNode ?? NODE_ID) === NODE_ID && c.customs);
  } else {
    // Import side (authority or importer/broker): consignments shared with
    // this org (cross-node pre-lodgement) plus anything it can already see.
    list = store.consignments.filter(c => {
      if (!c.customs) return false;
      const p = store.permissions[c.id] ?? {};
      return p[org.id] === 'owner' || p[org.id] === 'viewer' || c.creatorOrgId === org.id;
    });
  }

  const rows = list.map(queueRow);
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const r of rows) if (counts[r.channel] != null) counts[r.channel]++;
  res.json({
    role,
    node: NODE_ID,
    baseRates: CHANNEL_BASE_RATES,
    counts,
    // Reference processing times (UNI Customs Consulting / TGL published
    // figures): green clears same-day; yellow takes 1-3 working days of
    // manual review; red adds a scheduled physical inspection.
    referenceClearTimes: { green: 'same day', yellow: '1-3 working days', red: 'physical inspection' },
    declarations: rows,
  });
});

// ── Pre-clearance view model ───────────────────────────────────────────

// Resolve a document issuer (display name) to a DID, looking across local
// and peer orgs. Best-effort — seeded issuers are name strings.
function issuerDid(name) {
  if (!name) return null;
  const org = store.orgs.find(o => o.name === name) ?? store.peerOrgs.find(o => o.name === name);
  return org?.did ?? null;
}

function docByType(docs, ...types) {
  for (const t of types) {
    const d = docs.find(x => x.docType === t);
    if (d) return d;
  }
  return null;
}

function field(key, label, value, sourceDoc) {
  return {
    key,
    label,
    value: value ?? null,
    sourceDoc: sourceDoc?.docType ?? null,
    sourceDocId: sourceDoc?.id ?? null,
  };
}

export function buildPreclearance(c) {
  const docTypes = getConfig()?.documentTypes ?? {};
  const docs = store.documents.filter(d => d.consignmentId === c.id);
  const state = dossierState(c);
  const sim = simulateChannel(c, state);

  const documents = docs.map(d => ({
    id: d.id,
    docType: d.docType,
    title: d.title,
    reference: d.reference ?? null,
    issuer: d.issuer ?? d.creatorOrgName,
    issuerDid: issuerDid(d.issuer ?? d.creatorOrgName),
    format: d.format ?? null,
    requiresNotarization: docTypes[d.docType]?.requiresNotarization ?? false,
    uneceCode: docTypes[d.docType]?.uneceCode ?? null,
    sourceSystem: docTypes[d.docType]?.sourceSystem ?? null,
    notarization: {
      mode: d.notarizationMode ?? null,
      proofId: d.proofId ?? null,
      explorerUrl: d.proofExplorerUrl ?? null,
      verified: d.proofVerified ?? false,
      lastVerifiedAt: d.lastVerifiedAt ?? null,
      node: d.notarizationNode ?? null,
    },
    hash: d.hash ?? null,
  }));

  const inv = docByType(docs, 'Commercial Invoice');
  const pl = docByType(docs, 'Packing List');
  const bl = docByType(docs, 'Bill of Lading');
  const co = docByType(docs, 'Export Certificate of Origin', 'Certificate of Origin');
  const ed = docByType(docs, 'Export Declaration');
  const cust = c.customs ?? {};
  const dest = cust.destination ?? {};
  const isEu = dest.type === 'eu';

  const fields = [
    field('importerOfRecord', 'Importer of record', c.importer, inv),
    field('exporter', 'Exporter / seller', c.exporter, inv),
    field('ucr', 'Unique consignment reference', c.ucr, ed),
    field('exportDeclarationNo', 'Export declaration no.', cust.declarationNo, ed),
    field('goodsDescription', 'Goods description', c.product, inv),
    field('hsCode', isEu ? 'CN code (from HS)' : 'HTS classification (from HS)',
      isEu ? c.hsCode : (dest.htsCode ?? c.hsCode), ed),
    field('customsValue', 'Customs value', c.totalValue != null ? `${c.currency} ${c.totalValue.toLocaleString('en-US')}` : null, inv),
    field('quantity', 'Quantity', c.quantity, pl),
    field('grossWeight', 'Gross weight (kg)', cust.logistics?.grossWeightKg, pl),
    field('packages', 'Packages', cust.logistics?.packages != null ? `${cust.logistics.packages} ${cust.logistics.packageType ?? ''}`.trim() : null, pl),
    field('countryOfOrigin', 'Country of origin', c.fromCountry, co),
    field('preferentialClaim', 'Preferential claim', isEu ? (dest.preferentialClaim ?? null) : (cust.eCo?.formType ?? null), co),
    field('certificateOfOrigin', 'Certificate of origin ref.', cust.eCo?.ref, co),
    field('transportDocument', 'Transport document (B/L)', cust.logistics?.blNo, bl),
    field('vessel', 'Vessel', c.vessel, bl),
    field('containerNo', 'Container / seal', cust.logistics?.containerNo ? `${cust.logistics.containerNo} / ${cust.logistics.sealNo ?? '—'}` : null, bl),
    field('portOfEntry', 'Port of entry', c.destinationPort, bl),
  ];

  // Destination-specific data the pre-lodged dossier canNOT provide — the
  // importer's own additions. This is the demo point: pre-lodgement covers
  // most of the declaration, the importer adds only what is theirs.
  const missing = isEu
    ? ['Declarant EORI', 'Customs office of lodgement', 'VAT registration']
    : ['Entry filer code (broker)', 'Customs bond no.', 'Port of entry code'];

  return {
    consignment: {
      id: c.id,
      ucr: c.ucr,
      status: c.status,
      exporter: c.exporter,
      importer: c.importer,
      fromCountry: c.fromCountry,
      toCountry: c.toCountry,
      originNode: c.originNode ?? null,
      errorType: c.errorType ?? null,
      errorDescription: c.errorDescription ?? null,
      customs: cust,
      originComposition: c.originComposition ?? null,
    },
    dossier: state,
    channel: { current: cust.channel ?? null, ...sim },
    documents,
    draftDeclaration: {
      fields: fields.filter(f => f.value != null),
      missing,
      alreadyAccepted: docs.some(d => d.docType === 'Import Declaration (Draft)'),
    },
  };
}

function canSeePreclearance(c, org) {
  if (!org) return false;
  const p = store.permissions[c.id] ?? {};
  return c.creatorOrgId === org.id || p[org.id] === 'owner' || p[org.id] === 'viewer'
    || deskRole(org) === 'exportCustoms';
}

router.get('/api/consignments/:id/preclearance', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const org = findOrg(req.query.orgId);
  if (!canSeePreclearance(c, org)) return res.status(403).json({ error: 'No access to this consignment' });
  res.json(buildPreclearance(c));
});

// ── Accept pre-lodged data → Import Declaration (Draft) ───────────────
router.post('/api/consignments/:id/import-declaration', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const org = findOrg(req.body.actorOrgId);
  const role = deskRole(org);
  if (!['importer', 'importCustoms'].includes(role ?? '')) {
    return res.status(403).json({ error: 'Only the importer/broker or the destination customs authority can accept pre-lodged data' });
  }
  if (!canSeePreclearance(c, org)) return res.status(403).json({ error: 'No access to this consignment' });
  if (store.documents.some(d => d.consignmentId === c.id && d.docType === 'Import Declaration (Draft)')) {
    return res.status(409).json({ error: 'A draft import declaration already exists for this consignment' });
  }

  const view = buildPreclearance(c);
  const ref = `IMD-${c.ucr.split('-').pop()}`;
  const docId = genId();
  const fileBase64 = makeSeedPdf('Import Declaration (Draft)', ref, org.name, c.ucr,
    now().slice(0, 10), c.exporter, c.importer, c.fromCountry, c.toCountry,
    { verifyUrl: buildVerifyUrl({ docId, ucr: c.ucr, docType: 'Import Declaration (Draft)', issuer: org.name, nodeId: NODE_ID }) });
  const doc = {
    id: docId,
    consignmentId: c.id,
    title: 'Import Declaration (Draft)',
    docType: 'Import Declaration (Draft)',
    filename: `${ref}.pdf`,
    fileBase64,
    fileSize: Buffer.from(fileBase64, 'base64').length,
    hash: sha256OfBuffer(Buffer.from(fileBase64, 'base64')),
    creatorOrgId: org.id,
    creatorOrgName: org.name,
    timestamp: now(),
    reference: ref,
    format: 'PDF',
    issuer: org.name,
    // Working draft, deliberately NOT notarized — it is the importer's own
    // document in preparation, not an exchanged trade document.
    notarizationMode: null,
    proofId: null,
    proofVerified: false,
    lastVerifiedAt: null,
    notarizationNode: NODE_ID,
    // Per-field provenance snapshot at acceptance time.
    prelodged: {
      acceptedAt: now(),
      fields: view.draftDeclaration.fields,
      missing: view.draftDeclaration.missing,
    },
  };
  store.documents.push(doc);
  c.documentCount = store.documents.filter(d => d.consignmentId === c.id).length;

  addLog('document', 'Pre-lodged Data Accepted', org.name,
    `${c.ucr} — Import declaration draft ${ref} prepared from the verified export dossier (${view.draftDeclaration.fields.length} fields pre-filled, ${view.draftDeclaration.missing.length} importer-side fields outstanding).`,
    { consignmentId: c.id, reference: ref });

  // Mirror the new doc to the peer node when the consignment is shared
  // cross-node (same best-effort pattern as POST /api/documents).
  const grantees = Object.keys(store.permissions[c.id] ?? {});
  const sharedWithPeer = grantees.some(orgId => store.peerOrgs.some(po => po.id === orgId))
    || (c.originNode && c.originNode !== NODE_ID);
  if (sharedWithPeer) mirrorDocumentToPeer(c.id, doc);

  res.json({ ...doc, fileBase64: undefined });
});

// ── Request correction (importer-side bounce-back) ─────────────────────
// No new transport: addLog entries replicate to the peer node over the
// existing LEDGER_ENTRY channel, so the exporter side sees the request in
// its activity feed.
router.post('/api/consignments/:id/request-correction', (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const org = findOrg(req.body.actorOrgId);
  const role = deskRole(org);
  if (!['importer', 'importCustoms'].includes(role ?? '')) {
    return res.status(403).json({ error: 'Only the importer/broker or the destination customs authority can request a correction' });
  }
  if (!canSeePreclearance(c, org)) return res.status(403).json({ error: 'No access to this consignment' });
  const reason = (req.body.reason ?? '').toString().slice(0, 300) || 'unspecified';
  const entry = addLog('document', 'Correction Requested', org.name,
    `${c.ucr} — Correction requested on the pre-lodged dossier: ${reason}`,
    { consignmentId: c.id });
  res.json({ ok: true, entry });
});

export default router;
