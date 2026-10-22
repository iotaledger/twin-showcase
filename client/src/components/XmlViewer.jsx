import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { AlertTriangle, ChevronRight, Loader } from 'lucide-react';

function Section({ title, fields, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!fields || fields.length === 0) return null;
  return (
    <div className="xml-section">
      <div className="xml-section-header" onClick={() => setOpen(o => !o)}>
        <ChevronRight className={`xml-section-icon ${open ? 'open' : ''}`} style={{ width: 14, height: 14 }} />
        <span className="xml-section-title">{title}</span>
      </div>
      {open && (
        <div className="xml-fields">
          {fields.map((f, i) => f.value ? (
            <div key={i} className={`xml-field ${f.full ? 'full' : ''}`}>
              <div className="xml-field-label">{f.label}</div>
              <div className={`xml-field-value ${f.mono !== false ? '' : 'normal'}`}>{f.value}</div>
            </div>
          ) : null)}
        </div>
      )}
    </div>
  );
}

function getText(node, tag) {
  const el = node.querySelector ? node.querySelector(tag) : null;
  return el?.textContent?.trim() || '';
}

function parseBOL(doc) {
  const root = doc.documentElement;
  const get = tag => getText(root, tag);
  return [
    {
      title: 'Transport Document',
      fields: [
        { label: 'Document Reference', value: get('TransportDocumentReference') },
        { label: 'UCR', value: get('ContractQuotationReference') },
        { label: 'Issue Date', value: get('IssueDate') },
        { label: 'Shipped on Board', value: get('ShippedOnBoardDate') },
        { label: 'Issuer Code', value: get('IssuerCode') },
        { label: 'Invoice Reference', value: get('ServiceContractReference') },
      ],
    },
    {
      title: 'Shipper',
      fields: [
        { label: 'Name', value: get('Shipper PartyName'), full: true, mono: false },
        { label: 'Address', value: get('Shipper Address'), full: true, mono: false },
        { label: 'Registration Number', value: get('Shipper RegistrationNumber') },
        { label: 'Tax Identifier', value: get('Shipper TaxIdentifier') },
      ],
    },
    {
      title: 'Consignee',
      fields: [
        { label: 'Name', value: get('Consignee PartyName'), full: true, mono: false },
        { label: 'Address', value: get('Consignee Address'), full: true, mono: false },
        { label: 'Registration Number', value: get('Consignee RegistrationNumber') },
      ],
    },
    {
      title: 'Transport',
      fields: [
        { label: 'Vessel', value: get('VesselName') },
        { label: 'Voyage Number', value: get('VoyageNumber') },
        { label: 'IMO Number', value: get('IMONumber') },
        { label: 'Carrier', value: get('CarrierName') },
        { label: 'Port of Loading', value: get('PortOfLoading'), mono: false },
        { label: 'Port of Discharge', value: get('PortOfDischarge'), mono: false },
        { label: 'Estimated Arrival', value: get('EstimatedArrival') },
      ],
    },
    {
      title: 'Cargo',
      fields: [
        { label: 'HS Code', value: get('HSCode') },
        { label: 'Description', value: get('DescriptionOfGoods'), full: true, mono: false },
        { label: 'Quantity', value: get('Quantity') ? `${get('Quantity')} ${get('QuantityUnit')}` : '' },
        { label: 'Gross Weight', value: get('GrossWeight') ? `${get('GrossWeight')} ${get('GrossWeightUnit')}` : '' },
        { label: 'Packages', value: get('NumberOfPackages') },
        { label: 'Declared Value', value: get('DeclaredValue') ? `${get('Currency')} ${Number(get('DeclaredValue')).toLocaleString()}` : '' },
      ],
    },
    {
      title: 'Terms',
      fields: [
        { label: 'Incoterms', value: get('Incoterms'), mono: false },
        { label: 'Freight Payable By', value: get('FreightPayableBy'), mono: false },
        { label: 'Originals (B/L)', value: get('NumberOfOriginalsBL') },
        { label: 'Issue Place & Date', value: get('IssuePlaceAndDate'), full: true, mono: false },
        { label: 'Signatory', value: get('SignatoryName'), mono: false },
      ],
    },
  ];
}

function parseCUSDEC(doc) {
  const root = doc.documentElement;
  const get = tag => getText(root, tag);
  return [
    {
      title: 'Declaration Header',
      fields: [
        { label: 'Declaration Number', value: get('DeclarationNumber') },
        { label: 'UCR', value: get('UCR') },
        { label: 'Declaration Date', value: get('DeclarationDate') },
        { label: 'Declaration Type', value: get('DeclarationType') },
        { label: 'Procedure Code', value: get('ProcedureCode') },
        { label: 'Country of Dispatch', value: get('CountryOfDispatch') },
        { label: 'Country of Destination', value: get('CountryOfDestination') },
        { label: 'Port of Export', value: get('PortOfExport'), mono: false },
        { label: 'Port of Destination', value: get('PortOfDestination'), mono: false },
      ],
    },
    {
      title: 'Exporter',
      fields: [
        { label: 'Name', value: get('Exporter Name'), full: true, mono: false },
        { label: 'Address', value: get('Exporter Address'), full: true, mono: false },
        { label: 'Identifier', value: get('Exporter Identifier') },
        { label: 'Tax Identifier', value: get('Exporter TaxIdentifier') },
      ],
    },
    {
      title: 'Consignee',
      fields: [
        { label: 'Name', value: get('Consignee Name'), full: true, mono: false },
        { label: 'Address', value: get('Consignee Address'), full: true, mono: false },
        { label: 'Identifier', value: get('Consignee Identifier') },
      ],
    },
    {
      title: 'Transport',
      fields: [
        { label: 'Transport Mode', value: get('TransportMode') === '1' ? '1 — Sea' : get('TransportMode') },
        { label: 'Vessel', value: get('VesselName') },
        { label: 'Voyage Number', value: get('VoyageNumber') },
        { label: 'IMO Number', value: get('IMONumber') },
        { label: 'Container', value: get('ContainerNumber'), mono: false },
        { label: 'Seal Number', value: get('SealNumber') },
      ],
    },
    {
      title: 'Goods Item',
      fields: [
        { label: 'HS Code', value: get('HSCode') },
        { label: 'Description', value: get('Description'), full: true, mono: false },
        { label: 'Quantity', value: get('Quantity') ? `${get('Quantity')} ${get('QuantityUnit')}` : '' },
        { label: 'Unit Price', value: get('UnitPrice') },
        { label: 'Customs Value', value: get('CustomsValue') ? `${get('Currency')} ${Number(get('CustomsValue')).toLocaleString()}` : '' },
        { label: 'Gross Mass', value: get('GrossMass') ? `${get('GrossMass')} MT` : '' },
        { label: 'Net Mass', value: get('NetMass') ? `${get('NetMass')} MT` : '' },
        { label: 'Country of Origin', value: get('CountryOfOrigin') },
        { label: 'Preference Code', value: get('PreferenceCode') },
      ],
    },
    {
      title: 'Commercial References',
      fields: [
        { label: 'Invoice Number', value: get('InvoiceNumber') },
        { label: 'Invoice Date', value: get('InvoiceDate') },
        { label: 'Invoice Total', value: get('InvoiceTotal') ? `${get('InvoiceCurrency')} ${Number(get('InvoiceTotal')).toLocaleString()}` : '' },
        { label: 'Incoterms', value: get('Incoterms'), mono: false },
        { label: 'Bill of Lading Ref', value: get('BillOfLadingRef') },
        { label: 'Certificate of Origin Ref', value: get('CertificateOfOriginRef') },
        { label: 'Insurance Ref', value: get('InsuranceCertificateRef') },
      ],
    },
    {
      title: 'Authentication',
      fields: [
        { label: 'Declarant', value: get('DeclarantName'), full: true, mono: false },
        { label: 'Declaration Location', value: get('DeclarationLocation'), mono: false },
        { label: 'Date', value: get('DeclarationAuthentication DeclarationDate') || get('DeclarationDate') },
        { label: 'Status', value: get('Status') },
      ],
    },
  ];
}

function parseBOM(doc) {
  const root = doc.documentElement;
  const get = tag => getText(root, tag);
  const materials = [];
  root.querySelectorAll('Material').forEach(mat => {
    materials.push({
      label: getText(mat, 'Name'),
      value: `${getText(mat, 'Supplier')} (${getText(mat, 'Country')}) — ${getText(mat, 'Percent')}%${getText(mat, 'CPTPPMember') === 'true' ? ' [CPTPP]' : ''}`,
      full: true, mono: false,
    });
  });
  return [
    {
      title: 'Bill of Material',
      fields: [
        { label: 'Reference', value: get('Reference') },
        { label: 'UCR', value: get('UCR') },
        { label: 'Date', value: get('Date') },
        { label: 'Manufacturer', value: get('Manufacturer'), mono: false },
        { label: 'Product', value: get('Product'), full: true, mono: false },
        { label: 'HS Code', value: get('HSCode') },
      ],
    },
    {
      title: 'Origin Composition',
      fields: [
        { label: 'Local Content', value: get('LocalContentPercent') ? `${get('LocalContentPercent')}%` : '' },
        { label: 'Third Country Content', value: get('ThirdCountryContentPercent') ? `${get('ThirdCountryContentPercent')}%` : '' },
        { label: 'CPTPP Cumulation', value: get('CPTPPCumulationApplied') === 'true' ? 'Yes' : 'No' },
      ],
    },
    { title: 'Input Materials', fields: materials },
  ];
}

function parseCOO(doc) {
  const root = doc.documentElement;
  const get = tag => getText(root, tag);
  return [
    {
      title: 'Certificate of Origin',
      fields: [
        { label: 'Certificate Number', value: get('CertificateNumber') },
        { label: 'Form Type', value: get('FormType') },
        { label: 'Issue Date', value: get('IssueDate') },
        { label: 'Issuing Authority', value: get('IssuingAuthority'), full: true, mono: false },
        { label: 'Issuing System', value: get('IssuingSystem') },
      ],
    },
    {
      title: 'Exporter',
      fields: [
        { label: 'Name', value: get('Exporter PartyName'), full: true, mono: false },
        { label: 'Country', value: get('Exporter Country') },
      ],
    },
    {
      title: 'Consignee',
      fields: [
        { label: 'Name', value: get('Consignee PartyName'), full: true, mono: false },
        { label: 'Country', value: get('Consignee Country') },
      ],
    },
    {
      title: 'Goods',
      fields: [
        { label: 'HS Code', value: get('Goods HSCode') },
        { label: 'Description', value: get('Goods Description'), full: true, mono: false },
        { label: 'Origin Criterion', value: get('OriginCriterion') },
        { label: 'Origin Country', value: get('OriginCountry') },
      ],
    },
    {
      title: 'Cumulation Declaration',
      fields: [
        { label: 'CPTPP Cumulation', value: get('CPTPPCumulation') === 'true' ? 'Yes' : 'No' },
        { label: 'Partner Country', value: get('CumulationPartnerCountry') },
        { label: 'Material Type', value: get('CumulationMaterialType'), mono: false },
      ],
    },
    {
      title: 'Digital Signature',
      fields: [
        { label: 'Signer', value: get('SignerIdentity') },
        { label: 'Timestamp', value: get('DigitalSignature Timestamp') },
        { label: 'Algorithm', value: get('Algorithm') },
      ],
    },
  ];
}

export default function XmlViewer({ docId, docType, errorType, errorDescription }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sections, setSections] = useState([]);

  useEffect(() => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    api.getDocumentXml(docId)
      .then(({ content }) => {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, 'application/xml');
        const parseErr = xmlDoc.querySelector('parsererror');
        if (parseErr) throw new Error('Invalid XML');
        const rootTag = xmlDoc.documentElement.tagName;
        if (rootTag === 'TransportDocument') setSections(parseBOL(xmlDoc));
        else if (rootTag === 'CustomsDeclaration') setSections(parseCUSDEC(xmlDoc));
        else if (rootTag === 'BillOfMaterial') setSections(parseBOM(xmlDoc));
        else if (rootTag === 'CertificateOfOrigin') setSections(parseCOO(xmlDoc));
        else setSections([{ title: 'Raw Document', fields: [{ label: 'Content', value: content, full: true }] }]);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [docId]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
      <Loader style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} /> Loading XML document...
    </div>
  );

  if (error) return (
    <div style={{ padding: 16, color: '#991b1b', fontSize: 13, background: '#fef2f2', borderRadius: 8 }}>
      Failed to load XML: {error}
    </div>
  );

  return (
    <div className="xml-viewer">
      {errorType && (
        <div className="xml-error-banner">
          <AlertTriangle style={{ width: 16, height: 16, color: '#a16207', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div className="eb-type">⚠ {errorType.replace(/_/g, ' ')}</div>
            <div className="eb-desc">{errorDescription}</div>
          </div>
        </div>
      )}
      {sections.map((s, i) => (
        <Section key={i} title={s.title} fields={s.fields} defaultOpen={i < 2} />
      ))}
    </div>
  );
}
