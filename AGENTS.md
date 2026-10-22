# Trade Corridor Demo: guide for coding agents

This repo is an interactive demo of a cross-border trade corridor between two parties. Alpha (export side) and Beta (import side) are two instances of the same Express server, each serving the same React single-page app. In docker mode each demo server calls its own TWIN node, a Docker-deployed service stack (image `twinfoundation/twin-node:0.9.0`) that provides DIDs, notarization, document storage, audit trails and access policies (ODRL, the W3C language for usage policies), and records proofs on the IOTA testnet. Everything corridor-specific (organisations, logins, seeded consignments and documents, map, branding, colours) comes from one JSON file in `configs/`, so the code itself is corridor-agnostic. For what a TWIN node offers, see [docs/twin-node-overview.md](docs/twin-node-overview.md).

Terms used below. "Alpha", "Beta" or "demo server" means the Express process (the UI labels them Node Alpha and Node Beta), and "TWIN node" means the Docker service a demo server calls. Each TWIN node is multi-tenant: the node itself and every organisation provisioned by `twin:provision-orgs` get their own tenant, with a DID, a login user and an API key, and every TWIN REST call, login included, carries that key as `x-api-key`. Writes to the IOTA testnet cost gas, paid in testnet IOTA from the node wallets, which `twin:wallets:create` generates into the encrypted bundle `data/wallets.enc.json` (gitignored, never committed) and which are funded from the public testnet faucet. Provisioned organisations get their own wallets, funded from the node wallet.

## Safety rules for agents

- **Running the app.** `npm run demo`, `start` and `dev` run in docker mode unless `ADAPTER_MODE=simulated` is set. When TWIN nodes answer on localhost:3000/3001, boot already creates an audit stream on each TWIN node and appends the seeded ledger entries to it, and UI write actions (DID registration, document upload and notarization, sharing) create records on the TWIN nodes and on the IOTA testnet. When you start the app yourself, use `ADAPTER_MODE=simulated npm run demo` unless the user asks for docker mode.
- **Tests.** Run `npx vitest run tests/server`, or a single file under it. Do not run `npm test`, `npm run test:watch` or anything in `tests/integration` while TWIN nodes answer on localhost:3000/3001. Those suites write DIDs, immutable proofs and an attestation NFT to the IOTA testnet (gas paid from the funded wallets) and create documents and ODRL policies on the TWIN nodes. `org-attestation` runs whenever `data/tenant-state.json` lists orgs and an org login succeeds. The other suites probe `GET /health` first and skip when it fails.
- **TWIN scripts.** Do not run `twin:*` scripts unless the user asks. `twin:bootstrap`, `twin:provision-orgs`, `twin:seed` and `twin:reseed` write on-chain. `twin:reset` and `twin:reseed` destroy TWIN node volumes and state files, and `twin:reset -- --purge-wallets` also deletes the wallet bundle, the only copy of the wallet mnemonics unless the user backed it up, which makes their funds unspendable.
- **Secrets.** Never print, log or commit `WALLET_PASSPHRASE`, `.env`, `data/tenant-state.json` or `data/seed-state.json` (tenant API keys and org passwords in cleartext), or the output of `twin:wallets:reveal`. Nothing under `data/` is committed (`.gitignore` excludes the whole directory): `data/wallets.enc.json` holds the AES-256-GCM encrypted mnemonics of the funded wallets and `data/wallet-addresses.json` their addresses. With a different passphrase, `twin:wallets:create` aborts on an existing bundle. [docs/running-the-demo.md](docs/running-the-demo.md) covers creating and funding the wallets.
- **Obsolete labels.** Code comments, test names, log strings and one API field contain identifiers such as `T-nnn` and phase labels (one integration test file name starts with one) from the original developers' internal tracker, which is not public. Ignore them: nothing in the repo resolves them. Two are matched elsewhere, so change them only together with their consumer: `tests/server/adapter.test.js` expects the task ID in the error that `DockerAdapter.pipeToTwin` throws, and the 409 that `GET /api/documents/:id/proof` returns for a proof notarized on the peer carries one as the value of `supportedIn`.
- **Documents cited in comments but missing.** A few comments point at files that are not in this repository. `docs/ci-deployment.md` (in `deploy/deploy-template.sh`): see [docs/deployment.md](docs/deployment.md). `docs/twin-node-quickstart.md` (in `docker-compose.twin.yml`): see [docs/twin-node-overview.md](docs/twin-node-overview.md) and [twin/README.md](twin/README.md). `xroad-twin-adaptor-pattern` (in `server/twin/patched-identity-rest-client.ts`): see [Inside the docker adapter](docs/architecture.md#inside-the-docker-adapter) in docs/architecture.md. A UX notification spec (in `NotificationBell.jsx`) and a results template (in the DSP integration test) have no replacement: the implemented behaviour is in [docs/dsp-design.md](docs/dsp-design.md). Paths under `.claude/` (in `scripts/twin/wallets.mjs`) belong to that tracker. Section numbers cited in comments may not match the current docs.
- **Stale comments.** Some comments describe superseded behaviour: `server/adapter/docker.js` says the trust credential is "RETAINED, NOT CURRENTLY WIRED" (it is sent), several comments name `/dataspace/notify` (the code posts to `/dataspace/inbox`), `simulated.js` calls itself the default mode, and pre-0.9.0 node versions (`next.48` and similar) are cited throughout. Trust the code. [docs/open-work.md](docs/open-work.md) lists the misleading ones.

## Repo map

```
server/
  index.js             Express entry: middleware, routers, adapter init, WebSocket, listen
  store.js             In-memory store and demo server identity (PORT, NODE_ID, NODE_NAME, PEER_URL)
  config.js            Loads the corridor config (CONFIG_FILE), getConfig()
  ws.js                WebSocket: browser push on any path, peer channel on /peer
  proxy.js             Routing proxy on port 4002, one URL for both sides (plain http, no Express)
  seed.js, seed-state.js  Boot-time seeding from the config, hydration from data/seed-state.json
  anchor-backfill.js   Started at boot: re-polls notarized documents whose on-chain proof is still pending
  qr.js                QR URLs (PUBLIC_BASE_URL) for documents and shipments
  routes/              auth, config, node, orgs, consignments, documents, customs, permissions,
                       finance, notifications, public-verify, public-shipment, verify-api,
                       twin-proxy, ledger (holds the SPA fallback, mounted last)
  middleware/          security.js (helmet, CORS, opt-in login rate limit), session.js (twin_session)
  lib/                 doc-access.js (per document type publicAccess), verification.js (live proof check)
  adapter/             base.js (ITwinAdapter contract), simulated.js, docker.js, hosted.js,
                       dsp.js (ODRL policy and activity builders), index.js (mode selection)
  twin/                TypeScript TWIN REST wrappers (index.ts, kitsune-client.ts,
                       patched-identity-rest-client.ts), compiled to server/twin/dist by build:twin.
                       unece.js (UN/CEFACT consignment mapping) is plain JS
  twin/compat/         Inventory of TWIN node 0.9.0 workarounds (SHIMS) and the node version check
  generators/          pdf-core.js (deterministic PDF bytes), pdf.js, xml.js, transport-pass.js
client/
  index.html           Loads DM Sans and JetBrains Mono from Google Fonts
  public/              Corridor logos (branding.logo), favicon
client/src/
  main.jsx             /verify/* and /shipment/* render the public pages with no providers (no config,
                       theme, node context or login). Everything else renders App inside
                       ToastProvider, ConfigProvider and NodeProvider
  App.jsx              Sidebar navigation held in React state (no router, no deep links)
  context/             ConfigContext.jsx (config and theme variables), NodeContext.jsx (login, WebSocket, polling)
  components/          One file per sidebar page: Dashboard, Network, Consignments, Payments,
                       TradeFinance, Identity, Permissions (label "Access Control"), LedgerExplorer
                       (label "Analytics") and the role-gated CustomsDesk (label Customs Desk,
                       Customs Review or Import Pre-clearance, by customsDeskRole). Plus Login.jsx,
                       widgets and shared/
  pages/               PublicVerify.jsx, PublicShipment.jsx (no login)
  utils/               api.js (REST client for every view), qr.js, format.js
  hooks/, data/        useApiResource.js, countries.js (map placement from config geography)
  index.css            The only stylesheet
configs/               Corridor configs and demo-config.schema.json
docs/                  Documentation, index in docs/README.md
tests/server/          Hermetic unit tests (simulated adapter, supertest)
tests/helpers/         setup.js: createApp() and store reset for the unit tests
tests/integration/     Tests against live TWIN nodes (can write on-chain)
twin/                  TWIN node runtime files: alpha/ and beta/ (node.env, bootstrap.env),
                       node extensions jsonld-fix.mjs and dataspace-app.mjs, README.md
scripts/               seed-twin-nodes.js (twin:seed), twin/ (shell scripts and wallets.mjs behind twin:*),
                       gen-customs-config.py, customs-system-simulator.mjs
deploy/                VM deploy scripts, triggered over SSH by .github/workflows/vietnam-us.yml. Their
                       REPO_URL, REPO_DIR, REPO_BRANCH and SECRETS_FILE are values of an earlier
                       deployment, and each host needs its own wallet bundle in REPO_DIR/data/:
                       edit them before use (docs/deployment.md)
data/                  Gitignored, absent in a fresh clone: the wallet bundle and the secret runtime
                       state written by the twin:* scripts and the seeder
Dockerfile             Two-stage webapp image (npm run build), built by the CI workflow
docker-compose.twin.yml    TWIN nodes and their MySQL databases
docker-compose.deploy.yml  Prebuilt webapp image for a VM deployment
```

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies. Requires Node 24 or later. |
| `npm run build` | Runs `build:twin`, then Vite builds the SPA into `server/public/` (build output). |
| `npm run build:twin` | Compiles `server/twin/*.ts` into `server/twin/dist/` (build output). Needed before anything imports the server, see gotchas. |
| `npm run demo` | Build, then Alpha on 4000, Beta on 4001 and the proxy on 4002. Docker mode unless `ADAPTER_MODE=simulated`. |
| `npm start`, `npm run dev` | Identical: build, then Alpha and Beta without the proxy. No hot reload. |
| `npm run node:alpha`, `node:beta`, `proxy` | One process each, no build step. |
| `npm run dev:client` | Vite with hot reload on port 3000, the same port as TWIN node Alpha, configured in `vite.config.js` (root `client/`). Proxies only `/api` to Alpha, so there are no WebSocket updates and no `/twin` proxy. |
| `npx vitest run tests/server` | Unit tests only, the safe test command. `vitest.config.js` sets `ADAPTER_MODE=simulated` for every test run, overriding the shell value, and `tests/helpers/setup.js` builds the app on the simulated adapter, so these suites make no TWIN calls. A failure with a response the app never sends (`Unauthorized`, `ECONNRESET`) is a known port collision with other local programs: re-run, or add `--no-file-parallelism`, before debugging ([docs/open-work.md](docs/open-work.md#tests-that-report-less-than-they-appear-to)). |
| `npm test` | `vitest run` over all of `tests/`, including `tests/integration`. See the safety rules above. |
| `npm run test:watch` | `vitest` in watch mode over the same scope as `npm test`, integration suites included. Same on-chain risk. |
| `npm run twin:up`, `twin:down` (aliases `twin:start`, `twin:stop`) | Start or stop the TWIN containers. Volumes are kept. |
| `npm run twin:status` | Container status and TWIN node login check. Read-only. |
| `npm run twin:logs [alpha\|beta]` | Follows the container log and does not return. For a bounded read use `docker compose -f docker-compose.twin.yml logs --tail=200 twin-node-alpha`. |
| `npm run twin:wallets:{create,show,balance,reveal,rekey}` | Wallet bundle lifecycle. `reveal` prints the mnemonics. |
| `npm run twin:bootstrap -- --stage=anchor` | The `anchor` stage: creates each TWIN node's DID and node organisation DID on-chain (spends gas), then its tenant and admin user, writes `data/tenant-state.json` and starts the TWIN nodes. |
| `npm run twin:provision-orgs` | For each config org not yet provisioned (all of them with `--force`), creates and funds a wallet, then a DID and a tenant (spends gas). |
| `npm run twin:seed -- --reset-state` | Registers the config's orgs (reusing provisioned tenants), then writes consignments and documents to the TWIN nodes, notarizes each document, mints an org-signed attestation NFT when the issuing org has a wallet, and records `data/seed-state.json`. Finance is not seeded. Always uses the docker adapter. `--dry-run` only prints the plan. |
| `npm run twin:reset` | Destructive: removes TWIN node containers and volumes, `tenant-state.json` and `seed-state.json`. Keeps wallets unless `--purge-wallets`. |
| `npm run twin:reseed` | reset, `anchor`, up, `provision-orgs --force`, seed. A full wipe that funds a fresh wallet for every org with `ORG_FUNDING_IOTA` (default 2 IOTA each) from the node wallet and abandons the previous org wallets with their balance. |

Pass script flags after `--` (`npm run twin:reset -- --yes`), otherwise npm swallows them. `twin:wallets:create`, `reveal` and `rekey` (which also needs `WALLET_PASSPHRASE_OLD`), the `anchor` stage, `twin:provision-orgs` and `twin:reseed` need `WALLET_PASSPHRASE` exported. Always pass a seed argument to `twin:reseed`, for example `npm run twin:reseed -- --yes --node=both`: without one, bash 3.2 (the macOS default) aborts at the seed step with `SEED_ARGS[@]: unbound variable`, after the wipe, the `anchor` stage and org provisioning have already run.

## Run modes and corridor selection

`ADAPTER_MODE` selects the adapter, one value per demo server process. Any other value aborts startup.

| Mode | Behaviour |
|---|---|
| `docker` (default) | REST calls to local TWIN nodes on `http://localhost:3000` (Alpha) and `:3001` (Beta). A TWIN node that is down only produces a warning at boot. Requests fail later. |
| `simulated` | In-memory, synthetic DIDs and proofs, no network. Must be set explicitly: `ADAPTER_MODE=simulated npm run demo`. |
| `hosted` | Docker adapter against remote TWIN nodes. Each demo server needs `TWIN_<NODE>_URL` for its own TWIN node (`TWIN_ALPHA_URL` or `TWIN_BETA_URL`) and rejects localhost URLs. It resolves no peer TWIN node, so a share's inbox post goes to the sender's own TWIN node and only the peer channel carries the share. |

Docker mode needs funded wallets, TWIN node identities created by the `anchor` stage, provisioned orgs and seeded data first. That procedure lives in [docs/running-the-demo.md](docs/running-the-demo.md).

`CONFIG_FILE` (resolved against the current directory) selects the corridor: `adapt-africa`, `cambodia-eu`, `vietnam-eu`, `vietnam-us` or `vietnam-us-customs`. The defaults differ per entry point. The server and `twin:seed` load `configs/vietnam-us-customs.json` (although `twin:seed` logs `configs/vietnam-us.json`), while `twin:provision-orgs` and the compose files use `configs/vietnam-us.json`. Export one `CONFIG_FILE` for provisioning, seeding and the demo. If `twin:seed` and the server load different corridors, the server logs a corridor mismatch, ignores `data/seed-state.json`, and shows orgs as unregistered and documents without proofs.

Only `vietnam-us-customs.json` defines `customsDeskRole`, so the customs desk page appears only with that corridor. It is generated from `vietnam-us.json` by `python3 scripts/gen-customs-config.py`, which overwrites it.

Node code does not load `.env` (there is no dotenv). Export it with `set -a; . ./.env; set +a`. Docker Compose reads `.env` only for `${...}` interpolation. `.env.example` documents the variables.

## Invariants and gotchas

- **Build first.** `server/adapter/docker.js` statically imports `server/twin/dist`, a build output. Until `npm run build:twin` has run (for example on a fresh copy of the code), `node server/index.js`, `twin:seed` and the unit tests fail with `ERR_MODULE_NOT_FOUND` in every mode, simulated included. `npm run demo`, `start` and `dev` build first. Without `server/public/` the SPA fallback answers `404 {"error":"Build first"}`.
- **One port per demo server.** HTTP and WebSocket share the demo server's port. The browser connects on any path, the peer on `/peer`. `--peer` must name the other demo server's HTTP port (`ws://localhost:4001` for Alpha, `ws://localhost:4000` for Beta). `--ws` / `WS_PORT` (default 4010) binds nothing and is only echoed by `GET /api/node`. `GET /api/node/discover` shows the peer as the `PEER_URL` port minus 10 (`127.0.0.1:3991` on Alpha, `127.0.0.1:3990` on Beta). Only the displayed value is wrong.
- **Demo server identity.** Set by `--id` or `NODE_ID`, and only `alpha` and `beta` are supported. Environment variables override CLI flags, so a globally exported `PORT` or `NODE_ID` makes both npm-launched demo servers collide. `?node=` only selects the proxy target.
- **Peering is manual.** The peer channel opens only on `POST /api/node/connect` (the Connect action in Dashboard or Network), which needs a logged-in session. It does not reconnect after a peer restart, and `/peer` itself is unauthenticated. While connected, every ledger entry is mirrored to the peer.
- **Two parties need two browsers.** The proxy picks the demo server from `node=alpha|beta` in the URL, then the HttpOnly `twin-node` cookie, then defaults to Alpha. Cookies are scoped to the host and ignore the port. Behind the proxy, all tabs of one browser therefore share one `twin-node` choice (opening `?node=beta` in a second tab re-routes the first tab's API calls), and on localhost ports 4000 and 4001 share one `twin_session`, so logging out in one tab logs out the other. To simulate two parties, use two browsers or browser profiles, or ports 4000 and 4001 directly.
- **Auth is demo-grade.** Login compares plaintext against config passwords (every shipped config uses `demo`) and sets an HMAC-signed `twin_session` cookie (8 h). The HMAC key is `SESSION_SECRET`, which falls back to a hardcoded default when unset, so set it on any shared instance. `server/middleware/session.js` requires the cookie for every POST/PUT/PATCH/DELETE except `/api/login`, `/api/logout`, `/api/public/*`, `/api/verify/*` and `/twin/*`, so new write routes are covered automatically. The verify endpoints under `/api/verify/*` check an `x-service-token` header against `VERIFY_API_TOKENS` (default `demo-customs-integration`) instead. All GETs are open, including document downloads, and routes trust the org id the client sends. Login state lives in React memory, so a reload returns to the login screen. `GET /twin/demo-session`, `/twin/demo-orgs` and `/twin/openapi.json` are unauthenticated and return the node tenant API key, a fresh JWT and the seeded orgs' TWIN credentials. Alpha, Beta and the proxy listen on all interfaces when started via npm, so anyone who reaches ports 4000-4002 can read every GET route and fetch those credentials. The TWIN nodes publish 3000/3001 on 127.0.0.1 only. Details: [docs/authentication-architecture.md](docs/authentication-architecture.md).
- **Real vs simulated.** In docker and hosted mode, DIDs, notarization (immutable proofs), org attestation NFTs, document storage, consignments (auditable item graph, AIG: a versioned record per consignment), the ledger (auditable item stream, AIS: an append-only log) and ODRL access policies live on the TWIN node. Finance (payments, letters of credit, smart contracts), customs channel logic and registration-number validation are in-memory in every mode. `pipeToTwin` (the six-stage adaptor pipeline) is not implemented: docker and hosted throw "not implemented", simulated returns canned stage results, and no route calls it. Server state is in memory and is rebuilt at boot from the config, the TWIN node and `data/seed-state.json`. Org DIDs are hydrated from that file even in simulated mode when its corridor matches.
- **Cross-node sharing is not DSP end to end.** DSP (Dataspace Protocol) is the connector standard for catalogue, contract negotiation and data transfer that the TWIN node implements. A share creates a real ODRL policy on the owner's TWIN node and posts the activity to the recipient TWIN node's dataspace inbox. Node 0.9.0 rejects that because the demo never opens a DSP transfer between the parties, so the consignment actually travels over the WebSocket peer channel, and the sender confirms receipt by polling the recipient's AIG (a share request blocks for at least 9 s when the consignment does not appear there). Revoke and document-upload notifications reach only the local TWIN node, the federated catalogue is empty, and UI copy such as the federation receipt overstates the DSP part. Contract and gaps: [docs/dsp-design.md](docs/dsp-design.md).
- **TWIN compat layer.** `server/twin/compat/index.js` holds `NODE_COMPAT_VERSION` and `SHIMS`, the single inventory of workarounds for node 0.9.0 (for example the JSON-LD context loader preloaded into the TWIN node as `twin/jsonld-fix.mjs`, the org password policy and the org funding floor). Put new version-specific workarounds there. At boot the server reads the TWIN node version from `GET /` and only warns on drift. To upgrade the TWIN node, bump the image tag of the four node and bootstrap services in `docker-compose.twin.yml`, `NODE_COMPAT_VERSION` and the exact `@twin.org/*` versions in `package.json`, rebuild with `npm run build:twin`, then check each `SHIMS` entry's `removeWhen` condition and delete the shims the new version makes obsolete.
- **TWIN client stack.** The `@twin.org/*` REST clients wrapped by `server/twin/` are pinned to 0.9.0 to match the image. Identity, notarization and the other services run inside the TWIN node, and the only IOTA SDK (`@iota/iota-sdk`) is used by `scripts/twin/wallets.mjs`, not by the server.
- **Deterministic documents.** Seeded PDFs embed a verification QR built from `PUBLIC_BASE_URL` (default `http://localhost:4002`) and `pdf-core.js` emits byte-stable output so that the sha256 notarized at seed time can be recomputed from the served file. Seed and server must run with the same `PUBLIC_BASE_URL`, and any non-determinism in `server/generators/` breaks verification.
- **Config schema is not enforced.** The loader only parses JSON. `vietnam-us`, `vietnam-us-customs` and `vietnam-eu` fail `demo-config.schema.json`, so treat the schema as documentation.
- **Deployment.** The only deploy path is `docker-compose.deploy.yml` with `deploy/deploy-template.sh`, see [docs/deployment.md](docs/deployment.md). The `process.env.VERCEL` branch in `server/index.js` is a leftover with no matching configuration.

## Conventions

- Server code is plain ESM JavaScript. Only `server/twin/` is TypeScript, compiled by `build:twin`.
- Express routers live in `server/routes/` and are mounted in `server/index.js`, before `ledger.js`, which holds the SPA wildcard. Add the matching client call to `client/src/utils/api.js`. Unit tests build the app with `createApp()` in `tests/helpers/setup.js`, which keeps its own router list without `requireSession` and without the notifications router. Register a new router there too, and test session gating against `requireSession` directly, as `tests/server/session.test.js` does.
- New TWIN operations go into the `ITwinAdapter` contract in `server/adapter/base.js` and `ITWIN_ADAPTER_METHODS`, with implementations in `simulated.js` and `docker.js` (`HostedAdapter` extends `DockerAdapter`). `tests/server/adapter.test.js` only checks that every name in `ITWIN_ADAPTER_METHODS` is a function. Both adapters extend `ITwinAdapter`, whose methods all throw "not implemented", so a missing override passes that test and fails at runtime. Add a behaviour test for the simulated implementation of each new method.
- WebSocket messages are JSON objects with a `type` field. The browser and peer message types are listed in [docs/architecture.md](docs/architecture.md).
- Corridor data comes from config: `getConfig()` on the server, `useConfig()` in React, with generic fallbacks in code. Never hardcode corridor names, colours or labels. Existing exceptions are not patterns to copy: Vietnam-specific labels in `CustomsDesk.jsx`, the inline Vietnam orange `#FF7200` in `Dashboard.jsx`, `Payments.jsx`, `TradeNetworkPanel.jsx` (peer-node colour, selection stroke, route arcs) and `shared/Pills.jsx`, and three `index.css` rules outside `:root` (`.tn-dot-peer`, `.tn-arc-swatch`, `.net-org-dot.peer.on`). The navy `#11224E` (`pill-b`) and the success greens are deliberately corridor-independent. There are no frontend tests, so check UI changes with two differently themed corridors, for example the default (orange) and `ADAPTER_MODE=simulated CONFIG_FILE=configs/adapt-africa.json npm run demo` (green).
- React: functional components with hooks, plain JSX (no TypeScript), no router and no component library.
- Styling: one stylesheet, `client/src/index.css`, with `:root` custom properties. `ConfigProvider` overrides `--accent`, `--accent-light`, `--nav-bg`, `--nav-hover`, `--nav-active` and `--amber` from the config's `theme`, so use those for anything corridor-branded. The public pages render outside `ConfigProvider` and keep the `:root` orange defaults. Fonts are DM Sans (`--font`) and JetBrains Mono (`--mono`, for hashes, DIDs and identifiers).

## Frontend UI patterns

The UI is built for live projector presentations to non-technical customs and trade audiences: plain-language labels, an institutional look, details on demand.

- **Layout targets.** Design for a 1920x1080 projector first. `index.css` turns the sidebar into a drawer at `max-width:1023px`. At `max-width:767px` it shows the bottom tab bar (Dashboard, Network, Consignments, the customs page when present, Trade Finance), hides `.desktop-table` in favour of `.mobile-cards`, turns modals into bottom sheets and enforces 44 px touch targets. Give every new table a card variant.
- **Inspectable artefacts.** `NotarizationBadge.jsx` is a compact status pill that expands into a detail panel built from small local primitives: `Block` (title, plain-language hint, body), `KV`, `Mono`, `CopyBtn`, and explorer links opening in a new tab. Reuse this structure for any UI that drills into a verifiable record.
- **Icons and motion.** Icons come from `lucide-react`. `framer-motion` animates the map in `TradeNetworkPanel.jsx` (including the dashed green link between the two demo servers) and the steps of `FederationReceipt.jsx`. Reuse these idioms rather than adding animation libraries.
- **Cross-node cues.** Consignments received from the peer carry a `pill-b` "Shared from" pill naming the origin node, with the lucide `Network` icon (`sharedFromLabel` in `Consignments.jsx`).
- **Map.** `react-simple-maps` in `TradeNetworkPanel.jsx` loads country shapes from cdn.jsdelivr.net at runtime, so the map needs internet access.

## Where to look

| Topic | Code | Docs |
|---|---|---|
| Corridor data, logins, branding | `configs/*.json`, `server/config.js`, `ConfigContext.jsx` | [Run modes and corridor selection](#run-modes-and-corridor-selection), [README.md](README.md) |
| Calls to the TWIN node | `server/adapter/docker.js`, `server/twin/kitsune-client.ts` | [docs/twin-node-overview.md](docs/twin-node-overview.md) |
| Peer channel messages | `server/ws.js`, `server/store.js` | [docs/architecture.md](docs/architecture.md) |
| Share, revoke, DSP | `server/routes/permissions.js`, `server/adapter/dsp.js`, `server/adapter/docker.js` (`dspShareConsignment`), `server/twin/kitsune-client.ts` (`forwardActivity`), `server/ws.js` (recipient poll), `twin/dataspace-app.mjs` | [docs/dsp-design.md](docs/dsp-design.md) |
| Notarization, verification, public QR pages | `server/routes/documents.js`, `server/lib/`, `server/routes/public-*.js`, `server/qr.js`, `client/src/pages/` | [docs/document-verification.md](docs/document-verification.md) |
| System-to-system verify API | `server/routes/verify-api.js` (Swagger at `/api/verify/docs`), `scripts/customs-system-simulator.mjs` | [docs/document-verification.md](docs/document-verification.md) |
| Customs desk | `server/routes/customs.js`, `CustomsDesk.jsx`, `scripts/gen-customs-config.py` | [docs/customs-demo-storytelling.md](docs/customs-demo-storytelling.md) |
| Login and session | `server/routes/auth.js`, `server/middleware/session.js` | [docs/authentication-architecture.md](docs/authentication-architecture.md) |
| Boot seeding and hydration | `server/seed.js`, `server/seed-state.js`, `server/store.js` | [docs/architecture.md](docs/architecture.md) |
| Seeding the TWIN nodes | `scripts/seed-twin-nodes.js` | [docs/running-the-demo.md](docs/running-the-demo.md) |
| Wallets, `anchor` stage, org provisioning | `scripts/twin/wallets.mjs`, `scripts/twin/*.sh` | [docs/wallet-funding-workflow.md](docs/wallet-funding-workflow.md) |
| TWIN containers | `docker-compose.twin.yml`, `twin/` | [twin/README.md](twin/README.md) |
| Deployment | `docker-compose.deploy.yml`, `deploy/`, `Dockerfile`, `.github/workflows/vietnam-us.yml` | [docs/deployment.md](docs/deployment.md) |
| Known gaps and defects | | [docs/open-work.md](docs/open-work.md) |

The full documentation index, with a "start here by role" table, is [docs/README.md](docs/README.md). Presenter click-scripts are in [DEMO_GUIDE.md](DEMO_GUIDE.md).
