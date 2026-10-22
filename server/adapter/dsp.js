// DSP protocol builders — the ODRL policy + W3C Activity Streams documents the
// cross-node federation speaks (T-302/T-313). Pure functions, no adapter state:
// the DockerAdapter's DSP methods orchestrate the network calls and delegate
// the protocol-shaping to these. Centralised here because this is the part that
// churns whenever the TWIN node's data-plane contract moves (see the inline
// "verified live" notes), and it is the part worth unit-testing in isolation.
import { consignmentToUnece } from '../twin/unece.js';

// Neutral, corridor-agnostic URN/policy namespace (matches server/config.js
// DEFAULT_URN_NAMESPACE). The runtime threads the config-resolved namespace in
// via the DSP method inputs; this is the standalone fallback (e.g. tests).
export const DEFAULT_URN_NS = 'corridor';
export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

// Build an ODRL Offer for a consignment share. `targets` is an array of URNs
// (one per document for selective shares, one consignment URN for full shares).
// Matches the pattern the T-218 in-memory stub used so the revoke path can
// locate the policy by its (consignmentId, recipientOrgId) compound key via the
// URN convention.
//
// T-313: each target gets both `use` (read) and `modify` (write) so the
// recipient can upload documents back onto the shared consignment via
// dspNotifyDocumentUpload; the owner-side ingestion is gated on `modify`.
//
// TWIN's PolicyAdministrationPointService validates against three rules the demo
// previously tripped (500 namespaceMismatch / 400 common.validation):
//   1. the policy id's first colon-segment must be `policy` (TWIN id convention,
//      like attestation:nft:…), NOT `urn:…`. `ns` is the SECOND segment.
//   2. `@context` must be the W3C ODRL context as the http:// URL — https:// is rejected.
//   3. an Offer must carry a top-level `assigner`.
export function buildOdrlOfferPolicy({ consignment, recipientOrg, sharerOrg, targets, ns = DEFAULT_URN_NS }) {
  const uid = `policy:${ns}:${consignment.id}:${recipientOrg.id}`;
  const assigner = sharerOrg?.did || `urn:${ns}:org:${sharerOrg?.id ?? 'unknown'}`;
  const assignee = recipientOrg?.did || `urn:${ns}:org:${recipientOrg?.id ?? 'unknown'}`;
  const purposeConstraint = [{
    leftOperand: 'purpose',
    operator: 'eq',
    rightOperand: 'supply-chain-collaboration',
  }];
  const targetList = targets ?? [`urn:${ns}:consignment:${consignment.id}`];
  const permission = [];
  for (const target of targetList) {
    permission.push({ target, action: 'use',    assigner, assignee, constraint: purposeConstraint });
    permission.push({ target, action: 'modify', assigner, assignee, constraint: purposeConstraint });
  }
  return {
    '@context': 'http://www.w3.org/ns/odrl.jsonld',
    '@type': 'Offer',
    uid,
    assigner,
    permission,
    prohibition: [],
    obligation: [],
  };
}

// The TWIN data-plane Activity schema requires `@context` + `type` on every
// agent node (actor/target) as well as the envelope and object. Build a
// conformant Activity-Streams Organization agent from a demo org record.
export function asOrgAgent(org, fallbackId = 'unknown', ns = DEFAULT_URN_NS) {
  return {
    '@context': AS_CONTEXT,
    id: org?.did || `urn:${ns}:org:${org?.id ?? fallbackId}`,
    type: 'Organization',
    name: org?.name ?? '',
  };
}

// T-313: Activity Add for a single document upload against a shared
// consignment. The recipient is the consignment owner (so the activity flows in
// the reverse direction of buildShareActivity). The doc is carried inline under
// `object` (minus its blob) so the owner-side adapter can ingest it without a
// separate transfer step; the proofId rides along for cross-node verify (T-312).
export function buildDocumentUploadActivity({ doc, consignment, writerOrg, ownerOrg, ns = DEFAULT_URN_NS }) {
  const { fileBase64, ...docWithoutBlob } = doc ?? {};
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://schema.twindev.org/dataspace-protocol/'],
    type: 'Add',
    id: `urn:x-doc-upload:${consignment?.id ?? 'unknown'}:${doc?.id ?? 'unknown'}`,
    actor: asOrgAgent(writerOrg, 'unknown', ns),
    target: asOrgAgent(ownerOrg, 'unknown', ns),
    object: {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://schema.org'],
      type: 'Document',
      id: doc?.id ? `urn:doc:${doc.id}` : 'urn:doc:unknown',
      name: docWithoutBlob.name ?? docWithoutBlob.filename ?? 'Document',
      content: docWithoutBlob,
      consignmentRef: {
        type: 'Consignment',
        identifier: consignment?.ucr ?? null,
        id: consignment?.id ?? null,
      },
    },
    context: {
      consignmentId: consignment?.id,
      ucr: consignment?.ucr,
    },
    published: new Date().toISOString(),
  };
}

// Build the Add/Remove share activity. The object IS the UNECE D23B consignment
// (T-305): next.48's data-plane dispatches to a DataspaceApp by matching the
// object's EXPANDED @type against activitiesHandled(); the corridor app handles
// the UNECE Consignment IRI, so a bare UNECE Consignment object fires
// handleActivity where an AS `Document` wrapper does not (verified live).
export function buildShareActivity({ action, consignment, documents, sharerOrg, recipientOrg, policyId, ns = DEFAULT_URN_NS }) {
  const uneceConsignment = consignmentToUnece(consignment);
  const cid = consignment?.ucr ?? consignment?.id ?? 'unknown';
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://schema.twindev.org/dataspace-protocol/'],
    type: action, // "Add" or "Remove"
    id: `urn:x-share:${consignment?.id ?? cid}:${recipientOrg?.id ?? 'unknown'}`,
    // The inbox requires a generator identity (a DID) or it rejects the activity
    // with invalidActivityGeneratorIdentity. Use the sharer org's DID.
    generator: sharerOrg?.did ?? recipientOrg?.did,
    actor: asOrgAgent(sharerOrg, 'unknown', ns),
    target: asOrgAgent(recipientOrg, 'unknown', ns),
    object: {
      // The UNECE D23B consignment itself (carries @context, type, identifier =
      // UCR, and the twinFlatConsignment blob the recipient reads back). Plus the
      // demo doc records minus fileBase64 (blobs never ride the wire).
      ...uneceConsignment,
      id: `urn:consignment:${cid}`,
      attachment: (documents ?? []).map(d => {
        const { fileBase64, ...rest } = d ?? {};
        return { type: 'Document', ...rest };
      }),
    },
    ...(policyId && { context: { policyId } }),
    published: new Date().toISOString(),
  };
}
