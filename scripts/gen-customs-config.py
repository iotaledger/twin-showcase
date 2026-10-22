#!/usr/bin/env python3
"""One-off generator for configs/vietnam-us-customs.json (T-4V03 WP2).

Derives the customs-perspective corridor config from configs/vietnam-us.json:
- generic authority naming (all organisations in the configs are fictitious)
- 6 alpha consignments, all owned by org1 (simplified demo flow: one exporter,
  the certificate of origin office and export customs as the authorities), each with a
  per-consignment `customs` block (export declaration, channel,
  eCO linkage, logistics refs, destination entry data) — English-only,
  HS 61/62 only. The hero consignment 00101 is seeded READY FOR EXPORT
  CLEARANCE (declared, channel green, not yet released) so the demo opens
  on the export customs officer with an actionable queue head.
- customsDeskRole org flags driving the Customs Desk UI gating

Re-run after editing: python3 scripts/gen-customs-config.py
"""
import json, copy, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'configs', 'vietnam-us.json')
DST = os.path.join(ROOT, 'configs', 'vietnam-us-customs.json')

OLD_CUSTOMS = 'Export Customs Office (Vietnam)'
NEW_CUSTOMS = 'Export Customs Office (Vietnam)'
CUSTOMS_OFFICE = 'Port Customs Office (Ho Chi Minh City)'

with open(SRC) as f:
    cfg = json.load(f)

# ── Corridor identity ──────────────────────────────────────────────────
cfg['corridor'] = {
    'id': 'vietnam-us-customs',
    'name': 'Vietnam Export Corridor - Customs Perspective',
    'description': 'Vietnam garment exports (HS 61/62) with first-class customs views: export declarations in the style of a national customs system, channel simulation, eCO linkage and import pre-clearance at destination',
    'version': '1.0.0',
}

cfg['branding']['appName'] = 'TWIN Vietnam Customs'
cfg['branding']['alpha']['description'] = 'Vietnam Export Corridor - Customs Perspective'

# ── Global rename of the export customs authority (a no-op while both ──
# configs use the same generic name; kept for future renames) ──────────
def rename(node):
    if isinstance(node, dict):
        return {k: rename(v) for k, v in node.items()}
    if isinstance(node, list):
        return [rename(v) for v in node]
    if isinstance(node, str):
        return node.replace(OLD_CUSTOMS, NEW_CUSTOMS)
    return node

cfg = rename(cfg)

# ── Orgs: customsDeskRole flags + extra garment exporters ──────────────
alpha_orgs = cfg['nodes']['alpha']['orgs']
beta_orgs = cfg['nodes']['beta']['orgs']

for o in alpha_orgs:
    if o['id'] == 'org2':
        o['customsDeskRole'] = 'exportCustoms'
for o in beta_orgs:
    if o['id'] in ('org13', 'org14'):
        o['customsDeskRole'] = 'importCustoms'
    if o['id'] in ('org5', 'org6'):
        o['customsDeskRole'] = 'importer'

# ── Consignment builder ────────────────────────────────────────────────
# Single exporter by design: the simplified demo flow keeps every
# declaration on org1, with the certificate of origin office (eCO) and export customs as the
# authorities — same company, six shipments, including the "old way"
# (emailed PDFs, 00104) for the before/after contrast.
EXPORTERS = {
    'org1':  ('Lotus Bay Apparel JSC',  'LBA', '0900123456'),
}

def iso6346(owner_and_category, serial):
    """Container number with its ISO 6346 check digit (owner code is fictitious)."""
    letters, value = {}, 10
    for ch in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        if value % 11 == 0:
            value += 1
        letters[ch] = value
        value += 1
    code = owner_and_category + serial
    total = sum((letters[ch] if ch.isalpha() else int(ch)) * 2 ** i for i, ch in enumerate(code))
    return code + str(total % 11 % 10)

def consignment(n, *, org, product, hs, qty, value, currency, ship, status,
                vessel, channel, verified, dest, decl_seq, hts=None,
                duty=None, mrn=None, channel_reason=None, inspection=None,
                released=True, eco_form='CPTPP', origin=None, error=None):
    name, code, mst = EXPORTERS[org]
    to_eu = dest == 'eu'
    importer = 'Northpeak Athletics Europe B.V.' if to_eu else 'Northpeak Athletics Inc.'
    seq = f'{n:05d}' if not error else n  # error row keeps its legacy UCR tail
    ucr = f'VN-2026-EXP-{seq}'
    seed = decl_seq
    c = {
        'ucr': ucr,
        'product': product,
        # Pre-granted read access (server/seed.js): the export customs
        # authority and the eCO issuer see every declaration's consignment +
        # dossier in the regular views, not just the Customs Desk queue.
        'viewers': ['org2', 'org3'],
        'hsCode': hs,
        'quantity': qty,
        'totalValue': value,
        'currency': currency,
        'exporter': name,
        'importer': importer,
        'fromCountry': 'Vietnam',
        'toCountry': 'Netherlands' if to_eu else 'United States',
        'originPort': 'Port of Ho Chi Minh City',
        'destinationPort': 'Port of Rotterdam' if to_eu else 'Port of Los Angeles',
        'vessel': vessel,
        'shipDate': ship,
        'incoterms': 'FOB',
        'invoiceRef': f'INV-2026-{code}-{seq if isinstance(seq, str) else seq}',
        'declRef': f'VN-EXP-2026-{seq}',
        'status': status,
        'creatorOrgId': org,
        'creatorOrgName': name,
    }
    if error:
        c['errorType'] = error['type']
        c['errorDescription'] = error['description']
    if origin:
        c['originComposition'] = origin
    declared = f'{ship}T03:20:00.000Z'
    release_ts = f'{ship}T09:45:00.000Z' if released else None
    customs = {
        'declarationNo': f'3041260{seed * 37 + 11483:05d}',
        'declarationType': 'B11',
        'customsOffice': CUSTOMS_OFFICE,
        'traderTaxCode': mst,
        'declaredAt': declared,
        'channel': channel,
        'channelReason': channel_reason or (
            'Verified dossier - all supporting documents anchored and verified at source'
            if channel == 'green' else 'Document review required'),
        'inspectionResult': inspection,
        'exportDutyRatePercent': 0,
        'exportDutyAmount': 0,
        'vatRefundEligible': True,
        'releasedAt': release_ts,
        'dossierVerified': verified,
        'eCo': {
            'ref': f'CO-2026-VN-{4500 + seed}',
            'formType': eco_form,
            'issuedVia': 'the national eCO system',
            'issuer': 'Certificate of Origin Office (Vietnam)',
            'qrVerifiable': True,
            **({'paperOriginalRequired': True,
                'paperRule': 'EUR.1 above EUR 6,000 requires the printed original (EVFTA); the digital copy is an evidence twin, not the legal instrument'}
               if eco_form == 'EUR.1' else {}),
        },
        'logistics': {
            'containerNo': iso6346('BWLU', f'{723000 + seed:06d}'),
            'sealNo': f'VN{880000 + seed * 13}',
            'grossWeightKg': round(value / 21),
            'netWeightKg': round(value / 21 * 0.96),
            'packages': round(value / 350),
            'packageType': 'cartons',
            'bookingRef': f'BWCL2560{78000 + seed * 11}',
            'blNo': f'BWCL2560{78000 + seed * 11}',
        },
    }
    if to_eu:
        customs['destination'] = {
            'type': 'eu',
            'mrn': mrn,
            'eori': 'NL807654321',
            'preferentialClaim': 'EVFTA',
            'eur1PaperRequired': eco_form == 'EUR.1',
        }
    else:
        customs['destination'] = {
            'type': 'us',
            'entryNo': f'ABC-24618{seed:02d}-{(seed * 3) % 10}',
            'htsCode': hts,
            'dutyRatePercent': duty,
            'importerOfRecordEIN': '95-1234567',
            'isfFiled': True,
            'uflpaSensitive': True,
        }
    c['customs'] = customs
    return c

ORIGIN_101 = cfg['consignments']['alpha'][0].get('originComposition')
ORIGIN_102 = cfg['consignments']['alpha'][1].get('originComposition')
ORIGIN_E001 = cfg['consignments']['alpha'][2].get('originComposition')

# Incomplete supplier evidence: drives the RED channel demo beat (origin
# doubt, cotton inputs without an input C/O — the UFLPA-sensitive case).
ORIGIN_RED = {
    'localContentPercent': 58.0,
    'calculationMethod': 'RVC',
    'threshold': 55,
    'cptppCumulationApplied': False,
    'evidenceIncomplete': True,
    'inputMaterials': [
        {'material': 'Cotton Fabric', 'supplierCountry': 'UNDECLARED', 'valuePercent': 34.0, 'ftaMember': False, 'inputCoMissing': True},
        {'material': 'Thread', 'supplierCountry': 'VN', 'valuePercent': 8.0, 'ftaMember': True},
        {'material': 'Labor', 'supplierCountry': 'VN', 'valuePercent': 50.0, 'ftaMember': True},
        {'material': 'Trims', 'supplierCountry': 'CN', 'valuePercent': 8.0, 'ftaMember': False},
    ],
}

# Demo opening state: 00101 is the queue head, READY FOR EXPORT CLEARANCE —
# declared today, dossier fully verified, channel green, release pending.
# The officer opens the Customs Desk on an actionable declaration instead of
# an archive of released ones.
cfg['consignments']['alpha'] = [
    consignment(101, org='org1', product="Men's Cotton Polo Shirts (Knitted)", hs='6105.10',
                qty='24,000 pcs', value=168000, currency='USD', ship='2026-06-12', status='Customs',
                vessel='MV Bluewave Seletar', channel='green', verified=True, dest='us', decl_seq=11,
                hts='6105.10.0010', duty=19.7, released=False, origin=ORIGIN_101,
                channel_reason='Verified dossier - all supporting documents anchored and verified at source; ready for release'),
    consignment(102, org='org1', product="Women's Cotton T-Shirts (Knitted)", hs='6109.10',
                qty='36,000 pcs', value=216000, currency='USD', ship='2026-03-18', status='Delivered',
                vessel='MV Bluewave Sentosa', channel='green', verified=True, dest='us', decl_seq=12,
                hts='6109.10.0040', duty=16.5, origin=ORIGIN_102),
    consignment('E001', org='org1', product="Men's Cotton Dress Shirts (Woven)", hs='6205.20',
                qty='15,000 pcs', value=225000, currency='USD', ship='2026-02-20', status='Under Review',
                vessel='MV Bluewave Sentosa', channel='yellow', verified=True, dest='us', decl_seq=13,
                hts='6205.20.2051', duty=19.7, released=False, origin=ORIGIN_E001,
                channel_reason='Data inconsistency across the dossier: declaration HS code does not match the commercial invoice',
                inspection='Document review in progress - HS reconciliation requested from declarant',
                error={'type': 'HS Code Mismatch',
                       'description': 'Export Declaration filed under HS 6205.30 (man-made fibres) but Commercial Invoice declares HS 6205.20 (cotton). Export customs has flagged the shipment for reconciliation.'}),
    consignment(103, org='org1', product="Men's Windbreakers (Woven, Synthetic)", hs='6201.93',
                qty='12,000 pcs', value=264000, currency='EUR', ship='2026-04-02', status='In Transit',
                vessel='MV Bluewave Emerald', channel='green', verified=True, dest='eu', decl_seq=14,
                mrn='26NL7H9K2M4P6R8T1', eco_form='EUR.1'),
    consignment(104, org='org1', product="Men's Cotton Pullovers (Knitted)", hs='6110.20',
                qty='18,000 pcs', value=189000, currency='USD', ship='2026-04-15', status='Customs',
                vessel='MV Bluewave Altair', channel='yellow', verified=False, dest='us', decl_seq=15,
                hts='6110.20.2079', duty=16.5, released=False,
                channel_reason='Supporting documents received as emailed PDF scans - no provenance, manual officer review required',
                inspection='Awaiting manual document review (1-3 working days)'),
    consignment(107, org='org1', product="Boys' Knit Jackets (Cotton Blend)", hs='6101.20',
                qty='9,000 pcs', value=98000, currency='USD', ship='2026-05-20', status='Customs',
                vessel='MV Bluewave Atlas', channel='red', verified=False, dest='us', decl_seq=18,
                hts='6101.20.0010', duty=15.9, released=False, origin=ORIGIN_RED,
                channel_reason='Origin verification: declared Vietnam origin, but input fabric evidence is incomplete (no input C/O for 34% of value)',
                inspection='Physical inspection scheduled - container held at the port'),
]

# ── Beta starts EMPTY ──────────────────────────────────────────────────
# The import side receives the dossier live via the cross-node share
# (demo Beat 4) — no pre-seeded foreign consignments, and no documents
# issued by orgs outside the demo scope (the inherited KR input-material
# rows referenced a Korean customs office and carrier, neither of which is a
# demo org).
cfg['consignments']['beta'] = []
cfg['documents']['beta'] = []

# ── Import Declaration (Draft) doc type + template (WP1 output doc) ────
cfg['documentTypes']['Import Declaration (Draft)'] = {
    'uneceCode': '929',
    'dataClassification': 'workingDraft',
    'sourceSystem': None,
    'issuingAuthority': None,
    'requiresNotarization': False,
    'publicAccess': 'verify',  # internal working draft — verification only, never public content
}

cfg['documentTemplates']['pdfTemplates']['Import Declaration (Draft)'] = {
    'lines': [
        'IMPORT DECLARATION (DRAFT)',
        'Pre-lodged from verified export dossier - NOT a legal filing',
        'Reference: ${ref}',
        'Date: ${shipDate}',
        '',
        'Importer of record: ${importer}',
        'Exporter: ${exporter}',
        'Consignment: ${ucr}',
        '',
        'Country of Export: ${fromCountry}',
        'Country of Import: ${toCountry}',
        '',
        'Every pre-filled field of this draft is traceable to a',
        'provenance-backed source document anchored on the ledger.',
        '',
        'Prepared by: ${issuer}',
    ],
}

with open(DST, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')

alpha = cfg['consignments']['alpha']
channels = [c['customs']['channel'] for c in alpha]
print(f'Wrote {DST}')
print(f'  alpha consignments: {len(alpha)} '
      f'(green={channels.count("green")}, yellow={channels.count("yellow")}, red={channels.count("red")})')
print(f'  alpha orgs: {len(alpha_orgs)}, beta orgs: {len(beta_orgs)}')
