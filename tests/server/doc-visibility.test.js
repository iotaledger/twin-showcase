import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

// Regression for the cross-node share bug: a FULL consignment viewer (e.g.
// Vietnam Customs) must keep seeing every document even after a downstream
// share creates per-document permissions for another org. Previously the GET
// /api/documents filter used a GLOBAL "any doc has any permission" heuristic,
// which hid all docs from a full viewer the moment any per-doc grant appeared.

const app = createApp();
const docIds = (res) => res.body.map(d => d.id).sort();

beforeEach(() => { resetStore(); seedStore(); });

describe('full consignment viewer keeps visibility', () => {
  it('sees all docs before AND after a downstream FULL share to another org', async () => {
    const c = store.consignments[0];
    const all = docIds(await request(app).get(`/api/documents?orgId=org1&consignmentId=${c.id}`)); // owner baseline
    await request(app).post('/api/permissions/share').send({ consignmentId: c.id, recipientOrgId: 'org2', recipientOrgName: 'VN Customs', sharerOrgName: 'LBA', shareMode: 'full' });
    expect(docIds(await request(app).get(`/api/documents?orgId=org2&consignmentId=${c.id}`))).toEqual(all);
    // org2 re-shares (full) to org13
    await request(app).post('/api/permissions/share').send({ consignmentId: c.id, recipientOrgId: 'org13', recipientOrgName: 'EU Customs', sharerOrgName: 'VN Customs', shareMode: 'full' });
    expect(docIds(await request(app).get(`/api/documents?orgId=org2&consignmentId=${c.id}`))).toEqual(all); // still all
    expect(docIds(await request(app).get(`/api/documents?orgId=org13&consignmentId=${c.id}`))).toEqual(all);
  });

  it('full viewer still sees a doc when a downstream SELECTIVE share creates per-doc grants for another org', async () => {
    const c = store.consignments[0];
    const all = docIds(await request(app).get(`/api/documents?orgId=org1&consignmentId=${c.id}`));
    const someDoc = all[0];
    await request(app).post('/api/permissions/share').send({ consignmentId: c.id, recipientOrgId: 'org2', recipientOrgName: 'VN Customs', sharerOrgName: 'LBA', shareMode: 'full' });
    // a selective share to org13 (per-doc grant on ONE doc) — must NOT hide docs from full viewer org2
    await request(app).post('/api/permissions/share').send({ consignmentId: c.id, recipientOrgId: 'org13', recipientOrgName: 'EU', sharerOrgName: 'VN Customs', shareMode: 'selective', selectedDocIds: [someDoc] });
    expect(docIds(await request(app).get(`/api/documents?orgId=org2&consignmentId=${c.id}`))).toEqual(all); // org2 full → all
    // org13 was selective → sees only the one doc
    expect(docIds(await request(app).get(`/api/documents?orgId=org13&consignmentId=${c.id}`))).toEqual([someDoc]);
  });

  it('full viewer sees a doc uploaded AFTER the share', async () => {
    const created = await request(app).post('/api/consignments').send({ ucr: 'NEW-VIS', creatorOrgId: 'org1', description: 'x' });
    const cid = created.body.id;
    await request(app).post('/api/permissions/share').send({ consignmentId: cid, recipientOrgId: 'org2', recipientOrgName: 'VN Customs', sharerOrgName: 'LBA', shareMode: 'full' });
    await request(app).post('/api/documents').field('consignmentId', cid).field('title', 'Invoice').field('docType', 'Commercial Invoice').field('creatorOrgId', 'org1');
    // downstream grant to org13 used to flip the global gate and hide the doc from org2
    await request(app).post('/api/permissions/share').send({ consignmentId: cid, recipientOrgId: 'org13', recipientOrgName: 'EU', sharerOrgName: 'VN Customs', shareMode: 'full' });
    const org2docs = (await request(app).get(`/api/documents?orgId=org2&consignmentId=${cid}`)).body;
    const ownerDocs = (await request(app).get(`/api/documents?orgId=org1&consignmentId=${cid}`)).body;
    expect(org2docs.length).toBe(1);
    expect(org2docs.length).toBe(ownerDocs.length); // viewer matches owner, no longer 0
  });

  it('an org with no share sees nothing', async () => {
    const c = store.consignments[0];
    expect((await request(app).get(`/api/documents?orgId=org9&consignmentId=${c.id}`)).body).toEqual([]);
  });
});
