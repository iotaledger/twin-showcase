// Client mirror of server/qr.js — the URL builders + payload encoder shared by
// the QR affordances (VerifyQr, ShipmentQr). Keeping one copy avoids the
// drift that caused the UTF-8 crash (the encoder was duplicated per component).

// UTF-8-safe base64url. Plain btoa() throws InvalidCharacterError on non-Latin1
// characters — the shipment payload carries "→" and org names carry diacritics
// in some corridors — so encode the UTF-8 bytes first.
export function b64url(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Document verification QR → public /verify/:docId page (metadata only).
export function buildClientVerifyUrl(doc, nodeId) {
  const payload = b64url({
    v: 1, docId: doc.id, ucr: doc.ucr ?? null, docType: doc.docType,
    issuer: doc.issuer ?? doc.creatorOrgName ?? null, node: nodeId,
  });
  return `${window.location.origin}/verify/${encodeURIComponent(doc.id)}?node=${nodeId}#${payload}`;
}

// Shipment QR → public /shipment/:id border dossier (one consignment).
export function buildClientShipmentUrl(c, nodeId) {
  const route = c.fromCountry && c.toCountry ? `${c.fromCountry} → ${c.toCountry}` : undefined;
  const payload = b64url({
    v: 1, id: c.id, ucr: c.ucr, exporter: c.exporter, importer: c.importer, route, node: nodeId,
  });
  return `${window.location.origin}/shipment/${encodeURIComponent(c.id)}?node=${nodeId}#${payload}`;
}
