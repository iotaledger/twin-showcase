# Open work and known defects

This is the single list of what does not work yet, what works only in part, and what is missing in the demo. Defects are recorded here, not fixed, and every `path:line` reference points at the code as of version 1.0.0 (`package.json`). Behaviour that is simulated by design (finance, the customs channel logic, the business-registry check) is described in [architecture.md](architecture.md) and appears here only where it misleads or blocks something.

Items are verified in code (the cited lines, or the installed package where one is named, show the behaviour) unless they carry one of these labels, given in an Evidence line after the finding or inline next to the claim it covers:

| Label | Meaning |
|---|---|
| Inferred | A runtime consequence (timing, node response, process crash) derived from the code but not reproduced on running nodes. |
| Observed on a running instance | Seen on running TWIN nodes or a running demo instance (node 0.9.0 unless an earlier build is named), and not re-checked against the current code. |
| Assumption | A claim from the developers' notes, code comments or package documentation that was neither verified in code nor observed. |
| Risk | A failure seen only on a build older than 0.9.0, or plausible but not reproduced. |

Terms used throughout: a bare "node" means a TWIN node, while Alpha and Beta name both a demo server and its TWIN node. The AIG (auditable item graph) is the node module that stores each consignment as a vertex with its UCR (Unique Consignment Reference) as alias, and the AIS (auditable item stream) holds the ledger entries. ODRL is the W3C policy language in which the node stores access policies. A trust VC is a verifiable credential signed with the sending org's DID, which the node's inbox requires as its bearer token. The corridor DataspaceApp (`twin/dataspace-app.mjs`) is the node extension that ingests inbound activities. The Federation Receipt is the panel (`FederationReceipt.jsx`) the sender sees after a share. The two parties of a share are the sender (which [dsp-design.md](dsp-design.md) calls the sharer) and the recipient, which DSP calls the provider and the consumer. [twin-node-overview.md](twin-node-overview.md) describes the node modules.

## Where to start

| Item | Area | Why it comes first |
|---|---|---|
| [Cross-node shares do not travel over DSP](#cross-node-shares-do-not-travel-over-dsp) | DSP federation | On node 0.9.0 the federation the demo presents runs as an unauthenticated WebSocket copy between the two demo servers. |
| [Demo endpoints hand out node and org credentials](#demo-endpoints-hand-out-node-and-org-credentials) | Security | Anyone who can open a deployed instance gets tenant API keys, a node JWT and org passwords. |
| [Authentication without authorisation and open reads](#authentication-without-authorisation-and-open-reads) | Security | Any logged-in user can act as any org, and anyone can download any document. |
| [Shares do not survive a demo-server restart](#shares-do-not-survive-a-demo-server-restart) | State | A restart on either side silently drops cross-node access. |
| [Default corridor differs per entry point](#default-corridor-differs-per-entry-point) | Configuration | Seeding one corridor and running another makes the demo ignore the seeded on-chain identities. |
| [`npm test` writes to the IOTA testnet](#npm-test-writes-to-the-iota-testnet) | Tooling | The obvious test command spends gas whenever the nodes are up. |
| [The UI reports WebSocket delivery as DSP delivery](#the-ui-reports-websocket-delivery-as-dsp-delivery) | Frontend | Audiences are told a protocol exchange happened that did not. |

## DSP federation

The Dataspace Protocol (DSP) is the standard the TWIN node implements for exchanging data between independent organisations: a catalogue of datasets, a contract negotiation that ends in an agreement, and a transfer process inside which data is pushed or pulled. How the demo uses it today, including the node's inbox contract, is in [dsp-design.md](dsp-design.md). None of this applies in `simulated` mode, where the WebSocket peer channel is the only cross-node path by design.

### Cross-node shares do not travel over DSP

A cross-node share (`POST /api/permissions/share`) creates a real ODRL policy on the sender's node and then posts an Activity Streams `Add` to `POST /dataspace/inbox` on the recipient's node (`server/adapter/docker.js:377-439`, `server/twin/kitsune-client.ts:553-621`). Node 0.9.0 accepts an inbox activity only inside a DSP transfer process in state `STARTED` between the two parties, and otherwise answers `pushActivityNotAuthorized`. The demo never registers a dataset through the node's API, negotiates an agreement or starts a transfer: nothing in `server/`, `scripts/` or `twin/` imports `@twin.org/dataspace-control-plane-rest-client`, although `package.json` already pins it at 0.9.0. The consignment actually reaches the other side as a `SHARE_CONSIGNMENT` message on the demo's WebSocket peer channel, files included.

The data path the demo presents as federation is therefore a bilateral copy over a channel without authentication (see [The peer WebSocket channel is unauthenticated](#the-peer-websocket-channel-is-unauthenticated)). The properties a dataspace participant would expect from DSP, a transfer bound to an agreed policy and a sender verified by the receiving node, do not apply to the data that moves.

Evidence: the rejection is observed on a running instance.

Next step: build the lifecycle in a standalone script against two running nodes before touching the share route. The sequence to prototype is:

1. On the sender's node, register the shared consignment as an app dataset of the corridor DataspaceApp (`createAppDataset`), carrying the ODRL offer that `buildOdrlOfferPolicy` in `server/adapter/dsp.js` already builds.
2. On the recipient's node, negotiate an agreement for that dataset and prepare the transfer. The pinned REST client cannot do this from outside the node: in `@twin.org/dataspace-control-plane-rest-client` 0.9.0, `negotiateAgreement` and `prepareTransfer` throw `notSupportedOnClient`, because negotiation and consumer-initiated transfers run in-process on the node. The client's REST calls are the app-dataset methods, `requestTransfer`, `startTransfer`, `completeTransfer`, `suspendTransfer`, `terminateTransfer` and `getTransferProcess`. One way in is a REST route registered by the corridor DataspaceApp, whose `generateRestRoutes` returns no routes today (`twin/dataspace-app.mjs:304-306`).
3. Once `getTransferProcess` reports `STARTED`, retry the existing inbox POST, which should then return 2xx.

DSP is consumer-initiated while the demo's share is a provider push, so one decision is open: either a share triggers the negotiation on the recipient's side, or the sender pre-registers datasets that the recipient pulls. Prototype both before choosing.

Build the DSP messages from the types in `@twin.org/standards-dataspace-protocol` (installed at 0.9.0 as a transitive dependency) rather than by hand. Expect to override the client's path prefix (default `dataspace-control-plane`), as `server/twin/kitsune-client.ts` does for the other REST clients (`:167`, `:316`, `:352`, `:502`, `:657`), and probe the route on a running node first. Keep `simulated` mode on the WebSocket peer channel.

Assumption: two points come from reading the node packages, not from tests. The node's control-plane service may have a provider-side `autoStartTransfers` option that moves a requested transfer to `STARTED` without an explicit `startTransfer` (the client's documentation of `requestTransfer` also describes auto-start as a provider-side setting, but `twin/*/node.env` does not set one and the controlling environment variable is unknown). The node may also already provide transfer-process and app-dataset storage and a transfer-cleanup task, in which case no storage configuration is needed.

### The federated catalogue is empty and peer discovery depends on the WebSocket handshake

Catalogue-based peer discovery fails at three levels. On 0.9.0 the request itself is rejected: `queryFederatedCatalog` sends the session JWT as its bearer (`server/twin/kitsune-client.ts:705-711`) where the node expects a trust credential, and the node answers with a `CredentialStructure` error. The client maps only a 404 `noDatasetsFound` to an empty list (`:719-731`), so boot hydration logs a warning (`server/store.js:458-461`). With a valid credential the catalogue would still be empty, because nothing registers datasets. With datasets, `hydratePeerOrgsFromCatalog` would still keep only those typed `Organization` (`server/store.js:409-415`), while the DataspaceApp declares one static `Consignment` dataset (`twin/dataspace-app.mjs:76-106`).

The share route runs the DSP path, ODRL policy included, only when the recipient org is in `store.peerOrgs` (`server/routes/permissions.js:108`, `:141`). With the catalogue returning nothing, only the WebSocket peer messages fill that list (`HANDSHAKE`, `ORG_DIRECTORY` and `ORG_UPDATE`, `server/ws.js:63`, `:77-78`), and closing the channel empties it (`:53`, `:72`). Without a connected peer channel no cross-node share happens at all.

Evidence: the `CredentialStructure` rejection and an empty catalogue are observed on a running instance.

Next step: deliver this with the transfer lifecycle. Decide how organisations surface (as publishers of consignment datasets or as entries of their own), mint a trust VC for the catalogue request the way `#mintShareTrustCredential` does for the inbox, and fill `store.peerOrgs` from the catalogue in docker and hosted mode.

### Revoke and document write-back notifications go to the sender's own node

`dspRevokeConsignment` (`server/adapter/docker.js:552-584`) and `dspNotifyDocumentUpload` (`:603-608`) call `forwardActivity` on the local client, without `?organization=`, without the recipient's tenant key and without a trust VC. Each activity therefore goes to the node of the demo server that sends it: the sender's node for a revoke, and for a write-back the writer's node, usually the recipient's. They cannot meet the inbox contract the share path follows, and their failures are only logged (`docker.js:581`, `server/routes/documents.js:243`). Even if they arrived, the DataspaceApp acknowledges `Remove` without acting on it (`twin/dataspace-app.mjs:177-181`), and the upload activity carries an Activity Streams `Document` object that the app does not handle (`:136-138`) and no `generator`, which the inbox requires (`buildDocumentUploadActivity`, `server/adapter/dsp.js:74-100`). Only the ODRL policy deletion and the WebSocket `REVOKE_CONSIGNMENT` and `UPLOAD_DOCUMENT` messages take effect.

Evidence: that the node rejects these posts is inferred from the inbox contract.

Next step: route both calls through `#clientForNode(resolveOrgNode(...))` with the same `organization`, `apiKey` and `trustPayload` options as the share, taking the target of a write-back from the consignment's `originNode`. Send the UNECE document type the app handles, with the writer org's DID as `generator`, and implement `Remove` in the app. On the sender's node, ingest a write-back only when the writing org holds the `modify` permission of the share's ODRL policy. The AIG is append-only, so a revoke has to be recorded on the replicated vertex (for example as a revocation annotation) instead of deleting it.

### Revoke leaves the replicated consignment on the recipient's node

On a share, the recipient's demo server writes the consignment as a vertex on its own node's AIG (`replicateConsignmentToNode`, `server/ws.js:10-27`). A revoke removes it from the recipient's memory (`ws.js:133-142`) but not from the node. Every 5 s, `pollInboundShares` (`ws.js:161-196`) lists the node's consignment vertices, finds this one missing from memory and adds it back, with a new "received ... via the Dataspace Protocol" ledger entry and, if the earlier notification bell entry was acknowledged, a new notification. The recipient's orgs still cannot open it, because their grant is gone and `GET /api/consignments` filters by grant (`server/routes/consignments.js:21-25`). Once re-added, the consignment (without its documents) is again served by the recipient's public shipment page and by `GET /api/verify/consignment/:ref`, which look it up in memory without checking grants (`server/routes/public-shipment.js:91-97`, `server/routes/verify-api.js:107-110`).

The recipient's handler also ignores which org was revoked: `REVOKE_CONSIGNMENT` carries `recipientOrgId`, but the handler deletes the consignment, its documents and every grant on it (`server/ws.js:133-142`). Revoking one org on the other node therefore removes access for every org on that node, while the sender still lists the remaining grants.

Evidence: the re-add by the poll is inferred.

Next step: remove only the revoked org's grants, and drop the consignment on the recipient only when no grant is left. Record the revocation on the vertex when the revoke arrives and make the poll skip revoked UCRs (part of the revoke work above).

### File contents never travel over DSP

`buildShareActivity` strips `fileBase64` from every document (`server/adapter/dsp.js:126`), the DataspaceApp only counts attached documents (`twin/dataspace-app.mjs:166-168`, `:229`), and its `handleDataRequest` returns empty data (`:257-268`). Downloads on the recipient work today only because the WebSocket messages carry the files. With a working transfer lifecycle, a recipient would still get metadata and proofs but no files.

Next step: serve document bytes from the sender's document-management store through `handleDataRequest` and let the recipient pull them inside the transfer.

### Sender identity is verified but not authorised

The share path signs a trust VC with the sender org's DID, and the receiving node verifies the signature (`TWIN_TRUST_VERIFIERS=jwt-verifiable-credential` in `twin/*/node.env`). Nothing checks whether that DID belongs to an approved partner. This is latent today, because the inbox rejects every share. Once the transfer lifecycle works, any org whose DID verifies and that completes a negotiation can push activities into the DataspaceApp.

Evidence: the signature check and the `STARTED` requirement are observed on a running instance.

Next step: keep a trust registry per corridor (an allow-list of partner DIDs or nodes, in the config or derived from the catalogue). Check it when a negotiation or transfer request arrives and again on the activity's `generator` in the DataspaceApp before ingesting, and return a rejection reason the Federation Receipt can show. Decide how removing a partner affects transfers already started. The WebSocket peer channel is covered under [The peer WebSocket channel is unauthenticated](#the-peer-websocket-channel-is-unauthenticated).

### Two cross-node ingestion paths

Inbound consignments reach a demo server through the WebSocket handlers (`server/ws.js:80-142`) and through the recipient poll (`ws.js:161-196`), each with its own de-duplication, ledger entry and notification. The two paths disagree whenever memory and the node diverge, so a revoke or a restart produces a second "received" ledger entry and notification ([revoke](#revoke-leaves-the-replicated-consignment-on-the-recipients-node), [restart](#shares-do-not-survive-a-demo-server-restart)), and every ingestion fix has to be made twice. Document uploads (`server/routes/documents.js:218`, `:338`) and the customs import declaration (`server/routes/customs.js:349`) reach the peer only over the WebSocket peer channel, through `mirrorDocumentToPeer`.

Next step: extract one `ingestConsignment(consignment, { origin, via })` used by both paths and emitting one event, then gate WebSocket ingestion to `simulated` mode once DSP delivery works. This is the prerequisite for making DSP the only cross-node channel in docker and hosted mode.

### Two nodes are hardcoded, and hosted mode has no peers

`resolvePeers` returns no peers outside docker mode (`server/adapter/index.js:112-120`), so in hosted mode the inbox POST goes to the sender's own node and the Federation Receipt reports a failed delivery. The rest of the stack assumes exactly Alpha and Beta:

- `DOCKER_DEFAULT_PORT` and `KNOWN_NODES` (`server/adapter/index.js:69`, `:106`)
- `NODES` in `scripts/twin/wallets.mjs:50` and `scripts/seed-twin-nodes.js:51`
- the proxy's two targets (`server/proxy.js:23-37`)
- the required `alpha` and `beta` keys in `configs/demo-config.schema.json`
- `GET /api/node/discover`, which returns one computed peer named after the other of Alpha and Beta (`server/routes/node.js:32-37`)
- the boot seed, which loads Beta's consignments on every demo server whose id is not `alpha` and seeds finance records only on Alpha (`server/seed.js:42`, `:213`)
- a single `peerConnected` flag in the client (`client/src/context/NodeContext.jsx:10`)

Next step: make the node set configurable (corridor schema, compose, scripts, proxy, adapter). That can be built now, but a third node receives shares only once the transfer lifecycle works. Making DSP the only cross-node channel in docker and hosted mode also depends on the transfer lifecycle, on the single ingestion path above, and on revoke and upload over DSP.

### Cross-node document verification proves less than it shows

For a document anchored on the other node, `verifyCrossNodeProof` (`server/adapter/docker.js:617-665`) first asks the local node to verify the peer's proof id and labels a success `verificationSource: 'dsp'`, although no DSP or federated call is made and the local node is not expected to hold the peer's proof. It then falls back to `iota_getObject` on the IOTA RPC, which only checks that an object with the proof receipt's `objectId` exists, not that it matches the document hash. The proof receipt reaches the recipient over the unauthenticated peer channel, and the recipient's copy arrives with the sender's `proofVerified` flag, so "Verified on peer ledger" can appear before the recipient checked anything. The public `/verify` page and the system-to-system verify API run the same check (`liveVerifyDoc`, `server/lib/verification.js:31-49`) and report its result as verified. The full proof VC is not available across nodes: `GET /api/documents/:id/proof` returns 409 (`server/routes/documents.js:262-268`).

The recipient can also lack the `objectId` the fallback needs. A document is re-sent to the peer with its on-chain receipt only when `POST /api/documents/:id/verify` runs on the owner's side while the consignment is shared with an org of the other node (`server/routes/documents.js:335-339`). The uploader's browser calls that route every 4 s for 2 minutes after an upload (`client/src/context/NodeContext.jsx:113-150`), and "Verify on ledger now" calls it on click. The anchor backfill fills in the receipt without re-sending (`server/anchor-backfill.js:49-64`). A document that reached the peer before its receipt existed, and whose receipt then arrived through the backfill or after the browser's 2-minute window (typically a seeded document shared before its proof anchored), therefore cannot be verified on the recipient (409, `verificationSource: 'unavailable'`) until someone on the owner's side clicks Verify.

Evidence: that the first path always falls through is inferred.

Next step: fetch the proof VC from the anchoring node (inside a DSP transfer once that works, or through that node's API), verify its signature, compare the VC and the on-chain object with the document hash, drop the received `proofVerified` flag, and rename the `dsp` source (for example to `node`) together with its client label. Re-send the document to the peer from the anchor backfill as well. [document-verification.md](document-verification.md) describes the current checks.

### Smaller DSP items

| Item | Impact | Next step | Evidence |
|---|---|---|---|
| The share response waits for the sender's observation of the recipient's AIG, 6 polls 1.5 s apart (`server/adapter/docker.js:452-474`) | A share takes at least 9 s when the vertex does not appear | Return at once and push the Federation Receipt to the browser over the existing WebSocket | Inferred from the poll budget |
| After the inbox POST, `forwardActivity` polls `/dataspace-data-plane/activity-logs/{id}` without credentials, 6 times 1.2 s apart (`server/twin/kitsune-client.ts:606-640`), a prefix the running node does not mount for the inbox (`:560-561`) | Once the inbox accepts, the Federation Receipt is likely to miss the recipient's acceptance after waiting about 7 s | Probe the route on a running node and send the same credentials as the inbox POST | Inferred |
| Two ODRL builders. `server/routes/permissions.js:19-46` builds a display-only `odrl:Set` with `odrl:read`, while the node receives an `Offer` with `use` and `modify` from `server/adapter/dsp.js:31-55`. | The share response field `odrlPolicy` and `GET /api/permissions/:consignmentId/odrl` show a policy that does not exist on the node (the client reads neither) | Build the preview with `buildOdrlOfferPolicy` or return the node's policy | Verified in code |
| The node's published OpenAPI spec does not match the DSP and catalogue routes the running node mounts | Code written from the spec gets 404s | Probe routes on a running node first ([twin-node-overview.md](twin-node-overview.md#node-quirks-this-repo-compensates-for) lists the known differences, and its configuration section notes that `TWIN_DATASPACE_DATA_PLANE_PATH=dataspace-data-plane`, set in `twin/*/node.env`, does not apply to the inbox), and report the mismatch upstream | Observed on a running instance |
| Consignment vertices carry two UCR alias formats: `ucr` when created in the UI (`server/routes/consignments.js:87`, `:137`) and `urn:moit:ucr` when seeded or replicated (`scripts/seed-twin-nodes.js:334`, `server/ws.js:22`, `twin/dataspace-app.mjs:210`). The demo's readers accept any format containing `ucr` (`server/adapter/docker.js:292`). | Another system that selects vertices by alias format finds only part of the consignments, and the `urn:moit:` prefix ignores `corridor.urnNamespace` | Write one format built from `getUrnNamespace()` | Verified in code |
| `twin/dataspace-app.mjs:45` sets `APP_ID` to a URL on a domain of the original developers (`twin.kchain.solutions`), and that id is advertised as the dataset id. `configs/demo-config.schema.json:3` uses the same domain in the schema `$id`. | Every node advertises an identifier on a domain that people running this repository do not control | Replace `APP_ID` with a neutral URN such as `urn:twin-showcase:corridor-app`, then restart the nodes and reseed, because the node also registers the app under that id (`twin/dataspace-app.mjs:299`). Use a URN such as `urn:twin-showcase:demo-config` for the schema `$id`. | Verified in code |

## Security

The demo is built for a trusted audience on the IOTA testnet. These items have to change before an instance is reachable by people who should not control it. That includes a presenter's laptop: started through npm, the demo servers and the routing proxy listen on all network interfaces (`server/index.js:138`, `server/proxy.js:99`), so everything below is reachable from the local network, while the compose files publish ports on 127.0.0.1 only. The current model is described in [authentication-architecture.md](authentication-architecture.md).

### Demo endpoints hand out node and org credentials

`GET /twin/demo-session`, `GET /twin/demo-orgs` and `GET /twin/openapi.json` (`server/routes/twin-proxy.js:138-179`, `:232-286`) need no login. Together they return the node tenant `x-api-key`, a fresh node JWT (normally the node admin's, `twin-proxy.js:207-211`) with the email and password it was minted with, and every seeded org's TWIN email, password and tenant key. [authentication-architecture.md](authentication-architecture.md#demo-endpoints-that-hand-out-credentials) details what each endpoint returns and in which mode. The `/twin/*` proxy is exempt from the session check (`server/middleware/session.js:86-92`) and forwards every HTTP method on its allow-list (`twin-proxy.js:28-32`). With these credentials any visitor can therefore change the node admin password through `/authentication/password`, which breaks the demo server's own login to its node, and create immutable proofs through `POST /twin/immutable-proof`, each an on-chain write paid by the node wallet.

Next step: remove the three endpoints, or put them behind an opt-in environment flag and a session, drop `password` from the proxy allow-list and forward only `GET` on `/immutable-proof`. On any instance that was reachable with them enabled, run `npm run twin:reseed` to regenerate DIDs, tenant keys and org passwords. Reseed recreates the node admin users with the passwords hardcoded in the source, so changing those needs a code change (see [Plaintext passwords and default secrets](#plaintext-passwords-and-default-secrets)), and each reseed funds a new set of org wallets ([details](#every-reseed-funds-a-fresh-set-of-org-wallets)).

### Authentication without authorisation and open reads

`requireSession` (`server/middleware/session.js:75-104`) protects only `POST`, `PUT`, `PATCH` and `DELETE`, and no route reads the decoded `req.session`. Routes take the acting org from request fields (`creatorOrgId`, `actorOrgId`, `orgId`, `sharerOrgName`) and filter reads by an `orgId` query parameter. Any logged-in user can therefore share, revoke, rename orgs and change finance records on behalf of any org, and anyone, logged in or not, can list every document and download any file (`GET /api/documents/:id/download`, `server/routes/documents.js:361-367`).

Next step: take the acting org from `req.session.orgId`, filter every read by it, require the session on reads except the documented public routes, and add an explicit permission field to the config instead of parsing the free-text `role`. [authentication-architecture.md](authentication-architecture.md) lists the decisions this needs.

### Any visitor can spend the node wallets and the server's memory

Logging in is no barrier: every persona password is `demo`, and the Quick Sign-In list on the login page fills it in. Each DID registration (`POST /api/orgs/:id/register`, `server/routes/orgs.js:99-107`) creates a new DID on the testnet, also for an org that already has one. Each upload (up to 20 MB, `server/routes/documents.js:7`) creates an immutable proof paid by the node wallet and, for provisioned orgs, an attestation NFT paid by the org wallet, and its bytes stay in memory as base64. The only rate limiter is opt-in and covers `/api/login` alone (`server/middleware/security.js:48`), and the proof creation through `/twin` described above needs no login at all. Repeated calls can drain the node wallets, after which every notarization fails, or exhaust the demo server's memory.

Next step: reject registration for an org that already has a DID, rate-limit write routes and uploads per session, cap the stored upload bytes, and alert on the node wallet balances ([details](#no-health-endpoints-structured-logs-or-cluster-manifests)).

### Plaintext passwords and default secrets

[authentication-architecture.md](authentication-architecture.md#secrets-inventory) lists where each secret lives and how it is protected, including the cleartext files that any copy of a working directory carries. These are the defects that need a code or file change:

| Secret | Defect | Next step |
|---|---|---|
| Persona passwords | Plaintext `demo` in every corridor config, compared as plain strings (`server/routes/auth.js:8`) | Hash them, or move login to an identity provider |
| `SESSION_SECRET` and `VERIFY_API_TOKENS` | The defaults written in the source (`server/middleware/session.js:27`, `server/routes/verify-api.js:26`) are accepted in every mode, so an instance that does not set them accepts forged session cookies and the default service token, which the public Swagger page `/api/verify/docs` prints (`verify-api.js:160`) | Refuse to start in docker or hosted mode without them |
| `SESSION_SECRET`, `VERIFY_API_TOKENS` and `RATE_LIMIT_ENABLED` on a deployed instance | `docker-compose.deploy.yml` does not pass them to the demo-server containers, so setting them on the host has no effect ([deployment.md](deployment.md#before-exposing-an-instance-to-the-internet)) | Name all three in the compose file |
| Node admin passwords | Hardcoded in `server/adapter/index.js:72`, `scripts/twin/wallets.mjs:80-83` and `twin/*/bootstrap.env`, printed by `npm run twin:up` (`scripts/twin/up.sh:37-40`), and changed only by editing the code | Read them from a secret store |
| MySQL passwords | `root` and `twin` unless `TWIN_MYSQL_ROOT_PASSWORD` and `TWIN_MYSQL_PASSWORD` are set before the first start (`docker-compose.twin.yml:46-48`) | Require both instead of defaulting |
| Org tenant keys and org passwords | `data/seed-state.json` holds them in cleartext with the default file mode (`scripts/seed-twin-nodes.js:214-218`), while `data/tenant-state.json` uses 0600. They change only through `npm run twin:reseed`, which also re-anchors the nodes and funds new org wallets. | Write the file with mode 0600, and add a rotation that needs no reseed |
| `WALLET_PASSPHRASE` | `npm run twin:wallets:rekey` re-encrypts only the node wallets (`scripts/twin/wallets.mjs:379-397`), so the old passphrase still opens the org wallets in the bundle's `orgWallets` section until a forced provisioning replaces them ([wallet-funding-workflow.md](wallet-funding-workflow.md#passphrase-rotation)) | Make `rekey` re-encrypt `orgWallets` as well |

### The peer WebSocket channel is unauthenticated

Any client that reaches a demo server's port can open `/peer` and send `SHARE_CONSIGNMENT`, `REVOKE_CONSIGNMENT`, `LEDGER_ENTRY` or `ORG_UPDATE` messages, which the server applies without checks (`server/ws.js:58-143`). Browser WebSocket upgrades have no `Origin` check either. Peer messages are parsed with an unguarded `JSON.parse` (`ws.js:52`, `:61`), so a malformed frame throws inside the listener and is likely to stop the process. Binding the compose ports to 127.0.0.1 does not protect `/peer`: the routing proxy forwards every WebSocket upgrade whatever its path (`server/proxy.js:76-97`), so on an instance deployed with `docker-compose.deploy.yml` anyone can open `wss://<host>/peer?node=alpha` through the public URL unless the reverse proxy blocks it.

Evidence: the effect of a malformed frame is inferred.

Next step: reject `/peer` upgrades in `server/proxy.js` and block `/peer` at the reverse proxy, as [deployment.md](deployment.md#before-exposing-an-instance-to-the-internet) recommends. Make the listen address configurable, for example a `HOST` variable that defaults to 127.0.0.1 for the npm scripts, while the containers keep listening on all interfaces because the proxy and the peer reach them over the compose network. Authenticate the `HANDSHAKE` (for example a challenge signed with the node DID, or a shared secret per corridor), drop peer messages from unauthenticated sockets, wrap parsing in `try`/`catch`, and check `Origin` on browser upgrades.

### Public QR links are permanent and guessable

`/verify/:docId` and `/shipment/:id` use the record id as the only credential, with no expiry and no revocation. Seeded ids are built from readable references (`seed-<UCR>` and `seed-<UCR>-<suffix>`, `server/seed.js:58`, `:118`). The public routes are never rate-limited (the limiter is opt-in and covers only `/api/login`, `server/middleware/security.js:48`), and `GET /api/public/verify/:docId` ignores `publicAccess: none` (`server/routes/public-verify.js:34-63`), so anyone holding the id of a document whose type is set to `none` still gets its title, reference, issuer, issuer DID, UCR, hash and proof ids.

Next step: issue signed, expiring tokens for public links (or a node-side grant per holder), rate-limit `/api/public/*`, and apply the `publicAccess` policy on the verify route as well. See [document-verification.md](document-verification.md).

### Smaller security items

| Item | Impact | Next step |
|---|---|---|
| Uploads accept any MIME type (`server/routes/documents.js:7`), and the original file name goes unencoded into `Content-Disposition` (`:365`) | Any logged-in user can store files of any type that other users then download, and a name with quotes or non-ASCII characters can break the download | Allow-list document types and encode the name (RFC 6266 `filename*`) |
| `express.json` accepts 50 MB bodies (`server/index.js:43`), although uploads go through multer | Anyone can make a demo server parse 50 MB JSON bodies in memory, because parsing runs before the session check (`:58`) | Lower the JSON limit |
| CORS reflects any origin with credentials (`server/middleware/security.js:28-33`), and the session cookie has no `Secure` flag (`server/middleware/session.js:57`) | Any website opened in a browser that can reach the demo server can read its API responses, which include every document because reads are open, and the credentials from `/twin/demo-session` and `/twin/demo-orgs`. Without `Secure`, the cookie also travels over plain HTTP. | Restrict CORS to the deployed origin and set `Secure` behind TLS |
| Several routes return the adapter mode and the raw `e.message` in 502 bodies (for example `server/routes/documents.js:273`, `:314`, `:357`) | Node error details reach any caller | Log the detail and return a generic message unless a debug flag is set |
| Request bodies are not validated against a schema | Fields are stored as sent, for example a share records a grant for any `recipientOrgId` string, whether or not that org exists (`server/routes/permissions.js:68-69`) | Add per-route validation |
| Each docker-mode demo server holds the other node's admin login and tenant key to post to its inbox and read its AIG (`server/adapter/index.js:112-120`) | A compromised demo server exposes both nodes, and the layout works only while both servers run from one copy of the code | Once DSP delivery works, remove the other node's admin login and tenant key from `resolvePeers`, so each demo server holds only its own node's credentials |
| `.dockerignore` does not exclude `.env`, and the build stage of the `Dockerfile` copies the whole context | A local image build copies `WALLET_PASSPHRASE` into the build stage and the builder cache, although not into the final image | Add `.env` to `.dockerignore` |

## State and persistence

### Shares do not survive a demo-server restart

On the sender, `hydratePermissionsFromOdrl` (`server/store.js:301-397`) rebuilds grants at boot only from policy uids of the form `urn:moit:policy:<consignmentId>:<orgId>` with `urn:moit:consignment:` and `urn:moit:document:` targets. Shares write `policy:<ns>:<consignmentId>:<orgId>` with `urn:<ns>:...` targets (`server/adapter/dsp.js:31-40`), where `<ns>` defaults to `corridor` and no shipped config overrides it. Every policy is skipped, so after a restart the grants and the policy ids that revoke needs are gone and the policy stays orphaned on the node, while the comment at `server/index.js:118-121` claims the opposite. On the recipient, the grant only ever existed in memory: the replicated vertex survives, the recipient's orgs cannot see the consignment after the restart, and the poll raises a fresh "received" ledger entry and notification for it. Fixing the parser restores only the sender side, because the policy lives on the sender's node.

Evidence: the behaviour after a restart is inferred.

Next step: build the uid and target patterns from `getUrnNamespace()` and add a unit test that feeds `buildOdrlOfferPolicy()` output into `hydratePermissionsFromOdrl()`. For the recipient, persist the received grant (locally, or as the DSP agreement once negotiation exists).

### Most demo-server state is in memory

Each demo server keeps its working state in the `store` object (`server/store.js:79-100`). In docker and hosted mode, consignments (AIG) and ledger entries (AIS) are read back from the node. Permissions, notifications, finance records, the peer channel and every document uploaded during a session (metadata and bytes) are lost on restart, so a consignment created at runtime comes back from the AIG without its documents. A DID registered on the Identity page is lost too, because boot restores org DIDs only from `data/seed-state.json` (`server/store.js:33-44`): the org shows as unregistered again, and registering it once more creates a second DID on the testnet. Uploaded files are written to the node's document management but never read back: downloads serve the in-memory base64 copy (`server/routes/documents.js:361-367`). Because each instance holds its own state, a demo server cannot be replicated behind a load balancer.

Next step: read documents back from the node by `documentManagementId`, and either declare the remaining entities demo-only or move them to a database. Declaring them demo-only costs nothing. If they move, add a repository interface together with the database implementation, not ahead of it.

### The peer channel does not reconnect, and changes made while it is down are lost

The WebSocket peer channel opens only on `POST /api/node/connect` and nothing reopens it after either demo server restarts ([architecture.md](architecture.md) describes the channel). While it is down, nothing is queued or reported: `addLog` skips the `LEDGER_ENTRY` copy for the peer (`server/store.js:116-117`), so ledger entries written in that window never reach the other side.

A revoke issued while the channel is down does not reach the other side either. The UI hides the other demo server's orgs, but `POST /api/permissions/revoke` still accepts them and, with `store.peerOrgs` empty, treats the org as local (`server/routes/permissions.js:190`): it removes only the sender's in-memory grant and skips both the `REVOKE_CONSIGNMENT` message and the DSP revoke that deletes the ODRL policy on the node (`:199`). The recipient keeps access and the policy stays on the node.

`POST /api/node/connect` trusts the `store.peerConnected` flag and answers "Already connected" without checking the sockets (`server/routes/node.js:39-40`). Observed on a running instance: the UI showed "Peer connected" with no link open, until Disconnect followed by Connect cleared it.

Next step: reconnect with a backoff after a close, queue peer messages until the next handshake, reject or queue revokes for orgs of the other node while it is unreachable, and derive the connection state from the sockets rather than a flag.

### The Analytics feed switches between two sources

In docker and hosted mode, `GET /api/ledger` reads only the node's AIS, at most 200 entries across the streams of every earlier server start (`server/routes/ledger.js:16-30`), and none of the entries copied from the peer, which live only in memory (`server/ws.js:79`). Every live `LEDGER_UPDATE` push sends the in-memory log instead (`server/store.js:114-115`): up to 200 AIS entries loaded at boot (`hydrateLedgerFromAis`, `server/store.js:262-283`), this boot's entries and the peer's. The client replaces its list with it (`client/src/context/NodeContext.jsx:48`). The Analytics page therefore shows one history after a reload and another after the first live event, and on either demo server the entries mirrored from the other one are missing until that event.

Next step: write received peer entries to the local AIS (marked with their origin) and push only the new entry instead of the whole in-memory log.

### Proofs can stay on "Writing to ledger"

The node anchors immutable proofs asynchronously, and two pollers pick up the on-chain link. The uploader's browser polls every 4 s for 2 minutes after an upload (`client/src/context/NodeContext.jsx:113-150`). The server's anchor backfill starts at boot only if a document is pending then, polls every 15 s, and stops after 20 minutes or as soon as no document is pending (`server/anchor-backfill.js:34-47`), so an upload made after it stopped has only the browser poll. A proof that anchors outside both windows stays "Writing to ledger" until someone clicks "Verify on ledger now".

Risk (seen on a pre-0.9.0 build, not verified on 0.9.0): a node restart may interrupt pending anchoring and leave a proof without any on-chain receipt. On that build 3 of 15 documents stayed pending after a restart.

Next step: keep the backfill running for documents uploaded after boot, and mark a proof as failed when it has not anchored after a timeout.

### The consignment list costs one node call per consignment

`listConsignments` (`server/adapter/docker.js:286-318`) fetches the vertex list, capped at 500, and then each consignment vertex on its own. It runs on every `GET /api/consignments` and every 5 s in the recipient poll, so node load grows with the number of consignments. Vertices past the first 500, a count that also includes the vertices of stored documents (comment at `:289-290`), would be dropped without notice, both from the list and from the replication guard `findConsignmentVertexIdByUcr` (`:325-332`), which applies the same cap.

Evidence: the truncation is inferred.

Next step: read the needed fields from the list response or batch the reads, and page past 500 in both methods.

## Configuration, tooling and backend structure

### Default corridor differs per entry point

Without `CONFIG_FILE`, the demo server and `npm run twin:seed` load `configs/vietnam-us-customs.json` (`server/config.js:15-17`), while `npm run twin:provision-orgs` (`scripts/twin/wallets.mjs:782-784`) and the deploy compose file (`docker-compose.deploy.yml:27`, `:53`) use `configs/vietnam-us.json`. The seed also logs and records `configs/vietnam-us.json` as its config file while loading the customs one (`scripts/seed-twin-nodes.js:552-560`, `:581`). The defaults work together today only because both corridors use the same org ids. If the seed and the demo server end up on different corridors, the server discards `data/seed-state.json` (`server/seed-state.js:24-27`) and shows every org as unregistered and every seeded document as "Demo mode".

Next step: export one default from `server/config.js` and use it in `wallets.mjs`, the seed and the compose files. Until then, set one `CONFIG_FILE` for every command, as [running-the-demo.md](running-the-demo.md) describes.

### Node data is not partitioned by corridor

Every shipped config uses org ids between `org1` and `org14`, and nothing on the nodes records which corridor wrote a record. `provision-orgs` keys its records by node and org id, and in docker mode the consignment list is every consignment vertex on the node (`listConsignments`, `server/adapter/docker.js:286-318`), shown to the org whose id matches its `creatorOrgId` (`server/routes/consignments.js:21-25`). After a corridor switch without a reset, the new corridor's orgs reuse the previous corridor's DIDs and tenants and see its consignments. [running-the-demo.md](running-the-demo.md#switching-corridors) therefore recommends a full reseed, which costs gas and a new round of org funding.

Next step: tag each vertex with the corridor id (or `corridor.urnNamespace`), filter `listConsignments` and the recipient poll by it, and key org provisioning by corridor as well as org id.

### The config schema is out of date and not enforced

Nothing validates corridor configs against `configs/demo-config.schema.json`. Validated with Ajv 8.20.0 (installed in `node_modules` as a transitive dependency of the `@twin.org` packages), the default `vietnam-us-customs.json` fails with 38 errors, `vietnam-us.json` with 16 and `vietnam-eu.json` with 1, while `cambodia-eu.json` and `adapt-africa.json` pass. The schema does not know `customsDeskRole`, the consignment `customs` and `viewers` blocks, `documentTypes.*.publicAccess` or `dataClassification: "workingDraft"`, rejects the `null` values the configs use, and forbids `corridor.urnNamespace`, which the code reads (`server/config.js:51-53`). It also requires exactly the `alpha` and `beta` keys. In the other direction, the `regulations` and `channels` sections that several configs carry are read by no server, client or script code, so editing them changes nothing. `configs/vietnam-us-customs.json` is generated from `configs/vietnam-us.json` by `scripts/gen-customs-config.py`, and only that script keeps its cross-references consistent.

Next step: update the schema, add a test that validates every `configs/*.json` (declaring `ajv` as a devDependency for it), and add a cross-reference check (org ids exist, dates in order) so hand edits are caught.

### `npm test` writes to the IOTA testnet

`npm test` runs `vitest run` over `tests/**/*.test.js`, which includes `tests/integration/`. `tests/integration/org-attestation.test.js` mints an attestation NFT on the testnet whenever a TWIN node answers on localhost: it does not probe the node first, and runs as soon as `data/tenant-state.json` lists provisioned orgs and an org login succeeds. The other integration suites, which create DIDs, immutable proofs and documents, gate on an unauthenticated `GET /health`, which needs `x-api-key` on these multi-tenant nodes (comment in `scripts/twin/up.sh:19-21`) and returns 401 without it. Those suites therefore always skip, a node that answered `/health` without a key would make them write on every run, and docker mode has no automated coverage. No CI job runs any tests either: the only workflow, `.github/workflows/vietnam-us.yml`, builds the image and deploys. The comment in `vitest.config.js:12-13` calls the integration tests "unaffected".

Evidence: the 401 from `/health` is observed on a running instance.

Next step: move the integration suites behind their own script and include pattern, or behind an explicit opt-in variable, and run the hermetic suite in CI. Until then run only `npx vitest run tests/server` (see [AGENTS.md](../AGENTS.md)), and check docker mode by hand after changes.

### Tests that report less than they appear to

| Item | Impact | Next step |
|---|---|---|
| `tests/integration/adapter-parity-http.test.js:222` runs the "docker" contract suite under `describe.runIf(true)` | With no node it re-runs the simulated adapter and reports passing tests labelled docker | Resolve node reachability before the `describe` blocks and use `skipIf`, so skipped coverage shows as skipped |
| The DID, notarization, docker end-to-end, parity and DSP suites detect a node with an unauthenticated `GET /health` (for example `tests/integration/did-resolvability.test.js:45-47`) | `/health` answers 401 without `x-api-key` on these nodes ([details](#npm-test-writes-to-the-iota-testnet)), so these suites always skip and test nothing | Probe `GET /` or send the tenant key, together with the opt-in proposed above, so the suites run when asked and only then |
| The DSP end-to-end suite in `tests/integration/` (the `*-dsp-e2e.test.js` file) only runs when `POST /catalog/request` does not return 404 (`:44-66`), a route the running node does not mount, and it asserts a string `activityLogId` (`:132`), which the inbox rejection leaves null | The DSP path has no automated coverage (the skip is inferred, not observed) | Probe `/federated-catalogue/request` and assert on `policyId` and `delivered` |
| `tests/helpers/setup.js:28-46` keeps its own router list, without `requireSession` and without the notifications router | The session gate is tested only in isolation against stub routes (`tests/server/session.test.js`), so no route test runs behind it, and the notifications routes have no tests | Build the app in one exported function used by `server/index.js` and the tests, then add tests for `/api/notifications` and for writes without a session against the real routers |
| No unit test for `hydratePermissionsFromOdrl` or for the docker implementation of `dspNotifyDocumentUpload`, and no frontend tests at all | No test catches the restart and write-back defects described above, and frontend changes have no automated check | Add the two unit tests with their fixes. Until component tests exist, check frontend changes manually in the UI. |
| The unit suites call supertest's `request(app)` (about 125 call sites in `tests/server/`), which listens on an ephemeral port on all interfaces (`app.listen(0)`) and connects to `127.0.0.1` | On a machine where other programs listen on loopback ports in the ephemeral range, a request can reach one of them instead of the test app, so a run occasionally fails with a foreign response (`Unauthorized`, a 404, `ECONNRESET`) in a test that passes on the next run. Observed in October 2026 on a developer workstation, about once in ten full runs, on unchanged code | In a shared test helper, start the app on host `127.0.0.1`, wait for `listening` and pass the server to `request()`. Until then, re-run a failed suite, or run it with `--no-file-parallelism` (no failures in repeated serial runs), before investigating |
| `tests/server/adapter.test.js:208-211` asserts that `pipeToTwin` throws with an internal task label in the message | The label cannot be removed from the message without breaking the test | Change the test and the message together |

### Development scripts

`npm run dev` is identical to `npm start`: it builds, then runs both demo servers without the proxy and without hot reload. `npm run dev:client` starts Vite on port 3000, the port TWIN node Alpha uses, and proxies only `/api` to Alpha (`vite.config.js:21-26`). The browser WebSocket and `/twin` are not proxied, so live updates stop while working under Vite.

Next step: move Vite to its default port 5173, proxy `/twin` and the WebSocket upgrade, and make `dev` run the servers under a file watcher.

### `WS_PORT` is a leftover

All WebSocket traffic, browser and peer, shares each server's HTTP port (`server/ws.js:213`). `WS_PORT` and `--ws` (default 4010, `server/store.js:14`) are still parsed and echoed as `wsPort` by `GET /api/node`, and `GET /api/node/discover` computes the peer's HTTP port as the `PEER_URL` port minus 10 (`server/routes/node.js:34-36`). With the npm scripts, the Discover dialog shows `127.0.0.1:3991` on Alpha and `127.0.0.1:3990` on Beta.

Next step: drop `WS_PORT` and report the address taken from `PEER_URL`.

### Setup scripts report success after partial failures

`npm run twin:provision-orgs` and `npm run twin:seed` log a failed org, consignment or document as a warning and still exit 0 with a success line (`scripts/twin/wallets.mjs:931`, `:1012`, `scripts/seed-twin-nodes.js:528`, `:622`), so a half-provisioned or half-seeded corridor looks successful to an operator and to the example deploy pipeline. [running-the-demo.md](running-the-demo.md) describes how to read the logs.

Next step: exit non-zero when any item failed.

### Wallet commands lose results when one node fails

Both wallet commands hold their results in memory until every requested node has finished. `anchor` writes `data/tenant-state.json` only at the end (`scripts/twin/wallets.mjs:1061-1073`), so a failure on Beta discards Alpha's new tenant key, and a rerun creates new DIDs and tenants instead of resuming. `provision-orgs` saves the bundle and `tenant-state.json` only at the end (`wallets.mjs:1008-1010`), so a failure on Beta loses Alpha's org wallets, already funded and created on chain. Within a node, an org that fails after the funding transaction is not recorded at all, mnemonic included, so its funding is stranded (`wallets.mjs:914`, `wallets.mjs:931`). `anchor` also keeps the `orgs` section of an existing `tenant-state.json` (`wallets.mjs:1062-1067`): after a manual volume wipe without `twin:reset`, `provision-orgs` skips those orgs, and the seed's org-signed attestations fail with `Kitsune login failed (401)`. [wallet-funding-workflow.md](wallet-funding-workflow.md#org-provisioning) describes how to recover.

Next step: persist each node's anchor result and each org's encrypted mnemonic as soon as they exist (the mnemonic before the funding transaction), and drop the `orgs` section when an anchor creates new tenants.

### Dead or hazardous scripts and code

| Item | Impact | Next step |
|---|---|---|
| `scripts/twin/reseed.sh:73` expands an empty `SEED_ARGS` array under `set -u` (`scripts/twin/_common.sh:4`), and `scripts/twin/status.sh:56` does the same with `apikey_header` | With bash 3.2, the macOS default, `npm run twin:reseed -- --yes` stops at the seed step with `SEED_ARGS[@]: unbound variable`, after the reset, the anchor and the paid org provisioning have already run. `npm run twin:status` fails the same way for a node that has no API key in `data/tenant-state.json`. | Use `${SEED_ARGS[@]+"${SEED_ARGS[@]}"}`, as `scripts/twin/bootstrap.sh:55` does, in both scripts. Until then pass a seed argument such as `--node=both` ([running-the-demo.md](running-the-demo.md)). |
| `npm run twin:bootstrap -- --legacy` (`scripts/twin/bootstrap-legacy.sh`) | The faucet-funded legacy bootstrap never writes `data/tenant-state.json`, so the demo server has no tenant key for the multi-tenant nodes. It is also the default command of the `twin-bootstrap-alpha` and `twin-bootstrap-beta` compose services (`docker-compose.twin.yml:106`, `:210`), so a `docker compose run` of either service without a command runs it. | Remove the flag and the script, keeping the `twin-bootstrap-*` compose services that the anchor stage reuses, and replace their default command with one that prints a usage hint and exits |
| Encrypted tenant token plumbing: the anchor stage calls a `tenant-token` command that node 0.9.0 does not have (`scripts/twin/wallets.mjs:721-740`), and `TWIN_<NODE>_ENC_TENANT_TOKEN` and `encTenantToken` are passed through `server/adapter/index.js:33-42` and `server/adapter/docker.js:57`, `:545` | A harmless failure line in the anchor log, and code that suggests a live mechanism | Remove end to end |
| `pipeToTwin` in the adapter contract (`server/adapter/base.js:180-182`, `server/adapter/docker.js:667-670`, plus a simulated stub) | No caller. The six-stage pipeline it stands for was never implemented. | Remove from the contract, or implement it |
| Unused client methods `getActivityLog` and `getOdrlPolicy` (`server/twin/kitsune-client.ts:642-645`, `:665-670`), and `/verifiable` in the `/twin` proxy allow-list, for a module that node 0.9.0 does not provide | Dead paths | Remove |
| The Vercel branch in `server/index.js:132-146` (`process.env.VERCEL` skips `listen`, the WebSocket server and the anchor backfill, and the app is exported for a serverless runner) | Dead path: the repository no longer contains a Vercel configuration | Remove |
| `@twin.org/nft-rest-client`, `@twin.org/blob-storage-rest-client` and `@twin.org/notarization-rest-client` are declared in `package.json` but never imported | Install weight only. `@twin.org/dataspace-control-plane-rest-client` is also unused today, and the transfer lifecycle needs it for dataset registration and the transfer calls, not for negotiation. | Remove the first three |
| Deprecated `verified` and `verifiedAt` aliases in the `POST /api/documents/:id/verify` response (`server/routes/documents.js:302-304`, `:352-354`) | The client does not read them, but `tests/server/documents.test.js:113-114` asserts `verified` and `verifiedAt` | Remove them with the test, or keep them with a stated removal date for external callers |

### The adapter contract omits two methods the server depends on

The adapter contract `ITWIN_ADAPTER_METHODS` (`server/adapter/base.js:185-212`) omits `listConsignments` and `findConsignmentVertexIdByUcr`, which `server/ws.js` and `server/routes/consignments.js` call behind `typeof` checks. Only `DockerAdapter` (and `HostedAdapter`, which extends it) implements them, so a new adapter that follows the contract silently loses the node-backed consignment list, the recipient poll and replication de-duplication.

Next step: add the two methods to the adapter contract.

### Backend structure

Several modules mix concerns, which makes the defects above harder to fix and test:

- The document upload route (`server/routes/documents.js:53-249`) runs notarization, org attestation, document storage, the AIG shadow write, the DSP notify and the WebSocket mirror inline in one handler with nested `try`/`catch` blocks, and the share route (`server/routes/permissions.js:64-178`) mixes the WebSocket send with the DSP call.
- The DSP orchestration (share, revoke, trust VC minting, peer clients and cross-node verify, `server/adapter/docker.js:360-665`) lives in the 671-line `DockerAdapter` beside the five adapter domains. Only the message builders are in `server/adapter/dsp.js`.
- `server/store.js` combines CLI parsing and node identity, the in-memory store, ledger shadow writes and the boot-time hydrations.
- `scripts/twin/wallets.mjs` is 1185 lines covering wallet encryption, funding, anchoring and org provisioning.
- The SPA fallback lives in `server/routes/ledger.js:40-43`, which is why `server/index.js:75` must mount that router last.

Next step: extract a document service and a share service with one function per step so each can be unit-tested, move the DSP orchestration into a federation module before building the transfer lifecycle and the trust registry there, move the SPA fallback into `server/index.js`, and split `wallets.mjs` into modules behind the same CLI.

## Deployment and operations

[deployment.md](deployment.md) describes the supported way to deploy an instance.

### The deploy template seeds and runs with different `PUBLIC_BASE_URL` values

Seeded PDFs embed a QR URL built from `PUBLIC_BASE_URL`, and the seed anchors the hash of those bytes. The demo server regenerates the seeded PDFs at boot with its own `PUBLIC_BASE_URL` and keeps the anchored hash (`server/seed.js:120-152`). `deploy/deploy-template.sh` does not export `PUBLIC_BASE_URL`, so its reseed bakes `http://localhost:4002` into the anchored PDFs, while `docker-compose.deploy.yml` passes an empty string to the servers. `server/qr.js:17` keeps an empty string (it uses `??`), so the running servers print relative QR URLs, and downloaded seed PDFs do not match their anchored hash.

Evidence: the hash mismatch on a deployed host is inferred.

Next step: export `PUBLIC_BASE_URL` in the deploy script for both the reseed and the compose run, and treat an empty value as unset in `server/qr.js`.

### Every reseed funds a fresh set of org wallets

`npm run twin:reseed` wipes both nodes, re-anchors them and runs `provision-orgs --force` (`scripts/twin/reseed.sh:69`), and `deploy/deploy-template.sh` runs it on every deploy. The forced provisioning generates and funds a new wallet for every org (`scripts/twin/wallets.mjs:884-914`), 2 IOTA each by default (`ORG_FUNDING_IOTA`), about 28 IOTA for the 14 orgs of the Vietnam corridors, and abandons the previous wallets with their balance. Nothing sweeps them.

Next step: reuse provisioned org wallets across reseeds, or sweep the old balances back to the node wallet before provisioning new ones.

### No health endpoints, structured logs or cluster manifests

The demo servers expose no liveness or readiness route, so Docker or an orchestrator cannot tell a hung process from a working one, and logs are unstructured `console` output. Deployment targets a single host (the image, `docker-compose.deploy.yml` and the deploy script), with TLS left to an external reverse proxy. The repository has no Kubernetes manifests and no resource limits. Nothing watches the node wallet balances either: once a node wallet is empty, every proof and DID registration on that node fails, and refunding from the faucet is a manual step.

Next step: add `/livez` and `/readyz` that report TWIN node reachability and peer status, an alert on low node wallet balances, JSON logs with request ids and credential redaction, and cluster manifests once state is persisted.

### TWIN node memory is unbounded

No node or database container in `docker-compose.twin.yml` has a memory limit. `restart: unless-stopped` is the only recovery, and the compose comments assume a host with at least 16 GB.

Risk (seen on a pre-0.9.0 build, not verified on 0.9.0): if the scheduled `policy-negotiation` task re-fires while negotiations cannot complete, each run clones the node engine without freeing it, at about 80 MB per clone. On that build one node grew from about 210 MB idle to 4.15 GB this way. The signature in the node log is `TaskSchedulerService taskTriggered {"id":"policy-negotiation"}` followed by `engineCloneStart`, every 4 to 5 s in bursts, with resident memory that never falls between bursts. The corridor DataspaceApp is re-instantiated on each engine clone (`twin/dataspace-app.mjs:36-39`), which adds per-clone cost if extension modules are re-imported. The demo starts no negotiations today, so the risk returns with the transfer lifecycle.

Next step: watch node memory once negotiations exist, set a container limit if the growth reproduces, and report it upstream with the log lines above. In the report, ask for the clone to be freed at the end of each `policy-negotiation` run and for retries to back off and stop after a maximum number of attempts, and mention that the telemetry connector is disabled in `twin/*/node.env`, so telemetry is not the cause. A limit trades unbounded growth for restarts, and a restart can interrupt pending proof anchoring ([details](#proofs-can-stay-on-writing-to-ledger)).

### Smaller deployment items

| Item | Impact | Next step |
|---|---|---|
| `provisionOrgUser` derives the node from `localhost:3001` in the node URL (`server/adapter/docker.js:162`) | Under `docker-compose.deploy.yml` or in hosted mode, Beta's org users get `@alpha.demo.local` emails | Use the adapter's `nodeId` |
| The header of `.github/workflows/vietnam-us.yml` (`:19-24`) documents three deploy-script arguments, while the job sends four: corridor, image, repository ref and passphrase (`:120-123`). The header of `deploy/deploy-template.sh` (`:19`) calls the passphrase the third token, while the script reads it as the fourth (`:38`, `:42`). | A workflow or script adapted from the headers passes the arguments in the wrong order | Correct both headers when adapting the pipeline. [deployment.md](deployment.md#arguments-and-the-wallet-passphrase) describes the actual contract. |
| The workflow tags the image as `ghcr.io/${{ github.repository }}` (`.github/workflows/vietnam-us.yml:89-90`, `:123`) | Image references must be lowercase, so in a repository whose owner or name contains capitals the build and push step is likely to fail | Lowercase the repository name in a workflow step before using it as a tag |
| The IOTA network is fixed to the testnet: `twin/*/node.env` sets the testnet endpoints, and `scripts/twin/wallets.mjs` funds and queries wallets on the testnet only (`:58` and its `getFullnodeUrl('testnet')` calls) | A testnet reset invalidates every DID and anchor, and recovery means `twin:reset`, anchor, provisioning and seeding again. A testnet outage stops every on-chain write. Moving to another network needs edits in several places. | Take the network from one setting shared by the node env files, the wallet script and the server |

## Frontend

### The UI reports WebSocket delivery as DSP delivery

When the inbox rejects a share, `dspShareConsignment` still sets `delivered: true` and an acceptance with `observed: true` once it finds the consignment on the recipient's AIG (`server/adapter/docker.js:449-468`), a vertex the recipient wrote after the WebSocket message. `FederationReceipt.jsx` then marks "Delivered over the data space" as done with the text "Pushed the consignment ... through the Dataspace Protocol (DSP)" (`client/src/components/FederationReceipt.jsx:175-177`, `:232-234`), the next step says the recipient ingested it "over the Dataspace Protocol", and the footer calls the share "A real protocol exchange between two independent nodes" (`:264`). The tooltips of the sender's federated pills in the consignment list and detail (`client/src/components/Consignments.jsx:220`, `:277`, `:326`), the "Encrypted sharing" card of the Permissions page (`client/src/components/Permissions.jsx:132`), the recipient's notification bell (`client/src/components/NotificationBell.jsx:105`) and the poll's ledger entry (`server/ws.js:177`) repeat the claim. The Permissions card also says the data is encrypted in transit, although the peer channel uses `ws://` and the demo servers call the nodes over `http://` in every shipped configuration (the npm scripts, `server/adapter/index.js:97`, `docker-compose.deploy.yml:26-30`).

Next step: use `acceptance.observed` to show "received on the recipient's node" without naming a transport, claim DSP only when the inbox POST succeeded, and drop the encryption claim from the Permissions card until the channels use TLS.

### Labels that overstate what was checked

| Where | What the user sees | What is true | Next step |
|---|---|---|---|
| Notarization badge for `verificationSource: 'dsp'` (`client/src/components/NotarizationBadge.jsx:293-294`) | "via a federated DSP query to the peer node" | The check ran on the local node, and no DSP call was made ([details](#cross-node-document-verification-proves-less-than-it-shows)) | Rename the label together with the server value |
| Tooltip of the verify button on peer-anchored documents (`NotarizationBadge.jsx:276-277`) | "cross-node via federated DSP", followed by an internal task label | Same as the row above, and the label refers to an internal tracker that is not public | Reword it with the badge label and remove the task label |
| Ledger line of every full share (`server/routes/permissions.js:85`) | "Access granted via a verifiable ODRL policy" | Also written in simulated mode and for shares within one node, where no policy is created on a node | Write it only when `dspShareConsignment` returned a `policyId` |
| Analytics page subtitle (`client/src/components/LedgerExplorer.jsx:38`) | Every event anchored on "IOTA Mainnet" | Anchors go to the IOTA testnet, and simulated mode anchors nothing | Take the network name from the node's configuration |
| "Organisation signature" block (`NotarizationBadge.jsx:182`) | The org attestation "Proves the org ... endorsed this document" | No code verifies an attestation: the server and scripts make no attestation read or verify call, and the UI only links the attestation on the IOTA Explorer | Verify the attestation through the node before presenting it as proof |

### Finance sharing from Trade Finance writes broken ledger entries

The "Share Finance Access" modal exists twice. `client/src/components/Payments.jsx:116` sends `sharerOrgName` and `targetOrgName`, `client/src/components/TradeFinance.jsx:145` does not, so `server/routes/finance.js:24-25` writes a ledger entry with an undefined actor that reads "shared with undefined".

Next step: extract one modal component that always sends both names.

### The customs dossier state contradicts its documents

`dossierState` (`server/routes/customs.js:50-63`) calls a dossier verified when every document that requires notarization has a proof id, or when the config seeds `customs.dossierVerified: true`. In docker mode the seed notarizes the documents of every consignment, including `VN-2026-EXP-00104` and `VN-2026-EXP-00107`, which `configs/vietnam-us-customs.json` seeds as unverified, so the emailed-PDF case reads "Verified dossier" and the "Today's reality" banner (`client/src/components/CustomsDesk.jsx:269-275`) never shows. In simulated mode seeded documents have no proof, so the checklist marks each required document "No provenance" (`CustomsDesk.jsx:68-93`) while the pill above it says "Verified dossier" for every consignment seeded as verified. [DEMO_GUIDE.md](../DEMO_GUIDE.md) tells presenters how to work around both.

Next step: let the seed skip notarization for consignments seeded with `dossierVerified: false`, and in simulated mode derive the document rows from the same seeded flag as the pill.

### Values that look computed but are fixed

Each of these should either say what it is (illustrative, or a published reference with its source) or be computed.

| Where | What the user sees | What it is |
|---|---|---|
| Dashboard trust score (`client/src/components/Dashboard.jsx:121-129`) | 87, grade A | A constant shown whenever one org on the node is verified |
| Dashboard documents pill (`Dashboard.jsx:187`, `:220`) | `n/6` | The total is hardcoded to 6, while seeded consignments have 5 documents |
| Identity registration (`client/src/components/Identity.jsx:22-65`) | Five steps, including a query to a national business registry | A 700 ms-per-step animation around one rule check (`server/routes/orgs.js`). The registry and licence steps are not real. The DID is then created by `POST /api/orgs/:id/register`, on the testnet in docker mode. |
| Peer credential dialog (`Identity.jsx:431`) | "Ledger hash" | A slice of the DID string |
| Analytics entries (`client/src/components/LedgerExplorer.jsx:88`) and the "Auditable" card of the Permissions page (`client/src/components/Permissions.jsx:133`) | A hash per event, called a cryptographic hash | 16 random bytes from `genHash()` (`server/utils.js:11`, `server/store.js:113`), unrelated to the entry's content |
| Customs Desk export view (`server/routes/customs.js:34-36`) | Channel base rates | Published H1 2024 reference rates hardcoded in the route and shown without source or date |

### Frontend structure

One `DATA_SYNC` message bumps a global `refreshKey`, and every mounted view refetches (`client/src/context/NodeContext.jsx:17`, `:69`). Navigation is component state rather than URLs (only `/verify/*` and `/shipment/*` are routes). The largest components are `Consignments.jsx` (842 lines), `TradeNetworkPanel.jsx` (822) and `TradeFinance.jsx` (758), several modals are hand-rolled instead of using `shared/Modal.jsx`, and only three views use the `useApiResource` hook.

Consignments, the two Trade Finance tabs (`LCTab`, `ContractsTab`) and Payments each re-implement the select-a-row, show-a-side-panel pattern with their own state, and Consignments also scrolls the panel into view (`client/src/components/Consignments.jsx:102`, `:213`, `:266`). `client/src/index.css` is a single 714-line stylesheet in which component rules (`.tn-*`, `.nb-*` and `.fed-*`, about 130 rules) sit next to the `:root` theme variables, with seven media queries spread through the file and no breakpoint variables.

Next step: emit entity-level change events from the single ingestion function proposed above. Extract a shared list-detail hook before splitting the large components, so the extracted parts build on it. Move component rules next to their components and add breakpoint variables: runtime theming keeps working because the corridor config sets only the `:root` variables (`client/src/context/ConfigContext.jsx`). There are no frontend tests, so check each step manually in the UI.

### Smaller frontend items

| Item | Impact | Next step |
|---|---|---|
| Login state lives only in React memory, while the session cookie stays valid for 8 hours (`server/middleware/session.js:21`) | A browser reload during a demo logs the presenter out | Add a session endpoint the client calls on load |
| The Analytics page is named three ways (nav "Analytics", page id `ledger`, component `LedgerExplorer`), and its filters cover none of the `finance`, `payment` and `logistics` ledger types the server writes (`client/src/components/LedgerExplorer.jsx:26-32`) | Those entries appear only under "All Events", and the three names make the page hard to locate in the code | Pick one name and add the missing filters |
| `client/src/App.jsx:77` and `client/src/components/Login.jsx:103` fall back to `/logo.png`, which does not exist, while `client/public/twin-logo.svg` is unused | A broken logo image when the corridor config sets no logo | Point the fallback at `/twin-logo.svg` |
| The network map downloads its topology from `cdn.jsdelivr.net` at runtime (`client/src/components/TradeNetworkPanel.jsx:8`) | The network map stays blank without internet access | Bundle the file for offline demos |
| The 409 body of `GET /api/documents/:id/proof` carries an internal task label in its `supportedIn` field (`server/routes/documents.js:266`) | An internal label reaches API callers | Remove the field |
| The Customs Desk shows a sales line ("This is the competition: email with no provenance", `client/src/components/CustomsDesk.jsx:273`) and hardcodes Vietnam-specific labels (MST, CPTPP) in an otherwise config-driven page | The sales line appears in front of customs audiences, and other corridors would show Vietnamese system names | Drop the sales line and move the labels into the corridor config |
| The upload dialog offers a fixed list of document types (`client/src/components/Consignments.jsx:658`) that does not match the `documentTypes` keys of the configs, for example "Certificate of Origin" against "Export Certificate of Origin" | A document uploaded in the UI under an unmatched type falls back to `publicAccess: verify` (`server/lib/doc-access.js:20-23`) and does not count as a required document in the customs dossier | Build the list from the corridor's `documentTypes` |
| The Vietnam accent `#FF7200` is hardcoded in `Dashboard.jsx`, `shared/Pills.jsx`, `Payments.jsx`, `TradeNetworkPanel.jsx` and component rules of `client/src/index.css` | Corridors with another theme still show orange elements | Use the `--accent` and `--amber` variables |
| The Transport Pass prints "N documents (M verified)" from the in-memory `proofVerified` flag (`server/routes/public-shipment.js:106`), which the seed hydration sets to false | In docker mode M counts only documents verified on that server since it started, so a pass printed right after a restart shows 0 verified | Verify the documents live when printing the pass, as the public verify page does |
| Notifications are one list per demo server, without a recipient org (`server/routes/notifications.js:12-15`) | Every org logged in on that demo server sees, and can acknowledge, the bell entries for shares addressed to other orgs on that demo server | Store the recipient org with each notification and filter by the session's org |

## Corridor features

These are functional gaps in the trade scenario rather than defects.

| Feature | Current state | Next step |
|---|---|---|
| Origin composition per trade agreement | One `OriginComposition` per consignment (`originCompositionFromSeed` in `server/twin/unece.js`) with seeded percentages | A result per agreement (for example CPTPP, EVFTA or a US tariff rule), each with its method, threshold and determination, computed from the input components |
| Data-residency sharing | A share sends the full consignment and document metadata, and the WebSocket peer channel sends the files | A mode in which only hashes, proofs and summaries cross the border, enforced by the ODRL policy. Whether it is needed depends on the target corridor's legal analysis. |
| Per-destination data shaping | Every recipient gets the same view. Forced-labour fields for the US Uyghur Forced Labor Prevention Act (UFLPA) exist only in `vietnam-us.json` and `vietnam-us-customs.json`. | A field profile per destination authority in the corridor config |
| Trade finance | Payments, letters of credit and smart contracts are in memory in every mode, the contract hash is random (`server/routes/finance.js:125`), and the seed's `finance` category only prints a warning. In docker mode the "Smart Contract Deployed" entry with that hash still goes to the node's AIS like any real event (`finance.js:133-134`). | Decide whether to anchor finance records (for example as AIG vertices) or keep them demo-only and label them as simulated |
| Integration with national systems | The customs side is simulated through the verify API and `scripts/customs-system-simulator.mjs`. No decision exists on how a real adaptor is deployed: a separate service, an app inside the TWIN node, or a split. | Decide once the target systems' interfaces (API, webhook or manual upload) and data-residency rules are known. |
| Location identifiers | Every corridor config names ports in free text (for example "Port of Ho Chi Minh City"), and `consignmentToUnece` copies them into the UNECE `departureLocation.identifier` and `arrivalLocation.identifier` (`server/twin/unece.js:187-200`) | Add UN/LOCODE codes to the configs and map them, keeping the names as display text, so the payloads can be matched by other systems |
| Customs corridor data | Only `configs/vietnam-us-customs.json` defines `customsDeskRole`. Customs release is a state of the consignment's `customs` block, not a document type. | Add a release document type if the scenario needs one |

## Misleading code comments

Comments, test names, CLI help text and some log messages carry labels from the original developers' internal tracker and process, which nothing in this repository resolves: task ids (`T-` followed by a number or a short code, sometimes written as `Task` plus a code), phase labels, work-package labels (`WP` followed by a digit), UX finding labels (`UX` followed by a priority code), and references to call notes, slides and reports. Some are user-visible, for example in CLI help (`scripts/twin/wallets.mjs:1131`) and in a seed warning (`scripts/seed-twin-nodes.js:537`). Ignore them.

Several scripts tell the operator to send the wallet addresses to DevOps for funding (for example `scripts/twin/wallets.mjs:323`, `:519` and `scripts/twin/bootstrap.sh:83`). Fund the wallets yourself from the testnet faucet, as [running-the-demo.md](running-the-demo.md) describes. Comments and log lines that name node prereleases (`next.` followed by a number, for example the start-up line of `twin/jsonld-fix.mjs:82`) refer to builds older than 0.9.0, the version that runs.

Some code comments describe behaviour the code does not have. Where a comment and the table below disagree, the right-hand column is what runs.

| Location | The comment says | What the code does |
|---|---|---|
| `server/adapter/docker.js:479-490` | The trust VC minting is "retained, not currently wired", the inbox rejects any bearer, and the encrypted tenant token is the gate | `dspShareConsignment` mints the VC (`:418`) and sends it as the bearer (`:429`). Node 0.9.0 requires it. No tenant token is sent. |
| `server/adapter/docker.js:360-375`, `:388-395` | Share and revoke post to `/dataspace-data-plane/notify` or `/dataspace/notify`, and the inline activity avoids a transfer round trip | `forwardActivity` posts to `POST /dataspace/inbox` (`server/twin/kitsune-client.ts:573`), which on 0.9.0 requires a started transfer |
| `server/twin/kitsune-client.ts:38-46`, `server/adapter/index.js:28-32`, `server/adapter/docker.js:54-57`, `:542-545`, `scripts/twin/wallets.mjs:721-727`, `deploy/deploy-template.sh:16-18` | An encrypted tenant token (`?x-enc-tenant-token=`) gates the DSP inbox and is re-provisioned on reseed | Node 0.9.0 has no command that produces it, and no request carries the token (`kitsune-client.ts:159-168`, `:567-568`) |
| `server/twin/kitsune-client.ts:550-551` | The node config disables the dataspace | `TWIN_DATASPACE_ENABLED=true` in both `twin/*/node.env` |
| `server/adapter/base.js:150-154`, `server/store.js:400-407`, `server/twin/kitsune-client.ts:679-683`, `server/index.js:123-125`, `twin/*/node.env:72-74` | The federated catalogue spans `TWIN_DATASPACE_PEER_NODES` and replaces the WebSocket org directory. `node.env` names `/catalog/request`. | Node 0.9.0 has no such setting, the catalogue is empty, and the route is `/federated-catalogue/request`. Peer orgs come only from WebSocket peer-channel messages. |
| `server/adapter/base.js:130-136`, `:171-176` | The consumer node ingests the revoke and document-upload notifications | Both are posted to the sender's own node without inbox credentials and fail ([details](#revoke-and-document-write-back-notifications-go-to-the-senders-own-node)) |
| `server/adapter/dsp.js:21-23` | Owner-side ingestion of a write-back is gated on `modify` | Nothing checks `modify`, and the DataspaceApp does not ingest document activities ([details](#revoke-and-document-write-back-notifications-go-to-the-senders-own-node)) |
| `server/adapter/base.js:158-167`, `server/adapter/docker.js:610-623` | The first cross-node verify path is a DSP data-plane query to the peer. `:619` cites a "step 7" of `dsp-design.md`. | The first path calls the local node's `verifyImmutableProof`. No DSP call is made, and the cited step does not exist. |
| `server/ws.js:146-158` | Shares arrive over DSP and are ingested by the recipient's node, with no WebSocket channel needed for the file exchange | The WebSocket `SHARE_CONSIGNMENT` handler delivers. The poll only adds vertices missing from memory, typically after a restart or a revoke. |
| `server/twin/kitsune-client.ts:487-488` | The demo uses one AIS stream per node | `ensureAisStream` (`server/store.js:176-205`) creates a new stream each time a demo server starts, and `GET /api/ledger` reads entries across all streams |
| `server/store.js:139-143` | "The blob never rides the wire" | `mirrorDocumentToPeer` sends the full document, `fileBase64` included (`:148-155`) |
| `server/store.js:287-298`, `server/index.js:118-121` | Policies use `urn:moit:policy:...` from `routes/permissions.js`, and boot hydration preserves authorisation across restarts | Node policies come from `buildOdrlOfferPolicy` in `server/adapter/dsp.js` as `policy:<ns>:...`, so hydration restores nothing ([details](#shares-do-not-survive-a-demo-server-restart)) |
| `server/routes/permissions.js:8-12`, `:20-23`, `:132-139` | The share makes no TWIN call, `buildOdrlOfferPolicy` lives in `adapter/docker.js`, and a failed DSP delivery shows up as `federation.error` | The share route also creates a node policy through `dspShareConsignment`. The builder is in `server/adapter/dsp.js`. The in-memory object is a display-only preview. A failed inbox POST is caught and only logged inside `dspShareConsignment` (`server/adapter/docker.js:437-439`), so `federation.error` appears only when the whole call throws (`permissions.js:172-175`). |
| `server/routes/consignments.js:77-81`, `server/adapter/base.js:105-106`, `server/adapter/docker.js:272-274` against `consignments.js:30-34`, `docker.js:280-282` | Each group names a different store as the source of truth | Writes always land in memory, and the AIG write that precedes them is best-effort (a failure does not fail the request). In docker and hosted mode, reads merge the node's AIG list with memory. |
| `server/routes/documents.js:194-196`, `:260-261` | Cross-node verification stays disabled until later work | Cross-node verify is implemented (`:281-315`). Only `GET /api/documents/:id/proof` returns 409 for peer-anchored documents. |
| `client/src/components/NotarizationBadge.jsx:8-14` | Five badge states, "anchored" in orange, "failed" on storage errors | Seven states (`:48-56`). Storage errors do not downgrade the badge (`:23-26`), and "anchored" uses the green palette in `client/src/index.css`. |
| `client/src/components/NotarizationBadge.jsx:109-111`, `:206-208`, `client/src/index.css:385-389` | Verify and the full VC are disabled for peer-anchored documents until later work | The verify button shows for every non-simulated document with a proof (`:269`). Only the full-VC panel is hidden. |
| `twin/dataspace-app.mjs:5-21`, `:140-149` | Activities arrive via `/dataspace/notify`, the sender is `docker.js#buildShareActivity` and wraps the consignment in `object.content`, and the sender uses `DataspaceDataPlaneRestClient.notifyActivity` | The route is `/dataspace/inbox`, the builder is in `server/adapter/dsp.js` and spreads the consignment into `object` (as `twin/dataspace-app.mjs:156-161` says), and the sender uses a plain `fetch`. The consignment handler never runs today, because the inbox rejects every activity ([details](#cross-node-shares-do-not-travel-over-dsp)). |
| `server/adapter/simulated.js:5` | Simulated is the default mode | The default is `docker` (`server/adapter/index.js:66`) |
| `server/adapter/hosted.js:3-6` | Hosted config will come from `TWIN_NODE_URL` | `server/adapter/index.js:84-103` reads `TWIN_ALPHA_URL` and `TWIN_BETA_URL` with the matching `_EMAIL`, `_PASSWORD` and `_API_KEY` |
| `server/adapter/docker.js:667-670` | `pipeToTwin` will be implemented | Nothing calls it. Whether to implement or remove it is open ([details](#dead-or-hazardous-scripts-and-code)). |
| `server/middleware/session.js:3` | Every state-mutating endpoint is reachable without authentication | Writes require the session cookie (`requireSession`) |
| `vitest.config.js:12-13` | Integration tests are unaffected | They run in `npm test` and can write to the testnet when nodes answer ([details](#npm-test-writes-to-the-iota-testnet)) |
| `deploy/deploy-template.sh:31-32` | A host prerequisite is a committed `data/wallets.enc.json` holding funded node wallets | The bundle is not in the repository. Each deploy host creates or copies its own into `<REPO_DIR>/data/` before the first deploy ([deployment.md](deployment.md#host-setup)) |
| `docker-compose.deploy.yml:31-32` | An empty `PUBLIC_BASE_URL` falls back to localhost | `server/qr.js:17` uses `??`, so an empty string produces relative QR URLs |
| `docker-compose.twin.yml:1-17` | Bootstrap with `run --rm twin-bootstrap-*` (faucet funded) and check `/health` without a key | That is the legacy flow. The supported flow is in [running-the-demo.md](running-the-demo.md), and the scripts probe `/` because `/health` needs `x-api-key` in tenant mode (comment in `scripts/twin/up.sh:19-21`, with the 401 observed on a running instance). The bootstrap services' default command is that legacy flow ([details](#dead-or-hazardous-scripts-and-code)). |
| `scripts/seed-twin-nodes.js:13-19`, `:536-541` | `storeDocument` issues the org attestation, and finance seeding waits for adapter routes still to be built | `:423` passes `createAttestation: false` and mints the attestation separately. Finance is in memory by design, and the category only prints a warning. |
| `server/routes/twin-proxy.js:182-186`, `:108` | The demo-session JWT belongs to a registered organisation, not the node admin. The Swagger description of `GET /immutable-proof/{id}/verify` says a verified proof means the document hash "is signed by the org DID". | `pickVerificationIdentity` falls back to the node admin (`:196-212`), which is the normal case once every org has its own tenant. The proof is signed by the node operator's organization identity, not the uploading org ([document-verification.md](document-verification.md)). |
| `scripts/seed-twin-nodes.js:475-480`, `server/routes/orgs.js:112-115` | The seed skips the org attestation silently for an org without a provisioned wallet, and a DID registered in the UI gets a TWIN user so that later attestations are signed by the org | The seed and the upload route attempt the mint for every org with TWIN credentials. For an org whose DID was created through the REST API, which has no wallet mnemonic in the node vault, it fails with `secretNotFound` and is recorded in `orgAttestationError` ([wallet-funding-workflow.md](wallet-funding-workflow.md#org-provisioning)). |
| `scripts/twin/wallets.mjs:466-477` | The mnemonic is visible only inside the container, because the host's `ps` shows just the docker process, inside a runner trust boundary documented in `docs/wallet-funding-workflow.md` | The `--mnemonic=<words>` flag is part of the host's `docker compose run` command line, so the host process list shows it while each anchor command runs. The threat model in [wallet-funding-workflow.md](wallet-funding-workflow.md#threat-model) describes the real exposure. |
| `scripts/twin/wallets.mjs:531-532`, `:745`, `:772-773` | The anchor writes a 0600 env file per command, and provisioning runs `tenant-create` before `identity-create` | No env file is written: the temp directory holds only JSON outputs (and the provisioning script). Provisioning runs `identity-create` first, then `tenant-create --organization-id`, as node 0.9.0 requires (`:843-846`). |
| `scripts/twin/wallets.mjs:1137-1139` (CLI help), `scripts/seed-twin-nodes.js:184-185` (CLI help) | `provision-orgs` needs `--force` after `twin:reset` because the reset leaves stale orgs, and `twin:reseed` chains reset, bootstrap and seed | `twin:reset` deletes `tenant-state.json` (`scripts/twin/reset.sh:98`), so no `--force` is needed. `twin:reseed` also runs `twin:up` and `provision-orgs --force` (`scripts/twin/reseed.sh:64-69`). |
| `scripts/twin/bootstrap.sh:12-13`, `:76-87` | The default `both` stage stops after the accounts step when `WALLET_PASSPHRASE` is unset | The accounts step already fails without a passphrase (`scripts/twin/wallets.mjs:282`), so the stop is never reached |
| `scripts/twin/status.sh:87-92` (printed line) | `wallet funded`, because the faucet funded the wallet during bootstrap | The line only shows that a node DID exists. The supported flow never uses the faucet. `npm run twin:wallets:balance` shows the current balance. |
| `server/twin/compat/index.js:19-20` | Run `npm test` and the org-attestation smoke test after a node upgrade | With nodes running this writes to the testnet, and the docker suites skip ([details](#npm-test-writes-to-the-iota-testnet)), so a passing run says little about the upgrade |
| `server/lib/doc-access.js:6-8` | An invoice is an example of a `content` document | Both configs that set `publicAccess` mark Commercial Invoice as `verify` |
| `server/twin/patched-identity-rest-client.ts:21`, `docker-compose.twin.yml:4`, `deploy/deploy-template.sh:5` | Point to `xroad-twin-adaptor-pattern`, `twin-node-quickstart.md` and `docs/ci-deployment.md` | Those topics are in the node quirks table of [twin-node-overview.md](twin-node-overview.md#node-quirks-this-repo-compensates-for), in [twin-node-overview.md](twin-node-overview.md) and [../twin/README.md](../twin/README.md), and in [deployment.md](deployment.md) |
| `scripts/twin/wallets.mjs:9`, `client/src/components/NotificationBell.jsx:8-9`, the DSP end-to-end test header (`tests/integration/*-dsp-e2e.test.js:30-31`) | Point to a plan file under `.claude/`, a UX spec under `docs/ux/` and a results file under `tests/` | None of them is in this repository |
