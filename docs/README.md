# Documentation index

This repository is a demo of cross-border trade between two parties. Two demo servers, Alpha (export side) and Beta (import side), let the organisations on each side register identities, exchange and notarize trade documents and share consignments. The UI and the code also call each demo server a node (Node Alpha, Node Beta), so this index says demo server for those and TWIN node for the TWIN service. In docker mode each demo server is backed by its own TWIN node, a service shipped as the Docker image `twinfoundation/twin-node` that provides DIDs, notarization, document storage, audit records and ODRL (W3C Open Digital Rights Language) access policies over REST, and anchors identities and document proofs on the IOTA testnet, a public test ledger whose writes are real and paid with free faucet tokens. Hosted mode uses the same adapter against remote TWIN nodes, and simulated mode involves no TWIN node.

Each topic is described in one doc only, and the other docs link to it. When behaviour changes, update the owner doc listed in [All documents](#all-documents). [open-work.md](open-work.md) is the complete list of what does not work yet, each item with its impact and next step. Other docs mention a limitation only where it affects their topic, and link there. If a doc and the code disagree, the code is what runs: fix the doc, and record in open-work.md any code defect you do not fix.

## Start here by role

| You are | Read first | Then |
|---|---|---|
| An engineer new to the repo | [../README.md](../README.md), to run the demo in simulated mode | [architecture.md](architecture.md), the starting point for how the system works and how the two demo servers and their TWIN nodes communicate, then [twin-node-overview.md](twin-node-overview.md) and [open-work.md](open-work.md) |
| Presenting the demo | [../DEMO_GUIDE.md](../DEMO_GUIDE.md) | [customs-demo-storytelling.md](customs-demo-storytelling.md) for a customs audience, [running-the-demo.md](running-the-demo.md) to show real on-chain anchors |
| Running docker mode (real TWIN nodes) | [running-the-demo.md](running-the-demo.md) | [wallet-funding-workflow.md](wallet-funding-workflow.md), [../twin/README.md](../twin/README.md) |
| Adding or changing a corridor | [../AGENTS.md](../AGENTS.md#run-modes-and-corridor-selection) | [running-the-demo.md](running-the-demo.md#switching-corridors) to switch corridors in docker mode, [open-work.md](open-work.md#the-config-schema-is-out-of-date-and-not-enforced) because nothing validates the configs |
| Deploying to a cloud VM | [deployment.md](deployment.md) | [running-the-demo.md](running-the-demo.md), [authentication-architecture.md](authentication-architecture.md) |
| Extending cross-node communication (the demo servers' WebSocket peer channel, DSP between TWIN nodes) | [architecture.md](architecture.md) | [dsp-design.md](dsp-design.md) |
| Working on document verification or the public QR pages | [document-verification.md](document-verification.md) | [twin-node-overview.md](twin-node-overview.md) |
| Calling a TWIN node from code | [twin-node-overview.md](twin-node-overview.md) | [architecture.md](architecture.md#inside-the-docker-adapter) |
| An AI coding agent | [../AGENTS.md](../AGENTS.md) | The owner doc of the topic at hand, from the table below |

> Warning: `GET /twin/demo-session`, `/twin/demo-orgs` and `/twin/openapi.json` need no login and hand out the node tenant API key, a node JWT with the login it was minted from and every organisation's TWIN credentials, and `npm run demo` listens on all network interfaces, so anyone on your network can act on the TWIN nodes and spend wallet gas. Read [authentication-architecture.md](authentication-architecture.md#demo-endpoints-that-hand-out-credentials) before an instance is reachable by anyone outside your team.

## All documents

| Doc | Owns |
|---|---|
| [../README.md](../README.md) | What the demo is and does, simulated quick start, URLs and logins, a short docker-mode summary. |
| [../AGENTS.md](../AGENTS.md) | Entry point for AI coding agents: repo map, commands, run modes, safe test commands, conventions and gotchas. The root `CLAUDE.md` only imports it. |
| [../DEMO_GUIDE.md](../DEMO_GUIDE.md) | Presenter click script: logins, user journey, demo scenarios, customs beats 0 to 7, audience Q&A. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to set up, test and submit a change: safe commands, the commands that spend testnet gas, conventions, documentation rules, pull requests. |
| [../SECURITY.md](../SECURITY.md) | What the demo does and does not protect, and how to use it safely. |
| [architecture.md](architecture.md) | How the demo works: processes and ports, adapter modes (`simulated`, `docker`, `hosted`) and what each one sends to the TWIN node, the WebSocket peer channel and its message types, the attempted delivery over the Dataspace Protocol (DSP), end-to-end flows. |
| [running-the-demo.md](running-the-demo.md) | Docker-mode runbook: prerequisites, wallets and funding, anchoring, per-corridor provisioning and seeding, opening Alpha and Beta, daily restart, corridor switch, reset, customs corridor specifics, exposing the demo through a tunnel, timings, which tests are safe while the nodes run, using the `/twin` verification proxy, troubleshooting. |
| [wallet-funding-workflow.md](wallet-funding-workflow.md) | Reference for the node wallets that pay testnet gas: the encrypted bundle, funding, passphrase rotation, the staged anchor chain and its rationale, how the anchor and `provision-orgs` create the node tenant and the org tenants and where their credentials are stored, threat model. |
| [../twin/README.md](../twin/README.md) | TWIN container stack reference: services, ports, env files, where the `jsonld-fix.mjs` preload and `dataspace-app.mjs` extension are mounted, admin credentials, container-level troubleshooting. |
| [deployment.md](deployment.md) | Running a docker-mode instance on one Linux VM behind HTTPS: the webapp image, `docker-compose.deploy.yml`, `deploy/deploy-template.sh` and how to point it at your own repository, an example GitHub Actions workflow, reverse proxy and TLS, `PUBLIC_BASE_URL`. |
| [twin-node-overview.md](twin-node-overview.md) | What a TWIN node (`twinfoundation/twin-node:0.9.0`) offers and which modules the demo calls, tenancy and authentication (`x-api-key` plus JWT), the `node.env` configuration model, what the `dataspace-app.mjs` extension and `jsonld-fix.mjs` preload do and why, bootstrap CLI concepts, on-chain cost, the client and node mismatches `KitsuneClient` works around. |
| [dsp-design.md](dsp-design.md) | Cross-node sharing over DSP on node 0.9.0: the ODRL access policy that the owner's node creates, the node's inbox contract and why delivery falls back to the WebSocket peer channel, receipt confirmation, what is missing. |
| [document-verification.md](document-verification.md) | What an upload anchors, the verification paths (`/twin` proxy, "Verify on ledger now", cross-node verify), the public QR pages `/verify/:docId` and `/shipment/:id` with the per-document-type `publicAccess` policy, the system-to-system verify API under `/api/verify`. Public visibility is enforced by the demo server, not the TWIN node, which has no anonymous read access. |
| [authentication-architecture.md](authentication-architecture.md) | Login and the `twin_session` cookie, what the session gates, the three account layers (demo persona, node admin, per-org TWIN user), the hybrid tenant model (shared corridor data in the node tenant, org signatures in per-org tenants) and why a persona login must never switch tenant, the secrets inventory including demo-only exposures. |
| [customs-demo-storytelling.md](customs-demo-storytelling.md) | Customs narrative for `configs/vietnam-us-customs.json`: the one-dossier-two-declarations story, persona cast, functional flow, scene arc, what the demo does not do, questions for the audience. |
| [open-work.md](open-work.md) | Known limitations, defects and open work by area, each with its impact and a concrete next step. |
