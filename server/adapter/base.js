/**
 * Abstract TWIN adapter contract. Three concrete adapters implement it:
 * SimulatedAdapter (no network, mirrors current demo behaviour), DockerAdapter
 * (REST calls to local Docker TWIN Nodes), HostedAdapter (REST calls to a
 * remote hosted TWIN Node).
 *
 * Routes invoke adapter.<method>() without knowing the backend; T-209 wires
 * the ADAPTER_MODE env var to the factory in ./index.js to choose at startup.
 *
 * @typedef {Object} AdapterConfig
 * @property {'simulated'|'docker'|'hosted'} mode
 * @property {string} [nodeUrl]   Required for docker/hosted.
 * @property {string} [email]     Required for docker/hosted.
 * @property {string} [password]  Required for docker/hosted.
 *
 * @typedef {Object} CreateDidResult
 * @property {string} did                Issued DID identifier.
 * @property {string} explorerUrl        Block-explorer URL (empty for simulated).
 * @property {string} verificationMethodId  Local fragment of the assertion VM provisioned on the DID.
 *
 * @typedef {Object} CreateProofResult
 * @property {string} proofId
 * @property {unknown} receipt
 *
 * @typedef {Object} CreateAttestationResult
 * @property {string} attestationId
 *
 * @typedef {Object} StoreDocumentResult
 * @property {string} documentId            Local demo-side document identifier.
 * @property {string|null} documentManagementId  TWIN AIG vertex id (null in simulated/on failure).
 * @property {string} hash                  SHA-256 of the blob (`0x`-prefixed hex), or random when no blob.
 * @property {number} size                  Blob byte length.
 *
 * @typedef {Object} PipelineSummary
 * @property {string} pipelineId
 * @property {Array<{name:string, status:'ok'|'skipped'|'error', detail?:string}>} stages
 * @property {boolean} completed
 *
 * @typedef {Object} AdapterAuthStatus
 * @property {boolean} authenticated  True if the adapter holds a valid session against its backend.
 * @property {number|null} expiresInSeconds  Seconds until the cached session expires; null for simulated.
 * @property {string|null} subjectDid  DID embedded in the JWT (docker/hosted only).
 */

const NOT_IMPL = (m) => { throw new Error(`ITwinAdapter.${m}() not implemented by this adapter`); };

export class ITwinAdapter {
  /** @returns {'simulated'|'docker'|'hosted'} */
  get mode() { NOT_IMPL('mode'); }

  /** @param {AdapterConfig} config @returns {Promise<boolean>} */
  async init(_config) { NOT_IMPL('init'); }

  /** @returns {boolean} */
  isReady() { NOT_IMPL('isReady'); }

  // Eagerly authenticate against the backend. Simulated mode is a no-op.
  // Docker/hosted call the underlying KitsuneClient.login() so the token
  // is cached before the first user-facing request arrives.
  /** @returns {Promise<AdapterAuthStatus>} */
  async warmUp() { NOT_IMPL('warmUp'); }

  // Snapshot of the current auth state. Does NOT trigger a login.
  /** @returns {AdapterAuthStatus} */
  authStatus() { NOT_IMPL('authStatus'); }

  // ── Identity ──
  /** @returns {Promise<CreateDidResult>} */
  async createDid() { NOT_IMPL('createDid'); }

  /** @param {string} did @returns {Promise<unknown>} */
  async resolveDid(_did) { NOT_IMPL('resolveDid'); }

  // ── Notarization ──
  /** @param {Record<string,unknown>} document @returns {Promise<CreateProofResult>} */
  async createImmutableProof(_document) { NOT_IMPL('createImmutableProof'); }

  /** @param {string} proofId @returns {Promise<boolean>} */
  async verifyImmutableProof(_proofId) { NOT_IMPL('verifyImmutableProof'); }

  // Fetch the raw immutable-proof record (a VC). Used by integration tests to
  // confirm that the on-chain document carries the expected SHA-256.
  /** @param {string} proofId @returns {Promise<unknown>} */
  async getImmutableProof(_proofId) { NOT_IMPL('getImmutableProof'); }

  /** @param {Record<string,unknown>} jsonLd @returns {Promise<CreateAttestationResult>} */
  async createAttestation(_jsonLd) { NOT_IMPL('createAttestation'); }

  // T-1b — per-org signing. Provisions a TWIN user account bound to the
  // org's DID so subsequent attestations made by that org are signed by
  // the org's identity instead of the node admin's.
  /** @param {{orgId:string, did:string}} input @returns {Promise<{email:string, password:string}>} */
  async provisionOrgUser(_input) { NOT_IMPL('provisionOrgUser'); }

  // Issue an attestation signed by the given org (not by the node admin).
  // Requires provisionOrgUser to have been called for this orgId first.
  /** @param {{orgId:string, email:string, password:string}} creds @param {Record<string,unknown>} jsonLd @returns {Promise<CreateAttestationResult>} */
  async createAttestationAs(_creds, _jsonLd) { NOT_IMPL('createAttestationAs'); }

  // ── Document Management ──
  /** @param {Buffer} blob @param {Record<string,unknown>} metadata @returns {Promise<StoreDocumentResult>} */
  async storeDocument(_blob, _metadata) { NOT_IMPL('storeDocument'); }

  // ── Auditable Item Graph (T-217) ──
  // Shadow consignment CRUD onto the AIG. The in-memory store is the
  // primary source; the AIG vertex provides a tamper-evident audit log.
  // Simulated mode is a no-op (returns null).
  /** @param {{annotationObject:Record<string,unknown>, aliases?:{id:string,aliasFormat?:string}[]}} input @returns {Promise<{aigVertexId:string}|null>} */
  async createAigVertex(_input) { NOT_IMPL('createAigVertex'); }

  /** @param {{id:string, annotationObject:Record<string,unknown>, aliases?:{id:string,aliasFormat?:string}[]}} input @returns {Promise<void>} */
  async updateAigVertex(_input) { NOT_IMPL('updateAigVertex'); }

  /** @param {string} id @param {number=} limit @returns {Promise<unknown>} */
  async getAigChangesets(_id, _limit) { NOT_IMPL('getAigChangesets'); }

  // ── Auditable Item Stream (T-303) ──
  // Append-only event stream that backs the ledger view. One stream per
  // node holds every event emitted by addLog(). Simulated mode returns
  // null/no-ops so the in-memory ledger stays unchanged.
  /** @param {{annotationObject?:Record<string,unknown>}=} input @returns {Promise<{aisStreamId:string}|null>} */
  async createAisStream(_input) { NOT_IMPL('createAisStream'); }

  /** @param {string} streamId @param {Record<string,unknown>} entryObject @returns {Promise<{entryId:string}|null>} */
  async appendAisEntry(_streamId, _entryObject) { NOT_IMPL('appendAisEntry'); }

  /** @param {string=} streamId @param {{limit?:number, cursor?:string}=} options @returns {Promise<{entries:unknown[], cursor?:string}>} */
  async listAisEntries(_streamId, _options) { NOT_IMPL('listAisEntries'); }

  // ── DSP cross-node exchange (T-302) ──
  // High-level orchestrators that replace the WebSocket P2P share/revoke
  // path. In docker/hosted mode each call fans out to (a) an ODRL policy
  // create/delete on the local rights-management endpoint and (b) a W3C
  // Activity Streams Add/Remove notification on the DSP data plane. The
  // consumer node ingests the notification and updates its own store.
  // Simulated mode is a no-op so the WS path stays the primary exchange.
  /** @param {{consignment:object, recipientOrg:object, sharerOrg:object, documents:object[], policyTargets:string[]}} input @returns {Promise<{policyId:string,activityLogId:string}|null>} */
  async dspShareConsignment(_input) { NOT_IMPL('dspShareConsignment'); }

  /** @param {{consignment:object, recipientOrg:object, policyId?:string|null, revokerOrg:object}} input @returns {Promise<{activityLogId:string,policyRemoved:boolean}|null>} */
  async dspRevokeConsignment(_input) { NOT_IMPL('dspRevokeConsignment'); }

  // ── ODRL policy enforcement (T-304) ──
  // Query the local TWIN node's PolicyAdministrationPoint for policies
  // matching the given filter. Used at boot to hydrate the in-memory
  // permission cache so cross-restart authorisation stays consistent.
  /** @param {{assigner?:string, assignee?:string, target?:string, action?:string, cursor?:string, limit?:number}=} options @returns {Promise<{policies:unknown[], cursor?:string}>} */
  async queryOdrlPolicies(_options) { NOT_IMPL('queryOdrlPolicies'); }

  // ── Federated catalogue (T-306) ──
  // Query the TWIN node's DCAT-formatted catalogue. Returns datasets from
  // both the local node and any peers configured in TWIN_DATASPACE_PEER_NODES.
  // Used by the boot-time peer-org hydration to replace the WS handshake's
  // ORG_DIRECTORY message with standards-based discovery.
  /** @param {Record<string,unknown>=} filter @returns {Promise<{datasets:unknown[], raw?:unknown}>} */
  async queryFederatedCatalog(_filter) { NOT_IMPL('queryFederatedCatalog'); }

  // ── Cross-node proof verification (T-312) ──
  // Verify a proof anchored on the peer's TWIN node. Two paths, tried in
  // order:
  //   1. DSP data plane query against the peer (the proof + receipt come
  //      back signed by the peer node).
  //   2. On-chain fallback: parse the IOTA testnet anchor referenced by
  //      `receipt.objectId` (the chain is public — no TWIN node needed).
  // Returns { verified, source } where source is "dsp" | "iota-testnet"
  // | "unavailable". Simulated mode returns { verified: false, source:
  // 'unavailable' } since cross-node proofs can't exist there.
  /** @param {{proofId:string, notarizationNode:string, receipt?:object|null}} input @returns {Promise<{verified:boolean, source:string, detail?:string}>} */
  async verifyCrossNodeProof(_input) { NOT_IMPL('verifyCrossNodeProof'); }

  // ── Collaborative writes (T-313) ──
  // Notify the consignment owner that this node just uploaded a
  // document against a shared consignment. The owner side ingests the
  // activity and appends the doc to its consignment AIG vertex. The
  // doc is anchored on this (writer's) chain — the receiver uses T-312
  // for cross-node verify.
  /** @param {{doc:object, consignment:object, writerOrg:object, ownerOrg:object}} input @returns {Promise<{activityLogId:string}|null>} */
  async dspNotifyDocumentUpload(_input) { NOT_IMPL('dspNotifyDocumentUpload'); }

  // ── Pipeline ──
  /** @param {unknown} envelope @returns {Promise<PipelineSummary>} */
  async pipeToTwin(_envelope) { NOT_IMPL('pipeToTwin'); }
}

export const ITWIN_ADAPTER_METHODS = Object.freeze([
  'init',
  'isReady',
  'warmUp',
  'authStatus',
  'createDid',
  'resolveDid',
  'createImmutableProof',
  'verifyImmutableProof',
  'getImmutableProof',
  'createAttestation',
  'provisionOrgUser',
  'createAttestationAs',
  'storeDocument',
  'createAigVertex',
  'updateAigVertex',
  'getAigChangesets',
  'createAisStream',
  'appendAisEntry',
  'listAisEntries',
  'dspShareConsignment',
  'dspRevokeConsignment',
  'queryOdrlPolicies',
  'queryFederatedCatalog',
  'verifyCrossNodeProof',
  'dspNotifyDocumentUpload',
  'pipeToTwin',
]);
