import { getConfig } from '../config.js';
import { qrPdfOps } from '../qr.js';
import { buildSinglePagePdf, escapePdfText } from './pdf-core.js';

// T-4V03 (WP4): verification QR, bottom-right, drawn as vector rects (the
// raw-stream generator has no image support). The QR encodes the public
// verify URL — NOT the document hash: the QR is printed inside the PDF
// whose bytes get hashed, so a hash-carrying payload would be circular.
// The caption is a separate text block under the code.
function qrBlock(verifyUrl) {
  if (!verifyUrl) return '';
  const { ops } = qrPdfOps(verifyUrl, { x: 476, y: 56, size: 96 });
  const caption =
    `BT\n/F1 6.5 Tf\n476 46 Td\n(Scan to verify) Tj\nET\n` +
    `BT\n/F1 6.5 Tf\n476 38 Td\n(TWIN Trade Corridor) Tj\nET`;
  return `\n${ops}\n${caption}`;
}

export function makeSeedPdf(docType, ref, issuer, ucr, shipDate, exporter, importer, fromCountry, toCountry, opts = {}) {
  const cfgTemplate = getConfig()?.documentTemplates?.pdfTemplates?.[docType];
  if (cfgTemplate?.lines) {
    const vars = { ref, shipDate, exporter, importer, ucr, fromCountry, toCountry, issuer };
    const templateLines = cfgTemplate.lines.map(line =>
      line.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '')
    );
    const body = templateLines
      .map(l => `(${escapePdfText(l)}) Tj T*`)
      .join('\n');
    const stream = `BT\n/F1 11 Tf\n72 720 Td\n14 TL\n` + body + `\nET` + qrBlock(opts.verifyUrl);
    return buildSinglePagePdf(stream);
  }

  const lines = {
    'Commercial Invoice': [
      `COMMERCIAL INVOICE`, ``,
      `Invoice No : ${ref}`, `Date       : ${shipDate}`,
      `Exporter   : ${exporter}`, `Importer   : ${importer}`,
      `UCR        : ${ucr}`, `Route      : ${fromCountry} to ${toCountry}`,
      ``, `This document serves as the commercial invoice for the above shipment.`,
    ],
    'Packing List': [
      `PACKING LIST`, ``,
      `Reference  : ${ref}`, `Date       : ${shipDate}`,
      `Exporter   : ${exporter}`, `UCR        : ${ucr}`,
      ``, `Package details are as per the accompanying commercial invoice.`,
    ],
    'Bill of Lading': [
      `BILL OF LADING`, ``,
      `B/L No     : ${ref}`, `Date       : ${shipDate}`,
      `Shipper    : ${exporter}`, `Consignee  : ${importer}`,
      `UCR        : ${ucr}`,
      `Port of Loading    : ${fromCountry}`, `Port of Discharge  : ${toCountry}`,
      ``, `Received in apparent good order and condition the goods described herein.`,
    ],
    'Certificate of Origin': [
      `CERTIFICATE OF ORIGIN`, ``,
      `Certificate No : ${ref}`, `Date           : ${shipDate}`,
      `Issued by      : ${issuer}`, `Exporter       : ${exporter}`,
      `UCR            : ${ucr}`, `Country of Origin : ${fromCountry}`,
      ``, `We hereby certify that the goods described in this document`,
      `originate in ${fromCountry} and comply with all applicable regulations.`,
    ],
    'Export Declaration': [
      `EXPORT DECLARATION`, ``,
      `Declaration No : ${ref}`, `Date           : ${shipDate}`,
      `Declarant      : ${issuer}`, `Exporter       : ${exporter}`,
      `UCR            : ${ucr}`,
      `Country of Export : ${fromCountry}`, `Country of Destination : ${toCountry}`,
    ],
    'Inspection Report': [
      `QUALITY INSPECTION REPORT`, ``,
      `Report No    : ${ref}`, `Date         : ${shipDate}`,
      `Inspector    : ${issuer}`, `Manufacturer : ${exporter}`,
      `UCR          : ${ucr}`, ``, `RESULT: PASS`,
    ],
    'Bill of Material': [
      `BILL OF MATERIAL`, ``,
      `Reference    : ${ref}`, `Date         : ${shipDate}`,
      `Manufacturer : ${exporter}`, `UCR          : ${ucr}`,
    ],
  };
  const body = (lines[docType] || [`${docType}`, ``, `Reference: ${ref}`, `Issuer: ${issuer}`, `UCR: ${ucr}`])
    .map(l => `(${escapePdfText(l)}) Tj T*`)
    .join('\n');

  const stream = `BT\n/F1 11 Tf\n72 720 Td\n14 TL\n` + body + `\nET` + qrBlock(opts.verifyUrl);
  return buildSinglePagePdf(stream);
}
