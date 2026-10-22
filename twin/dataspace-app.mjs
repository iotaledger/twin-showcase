// TWIN node extension: the demo's corridor DataspaceApp.
//
// Loaded by the node via TWIN_EXTENSIONS (comma-separated module list; the node
// calls extensionInitialise / extensionInitialiseEngine / extensionInitialiseEngineServer
// for each). This is the foundation for both:
//   - T-321 (advertise / serve): handleDataRequest() serves the corridor's
//     consignments and documents as DSP data assets, so a peer node can
//     discover them via the federated catalogue and pull them over the transfer
//     lifecycle.
//   - T-324 (inbound ingestion, DSP-only file exchange): activitiesHandled() +
//     handleActivity() receive a shared Consignment / Document activity pushed
//     to this node via /dataspace/notify and ingest it, so the recipient webapp
//     no longer needs the WebSocket peer channel in docker / hosted mode.
//
// Pattern mirrors the upstream node test fixture
// (packages/node-core/tests/apps/{testApp.js,testDataspaceDataPlaneApp.js}).
//
// STATUS: scaffold for the load-spike. The handler bodies are wired to the
// contract; the deep ingestion into the node's document-management / AIG stores
// (handleActivity) and serving real corridor data (handleDataRequest) are the
// next live-iteration steps, validated against the running next.48 node.
import { ComponentFactory, Guards } from '@twin.org/core';
import { AuditableItemGraphTypes, AuditableItemGraphContexts } from '@twin.org/auditable-item-graph-models';
import { DataRequestType } from '@twin.org/dataspace-models';
import { DataspaceAppFactory } from '@twin.org/dataspace-models';
import { EngineTypeHelper } from '@twin.org/engine-types';
import { ContextIdHelper, ContextIdKeys, ContextIdStore } from '@twin.org/context';
import { DataTypeHandlerFactory } from '@twin.org/data-core';
import { DataspaceProtocolContexts } from '@twin.org/standards-dataspace-protocol';
import { DublinCoreContexts } from '@twin.org/standards-dublin-core';

const UNECE = 'https://vocabulary.uncefact.org/';
const CONSIGNMENT_TYPE = UNECE + 'Consignment';
const DOCUMENT_TYPE = UNECE + 'Document';

// Module-level guard: the engine clones the engine per dataspace operation and
// re-instantiates the app, re-calling start(). The data-type handlers live in a
// global factory, so register them once (cheap idempotency; avoids per-clone work).
let _typesRegistered = false;

// The component the engine registers for this app.
const COMPONENT_NAME = 'corridorDataspaceApp';

export class CorridorDataspaceApp {
  static APP_ID = 'https://twin.kchain.solutions/corridor-app';
  static CLASS_NAME = 'CorridorDataspaceApp';

  constructor(options) {
    this._logging = ComponentFactory.getIfExists(options?.loggingComponentType ?? 'logging');
    // Component TYPE names the inbound handler ingests into. The node registers
    // its components under the kebab-cased service class name (verified against
    // twin-supply-chain's supplyChainService.ts:
    //   ComponentFactory.get(StringHelper.kebabCase(nameof<AuditableItemGraphService>()))
    //   -> "auditable-item-graph-service" / "document-management-service").
    // Resolved lazily in start() once the engine is up (candidates list tolerates
    // a naming drift across node prereleases).
    this._aigType = options?.aigComponentType ?? 'auditable-item-graph-service';
    this._documentManagementType = options?.documentManagementComponentType ?? 'document-management-service';
    this._aigCandidates = [this._aigType, 'auditable-item-graph', 'auditableItemGraph'];
  }

  // Required by the engine component contract (the engine calls
  // instance.component.className() at start). Without it the node aborts with
  // "instance.component.className is not a function".
  className() {
    return CorridorDataspaceApp.CLASS_NAME;
  }

  supportedQueryTypes() {
    return ['Consignment', 'Document'];
  }

  // T-321: the DSP datasets this app advertises (DCAT3 + ODRL Offer). A peer
  // discovers these via the federated catalogue and pulls them over the
  // transfer lifecycle. NEXT ITERATION: derive @id/policy per real consignment.
  async datasetsHandled() {
    const contextIds = await ContextIdStore.getContextIds();
    const orgId =
      contextIds?.[ContextIdKeys.Organization] ?? contextIds?.[ContextIdKeys.Node] ?? '';
    return [
      {
        '@context': [
          DataspaceProtocolContexts.Context,
          { dcterms: DublinCoreContexts.NamespaceTerms },
        ],
        '@id': CorridorDataspaceApp.APP_ID + '/consignments',
        '@type': 'Dataset',
        'dcterms:publisher': orgId,
        hasPolicy: [
          {
            '@type': 'Offer',
            uid: 'urn:uuid:corridor-consignment-read',
            assigner: orgId,
            permission: [{ action: 'read' }],
          },
        ],
        distribution: {
          '@id': CorridorDataspaceApp.APP_ID + '/distribution',
          '@type': 'Distribution',
          accessService: CorridorDataspaceApp.APP_ID,
          format: 'Http-Pull-Query-Format',
        },
        'dcterms:type': CONSIGNMENT_TYPE,
      },
    ];
  }

  async start(_nodeLoggingComponentType) {
    const contextIds = await ContextIdStore.getContextIds();
    ContextIdHelper.guard(contextIds, ContextIdKeys.Node);
    this._nodeId = contextIds[ContextIdKeys.Node];
    // Resolve the AIG component the inbound handler ingests consignments into.
    // getIfExists (not get) so a name miss logs rather than aborting the node;
    // try the candidate names and keep the first that resolves.
    this._aig = null;
    for (const name of this._aigCandidates) {
      const c = ComponentFactory.getIfExists(name);
      if (c) { this._aig = c; this._aigResolvedAs = name; break; }
    }
    // Register data-type handlers once (global factory; engine re-runs start per clone).
    if (!_typesRegistered) {
      for (const t of ['Consignment', 'Document']) {
        DataTypeHandlerFactory.register(UNECE + t, () => ({
          namespace: UNECE,
          type: t,
          defaultValue: {},
          jsonSchema: async () => ({ type: 'object' }),
        }));
      }
      _typesRegistered = true;
      await this._log('info', `started, node=${this._nodeId ?? ''}, aig=${this._aigResolvedAs ?? 'UNRESOLVED'}`);
    }
  }

  // T-324: the activity object types this app ingests on inbound /dataspace/notify.
  activitiesHandled() {
    return [{ objectType: CONSIGNMENT_TYPE }, { objectType: DOCUMENT_TYPE }];
  }

  // T-324 inbound handler: a shared Consignment arrived over DSP. Ingests it
  // into THIS node's Auditable Item Graph so the recipient reads it from its own
  // node (no WebSocket). The sender (server/adapter/docker.js#buildShareActivity)
  // wraps the UNECE D23B consignment under `object.content` and the document
  // records (without file bytes) under `object.attachment`.
  //
  // The return value is delivered BACK to the sender: the node's inbox route
  // returns it in the notify response body, and the migrated
  // DataspaceDataPlaneRestClient.notifyActivity returns `response.body`. So this
  // is also the T-325 acceptance channel — Alpha learns Beta ingested.
  async handleActivity(activity) {
    Guards.object(CorridorDataspaceApp.CLASS_NAME, 'activity', activity);
    const obj = activity?.object ?? {};
    const objType = obj?.type ?? obj?.['@type'];
    const activityType = activity?.type ?? activity?.['@type'];

    // The activity object IS the UNECE consignment (sender spreads
    // consignmentToUnece into object, with identifier/globalId = ucr and the
    // twinFlatConsignment blob under additionalProperty). `?? obj.content`
    // tolerates the older wrapper shape. UCR from identifier/globalId, or the
    // urn:consignment:<ucr> id as a last resort.
    const content = obj?.content ?? obj;
    const ucr =
      content?.identifier ??
      content?.globalId ??
      (typeof obj?.id === 'string' ? obj.id.replace(/^urn:consignment:/, '') : '');
    const attachments = Array.isArray(obj?.attachment)
      ? obj.attachment
      : (obj?.attachment ? [obj.attachment] : []);

    await this._log('info', `inbound activity: activityType=${activityType} objectType=${objType} ucr=${ucr} docs=${attachments.length}`);

    if (!this._aig) {
      await this._log('error', `cannot ingest ucr=${ucr}: AIG component unresolved (tried ${this._aigCandidates.join(', ')})`);
      return { accepted: false, reason: 'aig-unavailable', ucr, node: this._nodeId };
    }

    // Revoke (Remove) ingestion is a later increment; acknowledge for now.
    if (activityType === 'Remove') {
      await this._log('info', `Remove activity ucr=${ucr} — revoke ingestion TODO`);
      return { accepted: true, type: 'Remove', ucr, node: this._nodeId };
    }

    if (!content || !ucr) {
      await this._log('warn', 'inbound activity has no consignment content/ucr — nothing to ingest');
      return { accepted: false, reason: 'no-consignment', node: this._nodeId };
    }

    // Best-effort idempotency: a re-share must not create a second vertex for the
    // same UCR. (The demo's listConsignments also dedups by UCR on read, so a
    // miss here is non-fatal.)
    let vertexId = await this._findVertexByUcr(ucr);
    if (vertexId) {
      await this._log('info', `consignment ucr=${ucr} already on node (vertex ${vertexId}); skip create`);
    } else {
      // annotationObject = the UNECE consignment, stripped of the activity-only
      // fields the sender added (the urn:consignment id override + the doc
      // `attachment` list — documents are a later increment), so it matches the
      // exact shape the demo's REST createAigVertex writes and flatFromAigVertex
      // reads back (it carries the twinFlatConsignment blob under
      // additionalProperty).
      const { attachment: _att, id: _objId, ...annotationObject } = content;
      // The in-process component (unlike the REST route, which wraps the body)
      // requires a fully-formed JSON-LD vertex: @context + type at the vertex
      // level and a type on each alias, validated against the AIG schema (see
      // twin-supply-chain supplyChainService.ts -> JsonLdUtils.buildJsonLdItem).
      const vertex = {
        '@context': [AuditableItemGraphContexts.Context, AuditableItemGraphContexts.ContextCommon],
        type: AuditableItemGraphTypes.Vertex,
        annotationObject,
        aliases: [{ id: ucr, aliasFormat: 'urn:moit:ucr', type: AuditableItemGraphTypes.Alias }],
      };
      vertexId = await this._aig.create(vertex);
      await this._log('info', `ingested consignment ucr=${ucr} -> AIG vertex ${vertexId}`);
    }

    // NOTE: document file bytes do NOT ride the DSP activity (the sender strips
    // fileBase64 — blobs live on the storage connector). object.attachment carries
    // the doc METADATA + proofs. Surfacing documents on the recipient (and the
    // blob transfer for download) is the next T-324 increment.
    //
    // T-325 acceptance: this object rides back to the sender in the inbox 201
    // response (tasks[0].result). acceptedAt + vertexId give the receipt a
    // timestamp and on-node evidence; recipientNode is this node's identity.
    return {
      accepted: true,
      type: 'Consignment',
      ucr,
      vertexId,
      documentCount: attachments.length,
      node: this._nodeId,
      recipientNode: this._nodeId,
      acceptedAt: new Date().toISOString(),
    };
  }

  // Find an existing AIG vertex carrying this UCR alias; null if none or if the
  // component does not expose query. Tolerant of the list shape (entries.entities
  // vs entries array).
  async _findVertexByUcr(ucr) {
    try {
      if (!ucr || typeof this._aig?.query !== 'function') return null;
      const res = await this._aig.query({ id: ucr, idMode: 'alias', idExact: true });
      // The vertex list is JSON-LD shaped: { entries: { itemListElement: [...] } }
      // (same envelope as GET /aig). Tolerate the other shapes defensively.
      const entries = res?.entries ?? res;
      const list =
        entries?.itemListElement ?? entries?.entities ?? (Array.isArray(entries) ? entries : []);
      const arr = Array.isArray(list) ? list : [];
      return arr[0]?.id ?? null;
    } catch (e) {
      await this._log('warn', `idempotency query failed for ucr=${ucr}: ${e.message}`);
      return null;
    }
  }

  // T-321 advertise/serve: a peer requests this node's advertised data assets.
  async handleDataRequest(dataRequest, _cursor, _limit) {
    Guards.object(CorridorDataspaceApp.CLASS_NAME, 'dataRequest', dataRequest);
    switch (dataRequest.type) {
      case DataRequestType.DataAssetEntities:
      case DataRequestType.QueryDataAsset:
        // TODO (live iteration): return the corridor's real consignments /
        // documents (from the node stores) as UNECE D23B entities.
        return { data: [] };
      default:
        return { data: [] };
    }
  }

  async _log(level, message) {
    await this._logging?.log({ level, source: CorridorDataspaceApp.CLASS_NAME, message });
  }
}

// ── Extension hooks (the node calls these per TWIN_EXTENSIONS entry) ──────────
export async function extensionInitialise(_envVars, nodeEngineConfig) {
  nodeEngineConfig.types[COMPONENT_NAME] = [{ type: 'service', options: {} }];
}

export async function extensionInitialiseEngine(engineCore) {
  engineCore.addTypeInitialiser(COMPONENT_NAME, import.meta.url, 'corridorAppInitialiser');
}

export async function extensionInitialiseEngineServer(engineCore, engineServer) {
  engineServer.addRestRouteGenerator(COMPONENT_NAME, import.meta.url, 'generateRestRoutes');
}

export function corridorAppInitialiser(engineCore, _context, instanceConfig) {
  let instanceTypeName;
  let createComponent;
  if (instanceConfig.type === 'service') {
    createComponent = (createConfig) =>
      new CorridorDataspaceApp(
        EngineTypeHelper.mergeConfig(
          { loggingComponentType: engineCore.getRegisteredInstanceType('loggingComponent') },
          createConfig.options,
        ),
      );
    instanceTypeName = CorridorDataspaceApp.APP_ID;
  }
  return { instanceTypeName, factory: DataspaceAppFactory, createComponent };
}

export function generateRestRoutes() {
  return [];
}
