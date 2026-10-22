# Running the demo against real TWIN nodes (docker mode)

This is the operator runbook for docker mode: two local TWIN node containers that anchor DIDs, document proofs and attestations on the IOTA testnet, with the two demo servers talking to them over REST. Simulated mode (`ADAPTER_MODE=simulated npm run demo`) needs none of this and is covered in the [README](../README.md). `ADAPTER_MODE` defaults to `docker` (`server/adapter/index.js`), so a bare `npm run demo` already expects the nodes described here. The third mode, `hosted`, points the demo servers at remote nodes through `TWIN_ALPHA_URL` and `TWIN_BETA_URL` and is described in [architecture.md](architecture.md).

Every command below runs from the repository root, in a terminal where `.env` has been loaded (step 2).

## How the stack fits together

| Component | Port (host) | Notes |
|---|---|---|
| Demo server Alpha (export side) | 4000 | HTTP and WebSocket on the same port |
| Demo server Beta (import side) | 4001 | same |
| Routing proxy | 4002 | single URL for both servers, see [Opening Alpha and Beta](#opening-alpha-and-beta) |
| TWIN node Alpha / Beta | 3000 / 3001 | image `twinfoundation/twin-node:0.9.0`, bound to 127.0.0.1 |
| MySQL for node Alpha / Beta | 3306 / 3307 | image `mysql:8.4.7`, bound to 127.0.0.1 |

A TWIN node is a ready-made service. It writes DIDs, immutable proofs (notarizations) and attestation NFTs to the IOTA testnet, and keeps document storage, a consignment graph and access policies off chain, in its own MySQL database and file storage (both in Docker volumes). [twin-node-overview.md](twin-node-overview.md) explains what it offers. The nodes run in multi-tenant mode. A tenant is an isolated partition of users and data on a node, and the tenant API key in the `x-api-key` header, required on every REST call including login, selects it. The anchor stage creates one node tenant per node, which holds the consignments, documents and proofs the demo server creates, and provisioning gives each organisation a tenant of its own. The scripts keep all tenant keys in `data/tenant-state.json`, and most 401 errors in this runbook come from that file being missing or out of date.

Each on-chain write costs gas, paid from a funded wallet. Bringing a corridor (one trade lane, defined by a JSON file in `configs/` with its organisations, consignments and documents) up is a chain of four layers:

| Layer | Command | Reads `CONFIG_FILE` | Writes on chain (paid by) | Local state | Run again |
|---|---|---|---|---|---|
| Wallets | `twin:wallets:create` | no | nothing, works offline | `data/wallets.enc.json`, `data/wallet-addresses.json` (local only, `data/` is gitignored) | to check the passphrase (existing wallets are reused), or after moving the files away to create new ones |
| Anchor stage | `twin:bootstrap -- --stage=anchor` | no | node DID, node organisation DID, 3 verification methods (node wallet) | node volumes, `data/tenant-state.json` (`nodes`) | after every `twin:reset` |
| Provision | `twin:provision-orgs` | yes | a 2 IOTA transfer to each new organisation wallet (node wallet), then each organisation's DID and verification methods (organisation wallet) | `tenant-state.json` (`orgs`), encrypted organisation mnemonics added to `wallets.enc.json` | after the anchor stage |
| Seed | `twin:seed -- --reset-state` | yes | one immutable proof per document (node wallet), one attestation NFT per document signed by the issuing organisation (organisation wallet) | `data/seed-state.json` | after provisioning, and on a corridor change |

The node DID identifies the node itself. The node organisation DID is the identity under which the node issues document proofs, and the node tenant and its admin user are bound to it. A verification method is a public key published in a DID document, against which that DID's signatures are checked. An attestation NFT is minted by the issuing organisation from its own wallet and binds a document to its issuer, which is why only an organisation with a provisioned, funded wallet can produce one.

`data/tenant-state.json` and `data/seed-state.json` are local runtime files that hold tenant API keys and organisation passwords in clear text. Do not share them. `.gitignore` excludes `.env` and the whole `data/` directory, so none of these files is committed.

**One `CONFIG_FILE` for everything.** The demo server and `twin:seed` default to `configs/vietnam-us-customs.json` (the seed's log line prints `configs/vietnam-us.json` even then), while `twin:provision-orgs` defaults to `configs/vietnam-us.json`. The demo server ignores `data/seed-state.json` when the corridor recorded in it differs from the active config, and every document then falls back to the "Demo mode" badge. Set `CONFIG_FILE` once in `.env` and load it in every terminal instead of relying on defaults.

## Prerequisites

- Docker with Compose v2 (`docker compose version` must work), for example Docker Desktop. The TWIN and MySQL containers have no memory limit, and the comments in `docker-compose.twin.yml` assume at least 16 GB for them. On Docker Desktop the bound is the memory set under Settings > Resources, so allocate about 16 GB there, which needs a machine with more than 16 GB of RAM. According to those comments, a node limited to 3 to 5 GB failed requests with `fetchHelper.general` late in a long seed. The seed retries such errors, but retries do not help a node that stays short of memory.
- Node.js 24 or newer with npm (`engines.node` is `>=24`), plus bash and curl, which the `twin:*` scripts use.
- Free local ports 3000, 3001, 3306, 3307, 4000, 4001 and 4002. A local MySQL on 3306 blocks node Alpha's database.
- Internet access to Docker Hub, to the IOTA testnet endpoints under `*.testnet.iota.cafe`, and from the browser to `cdn.jsdelivr.net` (map data on the Network page) and Google Fonts.
- A passphrase of your choice for the wallet bundle, and the time to fund two node wallets from the testnet faucet (step 3). The repository contains no wallets.

## First-time setup

### 1. Install dependencies and build the TWIN client

```bash
npm ci
npm run build:twin
```

`build:twin` compiles the TypeScript REST wrappers in `server/twin/` into `server/twin/dist/`. The seed script and the server import that output in every mode, so on a fresh copy `npm run twin:seed` fails with `ERR_MODULE_NOT_FOUND` until this step has run. `npm run demo` rebuilds it on every start.

### 2. Create `.env` and load it in every terminal

Create `.env` in the repository root with at least these lines. `WALLET_PASSPHRASE` is a passphrase you choose: step 3 encrypts the new wallets with it.

```bash
CONFIG_FILE=configs/vietnam-us-customs.json
ADAPTER_MODE=docker
WALLET_PASSPHRASE='choose-a-strong-passphrase'
```

Then load it, and repeat this in every new terminal before running any command from this runbook:

```bash
set -a; . ./.env; set +a
```

No script in the repository reads `.env` by itself. `set -a` exports every variable the file assigns, so npm, Node and the bash scripts inherit them. Keep the single quotes around the passphrase if it contains shell characters. `CONFIG_FILE` is resolved against the working directory, which is why everything runs from the repository root.

Do not set `PORT`, `NODE_ID`, `NODE_NAME` or `PEER_URL` in `.env`. Environment variables override the per-node flags that `package.json` passes to each demo server, so both servers would get the same value, and a shared `PEER_URL` would point both at the same peer. Docker Compose also reads `.env`, but only to fill `${...}` placeholders in the compose files. `.env.example` describes the other variables.

### 3. Create and fund the node wallets

Each node has one wallet that pays gas for the anchor stage, for funding organisation wallets and for every document proof. The repository contains no wallets, so every installation creates its own: `twin:wallets:create` generates one 24-word mnemonic per node offline, stores both in `data/wallets.enc.json` encrypted with `WALLET_PASSPHRASE` (AES-256-GCM), and writes the addresses to `data/wallet-addresses.json`. Bundle format, passphrase rotation (`twin:wallets:rekey`) and the threat model are in [wallet-funding-workflow.md](wallet-funding-workflow.md).

```bash
npm run twin:wallets:create -- --node=both    # offline: prints "new wallet generated" for alpha and beta
npm run twin:wallets:show -- --node=both      # prints the two addresses
```

Fund each address at https://faucet.testnet.iota.cafe and repeat `npm run twin:wallets:balance -- --node=both` until Alpha holds well over 20 IOTA and Beta well over 8 IOTA for the Vietnam corridors (see "How much is enough" below). The anchor stage rejects only a zero balance, so a wallet with a few IOTA passes the anchor stage and then fails during provisioning.

Running `create` again with the same passphrase generates nothing and prints `reusing existing wallet`, which makes it a quick passphrase check. With another passphrase it stops with `existing record present but decrypt failed`. Keep the passphrase in a password manager and a copy of both wallet files outside the working tree: without either, the funds stay on chain but cannot be spent. `git clean -x` deletes `data/` as well.

**How much is enough.** Each organisation that provisioning handles gets a fresh wallet funded with `ORG_FUNDING_IOTA` (default 2 IOTA) from the node wallet. That is every organisation on a first run, with `--force` and in every `twin:reseed`: 20 IOTA from Alpha for its 10 organisations and 8 IOTA from Beta for its 4 in the Vietnam corridors, plus gas for the funding transaction. More than 1 IOTA per organisation is required because every on-chain operation reserves a 1 IOTA gas budget, although a full organisation setup actually spends about 0.03 IOTA. Organisation wallets from earlier runs keep their leftover balance and nothing sweeps it back. The anchor stage and each document proof also cost gas, and so do actions in the running demo (DID registration, document uploads). Check the balances before each demo, and before a run that funds organisations make sure each node wallet holds a few IOTA more than the funding it will send.

### 4. Optional: pull the images in advance

```bash
docker pull twinfoundation/twin-node:0.9.0
docker pull mysql:8.4.7
```

The two images take about 4 GB on disk (roughly 2.8 GB and 1.1 GB as listed by `docker image ls`). The download itself is under 1 GB, because the layers are compressed. Without this step the anchor stage pulls them on first use.

### 5. Start from a clean stack

> Warning: destructive. Run it only when you mean to discard the current node state.

```bash
npm run twin:reset -- --yes
```

It removes every container named `twin-showcase-*`, the volumes `twin-showcase_mysql_data_alpha`, `twin-showcase_mysql_data_beta` (node databases), `twin-showcase_twin_data_alpha` and `twin-showcase_twin_data_beta` (node engine state and file storage), the network `twin-showcase_default`, and the files `data/tenant-state.json` and `data/seed-state.json`. It keeps the wallet bundle. Nothing on chain is deleted: DIDs anchored earlier simply become orphaned. On a machine that never ran the stack there is nothing to remove. On a machine with older volumes it prevents the "Unknown database 'twin'" and 401 failures described in [Troubleshooting](#troubleshooting). Without `--yes` it asks you to type `yes`.

### 6. Anchor the nodes

```bash
npm run twin:bootstrap -- --stage=anchor
```

For each node the anchor stage checks that the wallet balance is not zero, starts MySQL, and then runs about a dozen TWIN node CLI commands, each in a throwaway container: the node DID and the node organisation DID (both derived from the wallet mnemonic), the signing and encryption keys in the node vault, three verification methods, a tenant with its API key, and the admin user (`admin@alpha`, `admin@beta`). It writes `data/tenant-state.json` and finally starts the node runtime and waits for it on port 3000 or 3001. The full command chain and the reasons for its order are in [wallet-funding-workflow.md](wallet-funding-workflow.md).

If the anchor stage fails partway, for example because Beta's wallet has no balance after Alpha has completed, do not just run it again. `data/tenant-state.json` is written only after every node succeeds, so no tenant key has been saved, and a second run creates new DIDs and another tenant on top of the partial state. Run `npm run twin:reset -- --yes`, fix the cause, then run the anchor stage again. The gas already spent is lost.

Do not run `npm run twin:up` before the anchor stage has run once. Without the engine state that the anchor stage creates, the node container exits at start and Docker restarts it in a loop.

### 7. Check the nodes

```bash
npm run twin:status
```

For each node, expect a `/` line with `200 OK`, a `/login` line with `200 (admin user ready)` and a `node DID` line with `did:iota:testnet:0x...`, followed by an IOTA Explorer link. The login check sends the tenant API key from `data/tenant-state.json`.

### 8. Provision the corridor's organisations

```bash
npm run twin:provision-orgs
```

For every organisation in `CONFIG_FILE` that has no entry in `data/tenant-state.json`, the script generates a wallet, funds all new wallets of a node in one multi-output transaction from the node wallet, and then, in one container run per node, creates the organisation DID from the organisation's own mnemonic, a tenant for the organisation, three verification methods, a vault key and a user. An organisation set up this way can sign the attestation NFT of its own documents. Organisations without it get a wallet-less DID through REST during seeding, which cannot mint, so their documents carry only the node-signed proof.

The command is idempotent: a second run retries only the organisations that did not complete. `--force` re-provisions all of them, which funds a new set of wallets. For the customs corridor it provisions 14 organisations (10 on Alpha, 4 on Beta).

### 9. Seed the corridor data

```bash
npm run twin:seed -- --reset-state
```

`--reset-state` deletes `data/seed-state.json` first. That file is only local bookkeeping, so on-chain records stay. For each node the seed registers the organisations (reusing the provisioned DIDs and tenants), creates one graph vertex per consignment, and for each document generates the PDF or XML from the config templates, stores it on the node, creates an immutable proof, waits up to 50 s for the proof to be anchored, and mints the issuing organisation's attestation. It always talks to the nodes on `TWIN_ALPHA_URL` / `TWIN_BETA_URL` (default localhost 3000 and 3001), whatever `ADAPTER_MODE` says. Without `--reset-state` it resumes and skips items already recorded for the same corridor.

Two warnings are normal: `proof ... not anchored within 50s` (the demo fills in the on-chain reference later, see step 11) and `retry N/2 after ...` (the storage, proof and attestation calls are tried up to 3 times with a growing pause). `--node=alpha|beta|both` and `--only=identity,consignments,documents` limit the run, and `--max-consignments=N` and `--max-docs=N` cap it. By default nothing is capped. A consignment or document left out by a cap still appears in the demo, with the "Demo mode" badge on its documents. `npm run twin:seed -- --help` lists the remaining options (throttle, dry run, force).

Both the seed and the provisioning exit with status 0 and a success line (`seed complete`, `provision-orgs complete`) even when single items failed. Check the seed's summary line for each node and category, for example `[alpha/documents] done (30 created, 0 skipped, 0 errored)`, and look for `proof=FAILED` or `orgAtt=FAILED` in the document lines, because such documents still count as created. For provisioning, look for `did not complete (no done marker)` warnings. A provisioning rerun retries only the incomplete organisations. A seed run without `--reset-state` retries the errored items, but not documents already stored with a failed proof, which need a new run with `--reset-state`.

### 10. Start the demo

```bash
npm run demo
```

This builds the client and the TWIN wrappers, then starts Alpha, Beta and the proxy in one terminal. The boot log of each server shows `Adapter mode: docker -> http://localhost:3000` (or 3001), `Adapter authenticated`, and `Hydrated ...` lines that count the organisations, consignments and documents taken from `data/seed-state.json`. For the customs corridor Alpha should report 10 organisations, 6 consignments and 30 documents. A `corridor mismatch ... ignoring seed-state.json` warning means `CONFIG_FILE` differs from the one used for seeding.

### 11. Open Alpha and Beta, log in and connect

Follow [Opening Alpha and Beta](#opening-alpha-and-beta). If a seeded document still shows "Writing to ledger", the node had not finished signing its proof within the seed's 50 s window. Each demo server re-checks such documents every 15 s for 20 minutes after boot, and the "Verify on ledger now" button in the document panel checks immediately and stores the explorer link. What "verified" means and the other verification paths are covered in [document-verification.md](document-verification.md).

## Opening Alpha and Beta

Open http://localhost:4002/?node=alpha in one browser and http://localhost:4002/?node=beta in a different browser or a separate browser profile. The proxy on 4002 sends a request to Alpha or Beta according to `?node=` in the URL and otherwise according to an HttpOnly `twin-node` cookie that it sets whenever it sees `?node=`, with Alpha as the default. The app's own API calls carry no `?node=`, so they follow the cookie, and within one browser the cookie holds whichever node was opened last. A second tab in the same browser therefore silently re-routes the first one. Any link that carries `?node=`, including the QR verification links, re-points the cookie in the same way.

The alternative is to open http://localhost:4000 (Alpha) and http://localhost:4001 (Beta) directly, which bypasses the proxy. That also works in a single browser. Cookies are not port-specific, so both servers see the same `twin_session` cookie, and that does no harm because both sign it with the same `SESSION_SECRET` and only check that it is valid, not which server or organisation issued it. Signing out on one port clears the shared cookie for both, so the other tab's next change fails with 401 until you sign in there again.

Log in with any organisation of that node. The Quick Sign-In list shows all of them, and clicking one only fills in the form, so press Sign In afterwards. Every password in the shipped configs is `demo`, and [DEMO_GUIDE.md](../DEMO_GUIDE.md) has the persona table. The login lives in browser memory only, so a page reload returns to the login screen.

Peering between the two demo servers is not automatic. After logging in, click Connect in the Node Status card on the Dashboard (or Connect to peer on the Network page), then Connect next to the peer in the Discover dialog. One side is enough: the peer channel is a single WebSocket from that server to the other's `/peer` path, and both sides then list the peer's organisations. It does not reconnect by itself, so connect again after restarting either demo server. The address shown in the Discover dialog (`127.0.0.1:3991` or `127.0.0.1:3990`) is a cosmetic leftover, and the connection really goes to `ws://localhost:4001/peer` or `ws://localhost:4000/peer`. Cross-node sharing travels over this channel, because the node's dataspace (DSP) inbox rejects a delivery unless a DSP transfer between the two parties is already running, and the demo does not set one up ([dsp-design.md](dsp-design.md)).

## Daily restart

```bash
set -a; . ./.env; set +a
npm run twin:up      # starts both MySQL containers and both nodes, waits up to 60 s per node
npm run demo
```

Then log in on both sides and press Connect again. No anchor stage, provisioning or seed is needed: DIDs, tenants and seeded data live in the Docker volumes and in `data/`. After a reboot Docker may already have restarted the containers (restart policy `unless-stopped`), in which case `twin:up` only confirms they answer.

A demo server restart resets what the server holds in memory. Seeded consignments and documents are rebuilt from the config and `data/seed-state.json`, and consignments created during a session come back from the node's graph. Documents uploaded, finance records and notifications created during a session are gone. Shares made during a session are not restored either: their access policies stay on the node, but the boot-time reload (`hydratePermissionsFromOdrl` in `server/store.js`) only recognises `urn:moit:policy:` identifiers, while the share code writes `policy:<namespace>:...`. [open-work.md](open-work.md) tracks these gaps.

## Stopping and resetting

| Goal | Command | Effect |
|---|---|---|
| Stop the demo servers | Ctrl+C in the `npm run demo` terminal | Frees ports 4000 to 4002 and drops the servers' in-memory state. The nodes keep running. |
| Stop the nodes, keep their data | `npm run twin:down` | Removes the containers and network, keeps the volumes. `twin:up` resumes with the same DIDs and data. |
| Wipe the node state, keep the wallets | `npm run twin:reset` (add `-- --yes` to skip the prompt) | Destructive, see [step 5](#5-start-from-a-clean-stack). Continue with the anchor stage, provisioning and seed (steps 6 to 9). |
| Also delete the wallets | `npm run twin:reset -- --purge-wallets` | Also deletes `data/wallets.enc.json`, `data/wallet-addresses.json` and `data/.wallets.lock`. The funds stay on chain, but nobody can spend them without another copy of the bundle and its passphrase, so copy both files out of `data/` first if you may need them. After a purge, create and fund new wallets ([step 3](#3-create-and-fund-the-node-wallets)), then continue with step 6. |

### Full reset and reseed in one command

```bash
npm run twin:reseed -- --yes --node=both
npm run demo
```

`twin:reseed` (`scripts/twin/reseed.sh`) runs `twin:reset` (wallets kept), the anchor stage, `twin:up`, `twin:provision-orgs --force` and `twin:seed --reset-state`, passing any extra arguments to the seed. It needs `WALLET_PASSPHRASE`, uses the loaded `CONFIG_FILE`, and spends gas for new DIDs plus 2 IOTA per organisation (28 IOTA for the 14 organisations of the Vietnam corridors), while the previous organisation wallets keep their balance. Always pass at least one seed argument such as `--node=both` (the default anyway): the script runs under `set -u`, and with no extra argument bash 3.2, the macOS default, aborts at the seed step with `SEED_ARGS[@]: unbound variable`. Without `--yes` it asks for confirmation.

## Switching corridors

The corridor configs are the JSON files in `configs/`. Change `CONFIG_FILE` in `.env`, reload it in every terminal and stop the demo servers, then choose one of two paths.

**Clean switch (recommended before an audience).** `npm run twin:reseed -- --yes --node=both`, then `npm run demo`. The nodes hold only the new corridor's data, at the cost of a new anchor stage run and a new round of organisation funding.

**Quick switch.** Keep the nodes running, because the seed calls their REST API:

```bash
npm run twin:provision-orgs
npm run twin:seed -- --reset-state
npm run demo
```

This saves gas but mixes data. `provision-orgs` keys its records by node and organisation id only, and every shipped config uses ids between `org1` and `org14`, so it usually provisions nothing and the new corridor's organisations reuse the previous corridor's DIDs and tenants. The previous corridor's consignments also stay in the nodes' graphs, and in docker mode the consignment list is read from the node (`server/adapter/docker.js`, `listConsignments`), so an organisation still sees consignments created under the same id in the old corridor. Use the clean switch when that matters.

## Customs corridor specifics

`configs/vietnam-us-customs.json` is the default corridor and the only shipped config that gives organisations a `customsDeskRole`, so it is the only one with the customs views: Customs Desk for `vncustoms` on Alpha, and on Beta Customs Review for `uscustoms` and `eucustoms` and Import Pre-clearance for `northpeak` and `northpeakeu`. [DEMO_GUIDE.md](../DEMO_GUIDE.md) has the click-level customs script, which uses `vncustoms`, `uscustoms` and `northpeak`, and [customs-demo-storytelling.md](customs-demo-storytelling.md) the narrative.

Provisioning covers 14 organisations. The seed creates 6 consignments with 5 documents each (30 documents, each with its on-chain proof) on Alpha. Beta has no consignments in this config, so its seed only registers its 4 organisations, and data reaches Beta when it is shared during the demo. Do not cap this seed with `--max-consignments`: the customs story uses the fourth to sixth consignments (`VN-2026-EXP-00103`, `-00104`, `-00107`).

To show a system-to-system check the way a customs declaration system would call it, run this against Alpha while the demo is up:

```bash
node scripts/customs-system-simulator.mjs --ref VN-2026-EXP-00101
```

It calls `GET /api/verify/consignment/<ref>` on `http://localhost:4000` with the header `x-service-token: demo-customs-integration` and prints per-document verification and a channel recommendation. Other refs are `VN-2026-EXP-00102`, `-E001`, `-00103`, `-00104`, `-00107` or the 12-digit declaration number of each consignment (`customs.declarationNo` in the config, for example `304126011890` for `VN-2026-EXP-00101`). `--base` and `--token` override the defaults. The API itself is described in [document-verification.md](document-verification.md).

## Exposing the demo through a tunnel

The proxy's startup message suggests `cloudflared tunnel --url http://localhost:4002` or `npx localtunnel --port 4002`. Set `PUBLIC_BASE_URL=https://<tunnel-host>` in `.env` before seeding and keep it for the demo servers. The value is printed into the QR codes inside every generated PDF, so the PDF bytes and their anchored SHA-256 depend on it. Changing it after seeding requires a new seed. A quick tunnel started with `cloudflared tunnel --url` or `npx localtunnel` gets a new random hostname on every start by default, so for repeated demos use a tunnel with a fixed hostname.

> Warning: a public URL publishes credentials. `GET /twin/demo-session`, `GET /twin/demo-orgs` and `GET /twin/openapi.json` require no login and return the node tenant API key, a freshly minted JWT, the node admin login and the TWIN credentials and API keys of every seeded organisation. All `GET` API routes are open as well, and every demo password is `demo`. Anyone who reaches the URL can act on both TWIN nodes and spend wallet funds. Even without a tunnel, `npm run demo` listens on all network interfaces, so the same endpoints are reachable from your local network. See [authentication-architecture.md](authentication-architecture.md) and, for a hosted instance, [deployment.md](deployment.md).

## Timings

| Step | What to expect | What dominates |
|---|---|---|
| Image pull | under 1 GB to download (compressed), about 4 GB on disk once extracted | network |
| Anchor stage | several minutes in total. More than 5 minutes for one node usually means a slow testnet RPC | about a dozen CLI runs per node, each in a new container, several of them on-chain |
| `twin:up` | waits up to 60 s per node | node start |
| Provision | one funding transaction per node, then one container per node | 7 CLI steps per organisation, several of them on-chain |
| Seed | 10 to 25 minutes for the 25 to 30 documents of the shipped Vietnam corridors (an observed range, not a guarantee) | per document: storage, proof signing (5 to 35 s, waited up to 50 s), attestation, 500 ms throttle, retries after 4 s and 8 s |
| `npm run demo` | full client and TWIN build before the servers listen | Vite and tsc |

## Tests while the nodes are running

`npx vitest run tests/server` runs the hermetic unit suites (simulated adapter, no network). With the TWIN nodes up, `npm test` also runs `tests/integration/`. Its org-attestation suite mints an NFT on the IOTA testnet whenever `data/tenant-state.json` lists provisioned organisations, and the suites that create DIDs, immutable proofs and documents run whenever a node answers their `GET /health` probe on `localhost:3000`, spending node and organisation wallet funds. Run it only when that is the intent. [AGENTS.md](../AGENTS.md) lists the test commands.

## TWIN verification proxy (`/twin`)

Each demo server forwards its TWIN node's authentication (login, logout, refresh, password), immutable-proof and verifiable routes under `/twin` unchanged, so a stakeholder can verify proofs against the node directly instead of through the demo's API. It forwards every HTTP method on those routes, not only `GET`, so a caller holding a node-tenant key and JWT can also create proofs through it, which spends node wallet gas. The path list, the authentication contract and the error statuses are in [document-verification.md](document-verification.md).

Open http://localhost:4000/twin/docs for Alpha or http://localhost:4001/twin/docs for Beta. Through the routing proxy, or a tunnel to it, use http://localhost:4002/twin/docs?node=alpha or `?node=beta`: the `?node=` sets the routing cookie, so the page and its spec and session calls go to the same node. Each page is a Swagger UI over the node's own interface and shows its own node's organisations. On load it fetches `/twin/demo-session` and applies a node-tenant API key and JWT, so you can expand `GET /immutable-proof/{id}/verify`, where the id is pre-filled with a seeded proof, and press Execute to get `{ "verified": true }`.

If you followed this runbook, the page signs in as the node admin. Proofs live in the node tenant, and after `twin:provision-orgs` every organisation has its own tenant, where it can log in but gets `proofNotFound` on node-tenant proofs. The page signs in as an organisation only when a seeded organisation lives in the node tenant, which happens for organisations the seed registers through REST without provisioning. These endpoints are the demo-only credential exposure described in [Exposing the demo through a tunnel](#exposing-the-demo-through-a-tunnel).

## Troubleshooting

Node logs: `npm run twin:logs` follows Alpha, `npm run twin:logs -- beta` follows Beta, or use `docker logs twin-showcase-node-alpha`. The anchor stage and provisioning print the TWIN CLI output directly in the terminal.

| Symptom | Cause | Fix |
|---|---|---|
| `WALLET_PASSPHRASE env var is required` | `.env` not loaded in this terminal | `set -a; . ./.env; set +a` |
| `decrypt failed: bad passphrase (GCM auth tag mismatch)`, or `existing record present but decrypt failed` from `create` | The passphrase in the shell is not the one the bundle was encrypted with | Load the `.env` with the right passphrase. A lost passphrase cannot be recovered: move both wallet files out of `data/`, then create and fund new wallets ([step 3](#3-create-and-fund-the-node-wallets)). |
| `no bundle at data/wallets.enc.json` from the anchor stage or `provision-orgs` | Step 3 has not run in this copy, or `--purge-wallets` deleted the bundle | Run [step 3](#3-create-and-fund-the-node-wallets) |
| `mnemonic fingerprint mismatch` during the anchor stage | `wallets.enc.json` and `wallet-addresses.json` come from different bundles | Rerun `npm run twin:wallets:create -- --node=both` with the correct passphrase, which rewrites `wallet-addresses.json` from the bundle. Otherwise move or restore the two files together. |
| `wallet has zero balance` during the anchor stage | The node wallet is not funded yet | Fund it at the faucet and check with `npm run twin:wallets:balance -- --node=both`. If the other node already completed in the same run, reset first (see [step 6](#6-anchor-the-nodes)). |
| `funding tx failed` during provisioning, or gas errors during the anchor stage or seed | The node wallet holds too little for the run | Check the balance and top up (see "How much is enough" in step 3) |
| `ERR_MODULE_NOT_FOUND` for `server/twin/dist/index.js` | `build:twin` has not run in this copy | `npm run build:twin` |
| `port is already allocated`, `address already in use` or `EADDRINUSE` | Another process uses 3000, 3001, 3306, 3307 or 4000 to 4002 (often a local MySQL, or `npm run dev:client`, whose Vite server also uses 3000) | Stop the other process |
| `twin:up` stays on containers in "Created", or any Docker command hangs | The Docker Desktop daemon is wedged, common after sleep or an update | Ctrl+C, restart Docker Desktop, run the command again |
| `twin:up` prints curl errors such as `Connection reset by peer` or `Failed to connect` until it reports `did not respond within 60s`, and the node log says `node identity is enabled in config but is not set` | The node volume has no engine state: `twin:up` ran before the first anchor stage, or a Docker Desktop reset wiped the volumes | `npm run twin:reset -- --yes`, then steps 6 to 9 |
| `twin:status` shows `401` on the `/login` line | `data/tenant-state.json` belongs to an older node database (or, on bash 4.4 or newer, is missing) | `npm run twin:reset -- --yes`, then steps 6 to 9 |
| `twin:status` stops with `apikey_header[@]: unbound variable` | A node is running but `data/tenant-state.json` is missing or has no key for it, and the script runs under bash 3.2 (the macOS default), which rejects the empty array under `set -u` | `npm run twin:reset -- --yes`, then steps 6 to 9 |
| Node log shows `Unknown database 'twin'`, logins fail with 401, and the public verify page stays on its amber "verifying" banner | The MySQL volume predates the `twin` database. MySQL creates it only when it initialises an empty volume, and the `db-init-alpha` / `db-init-beta` services in `docker-compose.twin.yml` add it only when the stack starts through Compose | `npm run twin:reset -- --yes`, then steps 6 to 9. A bare `docker compose -f docker-compose.twin.yml down -v` is not enough, because it leaves `data/tenant-state.json` behind (see the `orgAtt=FAILED` row). |
| Seed prints `orgAtt=FAILED:Kitsune login failed (401)...` | The node database was wiped and anchored again without `twin:reset`, so `data/tenant-state.json` still lists organisation tenants that the new database does not contain, and `provision-orgs` skipped them. The documents still get their node-signed proof. (Kitsune is the demo's TWIN REST client, `server/twin/kitsune-client.ts`.) | `npm run twin:provision-orgs -- --force`, then `npm run twin:seed -- --reset-state` |
| Seed stops with `could not connect to TWIN node alpha` | The nodes are not running | `npm run twin:up`, or the anchor stage (step 6) if they were never set up |
| Seed warns `TWIN user ... already exists (prior provision)` | A user from an earlier run exists for an organisation without a provisioned tenant | Harmless: the DID is kept and the seed continues |
| Boot log shows `corridor mismatch (state=X, config=Y) ... ignoring seed-state.json`, and organisations are unverified with "Demo mode" documents | `CONFIG_FILE` at run time differs from the seed's | Load the same `.env` and restart, or seed the corridor you want to run |
| Every document shows "Demo mode" without a mismatch warning | The servers run in simulated mode, or the seed did not complete | Check `Adapter mode:` in the boot log and the `Hydrated ...` counts, then re-run the seed |
| A document stays on "Writing to ledger" | The proof was signed after the seed's 50 s wait | Press "Verify on ledger now", or wait for the background re-check |
| `twin:reseed` stops at the seed step with `SEED_ARGS[@]: unbound variable` | bash 3.2 with `set -u` and no extra argument | The reset, anchor stage, `twin:up` and provisioning already completed, so run `npm run twin:seed -- --reset-state`. Next time pass `--node=both`. |
| `Proxy error ... Is the node running on port 4000?` (HTTP 502) | The demo server behind the proxy is down | Check the `npm run demo` terminal for the server's error |
| A tab suddenly shows the other node's data | Both nodes are open in one browser through the proxy | Use two browsers or profiles, or ports 4000 and 4001 directly |
| The other node's organisations are missing, or sharing to them is disabled | The peer channel is not connected, or a demo server restarted | Press Connect on either side |
| A page reload shows the login screen | The login is kept in browser memory only | Log in again |
