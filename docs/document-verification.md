# Document verification and public access

Uploading a trade document in docker or hosted mode anchors a signed proof on the IOTA testnet. This page covers what is anchored, the four ways to verify it, and the no-login QR pages with the per-document-type `publicAccess` policy that limits what they disclose. Gaps called out below are tracked in [open-work.md](open-work.md).

The demo server is this repo's Express backend, one per corridor side (Alpha on port 4000, Beta on 4001, see [architecture.md](architecture.md)), and it sits between the browser and its own TWIN node. An immutable proof is a TWIN node feature: a W3C Verifiable Credential (VC) that the node signs over the hash of a JSON object and anchors on the IOTA ledger.

Everything below describes docker and hosted mode, where a real TWIN node sits behind each demo server. In simulated mode nothing is anchored: proof ids look like `immutable-proof:sim-<id>`, same-side proof checks always return `true`, the UI badge reads "Demo mode" with no Verify button, cross-node checks return `unavailable` and the `/twin` proxy answers 503.

## What an upload anchors

`POST /api/documents` (server/routes/documents.js) runs these steps:

1. Computes the SHA-256 of the attached file and stores it as `hash` (`0x`-prefixed hex). The file is optional: without one, `hash` is a random placeholder, so the proof covers a value that says nothing about any content.
2. Builds a JSON-LD `DigitalDocument` envelope with the document id, title, size, `sha256` (the `hash` value), creation time, `creator` (org name, plus the org DID as `identifier` when the org has one) and `about.identifier` (the consignment's UCR, Unique Consignment Reference). The envelope is saved on the document record.
3. Asks the node for an immutable proof over the envelope (`POST /immutable-proof`). The node returns a proof id (`immutable-proof:<hex>`) immediately and signs and anchors in the background. The signed proof carries `proofIntegrity` (`sha256-<base64>`), the node's hash of the envelope. The demo keeps the envelope itself on its document record, so the chain can be shown without asking the node.
4. If the proof was created and the uploading org has TWIN user credentials, creates a second signature: an attestation over the same envelope made as that org (`createAttestationAs`, TWIN attestation service, minted as an NFT on IOTA). The result is stored as `orgAttestationId` and `orgAttestationExplorerUrl`. A failure only sets `orgAttestationError`.
5. If a file is attached, stores it through TWIN document management. This is independent of the proof: a failure sets `documentStorageError` and the proof still stands.

Who signs the proof is easy to get wrong. The demo server creates proofs with its node admin session (`TWIN_<NODE>_EMAIL`, default `admin@alpha` or `admin@beta`). The anchor stage of the node bootstrap (`npm run twin:bootstrap -- --stage=anchor`, implemented in scripts/twin/wallets.mjs and described in [wallet-funding-workflow.md](wallet-funding-workflow.md#the-anchor-chain)) creates an organization DID for each node (controlled by the node DID), registers the admin user with that DID as both its user and organization identity, and adds to it the `immutable-proof-assertion` verification method (a named public key listed in the DID document) that the node's immutable-proof service signs with. The proof is therefore issued by the node operator's organization identity, which the UI labels "TWIN node admin", and never by the uploading org. For documents uploaded through the app, the uploading org's DID appears only inside the envelope (`creator.identifier`). The org's own signature is the attestation from step 4, made with the `attestation-assertion` method on the org DID. No code in this repo verifies that attestation: the UI only links it on the IOTA Explorer.

Seeded documents are notarized by `npm run twin:seed` (scripts/seed-twin-nodes.js), not by this route. Their envelope has the same shape except that `creator` carries only the org name, with no DID. The attestation, when the seed can make one, is signed by the org in the document's `issuerOrgId` in the corridor config, which defaults to the consignment's creator. No shipped config sets another org there, so a seeded document displayed as issued by a third party (for example the export certificate of origin or the carrier's bill of lading) carries the consignment creator's attestation.

On node 0.9.0 the proof is anchored through the node's notarization connector (`TWIN_NOTARIZATION_CONNECTOR=iota` in twin/alpha/node.env and twin/beta/node.env). The signed proof carries a `notarizationId` of the form `notarization:iota:0x<objectId>`. `normalizeImmutableProof` (server/twin/compat/index.js) derives `receipt.objectId` from it, and the demo builds the Explorer link `https://explorer.iota.org/object/<objectId>?network=testnet`. The normalizer also accepts a proof that carries a `verifiableStorageId` (an anchor in TWIN verifiable storage), but the node configuration in this repo enables no verifiable-storage connector, so expect that field to be null.

```
file bytes      --SHA-256-->                  hash (demo server record, and inside the envelope)
envelope        --hashed by the node-->       proofIntegrity (inside the proof VC)
proofIntegrity  --signed by node org DID-->   proof VC
proof VC        --anchored on IOTA-->         on-chain object (receipt.objectId, Explorer link)
envelope        --signed by uploading org-->  attestation NFT (orgAttestationId), optional
```

One link in this chain is vouched for only by the demo server. Every file check in this repo (the public page and the verify API) compares a file's SHA-256 with the `hash` on the demo server's record, and nothing recomputes `proofIntegrity` from the stored envelope. A verifier who does not trust the demo server has to fetch the proof VC, hash the envelope the way the node does and compare the result with `proofIntegrity`. This repo does not implement that step, and it does not document the canonicalization the node applies before hashing, so building the check needs the TWIN immutable-proof specification or source code.

`verified: true` from the node's `GET /immutable-proof/{id}/verify` is the node's verdict on its own proof. The steps behind it (signature and anchor checks) are internal to the node, and the demo trusts the verdict without re-checking either.

## Verification entry points

| Entry point | Caller | Auth | Check | Code |
|---|---|---|---|---|
| "Verify on ledger now", `POST /api/documents/:id/verify` | logged-in user (document panel, and "Verify" / "Verify all" on the Customs Desk, a view only the vietnam-us-customs corridor has) | `twin_session` cookie | live node check, or the cross-node path for documents anchored on the other side | server/routes/documents.js |
| Page `/verify/:docId`, API `GET /api/public/verify/:docId` | anyone holding the document QR | none | live check plus stored metadata, file hash compared in the browser | server/routes/public-verify.js, client/src/pages/PublicVerify.jsx |
| `POST /api/verify/document`, `GET /api/verify/consignment/:ref` | integrating systems | `x-service-token` header | lookup by hash, id or file, then live check | server/routes/verify-api.js |
| `/twin/*` proxy | integrators who want the node's own API | the node's `x-api-key` and JWT, passed through | the node's verify endpoint, unmodified | server/routes/twin-proxy.js |

The public page and the verify API share `liveVerifyDoc` (server/lib/verification.js). The button route has its own copy of the same logic, plus the receipt refresh and peer re-send described below. The shipment page (`/shipment/:id`) shows each document's stored verification state without a live check. `GET /api/documents/:id/proof` returns the full proof VC of a locally anchored document and, like every GET on the demo server, needs no session.

The first three entry points only see the store of the demo server that answers. A document anchored on Beta and never shared with Alpha is unknown to Alpha (404 on the public API, `verdict: "unknown"` on the verify API).

## "Verify on ledger now"

For a document anchored on this side, the route calls the node's verify, stores `proofVerified` and `lastVerifiedAt`, re-fetches the proof, fills `proofExplorerUrl` if it was missing and refreshes `receipt`. If the receipt now has an `objectId` and the consignment is shared with an org on the other side, it re-sends the document to the peer (`UPLOAD_DOCUMENT` on the WebSocket peer channel, only while that channel is connected) so the peer's copy gains the `objectId` its cross-node check needs. The response contains `proofVerified`, `lastVerifiedAt`, `proofId`, `proofExplorerUrl` and `receipt`, plus the deprecated aliases `verified` and `verifiedAt`. Errors are 404 (unknown document), 400 (no proof) and 502 (node unreachable).

The node finishes signing some time after the upload: 5-15 s according to code comments, and up to about 220 s on a slow testnet according to the comment in server/anchor-backfill.js. Three waits pick up the on-chain reference without a click, each within a limited window. After an upload through the app, the uploader's browser calls this route every 4 s for up to 2 minutes, and only while that page stays open. At boot, if documents are pending, the server starts the anchor backfill (server/anchor-backfill.js), which re-fetches their proofs every 15 s for up to 20 minutes. For seeded documents, `npm run twin:seed` itself waits up to 50 s per proof before recording it. A proof that anchors outside these windows stays on "Writing to ledger" until someone runs this route.

The badge next to each document is computed by `notarizationState()` in client/src/components/NotarizationBadge.jsx, checked in this order:

| Badge | Condition |
|---|---|
| Demo mode | `notarizationMode` is `simulated` or missing |
| Not on ledger | notarization error and no `proofId` |
| On peer ledger / Verified on peer ledger | `notarizationNode` is the other side, without or with `proofVerified` |
| Verified on ledger | Explorer link set and `proofVerified` true |
| On ledger | Explorer link set |
| Writing to ledger | `proofId` set, no Explorer link yet |
| Not on ledger | anything else (no proof) |

## Cross-node verification

A shared document keeps `notarizationNode`, the side whose node anchored it. The local node cannot resolve the other node's proof id, so for such a document the button route, the public page and the verify API all call `verifyCrossNodeProof` (server/adapter/docker.js), which reports a `verificationSource`:

| `verificationSource` | What actually happened |
|---|---|
| `dsp` | The local node's `verifyImmutableProof` accepted the peer's proof id. Despite the label and the code comments, no Dataspace Protocol (DSP) or federated call is made. The local node does not hold the peer's proof, so this path is expected to fail and fall through (inferred from code, not observed). |
| `iota-testnet` | JSON-RPC `iota_getObject` on `https://api.testnet.iota.cafe` returned an object whose id equals `receipt.objectId`. The code would query `https://api.mainnet.iota.cafe` when `receipt.network` is `mainnet`, but a receipt derived from `notarizationId` always says `testnet`. |
| `unavailable` | The local check failed and the record has no `receipt.objectId` to look up, or the RPC call threw. Simulated mode always returns this. |

On success the button route returns 200 with `verificationSource`. Otherwise it returns 409 (`Cross-node verify unavailable`) with whatever source the adapter reported, so an object missing on chain gives 409 with `iota-testnet`. An adapter exception gives 502. The public page and the verify API run the same adapter call through `liveVerifyDoc`, which reports any failure as `verified: null`, and the caller then falls back to the stored `proofVerified` flag.

Read a cross-node success for what it is: an object with that id exists on the ledger. The IOTA check does not read the object's content, does not compare anything with the document hash or envelope and does not check a signature. The `objectId` reaches the recipient over the peer channel, which is unauthenticated, so a crafted receipt pointing at any existing object would pass.

The recipient side has two more gaps. First, the shared document arrives with the sender's `proofVerified` flag (`SHARE_CONSIGNMENT` carries the documents as stored, and a re-sent `UPLOAD_DOCUMENT` merges `proofVerified`), so "Verified on peer ledger" can show before the recipient has checked anything. Because the same stored flag is the fallback when a live cross-node check fails, the recipient's verify API can answer `verdict: "verified"` and its public page can show "Verified" for a document that nobody on that side has checked. Second, the full VC is not available for these documents: `GET /api/documents/:id/proof` returns 409 and the UI hides the "Full on-chain VC" panel. A meaningful cross-node check would need the proof VC from the anchoring node and the on-chain object content, and would compare both with the envelope.

The `objectId` reaches the recipient's copy in two ways: a share made after the proof anchored carries the receipt, provided the recipient does not hold the document yet, and the owner's verify route re-sends it while the peer channel is connected. Re-sharing a consignment does not help, because `SHARE_CONSIGNMENT` skips documents the recipient already holds, although the public verify page suggests a re-share. A document shared before anchoring therefore has no `objectId` on the recipient until someone on the owner side runs the verify route (the button, the Customs Desk or the post-upload browser poller) while the two servers are peered. The anchor backfill does not re-send to the peer.

## Public QR pages

Two kinds of QR code lead to pages the SPA renders without login (client/src/main.jsx picks them by path prefix):

| Page | QR appears on | API called |
|---|---|---|
| `/verify/<docId>` | generated PDFs (seed documents, and the draft import declaration, which is not notarized) and the document panels in the app | `GET /api/public/verify/:docId` |
| `/shipment/<consignmentId>` | the consignment panels in the app and the Transport Pass PDF | `GET /api/public/shipment/:id` |

The URL format is `<base>/verify/<docId>?node=<alpha|beta>#<payload>`, where the payload is base64url JSON `{v, docId, ucr, docType, issuer, node}` (for shipments `{v, id, ucr, exporter, importer, route, node}`). Browsers never send the fragment to a server. The verify page decodes it and shows what the document claims to be (type, issuer, UCR, node) even when the API call fails. Integrity data is deliberately left out of the QR: the QR is printed inside the PDF whose hash gets anchored, so it cannot contain that hash. `?node=` matters only when the URL goes through the routing proxy on port 4002, which uses it to pick Alpha or Beta. QRs drawn in the app use the browser's current origin. QRs printed into generated PDFs use `PUBLIC_BASE_URL` (default `http://localhost:4002`).

Seeded PDFs embed this URL, so the seed and the demo servers must run with the same `PUBLIC_BASE_URL`, otherwise a downloaded seed PDF fails every file check (see [Seed and runtime must agree](deployment.md#seed-and-runtime-must-agree-public_base_url-and-config_file) in deployment.md).

### `/verify/:docId`

`GET /api/public/verify/:docId` runs a live check (same-side, or cross-node as described in [Cross-node verification](#cross-node-verification)) on every request and returns integrity metadata only:

- `document`: id, type, title, reference, format, issue time, issuer, issuer DID, UNECE code, source system, UCR.
- `integrity`: `sha256`, `notarizationMode`, `proofId`, `explorerUrl`, `anchorObjectId`, `verified` and `lastVerifiedAt` (the record's values, which the live check updates first whenever it returns a result), `liveVerified`, `liveError`, `notarizationNode`, `orgAttestationExplorerUrl`.

It never returns the file. Live-check failures are logged on the server and reported to the caller as the fixed string `Live check unavailable`. An id this server does not know returns `404 {"status": "unknown"}`, which the page presents as a possible forgery.

The page also lets the viewer select the file they hold. The browser computes its SHA-256 with `crypto.subtle` and compares it with `integrity.sha256`. Nothing is uploaded.

### `/shipment/:id`

`GET /api/public/shipment/:id` returns a curated border dossier for one consignment, built from the customs pre-clearance view model: parties, route, product, HS (Harmonized System) code, quantity, aggregate customs value, vessel, destination port, declaration facts (number, type, office, channel, release time, electronic certificate of origin, logistics references), origin composition, dossier state, channel and the document list with stored verification state. Finance, payments, ledger entries and unit prices are left out. Each listed document carries `publicAccess`, `contentAvailable` and, for `content` documents with a stored file, a `contentUrl`.

`GET /api/public/shipment/:id/pass` returns the Transport Pass PDF inline: the same curated facts plus the shipment QR, meant to travel with the driver.

`GET /api/public/shipment/:id/document/:docId` returns the file only when the document belongs to that consignment (otherwise 404), its type resolves to `publicAccess: "content"` (otherwise 403 with the effective value) and the server holds the file (otherwise 404). The file comes from the demo server's in-memory store. The route never calls the node.

## The `publicAccess` policy

server/lib/doc-access.js reads `documentTypes[<docType>].publicAccess` from the active corridor config:

| Value | Someone holding the shipment link sees |
|---|---|
| `content` | verification metadata and a "View" link to the file |
| `verify` | verification metadata only |
| `none` | nothing, the document is left out of the shipment dossier |

A missing or unrecognized value counts as `verify`, so a type nobody configured never exposes content on the public routes. Three shipped configs (adapt-africa, cambodia-eu, vietnam-eu) have no `documentTypes` section, so every document is verify-only there. vietnam-us and vietnam-us-customs set Commercial Invoice and Bill of Material to `verify`, and Export Certificate of Origin, Export Declaration, Packing List, Bill of Lading and Inspection Report to `content`. vietnam-us-customs also sets Import Declaration (Draft) to `verify`. The `verify` types are the ones with commercially sensitive detail or unfinished content: line-item prices on the Commercial Invoice, the supplier cost and origin breakdown on the Bill of Material, and the importer's working draft of the declaration.

No shipped type uses `none`. Before relying on the policy, note how it behaves:

- It is keyed by the exact `docType` string. The upload dialog offers a fixed list (client/src/components/Consignments.jsx) that does not always match the config keys. A "Certificate of Origin" uploaded through the UI is not an "Export Certificate of Origin", so it falls back to `verify`.
- `none` only affects the shipment dossier. `GET /api/public/verify/:docId` does not consult the policy and returns the metadata of any document whose id it receives.
- The config is read once at startup, so a change needs a demo server restart. No node-side change is involved.
- For vietnam-us-customs, scripts/gen-customs-config.py copies `documentTypes` from configs/vietnam-us.json and sets only `Import Declaration (Draft)` itself. Edit configs/vietnam-us.json and re-run `python3 scripts/gen-customs-config.py`, which overwrites configs/vietnam-us-customs.json, or edit the customs file directly and accept that the next regeneration overwrites the change.

## Public visibility is a demo-server feature

The TWIN node has no notion of an anonymous reader or a public link. Reading a proof or a document from the node needs a tenant `x-api-key` and a JWT, and access across organizations goes through ODRL (Open Digital Rights Language, a W3C standard) policies and the Dataspace Protocol (see [dsp-design.md](dsp-design.md) and [twin-node-overview.md](twin-node-overview.md)). Without credentials, the only direct check is on the ledger: the Explorer link, or any IOTA RPC endpoint, shows that the anchored object exists. Checking the signature needs the proof VC, which the node serves only to authenticated callers.

The public pages, the `publicAccess` policy and the verify API are built by the demo server from its own in-memory store. They are not bounded by the node's access model: the node would refuse an anonymous read, while the demo server hands out the file. Treat the whole surface as demo-grade:

- The id in the URL is the only credential (a bearer capability), with no expiry and no revocation. Seeded ids are derived from readable references (`seed-<UCR>` for consignments, `seed-<UCR>-<suffix>` for documents, for example `seed-VN-2026-EXP-00101-INV`), so they can be guessed. Only records created in the UI get random ids (16 hex characters).
- `publicAccess` governs only `/api/public/*`. Every GET on the demo server is open, including `GET /api/documents` (all documents when no `orgId` is given), `GET /api/documents/:id/download` (any file, no check) and `GET /api/documents/:id/proof`. For a `verify` document the shipment page withholds the file, but the file is not protected: anyone who knows the document id can download it with `GET /api/documents/:id/download`. Sessions and access rules are covered in [authentication-architecture.md](authentication-architecture.md).

A production design would replace the URL-as-capability with a time-boxed, revocable grant issued on the node (for example an ODRL policy for the holder), fetch content from the node by `documentManagementId`, and keep `publicAccess` as a second filter. [open-work.md](open-work.md#public-qr-links-are-permanent-and-guessable) tracks this, together with rate limiting and applying the policy to the verify route.

## System-to-system verify API

This API serves systems that want verification data without a browser (the demo frames the caller as a customs risk engine). Both endpoints need an `x-service-token` header whose value is listed in `VERIFY_API_TOKENS` (comma-separated, default `demo-customs-integration`), otherwise they return 401. The default token is published in this repo, so set your own in any shared deployment. The OpenAPI spec at `/api/verify/openapi.json` and the Swagger UI at `/api/verify/docs` need no token. `node scripts/customs-system-simulator.mjs --ref VN-2026-EXP-00101` is a ready-made command-line client that plays a customs declaration system calling this API.

`POST /api/verify/document` accepts JSON `{"sha256": "..."}` (a `0x` prefix and upper-case hex are tolerated), JSON `{"docId": "..."}` or a multipart `file`, which the server hashes. It looks the document up in the demo server's store and runs the live check. The response contains `found`, `verdict` and the document's verification fields (`docId`, `docType`, `reference`, `uneceCode`, `issuerName`, `issuerDid`, `ucr`, `sha256`, `anchored`, `verified`, `simulatedProvenance`, `notarizationMode`, `explorerUrl`, `anchoredAt`). `anchoredAt` is the record's timestamp (the upload time, or for seeded documents the ship date), not the time the proof anchored.

| `verdict` | Meaning |
|---|---|
| `verified` | the live check passed or, when it returned no result (node unreachable, or any cross-node failure), the stored `proofVerified` is true |
| `anchored` | the document has a proof id but is not verified |
| `registered` | the demo server knows the document, which has no proof |
| `unknown` | no match on this server (`found: false`, with `queriedHash` echoed back) |

`GET /api/verify/consignment/:ref` takes a UCR or, for consignments with a `customs` block (only configs/vietnam-us-customs.json defines one), the customs declaration number `customs.declarationNo` (for example `304126011890`). The export declaration reference shown in the UI (`exportDeclarationNo`, for example `VN-EXP-2026-00101`) is not matched: the route compares it with a `declRef` field that consignment records do not have, so that lookup returns 404. For a match, the route live-checks the consignment's documents one after the other and returns the per-document results with the dossier state, origin composition and a channel recommendation. The recommendation is an in-memory demo heuristic, and the response states that the decision stays with the customs authority (`decisionOwner`). An unknown reference returns 404.

```bash
# Is this file a registered, anchored document? (the server hashes the upload)
curl -s -X POST http://localhost:4000/api/verify/document \
  -H 'x-service-token: demo-customs-integration' \
  -F file=@./received-invoice.pdf

# Dossier status by UCR (a seeded consignment of the default corridor)
curl -s http://localhost:4000/api/verify/consignment/VN-2026-EXP-00101 \
  -H 'x-service-token: demo-customs-integration'
```

## The `/twin` proxy

`/twin/*` on each demo server (unrelated to the routing proxy on port 4002) is a reverse proxy to that side's TWIN node, for integrators who want the node's own verification API instead of the demo's. It forwards the method, path, query, headers (except `Host` and `Content-Length`) and JSON body, and returns the node's status, headers (including `Set-Cookie`, minus hop-by-hop and encoding headers) and body unchanged. Only JSON request bodies are forwarded. The caller authenticates exactly as against the node: the tenant `x-api-key` on every call, plus a JWT obtained from `POST /twin/authentication/login` (returned as the `access_token` cookie) and sent as `Authorization: Bearer <jwt>`.

| Proxied path | Purpose |
|---|---|
| `/twin/authentication/login`, `logout`, `refresh`, `password` | session handling (the node's admin user-management routes are not proxied) |
| `/twin/immutable-proof/{id}` | full proof VC: issuer, signature, `proofIntegrity`, on-chain reference |
| `/twin/immutable-proof/{id}/verify` | the node's verdict, `{verified, failure}` |
| `/twin/verifiable/*` | allowed, but no service behind it in this node configuration (see below) |

Any other path returns `404 {"error": "Out of scope for this proxy"}`. Simulated mode returns 503 and an unreachable node 502.

Proofs live in the node tenant, the tenant the demo server's admin session belongs to. A session from a per-org tenant (the kind `npm run twin:provision-orgs` creates) logs in successfully but gets `proofNotFound`. Use the node tenant's API key (`TWIN_<NODE>_API_KEY`, or `nodes.<node>.tenantApiKey` in data/tenant-state.json) with a node-tenant user. Tenancy is explained in [twin-node-overview.md](twin-node-overview.md).

The proxy also allows `/verifiable/*`, but the node configuration in this repo does not enable verifiable storage (twin/alpha/node.env and twin/beta/node.env set no `TWIN_VERIFIABLE_STORAGE_CONNECTOR`, and proofs are anchored through the notarization connector), so expect the node to answer 404. This has not been checked against a live node, and the route appears on the Swagger page only if the node's spec publishes it.

`/twin/docs` is a Swagger UI built from the node's own spec (`GET /spec` on the node, fetched with the node tenant key on first use and cached in memory once it loads), filtered to the paths above, with an `x-api-key` scheme added, external schema references replaced by empty schemas (their host returns 404) and request bodies removed from GET operations so "Try it out" works. The operation descriptions the proxy writes into this page say that a verified proof means the document hash "is signed by the org DID", which reads as if the uploading org signed. It did not: the issuer is the node operator's organization identity, as described in [What an upload anchors](#what-an-upload-anchors). Using the page in a demo is covered in [running-the-demo.md](running-the-demo.md).

> Warning: demo-only credential exposure. `/twin/docs` pre-authorizes itself through `GET /twin/demo-session`. That endpoint, `GET /twin/demo-orgs` and `GET /twin/openapi.json` require no login and return the node tenant API key, a fresh JWT together with the email and password that produced it (normally the node admin's), and the TWIN email, password and API key of every org that has TWIN credentials. The proxy also forwards `PUT /authentication/password`, so anyone who reaches the demo server can use that JWT to change the password of its identity, normally the node admin. Do not expose an instance beyond a trusted network without removing or protecting these routes. [authentication-architecture.md](authentication-architecture.md) explains which identity is chosen and lists every secret.

The node-native flow, without the demo shortcut:

```bash
# NODE_TENANT_API_KEY: TWIN_ALPHA_API_KEY if set, otherwise nodes.alpha.tenantApiKey in data/tenant-state.json
# Password: TWIN_ALPHA_PASSWORD if set, otherwise the Alpha admin password in twin/README.md (Admin accounts)

# 1. Log in through the proxy. The JWT comes back as Set-Cookie: access_token=<jwt>
curl -si -X POST http://localhost:4000/twin/authentication/login \
  -H "x-api-key: $NODE_TENANT_API_KEY" -H 'content-type: application/json' \
  -d '{"email":"admin@alpha","password":"<admin password>"}'

JWT='<value of access_token from the Set-Cookie header above>'

# 2. Verify a proof. PROOF_ID is a document's proofId from GET /api/documents
curl -s "http://localhost:4000/twin/immutable-proof/$PROOF_ID/verify" \
  -H "x-api-key: $NODE_TENANT_API_KEY" -H "authorization: Bearer $JWT" \
  -H 'accept: application/json'
```

## Field reference

| Document record field | Meaning |
|---|---|
| `hash` | SHA-256 of the file as `0x` hex (a random placeholder when no file was uploaded) |
| `envelope` | the JSON-LD object the proof covers |
| `proofId` | the node's proof handle, `immutable-proof:<hex>` (`immutable-proof:sim-<id>` in simulated mode) |
| `proofExplorerUrl` | IOTA Explorer link to the anchored object |
| `receipt` | `objectId`, `network`, `epoch`, `digest`, `smartContractId`, `proofIntegrity`, `verifiableStorageId`. A receipt derived from the proof's `notarizationId` has `objectId` set, `network` fixed to `testnet`, and null `epoch`, `digest` and `smartContractId`. `verifiableStorageId` is null with the node configuration in this repo. |
| `proofVerified`, `lastVerifiedAt` | result and time of the last verification on this server, or values copied from the peer (see [Cross-node verification](#cross-node-verification)) |
| `notarizationMode` | `simulated`, `docker` or `hosted` at upload time. null for documents that were never notarized: the draft import declaration, and seeded documents without a matching record in data/seed-state.json (every seeded document in simulated mode). The UI treats null as "Demo mode". |
| `notarizationNode` | the side whose node holds the proof (`alpha` or `beta`) |
| `orgAttestationId`, `orgAttestationExplorerUrl` | the org attestation NFT (the uploading org's, or for seeded documents the consignment creator's) and its Explorer link |
| `documentManagementId` | id of the TWIN document-management record that holds the file |
| `notarizationError`, `documentStorageError`, `orgAttestationError` | failure message of the corresponding upload step |
| `verificationSource` (cross-node verify responses only) | `dsp`, `iota-testnet` or `unavailable`, see [Cross-node verification](#cross-node-verification) |
