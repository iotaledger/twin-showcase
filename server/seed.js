import { getConfig } from './config.js';
import { genId, genHash, sha256OfBuffer } from './utils.js';
import { store, NODE_ID, NODE_NAME, addLog, seedLog } from './store.js';
import { makeSeedPdf } from './generators/pdf.js';
import { makeSeedXml } from './generators/xml.js';
import { buildVerifyUrl } from './qr.js';
import { loadSeedStateForNode } from './seed-state.js';

const ALPHA_CONSIGNMENTS = getConfig()?.consignments?.alpha ?? [];
const BETA_CONSIGNMENTS = getConfig()?.consignments?.beta ?? [];

// T-242: when the adapter is wired to a real TWIN node and the operator has
// run `npm run twin:seed`, data/seed-state.json carries the TWIN resource IDs
// (AIG vertex per consignment, documentManagementId per document) that we
// should attach to the in-memory store so the UI links to actual on-chain
// records and follow-up writes update the seeded TWIN resource instead of
// creating a parallel one. In simulated mode the file is ignored.
// MUST mirror ADAPTER_DEFAULT_MODE in server/adapter/index.js. When
// ADAPTER_MODE is unset, the adapter factory defaults to 'docker' (talks to
// the real TWIN nodes) — so the seed MUST default to 'docker' too and hydrate
// notarizationMode/proof fields from data/seed-state.json. If this defaulted
// to 'simulated' while the adapter ran docker, every seeded document would
// render as "Demo mode" despite having a real on-chain anchor (T-4V03 bug).
const ADAPTER_MODE = (process.env.ADAPTER_MODE ?? 'docker').toLowerCase();
const SHOULD_HYDRATE_FROM_SEED_STATE = ADAPTER_MODE === 'docker' || ADAPTER_MODE === 'hosted';

function docsForConsignment(m) {
  const cfgDocs = getConfig()?.documents?.[NODE_ID];
  if (cfgDocs) {
    return cfgDocs.map(d => ({
      name: d.name,
      docType: d.docType,
      issuer: d.issuerOrgId === 'creator' ? m.creatorOrgName : (d.issuerName || m.creatorOrgName),
      suffix: d.suffix,
    }));
  }
  return [];
}

export function seedConsignments() {
  if (store.consignments.length > 0) return;
  const list = NODE_ID === 'alpha' ? ALPHA_CONSIGNMENTS : BETA_CONSIGNMENTS;

  // T-242: load TWIN-side IDs from data/seed-state.json (docker/hosted only).
  // Helper already guards on corridor mismatch and returns null when nothing
  // matches the active config, so the per-row lookup below is just an
  // optional-chain access.
  const seedState = SHOULD_HYDRATE_FROM_SEED_STATE
    ? loadSeedStateForNode(NODE_ID, getConfig()?.corridor?.id)
    : null;
  const seededConsignments = seedState?.consignments ?? {};
  const seededDocuments = seedState?.documents ?? {};
  let hydratedConsignments = 0;
  let hydratedDocuments = 0;
  let totalDocuments = 0;

  for (const m of list) {
    const cId = `seed-${m.ucr}`;
    const createdAt = m.shipDate + 'T08:00:00.000Z';
    const docs = docsForConsignment(m);
    const seededConsignment = seededConsignments[m.ucr];
    if (seededConsignment?.aigVertexId) hydratedConsignments++;
    const c = {
      id: cId, ucr: m.ucr,
      commercialInvoiceNo: m.invoiceRef, exportDeclarationNo: m.declRef,
      description: m.product, product: m.product,
      hsCode: m.hsCode, quantity: m.quantity, unit: '',
      totalValue: m.totalValue, currency: m.currency,
      exporter: m.exporter, importer: m.importer,
      fromCountry: m.fromCountry, toCountry: m.toCountry,
      originPort: m.originPort, destinationPort: m.destinationPort,
      vessel: m.vessel, shipDate: m.shipDate, incoterms: m.incoterms,
      errorType: m.errorType || null, errorDescription: m.errorDescription || null,
      // T-4V03: per-consignment customs block (export declaration,
      // channel, eCO linkage, logistics refs, destination entry data) and
      // origin composition — both straight from the corridor config.
      customs: m.customs ?? null,
      originComposition: m.originComposition ?? null,
      creatorOrgId: m.creatorOrgId, creatorOrgName: m.creatorOrgName,
      createdAt, documentCount: docs.length, status: m.status,
      // T-242: TWIN AIG vertex anchoring this consignment (null in simulated
      // mode or when the operator hasn't seeded this UCR).
      aigVertexId: seededConsignment?.aigVertexId ?? null,
      // T-311: seeded consignments are local by definition (each node seeds
      // its own subset of UCRs).
      originNode: NODE_ID,
    };
    store.consignments.push(c);
    // T-4V03: optional per-consignment `viewers` in the corridor config —
    // orgs (e.g. the customs authority, the CoO issuer) pre-granted read
    // access so the regular Consignments/Documents views work for them
    // without a live "grant access" step. Configs without the key keep the
    // creator-only behavior.
    const seedViewers = (m.viewers ?? []).filter(v => v !== m.creatorOrgId);
    store.permissions[cId] = {
      [m.creatorOrgId]: 'owner',
      ...Object.fromEntries(seedViewers.map(v => [v, 'viewer'])),
    };
    store.financePermissions[cId] = { [m.creatorOrgId]: 'owner' };
    seedLog('document', 'Consignment Anchored', m.exporter,
      `Digital twin created: ${m.ucr} \u2014 ${m.product}. Anchored on the ledger.`, createdAt);
    // The pre-granted access is a SHARE in the demo narrative \u2014 make it an
    // auditable ledger event, like the live "grant access" flow does, so the
    // boot state reads as "the exporter shared the dossier with the
    // authorities", not as silently visible data. (Intra-node demo grant:
    // deliberately no ODRL-policy claim \u2014 that belongs to the cross-node
    // DSP share.)
    for (const v of seedViewers) {
      const granteeName = store.orgs.find(o => o.id === v)?.name ?? v;
      seedLog('permission', 'Access Granted', m.creatorOrgName,
        `"${m.ucr}" \u2014 dossier shared with ${granteeName} (read access) at corridor setup.`, createdAt);
    }

    for (const d of docs) {
      const ref = d.suffix === 'INV' ? m.invoiceRef
                : d.suffix === 'ED'  ? m.declRef
                : `${d.suffix}-${m.ucr.split('-').pop()}`;
      const docId = `${cId}-${d.suffix}`;
      const xmlContent = (d.suffix === 'BL' || d.suffix === 'ED' || d.suffix === 'BOM' || d.suffix === 'CO') ? makeSeedXml(d.docType, m, ref) : null;
      // T-4V03 (WP4): generated PDFs carry a verification QR pointing at the
      // public verify page. The docId is deterministic, so the URL is known
      // BEFORE the PDF bytes exist — and the content hash below is computed
      // on the final bytes (QR included), so there is no circularity.
      const fileBase64 = xmlContent
        ? Buffer.from(xmlContent, 'utf8').toString('base64')
        : makeSeedPdf(d.docType, ref, d.issuer, m.ucr, m.shipDate, m.exporter, m.importer, m.fromCountry, m.toCountry,
            { verifyUrl: buildVerifyUrl({ docId, ucr: m.ucr, docType: d.docType, issuer: d.issuer, nodeId: NODE_ID }) });
      const filename = xmlContent ? `${ref}.xml` : `${ref}.pdf`;
      const format   = xmlContent ? 'XML' : 'PDF';
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const fileSize = fileBuffer.length;
      totalDocuments++;
      // T-242: when the same doc was pushed to TWIN by the seed script, the
      // seed-state row carries the real documentManagementId and sha256.
      // Prefer those over genHash() (a synthetic placeholder) so the UI
      // fingerprint matches what is actually anchored on the TWIN node.
      // T-243: also propagate the immutable-proof envelope so the
      // NotarizationBadge reaches "anchored"/"verified" instead of
      // falling back to "Demo mode" (which keys off
      // `!doc?.notarizationMode`).
      const seededDoc = seededDocuments[docId];
      if (seededDoc?.documentManagementId) hydratedDocuments++;
      store.documents.push({
        id: docId, consignmentId: cId,
        title: d.name, docType: d.docType,
        filename,
        fileSize: seededDoc?.size ?? fileSize,
        fileBase64,
        // T-4V03: real sha256 of the generated blob (was a synthetic random
        // hash) so the public verify page's file-integrity check works on
        // seeded documents too.
        hash: seededDoc?.hash ?? sha256OfBuffer(fileBuffer),
        creatorOrgId: m.creatorOrgId, creatorOrgName: m.creatorOrgName,
        timestamp: createdAt, reference: ref,
        format, issuer: d.issuer,
        documentManagementId: seededDoc?.documentManagementId ?? null,
        // T-243: TWIN immutable-proof fields (null in simulated mode or
        // when the seed script ran before T-243 landed and didn't anchor
        // a proof). proofVerified stays false — UI verifies on demand.
        notarizationMode: seededDoc?.notarizationMode ?? null,
        proofId: seededDoc?.proofId ?? null,
        proofExplorerUrl: seededDoc?.proofExplorerUrl ?? null,
        receipt: seededDoc?.receipt ?? null,
        envelope: seededDoc?.envelope ?? null,
        // T-316: org-signed attestation NFT (issuer org's own DID + tenant).
        // null for REST-provisioned orgs (no wallet to mint with).
        orgAttestationId: seededDoc?.orgAttestationId ?? null,
        orgAttestationExplorerUrl: seededDoc?.orgAttestationExplorerUrl ?? null,
        proofVerified: false,
        lastVerifiedAt: null,
        // T-311: seeded docs are anchored on this node's TWIN.
        notarizationNode: NODE_ID,
      });
      seedLog('document', 'Document Anchored', m.exporter,
        `"${d.name}" anchored to ${m.ucr}. Issued by ${d.issuer}.`, createdAt);
    }

    const shipTs = new Date(m.shipDate + 'T08:00:00.000Z');
    const day = 86400000;
    if (['Released', 'In Transit', 'Customs', 'Delivered'].includes(m.status)) {
      seedLog('logistics', 'Export Clearance', m.exporter,
        `${m.ucr} \u2014 Export clearance granted. All documents verified.`,
        new Date(shipTs.getTime() - 2 * day).toISOString());
      seedLog('logistics', 'Container Loaded', m.exporter,
        `${m.ucr} \u2014 Container loaded at ${m.originPort}. Container: TCKU${3000000 + (parseInt(m.ucr.replace(/\D/g,'').slice(-4)||'0') % 9999999)}, Seal: SL${10000 + (parseInt(m.ucr.replace(/\D/g,'').slice(-4)||'0') % 89999)}.`,
        new Date(shipTs.getTime() - 1 * day).toISOString());
      seedLog('logistics', 'In Port', m.exporter,
        `${m.ucr} \u2014 Cargo received at ${m.originPort}. Awaiting vessel ${m.vessel}.`,
        new Date(shipTs.getTime()).toISOString());
      seedLog('logistics', 'Cleared for Export', m.exporter,
        `${m.ucr} \u2014 Cleared for export. Customs seal verified. Loading onto ${m.vessel}.`,
        new Date(shipTs.getTime() + 4 * 3600000).toISOString());
      seedLog('logistics', 'Departed Port', m.exporter,
        `${m.ucr} \u2014 ${m.vessel} departed ${m.originPort} bound for ${m.destinationPort}.`,
        new Date(shipTs.getTime() + 12 * 3600000).toISOString());
    }
    if (m.status === 'Delivered') {
      seedLog('logistics', 'Arrived at Port', m.importer,
        `${m.ucr} \u2014 ${m.vessel} arrived at ${m.destinationPort}.`,
        new Date(shipTs.getTime() + 18 * day).toISOString());
      seedLog('logistics', 'Import Clearance', m.importer,
        `${m.ucr} \u2014 Import clearance granted at ${m.destinationPort}. Goods released to consignee.`,
        new Date(shipTs.getTime() + 20 * day).toISOString());
    }
  }
  console.log(`[${NODE_NAME}] Seeded ${store.consignments.length} consignments`);
  if (SHOULD_HYDRATE_FROM_SEED_STATE && (hydratedConsignments > 0 || hydratedDocuments > 0)) {
    console.log(`[${NODE_NAME}] Hydrated ${hydratedConsignments}/${list.length} consignments and ${hydratedDocuments}/${totalDocuments} documents from data/seed-state.json`);
  }
}

export function seedFinanceData() {
  if (NODE_ID !== 'alpha') return;
  if (store.payments.length > 0 || store.letterOfCredits.length > 0 || store.smartContracts.length > 0) return;

  const seedData = getConfig()?.finance?.seedData;

  const viewers = seedData?.financeViewers ?? {};
  for (const [ucr, orgIds] of Object.entries(viewers)) {
    const c = store.consignments.find(cs => cs.ucr === ucr);
    if (c && store.financePermissions[c.id]) {
      for (const orgId of orgIds) store.financePermissions[c.id][orgId] = 'viewer';
    }
  }

  const cfgPayments = seedData?.payments ?? [];
  for (const p of cfgPayments) {
    const c = store.consignments.find(cs => cs.ucr === p.consignmentUcr);
    if (!c) continue;
    store.payments.push({
      id: genId(), consignmentId: c.id, ucr: c.ucr,
      invoiceRef: p.invoiceRef, amount: p.amount, currency: p.currency,
      dueDate: p.dueDate, status: p.status, paidAmount: p.paidAmount,
      paymentMethod: p.paymentMethod,
      payorOrgId: p.payorOrgId, payeeOrgId: p.payeeOrgId,
      creatorOrgId: p.payeeOrgId,
      notes: p.notes, createdAt: p.createdAt, updatedAt: p.createdAt,
    });
  }

  const cfgLCs = seedData?.letterOfCredits ?? [];
  for (const lc of cfgLCs) {
    const c = store.consignments.find(cs => cs.ucr === lc.consignmentUcr);
    if (!c) continue;
    const docs = store.documents.filter(d => d.consignmentId === c.id);
    store.letterOfCredits.push({
      id: genId(), consignmentId: c.id, ucr: c.ucr,
      lcNumber: lc.lcNumber,
      issuingBank: lc.issuingBank, advisingBank: lc.advisingBank,
      beneficiary: lc.beneficiary, applicant: lc.applicant,
      amount: lc.amount, currency: lc.currency, expiryDate: lc.expiryDate,
      status: lc.status,
      documentCompliance: docs.map((d, i) => ({ docType: d.title, required: true, submitted: lc.status === 'Confirmed', compliant: lc.status === 'Confirmed' ? (i < 5 ? true : null) : null })),
      creatorOrgId: lc.creatorOrgId, createdAt: lc.createdAt,
    });
  }

  const cfgSCs = seedData?.smartContracts ?? [];
  for (const sc of cfgSCs) {
    const c = store.consignments.find(cs => cs.ucr === sc.consignmentUcr);
    if (!c) continue;
    store.smartContracts.push({
      id: genId(), consignmentId: c.id, ucr: c.ucr,
      contractRef: sc.contractRef, contractHash: genHash(),
      payorOrgId: sc.payorOrgId, payeeOrgId: sc.payeeOrgId,
      amount: sc.amount, currency: sc.currency,
      conditions: sc.conditions.map((cond, i) => ({ id: `cond-${i}`, ...cond })),
      status: sc.status, autoRelease: sc.autoRelease, creatorOrgId: sc.payeeOrgId,
      createdAt: sc.createdAt, settledAt: null,
    });
  }

  const seedTs = (t, ts) => {
    if (!store.ledgerLog.some(e => e.details && e.details.includes(t)))
      store.ledgerLog.push({ id: genId(), timestamp: ts, hash: genHash(), type: 'finance', action: 'Finance Seeded', actor: 'System', details: t });
  };
  for (const p of store.payments) {
    const fmtAmt = `${p.currency} ${p.amount.toLocaleString()}`;
    seedTs(`Payment ${p.invoiceRef} created for ${p.ucr}. ${fmtAmt}. ${p.status}.`, p.createdAt);
  }
  for (const lc of store.letterOfCredits) {
    seedTs(`LC ${lc.lcNumber} created for ${lc.ucr}. Amount: ${lc.currency} ${lc.amount.toLocaleString()}. Status: ${lc.status}.`, lc.createdAt);
  }
  for (const sc of store.smartContracts) {
    seedTs(`Contract ${sc.contractRef} deployed for ${sc.ucr}. ${sc.conditions.length} release conditions. Hash: ${sc.contractHash}.`, sc.createdAt);
  }

  console.log(`[${NODE_NAME}] Seeded finance data: ${store.payments.length} payments, ${store.letterOfCredits.length} LCs, ${store.smartContracts.length} smart contracts`);
}
