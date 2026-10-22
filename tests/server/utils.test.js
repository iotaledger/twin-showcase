import { describe, it, expect } from 'vitest';
import {
  iotaExplorerUrlFromVerifiableStorageId,
  iotaExplorerUrlFromAttestationId,
  explorerUrlFromImmutableProof,
  findFirstByKey,
  sha256OfBuffer,
} from '../../server/utils.js';

describe('iotaExplorerUrlFromVerifiableStorageId', () => {
  it('extracts the trailing object hex and builds an IOTA Explorer URL', () => {
    const vsid = 'verifiable:iota:0x2dc63eedae3a93a908bc724c2b77a1f500c67eba131b8422ba3f06e6e99a10e0:0x7979ef35df74e823c370bb45066fc768e5239937ab948475d532db70f2edb4cc';
    const url = iotaExplorerUrlFromVerifiableStorageId(vsid);
    expect(url).toBe('https://explorer.iota.org/object/0x7979ef35df74e823c370bb45066fc768e5239937ab948475d532db70f2edb4cc?network=testnet');
  });

  it('honours a custom network parameter', () => {
    const url = iotaExplorerUrlFromVerifiableStorageId('verifiable:iota:0xaa:0xbb', 'mainnet');
    expect(url).toBe('https://explorer.iota.org/object/0xbb?network=mainnet');
  });

  it('returns null for missing, non-string, or unparseable values', () => {
    expect(iotaExplorerUrlFromVerifiableStorageId(null)).toBeNull();
    expect(iotaExplorerUrlFromVerifiableStorageId(undefined)).toBeNull();
    expect(iotaExplorerUrlFromVerifiableStorageId(123)).toBeNull();
    expect(iotaExplorerUrlFromVerifiableStorageId('no-hex-here')).toBeNull();
  });
});

describe('findFirstByKey', () => {
  it('finds a top-level key', () => {
    expect(findFirstByKey({ a: 1 }, 'a')).toBe(1);
  });
  it('walks nested objects', () => {
    expect(findFirstByKey({ a: { b: { c: 42 } } }, 'c')).toBe(42);
  });
  it('walks arrays', () => {
    expect(findFirstByKey({ items: [{ id: 1 }, { id: 2 }] }, 'id')).toBe(1);
  });
  it('returns undefined when missing', () => {
    expect(findFirstByKey({ a: 1 }, 'nope')).toBeUndefined();
  });
});

describe('explorerUrlFromImmutableProof', () => {
  it('handles old shape (top-level verifiableStorageId)', () => {
    const proof = { verifiableStorageId: 'verifiable:iota:0xaa:0xbb' };
    expect(explorerUrlFromImmutableProof(proof))
      .toBe('https://explorer.iota.org/object/0xbb?network=testnet');
  });

  it('handles TWIN 0.0.3-next.40 shape (nested under proof)', () => {
    const proof = {
      proof: {
        verifiableStorageId: 'verifiable:iota:0xaa:0xcafe1234',
        immutableReceipt: { objectId: '0xcafe1234', network: 'testnet' },
      },
    };
    expect(explorerUrlFromImmutableProof(proof))
      .toBe('https://explorer.iota.org/object/0xcafe1234?network=testnet');
  });

  it('falls back to immutableReceipt when verifiableStorageId is absent', () => {
    const proof = {
      proof: {
        immutableReceipt: { objectId: '0xdeadbeef', network: 'mainnet' },
      },
    };
    expect(explorerUrlFromImmutableProof(proof))
      .toBe('https://explorer.iota.org/object/0xdeadbeef?network=mainnet');
  });

  it('returns null when neither field is present', () => {
    expect(explorerUrlFromImmutableProof({ foo: 'bar' })).toBeNull();
    expect(explorerUrlFromImmutableProof(null)).toBeNull();
  });
});

describe('iotaExplorerUrlFromAttestationId', () => {
  it('decodes the base64 NFT URN and points the Explorer at the object hex', () => {
    // urn = "nft:iota:testnet:0xCAFE:0xBEEF"
    const urn = 'nft:iota:testnet:0xCAFE:0xBEEF';
    const id = 'attestation:nft:' + Buffer.from(urn).toString('base64');
    expect(iotaExplorerUrlFromAttestationId(id))
      .toBe('https://explorer.iota.org/object/0xBEEF?network=testnet');
  });

  it('returns null for missing/non-string/non-attestation input', () => {
    expect(iotaExplorerUrlFromAttestationId(null)).toBeNull();
    expect(iotaExplorerUrlFromAttestationId(undefined)).toBeNull();
    expect(iotaExplorerUrlFromAttestationId('immutable-proof:abc')).toBeNull();
    expect(iotaExplorerUrlFromAttestationId('attestation:nft:invalid')).toBeNull();
  });
});

describe('sha256OfBuffer', () => {
  it('returns the canonical SHA-256 of the input bytes as 0x-hex', () => {
    expect(sha256OfBuffer(Buffer.from('abc'))).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('produces 64 hex chars (32 bytes) for any non-empty input', () => {
    const result = sha256OfBuffer(Buffer.from('arbitrary content'));
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
