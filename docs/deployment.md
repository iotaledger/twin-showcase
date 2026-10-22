# Deploying a demo instance on a cloud VM

This guide covers running the demo in docker mode on a single Linux VM that people reach over HTTPS. A corridor is the set of organisations, consignments and documents defined by one `configs/*.json` file, and a TWIN node is the `twinfoundation/twin-node` service that stores identities, documents and proofs and writes to the IOTA testnet ([twin-node-overview.md](twin-node-overview.md)). The VM runs both TWIN nodes, their MySQL databases, the two demo servers and the routing proxy. The repo ships one supported pipeline for this, which needs the edits in [Adapting the template](#adapting-the-template) before first use: a host deploy script, `deploy/deploy-template.sh`, which rebuilds the corridor from scratch on every run, and an example GitHub Actions workflow that builds the webapp image and triggers the script over SSH. To run the same stack on a workstation, follow [running-the-demo.md](running-the-demo.md).

## What runs on the host

```
browser --HTTPS--> your reverse proxy (TLS) --[network "web"]--> <corridor>-webapp-proxy :4002
                                                                   | routes by ?node= or cookie
                                                 +-----------------+-----------------+
                                                 v                                   v
                                   <corridor>-webapp-alpha :4000       <corridor>-webapp-beta :4000
                                                 |  [network "twin-showcase_default"] |
                                                 v                                   v
                                   twin-showcase-node-alpha :3000      twin-showcase-node-beta :3000
                                                 |                                   |
                                        twin-showcase-db-alpha              twin-showcase-db-beta

host tooling (wallets, anchor, provisioning, seed) --> 127.0.0.1:3000 and 127.0.0.1:3001
```

| Stack | Defined by | Containers | Published on the host |
|---|---|---|---|
| TWIN nodes and MySQL (compose project `twin-showcase`) | `docker-compose.twin.yml`, images `twinfoundation/twin-node:0.9.0` and `mysql:8.4.7` | `twin-showcase-node-alpha`, `twin-showcase-node-beta`, `twin-showcase-db-alpha`, `twin-showcase-db-beta` | `127.0.0.1:3000`, `127.0.0.1:3001` (nodes), `127.0.0.1:3306`, `127.0.0.1:3307` (MySQL) |
| Webapp (compose project `<corridor>-webapp`) | `Dockerfile` (image) and `docker-compose.deploy.yml` (services `twin-alpha`, `twin-beta`, `twin-proxy`) | `<corridor>-webapp-alpha`, `<corridor>-webapp-beta`, `<corridor>-webapp-proxy` | `127.0.0.1:4002` (routing proxy only) |
| Host tooling | the clone of your repository in `REPO_DIR`, run with Node 24 | none, runs only during a deploy | none |

Despite their service names, `twin-alpha` and `twin-beta` in `docker-compose.deploy.yml` are the demo servers (Express plus the React SPA), not TWIN nodes. Both listen on 4000 inside their containers and publish nothing. They join the TWIN project's network `twin-showcase_default` as an external network and reach the nodes by container name (`ADAPTER_MODE=docker`, `TWIN_ALPHA_URL=http://twin-showcase-node-alpha:3000`, `TWIN_BETA_URL=http://twin-showcase-node-beta:3000`). They peer with each other over their own project network (`PEER_URL=ws://twin-beta:4000` and `ws://twin-alpha:4000`). The routing proxy is the only container on the external `web` network, which is where your reverse proxy reaches it. Every published port is bound to loopback, so the reverse proxy is the only public entry point.

The image is built in two stages on `node:24-alpine`. The build stage runs `npm run build`, which compiles the TWIN REST wrappers (`server/twin/dist`) and the SPA (`server/public`). The runtime stage installs production dependencies, copies only `server/`, `configs/` and `client/public/`, and starts `node server/index.js`. The image contains no `scripts/`, `twin/` or `data/`, so wallet handling, anchoring (registering each node's identity on the IOTA testnet, paid in testnet gas from the node wallet), org provisioning and seeding cannot run inside it. They run on the host from the clone in `REPO_DIR`, against the nodes' loopback ports, and write their results to `data/` in that clone. The clone should be at the commit the image was built from, which the example workflow guarantees by passing the same commit SHA as image tag and as ref.

The two demo server containers mount that directory read-only (`./data:/app/data:ro`) to read `data/tenant-state.json` and `data/seed-state.json`. The first holds the tenant API keys of the nodes and orgs: each node is multi-tenant, and the key sent as `x-api-key` selects the tenant a call acts on. The second holds the TWIN resource ids of the seeded records. The demo servers read both files at startup, so the webapp must be recreated after every reseed. The deploy script does this in its last step.

This layout keeps both TWIN nodes on the deploy VM. The demo servers also support `ADAPTER_MODE=hosted` against remote nodes (`TWIN_ALPHA_URL`, `TWIN_BETA_URL`), but nothing in the repo deploys that layout, and in hosted mode a demo server resolves no connection to the other node, so the cross-node calls of a share go to its own node ([open-work.md](open-work.md#two-nodes-are-hardcoded-and-hosted-mode-has-no-peers)).

## Host prerequisites

| Requirement | Why |
|---|---|
| Linux VM with Docker Engine, Docker Compose v2 (`docker compose`), `git`, `curl` and `bash` | The `scripts/twin/*.sh` helpers refuse to run without Compose v2 and poll the nodes with `curl`. |
| Node.js 24 and npm on the deploy user's `PATH` in a non-login shell | The host runs `npm ci`, `npm run build:twin` and the TWIN scripts. A forced SSH command does not load login-shell profiles, so per-user installs such as nvm stay invisible. Check with `sudo -u <deploy-user> -H bash -c 'node -v && npm -v'`. |
| 16 GB of RAM or more | The node and MySQL containers have no memory limits, so host memory is the only bound. 16 GB is the host size `docker-compose.twin.yml` assumes, not a measured minimum. With per-container caps of up to 5 GB, a node failed late in a long seed (`fetchHelper.general` on the last documents). |
| A dedicated deploy user that can run `docker` without sudo (for example a member of the `docker` group) | The scripts call `docker` and `docker compose` directly. |
| Outbound HTTPS to your git host, your container registry, Docker Hub, the npm registry and the IOTA testnet (`api.testnet.iota.cafe`) | Clone and fetch, image pulls, `npm ci`, and the on-chain writes of anchoring, provisioning and seeding. The nodes may also fetch public JSON-LD contexts (for example from w3.org and w3id.org), because `twin/jsonld-fix.mjs` answers only `schema.twindev.org` locally, so test proof handling before you restrict outbound HTTPS to this list. |
| Free loopback ports 3000, 3001, 3306, 3307 and 4002 | The two compose files publish them. |
| A reverse proxy with TLS, attached to an external Docker network named `web` | See [Reverse proxy and TLS](#reverse-proxy-and-tls). |
| Funded node wallets and their passphrase | Anchoring and provisioning fail without gas. See below. |

Anchoring and org provisioning spend testnet gas from the two node wallets in the wallet bundle `data/wallets.enc.json`, encrypted with `WALLET_PASSPHRASE`, whose addresses are listed in `data/wallet-addresses.json`. The repository contains neither file (`.gitignore` excludes all of `data/`), so each deploy host needs its own bundle in `<REPO_DIR>/data/`, created or copied there in [Host setup](#host-setup) step 5 before the first deploy. The forced checkout leaves files that the repository does not contain in place, so the bundle stays there between deploys. Every deploy also rewrites it, because `provision-orgs --force` stores a new wallet per org, so `<REPO_DIR>/data/` holds the only current copy: back it up outside `REPO_DIR` and copy it into any new clone. Do not use `WALLET_BUNDLE_PATH` to keep it elsewhere, because the anchor then writes `tenant-state.json` next to the bundle, where the seed, `twin:status` and the webapp containers do not look. Give each deploy host its own bundle: two installations sharing one spend from the same node wallets. [running-the-demo.md](running-the-demo.md) has the wallet procedure and [wallet-funding-workflow.md](wallet-funding-workflow.md) the wallet model. `data/tenant-state.json` and `data/seed-state.json`, which the deploy writes next to the bundle, hold tenant API keys and org passwords in cleartext, so keep `REPO_DIR` readable only by the deploy user.

## The host deploy script

`deploy/deploy-template.sh` contains all the logic that changes the host. It is meant to be installed outside the clone and run by the deploy user, either directly or as a forced SSH command, that is an `authorized_keys` entry that makes sshd run only this script for the CI key (see [the example pipeline](#example-pipeline-github-actions-and-a-forced-ssh-command)).

### What a run does

1. Reads `<corridor> <image-ref> <repo-ref> [wallet-passphrase]` and selects the matching `case` entry, which sets `REPO_URL`, `REPO_DIR`, `REPO_BRANCH`, `CONFIG_FILE` and `SECRETS_FILE`.
2. Creates `LOG_DIR` if needed and copies all output to `$LOG_DIR/deploy-<corridor>-<timestamp>.log`. On failure, an exit trap prints the log path.
3. Takes `WALLET_PASSPHRASE` from the fourth argument, otherwise sources `SECRETS_FILE`, and aborts if neither provides it.
4. Clones `REPO_URL` into `REPO_DIR` on the first run (it refuses a non-empty directory without a `.git` directory), then runs `git fetch` and a forced checkout of `<repo-ref>` (`--force` discards local changes to files the repository contains), fast-forwards when the ref is a branch name, and runs `npm ci` and `npm run build:twin`. It exports `CONFIG_FILE`, `ADAPTER_MODE=docker` and `WALLET_PASSPHRASE` for the following steps.
5. Runs `docker compose -f docker-compose.twin.yml down -v --remove-orphans` and `docker compose -f docker-compose.deploy.yml -p <corridor>-webapp down -v --remove-orphans`, discarding their errors. Nothing else on the host is touched. As shipped, the second command has no effect: `docker-compose.deploy.yml` requires `WEBAPP_IMAGE`, which the script sets only in step 7, so Compose aborts with `required variable WEBAPP_IMAGE is missing a value` and the previous webapp containers keep running until step 7 recreates them.
6. Runs `npm run twin:reseed -- --yes`, which chains reset, anchor, start, org provisioning and seed (`scripts/twin/reseed.sh`):
   - reset wipes the node volumes, `data/tenant-state.json` and `data/seed-state.json`, and keeps the wallet bundle,
   - anchor creates fresh DIDs (decentralized identifiers registered on the IOTA testnet), a tenant and an admin user on each node, paid from the existing node wallets,
   - `provision-orgs --force` gives every org in the corridor config a new tenant, DID and wallet funded from its node wallet,
   - the seed runs with `--reset-state` and writes every consignment and document of the config to the nodes.

   Then `npm run twin:status` prints containers, node reachability, admin login and DIDs to the log. It reports, it does not gate the run.
7. Starts the webapp with `docker compose -f docker-compose.deploy.yml -p <corridor>-webapp up -d --pull always --force-recreate --remove-orphans`, passing `WEBAPP_IMAGE=<image-ref>` and `CONFIG_FILE`.

The script ends there. It runs no smoke test, so open the public URL after each run. The two demo servers also start unpeered: log in and press Connect, because the peer channel opens only on `POST /api/node/connect` and does not reconnect by itself ([architecture.md](architecture.md)).

### Fresh corridor on every deploy

Every run rebuilds the corridor from nothing, which keeps the instance reproducible at a cost. On the first deploy nothing answers until step 7. On later deploys the previous webapp keeps serving the UI during the reseed, against nodes that are being wiped and re-anchored, so anything that reaches the nodes fails until step 7 recreates the containers. The reseed is dominated by testnet writes: for the shipped Vietnam corridors the anchor takes several minutes and the seed 10 to 25 minutes ([running-the-demo.md](running-the-demo.md#timings)). A failed run has no rollback. A failure in steps 1 to 4 leaves the running instance untouched, while a failure in step 6 leaves the previous webapp running against wiped or partly seeded nodes until a later run succeeds.

Anything users created in the UI is lost. The previous DIDs stay on the testnet, orphaned. `provision-orgs --force` funds a fresh wallet per org from the node wallets (`ORG_FUNDING_IOTA`, default 2 IOTA per org, so about 28 IOTA per deploy for a 14-org corridor such as `vietnam-us`, plus gas) and never recovers the balance of the previous org wallets. Only the node wallets survive, which is why a deploy needs no faucet step, but they must be topped up from the testnet faucet as deploys drain them (`npm run twin:wallets:balance -- --node=both` shows the balance).

The TWIN stack has a fixed compose project name (`twin-showcase`) and fixed container names, and every deploy wipes it. One VM therefore hosts one corridor at a time. Deploying a second corridor to the same VM replaces the first one's nodes, and its step 7 then fails, because the first corridor's routing proxy still holds `127.0.0.1:4002`. Before switching, run `WEBAPP_IMAGE=unused docker compose -f docker-compose.deploy.yml -p <old-corridor>-webapp down` as the deploy user from `REPO_DIR`, and point the reverse proxy at the new `<corridor>-webapp-proxy`.

### Arguments and the wallet passphrase

| Argument | Meaning |
|---|---|
| `<corridor>` | Selects a `case` entry, for example `vietnam-us`. Unknown values exit with `unknown corridor`. |
| `<image-ref>` | Webapp image to run, for example `ghcr.io/<owner>/<repo>:<sha>`. |
| `<repo-ref>` | Commit or branch to check out. When empty, the `REPO_BRANCH` of the selected `case` entry is used. |
| `[wallet-passphrase]` | Optional. When absent, the script sources `SECRETS_FILE`, a shell file containing `WALLET_PASSPHRASE=...`. |

Under a forced SSH command the arguments arrive in `SSH_ORIGINAL_COMMAND`, which the script splits with an unquoted `set -- $SSH_ORIGINAL_COMMAND`. The passphrase therefore must not contain whitespace, and should avoid the glob characters `*`, `?` and `[`, which that expansion tries to match against file names. Delivered this way, the passphrase lives in the process environment and stays out of the process list. Positional arguments are visible in `ps`, so manual runs should rely on `SECRETS_FILE` instead. The script logs where the passphrase came from, never its value.

### Adapting the template

The script fetches the code from `REPO_URL` on every run, and the example workflow passes the commit it built the image from, so `REPO_URL` must be the repository the workflow runs in (typically your fork), readable by the deploy user. Then edit the `vietnam-us` entry of the template, whose values are examples from an earlier deployment: `REPO_URL` names a specific repository, and `REPO_DIR`, `REPO_BRANCH`, `SECRETS_FILE` and `LOG_DIR` (set after the `case` block) are example host paths and a default ref. Replace them, add `PUBLIC_BASE_URL` (see [Seed and runtime must agree](#seed-and-runtime-must-agree-public_base_url-and-config_file)), and keep the `export` line in sync:

```bash
case "$CORRIDOR" in
  vietnam-us)
    REPO_URL="git@github.com:<your-org>/<your-repo>.git"
    REPO_DIR="/srv/vietnam-us"                 # writable by the deploy user
    REPO_BRANCH="main"                         # used when no <repo-ref> is passed
    CONFIG_FILE="configs/vietnam-us.json"
    PUBLIC_BASE_URL="https://demo.example.com"
    SECRETS_FILE="/srv/corridor-deploy/vietnam-us.secrets.env"   # mode 600, deploy user
    ;;
  ...
esac
...
LOG_DIR="/var/log/corridor-deploy"             # writable by the deploy user
...
export CONFIG_FILE ADAPTER_MODE=docker WALLET_PASSPHRASE PUBLIC_BASE_URL
```

Ignore the template's header comments where they disagree with this guide: the passphrase is the fourth token, not the third, the wallet bundle is not committed (each host keeps its own, see [Host prerequisites](#host-prerequisites)), `twin:reseed` stores no tenant token on node 0.9.0, and the install path and the `docs/ci-deployment.md` reference they give do not apply (this guide is the reference).

`CONFIG_FILE` picks the corridor. `configs/vietnam-us-customs.json` is the only shipped config with the customs desk view ([running-the-demo.md](running-the-demo.md#customs-corridor-specifics) covers the customs corridor). To deploy it, set `CONFIG_FILE="configs/vietnam-us-customs.json"` and `PUBLIC_BASE_URL` in the `case` entry.

To add a corridor, add a `case` entry named after it, with `CONFIG_FILE` set to one of the shipped configs in `configs/`. The commented `kenya-eu` example in the template references `configs/kenya-eu.json`, which does not exist. The entry's name becomes the compose project prefix, so its routing proxy container is `<corridor>-webapp-proxy`.

### Host setup

Steps 1 to 6 and 8 apply to every deploy host. Step 7 is needed only for the forced-command pipeline described in [the example pipeline](#example-pipeline-github-actions-and-a-forced-ssh-command).

1. Create the deploy user and meet the [host prerequisites](#host-prerequisites).
2. Give the deploy user read access to your repository, for example with a read-only deploy key, then check it with `sudo -u <deploy-user> -H ssh -T git@github.com` or the equivalent for your git host.
3. Log the deploy user in to the registry, unless the image is public. `sudo -u <deploy-user> -H docker login ghcr.io -u <user>` prompts for a token with package read access (`read:packages` on GHCR), which keeps the token out of the shell history. A registry token grants no git access and a deploy key grants no registry access, so the host needs both. Alternatively, one token with repository read and package read scopes can serve both, with an HTTPS `REPO_URL`, at the cost of a broader credential.
4. Create `REPO_DIR` and `LOG_DIR` owned by the deploy user, plus the directory of `SECRETS_FILE` if you use one, for example `sudo install -d -o <deploy-user> -g <deploy-user> /srv/vietnam-us /var/log/corridor-deploy /srv/corridor-deploy`. Leave `REPO_DIR` empty for the clone in step 5. For manual runs, create `SECRETS_FILE` with the line `WALLET_PASSPHRASE=...`, mode 600 and owned by the deploy user. The script sources it as shell code.
5. Clone the repository and create the host's wallets. The script reuses an existing clone, so clone it yourself and add the bundle before the first deploy. As the deploy user (`sudo -u <deploy-user> -H bash`):

   ```bash
   git clone <REPO_URL> <REPO_DIR> && cd <REPO_DIR> && npm ci
   read -rs WALLET_PASSPHRASE && export WALLET_PASSPHRASE   # the deploy passphrase, no whitespace
   npm run twin:wallets:create -- --node=both
   npm run twin:wallets:show -- --node=both
   ```

   Use the passphrase of the `WALLET_PASSPHRASE` CI secret or of `SECRETS_FILE` ([Arguments and the wallet passphrase](#arguments-and-the-wallet-passphrase)). Fund both addresses at https://faucet.testnet.iota.cafe and check them with `npm run twin:wallets:balance -- --node=both` (amounts in [running-the-demo.md](running-the-demo.md#3-create-and-fund-the-node-wallets)). To use a bundle created elsewhere, copy `wallets.enc.json` and `wallet-addresses.json` into `<REPO_DIR>/data/` instead, owned by the deploy user, and `chmod 600` the bundle. Keep a backup of the bundle outside `REPO_DIR`.
6. Install the edited template outside the clone, root-owned so the deploy user cannot change what runs: `sudo install -m 755 -o root -g root deploy-template.sh /usr/local/bin/corridor-deploy.sh`. Reinstall after every change. A symlink into the clone would follow the deployed ref instead, which lets anyone who can push to the repository change what the deploy user runs, including the forced command of the example pipeline.
7. Only for the example pipeline: bind the CI key to the script in the deploy user's `authorized_keys`:

   ```
   command="/usr/local/bin/corridor-deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... ci-deploy
   ```

8. Optional, recommended on a VM reachable from the internet: set `TWIN_MYSQL_ROOT_PASSWORD` and `TWIN_MYSQL_PASSWORD` (defaults `root` and `twin`) in `<REPO_DIR>/.env` of the clone from step 5. The forced checkout replaces only files that the repository contains, so it leaves `.env` and `data/` in place, and Compose reads `.env` for variable interpolation only. MySQL applies these values only when it initialises an empty data directory, and every deploy wipes the volumes, so they take effect on the next deploy.

### Running a deploy by hand

```bash
sudo -u <deploy-user> -H /usr/local/bin/corridor-deploy.sh vietnam-us ghcr.io/<owner>/<repo>:<sha> <sha>
```

Pass the image tag and the ref of the same commit, otherwise the host scripts and the image can come from different code. Without a fourth argument the passphrase comes from `SECRETS_FILE`. `-H` makes `docker` use the deploy user's registry login. A manual run bypasses the workflow's concurrency group, so check that no workflow run is in progress. On the deploy host, re-run the whole script rather than `npm run twin:reseed` alone, because the webapp must be recreated after a reseed.

## Seed and runtime must agree: PUBLIC_BASE_URL and CONFIG_FILE

`PUBLIC_BASE_URL` is the public origin of the instance, for example `https://demo.example.com`. The server uses it in `server/qr.js` to build the absolute `/verify/<docId>?node=<node>` and `/shipment/<id>?node=<node>` links that it prints as QR codes into the PDFs it generates: the seeded trade documents, the Transport Pass and the draft import declaration. QR codes drawn on screen use the browser's origin and do not depend on it. The `?node=` parameter lets the routing proxy send a scan to the right demo server, so one hostname serves both sides. What the public pages show is covered in [document-verification.md](document-verification.md).

The value must be identical when the seed runs and when the demo servers run. The seed script generates each PDF with its QR inside, stores the bytes on the TWIN node and anchors their SHA-256 hash on-chain. At startup, each demo server regenerates the same PDFs in memory with its own `PUBLIC_BASE_URL`, serves those bytes for download and displays the hash recorded by the seed. A different base URL produces different bytes and a QR that points at the wrong host. A seeded PDF downloaded from such an instance therefore does not match its anchored hash, and the file check on the public `/verify/:docId` page reports a mismatch. This consequence is derived from the code, not observed on a deployed host.

As shipped, `deploy-template.sh` does not set `PUBLIC_BASE_URL`. The seed falls back to `http://localhost:4002`, while `docker-compose.deploy.yml` passes an empty string to the containers (`${PUBLIC_BASE_URL:-}`). `server/qr.js` keeps an empty string (it uses `??`), so PDFs generated at run time carry relative links such as `/verify/<docId>` that a phone camera cannot open, and seeded PDFs downloaded from the instance hit the hash mismatch described above. The comment in `docker-compose.deploy.yml` that calls an empty value a "localhost fallback" is wrong. Set the variable in the `case` entry and export it before the reseed, as shown above. The exported value also reaches `docker compose`, which interpolates it into `docker-compose.deploy.yml`. Do not set it only in a `.env` file next to the compose files: Compose reads that file, but no Node code in the repo loads `.env`, so the seed would not see it.

`CONFIG_FILE` follows the same rule. The demo servers ignore `data/seed-state.json` when its corridor differs from the loaded config (`server/seed-state.js`), and the seeded records then lose their links to the TWIN node resources. The template passes the same `CONFIG_FILE` to the reseed and to the containers, so keep it that way when you edit it.

## Reverse proxy and TLS

The repo contains no reverse proxy configuration. `docker-compose.deploy.yml` assumes a container-based proxy such as Traefik, attached to an external Docker network named `web`. Only the routing proxy joins that network, and Compose refuses to start the webapp stack if the network does not exist. Whatever proxy you use, it must do the following.

- Terminate TLS and forward plain HTTP to `<corridor>-webapp-proxy:4002`.
- Forward WebSocket upgrades on `/`, where the browser opens its live-update socket (`wss://<host>/`). That request carries no `?node=`, so the routing proxy picks the demo server from the `twin-node` cookie. Without upgrades, ledger entries, notifications and incoming consignments stop appearing live, and only peer status keeps refreshing through polling.
- Pass the query string and cookies unchanged. The routing proxy picks Alpha or Beta from `?node=alpha|beta`, then from the `twin-node` cookie, and defaults to Alpha.

Example Traefik dynamic configuration (file provider). Entry point and certificate resolver names must match your Traefik static configuration, and Traefik forwards WebSocket upgrades without extra settings:

```yaml
http:
  routers:
    corridor-demo:
      rule: "Host(`demo.example.com`)"
      entryPoints: [websecure]
      service: corridor-demo
      tls:
        certResolver: letsencrypt
  services:
    corridor-demo:
      loadBalancer:
        servers:
          - url: "http://vietnam-us-webapp-proxy:4002"
```

With a proxy running directly on the host (nginx, Caddy), point it at `http://127.0.0.1:4002`, which the compose file publishes on loopback, enable WebSocket upgrades, and create the network once with `docker network create web` so Compose can start the stack.

Users open Alpha at `https://<host>/?node=alpha` and Beta at `https://<host>/?node=beta`. The deployed stack publishes no per-node port, so both sides share one origin and therefore one set of session and node cookies. To act as two separate parties, use two browsers or two browser profiles.

## Example pipeline: GitHub Actions and a forced SSH command

`.github/workflows/vietnam-us.yml` is one way to trigger the script. It shows a pattern in which CI never gets a shell on the host. Any other CI system that builds the image and runs the script works as well.

### The workflow

The workflow runs only on manual dispatch (`workflow_dispatch`, no inputs) and has two jobs:

- `build-push` builds the image from `Dockerfile` with Buildx and pushes `ghcr.io/<owner>/<repo>:latest` and `ghcr.io/<owner>/<repo>:<commit sha>`, authenticated with the automatic `GITHUB_TOKEN` (`packages: write`).
- `deploy` runs in the GitHub environment `vietnam-us`, which holds the secrets below and is where protection rules (required reviewers) can gate deploys. It fails early if `WALLET_PASSPHRASE` is empty, then uses `appleboy/ssh-action` to send `<corridor> <image-ref> <commit sha> <passphrase>` to the host with a 30-minute `command_timeout`. The image and the host clone therefore come from the same commit, the head of the branch you dispatch from.

`concurrency.group: vietnam-us-corridor` with `cancel-in-progress: false` queues runs, so two deploys never anchor with the same wallets at the same time. It does not cover runs started by hand on the host. The workflow's header comment lists three script arguments, while the step sends four. For another corridor, copy the file and change `name`, `concurrency.group`, the `environment` name and `env.CORRIDOR`, which must match a `case` label in the installed script.

| Secret | Scope | Purpose |
|---|---|---|
| `SSH_HOST` | environment | Host name or IP of the VM. |
| `SSH_USER` | environment | The deploy user bound to the forced command. |
| `SSH_PRIVATE_KEY` | environment | Private key of that user, without a passphrase, because the workflow passes no `passphrase` input. |
| `WALLET_PASSPHRASE` | environment | Decrypts the host's bundle in `<REPO_DIR>/data/`. No whitespace. GitHub masks it in the log. |
| `GITHUB_TOKEN` | automatic | Pushes the image to GHCR. |

### The forced-command model

In `~/.ssh/authorized_keys`, a `command="..."` option makes sshd run that command for the key, whatever the client asked for, and expose the requested command line in `SSH_ORIGINAL_COMMAND`. The workflow's `script:` value is therefore delivered as data, which the deploy script parses as arguments, and the CI key cannot open a shell or run anything else. That is why all deploy logic lives in the host script. The binding is step 7 of [Host setup](#host-setup).

The limit of the pattern: the key still chooses the image reference and the git ref, and the script runs `npm ci` and npm scripts from the deployed ref. Anyone holding the key, pushing to the repository or dispatching the workflow controls what runs on the host, so treat all three as deploy credentials.

## Before exposing an instance to the internet

The demo is built for presentations with synthetic data. A deployed instance has the following exposures. [authentication-architecture.md](authentication-architecture.md) covers the auth model and the full secrets inventory.

| Exposure | Effect |
|---|---|
| `GET /twin/demo-session`, `GET /twin/demo-orgs` and `GET /twin/openapi.json` are unauthenticated | They return the node tenant API key, a freshly minted JWT together with the email and password that obtained it, and the seeded orgs' TWIN emails, passwords and API keys. On a deployed instance that login is the node admin (`admin@<node>`), because the forced provisioning gives every org its own tenant. |
| The `/twin/*` proxy is exempt from the session check | It forwards every method on `/immutable-proof` and on the password-change route. With the JWT from `/twin/demo-session`, any visitor can create immutable proofs (on-chain writes that spend testnet gas) and change TWIN account passwords. |
| All GET routes are open | Documents (including downloads), consignments, finance data and the ledger are readable without logging in. |
| Demo logins | Every shipped config uses the password `demo`, compared in plaintext. |
| Default secrets | `SESSION_SECRET` (the HMAC key of the `twin_session` cookie) and `VERIFY_API_TOKENS` (default `demo-customs-integration`) have public defaults, and `docker-compose.deploy.yml` passes neither to the containers. |
| Peer channel | The `/peer` WebSocket between the demo servers is unauthenticated and reachable through the routing proxy (`wss://<host>/peer?node=alpha`). |

Use synthetic data and testnet wallets only. For an instance reachable from the internet, at least:

- Block the `/twin/` and `/peer` path prefixes at the reverse proxy. The UI calls neither: the demo servers peer directly over their compose network, and `/twin/*` serves only the TWIN node verification proxy and its Swagger page for integrators ([document-verification.md](document-verification.md#the-twin-proxy)), which you lose.
- Pass `SESSION_SECRET` and `VERIFY_API_TOKENS` (comma-separated) to the demo servers. Compose passes a variable to a container only when its `environment` list names it, and the lists of `twin-alpha` and `twin-beta` name neither. Add entries such as `- SESSION_SECRET=${SESSION_SECRET:?set SESSION_SECRET}` to both lists in the repository the host clones (the forced checkout of the next deploy reverts edits made only on the host), and keep the values out of the repository by setting them in `<REPO_DIR>/.env`, which Compose reads for interpolation. Use one random `SESSION_SECRET` for both services: Alpha and Beta share one origin and therefore one `twin_session` cookie, so with different values a login on one node makes every write on the other fail with 401.
- Redirect HTTP to HTTPS at the reverse proxy, because the `twin_session` cookie is set without `Secure`.

Two further settings reduce the remaining risk:

- Add `- RATE_LIMIT_ENABLED=1` to the same `environment` lists to limit `/api/login` to 50 requests per 15 minutes per client IP. The server takes the client IP from `X-Forwarded-For`, so the reverse proxy must overwrite that header.
- Set the MySQL passwords ([Host setup](#host-setup) step 8). The MySQL ports are bound to loopback, so the defaults are exposed only to processes on the host and to containers on the TWIN network.

Putting the whole site behind reverse-proxy authentication closes the open reads as well, but it also blocks the public QR pages (`/verify/...`, `/shipment/...`) that a scanner must reach without an account.

## Troubleshooting

Logs: the host log in `LOG_DIR`, the streamed output of the Actions run, `docker logs <container>`, and `npm run twin:logs -- alpha` or `-- beta` from `REPO_DIR` for the TWIN nodes. Container-level node issues are covered in [twin/README.md](../twin/README.md).

| Symptom | Cause and fix |
|---|---|
| `ssh: handshake failed ... [none publickey]` | `SSH_PRIVATE_KEY` is wrong, empty or passphrase-protected, or its public key is not in the deploy user's `authorized_keys`. |
| `unknown corridor '<name>'` | `env.CORRIDOR` in the workflow, or the first argument of a manual run, has no matching `case` entry in the installed script. |
| `no WALLET_PASSPHRASE (not passed from CI, no <file>)` | A run without a fourth argument (normally a manual run) found no `SECRETS_FILE`, or the file does not set `WALLET_PASSPHRASE`. An empty CI secret is stopped earlier by the workflow's guard step. |
| `mkdir: cannot create directory` at the start of the run | `LOG_DIR` does not exist and the deploy user cannot create it. Create it as in [Host setup](#host-setup) step 4. |
| `could not create work tree dir ... Permission denied` | The deploy user cannot create `REPO_DIR`. Pre-create it owned by that user. |
| `move it aside first (e.g. mv <REPO_DIR> <REPO_DIR>.old)` | `REPO_DIR` is non-empty and has no `.git` directory, for example because files were created in it before cloning. Moving it aside also moves the wallet bundle: clone again as in [Host setup](#host-setup) step 5 and copy `data/` and `.env` back before re-running. |
| `Permission denied (publickey)` on clone or fetch | The deploy user has no read credentials for `REPO_URL`, or `REPO_URL` still points at a repository your key cannot read. |
| `ERR_MODULE_NOT_FOUND ... server/twin/dist/index.js` | `npm run build:twin` did not run or failed. With `NODE_ENV=production` in the deploy user's environment, `npm ci` skips devDependencies, TypeScript included. |
| `npm: command not found` during the deploy | Node is not on the `PATH` of a non-login shell. Install it system-wide or set `PATH` in the script. |
| `decrypt failed: bad passphrase (GCM auth tag mismatch)` | `WALLET_PASSPHRASE` does not match the bundle in `<REPO_DIR>/data/`. |
| `no bundle at data/wallets.enc.json`, then `anchor failed — aborting` | The clone has no wallet bundle, for example a new or re-created `REPO_DIR`. The run has already wiped the nodes, so the instance stays down until a run succeeds. Add the bundle as in [Host setup](#host-setup) step 5 and re-run. |
| `wallet has zero balance at <address>` | The node wallet is unfunded or drained. Fund it from the testnet faucet ([wallet-funding-workflow.md](wallet-funding-workflow.md)). |
| `Failed to bootstrap ... MySqlEntityStorageConnector` | A node started while MySQL was restarting during its first initialisation. The TCP healthcheck in `docker-compose.twin.yml` exists to prevent this, so restore it if you changed it, then re-run the deploy. |
| `network web declared as external, but could not be found` | The reverse proxy stack has not created the `web` network. Start it, or run `docker network create web`. |
| `port is already allocated` for `127.0.0.1:4002` in step 7 | Another corridor's routing proxy still runs. See [Fresh corridor on every deploy](#fresh-corridor-on-every-deploy). |
| `unauthorized` or `403 Forbidden` from the registry on pull | The deploy user is not logged in to the registry, or the token lacks read access to the package. Grant access in the package settings, authorise SSO for the organisation, or make the package public. |
| `repository name must be lowercase` in `build-push` | The workflow tags the image with `github.repository` verbatim. Lowercase the owner and repository in your copy of the tags. |
| 502 or no response through the reverse proxy | The first deploy has not reached step 7 yet, the routing proxy container is not on `web`, or the router targets a different container name than `<corridor>-webapp-proxy`. |
| UI loads but data calls fail | Expected while a redeploy runs, until step 7 recreates the webapp ([What a run does](#what-a-run-does), step 5). After a run that failed during the reseed, read the log in `LOG_DIR` and re-run. |
| UI shows no data, node calls return 401 `missingApiKeyOrTenantToken` | The webapp cannot read `data/tenant-state.json`: the `./data` mount is missing from `docker-compose.deploy.yml`, or the containers restarted (by hand or after a host reboot) while a failed reseed had left the file absent. |
| `[seed-state] corridor mismatch` in `docker logs <corridor>-webapp-alpha` | `CONFIG_FILE` differs between the reseed and the containers. Keep one value in the `case` entry. |
| QR in a PDF points at localhost or is relative, or the file check on `/verify` reports a mismatch | `PUBLIC_BASE_URL` was not exported before the reseed, or differs between seed and runtime. |
| Peer shows as disconnected after a deploy | Expected. Log in and press Connect. |
| The `deploy` job fails after 30 minutes | The reseed took longer than `command_timeout`, which is close to the reseed time of the Vietnam corridors. Raise it in your copy of the workflow. A run that hits the timeout can leave the host mid-reseed, so read the host log in `LOG_DIR` before re-running. |
