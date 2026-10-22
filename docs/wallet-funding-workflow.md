# Wallets, funding and node bootstrap

The demo runs two TWIN nodes, alpha (export side) and beta (import side). Each hosts the organisations (orgs) defined for it in the active corridor config (`CONFIG_FILE`), and `npm run twin:seed` loads the corridor's demo data into them. Every on-chain write a TWIN node makes is an IOTA testnet transaction: creating a DID (a decentralized identifier, stored on chain as an identity document), notarizing a document's immutable proof (the node's signed record of the document's hash), minting an org's attestation NFT (the org's own signature over the same document, see [document-verification.md](document-verification.md)). The node pays the transaction fee (gas) in testnet IOTA from a wallet whose key it holds. This document is the reference for how the repo creates, stores and funds those wallets, what the anchor stage (the step that gives each node its DIDs, keys, tenant and admin user after every reset) provisions and why, how TWIN tenants (isolated partitions of a node, each with its own API key) are laid out, and what the wallet encryption protects. The procedure itself (which commands to run in which order, timings, recovery) is in [running-the-demo.md](running-the-demo.md).

A wallet here is a 24-word BIP39 mnemonic (a seed phrase). The Ed25519 key pair and the IOTA address are derived from it, so whoever holds the mnemonic can spend the wallet's funds. Testnet IOTA has no monetary value, but the same key also controls the DIDs created with it (see [Threat model](#threat-model)).

## Stages and design rules

The bootstrap is split into stages because of two rules.

1. **No script calls the faucet.** Wallet creation is offline, funding is a separate, deliberate step outside the scripts, and the anchor stage refuses a wallet with zero balance. The faucet's availability and rate limits therefore never sit on the boot path, and an unattended run (a deploy, for example) cannot spend faucet quota or create node wallets nobody knows about. Org wallets are the exception: `provision-orgs` creates a new wallet for every org it has no record of (for every org with `--force`, which each unattended reseed uses) and funds it from the node wallet (see [Who pays for what](#who-pays-for-what)).
2. **The funded node wallets outlive node state.** `twin:reset` wipes the node containers, volumes and runtime state files but keeps the wallet files, so re-anchoring after a reset reuses the same funded node wallets. Only `twin:reset -- --purge-wallets` forces new node wallets and a new funding round. Org wallets do not survive a reset in practice, because the next provisioning run replaces them.

| Stage | Command | Network | When |
|---|---|---|---|
| accounts | `npm run twin:wallets:create` (same as `twin:bootstrap -- --stage=accounts`) | none | once per wallet set |
| funding | outside the repo, see [Funding](#funding) | testnet transfer | once, then top-ups |
| anchor | `npm run twin:bootstrap -- --stage=anchor` | on-chain writes paid by the node wallets | after every reset |
| org provisioning | `npm run twin:provision-orgs` | node wallet funds org wallets, org wallets pay their own writes | per corridor and after every reset |

`npm run twin:bootstrap` without `--stage` runs `create` and then `anchor`. On fresh, unfunded wallets the anchor stops at the zero-balance check, which is the expected outcome of a first run. `npm run twin:reseed` chains reset, anchor, `twin:up`, `provision-orgs --force` and the seed.

## Commands

All wallet commands run [`scripts/twin/wallets.mjs`](../scripts/twin/wallets.mjs), accept `--node=alpha|beta|both` (default `both`) and abort on unknown flags. Pass flags after `--`, for example `npm run twin:wallets:balance -- --node=alpha`. The scripts do not read `.env` (only Docker Compose uses it, for substitutions in the compose files), so load it into the shell that runs the command (`set -a; . ./.env; set +a`, as in [running-the-demo.md](running-the-demo.md)) or export the passphrase there.

| npm script | What it does | Needs | Network |
|---|---|---|---|
| `twin:wallets:create` | Generates a wallet per node, or reuses an existing one after checking that it decrypts with the current passphrase and matches its stored address. Saves the bundle again and rewrites the addresses file from it: when every wallet is reused, only the `updatedAt` timestamp of both files changes. | `WALLET_PASSPHRASE` | none |
| `twin:wallets:show` | Prints addresses and fingerprints from the addresses file. | nothing | none |
| `twin:wallets:reveal` | Decrypts the node wallets and prints their mnemonics to stdout. Org wallets are not printed. | `WALLET_PASSPHRASE` | none |
| `twin:wallets:balance` | Prints each node address's testnet balance. Org wallets are not shown. | nothing | read only |
| `twin:wallets:rekey` | Re-encrypts the node wallets under a new passphrase, see [Passphrase rotation](#passphrase-rotation). | `WALLET_PASSPHRASE_OLD`, `WALLET_PASSPHRASE` | none |
| `twin:bootstrap -- --stage=anchor` | Runs `wallets.mjs anchor`, the node provisioning chain in [The anchor chain](#the-anchor-chain). | `WALLET_PASSPHRASE`, Docker | on-chain writes |
| `twin:provision-orgs` | Creates a funded wallet, DID, tenant and user for each org of the active corridor. `--force` re-provisions orgs already recorded. | `WALLET_PASSPHRASE`, the corridor's `CONFIG_FILE`, Docker | on-chain writes |

## Storage and encryption

| File | Contents | Origin | Protection |
|---|---|---|---|
| `data/wallets.enc.json` | The bundle: `wallets.alpha` and `wallets.beta` (node wallets) and, once orgs are provisioned, `orgWallets.<node>.<orgId>`. Each record holds the encrypted mnemonic plus its address and fingerprint in clear. | written by `twin:wallets:create`, org wallets added by `provision-orgs`. Never committed. | AES-256-GCM under `WALLET_PASSPHRASE`. The script creates the file with mode 0600. Later writes do not change an existing file's mode, so run `chmod 600` on a copy brought over from another machine. |
| `data/wallet-addresses.json` | Node addresses, mnemonic fingerprints and a static `fundingRequired: true` flag. No secrets. | written by `twin:wallets:create` | none needed |
| `data/tenant-state.json` | Per node: node DID, node org DID, tenant id, tenant API key, `encTenantToken` (null on node 0.9.0, see step 12 of [The anchor chain](#the-anchor-chain)). Per org: DID, tenant id, tenant API key, wallet address, user email and password. | runtime, written by anchor and `provision-orgs` | mode 0600, cleartext |
| `data/seed-state.json` | Written by `twin:seed`. Includes copies of the org emails, passwords and tenant API keys. | runtime, written by `twin:seed` | default mode, cleartext |
| `data/.wallets.lock` | Empty lock target, used only while no bundle exists. | runtime | n/a |
| Docker volumes `twin-showcase_twin_data_<node>` and `twin-showcase_mysql_data_<node>` | The node's `engine-state.json` and stored document files (`twin_data`), and its MySQL database (`mysql_data`), which contains the node vault with keys and wallet mnemonics. | runtime, created by Docker Compose | host access control only |

`.gitignore` excludes the whole `data/` directory, so none of these files is committed, and a fresh clone has no `data/` until `twin:wallets:create` creates it. A `tenant-state.json` left over from an earlier stack makes `provision-orgs` skip the orgs it lists. `twin:reset` deletes it together with `seed-state.json`, and the runbook in [running-the-demo.md](running-the-demo.md) runs it before the first anchor.

`create` draws 256 bits of entropy for a 24-word English BIP39 mnemonic and derives the address with `Ed25519Keypair.deriveKeypair` from `@iota/iota-sdk` (path `m/44'/4218'/0'/0'/0'` according to a code comment, 4218 being IOTA's coin type). Each record is encrypted on its own: a random 16-byte salt feeds PBKDF2-SHA256 with 600,000 iterations to derive a 32-byte key, and AES-256-GCM encrypts the mnemonic with a random 12-byte nonce. Salt, nonce, ciphertext and GCM tag are stored as base64. The fingerprint is `sha256:` followed by the first 32 hex characters of the mnemonic's SHA-256.

A wrong passphrase or an altered ciphertext fails with `decrypt failed: bad passphrase (GCM auth tag mismatch)`. The GCM tag covers only the mnemonic, so the clear `address` and `mnemonicFingerprint` fields are checked another way: `create` re-derives the address and refuses on mismatch, and `anchor` compares the fingerprint with the addresses file and stops with `mnemonic fingerprint mismatch` when the two files come from different bundles.

`create` and `rekey` hold a `proper-lockfile` lock while they rewrite the bundle (on the bundle itself, which shows up as `wallets.enc.json.lock` next to it, or on `data/.wallets.lock` before the bundle exists). `provision-orgs` also rewrites the bundle but takes no lock, so do not run it in parallel with `create` or `rekey`.

`WALLET_BUNDLE_PATH` moves the bundle. The scripts write `tenant-state.json` in the same directory, and the addresses file next to the bundle as `wallet-addresses.json` (bundle named `wallets.enc.json`), `<name>-addresses.json` (bundle named `<name>.enc.json`) or `<bundle>-addresses.json` (any other name). The demo server, `twin:seed`, `twin:status`, `twin:reset` and the containers of `docker-compose.deploy.yml` always use the files under `data/`, so a bundle outside `data/` leaves the running demo without its tenant keys. Use the override only to keep a second wallet set aside.

### Where the wallet files live

`data/` is not under version control, so the repository contains no wallets: every installation creates its own with `twin:wallets:create` and funds them ([Funding](#funding)). A bundle exists only where it was created and wherever you copy it, so keep a backup of both wallet files outside the working tree and the passphrase in a password manager. Give each installation its own bundle, because two installations sharing one spend from the same node wallets. A deploy host keeps its bundle in the clone it deploys from ([deployment.md](deployment.md#host-prerequisites)).

`twin:reset -- --purge-wallets` deletes both wallet files and `data/.wallets.lock`. Keep a copy first if you may need those wallets again: their funds stay on chain but cannot be spent without the bundle and its passphrase.

## Funding

Only the two node wallets are funded from outside. Their addresses are in `data/wallet-addresses.json` and are printed by `npm run twin:wallets:show`. Org wallets are funded by `provision-orgs` from their node's wallet (`ORG_FUNDING_IOTA`, default 2 IOTA) and normally need no manual funding. An org that mints many attestations without being re-provisioned can drop below the 1 IOTA gas reservation described under [Who pays for what](#who-pays-for-what). `twin:wallets:balance` shows only node wallets, so if an org's mints start failing, look up its address (`orgs.<node>.<orgId>` in `tenant-state.json`) on the IOTA explorer.

A node address can be funded in two ways:

- The IOTA testnet faucet at `https://faucet.testnet.iota.cafe`, when it is available: paste the address. The same URL is set in `twin/<node>/node.env` as `TWIN_IOTA_FAUCET_ENDPOINT`, together with `TWIN_FAUCET_CONNECTOR=iota`. The anchor and `provision-orgs` pass `--fund-wallet=false` and never call it. Only the [legacy bootstrap](#legacy-bootstrap) funds a wallet from the faucet.
- A transfer of testnet IOTA from any wallet that already holds some, for example a node wallet of another installation.

Confirm with `npm run twin:wallets:balance -- --node=both` before anchoring. Fund both node wallets before anchoring both nodes (the default): beta's zero-balance check runs only after alpha's chain has finished and spent its gas, and a beta failure then discards alpha's tenant key (see [The anchor chain](#the-anchor-chain)).

### Who pays for what

A verification method, in the table below, is a key entry in a DID document under which signatures made on behalf of that DID are checked.

| On-chain write | Triggered by | Paid from |
|---|---|---|
| Node DID, node org DID and the node org DID's three verification methods | anchor | node wallet |
| Transfer of `ORG_FUNDING_IOTA` (default 2 IOTA) to each new org wallet, one multi-output transaction per node | `provision-orgs` | node wallet |
| Org DID and its three verification methods | `provision-orgs` | that org's wallet |
| Org-signed attestation NFT for a document | seed, document upload in the UI | the issuing org's wallet |
| Immutable proof for a document | seed, document upload in the UI | node wallet. Proofs are issued under the node org DID, which was created from the node mnemonic (stated in code comments, not checked on chain). |
| DID and two verification methods for an org without a provisioned tenant, created over REST (`POST /identity`) by the seed or by registration on the Identity page | seed, UI | the node, presumably from the node wallet. The code does not show it, so check the transaction on the IOTA explorer. |
| Notarizations the node may attach to consignment-graph and ledger-stream writes (see [twin-node-overview.md](twin-node-overview.md)) | seed, UI | not stated in code. These writes go through the admin session, so presumably the node wallet. |

Vault keys, tenants and users are records in the node's database and cost nothing on chain.

Each on-chain operation reserves a 1 IOTA gas budget while it runs, although it spends far less (the mechanism is in the on-chain cost model of [twin-node-overview.md](twin-node-overview.md)). In this repo that is why `ORG_FUNDING_IOTA` defaults to 2, and why a node wallet holding a fraction of an IOTA passes the anchor pre-check (which only rejects zero) and then fails at its first write.

The node wallet budget is dominated by org funding. Every provisioning run that finds no record of an org funds a new wallet for it: any run after `twin:reset`, which deletes `tenant-state.json`, and any run with `--force`, which `twin:reseed` (and therefore the example deploy script) always uses. Such a run moves `ORG_FUNDING_IOTA` times the number of orgs, plus gas. With the shipped corridor configs that is 20 IOTA from alpha for its 10 orgs (12 IOTA for the 6 alpha orgs of `adapt-africa.json`) and 8 IOTA from beta for its 4. The previous org wallets keep their remaining balance, but their bundle entries are overwritten, and no script decrypts org wallets or sweeps funds back. That balance can be recovered only from a copy of the bundle kept before the run, by decrypting the record yourself (the scheme is described above) and transferring with an external wallet tool. On a host deployed with the example script, the bundle stays in the clone's `data/` between deploys, but every deploy runs `provision-orgs --force`, which replaces each org's entry, so unless you copy the host's bundle before the next deploy, the org wallets of the previous deploy and their balance are lost. Budget the node wallets for several reseeds.

## The anchor chain

The TWIN node image has a single `bootstrap-legacy` command that creates the node identity, the admin user and the wallet in one go, funds the wallet from the faucet, and implicitly creates the keys and verification methods the runtime needs. The two-stage flow cannot use it, since it would call the faucet and generate its own wallet. It runs the node's individual CLI commands with the pre-funded mnemonic instead, and therefore has to create each of those implicit pieces explicitly. `server/twin/compat/index.js` keeps the inventory of the node-version-specific workarounds ("shims") in this repo and records this one as `bootstrap-completeness`.

`anchor` first decrypts every requested wallet and checks its fingerprint, before any Docker work. Then, node by node, it checks that the balance is not zero, brings MySQL up with `docker compose up -d --wait db-<node>`, and runs each command of the table below as a throwaway container:

```bash
docker compose --progress=plain -f docker-compose.twin.yml --profile bootstrap run --rm -T \
  -v <tmpdir>:/work twin-bootstrap-<node> node src/index.js <command> <flags> [--output-json=/work/<file>.json]
```

`<tmpdir>` is a mode-0700 directory under the OS temp directory that collects the JSON outputs and is deleted at the end. The node's engine state (`engine-state.json` in the `twin_data` volume) and its database accumulate the results.

The reasons and error strings in the table come from comments in `scripts/twin/wallets.mjs` and `server/twin/compat/index.js`, which record the error each missing step produced. Several of those comments were written against pre-release node images. The full chain runs on node 0.9.0, but the code does not record whether every step is still strictly required there.

| # | Command | Why |
|---|---|---|
| 1 | `identity-create --mnemonic=<node mnemonic> --fund-wallet=false` | Creates the node DID on chain, paid by the pre-funded wallet. `--fund-wallet=false` keeps the CLI away from the faucet. |
| 2 | `node-set-identity --identity=<nodeDID>` | Records the node identity in the engine state. CLI commands that touch engine state (`tenant-create`, `user-create`) refuse to run until it is set ("node identity is enabled in config but is not set"). |
| 3 | `vault-key-create --identity=<nodeDID> --key-id=auth-signing --key-type=Ed25519 --overwrite-mode=skip` | Key the node signs login JWTs with. Without it the first `POST /authentication/login` fails with `entityStorageVaultConnector.keyNotFound`. |
| 4 | `vault-key-create --identity=<nodeDID> --key-id=param-encryption --key-type=ChaCha20Poly1305 --overwrite-mode=skip` | Key the node's URL transformer uses to encrypt tenant tokens. Without it login fails with `urlTransformerService.encryptionFailed`. |
| 5 | `identity-create --mnemonic=<node mnemonic> --fund-wallet=false --controller=<nodeDID>` | Creates the node org DID from the same wallet, controlled by the node DID. The node's own identity (step 2) and the organization identity that owns the tenant's data are separate DIDs: the node tenant and the admin user are bound to the node org DID, and document proofs are issued under it. |
| 6-8 | `identity-verification-method-create --identity=<nodeOrgDID> --verification-method-id=<id> --verification-method-type=assertionMethod --controller=<nodeOrgDID>` for `org-assertion`, `attestation-assertion` and `immutable-proof-assertion` | Signing methods on the node org DID for org credentials, attestation NFTs (the attestation service signs with `#attestation-assertion`) and immutable proofs (without `immutable-proof-assertion` every proof fails with `iotaIdentityConnector.methodMissing`). |
| 9 | `vault-key-create --identity=<nodeOrgDID> --key-id=blob-encryption --key-type=ChaCha20Poly1305 --overwrite-mode=skip` | `TWIN_BLOB_STORAGE_ENABLE_ENCRYPTION=true` makes the node encrypt every stored document with this key of the uploader's org. Without it uploads fail with `blobStorageService.createFailed`. |
| 10 | `tenant-create --label=<node>-demo --organization-id=<nodeOrgDID>` | Creates the node tenant and returns its id and API key. Node 0.9.0 requires `--organization-id`, so the node org DID must exist first. Anchor fails when no API key comes back, because the node resolves tenants only from `x-api-key`. |
| 11 | `user-create --tenant-id=<tenantId> --user-identity=<nodeOrgDID> --organization-identity=<nodeOrgDID> --email=admin@<node> --password=<admin password> --scope=tenant-admin,user-admin` | The admin user the demo server logs in as. `user-admin` is the scope the node enforces on `/authentication/admin/users`, which the seed and the UI use to create users for orgs that were not pre-provisioned. Without the scope those calls fail with `tokenHelper.insufficientScopes`. |
| 12 | `tenant-token --tenant-id=<tenantId>` | Leftover call, run best effort. Node 0.9.0 has no `tenant-token` command, so the step fails, anchor prints `tenant-token generation failed (...)` and continues, and `encTenantToken` is stored as null. No request uses the token (see [dsp-design.md](dsp-design.md)). |

Once every requested node has finished, `anchor` writes `nodes.<node>` into `data/tenant-state.json`, starts `twin-node-<node>` with `docker compose up -d --wait`, and polls `GET /` on port 3000 (alpha) or 3001 (beta) for up to 60 seconds. A node that does not answer in time only produces a warning: anchor still reports `anchor complete`, and `tenant-state.json` is already written.

Any failing command except `tenant-token` aborts the run. Because `tenant-state.json` is written only after all requested nodes succeed, a failure on beta also discards alpha's tenant API key even though alpha's chain completed. Anchor does not resume: running it again creates new DIDs and another tenant on top of the partial state. The clean recovery is `npm run twin:reset -- --yes` (wallets are kept) followed by a new anchor, at the cost of the gas already spent.

## Org provisioning

Org attestations are signed with each organisation's own DID, and minting an NFT needs a wallet behind that DID. The node keeps a DID's wallet mnemonic in its vault under `<did>/mnemonic`, and only the CLI's `identity-create --mnemonic` puts it there. The REST `POST /identity`, which the seed and the UI use for orgs that were not pre-provisioned, takes no mnemonic, so mint attempts for those orgs fail with `secretNotFound` and their documents carry only the node's immutable proof. `server/twin/compat/index.js` records this as the `cli-mnemonic-did` shim.

`provision-orgs` reads the orgs from the active `CONFIG_FILE`. Its default, `configs/vietnam-us.json`, differs from the default of the server and the seed (`configs/vietnam-us-customs.json`), so set one `CONFIG_FILE` for provisioning, seeding and running the demo as [running-the-demo.md](running-the-demo.md) describes. For each node it:

1. Selects the orgs not yet recorded in `tenant-state.json`, or all of them with `--force`.
2. Generates, per org, a mnemonic, its address, the email `<orgId>@<node>.demo.local` and a random password that satisfies the node's password policy.
3. Funds the new org addresses from the node wallet in one multi-output transaction sent through `https://api.testnet.iota.cafe`.
4. Runs one bootstrap container that executes a generated shell script with, per org, `identity-create --mnemonic=<org mnemonic> --fund-wallet=false`, `tenant-create --label=<orgId> --organization-id=<orgDID>`, the same three verification methods as the anchor, the `blob-encryption` key and `user-create --scope=user`. A single container serves all orgs because, according to a code comment, long series of `docker compose run` calls can hang Docker Desktop. One container per command would mean about 70 runs for alpha's 10 orgs, against 12 per node for the anchor.
5. Records each org that completed `user-create`: the encrypted mnemonic under `orgWallets.<node>.<orgId>` in the bundle, and DID, tenant id, API key, address, email and password under `orgs.<node>.<orgId>` in `tenant-state.json`.

Failure modes:

- Orgs fail independently. An org that fails after step 3 has been funded but is not recorded, mnemonic included, so its funding is stranded and the next run funds a fresh wallet for it.
- The bundle and `tenant-state.json` are written only after all requested nodes finish. If the beta run aborts (failed funding transaction, MySQL or container error), the alpha orgs just funded and created on chain are not recorded either. Running `--node=alpha` and `--node=beta` separately limits that loss.
- Records are keyed by org id, not by corridor. After switching `CONFIG_FILE` to a corridor that reuses the same org ids, as the shipped configs do, the existing org tenants are reused unless you pass `--force`. The consequences and the clean switch are in [running-the-demo.md](running-the-demo.md#switching-corridors).

## Tenant model

A TWIN tenant is an isolation boundary inside one node that owns users, identities, data and an API key. Both nodes run with `TWIN_TENANT_ENABLED=true` (`twin/<node>/node.env`), so every REST call, login included, carries an `x-api-key` header and the node resolves the tenant from that key on each request. There is no step that pins a default tenant to the node. The generic side (tenancy, `x-api-key`, JWT) is covered in [twin-node-overview.md](twin-node-overview.md).

Each node gets one node tenant and one tenant per org:

| | Node tenant | Org tenant |
|---|---|---|
| Created by | anchor | `provision-orgs` |
| Label and binding | `<node>-demo`, bound to the node org DID | `<orgId>`, bound to the org's own DID |
| User | `admin@<node>`, scope `tenant-admin,user-admin`, fixed admin password. Also a `user`-scope account `<orgId>@<node>.demo.local` with a random password for each org that got its DID over REST. | `<orgId>@<node>.demo.local`, scope `user`, random password |
| Holds | the shared corridor data the demo server writes with the admin session: documents, immutable proofs, consignments, ledger entries, access policies | the org's attestation NFTs |
| Credentials stored in | `tenant-state.json` under `nodes.<node>` (`TWIN_<NODE>_API_KEY` overrides the key). The admin password is hard-coded, see below. | `tenant-state.json` under `orgs.<node>.<orgId>`, copied into `seed-state.json` by the seed |

Apart from org attestations and the cross-node share, the demo server talks to its node as the admin user with the node tenant key. To mint an org attestation it logs in as that org's user with the org's tenant key, falling back to the node tenant key for orgs created over REST. For a cross-node share it signs a trust credential as the sharer org (org tenant key), posts the share to the recipient node's inbox with the recipient org's tenant key and that credential as bearer, and polls the recipient node's graph as that node's admin (see [dsp-design.md](dsp-design.md)). Why shared data stays on the node tenant while attestations use the org tenant, and the full credential inventory, are covered in [authentication-architecture.md](authentication-architecture.md).

The admin password is hard-coded, and the copies must agree: `ADMIN_USERS` in `scripts/twin/wallets.mjs` (used by the anchor's `user-create`), `twin/<node>/bootstrap.env`, and the default in `server/adapter/index.js`, which `TWIN_<NODE>_PASSWORD` overrides for the demo server and the seed. [twin/README.md](../twin/README.md) lists every copy and how to change the password.

## Passphrase rotation

```bash
WALLET_PASSPHRASE_OLD='<current>' WALLET_PASSPHRASE='<new>' npm run twin:wallets:rekey -- --node=both
```

`rekey` decrypts each node wallet with the old passphrase and re-encrypts it under the new one with a fresh salt and nonce. The mnemonic, address, fingerprint and on-chain DIDs do not change, so nothing is re-anchored or re-funded. Three limits apply:

- Org wallets in `orgWallets` are not re-encrypted. They stay under the old passphrase until a provisioning run replaces them (all of them with `--force`, which `twin:reseed` uses). No script reads them back, so the demo keeps working, but the old passphrase still opens them.
- Copies of the bundle made before the rotation (a backup, the copy on a deploy host) stay encrypted under the old passphrase. Rotation protects against future use of a passphrase that has not leaked. It does not revoke one that has.
- A deploy host keeps its own bundle in the clone's `data/`. Run `rekey` there as the deploy user and change the passphrase where the deploy reads it (the CI secret or `SECRETS_FILE`, see [deployment.md](deployment.md)) at the same time, otherwise the next deploy fails with `decrypt failed`.

If the passphrase or a mnemonic may have leaked, replace the wallets instead: `twin:reset -- --purge-wallets`, then create, fund, anchor, provision and seed as in [running-the-demo.md](running-the-demo.md). The old DIDs stay on chain, unused. No script moves the remaining balance of the old wallets, so transfer it out beforehand with an external wallet tool if it matters to you.

## Threat model

What the bundle protects against:

- Reading the file without the passphrase. Every guess costs 600,000 PBKDF2 iterations per record. Anyone who obtains a copy (a backup, a deploy host, an archive of the working directory) can guess offline for as long as they like, and passphrase strength is the only control.
- Undetected modification of an encrypted mnemonic. The GCM tag makes decryption fail instead of returning altered data.

What it does not protect against:

- **A leaked passphrase.** It opens every node and org mnemonic in every copy of the bundle encrypted under it. Beyond draining testnet funds, the wallet controls the DIDs created with it (on IOTA the creating address receives the DID's controller capability), so the holder could change the node and org DID documents, for example to add verification methods.
- **The passphrase outside the scripts.** A `.env` set up as in [running-the-demo.md](running-the-demo.md) holds the passphrase in the repository root, so any archive or copy of the working directory that includes `.env` ships the passphrase together with the bundle it decrypts. Leave `.env` and `data/` out of every copy you share. The wallet scripts themselves read the passphrase only from the environment and never print it. The example deploy pipeline in [deployment.md](deployment.md) keeps it as a CI secret and passes it to the deploy host, which decrypts the bundle on every deploy.
- **Exposure while the scripts run.** `anchor` passes the mnemonic as `--mnemonic=<words>` on the `docker compose run` command line, so it is visible in the host process list and in the container's arguments while each command runs. The scripts pass it as a flag because, according to a comment in `wallets.mjs`, the TWIN CLI does not pick up a mnemonic from an env file loaded with `--load-env`. `provision-orgs` writes the org mnemonics and passwords into a 0600 script inside its 0700 temp directory, and they appear in the CLI's arguments inside the container. The temp directories live under `os.tmpdir()`, usually on disk rather than tmpfs, and are left behind if the process is interrupted. On a Linux host, container processes also show in the host's process list. Run these commands on a host where no untrusted user has a shell.
- **Secrets outside the bundle.** `tenant-state.json` and `seed-state.json` hold tenant API keys and org passwords in clear text. Each node's vault, kept in its MySQL volume by the `entity-storage` vault connector set in `node.env`, holds the wallet mnemonics the node signs with. The admin passwords are fixed values committed to the repository, and therefore public (`ADMIN_USERS` in `scripts/twin/wallets.mjs`, `twin/<node>/bootstrap.env`, the defaults in `server/adapter/index.js`). The demo server's unauthenticated `GET /twin/demo-session`, `GET /twin/demo-orgs` and `GET /twin/openapi.json` hand out the node tenant API key, a freshly minted JWT, the email and password it was minted with (the node admin's once every org has its own tenant) and every org's TWIN email, password and tenant API key. See [authentication-architecture.md](authentication-architecture.md).
- **Custody.** The demo generates and holds every organisation's key, so no organisation controls its own identity.

## Legacy bootstrap

`npm run twin:bootstrap -- --legacy` runs `scripts/twin/bootstrap-legacy.sh`, which starts the image's `bootstrap-legacy` command in `twin-bootstrap-<node>` with `TWIN_FEATURES=node-identity,node-admin-user,node-wallet` and funds a new node wallet from the faucet inside the container. It ignores the bundle and writes no `tenant-state.json`, so the demo server has no tenant API key afterwards. It breaks both design rules. Use it only to debug the node image.

## Troubleshooting

Messages printed by the wallet scripts. General docker-mode troubleshooting is in [running-the-demo.md](running-the-demo.md), and container-level issues in [twin/README.md](../twin/README.md).

| Message | Cause | Fix |
|---|---|---|
| `WALLET_PASSPHRASE env var is required (and must be non-empty)` | Not set in this shell. | Load `.env` (`set -a; . ./.env; set +a`) or export the variable. The scripts do not read `.env` themselves. |
| `existing record present but decrypt failed` (from `create`) | The bundle in `data/` was made with another passphrase. | Use that passphrase. If it is lost, move both wallet files out of `data/` and create new ones. |
| `decrypt failed: bad passphrase (GCM auth tag mismatch)` | Wrong passphrase, or a modified record. | Use the right passphrase. If it is lost, the wallets cannot be recovered: replace them. |
| `no bundle at data/wallets.enc.json` | No bundle yet (a fresh clone), or after `--purge-wallets`. | `npm run twin:wallets:create`, then fund. |
| `mnemonic fingerprint mismatch` | `wallet-addresses.json` belongs to a different bundle. | Restore the matching file, or rerun `create` with the right passphrase, which rewrites it from the bundle. |
| `wallet has zero balance at <address>` | Not funded yet, or a different address was funded. | Fund the address shown and check with `twin:wallets:balance`. |
| `tenant-token generation failed (...)` during anchor | Expected on node 0.9.0, which has no `tenant-token` command. | Nothing to do. The anchor continues and no request uses the token. |
| `funding tx failed`, or another balance error, from `provision-orgs` | The node wallet holds less than `ORG_FUNDING_IOTA` times the orgs to fund, plus the gas budget. | Top up the node wallet and rerun. Nothing from the failed run is recorded (see [Org provisioning](#org-provisioning)). |
| `<orgId> did not complete (no done marker)` | That org's chain failed inside the container. Its output is printed just above. | Rerun `provision-orgs`. The org is retried with a new wallet. |
| `runtime not responding on :3000/ after 60s` (or `:3001/`) | The node did not come up after anchor. This is a warning only: anchor has completed and `tenant-state.json` is written. | `docker logs twin-showcase-node-<node>`. |
