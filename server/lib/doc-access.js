// Per-document-type PUBLIC access policy for the QR / border view.
//
// A document type's `publicAccess` (in the corridor config's documentTypes)
// decides what a holder of a shipment/verify link — a non-account-holder, e.g.
// a border officer — may see:
//   'content' — verification + the FULL document content (the border dossier
//               the owner intends inspectors to read: invoice, packing list,
//               certificate of origin, export declaration, transport doc, …)
//   'verify'  — verification metadata ONLY; content is NOT disclosed (e.g.
//               Bill of Material — supplier cost/origin breakdown; internal
//               working drafts)
//   'none'    — not exposed on the public view at all
//
// DENY-BY-DEFAULT: an unknown / unconfigured type falls back to 'verify'
// (never exposes content) — so a new doc type can't leak content by omission.
import { getConfig } from '../config.js';

export const DEFAULT_PUBLIC_ACCESS = 'verify';

export function docPublicAccess(docType) {
  const v = getConfig()?.documentTypes?.[docType]?.publicAccess;
  return v === 'content' || v === 'verify' || v === 'none' ? v : DEFAULT_PUBLIC_ACCESS;
}

// May a holder of a public link view this doc's CONTENT?
export function canViewContent(docType) {
  return docPublicAccess(docType) === 'content';
}

// Should this doc appear at all on the public view (verify or content)?
export function isPublicListed(docType) {
  return docPublicAccess(docType) !== 'none';
}
