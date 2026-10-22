// TWIN node compatibility layer (server/twin/compat) — the single home for
// every version-specific shim + the inventory + the version-assert.
import { describe, it, expect } from 'vitest';
import {
  NODE_COMPAT_VERSION,
  SHIMS,
  assertNodeCompat,
  parseNodeVersion,
  normalizeImmutableProof,
  findFirstByKey,
  genPolicyPassword,
  VM,
  VAULT_KEY,
  ORG_FUNDING_IOTA_DEFAULT,
} from '../../server/twin/compat/index.js';

const silent = { warn: () => {}, log: () => {} };

describe('twin compat — inventory', () => {
  it('declares a target node version', () => {
    expect(NODE_COMPAT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('every shim entry is fully documented', () => {
    expect(SHIMS.length).toBeGreaterThan(0);
    for (const s of SHIMS) {
      expect(s.id, 'id').toBeTruthy();
      expect(['in-process', 'infra', 'parameter']).toContain(s.kind);
      expect(s.compensates, `${s.id}.compensates`).toBeTruthy();
      expect(s.location, `${s.id}.location`).toBeTruthy();
      expect(s.removeWhen, `${s.id}.removeWhen`).toBeTruthy();
    }
  });

  it('shim ids are unique', () => {
    const ids = SHIMS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('twin compat — version assert', () => {
  it('parses the node root version banner', () => {
    expect(parseNodeVersion('TWIN Node - 0.0.3-next.40')).toBe('0.0.3-next.40');
    expect(parseNodeVersion('garbage')).toBeNull();
    expect(parseNodeVersion(null)).toBeNull();
  });

  it('passes when the reported version matches the target', () => {
    const r = assertNodeCompat(NODE_COMPAT_VERSION, { logger: silent });
    expect(r.ok).toBe(true);
    expect(r.reported).toBe(NODE_COMPAT_VERSION);
  });

  it('flags drift (but never throws) on a different version', () => {
    const r = assertNodeCompat('9.9.9-next.99', { logger: silent });
    expect(r.ok).toBe(false);
    expect(r.reported).toBe('9.9.9-next.99');
    expect(r.target).toBe(NODE_COMPAT_VERSION);
  });

  it('flags an unknown version without throwing', () => {
    expect(assertNodeCompat(null, { logger: silent }).ok).toBe(false);
  });
});

describe('twin compat — constants', () => {
  it('exposes the verification-method + vault-key names', () => {
    expect(VM.ORG_ASSERTION).toBe('org-assertion');
    expect(VM.ATTESTATION_ASSERTION).toBe('attestation-assertion');
    expect(VM.IMMUTABLE_PROOF_ASSERTION).toBe('immutable-proof-assertion');
    expect(VAULT_KEY.BLOB_ENCRYPTION).toEqual({ id: 'blob-encryption', type: 'ChaCha20Poly1305' });
    expect(VAULT_KEY.AUTH_SIGNING).toEqual({ id: 'auth-signing', type: 'Ed25519' });
  });

  it('per-org funding floor is above 1 IOTA (gas-budget reservation)', () => {
    expect(ORG_FUNDING_IOTA_DEFAULT).toBeGreaterThan(1n);
  });
});

describe('twin compat — password policy', () => {
  it('generates policy-compliant passwords (>=16, classes, no 3-run)', () => {
    for (let i = 0; i < 200; i++) {
      const pw = genPolicyPassword();
      expect(pw.length).toBeGreaterThanOrEqual(16);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
      expect(pw).not.toMatch(/(.)\1{2,}/);
    }
  });
});

describe('twin compat — immutable-proof normalization', () => {
  it('finds the on-chain reference at any nesting depth', () => {
    expect(findFirstByKey({ a: { b: { c: 42 } } }, 'c')).toBe(42);
    expect(findFirstByKey({ items: [{ id: 1 }, { id: 2 }] }, 'id')).toBe(1);
    expect(findFirstByKey({ a: 1 }, 'nope')).toBeUndefined();
  });

  it('normalizes a full proof (receipt present)', () => {
    // next.48 wires immutable-proof to a notarization connector, so the
    // normalized shape now also carries notarizationId (null when absent).
    const proof = { x: { proof: {
      verifiableStorageId: 'verifiable:iota:0x1:0xABC',
      notarizationId: 'notarization:iota:0x1:0xN1',
      proofIntegrity: 'sha256-x',
      immutableReceipt: { objectId: '0xDEF', network: 'testnet', epoch: 5, digest: '0x9', smartContractId: '0xC' },
    } } };
    expect(normalizeImmutableProof(proof)).toEqual({
      verifiableStorageId: 'verifiable:iota:0x1:0xABC',
      notarizationId: 'notarization:iota:0x1:0xN1',
      proofIntegrity: 'sha256-x',
      receipt: { objectId: '0xDEF', network: 'testnet', epoch: 5, digest: '0x9', smartContractId: '0xC' },
    });
  });

  it('returns receipt:null when no on-chain anchor is present yet (async signing)', () => {
    expect(normalizeImmutableProof({ proof: {} })).toEqual({
      verifiableStorageId: null, notarizationId: null, proofIntegrity: null, receipt: null,
    });
  });

  it('tolerates malformed receipt fields (wrong types → null)', () => {
    const proof = { immutableReceipt: { objectId: 123, network: 7, epoch: 'x' } };
    const r = normalizeImmutableProof(proof);
    expect(r.receipt).toEqual({ objectId: null, network: null, epoch: null, digest: null, smartContractId: null });
  });
});
