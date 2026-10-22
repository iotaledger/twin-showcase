import { ITwinAdapter } from './base.js';
import { KitsuneClient } from '../twin/dist/index.js';
import { iotaExplorerUrlFromDid } from '../utils.js';
import { flatFromAigVertex } from '../twin/unece.js';
// TWIN node version-specific names + policy live in the compat layer.
import { VM, genPolicyPassword } from '../twin/compat/index.js';
// DSP protocol builders (ODRL policy + Activity Streams) — the cross-node
// federation vocabulary; the DSP methods below orchestrate, dsp.js shapes.
import { DEFAULT_URN_NS, buildOdrlOfferPolicy, buildShareActivity, buildDocumentUploadActivity } from './dsp.js';

// REST client adapter pointed at a Docker-deployed TWIN Node on localhost
// (3000 for Alpha, 3001 for Beta). Delegates every operation to KitsuneClient
// from T-234. JWT auth is lazy: the first method call triggers login.
export class DockerAdapter extends ITwinAdapter {
  #ready = false;
  #client = null;
  #config = null;
  // Per-org Kitsune clients (cache keyed by orgId). Each entry uses the
  // org's own TWIN user credentials, so attestations issued via that
  // client are signed by the org's DID instead of the node admin's.
  #orgClients = new Map();
  // DSP cross-node federation: clients to the PEER node(s) so a federated
  // share's data-plane notify can be delivered to the recipient org's node
  // (cache keyed by nodeId). Resolved from config.peers at init.
  #peerClients = new Map();
  #nodeId = null;
  #peers = {};
  #resolveOrgNode = null;
  // DSP trust gate (next.48): resolves an org's own tenant credentials so a
  // cross-node share's notify can carry a trust VC signed by the sharer org's
  // DID. Injected (like #resolveOrgNode) to avoid a circular import.
  #resolveOrgTenant = null;

  get mode() { return 'docker'; }

  async init(config) {
    if (!config?.nodeUrl) throw new Error('DockerAdapter.init: config.nodeUrl is required');
    if (!config?.email)   throw new Error('DockerAdapter.init: config.email is required');
    if (!config?.password) throw new Error('DockerAdapter.init: config.password is required');
    this.#config = config;
    this.#nodeId = config.nodeId ?? (config.nodeUrl?.match(/localhost:(\d+)/)?.[1] === '3001' ? 'beta' : 'alpha');
    this.#peers = config.peers ?? {};
    this.#resolveOrgNode = typeof config.resolveOrgNode === 'function' ? config.resolveOrgNode : null;
    this.#resolveOrgTenant = typeof config.resolveOrgTenant === 'function' ? config.resolveOrgTenant : null;
    this.#client = new KitsuneClient({
      nodeUrl: config.nodeUrl,
      email: config.email,
      password: config.password,
      // T-314: present when multi-tenant is enabled on the node and the
      // operator has anchored via wallets.mjs (which persists the key in
      // data/tenant-state.json). Resolved by createAndInitAdapter() and
      // passed through here.
      apiKey: config.apiKey,
      // T-324: this node's own encrypted tenant token (for its own data-plane
      // reads, e.g. getActivityLog). Cross-node notify uses the peer's token
      // (see #clientForNode).
      encTenantToken: config.encTenantToken,
    });
    this.#ready = true;
    return true;
  }

  isReady() { return this.#ready; }

  /** Subclasses (e.g. HostedAdapter) read the resolved nodeUrl. */
  get nodeUrl() { return this.#config?.nodeUrl ?? null; }

  /** Internal accessor for subclasses that need the underlying Kitsune client. */
  get client() {
    if (!this.#client) throw new Error(`${this.mode}Adapter: not initialised (call init() first)`);
    return this.#client;
  }

  // ── Auth lifecycle (T-210) ──

  // Eagerly authenticate so the JWT is cached before the first user-facing
  // request. Returns the resulting auth status. The caller decides whether
  // to surface or swallow a failure (the server boot path logs and falls
  // through so a TWIN node outage doesn't block the demo server).
  async warmUp() {
    await this.client.login();
    return this.authStatus();
  }

  // Snapshot of the cached session. Does not trigger a login. The subject
  // DID is decoded from the JWT payload's `sub` claim.
  authStatus() {
    const session = this.#client?.getCachedSession?.();
    if (!session) return { authenticated: false, expiresInSeconds: null, subjectDid: null };
    const expiresInSeconds = Math.max(0, Math.floor((session.expiry - Date.now()) / 1000));
    let subjectDid = null;
    try {
      const payload = session.token.split('.')[1];
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      subjectDid = typeof json?.sub === 'string' ? json.sub : null;
    } catch { /* ignore — token shape can vary */ }
    return { authenticated: true, expiresInSeconds, subjectDid };
  }

  // ── Identity ──

  // Local fragment for the assertion verification method we provision on every
  // org DID. Used downstream when issuing org-scoped verifiable credentials.
  // (Names centralised in the TWIN compat layer — see server/twin/compat.)
  static ORG_VERIFICATION_METHOD_ID = VM.ORG_ASSERTION;
  // TWIN's attestation-service signs with `${orgDid}#attestation-assertion`
  // (hardcoded default in @twin.org/attestation-service). Without this VM
  // on the org DID, POST /attestation returns 500 attestationService.attestFailed.
  static ATTESTATION_VERIFICATION_METHOD_ID = VM.ATTESTATION_ASSERTION;

  async createDid() {
    const doc = await this.client.createDid('iota');
    const did = doc.id;
    // T-247: use the Explorer's /identity/ path which renders the DID
    // document (VMs, services, controller) in human-readable form,
    // instead of /object/ which only shows the raw on-chain object.
    const explorerUrl = iotaExplorerUrlFromDid(did) ?? '';
    const vmId = DockerAdapter.ORG_VERIFICATION_METHOD_ID;
    // Provision the assertion VM so the org DID is ready for VC issuance.
    // ensureVerificationMethod is idempotent.
    await this.client.ensureVerificationMethod(did, vmId);
    // Also provision the VM TWIN's attestation-service uses by default,
    // so POST /attestation by this org's user can sign with this DID.
    await this.client.ensureVerificationMethod(
      did,
      DockerAdapter.ATTESTATION_VERIFICATION_METHOD_ID,
    );
    return { did, explorerUrl, verificationMethodId: vmId };
  }

  async resolveDid(did) {
    return this.client.resolveDid(did);
  }

  // ── Notarization ──
  async createImmutableProof(document) {
    const proofId = await this.client.createImmutableProof(document);
    return { proofId, receipt: { pending: true, note: 'TWIN node signs the proof asynchronously' } };
  }

  async verifyImmutableProof(proofId) {
    const verification = await this.client.verifyImmutableProof(proofId);
    return Boolean(verification?.verified);
  }

  async getImmutableProof(proofId) {
    return this.client.getImmutableProof(proofId);
  }

  async createAttestation(jsonLd) {
    const attestationId = await this.client.createAttestation(jsonLd);
    return { attestationId };
  }

  // ── T-1b: per-org user provisioning + per-org attestation signing ──

  // Create a TWIN user account linked to the org's DID. The admin Kitsune
  // client (this.client) does the call; the returned credentials must be
  // persisted by the caller for later use in createAttestationAs.
  async provisionOrgUser({ orgId, did }) {
    if (!orgId || !did) throw new Error('provisionOrgUser: orgId and did are required');
    const node = this.nodeUrl?.match(/localhost:(\d+)/)?.[1] === '3001' ? 'beta' : 'alpha';
    const email = `${orgId}@${node}.demo.local`;
    // TWIN password policy (compat layer — password-policy shim): >=16 chars,
    // char classes, and no run of 3+ identical chars (validation.repeatedCharacters).
    const password = genPolicyPassword();
    await this.client.createUser({
      email, password,
      userIdentity: did,
      organizationIdentity: did,
      scope: ['user'],
    });
    return { email, password };
  }

  // Return (lazily build) the org-scoped Kitsune client. Each org's client
  // holds its own JWT so concurrent uploads from different orgs don't fight
  // over the cached session.
  #getOrgClient({ orgId, email, password, tenantApiKey }) {
    let c = this.#orgClients.get(orgId);
    if (!c) {
      c = new KitsuneClient({
        nodeUrl: this.nodeUrl,
        email,
        password,
        // T-316: under the tenant-per-org model each org is its own TWIN
        // tenant, so the org user lives in the org's tenant — login AND every
        // request must carry that org's x-api-key, not the node tenant's.
        // Fall back to the node tenant key for orgs provisioned the old way
        // (REST createDid, one-tenant-per-node) so mixed states still work.
        apiKey: tenantApiKey ?? this.#config?.apiKey,
      });
      this.#orgClients.set(orgId, c);
    }
    return c;
  }

  async createAttestationAs({ orgId, email, password, did, tenantApiKey }, jsonLd, namespace) {
    if (!orgId || !email || !password) {
      throw new Error('createAttestationAs: missing org credentials (run provisionOrgUser first)');
    }
    const client = this.#getOrgClient({ orgId, email, password, tenantApiKey });
    try {
      const attestationId = await client.createAttestation(jsonLd, namespace);
      return { attestationId };
    } catch (e) {
      // Self-heal: TWIN's attestation-service requires the org DID to expose
      // an `#attestation-assertion` verification method. Older DIDs (created
      // before this was provisioned at register time) lack it and fail with
      // attestationService.attestFailed. Provision via admin and retry once.
      // Note: under tenant-per-org the org's own client (not the node admin)
      // is the VM controller, so retry via the org client too.
      if (did) {
        try {
          await client.ensureVerificationMethod(
            did,
            DockerAdapter.ATTESTATION_VERIFICATION_METHOD_ID,
          );
          const attestationId = await client.createAttestation(jsonLd, namespace);
          return { attestationId };
        } catch (retryErr) {
          throw new Error(`${e.message} (retry after ensureVM failed: ${retryErr.message})`);
        }
      }
      throw e;
    }
  }

  // ── Document Management (T-215) ──
  //
  // metadata = {
  //   documentId: string,        // local demo id, becomes the TWIN documentId
  //   documentCode: string,      // UN/EDIFACT code, e.g. "unece:DocumentCodeList#380"
  //   filename?: string,
  //   title?: string,
  //   contentType?: string,
  //   sha256?: string,           // computed by the caller; surfaced as metadata
  //   creator?: { name: string, did?: string },
  //   relatedTo?: string,        // UCR or other anchor identifier
  //   createAttestation?: boolean,
  // }
  async storeDocument(blob, metadata = {}) {
    const u8 = blob instanceof Uint8Array ? blob : Buffer.from(blob ?? []);
    const annotation = {
      '@context': 'https://schema.org',
      '@type': 'DigitalDocument',
      identifier: metadata.documentId,
      name: metadata.title || metadata.filename || metadata.documentId,
      encodingFormat: metadata.contentType,
      contentSize: u8.length,
      sha256: metadata.sha256,
      ...(metadata.creator ? { creator: { '@type': 'Organization', name: metadata.creator.name } } : {}),
      ...(metadata.relatedTo ? { about: { '@type': 'Thing', identifier: metadata.relatedTo } } : {}),
    };
    const { documentManagementId } = await this.client.storeDocument({
      documentId: metadata.documentId,
      documentCode: metadata.documentCode ?? 'unece:DocumentCodeList#190', // Other administrative
      blob: u8,
      annotation,
      documentIdFormat: metadata.documentIdFormat,
      createAttestation: metadata.createAttestation ?? true,
    });
    return {
      documentId: metadata.documentId,
      documentManagementId,
      hash: metadata.sha256 ?? null,
      size: u8.length,
    };
  }

  // ── Auditable Item Graph (T-217) ──
  // Shadow consignment CRUD onto the TWIN node's AIG so we get a
  // tamper-evident audit log alongside the in-memory store. The in-memory
  // record stays the source of truth; the AIG vertex is a verifiable copy.

  async createAigVertex({ annotationObject, aliases }) {
    return this.client.createAigVertex({ annotationObject, aliases });
  }

  // Node-authoritative consignment list: read the consignments straight from
  // the node's Auditable Item Graph (the source of truth), not the in-memory
  // store. Consignment vertices carry a UCR alias; the demo flat shape is
  // reconstructed from the twinFlatConsignment blob (flatFromAigVertex). The
  // list query returns summaries only, so each vertex is fetched for its
  // annotation (N+1 — fine for the demo's handful of consignments).
  async listConsignments({ creatorOrgId } = {}) {
    const summaries = await this.client.queryAigVertices({ limit: 500 });
    // The node returns `aliases` as a single object when there's only one, an
    // array otherwise; consignment vertices carry a UCR-format alias (documents
    // carry a single alias with no aliasFormat).
    const asArr = (x) => Array.isArray(x) ? x : (x ? [x] : []);
    const ucrOf = (v) => asArr(v.aliases).find(a => /ucr/i.test(a?.aliasFormat || ''))?.id;
    const consignmentVertices = summaries.filter(v => ucrOf(v));
    // Dedup by UCR: cross-node replication is not transactional with the
    // in-memory store (a re-share after a demo restart can create a second
    // vertex for the same UCR — the node persists across restarts, the
    // in-memory idempotency guard does not). The UCR is the natural unique key,
    // so collapse duplicates here keeping the newest vertex per UCR. This also
    // saves the per-vertex fetch (N+1) on the dropped duplicates.
    const newestByUcr = new Map();
    for (const v of consignmentVertices) {
      const ucr = ucrOf(v);
      const prev = newestByUcr.get(ucr);
      if (!prev || String(v.dateCreated ?? '') > String(prev.dateCreated ?? '')) newestByUcr.set(ucr, v);
    }
    const out = [];
    const deduped = [...newestByUcr.values()];
    for (const s of deduped) {
      try {
        const vertex = await this.client.getAigVertex(s.id);
        const flat = flatFromAigVertex({ ...vertex, id: vertex.id ?? s.id, aliases: vertex.aliases ?? s.aliases });
        if (!flat) continue;
        if (creatorOrgId && flat.creatorOrgId !== creatorOrgId) continue;
        out.push(flat);
      } catch { /* skip an unreadable vertex rather than fail the whole list */ }
    }
    return out;
  }

  // Idempotency guard for cross-node replication: does this node already hold a
  // consignment vertex for this UCR? Returns the vertex id, or null. Used before
  // replicating a shared consignment so a re-share (after a demo restart, when
  // the in-memory idempotency guard has been reset but the node vertex persists)
  // doesn't create a duplicate vertex for the same UCR.
  async findConsignmentVertexIdByUcr(ucr) {
    if (!ucr) return null;
    const asArr = (x) => Array.isArray(x) ? x : (x ? [x] : []);
    const summaries = await this.client.queryAigVertices({ limit: 500 });
    const match = summaries.find(v =>
      asArr(v.aliases).some(a => /ucr/i.test(a?.aliasFormat || '') && a?.id === ucr));
    return match?.id ?? null;
  }

  async updateAigVertex({ id, annotationObject, aliases }) {
    return this.client.updateAigVertex({ id, annotationObject, aliases });
  }

  async getAigChangesets(id, limit) {
    return this.client.getAigChangesets(id, limit);
  }

  // ── Auditable Item Stream (T-303) ──
  // One stream per node, created lazily at server boot. Each addLog() call
  // appends an entry to this stream. /api/ledger reads the cross-stream
  // entries endpoint (passing streamId=undefined) so the response includes
  // entries from streams created in prior boots too.

  async createAisStream(input = {}) {
    return this.client.createAisStream(input);
  }

  async appendAisEntry(streamId, entryObject) {
    return this.client.appendAisEntry(streamId, entryObject);
  }

  async listAisEntries(streamId, options) {
    return this.client.listAisEntries(streamId, options);
  }

  // ── DSP cross-node exchange (T-302) ──
  //
  // Orchestrates the SHARE/REVOKE flow on the TWIN node's DSP stack:
  //   share:  POST /rights-management/policy/admin    (ODRL offer)
  //         + POST /dataspace-data-plane/notify       (Activity Add)
  //   revoke: DELETE /rights-management/policy/admin/{id}
  //         + POST /dataspace-data-plane/notify       (Activity Remove)
  //
  // The Activity carries the consignment + documents inline under
  // `object`, so the consumer node's adapter can ingest the payload
  // from the activity log without a separate transfer round-trip
  // (simpler than the full DSP transfer negotiation lifecycle).
  // Both calls are best-effort: the demo's in-memory state + WS
  // broadcast in routes/permissions.js stays the synchronous source of
  // truth for the local UI; DSP runs alongside to drive the
  // cross-node exchange.

  async dspShareConsignment(input) {
    const { consignment, recipientOrg, sharerOrg, documents, policyTargets, urnNamespace } = input;
    const ns = urnNamespace || DEFAULT_URN_NS;
    const policy = buildOdrlOfferPolicy({
      consignment,
      recipientOrg,
      sharerOrg,
      targets: policyTargets,
      ns,
    });
    const { policyId } = await this.client.createOdrlPolicy(policy);
    // Two artifacts make the cross-node share real:
    //   1. the ODRL policy above — the verifiable, on-chain access grant.
    //   2. the Activity notify below — a genuine push into the TWIN DSP
    //      data-plane (POST /dataspace/notify) on the RECIPIENT's node, so the
    //      recipient's node records + processes the consignment in its own
    //      data-plane activity log. (The full catalogue/dataset advertisement
    //      is deferred — it needs a node-engine-registered dataspace-app, see
    //      docs/dsp-design.md / T-321.)
    // Kept best-effort so a notify hiccup never discards the successful policy;
    // the demo's WS peering also propagates to the peer UI in parallel.
    const activity = buildShareActivity({
      action: 'Add',
      consignment,
      documents,
      sharerOrg,
      recipientOrg,
      policyId,
      ns,
    });
    // Deliver the notify to the recipient org's node (the consumer side of the
    // federation). Falls back to the local node when the recipient is on this
    // node or its node can't be resolved.
    const recipientNode = this.#resolveOrgNode?.(recipientOrg?.id) ?? null;
    const { client: notifyClient, nodeId: federatedTo } = this.#clientForNode(recipientNode);
    // T-432 (node 0.9.0, verified against the LIVE node): the recipient's
    // `/dataspace/inbox` requires THREE things — `?organization=<recipientOrgDid>`,
    // an `x-api-key` for the recipient org's tenant, and a trust VC as an
    // Authorization bearer (the inverse of next.48, which rejected the bearer).
    // Mint the sharer-org trust VC and resolve the recipient org's tenant key.
    const recipientTenant = this.#resolveOrgTenant?.(federatedTo, recipientOrg?.id) ?? null;
    const trustJwt = await this.#mintShareTrustCredential({ sharerOrg, recipientOrg, ns });
    let activityLogId = null;
    let acceptance = null;
    let delivered = false;
    try {
      // T-325: forwardActivity returns the recipient's handleActivity reply
      // (acceptance object, from the inbox response tasks[0].result) — Beta
      // confirming it ingested.
      ({ activityLogId, acceptance } = await notifyClient.forwardActivity(activity, {
        organization: recipientOrg?.did ?? null,
        apiKey: recipientTenant?.tenantApiKey ?? null,
        trustPayload: trustJwt,
      }));
      // T-430: the notify POST succeeded, so the consignment WAS delivered to the
      // recipient node's data-plane inbox (the node then ingests asynchronously).
      // This is the reliable "delivered" signal; activityLogId/acceptance are
      // best-effort and can lag the async processing, so the receipt must not
      // depend on them to avoid a false "transfer did not complete" alarm.
      delivered = true;
    } catch (e) {
      console.warn(`[adapter/docker] dspShareConsignment: policy ${policyId} created, but DSP notify to node "${federatedTo}" failed (${e.message}); cross-node propagation falls back to WS peering.`);
    }

    // T-431: confirm receipt by OBSERVING the recipient node's ledger — the
    // ground truth, regardless of whether delivery went over the DSP inbox or
    // the WS peer fallback, and regardless of the inbox's async reply shape.
    // Poll the recipient node's AIG (via the same peer client that delivered the
    // notify) for the shared consignment's UCR — the identical query the
    // recipient's own inbound poll uses. When it appears, the consignment was
    // genuinely received and stored on the recipient's ledger.
    const ucr = consignment?.ucr;
    if (!acceptance?.accepted && ucr && federatedTo && federatedTo !== this.#nodeId) {
      const asArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
      const ucrOf = (v) => asArr(v.aliases).find((a) => /ucr/i.test(a?.aliasFormat || ""))?.id;
      const CONFIRM_ATTEMPTS = 6;
      const CONFIRM_INTERVAL_MS = 1500;
      for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
        try {
          const vertices = await notifyClient.queryAigVertices({ limit: 500 });
          const match = asArr(vertices).find((v) => ucrOf(v) === ucr);
          if (match) {
            delivered = true;
            acceptance = {
              accepted: true,
              ucr,
              node: federatedTo,
              acceptedAt: new Date().toISOString(),
              vertexId: match.id ?? null,
              observed: true,
            };
            break;
          }
        } catch {
          /* recipient not queryable yet — keep trying within the budget */
        }
        await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
      }
    }
    return { policyId, activityLogId, acceptance, federatedToNode: federatedTo, delivered };
  }

  // RETAINED, NOT CURRENTLY WIRED (2026-06-08): the trust VC verifies correctly
  // on the recipient (TrustService logs "verified successfully"), but this node
  // config's API-auth layer rejects ANY Authorization bearer on /dataspace/inbox
  // with 401, so the trust VC cannot ride the request — the encrypted tenant
  // token is the gate instead (see forwardActivity + docs/dsp-design.md).
  // Kept for when the inbox accepts a trust bearer (e.g. an inbox route exempted
  // from API-auth), at which point dspShareConsignment can pass the jwt again.
  // Mint the trust VC: signed by the sharer org's own DID via its
  // `#org-assertion` VM, so the
  // recipient's jwt-verifiable-credential verifier resolves it on IOTA testnet
  // and admits the notify. Best-effort: returns undefined on failure (the notify
  // is then attempted unauthenticated and degrades to WS peering, as before).
  async #mintShareTrustCredential({ sharerOrg, recipientOrg, ns }) {
    try {
      const tenant = this.#resolveOrgTenant?.(this.#nodeId, sharerOrg?.id) ?? null;
      const did = sharerOrg?.did || tenant?.orgDid;
      if (!did) {
        throw new Error(`no DID for sharer org "${sharerOrg?.id ?? 'unknown'}"`);
      }
      // Sign AS the org: under tenant-per-org the org's own client controls its
      // VM (the node admin does not). Fall back to the node client when the org
      // has no dedicated tenant (single-tenant provisioning).
      const client = tenant?.email && tenant?.password
        ? this.#getOrgClient({
            orgId: sharerOrg.id,
            email: tenant.email,
            password: tenant.password,
            tenantApiKey: tenant.tenantApiKey,
          })
        : this.client;
      const credentialId = `urn:${ns}:trust:${sharerOrg.id}:${recipientOrg?.id ?? 'peer'}`;
      const { jwt } = await client.createCredential({
        identity: did,
        verificationMethodId: DockerAdapter.ORG_VERIFICATION_METHOD_ID,
        credentialId,
        subject: {
          id: did,
          '@type': 'OrganizationTrustAssertion',
          organization: sharerOrg.name ?? sharerOrg.id,
        },
      });
      return jwt;
    } catch (e) {
      console.warn(`[adapter/docker] dspShareConsignment: trust VC mint failed (${e.message}); DSP notify will be attempted unauthenticated.`);
      return undefined;
    }
  }

  // Resolve the Kitsune client for a target node: the local client when the
  // node is this adapter's own (or unknown), else a cached client to the peer
  // node (built from config.peers). Returns { client, nodeId } where nodeId is
  // the node the client actually talks to.
  #clientForNode(nodeId) {
    if (!nodeId || nodeId === this.#nodeId) return { client: this.client, nodeId: this.#nodeId };
    const peer = this.#peers?.[nodeId];
    if (!peer?.nodeUrl) return { client: this.client, nodeId: this.#nodeId };
    let c = this.#peerClients.get(nodeId);
    if (!c) {
      c = new KitsuneClient({
        nodeUrl: peer.nodeUrl,
        email: peer.email,
        password: peer.password,
        apiKey: peer.apiKey,
        // T-324: the peer (recipient) node's encrypted tenant token gates its
        // /dataspace/inbox. forwardActivity runs on THIS peer client, so it must
        // carry the recipient node's token.
        encTenantToken: peer.encTenantToken,
      });
      this.#peerClients.set(nodeId, c);
    }
    return { client: c, nodeId };
  }

  async dspRevokeConsignment(input) {
    const { consignment, recipientOrg, policyId, revokerOrg, urnNamespace } = input;
    const ns = urnNamespace || DEFAULT_URN_NS;
    let policyRemoved = false;
    if (policyId) {
      try {
        await this.client.deleteOdrlPolicy(policyId);
        policyRemoved = true;
      } catch (e) {
        // Don't abort the whole revoke if the policy was already gone —
        // still emit the Remove activity so the consumer can drop access.
        console.warn(`[adapter/docker] deleteOdrlPolicy(${policyId}) failed: ${e.message}`);
      }
    }
    const activity = buildShareActivity({
      action: 'Remove',
      consignment,
      documents: [],
      sharerOrg: revokerOrg,
      recipientOrg,
      policyId: policyId ?? null,
      ns,
    });
    // Best-effort (see dspShareConsignment): the policy deletion above is the
    // authoritative revoke; the Remove activity notify is the federated push.
    let activityLogId = null;
    try {
      ({ activityLogId } = await this.client.forwardActivity(activity));
    } catch (e) {
      console.warn(`[adapter/docker] dspRevokeConsignment: policy removed=${policyRemoved}, but activity notify is unavailable (${e.message}); cross-node propagation falls back to WS peering.`);
    }
    return { activityLogId, policyRemoved };
  }

  // ── ODRL enforcement (T-304) ──
  async queryOdrlPolicies(options = {}) {
    return this.client.queryOdrlPolicies(options);
  }

  // ── Federated catalogue (T-306) ──
  async queryFederatedCatalog(filter = {}) {
    return this.client.queryFederatedCatalog(filter);
  }

  // ── Collaborative writes (T-313) ──
  // Emit a W3C Activity Streams Add with object.type=DigitalDocument so
  // the consignment owner's TWIN can ingest the upload and append it
  // to the consignment AIG vertex. The doc was just anchored locally
  // by createImmutableProof on POST /api/documents — that proofId is
  // included in the activity so the owner can verify cross-node via
  // T-312's verifyCrossNodeProof.
  async dspNotifyDocumentUpload(input) {
    const { doc, consignment, writerOrg, ownerOrg, urnNamespace } = input ?? {};
    const activity = buildDocumentUploadActivity({ doc, consignment, writerOrg, ownerOrg, ns: urnNamespace || DEFAULT_URN_NS });
    const { activityLogId } = await this.client.forwardActivity(activity);
    return { activityLogId };
  }

  // ── Cross-node verify (T-312) ──
  // Path 1 — DSP data plane query: ask the local TWIN node to fetch the
  // proof from the peer via the federated DSP. The local node returns
  // the W3C VC, the consumer can locally verify the signature.
  // Path 2 — IOTA on-chain fallback: if path 1 fails, hit the testnet
  // RPC directly using receipt.objectId. Proves the anchor exists on
  // chain without going through any TWIN node.
  async verifyCrossNodeProof(input) {
    const { proofId, receipt } = input ?? {};
    // Path 1: DSP query is documented in dsp-design.md
    // step 7 but requires a known datasetId; for proof verification we
    // route through the (federated) immutable-proof endpoint by id
    // directly. If the peer's federation is enabled, the local node's
    // ImmutableProof connector should resolve the proof transparently.
    if (proofId) {
      try {
        const verification = await this.client.verifyImmutableProof(proofId);
        if (verification?.verified) {
          return { verified: true, source: 'dsp', detail: 'verified via federated immutable-proof' };
        }
      } catch (_e) {
        // Fall through to IOTA on-chain path.
      }
    }
    // Path 2: parse the on-chain receipt directly. The objectId / network
    // were captured at notarization time and propagated via the
    // SHARE_CONSIGNMENT / UPLOAD_DOCUMENT messages or DSP activity. No
    // TWIN node required to confirm the anchor exists.
    const objectId = receipt?.objectId ?? receipt?.verifiableStorageId ?? null;
    const network = receipt?.network ?? 'testnet';
    if (objectId) {
      const rpcUrl = network === 'mainnet'
        ? 'https://api.mainnet.iota.cafe'
        : 'https://api.testnet.iota.cafe';
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'iota_getObject',
            params: [objectId, { showType: true, showOwner: false, showContent: false }],
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (body?.result?.data?.objectId === objectId) {
          return { verified: true, source: 'iota-testnet', detail: `on-chain object resolved on ${network}` };
        }
        return { verified: false, source: 'iota-testnet', detail: 'object not found on chain' };
      } catch (e) {
        return { verified: false, source: 'unavailable', detail: `IOTA RPC failed: ${e.message}` };
      }
    }
    return { verified: false, source: 'unavailable', detail: 'no proofId or on-chain receipt to verify' };
  }

  // ── Pipeline (T-240 will implement the six-stage pipeline) ──
  async pipeToTwin(_envelope) {
    throw new Error('DockerAdapter.pipeToTwin: not implemented yet (T-240 will implement the six-stage pipeline)');
  }
}
