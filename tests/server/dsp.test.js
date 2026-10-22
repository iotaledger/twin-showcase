import { describe, it, expect } from 'vitest';
import {
  DEFAULT_URN_NS, asOrgAgent, buildOdrlOfferPolicy, buildShareActivity, buildDocumentUploadActivity,
} from '../../server/adapter/dsp.js';

// T-412 / T-418 — unit coverage for the extracted DSP protocol builders.
// These shape the cross-node federation messages; pure functions, no infra.

const sharer = { id: 'org1', name: 'LBA', did: 'did:iota:tst:0xAAA' };
const recipient = { id: 'org13', name: 'US Import Customs', did: 'did:iota:tst:0xBBB' };
const consignment = { id: 'seed-VN-1', ucr: 'VN-2026-EXP-00101', exporter: 'LBA', importer: 'US Import Customs' };

describe('buildOdrlOfferPolicy', () => {
  it('builds a policy-namespaced Offer with use+modify per target and a top-level assigner', () => {
    const p = buildOdrlOfferPolicy({ consignment, recipientOrg: recipient, sharerOrg: sharer, targets: ['urn:corridor:document:d1'] });
    expect(p['@type']).toBe('Offer');
    expect(p.uid).toBe('policy:corridor:seed-VN-1:org13'); // first segment MUST be `policy`
    expect(p['@context']).toBe('http://www.w3.org/ns/odrl.jsonld'); // http, not https
    expect(p.assigner).toBe(sharer.did);
    expect(p.permission.map(x => x.action)).toEqual(['use', 'modify']);
    expect(p.permission.every(x => x.target === 'urn:corridor:document:d1')).toBe(true);
  });

  it('defaults the target to the consignment URN for a full share', () => {
    const p = buildOdrlOfferPolicy({ consignment, recipientOrg: recipient, sharerOrg: sharer });
    expect(p.permission[0].target).toBe('urn:corridor:consignment:seed-VN-1');
  });

  it('falls back to urn:<ns>:org ids when a party has no DID', () => {
    const p = buildOdrlOfferPolicy({ consignment, recipientOrg: { id: 'org13' }, sharerOrg: { id: 'org1' }, ns: 'vn' });
    expect(p.assigner).toBe('urn:vn:org:org1');
    expect(p.permission[0].assignee).toBe('urn:vn:org:org13');
  });
});

describe('asOrgAgent', () => {
  it('produces a conformant AS Organization agent (context + type + id)', () => {
    expect(asOrgAgent(sharer)).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams', id: sharer.did, type: 'Organization', name: 'LBA',
    });
  });
  it('falls back to a urn id without a DID', () => {
    expect(asOrgAgent({ id: 'orgX', name: 'X' }).id).toBe(`urn:${DEFAULT_URN_NS}:org:orgX`);
  });
});

describe('buildShareActivity', () => {
  it('carries the UNECE consignment as the object and strips doc blobs', () => {
    const a = buildShareActivity({
      action: 'Add', consignment, sharerOrg: sharer, recipientOrg: recipient, policyId: 'policy:corridor:x',
      documents: [{ id: 'd1', title: 'Invoice', fileBase64: 'SECRET' }],
    });
    expect(a.type).toBe('Add');
    expect(a.generator).toBe(sharer.did); // inbox requires a DID generator
    expect(a.object.identifier).toBe('VN-2026-EXP-00101'); // UNECE consignment object
    expect(a.object.attachment[0]).toMatchObject({ type: 'Document', id: 'd1', title: 'Invoice' });
    expect(JSON.stringify(a)).not.toContain('SECRET'); // blob never rides the wire
    expect(a.context.policyId).toBe('policy:corridor:x');
  });
});

describe('buildDocumentUploadActivity', () => {
  it('builds a reverse-direction Add for a single doc, blob stripped', () => {
    const a = buildDocumentUploadActivity({
      doc: { id: 'd9', name: 'Packing List', fileBase64: 'SECRET' },
      consignment, writerOrg: recipient, ownerOrg: sharer,
    });
    expect(a.type).toBe('Add');
    expect(a.actor.id).toBe(recipient.did);  // writer
    expect(a.target.id).toBe(sharer.did);    // owner
    expect(a.object.content.fileBase64).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain('SECRET');
  });
});
