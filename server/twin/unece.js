/**
 * UNECE D23B consignment transformer (T-305).
 *
 * Maps the demo's flat in-memory consignment shape to and from
 * `ISupplyChainAppConsignment` (UN/CEFACT vocabulary, JSON-LD context
 * https://vocabulary.uncefact.org/unece-context-D23B.jsonld). Used at
 * the adapter boundary so:
 *   - AIG vertex annotations are UNECE-compliant (interop with TWIN
 *     Supply Chain module + downstream gov-interop)
 *   - in-memory store and the React UI keep the flat shape (no UI churn)
 *
 * Two-level structure: a transport `Consignment` wraps one
 * `includedConsignment` (commodity line) with `includedConsignmentItem`
 * (goods line). For the demo each shipment is exactly one commodity, one
 * goods line — multi-line shipments are out of scope.
 *
 * The IOriginComposition extension (Vietnam EVFTA/UKVFTA RoO data) rides
 * under `includedConsignmentItem.additionalProperty` since UNECE D23B has
 * no native field for it. The extension `@context` points at the TWIN
 * supply-chain schema namespace.
 */

const UNECE_CONTEXT = 'https://vocabulary.uncefact.org/unece-context-D23B.jsonld';
const ORIGIN_COMPOSITION_CONTEXT = 'https://schema.twindev.org/supply-chain/origin-composition';

// UN/ECE Rec 20 unit codes. Extend as the demo introduces new commodities.
const UNIT_CODES = {
  pairs: 'PR', pair: 'PR',
  kg: 'KGM', kgm: 'KGM', kilograms: 'KGM', kilo: 'KGM', kilos: 'KGM',
  tons: 'TNE', ton: 'TNE', tonnes: 'TNE', tonne: 'TNE', t: 'TNE',
  pieces: 'EA', piece: 'EA', units: 'EA', unit: 'EA', pcs: 'EA', pc: 'EA',
  liters: 'LTR', litres: 'LTR', liter: 'LTR', litre: 'LTR', l: 'LTR',
  bags: 'BG', bag: 'BG',
  sets: 'SET', set: 'SET',
  cartons: 'CT', carton: 'CT', ctn: 'CT',
  boxes: 'BX', box: 'BX',
};
// Explicit reverse mapping — picks the plural form for round-trip
// consistency with the demo's free-form quantity strings.
const UNIT_CODE_LABELS = {
  PR: 'pairs',
  KGM: 'kg',
  TNE: 'tons',
  EA: 'pieces',
  LTR: 'liters',
  BG: 'bags',
  SET: 'sets',
  CT: 'cartons',
  BX: 'boxes',
};

// Parse free-form quantity ("2,400 pairs", "1000 kg") into the wrapped
// IWrappedQuantity shape required by UNECE. Returns null on inputs that
// don't carry a numeric value so callers can omit the field.
export function parseQuantity(qty) {
  if (qty === null || qty === undefined) return null;
  if (typeof qty === 'number') return { value: qty, unitCode: 'EA' };
  const s = String(qty).trim();
  const match = s.match(/([\d,]+(?:\.\d+)?)\s*(.*)/);
  if (!match) return null;
  const raw = match[1].replace(/,/g, '');
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const unitWord = (match[2] || '').toLowerCase().trim();
  const unitCode = UNIT_CODES[unitWord] || (unitWord ? 'EA' : 'EA');
  return { value, unitCode };
}

// Render IWrappedQuantity back to the demo's free-form string. Used by
// uneceToFlat so the UI receives the same display format it expects.
export function formatQuantity(q) {
  if (!q || q.value === undefined || q.value === null) return '';
  const num = Number(q.value).toLocaleString('en-US');
  const word = UNIT_CODE_LABELS[q.unitCode] ?? (q.unitCode ? q.unitCode.toLowerCase() : '');
  return word ? `${num} ${word}` : num;
}

// "FOB Ho Chi Minh City" -> { incotermsCode: "FOB", locationName: "Ho Chi Minh City" }
function parseIncoterms(incoterms) {
  if (!incoterms) return null;
  const s = String(incoterms).trim();
  const m = s.match(/^([A-Z]{3})\b\s*(.*)$/i);
  if (m && m[1]) {
    const code = m[1].toUpperCase();
    const loc = (m[2] || '').trim();
    return loc
      ? { incotermsCode: code, locationName: loc }
      : { incotermsCode: code };
  }
  return { incotermsCode: s.toUpperCase().slice(0, 3) };
}

function formatIncoterms(dt) {
  if (!dt) return '';
  const code = dt.incotermsCode ?? '';
  const loc = dt.locationName ? ` ${dt.locationName}` : '';
  return `${code}${loc}`.trim();
}

// Demo ships dates as "2026-06-15"; UNECE wants ISO 8601 datetime.
function ensureIsoDateTime(d) {
  if (!d) return null;
  const s = String(d);
  return s.includes('T') ? s : `${s}T00:00:00.000Z`;
}

function extractHsCode(goodsTypeCode) {
  if (!goodsTypeCode) return '';
  return String(goodsTypeCode).replace(/^.*#/, '');
}

// Build the IOriginComposition extension off the seed config's
// inputMaterials shape. Returns null when no composition data is present
// so callers can omit the field cleanly.
function originCompositionFromSeed(origin) {
  const materials = origin?.inputMaterials;
  if (!Array.isArray(materials) || materials.length === 0) return null;
  return {
    '@context': ORIGIN_COMPOSITION_CONTEXT,
    type: 'OriginComposition',
    ...(origin.qualifyingRule && { qualifyingRule: origin.qualifyingRule }),
    ...(origin.totalDomesticContent !== undefined && {
      totalDomesticContent: origin.totalDomesticContent,
    }),
    ...(origin.verificationStatus && { verificationStatus: origin.verificationStatus }),
    components: materials.map((m, idx) => ({
      type: 'OriginComponent',
      sequenceNumeric: idx + 1,
      ...(m.material && { material: m.material }),
      ...(m.hsCode && { hsCode: m.hsCode }),
      ...(m.supplierCountry && { originCountry: m.supplierCountry }),
      ...(m.valuePercent !== undefined && { valueShare: m.valuePercent }),
      ...(m.supplier && { supplier: m.supplier }),
    })),
  };
}

/**
 * Demo flat consignment -> UNECE D23B JSON-LD. Used by the adapter
 * boundary (POST /api/consignments, PUT /api/consignments/:id/status,
 * scripts/seed-twin-nodes.js) when writing to AIG.
 *
 * Fields the demo carries that have no UNECE D23B home (status,
 * exportDeclarationNo) ride under `additionalProperty` so they round-trip
 * losslessly through AIG without breaking schema compliance.
 */
export function consignmentToUnece(c) {
  if (!c) return null;

  const exporterParty = c.exporter ? { type: 'TradeParty', name: c.exporter } : null;
  const importerParty = c.importer ? { type: 'TradeParty', name: c.importer } : null;

  const item = {
    type: 'ConsignmentItem',
    sequenceNumeric: 1,
    ...(c.product && { cargoDescription: c.product }),
    ...(c.hsCode && { goodsTypeCode: `unece:GoodsTypeCodeList#${c.hsCode}` }),
    ...(c.fromCountry && { originCountry: { identificationCode: c.fromCountry } }),
  };
  const originComp = originCompositionFromSeed(c.originComposition);
  if (originComp) item.additionalProperty = [originComp];

  const invoiceAmount = (c.totalValue !== undefined && c.totalValue !== null && c.currency)
    ? { value: c.totalValue, currencyCode: c.currency }
    : null;

  const transactionalReference = c.commercialInvoiceNo
    ? {
        type: 'ReferencedDocument',
        identificationNumber: c.commercialInvoiceNo,
        typeCode: 'unece:DocumentCodeList#380',
      }
    : null;

  const deliveryTerms = parseIncoterms(c.incoterms);

  const includedConsignment = {
    type: 'Consignment',
    ...(exporterParty && { exporterParty }),
    ...(importerParty && { importerParty }),
    ...(invoiceAmount && { invoiceAmount }),
    ...(transactionalReference && { transactionalReference }),
    ...(deliveryTerms && { deliveryTerms }),
    includedConsignmentItem: [item],
  };

  const atDeparture = (c.originPort || c.shipDate)
    ? {
        type: 'TransportMovement',
        ...(c.originPort && { departureLocation: { identifier: c.originPort } }),
        ...(c.shipDate && { plannedDepartureTime: ensureIsoDateTime(c.shipDate) }),
      }
    : null;

  const atArrival = c.destinationPort
    ? {
        type: 'TransportMovement',
        arrivalLocation: { identifier: c.destinationPort },
      }
    : null;

  const carrierParty = c.vessel ? { type: 'TradeParty', name: c.vessel } : null;

  const quantity = parseQuantity(c.quantity);

  const extraProps = [];
  if (c.status) extraProps.push({ type: 'PropertyValue', name: 'demoLifecycleStatus', value: c.status });
  if (c.exportDeclarationNo) extraProps.push({ type: 'PropertyValue', name: 'exportDeclarationNo', value: c.exportDeclarationNo });
  if (c.creatorOrgId) extraProps.push({ type: 'PropertyValue', name: 'creatorOrgId', value: c.creatorOrgId });
  // Node-authoritative read-back: carry the whole demo flat consignment as a
  // JSON blob so the node round-trips it losslessly (the node stores JSON-LD in
  // EXPANDED form, which the field-by-field uneceToFlat() can't reconstruct).
  // flatFromAigVertex() reads this back. The UNECE structure above stays for
  // interop; this blob is the UI's source of truth on read-back.
  extraProps.push({ type: 'PropertyValue', name: 'twinFlatConsignment', value: JSON.stringify(stripFlatForBlob(c)) });

  return {
    '@context': UNECE_CONTEXT,
    type: 'Consignment',
    identifier: c.ucr,
    globalId: c.ucr,
    ...(c.description && { summaryDescription: c.description }),
    ...(quantity && { consignmentItemQuantity: quantity }),
    ...(carrierParty && { carrierParty }),
    ...(atDeparture && { atDepartureTransportMovement: atDeparture }),
    ...(atArrival && { atArrivalTransportMovement: atArrival }),
    includedConsignment: [includedConsignment],
    ...(extraProps.length > 0 && { additionalProperty: extraProps }),
  };
}

/**
 * UNECE D23B JSON-LD -> demo flat consignment. Used by T-308 tests and any
 * future codepath that reads AIG annotations back into the demo's wire
 * format. Round-trips with consignmentToUnece for the fields the demo
 * actually uses.
 */
export function uneceToFlat(unece) {
  if (!unece) return null;
  const included = unece.includedConsignment?.[0];
  const item = included?.includedConsignmentItem?.[0];
  const props = Object.fromEntries(
    (unece.additionalProperty ?? []).map(p => [p.name, p.value]),
  );
  return {
    ucr: unece.identifier ?? '',
    description: unece.summaryDescription ?? '',
    product: item?.cargoDescription ?? '',
    hsCode: extractHsCode(item?.goodsTypeCode),
    fromCountry: item?.originCountry?.identificationCode ?? '',
    quantity: formatQuantity(unece.consignmentItemQuantity),
    exporter: included?.exporterParty?.name ?? '',
    importer: included?.importerParty?.name ?? '',
    totalValue: included?.invoiceAmount?.value ?? null,
    currency: included?.invoiceAmount?.currencyCode ?? '',
    commercialInvoiceNo: included?.transactionalReference?.identificationNumber ?? '',
    incoterms: formatIncoterms(included?.deliveryTerms),
    originPort: unece.atDepartureTransportMovement?.departureLocation?.identifier ?? '',
    destinationPort: unece.atArrivalTransportMovement?.arrivalLocation?.identifier ?? '',
    vessel: unece.carrierParty?.name ?? '',
    shipDate: unece.atDepartureTransportMovement?.plannedDepartureTime ?? '',
    status: props.demoLifecycleStatus ?? 'Draft',
    exportDeclarationNo: props.exportDeclarationNo ?? '',
    creatorOrgId: props.creatorOrgId ?? '',
  };
}

// ── Node-authoritative read-back (flat JSON blob) ──────────────────────────

// Fields NOT carried in the blob: node-side identifiers set after creation
// (would be stale) — the live vertex id is re-attached on read-back.
function stripFlatForBlob(c) {
  const { aigVertexId, aigError, ...rest } = c ?? {};
  return rest;
}

// Read a property's name/value handling BOTH the compacted shape
// ({ name, value }) and the node's stored EXPANDED JSON-LD shape
// ({ 'https://vocabulary.uncefact.org/name': { '@value': … } }).
const UNECE_NAME_IRI = 'https://vocabulary.uncefact.org/name';
const UNECE_VALUE_IRI = 'https://vocabulary.uncefact.org/value';
const unwrap = (v) => (v && typeof v === 'object' && '@value' in v) ? v['@value'] : v;
// next.48 also serves these under the `schema:` vocab prefix (the REST client's
// GET compacts to schema:), so accept name/value, schema:name/schema:value, and
// the expanded UNECE IRI.
const propName = (p) => unwrap(p?.name ?? p?.['schema:name'] ?? p?.[UNECE_NAME_IRI]);
const propValue = (p) => unwrap(p?.value ?? p?.['schema:value'] ?? p?.[UNECE_VALUE_IRI]);

// Reconstruct the demo flat consignment from an AIG vertex (as returned by the
// node's GET /aig or /aig/{id}). Prefers the lossless twinFlatConsignment blob;
// falls back to uneceToFlat for legacy vertices. Re-attaches the live vertex id
// + the UCR alias from the vertex envelope.
export function flatFromAigVertex(vertex) {
  if (!vertex) return null;
  // next.48: the REST client's GET compacts the vertex under the `schema:` vocab
  // (schema:annotationObject / schema:aliases / schema:additionalProperty), while
  // a bare curl returns plain keys. Accept both so the read path works either way.
  const ann = vertex['schema:annotationObject'] ?? vertex.annotationObject ?? vertex;
  const props = ann.additionalProperty ?? ann['schema:additionalProperty'] ?? [];
  let flat = null;
  const blob = props.map((p) => [propName(p), propValue(p)]).find(([n]) => n === 'twinFlatConsignment')?.[1];
  if (typeof blob === 'string') { try { flat = JSON.parse(blob); } catch { /* fall through */ } }
  if (!flat) flat = uneceToFlat(ann); // legacy vertices (compacted) / partial
  if (!flat) return null;
  // The node returns `aliases` as a single object when there's only one.
  const rawAliases = vertex['schema:aliases'] ?? vertex.aliases;
  const aliases = Array.isArray(rawAliases) ? rawAliases : (rawAliases ? [rawAliases] : []);
  const ucrAlias = aliases.find((a) => /ucr/i.test((a?.aliasFormat ?? a?.['schema:aliasFormat']) || ''))?.id;
  return {
    ...flat,
    ucr: flat.ucr || ucrAlias || '',
    aigVertexId: vertex.id ?? flat.aigVertexId ?? null,
  };
}
