import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

// T-4V03 (WP1) — customs queue, pre-clearance view model and the draft
// import declaration flow. The test app runs as node `alpha` against the
// default vietnam-us-customs corridor config, so org2 is the export
// customs authority (customsDeskRole: exportCustoms). Import-side roles
// (importer / importCustoms) live on beta in the config, so the tests
// graft a beta-style org into store.orgs where needed.

const app = createApp();

function graftImportOrg(role = 'importCustoms') {
  const org = {
    id: 'org13',
    name: 'Import Customs Office (United States)',
    role: 'Customs Authority - United States',
    orgType: 'public',
    customsDeskRole: role,
  };
  store.orgs.push(org);
  return org;
}

beforeEach(() => {
  resetStore();
  seedStore();
  store.orgs = store.orgs.filter(o => o.id !== 'org13');
});

describe('GET /api/customs/queue', () => {
  it('rejects orgs without a customsDeskRole', async () => {
    const res = await request(app).get('/api/customs/queue?orgId=org1');
    expect(res.status).toBe(403);
  });

  it('export customs sees every local declaration with channel + dossier state', async () => {
    const res = await request(app).get('/api/customs/queue?orgId=org2');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('exportCustoms');
    expect(res.body.baseRates).toEqual({ green: 66.0, yellow: 30.3, red: 3.4 });
    expect(res.body.declarations.length).toBe(6);
    const row = res.body.declarations.find(r => r.ucr === 'VN-2026-EXP-00101');
    expect(row.declarationNo).toMatch(/^\d{12}$/);
    expect(row.declarationType).toBe('B11');
    expect(row.traderTaxCode).toMatch(/^\d{10}$/);
    expect(row.channel).toBe('green');
    expect(row.dossier.dossierVerified).toBe(true);
    expect(row.eCo.issuedVia).toBe('the national eCO system');
    expect(row.logistics.containerNo).toMatch(/^[A-Z]{4}\d{7}$/);
  });

  it('channel mix matches the seeded queue (3 green / 2 yellow / 1 red)', async () => {
    const res = await request(app).get('/api/customs/queue?orgId=org2');
    expect(res.body.counts).toEqual({ green: 3, yellow: 2, red: 1 });
  });

  it('simulation: unverified yellow would improve with a verified dossier; data errors would not', async () => {
    const res = await request(app).get('/api/customs/queue?orgId=org2');
    const emailedPdf = res.body.declarations.find(r => r.ucr === 'VN-2026-EXP-00104');
    expect(emailedPdf.channel).toBe('yellow');
    expect(emailedPdf.dossier.dossierVerified).toBe(false);
    expect(emailedPdf.wouldImproveIfVerified).toBe(true);

    const hsMismatch = res.body.declarations.find(r => r.ucr === 'VN-2026-EXP-E001');
    expect(hsMismatch.channel).toBe('yellow');
    expect(hsMismatch.wouldImproveIfVerified).toBe(false); // data inconsistency, not a provenance gap

    const originGap = res.body.declarations.find(r => r.ucr === 'VN-2026-EXP-00107');
    expect(originGap.channel).toBe('red');
    expect(originGap.wouldImproveIfVerified).toBe(false); // missing input C/O: provenance can't fix content
  });

  it('import-side org sees only consignments shared with it', async () => {
    const org = graftImportOrg();
    const empty = await request(app).get('/api/customs/queue?orgId=org13');
    expect(empty.body.declarations).toEqual([]);

    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    store.permissions[c.id][org.id] = 'viewer';
    const res = await request(app).get('/api/customs/queue?orgId=org13');
    expect(res.body.role).toBe('importCustoms');
    expect(res.body.declarations.map(r => r.ucr)).toEqual(['VN-2026-EXP-00101']);
  });
});

describe('GET /api/consignments/:id/preclearance', () => {
  it('returns the dossier + draft declaration with per-field provenance', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/consignments/${c.id}/preclearance?orgId=org2`);
    expect(res.status).toBe(200);
    expect(res.body.consignment.ucr).toBe('VN-2026-EXP-00101');
    expect(res.body.documents.length).toBeGreaterThan(0);
    for (const d of res.body.documents) {
      expect(d).toHaveProperty('notarization');
      expect(d).toHaveProperty('requiresNotarization');
    }
    const fields = res.body.draftDeclaration.fields;
    expect(fields.length).toBeGreaterThan(8);
    // Every pre-filled field is traceable to a source document.
    for (const f of fields) {
      expect(f.value).not.toBeNull();
      expect(f.sourceDoc).toBeTruthy();
    }
    const hts = fields.find(f => f.key === 'hsCode');
    expect(hts.value).toBe('6105.10.0010'); // US destination: 10-digit HTS
    expect(hts.sourceDoc).toBe('Export Declaration');
    expect(res.body.draftDeclaration.missing.length).toBeGreaterThan(0);
  });

  it('denies orgs without access', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app).get(`/api/consignments/${c.id}/preclearance?orgId=org4`);
    expect(res.status).toBe(403);
  });

  it('EU destination uses MRN/EVFTA fields and flags the EUR.1 paper rule', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00103');
    const res = await request(app).get(`/api/consignments/${c.id}/preclearance?orgId=org2`);
    expect(res.body.consignment.customs.destination.type).toBe('eu');
    expect(res.body.consignment.customs.destination.mrn).toHaveLength(17);
    expect(res.body.consignment.customs.eCo.paperOriginalRequired).toBe(true);
    const pref = res.body.draftDeclaration.fields.find(f => f.key === 'preferentialClaim');
    expect(pref.value).toBe('EVFTA');
  });
});

describe('POST /api/consignments/:id/import-declaration', () => {
  it('importer with access creates the draft with a provenance snapshot', async () => {
    const org = graftImportOrg('importer');
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    store.permissions[c.id][org.id] = 'viewer';

    const res = await request(app)
      .post(`/api/consignments/${c.id}/import-declaration`)
      .send({ actorOrgId: 'org13' });
    expect(res.status).toBe(200);
    expect(res.body.docType).toBe('Import Declaration (Draft)');
    expect(res.body.reference).toBe('IMD-00101');
    expect(res.body.prelodged.fields.length).toBeGreaterThan(8);
    expect(res.body.proofId).toBeNull(); // working draft, deliberately not notarized

    const doc = store.documents.find(d => d.id === res.body.id);
    expect(doc).toBeTruthy();
    expect(store.ledgerLog.some(e => e.action === 'Pre-lodged Data Accepted')).toBe(true);

    // Second acceptance is rejected.
    const dup = await request(app)
      .post(`/api/consignments/${c.id}/import-declaration`)
      .send({ actorOrgId: 'org13' });
    expect(dup.status).toBe(409);
  });

  it('export customs cannot accept pre-lodged data (importer-side action)', async () => {
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-00101');
    const res = await request(app)
      .post(`/api/consignments/${c.id}/import-declaration`)
      .send({ actorOrgId: 'org2' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/consignments/:id/request-correction', () => {
  it('logs the correction request on the replicated ledger', async () => {
    const org = graftImportOrg('importCustoms');
    const c = store.consignments.find(x => x.ucr === 'VN-2026-EXP-E001');
    store.permissions[c.id][org.id] = 'viewer';
    const res = await request(app)
      .post(`/api/consignments/${c.id}/request-correction`)
      .send({ actorOrgId: 'org13', reason: 'HS code on the declaration does not match the invoice' });
    expect(res.status).toBe(200);
    const entry = store.ledgerLog.find(e => e.action === 'Correction Requested');
    expect(entry).toBeTruthy();
    expect(entry.details).toContain('VN-2026-EXP-E001');
  });
});
