import { Router } from 'express';
import multer from 'multer';
import { genId, genHash, sha256OfBuffer, explorerUrlFromImmutableProof, extractImmutableReceipt, iotaExplorerUrlFromAttestationId, now } from '../utils.js';
import { store, addLog, mirrorDocumentToPeer, NODE_ID } from '../store.js';
import { getUrnNamespace } from '../config.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = Router();

// Map the demo docType strings (UI dropdown values) to UN/EDIFACT
// document codes consumed by the TWIN document-management endpoint.
// Anything unknown falls back to "Other administrative documents" (190).
const UNECE_DOCUMENT_CODE_BY_TYPE = {
  'General':                  'unece:DocumentCodeList#190',
  'Commercial Invoice':       'unece:DocumentCodeList#380',
  'Packing List':             'unece:DocumentCodeList#271',
  'Bill of Lading':           'unece:DocumentCodeList#705',
  'Certificate of Origin':    'unece:DocumentCodeList#861',
  'Export Declaration':       'unece:DocumentCodeList#423',
  'Import Declaration':       'unece:DocumentCodeList#496',
  'Health Certificate':       'unece:DocumentCodeList#636',
  'Phytosanitary Certificate':'unece:DocumentCodeList#851',
  'Insurance Certificate':    'unece:DocumentCodeList#520',
};
const UNECE_FALLBACK = 'unece:DocumentCodeList#190';

router.get('/api/documents', (req, res) => {
  const { orgId, consignmentId } = req.query;
  let docs = store.documents;
  if (consignmentId) docs = docs.filter(d => d.consignmentId === consignmentId);
  if (orgId) {
    docs = docs.filter(d => {
      const cp = store.permissions[d.consignmentId] || {};
      if (cp[orgId] === 'owner' || d.creatorOrgId === orgId) return true;
      const dp = store.docPermissions[d.id] || {};
      if (dp[orgId]) return true; // explicit per-doc (selective) grant on THIS doc
      // Is THIS org restricted to specific docs — i.e. was it given a SELECTIVE
      // share (per-doc grants on some docs of this consignment)? Only then do we
      // hide the docs it wasn't granted. A FULL consignment viewer has no per-doc
      // grants at all and therefore sees every doc (including ones uploaded after
      // the share). Keyed PER-VIEWER, not globally — a downstream selective share
      // to another org must not hide docs from a full viewer.
      const orgHasPerDocGrant = store.documents
        .filter(dd => dd.consignmentId === d.consignmentId)
        .some(dd => (store.docPermissions[dd.id] || {})[orgId]);
      if (orgHasPerDocGrant) return false;
      return cp[orgId] === 'viewer';
    });
  }
  res.json(docs.map(d => ({ ...d, fileBase64: undefined })));
});

router.post('/api/documents', upload.single('file'), async (req, res) => {
  const { consignmentId, title, docType, creatorOrgId } = req.body;
  const org = store.orgs.find(o => o.id === creatorOrgId);
  const consignment = store.consignments.find(c => c.id === consignmentId);
  if (!org || !consignment) return res.status(400).json({ error: 'Not found' });

  let fileBase64 = null, filename = null, fileSize = 0;
  let hash = genHash();
  if (req.file) {
    fileBase64 = req.file.buffer.toString('base64');
    filename = req.file.originalname;
    fileSize = req.file.size;
    hash = sha256OfBuffer(req.file.buffer);
  }

  const id = genId();
  const timestamp = now();

  // Notarize the document metadata via the adapter (T-214). The TWIN node
  // hashes the JSON-LD object and anchors that hash on IOTA. We keep the
  // raw SHA-256 of the content in the `hash` field for audit/display.
  let proofId = null;
  let proofExplorerUrl = null;
  let receipt = null;
  let documentManagementId = null;
  const notarizationMode = store.adapter?.mode ?? 'simulated';
  let notarizationError = null;
  let documentStorageError = null;

  // The envelope is the JSON-LD object whose hash becomes the on-chain
  // `proofIntegrity`. We persist it on the doc record so the user can
  // verify the full chain (file → fingerprint → envelope → on-chain hash)
  // without depending on the TWIN node's internal storage. The creator's
  // DID is embedded as `creator.identifier` so the envelope carries both
  // human-readable name AND the cryptographic identifier of the issuer.
  const envelope = {
    '@context': 'https://schema.org',
    '@type': 'DigitalDocument',
    identifier: id,
    name: title,
    contentSize: fileSize,
    sha256: hash,
    dateCreated: timestamp,
    creator: {
      '@type': 'Organization',
      name: org.name,
      ...(org.did ? { identifier: org.did } : {}),
    },
    about: { '@type': 'Thing', identifier: consignment.ucr },
  };

  try {
    const result = await store.adapter.createImmutableProof(envelope);
    proofId = result.proofId;
    // Best-effort: fetch the proof immediately to extract the on-chain
    // reference + receipt details (objectId / network / epoch / digest /
    // smartContractId). The shape varies across TWIN node versions, so
    // both helpers deep-walk the object tree.
    try {
      const proof = await store.adapter.getImmutableProof(proofId);
      proofExplorerUrl = explorerUrlFromImmutableProof(proof);
      receipt = extractImmutableReceipt(proof);
    } catch { /* harmless: link + receipt will be derived later by /verify */ }
  } catch (e) {
    notarizationError = e.message;
  }

  // T-1b: org-signed attestation of the document envelope. The TWIN
  // immutable-proof above is always signed by the node admin DID; this
  // attestation is signed by the creator org's own DID, anchoring "this
  // organisation attested this document" on chain alongside the node's
  // notary stamp. Skipped silently if the org never provisioned a TWIN
  // user (e.g. simulated mode or a non-registered seeded org).
  let orgAttestationId = null;
  let orgAttestationExplorerUrl = null;
  let orgAttestationError = null;
  if (org.twinCredentials?.email && org.twinCredentials?.password && proofId) {
    try {
      const r = await store.adapter.createAttestationAs(
        {
          orgId: org.id,
          email: org.twinCredentials.email,
          password: org.twinCredentials.password,
          did: org.did,
          // T-316: org's own tenant key (tenant-per-org). null for
          // REST-provisioned orgs → adapter falls back to the node tenant key.
          tenantApiKey: org.twinCredentials.tenantApiKey,
        },
        envelope,
      );
      orgAttestationId = r.attestationId;
      orgAttestationExplorerUrl = iotaExplorerUrlFromAttestationId(orgAttestationId);
    } catch (e) {
      orgAttestationError = e.message;
    }
  }

  // T-215: also push the blob through the TWIN composite document-management
  // endpoint (blob storage + AIG audit trail + optional attestation). Only
  // when we actually have a blob; metadata-only docs skip storage.
  if (req.file) {
    try {
      const storeResult = await store.adapter.storeDocument(req.file.buffer, {
        documentId: id,
        documentCode: UNECE_DOCUMENT_CODE_BY_TYPE[docType] ?? UNECE_FALLBACK,
        filename,
        title,
        contentType: req.file.mimetype,
        sha256: hash,
        creator: { name: org.name },
        relatedTo: consignment.ucr,
        // The org-signed attestation is created separately above
        // (Task 1b). The composite endpoint's bundled attestation
        // doubles the IOTA round-trip and frequently fails with a 500
        // even on small files — skipping it makes the composite call
        // reliably succeed with just blob storage + AIG vertex.
        createAttestation: false,
      });
      documentManagementId = storeResult.documentManagementId;
    } catch (e) {
      documentStorageError = e.message;
    }
  }

  const doc = {
    id, consignmentId, title, docType: docType || 'General',
    filename, fileBase64, fileSize,
    hash,                        // sha256 of content (real), or random if no file
    envelope,                    // the JSON-LD that TWIN hashed -> proofIntegrity
    proofId,                     // adapter-issued proof identifier (null on notarization failure)
    proofExplorerUrl,            // IOTA Explorer URL for the on-chain anchor (null when no real anchor)
    receipt,                     // {verifiableStorageId,objectId,network,epoch,digest,smartContractId,proofIntegrity} or null
    documentManagementId,        // TWIN AIG vertex id (null in simulated unless adapter mocks it)
    orgAttestationId,            // T-1b: NFT-backed attestation signed by the creator org's DID
    orgAttestationExplorerUrl,   // IOTA Explorer URL for the org-signed attestation
    orgAttestationError,         // populated only when the org attestation call failed
    proofVerified: false,        // updated by POST /api/documents/:id/verify
    lastVerifiedAt: null,
    notarizationMode,            // 'simulated' | 'docker' | 'hosted'
    notarizationError,           // populated only when createImmutableProof failed
    documentStorageError,        // populated only when storeDocument failed
    // T-311: the node whose TWIN holds the immutable proof. Propagated via
    // UPLOAD_DOCUMENT so the peer knows the proofId is on this chain and
    // can disable verify until T-312 implements cross-node verification.
    notarizationNode: NODE_ID,
    creatorOrgId, creatorOrgName: org.name, timestamp,
  };
  store.documents.push(doc);
  consignment.documentCount = store.documents.filter(d => d.consignmentId === consignmentId).length;

  const parts = [];
  if (proofId) parts.push(`proof ${proofId}`);
  if (documentManagementId) parts.push(`document ${documentManagementId}`);
  const anchorDescr = parts.length
    ? `Anchored on the ledger (${parts.join(', ')}).`
    : `Notarization unavailable (${notarizationError || documentStorageError || 'no proof'}); document stored without on-chain proof.`;
  addLog('document', 'Document Anchored', org.name, `"${title}" anchored to ${consignment.ucr}. ${anchorDescr}`, { proofId, documentManagementId, hash });

  // T-245: if this consignment was shared with a peer-node org (alpha
  // shared it with a beta org, or vice versa), notify the peer so its
  // store gains the new doc too. Best-effort: silently drops if the
  // peer WS isn't connected — the doc still lives locally and a future
  // SHARE_CONSIGNMENT (re-share) would replay the full state.
  const grantees = Object.keys(store.permissions[consignmentId] ?? {});
  const peerGranted = grantees.some(orgId => store.peerOrgs.some(po => po.id === orgId));
  if (peerGranted) mirrorDocumentToPeer(consignmentId, doc);

  // T-313: if the consignment is owned by a peer node (i.e. we're
  // writing back to a shared consignment), also emit a DSP Activity Add
  // with the doc inline. The consignment owner's TWIN ingests the
  // notification and appends the doc to the AIG vertex. Fire-and-forget
  // so the API response stays sync. Only fires when the local consignment
  // record carries originNode set by T-311 (i.e. we received the
  // consignment via SHARE_CONSIGNMENT or DSP — we don't own it).
  if (consignment.originNode && consignment.originNode !== NODE_ID
      && store.adapter && store.adapter.mode !== 'simulated') {
    (async () => {
      try {
        // Owner-side org: look up the consignment creator in peerOrgs.
        const ownerOrg =
          store.peerOrgs.find(o => o.id === consignment.creatorOrgId)
          ?? { id: consignment.creatorOrgId, name: consignment.creatorOrgName, did: null };
        await store.adapter.dspNotifyDocumentUpload({
          doc: { ...doc, fileBase64: undefined },
          consignment,
          writerOrg: org,
          ownerOrg,
          urnNamespace: getUrnNamespace(),
        });
      } catch (e) {
        console.warn(`[documents] DSP notifyDocumentUpload failed for ${id}: ${e.message}`);
      }
    })();
  }

  res.json({ ...doc, fileBase64: undefined });
});

// Returns the full immutable-proof VC fetched live from the TWIN node.
// Used by the UI "Show full on-chain VC" expand to display the complete
// W3C VerifiableCredential (issuer, credentialSubject.proofIntegrity,
// proof.proofValue, proof.immutableReceipt, ...). Lazy-loaded — only
// hits TWIN when the user expands the section.
router.get('/api/documents/:id/proof', async (req, res) => {
  const doc = store.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!doc.proofId) return res.status(400).json({ error: 'Document has no proof' });
  // T-311: this proof lives on the peer's TWIN — local node cannot resolve
  // it. T-312 will route the lookup via DSP data plane query.
  if (doc.notarizationNode && doc.notarizationNode !== NODE_ID) {
    return res.status(409).json({
      error: 'Proof anchored on peer node',
      notarizationNode: doc.notarizationNode,
      supportedIn: 'T-312',
    });
  }
  try {
    const proof = await store.adapter.getImmutableProof(doc.proofId);
    res.json({ proofId: doc.proofId, proof });
  } catch (e) {
    res.status(502).json({ error: 'TWIN Node unavailable', mode: store.adapter?.mode, detail: e.message });
  }
});

router.post('/api/documents/:id/verify', async (req, res) => {
  const doc = store.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!doc.proofId) return res.status(400).json({ error: 'Document has no proof to verify', detail: doc.notarizationError });
  // T-312: when the proof was anchored on the peer's TWIN, ask the adapter
  // to verify it across nodes (DSP query first, IOTA on-chain fallback).
  // The route still returns 409 when even the on-chain fallback is
  // unavailable so the UI can keep its T-311 disabled state in those cases.
  if (doc.notarizationNode && doc.notarizationNode !== NODE_ID) {
    try {
      const result = await store.adapter.verifyCrossNodeProof({
        proofId: doc.proofId,
        notarizationNode: doc.notarizationNode,
        receipt: doc.receipt ?? null,
      });
      if (result?.verified) {
        doc.proofVerified = true;
        doc.lastVerifiedAt = now();
        return res.json({
          proofVerified: true,
          lastVerifiedAt: doc.lastVerifiedAt,
          proofId: doc.proofId,
          proofExplorerUrl: doc.proofExplorerUrl,
          receipt: doc.receipt,
          verificationSource: result.source,
          // Back-compat aliases.
          verified: true,
          verifiedAt: doc.lastVerifiedAt,
        });
      }
      return res.status(409).json({
        error: 'Cross-node verify unavailable',
        notarizationNode: doc.notarizationNode,
        verificationSource: result?.source ?? 'unavailable',
        detail: result?.detail ?? null,
      });
    } catch (e) {
      return res.status(502).json({ error: 'Cross-node verify failed', mode: store.adapter?.mode, detail: e.message });
    }
  }
  try {
    const verified = await store.adapter.verifyImmutableProof(doc.proofId);
    doc.proofVerified = verified;
    doc.lastVerifiedAt = now();
    // Always re-fetch the proof so we pick up the receipt details as soon
    // as TWIN finishes signing (these are populated async, ~5-15s after
    // upload). The explorerUrl + receipt fields update in place.
    try {
      const proof = await store.adapter.getImmutableProof(doc.proofId);
      if (!doc.proofExplorerUrl) doc.proofExplorerUrl = explorerUrlFromImmutableProof(proof);
      const r = extractImmutableReceipt(proof);
      if (r) doc.receipt = r;
    } catch { /* leave existing values if fetch failed */ }
    // T-312: this is a locally-anchored doc (the peer-anchored branch
    // returned above). If its proof just gained an on-chain receipt and the
    // consignment is shared with a peer org, re-send UPLOAD_DOCUMENT so the
    // peer's copy gains receipt.objectId — what its verifyCrossNodeProof
    // IOTA on-chain fallback needs. Best-effort; the peer upserts the fields.
    if (doc.receipt?.objectId) {
      const grantees = Object.keys(store.permissions[doc.consignmentId] ?? {});
      const sharedWithPeer = grantees.some(orgId => store.peerOrgs.some(po => po.id === orgId));
      if (sharedWithPeer) mirrorDocumentToPeer(doc.consignmentId, doc);
    }
    // T-246: response field names must match the doc record fields so the
    // frontend's `{ ...doc, ...result }` merge actually updates
    // `proofVerified` / `lastVerifiedAt` (which `notarizationState()` in
    // NotarizationBadge.jsx reads) instead of grafting on stray `verified`
    // / `verifiedAt` aliases. Keep the old aliases too for any external
    // caller pinned to the previous shape.
    res.json({
      proofVerified: verified,
      lastVerifiedAt: doc.lastVerifiedAt,
      proofId: doc.proofId,
      proofExplorerUrl: doc.proofExplorerUrl,
      receipt: doc.receipt,
      // Back-compat aliases (deprecated):
      verified,
      verifiedAt: doc.lastVerifiedAt,
    });
  } catch (e) {
    res.status(502).json({ error: 'TWIN Node unavailable', mode: store.adapter?.mode, detail: e.message });
  }
});

router.get('/api/documents/:id/download', (req, res) => {
  const doc = store.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!doc.fileBase64) return res.status(404).json({ error: 'File not stored \u2014 upload a real file to enable download' });
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
  res.send(Buffer.from(doc.fileBase64, 'base64'));
});

router.get('/api/documents/:id/xml', (req, res) => {
  const doc = store.documents.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.fileBase64 && doc.filename?.endsWith('.xml')) {
    return res.json({ content: Buffer.from(doc.fileBase64, 'base64').toString('utf-8'), docType: doc.docType });
  }
  res.status(400).json({ error: 'Not an XML file or not available' });
});

export default router;
