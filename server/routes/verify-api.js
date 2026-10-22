// T-4V03 (WP3) — system-to-system verification API.
//
// The artifact behind the "data contributor / interoperability beneficiary"
// conversation: a customs declaration system (national or regional) calls
// these endpoints to pull verification
// for the supporting documents of a declaration — feeding ITS OWN risk
// engine. Channeling stays 100% the authority's decision; the API returns
// data and a transparent recommendation, never a verdict.
//
// Auth mirrors TWIN Cloud's integrator model: a service-account token in the
// `x-service-token` header. Demo default: `demo-customs-integration`
// (override with VERIFY_API_TOKENS, comma-separated). Swagger UI: /api/verify/docs
import { Router } from 'express';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';
import { store } from '../store.js';
import { getConfig } from '../config.js';
import { sha256OfBuffer } from '../utils.js';
import { dossierState, simulateChannel, CHANNEL_BASE_RATES } from './customs.js';
import { liveVerifyDoc, resolveIssuerOrg } from '../lib/verification.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = Router();

export function serviceTokens() {
  return (process.env.VERIFY_API_TOKENS ?? 'demo-customs-integration')
    .split(',').map(t => t.trim()).filter(Boolean);
}

function tokenAuth(req, res, next) {
  const token = req.headers['x-service-token'];
  if (!token || !serviceTokens().includes(token)) {
    return res.status(401).json({ error: 'Missing or invalid x-service-token (service-account token)' });
  }
  next();
}

function normHash(h) {
  return (h ?? '').toString().toLowerCase().replace(/^0x/, '');
}

async function liveVerify(doc) {
  return (await liveVerifyDoc(doc)).verified;
}

function docVerification(doc, live = null) {
  const docTypes = getConfig()?.documentTypes ?? {};
  const consignment = store.consignments.find(c => c.id === doc.consignmentId);
  const issuerOrg = resolveIssuerOrg(doc);
  return {
    docId: doc.id,
    docType: doc.docType,
    reference: doc.reference ?? null,
    uneceCode: docTypes[doc.docType]?.uneceCode ?? null,
    issuerName: doc.issuer ?? doc.creatorOrgName ?? null,
    issuerDid: issuerOrg?.did ?? null,
    ucr: consignment?.ucr ?? null,
    sha256: doc.hash ?? null,
    anchored: Boolean(doc.proofId),
    verified: live ?? (doc.proofVerified ?? false),
    // Simulated mode carries no real proofs: when the seeded dossier is
    // flagged verified, surface that as simulated provenance so the caller
    // can label it honestly instead of reading "no proof" next to a
    // verified dossier.
    simulatedProvenance: !doc.proofId
      && store.adapter?.mode === 'simulated'
      && (consignment?.customs?.dossierVerified ?? false),
    notarizationMode: doc.notarizationMode ?? null,
    explorerUrl: doc.proofExplorerUrl ?? null,
    anchoredAt: doc.timestamp ?? null,
  };
}

// ── POST /api/verify/document ──────────────────────────────────────────
// Lookup by content hash (the integrator hashes the file it received), by
// docId, or by uploading the file itself (multipart `file`).
router.post('/api/verify/document', tokenAuth, upload.single('file'), async (req, res) => {
  let doc = null;
  let queriedHash = null;
  if (req.file) {
    queriedHash = normHash(sha256OfBuffer(req.file.buffer));
    doc = store.documents.find(d => normHash(d.hash) === queriedHash);
  } else if (req.body?.sha256) {
    queriedHash = normHash(req.body.sha256);
    doc = store.documents.find(d => normHash(d.hash) === queriedHash);
  } else if (req.body?.docId) {
    doc = store.documents.find(d => d.id === req.body.docId);
  } else {
    return res.status(400).json({ error: 'Provide sha256, docId, or a multipart file' });
  }

  if (!doc) {
    return res.json({
      found: false,
      queriedHash,
      verdict: 'unknown',
      detail: 'No registered document matches — the file may be altered, forged, or registered on the peer node.',
    });
  }
  const live = await liveVerify(doc);
  res.json({ found: true, verdict: (live ?? doc.proofVerified) ? 'verified' : doc.proofId ? 'anchored' : 'registered', ...docVerification(doc, live) });
});

// ── GET /api/verify/consignment/:ref ───────────────────────────────────
// Dossier-level status by UCR or customs declaration number. This is what a
// risk engine would pull per declaration.
router.get('/api/verify/consignment/:ref', tokenAuth, async (req, res) => {
  const ref = req.params.ref;
  const c = store.consignments.find(x => x.ucr === ref || x.customs?.declarationNo === ref || x.declRef === ref);
  if (!c) return res.status(404).json({ error: `No consignment matches '${ref}' (UCR or declaration number)` });

  const docs = store.documents.filter(d => d.consignmentId === c.id);
  const verifications = [];
  for (const d of docs) {
    const live = await liveVerify(d);
    verifications.push(docVerification(d, live));
  }
  const state = dossierState(c);
  const sim = simulateChannel(c, state);
  res.json({
    ucr: c.ucr,
    declarationNo: c.customs?.declarationNo ?? null,
    declarationType: c.customs?.declarationType ?? null,
    customsOffice: c.customs?.customsOffice ?? null,
    channel: c.customs?.channel ?? null,
    status: c.status,
    dossier: state,
    originComposition: c.originComposition
      ? {
          localContentPercent: c.originComposition.localContentPercent,
          calculationMethod: c.originComposition.calculationMethod,
          threshold: c.originComposition.threshold,
          evidenceIncomplete: c.originComposition.evidenceIncomplete ?? false,
        }
      : null,
    documents: verifications,
    // Transparent demo heuristic, not a decision: verified dossier with no
    // data inconsistency and complete origin evidence supports green.
    channelRecommendation: {
      recommended: sim.simulatedChannel,
      basis: state.dossierVerified
        ? 'All notarization-required supporting documents are provenance-backed'
        : 'Dossier not fully provenance-backed - manual document review applies',
      decisionOwner: 'The channeling decision remains with the customs authority',
      baseRates: CHANNEL_BASE_RATES,
    },
  });
});

// ── OpenAPI spec + Swagger UI ──────────────────────────────────────────
const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'TWIN Trade Corridor — customs verification API',
    version: '1.0.0',
    description:
      'System-to-system verification for customs declaration systems and other integrators. '
      + 'Pull provenance verification for the supporting documents of a declaration and feed your own risk engine. '
      + 'The channeling decision always remains with the authority.\n\n'
      + '**Auth:** send the service-account token in the `x-service-token` header. Demo token: `demo-customs-integration`.',
  },
  servers: [{ url: '/', description: 'this demo node' }],
  components: {
    securitySchemes: {
      ServiceToken: { type: 'apiKey', in: 'header', name: 'x-service-token', description: 'Service-account token (demo: demo-customs-integration)' },
    },
  },
  security: [{ ServiceToken: [] }],
  paths: {
    '/api/verify/document': {
      post: {
        summary: 'Verify a single document by hash, id, or file',
        description: 'Lookup by `sha256` (hash the file you received), by `docId` (from a QR payload), or upload the file itself as multipart `file` — the node hashes it server-side. Returns provenance verdict: verified / anchored / registered / unknown.',
        requestBody: {
          content: {
            'application/json': {
              example: { sha256: '0x…64 hex chars…' },
              schema: { type: 'object', properties: { sha256: { type: 'string' }, docId: { type: 'string' } } },
            },
            'multipart/form-data': {
              schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
            },
          },
        },
        responses: { 200: { description: 'Verification result' }, 401: { description: 'Missing/invalid service token' } },
      },
    },
    '/api/verify/consignment/{ref}': {
      get: {
        summary: 'Dossier-level verification by UCR or declaration number',
        parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' }, example: 'VN-2026-EXP-00101' }],
        responses: {
          200: { description: 'Per-document verification + origin composition + transparent channel recommendation' },
          404: { description: 'Unknown consignment' },
          401: { description: 'Missing/invalid service token' },
        },
      },
    },
  },
};

router.get('/api/verify/openapi.json', (_req, res) => res.json(OPENAPI_SPEC));
router.use('/api/verify/docs', swaggerUi.serveFiles(OPENAPI_SPEC), swaggerUi.setup(OPENAPI_SPEC, {
  customSiteTitle: 'Customs verification API — TWIN demo',
}));

export default router;
