import { describe, it, expect, afterEach } from 'vitest';
import {
  ADAPTER_DEFAULT_MODE,
  ITWIN_ADAPTER_METHODS,
  SimulatedAdapter,
  DockerAdapter,
  HostedAdapter,
  createAdapter,
  createAndInitAdapter,
  resolveAdapterMode,
  resolveAdapterConfig,
} from '../../server/adapter/index.js';

describe('adapter factory', () => {
  it('returns the right concrete class per mode', () => {
    expect(createAdapter('simulated')).toBeInstanceOf(SimulatedAdapter);
    expect(createAdapter('docker')).toBeInstanceOf(DockerAdapter);
    expect(createAdapter('hosted')).toBeInstanceOf(HostedAdapter);
  });

  it('defaults to docker (production-leaning default; tests force simulated)', () => {
    expect(createAdapter()).toBeInstanceOf(DockerAdapter);
  });

  it('throws on unknown mode', () => {
    expect(() => createAdapter('bogus')).toThrow(/Unknown adapter mode/);
  });
});

describe('interface conformance — all three adapters expose ITwinAdapter methods', () => {
  for (const mode of ['simulated', 'docker', 'hosted']) {
    it(`${mode} adapter has every ITwinAdapter method`, () => {
      const a = createAdapter(mode);
      for (const m of ITWIN_ADAPTER_METHODS) {
        expect(typeof a[m]).toBe('function');
      }
      expect(a.mode).toBe(mode);
    });
  }
});

describe('warmUp + authStatus (T-210)', () => {
  it('SimulatedAdapter.warmUp is a no-op that reports authenticated', async () => {
    const a = new SimulatedAdapter();
    expect(a.authStatus()).toEqual({ authenticated: false, expiresInSeconds: null, subjectDid: null });
    await a.init({});
    expect(await a.warmUp()).toEqual({ authenticated: true, expiresInSeconds: null, subjectDid: null });
  });

  it('DockerAdapter.authStatus before warmUp reports not authenticated', async () => {
    const a = new DockerAdapter();
    await a.init({ nodeUrl: 'http://localhost:3000', email: 'admin@alpha', password: 'pw' });
    expect(a.authStatus()).toEqual({ authenticated: false, expiresInSeconds: null, subjectDid: null });
  });
});

describe('SimulatedAdapter', () => {
  it('init is no-op and isReady flips to true', async () => {
    const a = new SimulatedAdapter();
    expect(a.isReady()).toBe(false);
    expect(await a.init({})).toBe(true);
    expect(a.isReady()).toBe(true);
  });

  it('createDid returns fake DID, empty explorerUrl and the org-assertion VM fragment (T-211)', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const { did, explorerUrl, verificationMethodId } = await a.createDid();
    expect(did).toMatch(/^did:iota:0x[0-9a-f]+$/);
    expect(explorerUrl).toBe('');
    expect(verificationMethodId).toBe('org-assertion');
  });

  it('createImmutableProof returns a stable shape with a simulated receipt', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const result = await a.createImmutableProof({ '@type': 'Thing' });
    expect(result.proofId).toMatch(/^immutable-proof:sim-[0-9a-f]+$/);
    expect(result.receipt).toMatchObject({ simulated: true });
    expect(result.receipt.hash).toMatch(/^0x[0-9a-f]+$/);
  });

  it('verifyImmutableProof returns true (simulated)', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    expect(await a.verifyImmutableProof('any')).toBe(true);
  });

  it('createAttestation returns a sim attestation id', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const { attestationId } = await a.createAttestation({ '@type': 'DigitalDocument' });
    expect(attestationId).toMatch(/^attestation:sim-[0-9a-f]+$/);
  });

  it('storeDocument returns id, hash and blob size', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const buf = Buffer.from('hello world');
    const { documentId, hash, size } = await a.storeDocument(buf, { name: 'test.txt' });
    expect(documentId).toMatch(/^document:sim-[0-9a-f]+$/);
    expect(hash).toMatch(/^0x[0-9a-f]+$/);
    expect(size).toBe(buf.length);
  });

  it('pipeToTwin reports all six stages, all skipped in simulated mode', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const { stages, completed } = await a.pipeToTwin({});
    expect(stages.map(s => s.name)).toEqual(['parse','translate','notify','confirm','vc','anchor']);
    expect(completed).toBe(true);
  });

  it('T-303: AIS stream/append/list are no-ops returning empty/null', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    expect(await a.createAisStream({})).toBeNull();
    expect(await a.appendAisEntry('stream-x', { type: 'test' })).toBeNull();
    const result = await a.listAisEntries();
    expect(result.entries).toEqual([]);
    expect(result.simulated).toBe(true);
  });

  it('T-302: dspShareConsignment / dspRevokeConsignment are no-ops returning null', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    expect(await a.dspShareConsignment({
      consignment: { id: 'c1', ucr: 'X-1' },
      recipientOrg: { id: 'r', name: 'R' },
      sharerOrg: { id: 's', name: 'S' },
      documents: [],
      policyTargets: ['urn:moit:consignment:c1'],
    })).toBeNull();
    expect(await a.dspRevokeConsignment({
      consignment: { id: 'c1', ucr: 'X-1' },
      recipientOrg: { id: 'r', name: 'R' },
      revokerOrg: { id: 's', name: 'S' },
      policyId: null,
    })).toBeNull();
  });

  it('T-304: queryOdrlPolicies returns an empty list in simulated mode', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const result = await a.queryOdrlPolicies({ assignee: 'did:iota:tst:0x123' });
    expect(result.policies).toEqual([]);
    expect(result.simulated).toBe(true);
  });

  it('T-306: queryFederatedCatalog returns an empty list in simulated mode', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const result = await a.queryFederatedCatalog({ type: 'Organization' });
    expect(result.datasets).toEqual([]);
    expect(result.simulated).toBe(true);
  });

  it('T-312: verifyCrossNodeProof returns source=unavailable in simulated mode', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    const result = await a.verifyCrossNodeProof({
      proofId: 'immutable-proof:sim-xxx',
      notarizationNode: 'beta',
      receipt: { objectId: '0xabc' },
    });
    expect(result.verified).toBe(false);
    expect(result.source).toBe('unavailable');
  });

  it('T-313: dspNotifyDocumentUpload is a no-op returning null in simulated mode', async () => {
    const a = new SimulatedAdapter();
    await a.init({});
    expect(await a.dspNotifyDocumentUpload({
      doc: { id: 'd1', title: 'x' },
      consignment: { id: 'c1', ucr: 'X-1' },
      writerOrg: { id: 'w', name: 'W' },
      ownerOrg: { id: 'o', name: 'O' },
    })).toBeNull();
  });
});

describe('DockerAdapter', () => {
  it('init throws when required config is missing', async () => {
    const a = new DockerAdapter();
    await expect(a.init({})).rejects.toThrow(/nodeUrl is required/);
    await expect(a.init({ nodeUrl: 'http://x' })).rejects.toThrow(/email is required/);
    await expect(a.init({ nodeUrl: 'http://x', email: 'a@b' })).rejects.toThrow(/password is required/);
  });

  it('init with complete config flips isReady and exposes nodeUrl', async () => {
    const a = new DockerAdapter();
    await a.init({ nodeUrl: 'http://localhost:3000', email: 'admin@alpha', password: 'pw' });
    expect(a.isReady()).toBe(true);
    expect(a.nodeUrl).toBe('http://localhost:3000');
    expect(a.mode).toBe('docker');
  });

  it('storeDocument now wired to TWIN document-management (T-215); throws on network failure', async () => {
    const a = new DockerAdapter();
    // Unreachable port so the call fails fast without hitting a real node
    await a.init({ nodeUrl: 'http://127.0.0.1:1', email: 'admin@alpha', password: 'pw' });
    await expect(a.storeDocument(Buffer.from('x'), {
      documentId: 'doc1',
      documentCode: 'unece:DocumentCodeList#380',
    })).rejects.toThrow();
  });

  it('pipeToTwin throws "not implemented" pointing at T-240', async () => {
    const a = new DockerAdapter();
    await a.init({ nodeUrl: 'http://localhost:3000', email: 'admin@alpha', password: 'pw' });
    await expect(a.pipeToTwin({})).rejects.toThrow(/T-240/);
  });
});

describe('resolveAdapterMode (T-209)', () => {
  const original = process.env.ADAPTER_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.ADAPTER_MODE;
    else process.env.ADAPTER_MODE = original;
  });

  it('defaults to docker when ADAPTER_MODE is unset', () => {
    delete process.env.ADAPTER_MODE;
    expect(ADAPTER_DEFAULT_MODE).toBe('docker');
    expect(resolveAdapterMode()).toBe('docker');
  });

  it('reads ADAPTER_MODE env var', () => {
    process.env.ADAPTER_MODE = 'simulated';
    expect(resolveAdapterMode()).toBe('simulated');
    process.env.ADAPTER_MODE = 'hosted';
    expect(resolveAdapterMode()).toBe('hosted');
  });

  it('throws on invalid ADAPTER_MODE', () => {
    process.env.ADAPTER_MODE = 'bogus';
    expect(() => resolveAdapterMode()).toThrow(/Invalid ADAPTER_MODE=bogus/);
  });
});

describe('resolveAdapterConfig (T-209)', () => {
  const snapshot = {};
  const keys = ['TWIN_ALPHA_URL', 'TWIN_ALPHA_EMAIL', 'TWIN_ALPHA_PASSWORD',
                'TWIN_BETA_URL',  'TWIN_BETA_EMAIL',  'TWIN_BETA_PASSWORD'];
  for (const k of keys) snapshot[k] = process.env[k];
  afterEach(() => {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('returns empty config for simulated mode', () => {
    expect(resolveAdapterConfig('simulated', 'alpha')).toEqual({});
  });

  it('docker mode: defaults Alpha to localhost:3000 with demo credentials', () => {
    for (const k of keys) delete process.env[k];
    const cfg = resolveAdapterConfig('docker', 'alpha');
    // toMatchObject (not toEqual): multi-tenant adds an optional `apiKey`
    // read from data/tenant-state.json when present (T-314). The defaults
    // under test are nodeUrl/email/password.
    expect(cfg).toMatchObject({
      nodeUrl: 'http://localhost:3000',
      email: 'admin@alpha',
      password: 'TwinAlpha#2026!Demo',
    });
  });

  it('docker mode: defaults Beta to localhost:3001', () => {
    for (const k of keys) delete process.env[k];
    expect(resolveAdapterConfig('docker', 'beta').nodeUrl).toBe('http://localhost:3001');
  });

  it('reads TWIN_<NODE>_* env vars when set', () => {
    process.env.TWIN_ALPHA_URL = 'http://custom:9000';
    process.env.TWIN_ALPHA_EMAIL = 'svc@alpha.example';
    process.env.TWIN_ALPHA_PASSWORD = 'override-1234567890';
    expect(resolveAdapterConfig('docker', 'alpha')).toMatchObject({
      nodeUrl: 'http://custom:9000',
      email: 'svc@alpha.example',
      password: 'override-1234567890',
    });
  });

  it('hosted mode requires TWIN_<NODE>_URL (fail-fast, no defaults)', () => {
    for (const k of keys) delete process.env[k];
    expect(() => resolveAdapterConfig('hosted', 'alpha')).toThrow(/hosted mode requires TWIN_ALPHA_URL/);
  });

  it('hosted mode succeeds with explicit TWIN_<NODE>_URL', () => {
    process.env.TWIN_BETA_URL = 'https://twin-beta.example.com';
    const cfg = resolveAdapterConfig('hosted', 'beta');
    expect(cfg.nodeUrl).toBe('https://twin-beta.example.com');
  });
});

describe('createAndInitAdapter (T-209)', () => {
  it('produces a ready SimulatedAdapter without touching the network', async () => {
    const a = await createAndInitAdapter('simulated', 'alpha');
    expect(a).toBeInstanceOf(SimulatedAdapter);
    expect(a.isReady()).toBe(true);
  });

  it('builds a DockerAdapter from env defaults without connecting (lazy auth)', async () => {
    const a = await createAndInitAdapter('docker', 'alpha');
    expect(a).toBeInstanceOf(DockerAdapter);
    expect(a.isReady()).toBe(true);
    expect(a.nodeUrl).toBe('http://localhost:3000');
  });
});

describe('HostedAdapter', () => {
  it('refuses localhost nodeUrl', async () => {
    const a = new HostedAdapter();
    await expect(a.init({ nodeUrl: 'http://localhost:3000', email: 'a@b', password: 'pw' }))
      .rejects.toThrow(/use DockerAdapter instead/);
    await expect(a.init({ nodeUrl: 'http://127.0.0.1:3000', email: 'a@b', password: 'pw' }))
      .rejects.toThrow(/use DockerAdapter instead/);
  });

  it('init succeeds for a remote URL', async () => {
    const a = new HostedAdapter();
    await a.init({ nodeUrl: 'https://twin.example.com', email: 'a@b', password: 'pw' });
    expect(a.isReady()).toBe(true);
    expect(a.mode).toBe('hosted');
    expect(a.nodeUrl).toBe('https://twin.example.com');
  });
});
