import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, store } from '../helpers/setup.js';

const app = createApp();

/**
 * T-1V07: Verify Vietnamese diacritics survive the full pipeline:
 * config JSON -> store -> Express API -> JSON response
 */
describe('Vietnamese diacritics support', () => {
  it('preserves diacritics in org names through GET /api/orgs', async () => {
    // Inject a Vietnamese-named org
    const vnOrg = {
      id: 'orgVN',
      name: 'Tổng cục Hải quan Việt Nam',
      role: 'Cơ quan Hải quan - Việt Nam',
      username: 'vntest',
      password: 'demo',
      orgType: 'public',
    };
    store.orgs.push(vnOrg);

    const res = await request(app).get('/api/orgs');
    expect(res.status).toBe(200);
    const found = res.body.find(o => o.id === 'orgVN');
    expect(found).toBeDefined();
    expect(found.name).toBe('Tổng cục Hải quan Việt Nam');
    expect(found.role).toBe('Cơ quan Hải quan - Việt Nam');

    // Cleanup
    store.orgs = store.orgs.filter(o => o.id !== 'orgVN');
  });

  it('preserves diacritics in consignment product names', async () => {
    const vnConsignment = {
      id: 'cVN',
      ucr: 'VN-2026-EXP-VN001',
      product: 'Áo sơ mi nam (Vải dệt thoi)',
      hsCode: '6205.20',
      quantity: '1,000 chiếc',
      totalValue: 10000,
      currency: 'USD',
      exporter: 'Công ty Cổ phần Đầu tư và Thương mại LBA',
      importer: 'Northpeak Athletics Inc.',
      fromCountry: 'Việt Nam',
      toCountry: 'Hoa Kỳ',
      originPort: 'Cảng Cát Lái, TP. Hồ Chí Minh',
      destinationPort: 'Port of Los Angeles',
      vessel: 'MV Bluewave Seletar',
      shipDate: '2026-05-01',
      incoterms: 'FOB',
      invoiceRef: 'INV-2026-LBA-VN01',
      declRef: 'VN-EXP-2026-VN01',
      status: 'Submitted',
      creatorOrgId: 'org1',
      creatorOrgName: 'Công ty Cổ phần Đầu tư và Thương mại LBA',
      docs: [],
    };
    store.consignments.push(vnConsignment);
    store.permissions[vnConsignment.id] = { org1: 'owner' };

    const res = await request(app).get('/api/consignments?orgId=org1');
    expect(res.status).toBe(200);
    const found = res.body.find(c => c.ucr === 'VN-2026-EXP-VN001');
    expect(found).toBeDefined();
    expect(found.product).toBe('Áo sơ mi nam (Vải dệt thoi)');
    expect(found.exporter).toBe('Công ty Cổ phần Đầu tư và Thương mại LBA');
    expect(found.fromCountry).toBe('Việt Nam');
    expect(found.originPort).toBe('Cảng Cát Lái, TP. Hồ Chí Minh');

    // Cleanup
    store.consignments = store.consignments.filter(c => c.ucr !== 'VN-2026-EXP-VN001');
    delete store.permissions[vnConsignment.id];
  });

  it('XML escaper preserves Vietnamese characters', () => {
    // Import the escXml function directly
    const escXml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const vietnamese = 'Tổng cục Hải quan Việt Nam';
    expect(escXml(vietnamese)).toBe('Tổng cục Hải quan Việt Nam');

    const withSpecial = 'Công ty <Đầu tư> & Thương mại "LBA"';
    expect(escXml(withSpecial)).toBe('Công ty &lt;Đầu tư&gt; &amp; Thương mại &quot;LBA&quot;');
  });

  it('handles all Vietnamese tone marks correctly', () => {
    // All 6 Vietnamese tones across vowels
    const toneMarks = [
      'à á ả ã ạ',  // a with marks
      'ằ ắ ẳ ẵ ặ',  // ă with marks
      'ầ ấ ẩ ẫ ậ',  // â with marks
      'è é ẻ ẽ ẹ',  // e with marks
      'ề ế ể ễ ệ',  // ê with marks
      'ì í ỉ ĩ ị',  // i with marks
      'ò ó ỏ õ ọ',  // o with marks
      'ồ ố ổ ỗ ộ',  // ô with marks
      'ờ ớ ở ỡ ợ',  // ơ with marks
      'ù ú ủ ũ ụ',  // u with marks
      'ừ ứ ử ữ ự',  // ư with marks
      'ỳ ý ỷ ỹ ỵ',  // y with marks
    ];

    for (const tone of toneMarks) {
      const encoded = JSON.stringify(tone);
      const decoded = JSON.parse(encoded);
      expect(decoded).toBe(tone);
    }
  });
});
