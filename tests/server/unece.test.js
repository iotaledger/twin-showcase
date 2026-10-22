import { describe, it, expect } from 'vitest';
import {
  consignmentToUnece,
  uneceToFlat,
  flatFromAigVertex,
  parseQuantity,
  formatQuantity,
} from '../../server/twin/unece.js';

const SAMPLE_DEMO_CONSIGNMENT = {
  id: 'seed-VN-2026-EXP-00301',
  ucr: 'VN-2026-EXP-00301',
  commercialInvoiceNo: 'INV-2026-LBA-0042',
  exportDeclarationNo: 'VN-HCMC-EXP-2026-0342',
  description: 'Athletic Footwear - Running Shoes',
  product: 'Athletic Footwear',
  hsCode: '6402.99',
  quantity: '2,400 pairs',
  totalValue: 156000,
  currency: 'USD',
  exporter: 'Lotus Bay Apparel JSC',
  importer: 'Northpeak Athletics Europe B.V.',
  fromCountry: 'VN',
  toCountry: 'US',
  originPort: 'VNSGN',
  destinationPort: 'USLAX',
  vessel: 'Eastern Star Taurus',
  shipDate: '2026-06-15',
  incoterms: 'FOB Ho Chi Minh City',
  creatorOrgId: 'org-lotusbay',
  creatorOrgName: 'Lotus Bay Apparel JSC',
  status: 'Released',
};

describe('T-305: parseQuantity', () => {
  it('parses "2,400 pairs" with comma + word unit', () => {
    expect(parseQuantity('2,400 pairs')).toEqual({ value: 2400, unitCode: 'PR' });
  });

  it('parses "1000 kg" -> KGM', () => {
    expect(parseQuantity('1000 kg')).toEqual({ value: 1000, unitCode: 'KGM' });
  });

  it('parses bare numbers as EA (each)', () => {
    expect(parseQuantity('500')).toEqual({ value: 500, unitCode: 'EA' });
  });

  it('parses pure-number input', () => {
    expect(parseQuantity(42)).toEqual({ value: 42, unitCode: 'EA' });
  });

  it('returns null for empty / non-numeric strings', () => {
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('lots')).toBeNull();
  });

  it('falls back to EA for unrecognised unit words', () => {
    expect(parseQuantity('100 widgets')).toEqual({ value: 100, unitCode: 'EA' });
  });
});

describe('T-305: formatQuantity', () => {
  it('round-trips parseQuantity output', () => {
    expect(formatQuantity({ value: 2400, unitCode: 'PR' })).toBe('2,400 pairs');
    expect(formatQuantity({ value: 1000, unitCode: 'KGM' })).toBe('1,000 kg');
  });

  it('returns empty string for missing input', () => {
    expect(formatQuantity(null)).toBe('');
    expect(formatQuantity({})).toBe('');
  });
});

describe('T-305: consignmentToUnece', () => {
  it('returns the UNECE D23B JSON-LD context', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    expect(u['@context']).toBe('https://vocabulary.uncefact.org/unece-context-D23B.jsonld');
    expect(u.type).toBe('Consignment');
  });

  it('maps UCR to identifier and globalId', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    expect(u.identifier).toBe('VN-2026-EXP-00301');
    expect(u.globalId).toBe('VN-2026-EXP-00301');
  });

  it('wraps the commodity in a two-level structure', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    expect(u.includedConsignment).toHaveLength(1);
    const included = u.includedConsignment[0];
    expect(included.type).toBe('Consignment');
    expect(included.includedConsignmentItem).toHaveLength(1);
    const item = included.includedConsignmentItem[0];
    expect(item.type).toBe('ConsignmentItem');
    expect(item.cargoDescription).toBe('Athletic Footwear');
    expect(item.goodsTypeCode).toBe('unece:GoodsTypeCodeList#6402.99');
    expect(item.originCountry).toEqual({ identificationCode: 'VN' });
  });

  it('maps parties + invoice on the included consignment', () => {
    const included = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT).includedConsignment[0];
    expect(included.exporterParty).toEqual({ type: 'TradeParty', name: 'Lotus Bay Apparel JSC' });
    expect(included.importerParty).toEqual({ type: 'TradeParty', name: 'Northpeak Athletics Europe B.V.' });
    expect(included.invoiceAmount).toEqual({ value: 156000, currencyCode: 'USD' });
    expect(included.transactionalReference).toEqual({
      type: 'ReferencedDocument',
      identificationNumber: 'INV-2026-LBA-0042',
      typeCode: 'unece:DocumentCodeList#380',
    });
    expect(included.deliveryTerms).toEqual({
      incotermsCode: 'FOB',
      locationName: 'Ho Chi Minh City',
    });
  });

  it('builds atDepartureTransportMovement and atArrivalTransportMovement', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    expect(u.atDepartureTransportMovement.departureLocation).toEqual({ identifier: 'VNSGN' });
    expect(u.atDepartureTransportMovement.plannedDepartureTime).toBe('2026-06-15T00:00:00.000Z');
    expect(u.atArrivalTransportMovement.arrivalLocation).toEqual({ identifier: 'USLAX' });
  });

  it('carrierParty carries the vessel name', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    expect(u.carrierParty).toEqual({ type: 'TradeParty', name: 'Eastern Star Taurus' });
  });

  it('stashes demo-only fields under additionalProperty', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    const props = Object.fromEntries(u.additionalProperty.map(p => [p.name, p.value]));
    expect(props.demoLifecycleStatus).toBe('Released');
    expect(props.exportDeclarationNo).toBe('VN-HCMC-EXP-2026-0342');
    expect(props.creatorOrgId).toBe('org-lotusbay');
  });

  it('attaches IOriginComposition under includedConsignmentItem.additionalProperty', () => {
    const u = consignmentToUnece({
      ...SAMPLE_DEMO_CONSIGNMENT,
      originComposition: {
        qualifyingRule: 'EVFTA Article 15',
        totalDomesticContent: 65,
        verificationStatus: 'verified',
        inputMaterials: [
          { material: 'Synthetic upper fabric', hsCode: '5407.61', supplierCountry: 'VN', valuePercent: 40, supplier: 'Vinatex' },
          { material: 'Rubber sole', hsCode: '4008.21', supplierCountry: 'CN', valuePercent: 25 },
        ],
      },
    });
    const item = u.includedConsignment[0].includedConsignmentItem[0];
    expect(item.additionalProperty).toHaveLength(1);
    const oc = item.additionalProperty[0];
    expect(oc['@context']).toBe('https://schema.twindev.org/supply-chain/origin-composition');
    expect(oc.type).toBe('OriginComposition');
    expect(oc.qualifyingRule).toBe('EVFTA Article 15');
    expect(oc.totalDomesticContent).toBe(65);
    expect(oc.verificationStatus).toBe('verified');
    expect(oc.components).toHaveLength(2);
    expect(oc.components[0]).toMatchObject({
      type: 'OriginComponent',
      sequenceNumeric: 1,
      material: 'Synthetic upper fabric',
      hsCode: '5407.61',
      originCountry: 'VN',
      valueShare: 40,
      supplier: 'Vinatex',
    });
  });

  it('omits optional fields cleanly when the demo data is sparse', () => {
    const u = consignmentToUnece({ ucr: 'MIN-001' });
    expect(u).toEqual({
      '@context': 'https://vocabulary.uncefact.org/unece-context-D23B.jsonld',
      type: 'Consignment',
      identifier: 'MIN-001',
      globalId: 'MIN-001',
      includedConsignment: [{ type: 'Consignment', includedConsignmentItem: [{ type: 'ConsignmentItem', sequenceNumeric: 1 }] }],
      // Node-authoritative read-back: every consignment vertex carries the demo
      // flat shape as a JSON blob so the node round-trips it losslessly.
      additionalProperty: [
        { type: 'PropertyValue', name: 'twinFlatConsignment', value: JSON.stringify({ ucr: 'MIN-001' }) },
      ],
    });
  });

  it('returns null on null input', () => {
    expect(consignmentToUnece(null)).toBeNull();
  });
});

describe('flatFromAigVertex (node-authoritative read-back)', () => {
  it('losslessly reconstructs the flat consignment from a vertex (compacted annotation)', () => {
    const annotationObject = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    const flat = flatFromAigVertex({
      id: 'aig:abc123',
      aliases: [{ id: SAMPLE_DEMO_CONSIGNMENT.ucr, aliasFormat: 'urn:corridor:ucr' }],
      annotationObject,
    });
    // Every UI field round-trips via the blob (not the lossy field-by-field path).
    expect(flat.ucr).toBe(SAMPLE_DEMO_CONSIGNMENT.ucr);
    expect(flat.product).toBe('Athletic Footwear');
    expect(flat.exporter).toBe('Lotus Bay Apparel JSC');
    expect(flat.totalValue).toBe(156000);
    expect(flat.status).toBe(SAMPLE_DEMO_CONSIGNMENT.status);
    expect(flat.creatorOrgId).toBe('org-lotusbay');
    // The live vertex id is re-attached as aigVertexId.
    expect(flat.aigVertexId).toBe('aig:abc123');
  });

  it('reads the blob from the node EXPANDED JSON-LD form (IRI-keyed @value props)', () => {
    const blob = JSON.stringify({ ucr: 'VN-X', product: 'Tea', creatorOrgId: 'org9', status: 'In Transit' });
    const vertex = {
      id: 'aig:exp1',
      aliases: [{ id: 'VN-X', aliasFormat: 'urn:corridor:ucr' }],
      annotationObject: {
        type: 'https://vocabulary.uncefact.org/Consignment',
        additionalProperty: [
          {
            type: 'PropertyValue',
            'https://vocabulary.uncefact.org/name': { type: 'xsd:string', '@value': 'twinFlatConsignment' },
            'https://vocabulary.uncefact.org/value': { type: 'xsd:string', '@value': blob },
          },
        ],
      },
    };
    const flat = flatFromAigVertex(vertex);
    expect(flat.ucr).toBe('VN-X');
    expect(flat.product).toBe('Tea');
    expect(flat.creatorOrgId).toBe('org9');
    expect(flat.aigVertexId).toBe('aig:exp1');
  });

  it('returns null for a null vertex', () => {
    expect(flatFromAigVertex(null)).toBeNull();
  });
});

describe('T-305: uneceToFlat (round-trip)', () => {
  it('reverses consignmentToUnece for the fields the UI consumes', () => {
    const u = consignmentToUnece(SAMPLE_DEMO_CONSIGNMENT);
    const flat = uneceToFlat(u);
    expect(flat.ucr).toBe(SAMPLE_DEMO_CONSIGNMENT.ucr);
    expect(flat.description).toBe(SAMPLE_DEMO_CONSIGNMENT.description);
    expect(flat.product).toBe(SAMPLE_DEMO_CONSIGNMENT.product);
    expect(flat.hsCode).toBe(SAMPLE_DEMO_CONSIGNMENT.hsCode);
    expect(flat.quantity).toBe(SAMPLE_DEMO_CONSIGNMENT.quantity);
    expect(flat.exporter).toBe(SAMPLE_DEMO_CONSIGNMENT.exporter);
    expect(flat.importer).toBe(SAMPLE_DEMO_CONSIGNMENT.importer);
    expect(flat.fromCountry).toBe(SAMPLE_DEMO_CONSIGNMENT.fromCountry);
    expect(flat.totalValue).toBe(SAMPLE_DEMO_CONSIGNMENT.totalValue);
    expect(flat.currency).toBe(SAMPLE_DEMO_CONSIGNMENT.currency);
    expect(flat.originPort).toBe(SAMPLE_DEMO_CONSIGNMENT.originPort);
    expect(flat.destinationPort).toBe(SAMPLE_DEMO_CONSIGNMENT.destinationPort);
    expect(flat.vessel).toBe(SAMPLE_DEMO_CONSIGNMENT.vessel);
    expect(flat.commercialInvoiceNo).toBe(SAMPLE_DEMO_CONSIGNMENT.commercialInvoiceNo);
    expect(flat.incoterms).toBe(SAMPLE_DEMO_CONSIGNMENT.incoterms);
    expect(flat.status).toBe(SAMPLE_DEMO_CONSIGNMENT.status);
    expect(flat.exportDeclarationNo).toBe(SAMPLE_DEMO_CONSIGNMENT.exportDeclarationNo);
    expect(flat.creatorOrgId).toBe(SAMPLE_DEMO_CONSIGNMENT.creatorOrgId);
  });

  it('returns null on null input', () => {
    expect(uneceToFlat(null)).toBeNull();
  });

  it('defaults missing demoLifecycleStatus to "Draft"', () => {
    const u = consignmentToUnece({ ucr: 'X-1', product: 'Widgets' });
    expect(uneceToFlat(u).status).toBe('Draft');
  });
});
