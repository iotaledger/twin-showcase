# TWIN node container stack

[`docker-compose.twin.yml`](../docker-compose.twin.yml) and this directory define the two TWIN nodes that the demo uses in docker mode: Alpha (export side) and Beta (import side). Each is a `twinfoundation/twin-node:0.9.0` container with its own MySQL 8.4.7 database, volumes and node tenant (plus one tenant per provisioned organisation), and both write to the IOTA testnet. With `ADAPTER_MODE=docker`, demo server Alpha (port 4000) calls node Alpha on `http://localhost:3000` and demo server Beta (port 4001) calls node Beta on `http://localhost:3001`, unless `TWIN_ALPHA_URL` or `TWIN_BETA_URL` points elsewhere. For cross-node shares each demo server also calls the other node.

This page is the reference for the containers, their configuration files and container-level troubleshooting. The procedures (first-time setup, daily restart, reset, corridor switch) are in [running-the-demo.md](../docs/running-the-demo.md). What a TWIN node offers is in [twin-node-overview.md](../docs/twin-node-overview.md), and how the node wallets are funded and the nodes anchored is in [wallet-funding-workflow.md](../docs/wallet-funding-workflow.md).

Two one-off steps prepare the nodes. The **anchor** (`npm run twin:bootstrap -- --stage=anchor`) uses each node's wallet, funded beforehand, to publish the node DID and the node organisation DID on the IOTA testnet. It also records the node identity in the node's `engine-state.json`, creates the node's vault keys, the node tenant with its API key and the admin user, writes the tenant API key to `data/tenant-state.json` and starts the node. **Org provisioning** (`npm run twin:provision-orgs`) then gives each organisation of the corridor a wallet funded from the node wallet, a DID, a tenant and a login user.

## Services

| Service (Alpha / Beta) | Container name | Image | Host port | Role |
|---|---|---|---|---|
| `db-alpha` / `db-beta` | `twin-showcase-db-alpha` / `twin-showcase-db-beta` | `mysql:8.4.7` | `127.0.0.1:3306` / `127.0.0.1:3307` | The node's MySQL server, database `twin` |
| `db-init-alpha` / `db-init-beta` | assigned by Compose | `mysql:8.4.7` | none | One-shot: `CREATE DATABASE IF NOT EXISTS twin` and grants for user `twin`, once the database is healthy |
| `twin-node-alpha` / `twin-node-beta` | `twin-showcase-node-alpha` / `twin-showcase-node-beta` | `twinfoundation/twin-node:0.9.0` | `127.0.0.1:3000` / `127.0.0.1:3001` (container port 3000) | The node runtime and its REST API |
| `twin-bootstrap-alpha` / `twin-bootstrap-beta` | assigned by Compose, removed after each run | `twinfoundation/twin-node:0.9.0` | none | The same image used as a command-line tool, behind the Compose profile `bootstrap` |

The Compose project is named `twin-showcase`, so the volumes are `twin-showcase_mysql_data_<node>` and `twin-showcase_twin_data_<node>` and the network is `twin-showcase_default`. Service names go with `docker compose -f docker-compose.twin.yml ...`, container names with plain `docker` commands.

Every published port is bound to `127.0.0.1`, so nothing in this stack is reachable from another machine. Use an SSH tunnel to reach a node or database on a remote host. On a deployed VM the webapp containers join the `twin-showcase_default` network and call the nodes by container name, as described in [deployment.md](../docs/deployment.md).

When Compose starts them (`docker compose up` or `docker compose run`), the node and bootstrap services wait until their database is healthy and `db-init-<node>` has finished. `npm run twin:up` instead starts the containers with plain `docker start`, which ignores these conditions and does not run `db-init` (see [Helper scripts](#helper-scripts)). The database healthcheck pings MySQL over TCP on `127.0.0.1:3306` inside the container rather than over the Unix socket. During first initialisation MySQL runs a temporary socket-only server and then restarts, and a socket ping would report healthy in that window, so dependent containers would connect too early and fail with `Failed to bootstrap MySqlEntityStorageConnector`. `db-init` exists because MySQL creates the `twin` database only when it initialises an empty data directory, so an older volume can lack it.

No service has a memory limit, on purpose. According to the compose file comments, a node capped at 3 GB or 5 GB runs out of memory late in a long seed and the last documents fail with `fetchHelper.general`, so the host is the only bound, and the comments assume at least 16 GB of RAM. The database and node services use `restart: unless-stopped`, which also brings a node back after an out-of-memory exit.

### The bootstrap services

A plain `docker compose -f docker-compose.twin.yml up -d` starts the databases, `db-init` and the nodes, never the bootstrap services, because those sit behind the `bootstrap` profile. The repo's scripts use them as throwaway command-line containers. `npm run twin:bootstrap -- --stage=anchor` and `npm run twin:provision-orgs` run `docker compose --profile bootstrap run --rm -T twin-bootstrap-<node> ...` with an explicit TWIN CLI command: one container per command for the anchor, one per node for org provisioning. Each run shares the node's `node.env`, its `twin_data` volume and its database, so whatever it creates is there when the runtime starts.

> Warning: do not run `docker compose -f docker-compose.twin.yml run --rm twin-bootstrap-<node>` without a command. The service's default command is the image's `bootstrap-legacy`, which generates its own wallet inside the container, funds it from the testnet faucet and never writes `data/tenant-state.json`. The demo servers and `twin:status` then have no tenant API key, and every login returns 401. The same flow is reachable as `npm run twin:bootstrap -- --legacy`, which the demo does not support. Ignore the header comment of `docker-compose.twin.yml`: it describes this legacy sequence, an unauthenticated `/health` check and a document that is not in this repository ([open-work.md](../docs/open-work.md#misleading-code-comments) lists it).

## Configuration files

| File | Loaded by | Contents |
|---|---|---|
| `twin/alpha/node.env`, `twin/beta/node.env` | `env_file` of that node's runtime and bootstrap containers | Every node setting: port 3000, MySQL connection, IOTA testnet endpoints (`api.testnet.iota.cafe`, faucet, explorer), storage and connector backends, and feature toggles, including `TWIN_TENANT_ENABLED=true` and the Dataspace Protocol (DSP) modules (`TWIN_DATASPACE_ENABLED=true`). Alpha and Beta differ only in `TWIN_MY_SQL_HOST`. |
| `twin/alpha/bootstrap.env`, `twin/beta/bootstrap.env` | Mounted read-only at `/app/.env.bootstrap` in the bootstrap container and used only by `bootstrap-legacy`. `twin:status` reads the admin password from it. The anchor ignores it. | `TWIN_FEATURES=node-identity,node-admin-user,node-wallet` and the admin credentials |
| `twin/jsonld-fix.mjs` | Runtime containers only, preloaded with `NODE_OPTIONS=--import /app/jsonld-fix.mjs` | JSON-LD loader patch, see below |
| `twin/dataspace-app.mjs` | Runtime containers only, loaded with `TWIN_EXTENSIONS=/app/dataspace-app.mjs` | Node extension, see below |
| `.env` in the repository root (optional, you create it, holds secrets) | Your shell when you load it, and Docker Compose, which reads it only for `${...}` substitution | The same file that [running-the-demo.md](../docs/running-the-demo.md) has you load in every terminal. From it, `docker-compose.twin.yml` takes `TWIN_MYSQL_ROOT_PASSWORD` (default `root`) and `TWIN_MYSQL_PASSWORD` (default `twin`). |

What each `node.env` setting does, and which settings node 0.9.0 rejects, is in [twin-node-overview.md](../docs/twin-node-overview.md#configuration-model). `node.env` also configures the testnet faucet (`TWIN_FAUCET_CONNECTOR=iota`), which the legacy bootstrap uses. The anchor and provisioning steps pass `--fund-wallet=false` and never call it.

**MySQL passwords.** `node.env` sets `TWIN_MY_SQL_PASSWORD=twin`, but the compose file overrides it in each node's runtime and bootstrap containers with `${TWIN_MYSQL_PASSWORD:-twin}`, so one variable sets both the database user's password and the node's connection. MySQL applies both passwords only when it initialises an empty data directory, so set them before the first start. On an existing volume MySQL keeps the old values, and `db-init` or the node then fails to authenticate. To apply new values to an existing stack, run `npm run twin:reset -- --yes`, then anchor, provision and seed as in [running-the-demo.md](../docs/running-the-demo.md). Change both defaults on any host that others can reach.

**`jsonld-fix.mjs`** patches the node's JSON-LD document loader so that contexts under `https://schema.twindev.org/`, which return 404, resolve to locally built ones. Without it, `GET /immutable-proof/:id` responses lose the on-chain reference, the demo cannot link a document to the IOTA Explorer, and the document stays on "Writing to ledger". The patch affects reads only, so proofs anchored without it show the reference on the next request. When the preload is active, the node log prints `[jsonld-fix] installed schema.twindev.org JSON-LD loader ...` at start (the message names a pre-release node version, the image is 0.9.0). How the patch works, and when the file can be removed, is in [twin-node-overview.md](../docs/twin-node-overview.md#extensions-loaded-by-this-repo).

**`dataspace-app.mjs`** is a node extension that registers a dataspace app: the node-side handler that ingests consignments arriving at the node's DSP inbox into the receiving node's auditable item graph (AIG), where the demo stores consignments. It is a scaffold. Node 0.9.0 rejects the demo's inbox call, so the node loads the extension but its ingestion handler never fires during a normal demo. Its behaviour and limits are in [dsp-design.md](../docs/dsp-design.md#the-corridor-dataspaceapp).

## Where the state lives

| Location | Holds | Deleted by |
|---|---|---|
| Volume `twin-showcase_twin_data_<node>`, mounted at `/var/lib/twin` | `engine-state.json`, which records the node identity set by the anchor, and the stored document files (blob storage is `file`, with encryption on) | `docker compose ... down -v`, `npm run twin:reset` |
| Volume `twin-showcase_mysql_data_<node>` | Database `twin`: tenants, users, vault keys and the records of every node module | `docker compose ... down -v`, `npm run twin:reset` |
| `data/tenant-state.json` on the host (file mode 0600, holds secrets) | Node and org tenant ids and API keys, org passwords. Written by the anchor and by `twin:provision-orgs` | `npm run twin:reset` only |
| `data/wallets.enc.json` and `data/wallet-addresses.json` on the host (created by `twin:wallets:create`, not under version control) | The encrypted wallet mnemonics (node wallets, plus org wallets after `twin:provision-orgs`) and the node wallet addresses | `npm run twin:reset -- --purge-wallets` only |

Three consequences follow. The runtime container cannot create its own identity: without `engine-state.json` it exits at start and the restart policy keeps restarting it, so a fresh volume needs the anchor before `twin:up`. A raw `down -v` wipes the node but leaves `data/tenant-state.json` pointing at deleted tenants, which causes 401s and makes `twin:provision-orgs` skip the orgs, so prefer `npm run twin:reset`. Because the wallet bundle survives a reset, re-anchoring reuses the funded node wallet, but it creates new DIDs and pays gas again from its balance.

## Helper scripts

The `twin:*` npm scripts in [`scripts/twin/`](../scripts/twin) wrap Compose with progress output and waits. The ones below all target `docker-compose.twin.yml` through `docker compose` (Compose v2), not the old `docker-compose`, and the bash scripts behind them (`scripts/twin/*.sh`) refuse to run without v2. Pass flags after `--`, as in `npm run twin:reset -- --yes`, otherwise npm consumes them itself.

| Script | Effect on the stack |
|---|---|
| `twin:up` (alias `twin:start`) | Creates the containers with `docker compose create`, starts the two databases and the two nodes with `docker start`, then waits up to 60 s per node for `GET /`. The two-step start works around a `docker compose up -d` hang seen under Docker Desktop. Because `docker start` bypasses Compose, it does not run `db-init` and does not wait for the database healthcheck. |
| `twin:down` (alias `twin:stop`) | `docker compose down`: removes the containers and the network, keeps the volumes. |
| `twin:status` | `docker compose ps`, then per node: `GET /`, an admin login with the tenant key from `data/tenant-state.json`, the node DID from `engine-state.json` and its IOTA Explorer link. Its `wallet funded` line only means that a DID exists. `npm run twin:wallets:balance -- --node=both` shows the current balance. |
| `twin:logs` | `docker compose logs -f --tail=50` for `twin-node-alpha`, or for another target such as `npm run twin:logs -- beta`. The `bootstrap-alpha` and `bootstrap-beta` targets belong to the unsupported legacy flow and show output only while a legacy bootstrap container exists. The anchor and org provisioning print their output in the terminal that runs them. |
| `twin:bootstrap` | Needs `WALLET_PASSPHRASE`. With `--stage=anchor` it anchors both nodes (or one with `--node=alpha` or `--node=beta`): it checks that the node wallet balance is not zero, starts the node's MySQL, runs the anchor's CLI commands in bootstrap containers, writes `data/tenant-state.json`, then runs `docker compose up -d --wait twin-node-<node>`. Without `--stage` it runs `twin:wallets:create` first, which creates the wallets or reuses an existing bundle, and then the anchor. |
| `twin:provision-orgs` | Needs `WALLET_PASSPHRASE`. Funds a new wallet for each organisation in `CONFIG_FILE` from the node wallet (one on-chain transfer per node, `ORG_FUNDING_IOTA`, default 2 IOTA per organisation), then creates each organisation's DID, tenant, keys and login user in one bootstrap container per node. Skips organisations already listed in `data/tenant-state.json` unless `--force` is given. |
| `twin:reset` | Destructive. Removes every `twin-showcase-*` container, the four volumes, the network, `data/tenant-state.json` and `data/seed-state.json`. Keeps the wallet bundle unless `--purge-wallets` is given. Prompts unless `--yes`. With `--bootstrap` it runs `twin:bootstrap` (without `--stage`) afterwards. |
| `twin:reseed` | Destructive. Chains reset, anchor, `twin:up`, `twin:provision-orgs --force` and the seed, see [running-the-demo.md](../docs/running-the-demo.md). |

Without `CONFIG_FILE`, `twin:provision-orgs` uses `configs/vietnam-us.json`, while the demo server and `twin:seed` default to `configs/vietnam-us-customs.json`. A mismatch provisions the organisations of one corridor and seeds or runs another, so set one `CONFIG_FILE` for provisioning, seed and demo, as [running-the-demo.md](../docs/running-the-demo.md) does with `.env`.

Without the npm scripts, `docker compose -f docker-compose.twin.yml down` stops the stack and keeps the volumes, and `docker compose -f docker-compose.twin.yml up -d twin-node-alpha twin-node-beta` starts both nodes together with their databases and `db-init`.

## Liveness check

```bash
curl http://localhost:3000/    # Alpha: TWIN Node - 0.9.0
curl http://localhost:3001/    # Beta
```

`GET /` is public and returns the node name and version, and it is the liveness check the supported scripts use. `/health` is enabled (`TWIN_HEALTH_ENABLED=true`), but according to the comment in `scripts/twin/up.sh` it requires the tenant `x-api-key` in multi-tenant mode, so it does not work as an unauthenticated probe.

## Admin accounts

The nodes run with `TWIN_TENANT_ENABLED=true`, and every REST call except `GET /`, login included, must carry the tenant API key in the `x-api-key` header. The node selects the tenant from that header, so a login without it looks up the user in the wrong tenant and fails with 401 even for a correct password. The anchor stores each node tenant's key in `data/tenant-state.json` under `nodes.<node>.tenantApiKey`. The tenant model is explained in [twin-node-overview.md](../docs/twin-node-overview.md#tenancy-and-authentication).

The anchor creates one admin user per node in the node tenant, with scope `tenant-admin,user-admin`. The demo servers and `twin:seed` log in as this user.

| Node | Email | Password |
|---|---|---|
| Alpha | `admin@alpha` | `TwinAlpha#2026!Demo` |
| Beta | `admin@beta` | `TwinBeta#2026!Demo` |

These are testnet demo values shipped in the code. Do not reuse them outside a local testnet demo. Three places must agree:

- `ADMIN_USERS` in `scripts/twin/wallets.mjs`, used by the anchor's `user-create` step.
- `twin/<node>/bootstrap.env`, used by the legacy bootstrap and read by `twin:status` for its login check.
- The defaults of `TWIN_<NODE>_EMAIL` and `TWIN_<NODE>_PASSWORD` in `server/adapter/index.js`, used by the demo servers and the seed.

The banner printed by `scripts/twin/up.sh` repeats them for convenience. The integration tests fall back to the Alpha password when `TWIN_ALPHA_PASSWORD` is unset, and `tests/server/adapter.test.js` asserts the Alpha default in `server/adapter/index.js`, so editing that default makes the unit tests fail.

To use other credentials, change `ADMIN_USERS` and both `bootstrap.env` files before anchoring, and export `TWIN_ALPHA_PASSWORD` and `TWIN_BETA_PASSWORD` for the demo servers and the seed instead of editing the defaults. Keep the emails `admin@alpha` and `admin@beta`, because `twin:status` builds the email from the node name and its login check would report 401 for any other. On a host running `docker-compose.deploy.yml`, exported variables do not reach the webapp containers, because that file lists their environment explicitly: add `TWIN_ALPHA_PASSWORD` and `TWIN_BETA_PASSWORD` to the `environment` list of both demo server services, since each demo server also logs in to the other node. A new password must pass the node's policy: at least 16 characters, upper and lower case, a special character and no run of three identical characters. In `bootstrap.env` a value containing `#` must be quoted, otherwise the rest of the line is read as a comment and the password is truncated.

> Warning: the demo server's unauthenticated `GET /twin/demo-session` returns the node tenant API key, a fresh JWT and the email and password it logged in with, which after `twin:provision-orgs` are normally this node admin's. `GET /twin/demo-orgs` and `GET /twin/openapi.json` are unauthenticated as well and return every seeded organisation's TWIN email, password and tenant API key. Anyone who can reach a demo server can therefore act as node admin or as any organisation. See [authentication-architecture.md](../docs/authentication-architecture.md#demo-endpoints-that-hand-out-credentials).

To get a JWT by hand, run from the repository root:

```bash
KEY=$(node -e "console.log(require('./data/tenant-state.json').nodes.alpha.tenantApiKey)")
curl -i -X POST http://localhost:3000/authentication/login \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{"email":"admin@alpha","password":"TwinAlpha#2026!Demo"}'
```

The JWT arrives in the response body as `token` or `access_token`, or only in the `access_token` cookie, which `-i` makes visible. Later calls need the same `x-api-key` plus `Authorization: Bearer <jwt>`.

## Inspecting a running node

```bash
# Engine state, including the node DID
docker exec twin-showcase-node-alpha cat /var/lib/twin/engine-state.json

# Logs and resource usage
docker compose -f docker-compose.twin.yml logs -f twin-node-alpha
docker stats --no-stream twin-showcase-node-alpha twin-showcase-node-beta

# MySQL shell for node Alpha (user and database "twin", password "twin" unless overridden)
docker exec -it twin-showcase-db-alpha mysql -utwin -p twin
```

## Troubleshooting

Container-level problems only. Demo-level symptoms (corridor mismatch, seed failures, peering) are in [running-the-demo.md](../docs/running-the-demo.md#troubleshooting), and messages from the wallet scripts in [wallet-funding-workflow.md](../docs/wallet-funding-workflow.md#troubleshooting). "Reset and rebuild" below means `npm run twin:reset -- --yes`, then anchor, provision and seed as in [running-the-demo.md](../docs/running-the-demo.md).

| Symptom | Cause | Fix |
|---|---|---|
| The node container restarts in a loop, `twin:up` reports `did not respond within 60s`, and the node log says `node identity is enabled in config but is not set` | No `engine-state.json` in the volume: the node was never anchored, or the volumes were wiped | Reset and rebuild |
| Every REST call returns 401 | The call has no `x-api-key`, or the key belongs to an older node database | Send the key from `data/tenant-state.json`. If the file is missing or stale, reset and rebuild |
| The node log shows `Unknown database 'twin'` | The MySQL volume has no `twin` database. MySQL creates it only on an empty volume, and `db-init` adds it only when the stack starts through Compose, not through `twin:up` | Reset and rebuild |
| `Failed to bootstrap MySqlEntityStorageConnector` | The node or a bootstrap container connected while MySQL was still initialising | Run the command again once `docker compose -f docker-compose.twin.yml ps` shows the database as healthy |
| The node aborts at start with `Instance type not found for ...`, naming `notarizationConnector` or `authenticationAdminComponent` | A required setting is missing from `node.env`: `TWIN_NOTARIZATION_CONNECTOR=iota` (mandatory while the dataspace is enabled), or `TWIN_AUTH_PROCESSOR_TYPE` and `TWIN_AUTH_ADMIN_PROCESSOR_TYPE` (both `entity-storage`) | Add the setting back to both `node.env` files with the value shown in the Cause column. Node 0.9.0 validates its environment strictly, so do not copy settings from older TWIN examples |
| `wallet has zero balance` during anchor, or `does not have enough coins to form a balance of 1000000000` | The paying wallet is empty or holds 1 IOTA or less. Each on-chain operation reserves a 1 IOTA gas budget, and the anchor's pre-check rejects only a zero balance | Fund the node address from `data/wallet-addresses.json` at https://faucet.testnet.iota.cafe and check with `npm run twin:wallets:balance -- --node=both` |
| `port is already allocated` | Another process uses 3000, 3001, 3306 or 3307, for example a local MySQL, or `npm run dev:client`, whose Vite server also listens on 3000 | Stop that process. The MySQL host ports only serve debugging and can be remapped in `docker-compose.twin.yml`, but 3000 and 3001 are hard-coded in `scripts/twin/*.sh` and `scripts/twin/wallets.mjs` |
| Node data is gone after a restart | The stack was stopped with `down -v` or `twin:reset` | Stop with `npm run twin:down` or `docker compose -f docker-compose.twin.yml down`, which keep the volumes |

A running node uses a new wallet balance without a restart. An anchor that failed half-way does not resume, see [wallet-funding-workflow.md](../docs/wallet-funding-workflow.md#the-anchor-chain).
