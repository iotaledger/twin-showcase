// T-4V03 (WP4) — public, unauthenticated document verification.
//
// The off-platform requirement (call-prep A4, Minireport criticality 3): a
// destination customs officer with NO demo account scans the QR printed on
// a document and lands on /verify/:docId. That page calls this endpoint.
//
// Disclosure rule: INTEGRITY METADATA ONLY. The endpoint never serves the
// document blob, the consignment business data, values or parties beyond
// the issuer. The permission model for everything else is unchanged.
import { Router } from 'express';
import { store, NODE_ID, NODE_NAME } from '../store.js';
import { getConfig } from '../config.js';
import { liveVerifyDoc, resolveIssuerOrg } from '../lib/verification.js';

const router = Router();

router.get('/api/public/verify/:docId', async (req, res) => {
  const doc = store.documents.find(d => d.id === req.params.docId);
  if (!doc) {
    // Unknown id — the tamper/forgery beat. 404 with a typed body so the
    // page renders the red state instead of a generic error.
    return res.status(404).json({ status: 'unknown', error: 'No record for this document id on this node', node: NODE_ID });
  }

  // Best-effort live verification of the on-chain proof. Failure (TWIN
  // unreachable, simulated mode) degrades to the stored state — the page
  // labels the difference.
  const { verified: liveVerified, error: liveError } = await liveVerifyDoc(doc);

  const docTypes = getConfig()?.documentTypes ?? {};
  const consignment = store.consignments.find(c => c.id === doc.consignmentId);
  const issuerOrg = resolveIssuerOrg(doc);

  res.json({
    status: 'found',
    node: NODE_ID,
    nodeName: NODE_NAME,
    document: {
      id: doc.id,
      docType: doc.docType,
      title: doc.title,
      reference: doc.reference ?? null,
      format: doc.format ?? null,
      issuedAt: doc.timestamp ?? null,
      issuer: doc.issuer ?? doc.creatorOrgName ?? null,
      issuerDid: issuerOrg?.did ?? null,
      uneceCode: docTypes[doc.docType]?.uneceCode ?? null,
      sourceSystem: docTypes[doc.docType]?.sourceSystem ?? null,
      // UCR only — a cross-system reference, not business data.
      ucr: consignment?.ucr ?? null,
    },
    integrity: {
      sha256: doc.hash ?? null,
      notarizationMode: doc.notarizationMode ?? null,
      proofId: doc.proofId ?? null,
      explorerUrl: doc.proofExplorerUrl ?? null,
      anchorObjectId: doc.receipt?.objectId ?? null,
      verified: doc.proofVerified ?? false,
      lastVerifiedAt: doc.lastVerifiedAt ?? null,
      liveVerified,
      liveError,
      notarizationNode: doc.notarizationNode ?? null,
      orgAttestationExplorerUrl: doc.orgAttestationExplorerUrl ?? null,
    },
  });
});

export default router;
