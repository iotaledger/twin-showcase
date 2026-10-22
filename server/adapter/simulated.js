import { ITwinAdapter } from './base.js';
import { genId, genHash, genDID } from '../utils.js';

// No-network adapter that mirrors the in-memory demo behaviour. All IDs,
// DIDs and hashes are random; nothing is anchored on IOTA. Default mode.
export class SimulatedAdapter extends ITwinAdapter {
  #ready = false;

  get mode() { return 'simulated'; }

  async init(_config) {
    this.#ready = true;
    return true;
  }

  isReady() { return this.#ready; }

  async warmUp() {
    return this.authStatus();
  }

  authStatus() {
    return { authenticated: this.#ready, expiresInSeconds: null, subjectDid: null };
  }

  // ── Identity ──
  async createDid() {
    const did = genDID();
    return { did, explorerUrl: '', verificationMethodId: 'org-assertion' };
  }

  async resolveDid(did) {
    return { id: did, simulated: true };
  }

  // ── Notarization ──
  async createImmutableProof(document) {
    return {
      proofId: 'immutable-proof:sim-' + genId(),
      receipt: { hash: genHash(), document, simulated: true },
    };
  }

  async verifyImmutableProof(_proofId) {
    return true;
  }

  // Synthetic VC for tests that exercise the proof-fetch path in simulated
  // mode. Real shape is provided by the TWIN node in docker/hosted modes.
  async getImmutableProof(proofId) {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: proofId,
      type: ['VerifiableCredential', 'ImmutableProof'],
      credentialSubject: { simulated: true, proofId },
    };
  }

  async createAttestation(_jsonLd) {
    return { attestationId: 'attestation:sim-' + genId() };
  }

  // T-1b stubs — simulated mode pretends the org has its own TWIN user.
  async provisionOrgUser({ orgId }) {
    return { email: `${orgId}@sim.demo`, password: 'sim-' + genId() };
  }

  async createAttestationAs(_creds, _jsonLd) {
    return { attestationId: 'attestation:sim-org-' + genId() };
  }

  // ── Document Management ──
  async storeDocument(blob, _metadata) {
    return {
      documentId: 'document:sim-' + genId(),
      documentManagementId: 'aig:sim-' + genId(),
      hash: genHash(),
      size: blob?.length ?? 0,
    };
  }

  // ── AIG (T-217) — simulated mode skips shadow writes ──
  // Returning null lets the consignment route persist `aigVertexId = null`
  // and tell the UI "shadowing not active for this mode".
  async createAigVertex(_input) { return null; }
  async updateAigVertex(_input) { /* no-op */ }
  async getAigChangesets(_id, _limit) {
    return { changesets: { entries: [] }, simulated: true };
  }

  // ── AIS (T-303) — simulated mode skips stream writes ──
  // Returning null tells store.js to skip stream init and fall back to the
  // in-memory ledger. The /api/ledger endpoint returns store.ledgerLog
  // directly when the adapter is simulated.
  async createAisStream(_input) { return null; }
  async appendAisEntry(_streamId, _entryObject) { return null; }
  async listAisEntries(_streamId, _options) {
    return { entries: [], simulated: true };
  }

  // ── DSP share/revoke (T-302) — simulated mode skips DSP calls ──
  // Returning null tells the permissions route to fall back to the
  // existing WebSocket P2P path. No ODRL policy is created on the TWIN
  // node and no Activity is forwarded — the in-memory store + WS broadcast
  // stay the sole mechanism for cross-node share/revoke.
  async dspShareConsignment(_input) { return null; }
  async dspRevokeConsignment(_input) { return null; }

  // ── ODRL enforcement (T-304) — simulated mode has no policies ──
  // Returning an empty list tells the permission hydrator there's nothing
  // to merge; the in-memory store.permissions remains the source of truth.
  async queryOdrlPolicies(_options) { return { policies: [], simulated: true }; }

  // ── Federated catalogue (T-306) — simulated mode has no catalogue ──
  // Peer org discovery falls back to the existing WS ORG_DIRECTORY path.
  async queryFederatedCatalog(_filter) { return { datasets: [], simulated: true }; }

  // ── Cross-node verify (T-312) — simulated mode has no peer chain ──
  // Cross-node proofs can't exist in simulated mode (both nodes share the
  // same in-memory adapter state). Return a deterministic "unavailable"
  // so the route can decide whether to surface an error or skip.
  async verifyCrossNodeProof(_input) {
    return { verified: false, source: 'unavailable', detail: 'simulated mode has no cross-node chain' };
  }

  // ── Collaborative writes (T-313) — simulated mode skips DSP notify ──
  // The existing T-245 WS UPLOAD_DOCUMENT path stays the sole mechanism
  // for cross-node doc propagation in simulated mode.
  async dspNotifyDocumentUpload(_input) { return null; }

  // ── Pipeline (stub for T-240) ──
  async pipeToTwin(_envelope) {
    return {
      pipelineId: 'pipeline:sim-' + genId(),
      stages: [
        { name: 'parse',     status: 'ok' },
        { name: 'translate', status: 'ok' },
        { name: 'notify',    status: 'skipped', detail: 'simulated' },
        { name: 'confirm',   status: 'skipped', detail: 'simulated' },
        { name: 'vc',        status: 'skipped', detail: 'simulated' },
        { name: 'anchor',    status: 'skipped', detail: 'simulated' },
      ],
      completed: true,
    };
  }
}
