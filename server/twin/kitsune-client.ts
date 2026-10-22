import type { IBaseRestClientConfig } from "@twin.org/api-models";
import type { IJsonLdNodeObject } from "@twin.org/data-json-ld";
import type { IActivityLogEntry } from "@twin.org/dataspace-models";
import type { IImmutableProofCredential, IImmutableProofVerification } from "@twin.org/immutable-proof-models";
import type { IActivityStreamsActivity } from "@twin.org/standards-w3c-activity-streams";
import type {
  IDidDocument,
  IDidVerifiableCredential,
} from "@twin.org/standards-w3c-did";
import { DidVerificationMethodType } from "@twin.org/standards-w3c-did";

import { AttestationRestClient } from "@twin.org/attestation-rest-client";
import { AuditableItemGraphRestClient } from "@twin.org/auditable-item-graph-rest-client";
import type { IAuditableItemGraphAlias } from "@twin.org/auditable-item-graph-models";
import { AuditableItemGraphContexts, AuditableItemGraphTypes } from "@twin.org/auditable-item-graph-models";
import { AuditableItemStreamRestClient } from "@twin.org/auditable-item-stream-rest-client";
import type { IAuditableItemStreamEntry } from "@twin.org/auditable-item-stream-models";
import { AuditableItemStreamContexts, AuditableItemStreamTypes } from "@twin.org/auditable-item-stream-models";
import { DataspaceDataPlaneRestClient } from "@twin.org/dataspace-data-plane-rest-client";
import { DocumentManagementRestClient } from "@twin.org/document-management-rest-client";
import { IdentityResolverRestClient } from "@twin.org/identity-rest-client";
import { ImmutableProofRestClient } from "@twin.org/immutable-proof-rest-client";
import { PolicyAdministrationPointRestClient } from "@twin.org/rights-management-rest-client";
import { SchemaOrgContexts } from "@twin.org/standards-schema-org";

import { PatchedIdentityRestClient } from "./patched-identity-rest-client.js";

export interface KitsuneClientOptions {
  nodeUrl: string;
  email: string;
  password: string;
  sessionTtlMs?: number;
  // T-314: when the TWIN node runs in multi-tenant mode
  // (TWIN_TENANT_ENABLED=true), every REST call — login included —
  // requires `x-api-key`. Provide the tenant API key captured during the
  // anchor stage (persisted in data/tenant-state.json) here.
  apiKey?: string;
  // T-324: the DSP data-plane inbox (/dataspace/inbox) and entity reads are
  // gated by `tenantProcessor.missingTenantToken` unless the request carries
  // the url-transformer ENCRYPTED tenant token as a QUERY PARAM
  // (?x-enc-tenant-token=…). It is produced by the node's `tenant-token` CLI
  // and persisted in data/tenant-state.json (nodes.<node>.encTenantToken). For a
  // cross-node notify this must be the RECIPIENT node's token. Confirmed live:
  // a header is NOT accepted; the BaseRestClient preserves an endpoint query
  // string, so we smuggle it via the endpoint URL.
  encTenantToken?: string;
}

export interface AuthSession {
  token: string;
  expiry: number;
}

interface LoginResponseBody {
  token?: string;
  access_token?: string;
  expiry?: number;
}

const REFRESH_SAFETY_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

// Typed REST wrapper around a single TWIN Node REST API. Each demo server
// (Alpha :4000, Beta :4001) constructs its own KitsuneClient pointed at the
// corresponding TWIN Node (:3000, :3001). The JWT session is instance-scoped
// (not globalThis), which lets two clients target different nodes concurrently.
// T-428: minimal shape of the 0.9.0 DSP ActivityLogEntry we read for the
// cross-node acceptance ({ accepted, ucr, vertexId } in a completed task result).
type ActivityLog = {
  id?: string;
  status?: string;
  tasks?: Array<{ status?: string; result?: unknown; error?: unknown }>;
};

export class KitsuneClient {
  private session: AuthSession | null = null;

  constructor(private readonly opts: KitsuneClientOptions) {}

  // Merge the always-present `x-api-key` (when multi-tenant is enabled)
  // with any per-call headers. Used by every direct `fetch` and by
  // `authedConfig` for the REST-client wrappers.
  private apiKeyHeaders(): Record<string, string> {
    return this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {};
  }

  async login(): Promise<AuthSession> {
    const response = await fetch(`${this.opts.nodeUrl}/authentication/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.apiKeyHeaders() },
      body: JSON.stringify({
        email: this.opts.email,
        password: this.opts.password,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Kitsune login failed (${response.status}) for ${this.opts.email} @ ${this.opts.nodeUrl}: ${text}`,
      );
    }

    const body = (await response
      .json()
      .catch(() => ({}))) as LoginResponseBody;
    let token = body.token ?? body.access_token;
    if (!token) {
      const cookie = response.headers.get("set-cookie");
      const match = cookie?.match(/access_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token) {
      throw new Error(
        `Kitsune login succeeded but no token returned (body or Set-Cookie) for ${this.opts.nodeUrl}`,
      );
    }

    const ttl = this.opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const session: AuthSession = {
      token,
      expiry: body.expiry ?? Date.now() + ttl,
    };
    this.session = session;
    return session;
  }

  async getSession(): Promise<AuthSession> {
    const cached = this.session;
    if (cached && cached.expiry - REFRESH_SAFETY_MS > Date.now()) {
      return cached;
    }
    return this.login();
  }

  // Read the cached session without forcing a login. Returns null if not
  // yet authenticated or if the cached token has already expired.
  getCachedSession(): AuthSession | null {
    const cached = this.session;
    if (!cached) return null;
    if (cached.expiry <= Date.now()) return null;
    return cached;
  }

  private async authedConfig(
    overrides: Partial<IBaseRestClientConfig> = {},
  ): Promise<IBaseRestClientConfig> {
    const session = await this.getSession();
    return {
      endpoint: this.opts.nodeUrl,
      headers: {
        Authorization: `Bearer ${session.token}`,
        Cookie: `access_token=${session.token}`,
        ...this.apiKeyHeaders(),
      },
      ...overrides,
    };
  }

  // DSP data-plane config (T-428, node 0.9.0). The 0.9.0 OpenAPI declares every
  // `/dataspace-data-plane/*` route with NO security (the inbox and the entity
  // reads alike), and `x-enc-tenant-token` is not a declared parameter anywhere.
  // So the next.48 encrypted-tenant-token query gate is obsolete and no longer
  // appended; tenant resolution rides the `x-api-key` header from authedConfig.
  // (`encTenantToken` is retained on the options for now in case a live 0.9.0
  // check shows a residual need; it is intentionally unused here.)
  private async dataspaceConfig(): Promise<IBaseRestClientConfig> {
    return this.authedConfig({ pathPrefix: "dataspace" });
  }

  // ─── Authentication admin (used to provision per-org TWIN users) ──

  // Create a TWIN user account linked to an existing identity (DID). The
  // resulting user authenticates with email+password, and TWIN signs
  // attestations issued by them with that DID's keys.
  //
  // TWIN requires: email, password (>=16 chars + upper + lower + special),
  // userIdentity (DID), organizationIdentity (DID), scope (array of roles).
  async createUser(input: {
    email: string;
    password: string;
    userIdentity: string;
    organizationIdentity: string;
    scope?: string[];
  }): Promise<unknown> {
    const session = await this.getSession();
    const res = await fetch(`${this.opts.nodeUrl}/authentication/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        ...this.apiKeyHeaders(),
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        userIdentity: input.userIdentity,
        organizationIdentity: input.organizationIdentity,
        scope: input.scope ?? ["user"],
      }),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      throw new Error(`createUser failed (${res.status}): ${text}`);
    }
    // Try to parse JSON, but accept empty/text responses too.
    return res.json().catch(() => ({}));
  }

  // ─── Identity ─────────────────────────────────────────────────────

  async createDid(namespace = "iota"): Promise<IDidDocument> {
    const client = new PatchedIdentityRestClient(await this.authedConfig());
    return client.identityCreate(namespace);
  }

  async resolveDid(documentId: string): Promise<IDidDocument> {
    const client = new IdentityResolverRestClient(await this.authedConfig());
    return client.identityResolve(documentId);
  }

  // Idempotent: skip the create call if the DID already has a verification
  // method with the given fragment.
  async ensureVerificationMethod(
    did: string,
    verificationMethodId: string,
    type: DidVerificationMethodType = DidVerificationMethodType.AssertionMethod,
  ): Promise<void> {
    const doc = await this.resolveDid(did);
    const candidates = [
      ...(doc.assertionMethod ?? []),
      ...(doc.verificationMethod ?? []),
    ];
    const target = `${did}#${verificationMethodId}`;
    const exists = candidates.some((vm) =>
      typeof vm === "string" ? vm === target : vm.id === target,
    );
    if (exists) return;

    const client = new PatchedIdentityRestClient(await this.authedConfig());
    await client.verificationMethodCreate(did, type, verificationMethodId);
  }

  async createCredential(input: {
    identity: string;
    verificationMethodId: string;
    credentialId: string;
    subject: IJsonLdNodeObject;
    revocationIndex?: number;
  }): Promise<{
    verifiableCredential: IDidVerifiableCredential;
    jwt: string;
  }> {
    const client = new PatchedIdentityRestClient(await this.authedConfig());
    const fullVmId = `${input.identity}#${input.verificationMethodId}`;
    return client.verifiableCredentialCreate(
      fullVmId,
      input.credentialId,
      input.subject,
      input.revocationIndex !== undefined
        ? { revocationIndex: input.revocationIndex }
        : undefined,
    );
  }

  // ─── Notarization ─────────────────────────────────────────────────

  async createImmutableProof(document: IJsonLdNodeObject): Promise<string> {
    const client = new ImmutableProofRestClient(await this.authedConfig());
    return client.create(document);
  }

  async verifyImmutableProof(
    id: string,
  ): Promise<IImmutableProofVerification> {
    const client = new ImmutableProofRestClient(await this.authedConfig());
    return client.verify(id);
  }

  // next.63: the immutable proof is now returned as a typed
  // IImmutableProofCredential (W3C VC v2 context) rather than a generic
  // IDidVerifiableCredential. Downstream normalizeImmutableProof() deep-walks
  // the object for the on-chain reference, so the stricter type is transparent.
  async getImmutableProof(id: string): Promise<IImmutableProofCredential> {
    const client = new ImmutableProofRestClient(await this.authedConfig());
    return client.get(id);
  }

  // ─── Attestation ──────────────────────────────────────────────────

  async createAttestation(
    attestationObject: IJsonLdNodeObject,
    namespace?: string,
  ): Promise<string> {
    const client = new AttestationRestClient(await this.authedConfig());
    return client.create(attestationObject, namespace);
  }

  // ─── Document Management ──────────────────────────────────────────
  // Composite endpoint: stores the blob, creates an AIG vertex (audit
  // trail) and optionally an attestation in a single call. Returns the
  // AIG vertex id which becomes the TWIN-side document identifier.

  async storeDocument(input: {
    documentId: string;
    documentCode: string;            // UN/EDIFACT, e.g. "unece:DocumentCodeList#380"
    blob: Uint8Array;
    annotation?: IJsonLdNodeObject;
    documentIdFormat?: string;
    createAttestation?: boolean;
  }): Promise<{ documentManagementId: string }> {
    // Path-prefix override: the @twin.org/document-management-rest-client
    // hard-codes "document-management" but the TWIN node 0.0.3-next.40
    // actually mounts the routes under "documents". The OpenAPI spec
    // advertises the old path; the route registrar uses the new one.
    const client = new DocumentManagementRestClient(
      await this.authedConfig({ pathPrefix: "documents" }),
    );
    // next.63 (document-management next.19) reshaped create(): the document
    // metadata is now passed as a single IDocumentBase object (was positional
    // args), blob is second, optional AIG edges third, and the attestation flag
    // moved from `createAttestation` to `options.includeAttestation`.
    // documentCode is cast (transport accepts any string of the right shape).
    const documentManagementId = await client.create(
      {
        documentId: input.documentId,
        documentIdFormat: input.documentIdFormat,
        documentCode: input.documentCode as never,
        annotationObject: input.annotation,
      },
      input.blob,
      undefined,
      { includeAttestation: input.createAttestation ?? false },
    );
    return { documentManagementId };
  }

  // ─── Auditable Item Graph (T-217) ─────────────────────────────────
  // The AIG stores tamper-evident JSON-LD vertices with an automatic
  // changeset history. Every update creates a new changeset (audit trail)
  // signed by the TWIN node. Used by the demo to shadow consignment CRUD
  // operations in docker mode — the in-memory store stays the primary
  // source, the AIG vertex provides the verifiable audit log.

  async createAigVertex(input: {
    annotationObject: IJsonLdNodeObject;
    aliases?: { id: string; aliasFormat?: string }[];
  }): Promise<{ aigVertexId: string }> {
    // Path-prefix override: the @twin.org/auditable-item-graph-rest-client
    // hard-codes "auditable-item-graph" but the TWIN node 0.0.3-next.40
    // mounts the routes under "aig".
    const client = new AuditableItemGraphRestClient(
      await this.authedConfig({ pathPrefix: "aig" }),
    );
    // TWIN's vertex validation requires `@context` + `type` on the top-level
    // vertex body, not just on nested elements. The REST client's
    // Omit<...,"id"> signature is too loose to enforce this, so we build
    // the full vertex shape ourselves and cast to satisfy TS.
    const aigVertexId = await client.create({
      "@context": [
        AuditableItemGraphContexts.Context,
        AuditableItemGraphContexts.ContextCommon,
      ],
      type: AuditableItemGraphTypes.Vertex,
      annotationObject: input.annotationObject,
      aliases: input.aliases?.map(toAlias),
    } as unknown as Parameters<AuditableItemGraphRestClient["create"]>[0]);
    return { aigVertexId };
  }

  async updateAigVertex(input: {
    id: string;
    annotationObject: IJsonLdNodeObject;
    aliases?: { id: string; aliasFormat?: string }[];
  }): Promise<void> {
    // Path-prefix override: the @twin.org/auditable-item-graph-rest-client
    // hard-codes "auditable-item-graph" but the TWIN node 0.0.3-next.40
    // mounts the routes under "aig".
    const client = new AuditableItemGraphRestClient(
      await this.authedConfig({ pathPrefix: "aig" }),
    );
    await client.update({
      "@context": [
        AuditableItemGraphContexts.Context,
        AuditableItemGraphContexts.ContextCommon,
      ],
      type: AuditableItemGraphTypes.Vertex,
      id: input.id,
      annotationObject: input.annotationObject,
      aliases: input.aliases?.map(toAlias),
    } as unknown as Parameters<AuditableItemGraphRestClient["update"]>[0]);
  }

  async getAigVertex(id: string) {
    // Path-prefix override: the @twin.org/auditable-item-graph-rest-client
    // hard-codes "auditable-item-graph" but the TWIN node 0.0.3-next.40
    // mounts the routes under "aig".
    const client = new AuditableItemGraphRestClient(
      await this.authedConfig({ pathPrefix: "aig" }),
    );
    return client.get(id);
  }

  async getAigChangesets(id: string, limit?: number) {
    // Path-prefix override: the @twin.org/auditable-item-graph-rest-client
    // hard-codes "auditable-item-graph" but the TWIN node 0.0.3-next.40
    // mounts the routes under "aig".
    const client = new AuditableItemGraphRestClient(
      await this.authedConfig({ pathPrefix: "aig" }),
    );
    const result = await client.getChangesets(id, undefined, limit);
    // T-434: node 0.9.0 returns changeset fields as JSON-LD `schema:`-prefixed
    // keys (`schema:patches`, `schema:proofId`, `schema:patchOperation/Path/Value`),
    // like the AIG vertex aliases. The UI reads PLAIN keys, so without this the
    // Audit Log modal opens but shows no patches/proof. Normalise the changeset +
    // patch level to plain keys (leave `patchValue` untouched — it carries its own
    // UN/CEFACT vocabulary the UI just renders as-is).
    const lift = <T extends Record<string, unknown>>(o: T, keys: string[]): T => {
      for (const k of keys) {
        const sk = `schema:${k}`;
        if (o[sk] !== undefined && o[k] === undefined) {
          (o as Record<string, unknown>)[k] = o[sk];
        }
      }
      return o;
    };
    const list = (result as { changesets?: { itemListElement?: unknown[] } })
      ?.changesets?.itemListElement;
    if (Array.isArray(list)) {
      for (const cs of list as Array<Record<string, unknown>>) {
        lift(cs, ["patches", "proofId", "userIdentity"]);
        const patches = cs.patches;
        if (Array.isArray(patches)) {
          for (const p of patches as Array<Record<string, unknown>>) {
            lift(p, ["patchOperation", "patchPath", "patchValue"]);
          }
        }
      }
    }
    return result;
  }

  // List AIG vertices (summaries: id, type, aliases, dateCreated — NOT the
  // annotationObject; fetch that per-vertex via getAigVertex). Direct GET so we
  // control all query params (the node mounts /aig, returns `itemListElement`).
  // Used to make the node the source of truth for the consignment list.
  async queryAigVertices(
    options: { conditions?: string; orderBy?: string; limit?: number } = {},
  ): Promise<Array<{ id: string; aliases?: Array<{ id: string; aliasFormat?: string }> }>> {
    const session = await this.getSession();
    const params = new URLSearchParams();
    if (options.conditions) params.set("conditions", options.conditions);
    if (options.orderBy) params.set("orderBy", options.orderBy);
    params.set("limit", String(options.limit ?? 100));
    const res = await fetch(`${this.opts.nodeUrl}/aig?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...this.apiKeyHeaders(),
      },
    });
    if (!res.ok) {
      throw new Error(`/aig query failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      itemListElement?: Array<Record<string, unknown>>;
    };
    // next.48 returns the LIST as JSON-LD compacted under the `schema:` vocab
    // (`schema:aliases`, `schema:aliasFormat`), unlike GET /aig/{id} which uses
    // plain keys. Normalise to the plain `{ id, aliases:[{id, aliasFormat}] }`
    // shape listConsignments filters on, so a UCR-aliased consignment vertex is
    // discovered (otherwise the alias is invisible and the list is always empty).
    const items = body.itemListElement ?? [];
    return items.map((v) => {
      const rawAliases = (v["schema:aliases"] ?? v.aliases) as unknown;
      const aliasArr = Array.isArray(rawAliases)
        ? rawAliases
        : rawAliases
          ? [rawAliases]
          : [];
      const aliases = (aliasArr as Array<Record<string, unknown>>).map((a) => ({
        id: a?.id as string,
        aliasFormat: (a?.["schema:aliasFormat"] ?? a?.aliasFormat) as string | undefined,
      }));
      return { id: v.id as string, aliases };
    });
  }

  // ─── Auditable Item Stream (T-303) ────────────────────────────────
  // AIS holds append-only, time-ordered event streams. The demo uses one
  // stream per node to record the ledger events that addLog() emits in
  // the in-memory store. Each entry is signed and (optionally) anchored
  // on chain at the configured immutableInterval.
  //
  // Read pattern: getEntries(undefined) returns entries across ALL streams
  // — used by /api/ledger to render the unified ledger view.

  async createAisStream(input: {
    annotationObject?: IJsonLdNodeObject;
  } = {}): Promise<{ aisStreamId: string }> {
    // Path-prefix override: the rest-client hard-codes "auditable-item-stream"
    // but the TWIN node mounts the routes under "ais".
    const client = new AuditableItemStreamRestClient(
      await this.authedConfig({ pathPrefix: "ais" }),
    );
    const aisStreamId = await client.create({
      "@context": [
        SchemaOrgContexts.Context,
        AuditableItemStreamContexts.Context,
        AuditableItemStreamContexts.ContextCommon,
      ],
      type: AuditableItemStreamTypes.Stream,
      annotationObject: input.annotationObject,
    });
    return { aisStreamId };
  }

  async appendAisEntry(
    streamId: string,
    entryObject: IJsonLdNodeObject,
  ): Promise<{ entryId: string }> {
    const client = new AuditableItemStreamRestClient(
      await this.authedConfig({ pathPrefix: "ais" }),
    );
    const entryId = await client.createEntry(streamId, entryObject);
    return { entryId };
  }

  // List entries across all streams (or a specific one when streamId is
  // provided). Used by /api/ledger to render the unified ledger view.
  async listAisEntries(
    streamId?: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ entries: IAuditableItemStreamEntry[]; cursor?: string }> {
    const client = new AuditableItemStreamRestClient(
      await this.authedConfig({ pathPrefix: "ais" }),
    );
    const result = await client.getEntries(streamId, {
      limit: options.limit,
      cursor: options.cursor,
    });
    // The REST shape wraps entries in `{ entries: { itemListElement: [...] } }`.
    // Unwrap so callers see a flat array.
    const list = (result.entries as unknown as {
      itemListElement?: IAuditableItemStreamEntry[];
    })?.itemListElement
      ?? (Array.isArray(result.entries) ? (result.entries as unknown as IAuditableItemStreamEntry[]) : []);
    return { entries: list, cursor: result.cursor };
  }

  // ─── Dataspace data plane ─────────────────────────────────────────
  // These require TWIN_DATASPACE_ENABLED=true on the target node.
  // The current Phase 2 node config disables it - Phase 3 enables it.

  async forwardActivity(
    activity: IActivityStreamsActivity,
    opts?: { organization?: string | null; apiKey?: string | null; trustPayload?: string },
  ): Promise<{ activityLogId: string; acceptance?: unknown }> {
    // T-432 (node 0.9.0) — verified against the LIVE running node, NOT the
    // release OpenAPI spec (which diverged and misled T-426/T-428). Probing the
    // live 0.9.0 inbox revealed the real contract:
    //   • the route is `POST /dataspace/inbox` (the spec's
    //     `/dataspace-data-plane/inbox` 404s on the running node);
    //   • the node's TenantProcessor REQUIRES `?organization=<recipientOrgDid>`
    //     as a query param (401 `missingOrganizationId` without it) plus an
    //     `x-api-key` for the recipient tenant;
    //   • its TrustHelper then REQUIRES a trust VC as an `Authorization` bearer
    //     (401 `trustVerifyFailed` without it) — the inverse of next.48, which
    //     rejected the bearer. The `tenant-token` CLI is removed in 0.9.0, so the
    //     old `?x-enc-tenant-token=` gate is dead.
    const base = this.opts.nodeUrl.replace(/\/$/, "");
    const org = opts?.organization
      ? `?organization=${encodeURIComponent(opts.organization)}`
      : "";
    const url = `${base}/dataspace/inbox${org}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts?.apiKey ? { "x-api-key": opts.apiKey } : this.apiKeyHeaders()),
        ...(opts?.trustPayload
          ? { Authorization: `Bearer ${opts.trustPayload}` }
          : {}),
      },
      body: JSON.stringify(activity),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`inbox notify failed (${res.status}): ${text.slice(0, 200)}`);
    }
    // The 200 body is an ActivityLogEntry { id, status, tasks: [{ status,
    // result, error }] } (0.9.0 OpenAPI). The recipient's
    // CorridorDataspaceApp.handleActivity return is the T-325 acceptance
    // ({ accepted, ucr, vertexId }) and lands in a task's `result` — but ONLY
    // once that task COMPLETES. 0.9.0 processes the inbox asynchronously, so the
    // result is usually absent from this immediate response.
    let body: ActivityLog | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body — fall through to the defaults */
    }
    const pickResult = (b: ActivityLog | null) =>
      b?.tasks?.find((t) => t?.result != null)?.result ?? null;
    const activityLogId = (typeof body?.id === "string" && body.id) || "";
    let acceptance = pickResult(body);

    // T-428: the inbox is async, so poll the activity-log briefly so the
    // Federation Receipt can confirm beta's acceptance in real time. Graceful:
    // on timeout we return without an acceptance and the recipient poll /
    // DATA_SYNC still updates beta's view (the prior behaviour).
    const FORWARD_POLL_ATTEMPTS = 6;
    const FORWARD_POLL_INTERVAL_MS = 1200;
    if (!acceptance && activityLogId) {
      for (let i = 0; i < FORWARD_POLL_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, FORWARD_POLL_INTERVAL_MS));
        const entry = await this.fetchActivityLogRaw(base, activityLogId);
        acceptance = pickResult(entry);
        if (acceptance || entry?.tasks?.some((t) => t?.error != null)) break;
      }
    }
    return { activityLogId, acceptance };
  }

  // T-428: raw GET of the DSP data-plane activity-log entry. The 0.9.0 OpenAPI
  // declares this route `security: none` (like the inbox), so no auth — the
  // same posture as the inbox POST above. Returns null on any failure so the
  // caller degrades gracefully.
  private async fetchActivityLogRaw(
    base: string,
    id: string,
  ): Promise<ActivityLog | null> {
    try {
      const r = await fetch(
        `${base}/dataspace-data-plane/activity-logs/${encodeURIComponent(id)}`,
      );
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    } catch {
      return null;
    }
  }

  async getActivityLog(logEntryId: string): Promise<IActivityLogEntry> {
    const client = new DataspaceDataPlaneRestClient(await this.dataspaceConfig());
    return client.getActivityLogEntry(logEntryId);
  }

  // ─── Rights Management — Policy Administration (T-302, T-304) ─────
  // ODRL policies stored in the TWIN node's PolicyAdministrationPoint.
  // T-302 uses these as part of the SHARE/REVOKE flow; T-304 deepens the
  // enforcement to drive consignment access decisions from real policies
  // rather than the in-memory grants store.

  async createOdrlPolicy(
    policy: Record<string, unknown>,
  ): Promise<{ policyId: string }> {
    const client = new PolicyAdministrationPointRestClient(
      await this.authedConfig({ pathPrefix: "rights-management" }),
    );
    const policyId = await client.create(
      policy as Parameters<PolicyAdministrationPointRestClient["create"]>[0],
    );
    return { policyId };
  }

  async getOdrlPolicy(policyId: string): Promise<unknown> {
    const client = new PolicyAdministrationPointRestClient(
      await this.authedConfig({ pathPrefix: "rights-management" }),
    );
    return client.get(policyId);
  }

  async deleteOdrlPolicy(policyId: string): Promise<void> {
    const client = new PolicyAdministrationPointRestClient(
      await this.authedConfig({ pathPrefix: "rights-management" }),
    );
    await client.remove(policyId);
  }

  // ─── Federated Catalogue (T-306, paths corrected in T-317) ───────
  // The TWIN node exposes a DCAT-formatted federated catalogue that spans
  // the peers configured in TWIN_DATASPACE_PEER_NODES. No dedicated REST
  // client class exists in the @twin.org packages for this endpoint, so we
  // hit it via raw fetch with the same JWT.
  //
  // T-317 (verified live against twin-node:0.0.3-next.40): the route is
  // `POST /federated-catalogue/request`, NOT `/catalog/request` (the latter
  // is what the stale OpenAPI spec lists — the runtime mounts the former).
  // The body must be an Eclipse DSP CatalogRequestMessage: `@context`,
  // `@type: "CatalogRequestMessage"`, and a REQUIRED `filter` array (server
  // guards reject a missing `@type` or a non-array `filter`). The filter
  // expression format is implementation-specific and undocumented, so we
  // send an empty array (return everything) and let callers filter the
  // returned datasets client-side (see dcatOrgToPeer in server/store.js).
  //
  // NOTE: the catalogue federates DATASETS (negotiable data assets, each
  // with an ODRL offer + distribution), and organisations surface only as
  // the publishers of such datasets. There is no "register an org as a
  // standalone dataset" path: POST /dataspace/app-datasets requires an
  // engine-registered `dataspace-app` as `appId` and a full DSP dataset.
  // Org discovery therefore stays on the WS ORG_DIRECTORY fallback until
  // consignment/document datasets exist. See T-317 findings.
  async queryFederatedCatalog(
    _filter: Record<string, unknown> = {},
  ): Promise<{ datasets: unknown[]; raw?: unknown }> {
    const session = await this.getSession();
    const res = await fetch(`${this.opts.nodeUrl}/federated-catalogue/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        ...this.apiKeyHeaders(),
      },
      body: JSON.stringify({
        "@context": "https://w3id.org/dspace/2025/1/context.jsonld",
        "@type": "CatalogRequestMessage",
        filter: [],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      // An empty catalogue is the normal steady state for org discovery (no
      // datasets are registered yet — see the NOTE above). The service signals
      // it with a 404 DSP CatalogError `federatedCatalogueService.noDatasetsFound`,
      // not a route error. Treat that as "0 datasets" rather than throwing, so
      // boot-time hydration stays quiet and falls back to the WS path cleanly.
      if (res.status === 404 && text.includes("noDatasetsFound")) {
        return { datasets: [], raw: undefined };
      }
      throw new Error(
        `/federated-catalogue/request failed (${res.status}): ${text}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as
      | { dataset?: unknown[]; datasets?: unknown[] }
      | Record<string, unknown>;
    // DSP catalogue responds with a DCAT Catalog whose entries live under
    // `dataset` (DCAT3 singular-keyed array); tolerate `datasets` too.
    const datasets =
      (Array.isArray((body as { dataset?: unknown[] }).dataset)
        ? (body as { dataset: unknown[] }).dataset
        : Array.isArray((body as { datasets?: unknown[] }).datasets)
          ? (body as { datasets: unknown[] }).datasets
          : []) as unknown[];
    return { datasets, raw: body };
  }

  // T-304: query the local node's ODRL policies. Used at boot to hydrate
  // the in-memory permission cache so the demo's authorisation checks
  // (the existing store.permissions / store.docPermissions reads in
  // routes/consignments.js + routes/documents.js) stay correct after a
  // restart in docker/hosted mode.
  async queryOdrlPolicies(options: {
    assigner?: string;
    assignee?: string;
    target?: string;
    action?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<{ policies: unknown[]; cursor?: string }> {
    const client = new PolicyAdministrationPointRestClient(
      await this.authedConfig({ pathPrefix: "rights-management" }),
    );
    const result = await client.query(
      {
        assigner: options.assigner,
        assignee: options.assignee,
        target: options.target,
        action: options.action,
      },
      undefined,
      options.cursor,
      options.limit,
    );
    // The client returns { entities: unknown[]; cursor?: string }. Normalise
    // to a `policies` array so callers don't depend on the internal field
    // name.
    const policies = (result as unknown as { entities?: unknown[]; policies?: unknown[] }).entities
      ?? (result as unknown as { policies?: unknown[] }).policies
      ?? [];
    return {
      policies,
      cursor: (result as unknown as { cursor?: string }).cursor,
    };
  }
}

// Helper: turn the demo's flat alias shape ({id, aliasFormat?}) into the
// JSON-LD-typed shape the AIG models require. The `dateCreated` field is
// omitted — the TWIN server stamps it server-side on insertion.
function toAlias(a: { id: string; aliasFormat?: string }): IAuditableItemGraphAlias {
  return {
    id: a.id,
    type: AuditableItemGraphTypes.Alias,
    ...(a.aliasFormat ? { aliasFormat: a.aliasFormat } : {}),
  } as IAuditableItemGraphAlias;
}
