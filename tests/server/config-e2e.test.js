import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configsDir = path.join(__dirname, '../../configs');

/**
 * T-145: End-to-end testing of the config system.
 * Validates that all corridor configs are structurally valid and
 * internally consistent without needing to start a server.
 */

// Load all config files
const configFiles = readdirSync(configsDir).filter(f => f.endsWith('.json') && !f.endsWith('.schema.json'));
const configs = configFiles.map(f => ({
  file: f,
  id: f.replace('.json', ''),
  data: JSON.parse(readFileSync(path.join(configsDir, f), 'utf-8')),
}));

describe('Config system end-to-end validation', () => {

  it('has at least 2 corridor configs for validation', () => {
    expect(configs.length).toBeGreaterThanOrEqual(2);
  });

  describe.each(configs)('$file', ({ file, id, data }) => {

    it('has required top-level sections', () => {
      expect(data).toHaveProperty('corridor');
      expect(data).toHaveProperty('branding');
      expect(data).toHaveProperty('theme');
      expect(data).toHaveProperty('nodes');
      expect(data).toHaveProperty('credentials');
      expect(data).toHaveProperty('consignments');
      expect(data).toHaveProperty('documents');
      expect(data).toHaveProperty('documentTemplates');
      expect(data).toHaveProperty('finance');
      expect(data).toHaveProperty('geography');
    });

    it('corridor.id matches filename', () => {
      expect(data.corridor.id).toBe(id);
    });

    it('has valid semver version', () => {
      expect(data.corridor.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('branding has all required fields', () => {
      expect(data.branding.appName).toBeTruthy();
      expect(data.branding.tagline).toBeTruthy();
      expect(data.branding.logo).toMatch(/^\//);
      expect(data.branding.alpha).toHaveProperty('label');
      expect(data.branding.alpha).toHaveProperty('description');
      expect(data.branding.beta).toHaveProperty('label');
      expect(data.branding.beta).toHaveProperty('description');
    });

    it('theme colors are valid hex', () => {
      const hexPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
      for (const key of ['accent', 'accentLight', 'navBg', 'navHover', 'navActive', 'amber']) {
        expect(data.theme[key]).toMatch(hexPattern);
      }
    });

    it('all org IDs are unique across both nodes', () => {
      const allOrgs = [...data.nodes.alpha.orgs, ...data.nodes.beta.orgs];
      const ids = allOrgs.map(o => o.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all usernames are unique across both nodes', () => {
      const allOrgs = [...data.nodes.alpha.orgs, ...data.nodes.beta.orgs];
      const usernames = allOrgs.map(o => o.username);
      expect(new Set(usernames).size).toBe(usernames.length);
    });

    it('all passwords are "demo"', () => {
      const allOrgs = [...data.nodes.alpha.orgs, ...data.nodes.beta.orgs];
      for (const org of allOrgs) {
        expect(org.password).toBe('demo');
      }
    });

    it('alpha has at least 1 org', () => {
      expect(data.nodes.alpha.orgs.length).toBeGreaterThanOrEqual(1);
    });

    it('beta has at least 1 org', () => {
      expect(data.nodes.beta.orgs.length).toBeGreaterThanOrEqual(1);
    });

    it('consignment UCRs are unique', () => {
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      const ucrs = all.map(c => c.ucr);
      expect(new Set(ucrs).size).toBe(ucrs.length);
    });

    it('consignment creatorOrgIds reference valid orgs', () => {
      const allOrgIds = new Set([...data.nodes.alpha.orgs, ...data.nodes.beta.orgs].map(o => o.id));
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      for (const c of all) {
        expect(allOrgIds.has(c.creatorOrgId)).toBe(true);
      }
    });

    it('consignment currencies are in finance.currencies', () => {
      const validCurrencies = new Set(data.finance.currencies);
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      for (const c of all) {
        expect(validCurrencies.has(c.currency)).toBe(true);
      }
    });

    it('consignment countries are in geography.countries', () => {
      const validCountries = new Set(Object.keys(data.geography.countries));
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      for (const c of all) {
        expect(validCountries.has(c.fromCountry)).toBe(true);
        expect(validCountries.has(c.toCountry)).toBe(true);
      }
    });

    it('geography countries have valid ISO numeric codes', () => {
      for (const [name, geo] of Object.entries(data.geography.countries)) {
        expect(geo.iso).toMatch(/^\d{3}$/);
        expect(geo.coords).toHaveLength(2);
        expect(geo.spread).toBeGreaterThanOrEqual(0.5);
        expect(geo.spread).toBeLessThanOrEqual(20);
      }
    });

    it('has at least 2 types of consignment status', () => {
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      const statuses = new Set(all.map(c => c.status));
      expect(statuses.size).toBeGreaterThanOrEqual(2);
    });

    it('has at least 1 error consignment', () => {
      const all = [...data.consignments.alpha, ...data.consignments.beta];
      const errors = all.filter(c => c.errorType);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('finance seed UCRs reference valid consignments', () => {
      const allUcrs = new Set([...data.consignments.alpha, ...data.consignments.beta].map(c => c.ucr));
      for (const p of data.finance.seedData.payments) {
        expect(allUcrs.has(p.consignmentUcr)).toBe(true);
      }
      for (const lc of data.finance.seedData.letterOfCredits) {
        expect(allUcrs.has(lc.consignmentUcr)).toBe(true);
      }
      for (const sc of data.finance.seedData.smartContracts) {
        expect(allUcrs.has(sc.consignmentUcr)).toBe(true);
      }
    });

    it('finance org IDs reference valid orgs', () => {
      const allOrgIds = new Set([...data.nodes.alpha.orgs, ...data.nodes.beta.orgs].map(o => o.id));
      for (const p of data.finance.seedData.payments) {
        expect(allOrgIds.has(p.payorOrgId)).toBe(true);
        expect(allOrgIds.has(p.payeeOrgId)).toBe(true);
      }
    });

    it('test credentials have both pass and fail entries', () => {
      expect(data.credentials.testCredentials.pass.length).toBeGreaterThanOrEqual(1);
      expect(data.credentials.testCredentials.fail.length).toBeGreaterThanOrEqual(1);
    });

    it('has at least 1 payment method', () => {
      expect(data.finance.paymentMethods.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('cross-config uniqueness', () => {
    it('all corridor IDs are unique', () => {
      const ids = configs.map(c => c.data.corridor.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all corridor app names are unique', () => {
      const names = configs.map(c => c.data.branding.appName);
      expect(new Set(names).size).toBe(names.length);
    });
  });
});
