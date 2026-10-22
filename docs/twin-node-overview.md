# TWIN node overview

A TWIN node is a Node.js service, distributed as the Docker image `twinfoundation/twin-node`, that exposes a REST API over a set of modules: decentralized identifiers (DIDs) published on the IOTA ledger and verifiable credentials signed with them, signed proofs and notarizations anchored on that ledger, NFT-backed attestations, file and document storage, tamper-evident graphs and event streams, ODRL (W3C Open Digital Rights Language) access policies, and the Eclipse Dataspace Protocol (DSP) for exchange between nodes. The same image runs both the REST server and the one-shot CLI that bootstraps it. Environment variables decide which modules load and which backend each capability uses, and one node can host several tenants, each with its own API key, users and data.

This repo runs two nodes from `twinfoundation/twin-node:0.9.0`: Alpha on `localhost:3000` and Beta on `localhost:3001`, both published on `127.0.0.1` only, each with its own MySQL database, both on the IOTA testnet. The demo servers reach them over REST through the TWIN REST client wrapper `KitsuneClient` (`server/twin/kitsune-client.ts`, compiled to `server/twin/dist` by `npm run build:twin`), which `DockerAdapter` (`server/adapter/docker.js`) uses in `docker` and `hosted` mode. The REST client packages are pinned to `0.9.0` in `package.json`: `@twin.org/<name>-rest-client` for attestation, auditable-item-graph, auditable-item-stream, blob-storage, dataspace-control-plane, dataspace-data-plane, document-management, identity, immutable-proof, nft, notarization and rights-management. `KitsuneClient` imports all of them except blob-storage, nft, notarization and dataspace-control-plane, which are installed but unused. At startup the demo server reads the node version from `GET /` and logs a warning, without failing, when it differs from `NODE_COMPAT_VERSION` in `server/twin/compat/index.js`. How the demo uses the nodes end to end is in [architecture.md](architecture.md), and the container stack (services, volumes, env files) is in [twin/README.md](../twin/README.md).

## Modules and what the demo uses

The table covers the modules of a 0.9.0 node, whether the demo uses them, and the routes this repo actually calls (taken from `server/twin/kitsune-client.ts`, `server/routes/twin-proxy.js` and `scripts/twin/*.sh`, not from the node's OpenAPI document, which is wrong for some paths). Unless noted, calls carry the tenant `x-api-key` header and a login JWT, as described under [Tenancy and authentication](#tenancy-and-authentication).

| Module | What it does | Used by this demo? | Route family this repo calls |
|---|---|---|---|
| Info and spec | Node version string, OpenAPI document, health probes | Yes | `GET /` (no credentials), `GET /spec` (API key only) |
| Authentication | Email and password login returning a JWT, plus logout, refresh and password change | Yes, by every client | `POST /authentication/login` |
| Authentication admin | User accounts bound to a user DID and an organization DID | Yes, when an org gets its DID over REST (UI registration, seed fallback) | `POST /authentication/admin/users` |
| Identity | Creates and resolves IOTA DIDs (on this network of the form `did:iota:testnet:0x...`), manages verification methods, issues and verifies credentials and presentations | Yes | `POST /identity`, `GET /identity/{did}`, `POST /identity/{did}/verification-method`, `POST /identity/{did}/verifiable-credential/{vmId}` |
| Identity profile | Profile properties per identity | No | none |
| Immutable proof | Signs a JSON-LD object as a verifiable credential and anchors it through the notarization connector | Yes, for every document | `POST /immutable-proof`, `GET /immutable-proof/{id}`, `GET /immutable-proof/{id}/verify` |
| Notarization | On-chain notarization objects that can be updated and transferred | Indirectly, as the backend of immutable proof | none |
| NFT | Mints, updates and transfers IOTA NFT objects | Indirectly, as the backend of attestation | none |
| Attestation | Signs a JSON-LD object with the caller's organization DID and mints it as an NFT | Yes, org-signed document attestation | `POST /attestation` |
| Blob storage | Encrypted file storage | Indirectly, through document management | none |
| Document management | Stores a file, creates its auditable item graph vertex and can add an attestation, in one call | Yes, with the attestation option off | `POST /documents` |
| Auditable item graph (AIG) | Versioned JSON-LD vertices with aliases and signed changesets | Yes, one vertex per consignment | `POST /aig`, `GET /aig`, `GET /aig/{id}`, `PUT /aig/{id}`, `GET /aig/{id}/changesets` |
| Auditable item stream (AIS) | Append-only streams of signed entries | Yes, for the demo's activity log (`GET /api/ledger`, the Analytics page). Each demo server start creates a new stream, and the ledger read lists entries across all streams | `POST /ais`, `POST /ais/{id}/entries`, `GET /ais/entries` |
| Rights management, policy administration | Stores and queries ODRL policies | Yes, one ODRL `Offer` per cross-node share, in which the owner, as `assigner`, grants the recipient `use` and `modify` | `POST /rights-management/policy/admin`, `GET /rights-management/policy/admin`, `DELETE /rights-management/policy/admin/{id}` |
| Rights management, negotiation | DSP contract negotiation | No | none |
| Federated catalogue | DSP catalogue of datasets advertised by dataspace apps | Yes, queried at boot for peer-org discovery. It yields no peers: the demo never registers a dataset with the node, and on 0.9.0 the query was seen failing with a `CredentialStructure` error because it sends the session JWT instead of a trust credential ([open-work.md](open-work.md#the-federated-catalogue-is-empty-and-peer-discovery-depends-on-the-websocket-handshake)). Peer orgs come from the WebSocket handshake | `POST /federated-catalogue/request` |
| Dataspace control plane | DSP transfer processes (request, start, complete, suspend, terminate) and app dataset registration | No. The 0.9.0 client package defaults to the `/dataspace-control-plane` prefix, which this repo never calls, so the runtime path is unverified | none |
| Dataspace data plane | Inbox that hands inbound Activity Streams activities to dataspace apps, activity logs, entity queries | Attempted on every cross-node share (recipient node), and on revoke and write-back document upload (local node, without the organization parameter or trust credential). The node rejects all of them in this setup | `POST /dataspace/inbox?organization=<recipientOrgDid>` (own credential contract), `GET /dataspace-data-plane/activity-logs/{id}` (no credentials, reached only after an accepted inbox POST, so never in this setup) |
| Trust | Verifies trust credentials presented on dataspace requests | Indirectly, the share attaches a trust credential | none |
| Data processing | JSON and XML conversion, JSONPath extraction rules | No. Enabled, never called | none |
| Task scheduler | Background jobs for other modules | Indirectly, used by other modules. This repo never calls it | none |
| Logging, authentication audit, messaging, automation, synchronized storage, telemetry | Log entries, authentication audit log, email, SMS and push messages, automation actions, multi-node sync, metrics | No | none |

To call a node directly, log in as shown in [twin/README.md](../twin/README.md), then send `x-api-key` and `Authorization: Bearer <jwt>` on every call. The write bodies of the routes above, as defined by the 0.9.0 client packages:

| Route | Body | Notes |
|---|---|---|
| `POST /identity` | `{ "namespace": "iota" }` | The namespace selects the identity connector and must match `TWIN_IDENTITY_CONNECTOR=iota`. Another value, such as `example`, fails. `DockerAdapter.createDid()` always passes `iota` |
| `POST /identity/{did}/verification-method` | `{ "verificationMethodType": "assertionMethod", "verificationMethodId": "<id>" }` | Updates the DID document on chain |
| `POST /immutable-proof` | `{ "document": <JSON-LD> }` | Returns the proof id in the `Location` header |
| `POST /ais/{id}/entries` | `{ "entryObject": <JSON-LD> }` | Returns the entry id in the `Location` header |
| `POST /attestation` | `{ "attestationObject": <JSON-LD> }`, plus an optional `namespace` | Returns the attestation id in the `Location` header |

DID creation, verification methods, immutable proofs and attestations spend testnet gas, see [On-chain cost model](#on-chain-cost-model).

`GET /` returns a plain `TWIN Node - <version>` string without credentials, so `npm run twin:up`, `npm run twin:status` and the server's version check use it as the readiness probe. `/health` is no substitute on these tenant-enabled nodes: it answers 401 without `x-api-key` (observed on a running instance, see [open-work.md](open-work.md)).

The demo server's `/twin` proxy forwards the authentication and immutable-proof routes to the node, so a third party can verify a document with the node's own API ([document-verification.md](document-verification.md)). Its allow-list also includes `/verifiable/*`, a route family that 0.9.0 does not serve, so those requests fail at the node.

The dataspace inbox is the one route this repo calls but cannot complete. Its contract (organization query parameter, recipient API key, trust credential) and the reason the node rejects the call are specified in [dsp-design.md](dsp-design.md). Shared consignments reach the other demo server over its WebSocket peer channel instead.

Three modules anchor data on the ledger, and they are easy to confuse. Notarization is the low-level on-chain record. Immutable proof builds on it: the node hashes a JSON-LD object, signs a verifiable credential over that hash (`proofIntegrity`) with the `immutable-proof-assertion` method of the calling user's organization DID (in this demo the node admin, so the node organization DID), and anchors it through the notarization connector. In 0.9.0 the proof carries the anchor as a `notarization:iota:0x<objectId>` reference. Attestation is a separate path: the calling organization signs the object with its `attestation-assertion` method and the result is minted as an NFT from that organization's wallet.

`POST /immutable-proof` returns the proof id immediately and the signing and anchoring finish in the background. The demo therefore polls `GET /immutable-proof/{id}` until the on-chain reference appears: the seed waits up to 50 seconds per document, and the server re-polls documents still unanchored at boot every 15 seconds, for at most 20 minutes.

Each uploaded or seeded document therefore leaves up to three records on the node. The first is an immutable proof over a JSON-LD envelope that contains the file's SHA-256, signed by the node organization DID. The second is an attestation of the same envelope signed by the uploading org. It is attempted for every org with TWIN user credentials and succeeds only for orgs provisioned with their own wallet. The third is the document-management entry: the encrypted file plus its AIG vertex. How these are checked is in [document-verification.md](document-verification.md).

Consignment vertices use the UN/CEFACT trade vocabulary published by UNECE, release D23B, as JSON-LD (`https://vocabulary.uncefact.org/unece-context-D23B.jsonld`, a transport `Consignment` wrapping an `includedConsignment` and its `includedConsignmentItem`). `server/twin/unece.js` maps them from the demo's flat shape, and each vertex carries its Unique Consignment Reference (UCR, the shipment's trade identifier) as an alias, a secondary key the AIG can be queried by.

The activities this repo posts to a DSP inbox are W3C Activity Streams (`server/adapter/dsp.js`). Share and revoke send `Add` and `Remove` with the UNECE consignment as `object` and the sharing and receiving organizations as `actor` and `target`. A document written back to a shared consignment sends an `Add` whose `object` is an Activity Streams `Document`. The WebSocket peer messages that actually deliver the data use the demo's own JSON format ([architecture.md](architecture.md)).

A share stores a plain ODRL `Offer`, built by `buildOdrlOfferPolicy()`. According to TWIN's documentation, the W3C ODRL types are identified by `https://schema.twindev.org/w3c-odrl/types.html` and TWIN's own extensions live under `https://schema.twindev.org/odrl/v1/`. One of them, `EcosystemPolicy`, adds party collections selected with JSONPath refinements. This repo uses none of the extensions.

## Tenancy and authentication

The nodes run with `TWIN_TENANT_ENABLED=true`. A tenant is a partition of the node's data with its own API key, users and organization DID. The node resolves the tenant on every request from the `x-api-key` header, so this repo sends it on every call, login included, except `GET /` and the activity-log read `GET /dataspace-data-plane/activity-logs/{id}`. Without the header the user lookup runs in the wrong partition and login answers 401 even for a correct password. Nothing binds a default tenant to the node, so the header is the only way a request reaches a tenant's data. This repo creates tenants with the CLI command `tenant-create`, which returns the tenant id and API key. In 0.9.0 it requires `--organization-id=<did>`, so the organization DID has to exist first.

Inside a tenant, a user account has an email, a password, a user DID, an organization DID and a scope. `POST /authentication/login` with email, password and the tenant's `x-api-key` returns a JWT, either as `token` or `access_token` in the response body or only in the `access_token` cookie. `KitsuneClient` accepts all three forms and sends the token both as `Authorization: Bearer` and as `Cookie: access_token=`, together with `x-api-key`. When the node returns no expiry, the wrapper assumes one hour and logs in again 60 seconds before it ends. Passwords must satisfy the node's policy: at least 16 characters, upper and lower case and a special character, and no run of three identical characters. `genPolicyPassword()` in `server/twin/compat/index.js` generates compliant ones.

This repo uses two kinds of tenant: one node tenant per node, created by the anchor stage (`npm run twin:bootstrap -- --stage=anchor`), which holds all corridor data and the admin user, and one tenant per org provisioned by `npm run twin:provision-orgs`, which holds that org's own signatures (its attestations and the trust credentials it issues). Their users, labels and stored credentials are described in the [tenant model](wallet-funding-workflow.md#tenant-model) of wallet-funding-workflow.md.

Data in one tenant is invisible from another. An org session from a per-org tenant logs in successfully but gets `proofNotFound` for proofs stored in the node tenant, which is why the `/twin/docs` Swagger page authenticates as a user of the node tenant. The account layers built on top of this, and the constraints of mixing the two tenant kinds, are covered in [authentication-architecture.md](authentication-architecture.md).

The demo server takes each node's API key from `TWIN_<NODE>_API_KEY` or, by default, from `data/tenant-state.json`, which the anchor and provisioning steps write. That file is local runtime state and holds every tenant API key and org password in clear text. The admin login comes from `TWIN_<NODE>_EMAIL` and `TWIN_<NODE>_PASSWORD`, whose defaults match `twin/<node>/bootstrap.env`. In `docker` mode each demo server also holds the other node's admin credentials and API key, used for the cross-node inbox call and to observe the recipient's graph. Demo-only exposure: the demo server's unauthenticated `GET /twin/demo-session`, `GET /twin/demo-orgs` and `GET /twin/openapi.json` return the node tenant API key, a freshly minted JWT and the seeded org credentials, so a deployment reachable by others discloses them.

## Configuration model

A node is configured only through `TWIN_*` environment variables. This repo keeps them in `twin/alpha/node.env` and `twin/beta/node.env`, which differ only in the MySQL host. `docker-compose.twin.yml` adds `TWIN_EXTENSIONS` for the runtime containers and a `TWIN_MY_SQL_PASSWORD` override for the runtime and bootstrap containers ([twin/README.md](../twin/README.md)). Connector variables pick the backend of a capability: `entity-storage` keeps the data in the node's own off-chain storage, while `iota` performs real ledger operations. Feature toggles (`TWIN_*_ENABLED`) load optional modules.

| Capability | Setting in this repo | Consequence |
|---|---|---|
| Entity storage | `mysql` | Node records live in the per-node MySQL database `twin` |
| Vault | `entity-storage` | Vault keys and wallet mnemonics are stored in that same MySQL database |
| Blob storage | `file`, with `TWIN_BLOB_STORAGE_ENABLE_ENCRYPTION=true` | Files are written under `TWIN_STORAGE_FILE_ROOT=/var/lib/twin`, encrypted with the calling organization's `blob-encryption` key. The demo server uploads with the node admin session, so in practice that is the node organization's key |
| Identity, identity resolver, wallet, NFT, notarization, faucet | `iota` | DIDs, NFTs and notarizations are real objects on the IOTA testnet (`TWIN_IOTA_NODE_ENDPOINT=https://api.testnet.iota.cafe`, `TWIN_IOTA_NETWORK=testnet`) |
| Attestation | `nft` | Each attestation is minted as an NFT |
| Identity profile | `entity-storage` | Off chain, not used by the demo |
| Logging, event bus | `console`, `local` | In-process only |
| Telemetry | commented out | Disabled |
| Debug | `TWIN_DEBUG=true` | Verbose node logs. According to the node documentation, debug mode also turns on request-body route logging (`TWIN_ROUTE_LOGGING_INCLUDE_BODY`), so login passwords may reach the logs |

Because the vault uses entity storage, the MySQL database (volume `mysql_data_<node>`, port 3306 or 3307 on loopback) holds the node and org signing keys and the wallet mnemonics. Treat a database dump or a copy of the volume with the same care as the wallet bundle and its passphrase. Before anyone else relies on a node, set `TWIN_DEBUG=false`, change the default MySQL passwords ([twin/README.md](../twin/README.md)) and run the database as a managed, backed-up service.

According to the node documentation this repo was built from (not checked against the 0.9.0 image), entity storage also supports `file`, `memory`, `postgresql`, `mongodb`, `aws-dynamodb`, `azure-cosmosdb`, `gcp-firestoredb` and `scylladb`. Blob storage also supports `memory`, `ipfs`, `aws-s3`, `azure-storage` and `gcp-storage`, the vault supports `hashicorp`, and the identity resolver supports `universal`.

The enabled toggles are `TWIN_TENANT_ENABLED`, `TWIN_HEALTH_ENABLED`, `TWIN_DATA_PROCESSING_ENABLED`, `TWIN_AUDITABLE_ITEM_GRAPH_ENABLED`, `TWIN_AUDITABLE_ITEM_STREAM_ENABLED`, `TWIN_DOCUMENT_MANAGEMENT_ENABLED`, `TWIN_FEDERATED_CATALOGUE_ENABLED`, `TWIN_TASK_SCHEDULER_ENABLED` and `TWIN_DATASPACE_ENABLED`. `TWIN_DATASPACE_DATA_PLANE_PATH=dataspace-data-plane` sets the prefix of data-plane reads such as activity logs, while the inbox itself is served at `POST /dataspace/inbox` (see the quirks table). Enabling the dataspace has side effects. It switches on trust (configured here with `TWIN_TRUST_VERIFIERS=jwt-verifiable-credential`) and rights management, neither of which has its own toggle in 0.9.0. According to the node documentation it also switches on the automation module and the URL transformer, which encrypts URL parameters with the `param-encryption` vault key and is enabled by tenant mode as well. Finally it makes the immutable-proof module mandatory, and that module needs a notarization connector, so without `TWIN_NOTARIZATION_CONNECTOR=iota` the engine aborts at start with `Instance type not found for notarizationConnector`.

Node 0.9.0 validates its environment strictly and, according to the comments in `node.env` and `.env.example`, rejects `TWIN_*` keys it does not know. Do not add `TWIN_VERIFIABLE_STORAGE_CONNECTOR`, `TWIN_BACKGROUND_TASKS_ENABLED`, `TWIN_RIGHTS_MANAGEMENT_ENABLED` or `TWIN_DATASPACE_PEER_NODES` to `node.env`, even though older TWIN examples use them. None is needed: immutable proofs use the notarization connector, the task scheduler toggle is `TWIN_TASK_SCHEDULER_ENABLED`, rights management follows the dataspace toggle, and DSP peers are addressed per request.

## Extensions loaded by this repo

A node loads the extension modules listed in `TWIN_EXTENSIONS` (comma-separated). An extension exports lifecycle hooks that the node calls in order: `extensionInitialise(envVars, nodeEngineConfig)` before the engine is built, to register component types in the configuration, then `extensionInitialiseEngine(engineCore)` once the engine exists, to register initializers, then `extensionInitialiseEngineServer(engineCore, engineServer)` once the HTTP server exists, to add REST routes. According to the node documentation there is also an optional `extensionShutdown()` hook, and modules can be loaded as `npm:@scope/package` or from `https://` URLs (downloaded and cached, at most 10 MB), while plain `http://` is rejected. This repo uses none of these and loads one local plain-JavaScript ES module.

**`twin/dataspace-app.mjs`** is that extension. `docker-compose.twin.yml` mounts it read-only into the runtime containers and sets `TWIN_EXTENSIONS=/app/dataspace-app.mjs`. It registers the component `corridorDataspaceApp` as a dataspace app, the node-side handler to which the DSP inbox hands an inbound activity whose object type the app lists in `activitiesHandled()`. Without an app, an activity delivered to the inbox has nowhere to go. Because the node rejects the demo's inbox calls, the app is loaded but never exercised. What its handlers do, what the scaffold leaves out and the `APP_ID` to replace before you run your own nodes are described in [dsp-design.md](dsp-design.md#the-corridor-dataspaceapp).

**`twin/jsonld-fix.mjs`** is not an extension but a Node.js preload, injected into the runtime containers only with `NODE_OPTIONS=--import /app/jsonld-fix.mjs`. It exists because the node compacts immutable-proof responses against JSON-LD contexts hosted under `https://schema.twindev.org/`, and those URLs return 404. An unresolvable context makes compaction silently drop the terms that carry the on-chain reference (`notarizationId`, `immutableReceipt`, `objectId` and similar), so the demo cannot build the IOTA Explorer link and the document stays on "Writing to ledger". The preload replaces the JSON-LD document loader: for any `schema.twindev.org` URL it returns a local context whose `@vocab` is that URL's base, plus the known terms, and it passes every other URL to the default loader. It only affects reads. The same 404 breaks the node's OpenAPI `$ref`s, which `server/routes/twin-proxy.js` replaces with empty schemas before serving `/twin/docs`. Both workarounds can go once the contexts resolve again, so check those URLs before removing them.

## Bootstrap and provisioning with the node CLI

The runtime container does not create its own identity. It needs an engine state written beforehand by a one-shot step, and without it the node exits at start. That step uses the node's CLI, which is the same image run as `node src/index.js <command> --flag=value`. According to the node documentation, every CLI command accepts `--output-json=<file>` to write its result and `--load-env=<file>` to read extra variables from a file. This repo runs the CLI in throwaway `twin-bootstrap-<node>` containers (compose profile `bootstrap`), one per command for the anchor and one per node for the whole org batch during provisioning. They share the node's `node.env`, data volume and MySQL, and the scripts read results back through `--output-json`.

The image also has a one-command bootstrap, `bootstrap-legacy`, driven by `TWIN_FEATURES=node-identity,node-admin-user,node-wallet` in `twin/<node>/bootstrap.env`, which the compose service mounts at `/app/.env.bootstrap` and passes as `--load-env=.env.bootstrap`. It generates a mnemonic inside the container, funds the wallet from the testnet faucet and creates the identities, keys and admin user. `npm run twin:bootstrap -- --legacy` still runs it, but the demo does not work afterwards: it ignores the wallet bundle and writes no `data/tenant-state.json`, so the demo servers have no tenant API key and every login returns 401. Use it only to debug the node image. The supported path calls the granular commands instead, with a mnemonic taken from your local encrypted wallet bundle (`data/wallets.enc.json`, created by `npm run twin:wallets:create` and never committed), whose address you funded beforehand: `npm run twin:bootstrap -- --stage=anchor` for the node, then `npm run twin:provision-orgs` for one tenant, DID and funded wallet per org. The order of the chain and the reasons for the two-stage design are in [wallet-funding-workflow.md](wallet-funding-workflow.md), and the procedure is in [running-the-demo.md](running-the-demo.md).

| Command | Creates | Used here for |
|---|---|---|
| `identity-create --mnemonic=... --fund-wallet=false` | A DID on IOTA, created and paid for by the wallet of the given mnemonic. With `--controller=<did>` the new DID is controlled by another DID | Node DID, node organization DID (controlled by the node DID), one DID per provisioned org |
| `node-set-identity --identity=<did>` | Records the node DID in the engine state | Must run right after the node DID is created and before any other command. Otherwise `tenant-create`, `user-create` and the rest fail with "node identity is enabled in config but is not set" |
| `vault-key-create --identity --key-id --key-type` | A key in the node vault under that identity | `auth-signing` (Ed25519, signs login JWTs), `param-encryption` (ChaCha20Poly1305, used by the node's URL transformer during login), `blob-encryption` (ChaCha20Poly1305, per organization, encrypts uploads) |
| `identity-verification-method-create --verification-method-id --verification-method-type=assertionMethod` | A verification method on the DID document (an on-chain update) | `org-assertion` (credentials this repo issues, such as the share's trust credential), `attestation-assertion` (attestations), `immutable-proof-assertion` (immutable proofs) |
| `tenant-create --label --organization-id=<did>` | A tenant and its API key | The `x-api-key` on every REST call |
| `user-create --tenant-id --user-identity --organization-identity --email --password --scope` | A login inside a tenant | Node admin (`tenant-admin,user-admin`) and org users (`user`) |
| `tenant-token --tenant-id` | Nothing on 0.9.0. A code comment in `server/twin/kitsune-client.ts` records that 0.9.0 does not have this command | The anchor step still calls it best effort and logs the failure, which is harmless. No request uses a tenant token |

The node selects the key and method ids through settings that this repo leaves at their defaults: `TWIN_AUTH_SIGNING_KEY_ID` (`auth-signing`), `TWIN_URL_TRANSFORMER_ENCRYPTION_KEY_ID` (`param-encryption`), `TWIN_BLOB_STORAGE_ENCRYPTION_KEY_ID` (`blob-encryption`), `TWIN_ATTESTATION_VERIFICATION_METHOD_ID` (`attestation-assertion`) and `TWIN_IMMUTABLE_PROOF_VERIFICATION_METHOD_ID` (`immutable-proof-assertion`). The same ids are hard-coded in `VM` and `VAULT_KEY` in `server/twin/compat/index.js`, so a rename has to be made in both places.

`bootstrap-legacy` creates the keys and verification methods implicitly. The granular chain must create each one, and a missing item surfaces only later as a runtime error, for example `entityStorageVaultConnector.keyNotFound` at the first login when the `auth-signing` key is missing, or `attestationService.attestFailed` on `POST /attestation` from a DID without `attestation-assertion`. [The anchor chain](wallet-funding-workflow.md#the-anchor-chain) in wallet-funding-workflow.md lists each step with the error its absence produces.

DIDs created over REST with `POST /identity` get only `org-assertion` and `attestation-assertion`, added by `DockerAdapter.createDid()`. They lack `immutable-proof-assertion` and, having no wallet, cannot mint attestations (see the cost model below).

The results live in two places: `engine-state.json` under `/var/lib/twin` on the `twin_data_<node>` volume, and the vault, users and tenants in MySQL on the `mysql_data_<node>` volume. Deleting those volumes, which `npm run twin:reset` does, discards the node's identity and tenants. The wallet bundle survives, but the next anchor creates new DIDs and pays gas again.

## On-chain cost model

IOTA is not feeless. Every on-chain write is paid in gas by the wallet behind the identity that performs it: creating a DID, adding a verification method, notarizing an immutable proof, minting an attestation NFT. Testnet tokens are free from `https://faucet.testnet.iota.cafe`, but the wallet must hold them before the write.

The pitfall is the gas budget. Each DID, verification-method or mint operation reserves a budget of 1 IOTA (1,000,000,000 nanos) before it runs, while the actual spend is far lower (about 0.03 IOTA for an org's whole provisioning chain, according to the measurement recorded in `server/twin/compat/index.js`). A wallet holding exactly 1 IOTA therefore fails with `does not have enough coins to form a balance of 1000000000`. This is why `twin:provision-orgs` funds each org wallet with 2 IOTA (`ORG_FUNDING_IOTA`, default `ORG_FUNDING_IOTA_DEFAULT = 2n`).

| Wallet | Funded by | Pays for |
|---|---|---|
| Node wallet, one per node, mnemonic in `data/wallets.enc.json` | The operator, from the faucet | Node DID and node organization DID (both created and paid for by this wallet) with their verification methods, immutable proofs issued under the node organization DID, and the funding of every org wallet |
| Org wallet, one per provisioned org | The node wallet, 2 IOTA per org | The org's DID, its verification methods and its attestation NFTs |

Orgs registered over `POST /identity` (UI registration, seed fallback) get no wallet, because that route takes no mnemonic, so they cannot mint attestations. Their DID and verification methods are created through the node admin's session, so the gas presumably comes from the node wallet (inferred from the code, not checked on chain).

Document proofs may not be the only notarizations. AIG changesets returned by the node carry a `proofId` (as `schema:proofId`, see the quirks table), which indicates that consignment updates are notarized as well, and an AIS stream can add a proof every `immutableInterval` entries, a setting this repo leaves at the service default. How much gas these add has not been measured.

Re-provisioning is the expensive operation: every `npm run twin:reseed` funds a fresh wallet for every org and abandons the old ones with their balance. Numbers and options are in [wallet-funding-workflow.md](wallet-funding-workflow.md). A node can also be configured with an IOTA Gas Station that sponsors fees for its users, which this repo does not use.

## Pinned versions

| Component | Version | Role |
|---|---|---|
| TWIN node (`twinfoundation/twin-node`) | 0.9.0, Docker image for linux/amd64 and linux/arm64 | One node per side (Alpha, Beta), pinned in `docker-compose.twin.yml`. |
| MySQL | 8.4.7 (Docker image) | Entity storage, one instance per TWIN node. |
| IOTA Identity (`@iota/identity-wasm`) | 1.9.6-beta.1 | Inside the TWIN node: creates and resolves the `did:iota:testnet:0x...` DIDs of nodes and organisations. |
| IOTA Notarization (`@iota/notarization`) | 0.1.13 | Inside the TWIN node: anchors document proofs on chain. |
| IOTA SDK (`@iota/iota-sdk`) | 1.14.0 | Inside the TWIN node's IOTA connectors, and in this repo for `scripts/twin/wallets.mjs` (wallets, balances, organisation funding). |
| `@twin.org/*` REST clients | 0.9.0 | Wrapped by `server/twin/`, pinned in `package.json`. |
| IOTA testnet | | RPC `https://api.testnet.iota.cafe` (TWIN nodes, funding transactions, cross-node checks), the SDK's default testnet endpoint for balance checks in `scripts/twin/wallets.mjs`, faucet `https://faucet.testnet.iota.cafe`, explorer `https://explorer.iota.org`. |

The demo never calls IOTA Identity or IOTA Notarization directly. It calls the TWIN node REST API, and the node uses those libraries through its IOTA connectors (`TWIN_IDENTITY_CONNECTOR=iota` and `TWIN_NOTARIZATION_CONNECTOR=iota` in `twin/<node>/node.env`). The IOTA Identity and Notarization versions come from the npm metadata of `@twin.org/identity-connector-iota`, `@twin.org/notarization-connector-iota` and `@twin.org/dlt-iota` at 0.9.0, not from an inspection of the image. In this repo, `package.json` requires `@iota/iota-sdk` `^1.14.0` and the lockfile installs 1.14.0.

The pinned image tag is what keeps the node stack fixed. The 0.9.0 connectors depend on `@twin.org/dlt-iota` `^0.9.0`, whose 0.9.1 and 0.9.2 releases require `@iota/iota-sdk` 1.15.0 and `@iota/identity-wasm` 1.9.7-beta.1, so a node rebuilt from the same npm ranges would pull different IOTA libraries. In October 2026 npm listed the TWIN node package (`@twin.org/node`) up to 0.9.4 on the 0.9 line and 0.11.0 overall. Moving to the latest 0.9.x and re-checking the workarounds below is the lower-risk path. 0.11 has not been tested with this repo, and a 0.x minor release can change the REST API.

## Node quirks this repo compensates for

The 0.9.0 `@twin.org/*` REST clients and the 0.9.0 node disagree on some paths and response shapes. `KitsuneClient` works around each mismatch, so code that bypasses it runs into them again.

| Area | What the client package or spec assumes | What the running node does | Workaround in this repo |
|---|---|---|---|
| Auditable item graph | Prefix `/auditable-item-graph` | Serves `/aig` | `pathPrefix: "aig"` |
| Auditable item stream | Prefix `/auditable-item-stream` | Serves `/ais` | `pathPrefix: "ais"` |
| Document management | Prefix `/document-management` | Serves `/documents` | `pathPrefix: "documents"` |
| Credential issuance | `POST /identity/{did}/verifiable-credential`, dropping the verification method id | Needs `POST /identity/{did}/verifiable-credential/{vmId}` | `PatchedIdentityRestClient` (`server/twin/patched-identity-rest-client.ts`) |
| Dataspace inbox | `DataspaceDataPlaneRestClient` posts to `/dataspace-data-plane/inbox` | That path returns 404, the inbox is `POST /dataspace/inbox` | Raw `fetch` in `forwardActivity()` |
| Federated catalogue | No client package installed. Comments in `node.env` name `/catalog/request` | Serves `POST /federated-catalogue/request`, body a DSP `CatalogRequestMessage` with a required `filter` array. An empty catalogue answers 404 `noDatasetsFound` (according to a code comment, while on 0.9.0 the call was seen rejected earlier for lack of a trust credential, see the module table) | Raw `fetch` in `queryFederatedCatalog()`, the 404 is read as zero datasets |
| AIG list and changesets | Plain keys | Keys prefixed `schema:` (`schema:aliases`, `schema:patches`, `schema:proofId`) | Normalized in `queryAigVertices()` and `getAigChangesets()` |
| Immutable proof receipt | A fixed field path | The on-chain reference sits at varying depth, as `notarization:iota:0x<objectId>` on 0.9.0 | `normalizeImmutableProof()` walks the whole object |
| ODRL policies | Generic ODRL | Policy ids must start with `policy:`, `@context` must be `http://www.w3.org/ns/odrl.jsonld` (the `https` form is rejected), an `Offer` needs a top-level `assigner` | `buildOdrlOfferPolicy()` in `server/adapter/dsp.js` |

Version-specific workarounds that are not path fixes are inventoried in the `SHIMS` list of `server/twin/compat/index.js`:

| Shim | Compensates for | Explained in |
|---|---|---|
| `jsonld-context-loader` | The 404 JSON-LD contexts, handled by `twin/jsonld-fix.mjs` | [Extensions loaded by this repo](#extensions-loaded-by-this-repo) |
| `cli-mnemonic-did` | REST-created DIDs having no wallet | [On-chain cost model](#on-chain-cost-model) |
| `bootstrap-completeness` | Keys, methods and admin scope the granular chain must create | [Bootstrap and provisioning](#bootstrap-and-provisioning-with-the-node-cli) |
| `immutable-proof-shape` | The moving on-chain reference inside the proof | Quirks table above |
| `password-policy` | The node's password rules | [Tenancy and authentication](#tenancy-and-authentication) |
| `org-funding-floor` | The 1 IOTA gas budget reservation | [On-chain cost model](#on-chain-cost-model) |
| `immutable-proof-notarization-gate` | Immutable proof requiring a notarization connector | [Configuration model](#configuration-model) |
| `tenant-additive` | Per-request tenant resolution and the required `tenant-create --organization-id` | [Tenancy and authentication](#tenancy-and-authentication) |

To move to a newer node, change the image tag in `docker-compose.twin.yml`, `NODE_COMPAT_VERSION` and the `@twin.org/*` pins in `package.json` together, run `npm install` and `npm run build:twin`, then walk `SHIMS` and delete what the new version fixed (the header of `server/twin/compat/index.js` describes these steps). The same header suggests `npm test` plus the org-attestation test. With nodes running, `npm test` also runs the integration suites: the org-attestation suite mints an NFT on testnet whenever `data/tenant-state.json` lists provisioned orgs, while the suites that gate on an unauthenticated `GET /health` never reach these nodes, because that probe fails with 401 ([open-work.md](open-work.md#tests-that-report-less-than-they-appear-to)). A passing run is therefore weak evidence for the upgrade and still spends gas. `npx vitest run tests/server` stays local.

Comments in the compat layer, the client wrapper, `node.env` and the scripts often name pre-release node versions (`next.40`, `next.48`, `next.63` and similar). They record where a behavior was first observed, and 0.9.0 is the version that runs. Some of those comments do not match 0.9.0, and [open-work.md](open-work.md) lists the misleading ones.
