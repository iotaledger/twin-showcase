import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, resetStore, seedStore, store } from '../helpers/setup.js';

const app = createApp();

describe('Finance permissions', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('GET /api/finance-permissions/:consignmentId returns permissions', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app).get(`/api/finance-permissions/${cId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('org1', 'owner');
  });

  it('POST /api/finance-permissions/share grants access', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/finance-permissions/share')
      .send({ consignmentId: cId, targetOrgId: 'org2', role: 'viewer', sharerOrgName: 'Owner', targetOrgName: 'Viewer' });
    expect(res.status).toBe(200);
    expect(store.financePermissions[cId]).toHaveProperty('org2', 'viewer');
  });
});

describe('Payments', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('GET /api/payments returns payments for authorized org', async () => {
    const res = await request(app).get('/api/payments?orgId=org1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/payments creates a payment', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/payments')
      .send({
        consignmentId: cId, invoiceRef: 'INV-TEST-001', amount: 50000, currency: 'USD',
        dueDate: '2026-06-01', payorOrgId: 'org2', payeeOrgId: 'org1', creatorOrgId: 'org1',
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.amount).toBe(50000);
    expect(res.body.status).toBe('Unpaid');
  });

  it('POST /api/payments rejects non-owner', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/payments')
      .send({ consignmentId: cId, invoiceRef: 'INV-X', amount: 100, currency: 'USD', creatorOrgId: 'org99' });
    expect(res.status).toBe(403);
  });

  it('PUT /api/payments/:id/status updates payment status', async () => {
    // Create a payment first
    const cId = store.consignments[0].id;
    const createRes = await request(app)
      .post('/api/payments')
      .send({ consignmentId: cId, invoiceRef: 'INV-UPD', amount: 10000, currency: 'USD', creatorOrgId: 'org1' });
    const paymentId = createRes.body.id;

    const res = await request(app)
      .put(`/api/payments/${paymentId}/status`)
      .send({ status: 'Paid', paidAmount: 10000, orgId: 'org1', orgName: 'Test' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Paid');
    expect(res.body.paidAmount).toBe(10000);
  });
});

describe('Letter of Credit', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('POST /api/lc creates a letter of credit', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/lc')
      .send({
        consignmentId: cId, issuingBank: 'Test Bank', advisingBank: 'Advising Bank',
        amount: 100000, currency: 'USD', expiryDate: '2026-12-31', creatorOrgId: 'org1',
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('lcNumber');
    expect(res.body.status).toBe('Draft');
  });

  it('PUT /api/lc/:id/status updates LC status', async () => {
    const cId = store.consignments[0].id;
    const createRes = await request(app)
      .post('/api/lc')
      .send({ consignmentId: cId, issuingBank: 'B', amount: 1000, currency: 'USD', expiryDate: '2026-12-31', creatorOrgId: 'org1' });
    const lcId = createRes.body.id;

    const res = await request(app)
      .put(`/api/lc/${lcId}/status`)
      .send({ status: 'Issued', orgName: 'Test' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Issued');
  });
});

describe('Smart Contracts', () => {
  beforeEach(() => {
    resetStore();
    seedStore();
  });

  it('POST /api/contracts creates a smart contract', async () => {
    const cId = store.consignments[0].id;
    const res = await request(app)
      .post('/api/contracts')
      .send({
        consignmentId: cId, amount: 50000, currency: 'USD',
        conditions: [{ description: 'Bill of Lading verified' }, { description: 'Customs cleared' }],
        payorOrgId: 'org2', payeeOrgId: 'org1', creatorOrgId: 'org1',
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contractRef');
    expect(res.body.conditions).toHaveLength(2);
    expect(res.body.status).toBe('Active');
  });

  it('PUT /api/contracts/:id/condition/:condId verifies a condition', async () => {
    const cId = store.consignments[0].id;
    const createRes = await request(app)
      .post('/api/contracts')
      .send({
        consignmentId: cId, amount: 10000, currency: 'USD',
        conditions: [{ description: 'Test condition' }],
        creatorOrgId: 'org1',
      });
    const contractId = createRes.body.id;

    const res = await request(app)
      .put(`/api/contracts/${contractId}/condition/cond-0`)
      .send({ orgName: 'Test' });
    expect(res.status).toBe(200);
    expect(res.body.conditions[0].met).toBe(true);
    // Single condition + autoRelease => should be Released
    expect(res.body.status).toBe('Released');
  });
});
