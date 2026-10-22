import { getConfig } from '../config.js';
import { escXml } from '../utils.js';

export function makeSeedXml(docType, m, ref) {
  const seed = parseInt(m.ucr.replace(/\D/g, '').slice(-4) || '1234');
  // T-4V03: when the consignment carries a `customs` block, the generated
  // XML reuses ITS references (container, seal, B/L, export declaration,
  // eCO) so every cross-reference an officer checks matches the Customs
  // Desk. Corridors without the block keep the derived fallbacks.
  const cust = m.customs ?? {};
  const log  = cust.logistics ?? {};
  const voyageNo  = `V${2600 + (seed % 99)}`;
  const imoNo     = `IMO${9000000 + (seed % 999999)}`;
  const blOriginals = '3';
  const containerNo = log.containerNo ?? `TCKU${3000000 + (seed % 9999999)}`;
  const sealNo      = log.sealNo ?? `SL${10000 + (seed % 89999)}`;
  const qty         = m.quantity.match(/[\d,]+/)?.[0]?.replace(',','') || '1000';
  const qtyUnit     = /pcs/i.test(m.quantity ?? '') ? 'PCS' : 'MT';
  const grossMass   = log.grossWeightKg ?? qty;
  const massUnit    = log.grossWeightKg ? 'KG' : 'MT';
  const netMass     = log.netWeightKg ?? Math.round(parseInt(qty) * 0.97);
  const packages    = log.packages ?? Math.ceil(parseInt(qty) / 25);
  const blRef       = log.blNo ?? null;
  const arrival     = new Date(new Date(m.shipDate).getTime() + 14 * 86400000).toISOString().slice(0,10);
  const addrBook = getConfig()?.documentTemplates?.addressBook ?? {};
  const carrier  = getConfig()?.documentTemplates?.defaultCarrier ?? 'Carrier';
  const exporterAddr = addrBook[m.fromCountry] ?? 'Unknown';
  const importerAddr = addrBook[m.toCountry] ?? 'Unknown';

  const e = escXml;
  if (docType === 'Bill of Lading') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<TransportDocument>
  <TransportDocumentReference>${e(blRef ?? ref)}</TransportDocumentReference>
  <ContractQuotationReference>${e(m.ucr)}</ContractQuotationReference>
  <IssueDate>${m.shipDate}</IssueDate>
  <ShippedOnBoardDate>${m.shipDate}</ShippedOnBoardDate>
  <IssuerCode>NL-SHP-001</IssuerCode>
  <ServiceContractReference>${e(m.invoiceRef)}</ServiceContractReference>
  <Shipper>
    <PartyName>${e(m.exporter)}</PartyName>
    <Address>${e(exporterAddr)}</Address>
    <RegistrationNumber>REG-${m.fromCountry.slice(0,2).toUpperCase()}-${seed}</RegistrationNumber>
    <TaxIdentifier>TAX-${seed + 1000}</TaxIdentifier>
  </Shipper>
  <Consignee>
    <PartyName>${e(m.importer)}</PartyName>
    <Address>${e(importerAddr)}</Address>
    <RegistrationNumber>REG-${m.toCountry.slice(0,2).toUpperCase()}-${seed + 500}</RegistrationNumber>
  </Consignee>
  <VesselName>${e(m.vessel)}</VesselName>
  <VoyageNumber>${voyageNo}</VoyageNumber>
  <IMONumber>${imoNo}</IMONumber>
  <CarrierName>${e(carrier)}</CarrierName>
  <PortOfLoading>${e(m.originPort)}</PortOfLoading>
  <PortOfDischarge>${e(m.destinationPort)}</PortOfDischarge>
  <EstimatedArrival>${arrival}</EstimatedArrival>
  <HSCode>${e(m.hsCode)}</HSCode>
  <DescriptionOfGoods>${e(m.product)}</DescriptionOfGoods>
  <ContainerNumber>${containerNo}</ContainerNumber>
  <SealNumber>${sealNo}</SealNumber>
  <Quantity>${qty}</Quantity>
  <QuantityUnit>${qtyUnit}</QuantityUnit>
  <GrossWeight>${grossMass}</GrossWeight>
  <GrossWeightUnit>${massUnit}</GrossWeightUnit>
  <NumberOfPackages>${packages}</NumberOfPackages>
  <PackageType>${e(log.packageType ?? 'packages')}</PackageType>
  <DeclaredValue>${m.totalValue}</DeclaredValue>
  <Currency>${m.currency}</Currency>
  <Incoterms>${e(m.incoterms)}</Incoterms>
  <FreightPayableBy>${m.incoterms === 'FOB' ? 'Consignee' : 'Shipper'}</FreightPayableBy>
  <NumberOfOriginalsBL>${blOriginals}</NumberOfOriginalsBL>
  <IssuePlaceAndDate>${e(m.originPort)}, ${m.shipDate}</IssuePlaceAndDate>
  <SignatoryName>Captain, ${e(m.vessel)}</SignatoryName>
</TransportDocument>`;
  }

  if (docType === 'Export Declaration') {
    const edCfg = getConfig()?.documentTemplates?.xmlTemplates?.['Export Declaration'];
    const declarantName = edCfg?.declarantName ?? 'Customs Authority';
    return `<?xml version="1.0" encoding="UTF-8"?>
<CustomsDeclaration>
  <DeclarationNumber>${e(cust.declarationNo ?? ref)}</DeclarationNumber>
  <DeclarationReference>${e(ref)}</DeclarationReference>
  <UCR>${e(m.ucr)}</UCR>
  <DeclarationDate>${m.shipDate}</DeclarationDate>
  <DeclarationType>${e(cust.declarationType ?? 'EX')}</DeclarationType>
  <ProcedureCode>1000</ProcedureCode>${cust.customsOffice ? `
  <CustomsOffice>${e(cust.customsOffice)}</CustomsOffice>` : ''}${cust.traderTaxCode ? `
  <TraderTaxCode>${e(cust.traderTaxCode)}</TraderTaxCode>` : ''}${cust.channel ? `
  <ChannelAssigned>${e(cust.channel.toUpperCase())}</ChannelAssigned>` : ''}
  <CountryOfDispatch>${e(m.fromCountry)}</CountryOfDispatch>
  <CountryOfDestination>${e(m.toCountry)}</CountryOfDestination>
  <PortOfExport>${e(m.originPort)}</PortOfExport>
  <PortOfDestination>${e(m.destinationPort)}</PortOfDestination>
  <Exporter>
    <Name>${e(m.exporter)}</Name>
    <Address>${e(exporterAddr)}</Address>
    <Identifier>EXP-${m.fromCountry.slice(0,2).toUpperCase()}-${seed}</Identifier>
    <TaxIdentifier>TAX-${seed + 1000}</TaxIdentifier>
  </Exporter>
  <Consignee>
    <Name>${e(m.importer)}</Name>
    <Address>${e(importerAddr)}</Address>
    <Identifier>IMP-${m.toCountry.slice(0,2).toUpperCase()}-${seed + 500}</Identifier>
  </Consignee>
  <TransportMode>1</TransportMode>
  <VesselName>${e(m.vessel)}</VesselName>
  <VoyageNumber>${voyageNo}</VoyageNumber>
  <IMONumber>${imoNo}</IMONumber>
  <ContainerNumber>${containerNo}</ContainerNumber>
  <SealNumber>${sealNo}</SealNumber>
  <HSCode>${e(m.hsCode)}</HSCode>
  <Description>${e(m.product)}</Description>
  <Quantity>${qty}</Quantity>
  <QuantityUnit>${qtyUnit}</QuantityUnit>
  <UnitPrice>${Math.round(m.totalValue / parseInt(qty))}</UnitPrice>
  <CustomsValue>${m.totalValue}</CustomsValue>
  <Currency>${m.currency}</Currency>
  <GrossMass>${grossMass}</GrossMass>
  <NetMass>${netMass}</NetMass>${cust.exportDutyRatePercent != null ? `
  <ExportDutyRatePercent>${cust.exportDutyRatePercent}</ExportDutyRatePercent>
  <ExportDutyAmount>${cust.exportDutyAmount ?? 0}</ExportDutyAmount>` : ''}
  <CountryOfOrigin>${e(m.fromCountry)}</CountryOfOrigin>
  <PreferenceCode>100</PreferenceCode>
  <InvoiceNumber>${e(m.invoiceRef)}</InvoiceNumber>
  <InvoiceDate>${m.shipDate}</InvoiceDate>
  <InvoiceTotal>${m.totalValue}</InvoiceTotal>
  <InvoiceCurrency>${m.currency}</InvoiceCurrency>
  <Incoterms>${e(m.incoterms)}</Incoterms>
  <BillOfLadingRef>${e(blRef ?? `BL-${ref.replace(/[A-Z]+-\d+-/,'')}`)}</BillOfLadingRef>
  <CertificateOfOriginRef>${e(cust.eCo?.ref ?? `CO-${ref.replace(/[A-Z]+-\d+-/,'')}`)}</CertificateOfOriginRef>
  <InsuranceCertificateRef>INS-${seed}</InsuranceCertificateRef>
  <DeclarantName>${e(declarantName)}</DeclarantName>
  <DeclarationLocation>${e(m.originPort)}</DeclarationLocation>
  <Status>ACCEPTED</Status>
</CustomsDeclaration>`;
  }

  if (docType === 'Bill of Material') {
    const bomCfg = getConfig()?.documentTemplates?.xmlTemplates?.['Bill of Material']?.originComposition;
    const localPct = bomCfg?.localContentPercent ?? 0;
    const cumulationApplied = bomCfg?.cptppCumulationApplied ?? false;
    const thirdPct = bomCfg?.thirdCountryContentPercent ?? 0;
    const materials = bomCfg?.inputMaterials ?? [];
    const materialsXml = materials.map(mat =>
      `      <Material><Name>${e(mat.material)}</Name><Country>${e(mat.origin)}</Country><Percent>${mat.percent}</Percent></Material>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<BillOfMaterial>
  <Reference>${e(ref)}</Reference>
  <UCR>${e(m.ucr)}</UCR>
  <Date>${m.shipDate}</Date>
  <Manufacturer>${e(m.exporter)}</Manufacturer>
  <Product>${e(m.product)}</Product>
  <HSCode>${e(m.hsCode)}</HSCode>
  <OriginComposition>
    <LocalContentPercent>${localPct}</LocalContentPercent>
    <CPTPPCumulationApplied>${cumulationApplied}</CPTPPCumulationApplied>
    <ThirdCountryContentPercent>${thirdPct}</ThirdCountryContentPercent>
    <InputMaterials>
${materialsXml}
    </InputMaterials>
  </OriginComposition>
</BillOfMaterial>`;
  }

  const coCfg = getConfig()?.documentTemplates?.xmlTemplates?.[docType];
  if (coCfg?.issuingAuthority) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<CertificateOfOrigin>
  <CertificateNumber>${e(cust.eCo?.ref ?? ref)}</CertificateNumber>
  <FormType>${e(cust.eCo?.formType ?? coCfg.formType ?? 'Standard')}</FormType>
  <IssueDate>${m.shipDate}</IssueDate>
  <IssuingAuthority>${e(coCfg.issuingAuthority)}</IssuingAuthority>
  <IssuingSystem>${coCfg.issuingSystem || 'Manual'}</IssuingSystem>
  <Exporter><PartyName>${e(m.exporter)}</PartyName><Country>${m.fromCountry.slice(0,2).toUpperCase()}</Country></Exporter>
  <Consignee><PartyName>${e(m.importer)}</PartyName><Country>${m.toCountry.slice(0,2).toUpperCase()}</Country></Consignee>
  <Goods>
    <HSCode>${e(m.hsCode)}</HSCode>
    <Description>${e(m.product)}</Description>
    <OriginCriterion>${coCfg.originCriterion || 'WO'}</OriginCriterion>
    <OriginCountry>${m.fromCountry.slice(0,2).toUpperCase()}</OriginCountry>
  </Goods>
  <CumulationDeclaration>
    <CumulationApplied>${!!coCfg.cumulationPartnerCountry}</CumulationApplied>
    <CumulationPartnerCountry>${coCfg.cumulationPartnerCountry || ''}</CumulationPartnerCountry>
    <CumulationMaterialType>${e(coCfg.cumulationMaterialType || '')}</CumulationMaterialType>
  </CumulationDeclaration>
  <DigitalSignature>
    <SignerIdentity>${coCfg.issuingSystem || 'Authority'}</SignerIdentity>
    <Timestamp>${m.shipDate}T10:00:00.000Z</Timestamp>
    <Algorithm>Ed25519</Algorithm>
  </DigitalSignature>
</CertificateOfOrigin>`;
  }

  return null;
}
