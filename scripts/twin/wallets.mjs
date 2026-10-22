#!/usr/bin/env node
/**
 * T-314 — Two-stage TWIN bootstrap: wallet lifecycle CLI.
 *
 * Owns the encrypted wallet bundle, the cleartext addresses export, the
 * IOTA testnet balance query, and (for the anchor stage) the docker
 * compose orchestration that anchors DIDs against an already-funded
 * wallet via TWIN's granular CLI commands. See plan at
 * `.claude/plans/parallel-percolating-codd.md` and runbook at
 * `docs/wallet-funding-workflow.md`.
 *
 * Subcommands:
 *   create   — generate-or-reuse wallet (offline; no network).
 *   show     — print current addresses (no decrypt).
 *   reveal   — decrypt and print the mnemonic (WALLET_PASSPHRASE).
 *   balance  — query IOTA testnet RPC for current balance.
 *   rekey    — rotate WALLET_PASSPHRASE (same mnemonic + address).
 *   anchor   — run the granular identity-create chain inside the bootstrap
 *              container, using a pre-funded wallet. Never enters the
 *              faucet code path.
 *
 * Storage:
 *   data/wallets.enc.json       — encrypted bundle (gitignored).
 *   data/wallet-addresses.json  — cleartext addresses for DevOps handoff.
 *   Both paths configurable via WALLET_BUNDLE_PATH env (addresses file
 *   is derived: <bundle>.replace('.enc.json', '-addresses.json')).
 *
 * Crypto: AES-256-GCM with key derived via PBKDF2-SHA256 600,000 rounds
 *         (OWASP 2023), random 16-byte salt + 12-byte nonce per record.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import lockfile from 'proper-lockfile';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { getFullnodeUrl, IotaClient } from '@iota/iota-sdk/client';
import { Transaction } from '@iota/iota-sdk/transactions';
// TWIN node version-specific names, keys, policy + funding floor live in the
// compat layer (single source of truth shared with the server adapter).
import { VM, VAULT_KEY, genPolicyPassword, ORG_FUNDING_IOTA_DEFAULT } from '../../server/twin/compat/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_BUNDLE_PATH = path.join(ROOT, 'data', 'wallets.enc.json');
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.twin.yml');
const NODES = ['alpha', 'beta'];
const NETWORK = 'iota-testnet';
const NANO_PER_IOTA = 1_000_000_000n;

// Fullnode RPC used for funding transactions. getFullnodeUrl('testnet')
// returns the *indexer* URL (fine for getBalance, which the balance command
// uses) but transaction execution wants the fullnode RPC — the same endpoint
// the TWIN nodes use (twin/<node>/node.env: TWIN_IOTA_NODE_ENDPOINT).
const TESTNET_RPC = 'https://api.testnet.iota.cafe';

// T-316: per-org funding floor. Each on-chain DID/VM/mint op reserves a
// 1-IOTA gas budget; a wallet holding *exactly* 1 IOTA fails VM-create with
// "does not have enough coins to form a balance of 1000000000". Actual spend
// is tiny (~0.03 IOTA across the full chain) — the rest stays in the org
// wallet for future mints. Default 2 IOTA per org (configurable via
// ORG_FUNDING_IOTA); the node wallet holds ~1000, so N orgs cost ~2N IOTA.
const ORG_FUNDING_IOTA = BigInt(process.env.ORG_FUNDING_IOTA ?? ORG_FUNDING_IOTA_DEFAULT.toString());
const ORG_FUNDING_NANO = ORG_FUNDING_IOTA * NANO_PER_IOTA;

// The verification methods provisioned on every org DID, mirroring what
// anchorNode() provisions on the node's org DID (steps 6/6b) so a per-org
// identity can do everything the node-org can: issue org-assertion VCs, sign
// the standard attestation NFT (#attestation-assertion), and act as the
// immutable-proof issuer. (Names from the compat layer.)
const ORG_VERIFICATION_METHODS = [VM.ORG_ASSERTION, VM.ATTESTATION_ASSERTION, VM.IMMUTABLE_PROOF_ASSERTION];

// Per-node admin user credentials used by the anchor stage's user-create
// step. These match the values baked into twin/<node>/bootstrap.env so a
// post-anchor TWIN runtime accepts the same credentials the existing
// adapter code expects.
const ADMIN_USERS = {
  alpha: { name: 'admin@alpha', password: 'TwinAlpha#2026!Demo' },
  beta:  { name: 'admin@beta',  password: 'TwinBeta#2026!Demo' },
};

// Scope granted to the demo admin user. TWIN's auth-admin routes
// (POST/PUT/DELETE /authentication/admin/users — used by the seed's
// provisionOrgUser to create one TWIN user per org) are gated on the
// `user-admin` scope (see entityStorageAuthenticationAdminRoutes.js:
// requiredScope: ["user-admin"]). The token scope is matched with
// TokenHelper.verify, which splits the stored scope on "," — so we grant
// both `tenant-admin` (kept for tenant-scoped service checks) and
// `user-admin` (the only route-enforced scope in this image) as a single
// comma-separated value. Without `user-admin` the seed fails every
// createUser call with 401 tokenHelper.insufficientScopes.
const ADMIN_SCOPE = 'tenant-admin,user-admin';

// ── CLI helpers ──────────────────────────────────────────────────────────
const die = (msg) => { console.error(`[wallets] ERROR: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`[wallets] ${msg}`);
const ok   = (msg) => console.log(`[wallets] OK ${msg}`);
const warn = (msg) => console.warn(`[wallets] WARN: ${msg}`);

function parseArgs(argv) {
  const out = { node: 'both', help: false, force: false, _: [] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--force') out.force = true;
    else if (arg.startsWith('--node=')) {
      const v = arg.slice(7);
      if (v !== 'alpha' && v !== 'beta' && v !== 'both') die(`--node must be alpha|beta|both, got ${v}`);
      out.node = v;
    } else if (arg.startsWith('--')) {
      die(`unknown flag: ${arg}`);
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function nodesFromArg(nodeArg) {
  return nodeArg === 'both' ? NODES : [nodeArg];
}

function bundlePath() {
  return process.env.WALLET_BUNDLE_PATH
    ? path.resolve(process.env.WALLET_BUNDLE_PATH)
    : DEFAULT_BUNDLE_PATH;
}

function addressesPath() {
  const bp = bundlePath();
  // Replace the encrypted bundle suffix with the cleartext addresses
  // suffix. Falls back to "<bundle>-addresses.json" if the bundle path
  // doesn't end with the canonical suffix.
  // Canonical mapping: "<dir>/wallets.enc.json" → "<dir>/wallet-addresses.json"
  // (singular "wallet" matches the runbook + plan contract).
  if (bp.endsWith('/wallets.enc.json') || bp === 'wallets.enc.json') {
    return bp.replace(/wallets\.enc\.json$/, 'wallet-addresses.json');
  }
  if (bp.endsWith('.enc.json')) return bp.replace(/\.enc\.json$/, '-addresses.json');
  return `${bp}-addresses.json`;
}

function requirePassphrase(varName = 'WALLET_PASSPHRASE') {
  const v = process.env[varName];
  if (!v || v.length === 0) die(`${varName} env var is required (and must be non-empty)`);
  return v;
}

// ── Crypto ────────────────────────────────────────────────────────────────
const KDF = { name: 'pbkdf2', hash: 'sha256', iterations: 600_000, keyLen: 32 };

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, KDF.iterations, KDF.keyLen, KDF.hash);
}

function encryptMnemonic(mnemonic, passphrase) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ct.toString('base64'),
    authTag: tag.toString('base64'),
  };
}

function decryptMnemonic(record, passphrase) {
  const salt = Buffer.from(record.salt, 'base64');
  const nonce = Buffer.from(record.nonce, 'base64');
  const ct = Buffer.from(record.ciphertext, 'base64');
  const tag = Buffer.from(record.authTag, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    // crypto.createDecipheriv throws "Unsupported state or unable to authenticate data" on tag mismatch.
    throw new Error(`decrypt failed: bad passphrase (GCM auth tag mismatch)`);
  }
}

function mnemonicFingerprint(mnemonic) {
  return 'sha256:' + crypto.createHash('sha256').update(mnemonic).digest('hex').slice(0, 32);
}

// ── Mnemonic + address derivation (offline) ───────────────────────────────
function generateFreshMnemonic() {
  // 256-bit entropy ⇒ 24 BIP39 words.
  return generateMnemonic(englishWordlist, 256);
}

function deriveAddress(mnemonic) {
  if (!validateMnemonic(mnemonic, englishWordlist)) {
    throw new Error('invalid BIP39 mnemonic (checksum failed)');
  }
  // Default derivation path on @iota/iota-sdk Ed25519Keypair is
  // m/44'/4218'/0'/0'/0' (verified empirically in T-314 spike).
  return Ed25519Keypair.deriveKeypair(mnemonic).toIotaAddress();
}

// ── Bundle IO ─────────────────────────────────────────────────────────────
async function loadBundle() {
  try {
    const buf = await fs.readFile(bundlePath(), 'utf8');
    return JSON.parse(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveBundle(bundle) {
  const bp = bundlePath();
  await fs.mkdir(path.dirname(bp), { recursive: true });
  bundle.updatedAt = new Date().toISOString();
  await fs.writeFile(bp, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
}

async function loadAddresses() {
  try {
    const buf = await fs.readFile(addressesPath(), 'utf8');
    return JSON.parse(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveAddresses(bundle) {
  const ap = addressesPath();
  await fs.mkdir(path.dirname(ap), { recursive: true });
  const out = {
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    network: bundle.network,
    wallets: Object.fromEntries(
      Object.entries(bundle.wallets).map(([k, v]) => [
        k,
        { address: v.address, mnemonicFingerprint: v.mnemonicFingerprint, fundingRequired: true },
      ]),
    ),
  };
  await fs.writeFile(ap, JSON.stringify(out, null, 2) + '\n');
  return ap;
}

function emptyBundle() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    network: NETWORK,
    kdf: { name: KDF.name, hash: KDF.hash, iterations: KDF.iterations },
    cipher: { algorithm: 'aes-256-gcm', keyLen: KDF.keyLen },
    wallets: {},
  };
}

async function withBundleLock(fn) {
  const bp = bundlePath();
  await fs.mkdir(path.dirname(bp), { recursive: true });
  // proper-lockfile needs a file that exists; touch the bundle path's
  // parent directory or a sibling lock-target. We lock the bundle file
  // itself when present, else a sentinel.
  let target = bp;
  try { await fs.access(bp); } catch { target = path.join(path.dirname(bp), '.wallets.lock'); await fs.writeFile(target, '', { flag: 'a' }); }
  const release = await lockfile.lock(target, { retries: { retries: 5, minTimeout: 200, maxTimeout: 1500 } });
  try { return await fn(); } finally { await release(); }
}

// ── Subcommands ───────────────────────────────────────────────────────────
async function cmdCreate({ nodeArg }) {
  const passphrase = requirePassphrase();
  await withBundleLock(async () => {
    let bundle = await loadBundle();
    const fresh = !bundle;
    if (fresh) bundle = emptyBundle();

    const nodes = nodesFromArg(nodeArg);
    let generated = 0, reused = 0;
    for (const node of nodes) {
      if (bundle.wallets[node]) {
        // Defense in depth: verify the stored record decrypts with the
        // current passphrase before declaring "reused". Catches the
        // scenario where the operator typed the wrong passphrase on a
        // pre-existing bundle.
        try {
          const m = decryptMnemonic(bundle.wallets[node], passphrase);
          const addr = deriveAddress(m);
          if (addr !== bundle.wallets[node].address) {
            die(`bundle inconsistency on ${node}: stored address ${bundle.wallets[node].address} does not match decrypted mnemonic (${addr}). Refusing to overwrite.`);
          }
          ok(`${node}: reusing existing wallet (${bundle.wallets[node].address})`);
          reused++;
          continue;
        } catch (e) {
          die(`${node}: existing record present but decrypt failed: ${e.message}`);
        }
      }
      const mnemonic = generateFreshMnemonic();
      const address = deriveAddress(mnemonic);
      const enc = encryptMnemonic(mnemonic, passphrase);
      bundle.wallets[node] = { ...enc, address, mnemonicFingerprint: mnemonicFingerprint(mnemonic) };
      ok(`${node}: new wallet generated (${address})`);
      generated++;
    }

    await saveBundle(bundle);
    const ap = await saveAddresses(bundle);
    info(`bundle:    ${path.relative(ROOT, bundlePath())}`);
    info(`addresses: ${path.relative(ROOT, ap)}`);
    if (generated > 0) {
      info('');
      info('NEXT STEP: send the addresses file to DevOps for manual faucet funding.');
      info(`Run \`npm run twin:wallets:balance -- --node=${nodeArg}\` to confirm funding before \`--stage=anchor\`.`);
    }
  });
}

async function cmdShow({ nodeArg }) {
  const a = await loadAddresses();
  if (!a) die(`no addresses file at ${path.relative(ROOT, addressesPath())} — run \`twin:wallets:create\` first`);
  const nodes = nodesFromArg(nodeArg);
  for (const node of nodes) {
    const w = a.wallets[node];
    if (!w) die(`no wallet for node "${node}" — known: ${Object.keys(a.wallets).join(', ')}`);
    console.log(`${node}: ${w.address}  (${w.mnemonicFingerprint})`);
  }
}

async function cmdReveal({ nodeArg }) {
  const passphrase = requirePassphrase();
  const bundle = await loadBundle();
  if (!bundle) die(`no bundle at ${path.relative(ROOT, bundlePath())} — run \`twin:wallets:create\` first`);
  const nodes = nodesFromArg(nodeArg);
  for (const node of nodes) {
    const rec = bundle.wallets[node];
    if (!rec) die(`no wallet for node "${node}" — known: ${Object.keys(bundle.wallets).join(', ')}`);
    const m = decryptMnemonic(rec, passphrase);
    console.log(`${node}: ${m}`);
  }
}

function formatIota(nanoStr) {
  const n = BigInt(nanoStr);
  const whole = n / NANO_PER_IOTA;
  const frac = n % NANO_PER_IOTA;
  if (frac === 0n) return `${whole} IOTA`;
  return `${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '')} IOTA`;
}

async function cmdBalance({ nodeArg }) {
  const a = await loadAddresses();
  if (!a) die(`no addresses file — run \`twin:wallets:create\` first`);
  const client = new IotaClient({ url: getFullnodeUrl('testnet') });
  const nodes = nodesFromArg(nodeArg);
  for (const node of nodes) {
    const w = a.wallets[node];
    if (!w) die(`no wallet for node "${node}"`);
    try {
      const bal = await client.getBalance({ owner: w.address });
      const human = formatIota(bal.totalBalance);
      console.log(`${node}: ${human}  (${bal.totalBalance} nano, ${bal.coinObjectCount} coin objects) — ${w.address}`);
    } catch (e) {
      warn(`${node}: balance query failed — ${e.message}`);
    }
  }
}

async function cmdRekey({ nodeArg }) {
  const oldPassphrase = requirePassphrase('WALLET_PASSPHRASE_OLD');
  const newPassphrase = requirePassphrase('WALLET_PASSPHRASE');
  if (oldPassphrase === newPassphrase) die('WALLET_PASSPHRASE_OLD and WALLET_PASSPHRASE are identical — nothing to rotate');
  await withBundleLock(async () => {
    const bundle = await loadBundle();
    if (!bundle) die(`no bundle at ${path.relative(ROOT, bundlePath())}`);
    const nodes = nodesFromArg(nodeArg);
    for (const node of nodes) {
      const rec = bundle.wallets[node];
      if (!rec) die(`no wallet for node "${node}"`);
      const m = decryptMnemonic(rec, oldPassphrase);
      const enc = encryptMnemonic(m, newPassphrase);
      bundle.wallets[node] = { ...enc, address: rec.address, mnemonicFingerprint: rec.mnemonicFingerprint };
      ok(`${node}: rekeyed (address unchanged: ${rec.address})`);
    }
    await saveBundle(bundle);
  });
}

// ── Docker orchestration helpers (used by `anchor`) ───────────────────────
// `capture`  — pipe stdout/stderr, accumulate into the returned object,
//              AND stream live to the parent console (default behavior for
//              docker run of TWIN commands where the operator wants to
//              watch progress).
// `quiet`    — like capture but DOES NOT echo to the console. Use for
//              polling/inspect calls whose output is internal noise.
// `stdin`    — string to feed to the child's stdin and close.
function spawnCmd(cmd, args, { capture = false, quiet = false, stdin = null } = {}) {
  const wantStream = capture || quiet;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [stdin === null ? 'ignore' : 'pipe', wantStream ? 'pipe' : 'inherit', wantStream ? 'pipe' : 'inherit'],
      env: process.env,
    });
    let stdout = '', stderr = '';
    if (wantStream) {
      child.stdout.on('data', d => { const s = d.toString(); stdout += s; if (!quiet) process.stdout.write(s); });
      child.stderr.on('data', d => { const s = d.toString(); stderr += s; if (!quiet) process.stderr.write(s); });
    }
    if (stdin !== null) {
      child.stdin.end(stdin);
    }
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}… exited with code ${code}${wantStream ? `\nstderr: ${stderr.slice(-500)}` : ''}`));
    });
  });
}

async function getBalanceNano(address) {
  const client = new IotaClient({ url: getFullnodeUrl('testnet') });
  const bal = await client.getBalance({ owner: address });
  return BigInt(bal.totalBalance);
}

// Bring up the per-node MySQL container via docker-compose. We delegate
// everything (network creation, volume creation, healthcheck definition)
// to compose so this script stays aligned with what DevOps and the
// GitHub Actions self-hosted runner will execute. `--progress=plain`
// disables the TUI spinner that can wedge under Docker Desktop CLI plugin
// 5.1.x when stdio is not a TTY; capture mode keeps the verbose output
// off the parent's stdio and we surface our own concise progress lines.
//
// If this step hangs in practice it almost always means the Docker
// Desktop daemon is wedged — restart Docker Desktop and rerun.
async function ensureDbHealthy(node) {
  info(`  [${node}] bringing MySQL up via compose…`);
  await spawnCmd(
    'docker',
    ['compose', '--progress=plain', '-f', COMPOSE_FILE, 'up', '-d', '--wait', `db-${node}`],
    { quiet: true },
  );
  info(`  [${node}] MySQL healthy`);
}

// Run a TWIN node CLI command inside the twin-bootstrap-<node> service
// via `docker compose run --rm -T`. The service is gated behind the
// `bootstrap` profile in docker-compose.twin.yml, so we pass --profile
// explicitly. `-T` disables TTY allocation (avoids the well-known
// Docker Desktop "Created" hang). `--rm` cleans the per-command
// container on exit (TWIN granular commands are single-shot).
//
// Extra volume mount: we bind `tmpDir` to `/work` inside the container
// so the command's `--output-json=/work/<name>.json` lands on the host
// filesystem and we can read it back here.
//
// Mnemonic delivery: passed as a CLI flag (`--mnemonic="word1 …"`).
// Earlier drafts tried writing it to a 0600 env file and using
// `--load-env`, but the TWIN node v0.0.3-next.40 CLI silently ignores
// `TWIN_MNEMONIC` from --load-env and regenerates a fresh random
// mnemonic. The CLI-flag approach makes the mnemonic briefly visible in
// the *container's* argv during execution. The container is `--rm`
// effimero; the host's `ps` only shows the docker process arg list,
// not the inner command's. Threat model: an attacker with `docker exec`
// capability on the host during the anchor window can read it.
// Acceptable inside the self-hosted runner trust boundary documented in
// docs/wallet-funding-workflow.md.
async function runTwinCmd({ node, tmpDir, command, params, outputName }) {
  const containerOutputPath = outputName ? `/work/${outputName}` : null;
  const cliFlags = Object.entries(params).flatMap(([k, v]) => [`--${k}=${v}`]);

  const args = [
    'compose', '--progress=plain', '-f', COMPOSE_FILE,
    '--profile', 'bootstrap',
    'run', '--rm', '-T',
    '-v', `${tmpDir}:/work`,
    `twin-bootstrap-${node}`,
    'node', 'src/index.js', command,
    ...cliFlags,
  ];
  if (containerOutputPath) args.push(`--output-json=${containerOutputPath}`);

  const t = Date.now();
  info(`  [${node}] ${command} …`);
  await spawnCmd('docker', args);
  info(`  [${node}] ${command} OK (${Date.now() - t}ms)`);

  if (outputName) {
    const hostOutputPath = path.join(tmpDir, outputName);
    try {
      const buf = await fs.readFile(hostOutputPath, 'utf8');
      return JSON.parse(buf);
    } catch (e) {
      throw new Error(`${command} on ${node}: expected output file ${outputName} missing or unreadable (${e.message})`);
    }
  }
  return null;
}

// ── Per-node anchor pipeline ──────────────────────────────────────────────
async function anchorNode({ node, mnemonic, address }) {
  info(`── anchor [${node}] ──`);

  // 1. Pre-flight: balance > 0 (anchor needs gas for each on-chain write).
  const nano = await getBalanceNano(address);
  if (nano === 0n) {
    throw new Error(
      `[${node}] wallet has zero balance at ${address}. ` +
      `Send data/wallet-addresses.json to DevOps for funding; ` +
      `re-check with \`npm run twin:wallets:balance -- --node=${node}\` before retrying.`,
    );
  }
  info(`  [${node}] balance: ${formatIota(nano.toString())} (${address})`);

  // 2. Ensure the per-node MySQL is healthy via compose (compose
  //    creates the volume + network + applies the healthcheck from
  //    docker-compose.twin.yml; we just wait for it to land).
  info(`  [${node}] ensuring MySQL is healthy…`);
  await ensureDbHealthy(node);

  // 3. Tmpdir for the per-command env file + JSON outputs. Mode 0700 on
  //    the dir; mode 0600 on the env file (set in runTwinCmd).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `twin-anchor-${node}-`));
  await fs.chmod(tmpDir, 0o700);
  try {
    // 4. Node DID — same mnemonic, fund-wallet=false (default but explicit
    //    for diagnostic clarity).
    const nodeOut = await runTwinCmd({
      node, tmpDir,
      command: 'identity-create',
      params: { mnemonic, 'fund-wallet': 'false' },
      outputName: 'node-identity.json',
    });
    const nodeDid = pickDid(nodeOut, 'node-identity');
    info(`  [${node}] nodeDID: ${nodeDid}`);

    // 4b. Pin the node identity NOW (before any other command). TWIN's
    //     start-up routine asserts `nodeIdentitySet` for every CLI that
    //     touches engine state (tenant-create, user-create, …), so
    //     leaving this until the end produces the cryptic "node identity
    //     is enabled in config but is not set" error on those commands.
    await runTwinCmd({
      node, tmpDir,
      command: 'node-set-identity',
      params: { identity: nodeDid },
    });

    // 4c. Provision the `auth-signing` vault key for the node DID. TWIN's
    //     EntityStorageAuthenticationService uses this key (by id
    //     TWIN_AUTH_SIGNING_KEY_ID, default `auth-signing`) to sign the
    //     JWTs it issues on POST /authentication/login. bootstrap-legacy
    //     created it implicitly; the granular chain doesn't, so the
    //     runtime's first login attempt fails with
    //     `entityStorageVaultConnector.keyNotFound`. Idempotent —
    //     overwrite-mode=skip leaves an existing key in place.
    await runTwinCmd({
      node, tmpDir,
      command: 'vault-key-create',
      params: {
        identity: nodeDid,
        'key-id': VAULT_KEY.AUTH_SIGNING.id,
        'key-type': VAULT_KEY.AUTH_SIGNING.type,
        'overwrite-mode': 'skip',
      },
    });

    // 4d. (next.48) Provision the `param-encryption` vault key for the node
    //     DID. next.48 auto-enables the URL transformer (tenant mode plus
    //     dataspace plus rights management are on), which encrypts the tenant
    //     token with this ChaCha20Poly1305 key (TWIN_URL_TRANSFORMER_ENCRYPTION_KEY_ID,
    //     default `param-encryption`). bootstrap-legacy creates it
    //     (bootstrapLegacy.ts), but the granular chain does not, so login fails
    //     with `urlTransformerService.encryptionFailed` -> vault `keyNotFound`
    //     for `<nodeDID>/param-encryption`. Idempotent (overwrite-mode=skip).
    await runTwinCmd({
      node, tmpDir,
      command: 'vault-key-create',
      params: {
        identity: nodeDid,
        'key-id': VAULT_KEY.PARAM_ENCRYPTION.id,
        'key-type': VAULT_KEY.PARAM_ENCRYPTION.type,
        'overwrite-mode': 'skip',
      },
    });

    // 5. Org DID — same mnemonic. If TWIN refuses same-wallet reuse here,
    //    this is where the empirical fallback kicks in: we'd need a
    //    second mnemonic per node (out of scope until the failure surfaces).
    const orgOut = await runTwinCmd({
      node, tmpDir,
      command: 'identity-create',
      params: { mnemonic, 'fund-wallet': 'false', controller: nodeDid },
      outputName: 'org-identity.json',
    });
    const orgDid = pickDid(orgOut, 'org-identity');
    info(`  [${node}] orgDID:  ${orgDid}`);

    // 6. Two verification methods on the org DID. These mirror what the
    //    DockerAdapter.createDid() path provisions for downstream org
    //    attestations (server/adapter/docker.js:91-98).
    await runTwinCmd({
      node, tmpDir,
      command: 'identity-verification-method-create',
      params: {
        identity: orgDid,
        'verification-method-id': VM.ORG_ASSERTION,
        'verification-method-type': 'assertionMethod',
        controller: orgDid,
      },
    });
    await runTwinCmd({
      node, tmpDir,
      command: 'identity-verification-method-create',
      params: {
        identity: orgDid,
        'verification-method-id': VM.ATTESTATION_ASSERTION,
        'verification-method-type': 'assertionMethod',
        controller: orgDid,
      },
    });

    // 6b. Assertion method for the immutable-proof service. Documents are
    //     notarized by the node admin (DockerAdapter.storeDocument uses the
    //     admin Kitsune client), so the ImmutableProofService issues the
    //     proof VC under the admin's ORGANIZATION identity (this org DID)
    //     with verification method id `immutable-proof-assertion` (the
    //     TWIN default: ImmutableProofService._verificationMethodId →
    //     config.verificationMethodId ?? "immutable-proof-assertion"). The
    //     legacy node-admin-user bootstrap created it implicitly; the
    //     granular chain doesn't, so without this every seeded document's
    //     background proof task fails with iotaIdentityConnector.methodMissing.
    await runTwinCmd({
      node, tmpDir,
      command: 'identity-verification-method-create',
      params: {
        identity: orgDid,
        'verification-method-id': VM.IMMUTABLE_PROOF_ASSERTION,
        'verification-method-type': 'assertionMethod',
        controller: orgDid,
      },
    });

    // 6c. Blob-encryption vault key. TWIN_BLOB_STORAGE_ENABLE_ENCRYPTION=true
    //     makes BlobStorageService encrypt every blob with the symmetric
    //     vault key `${Organization}/blob-encryption` (ChaCha20Poly1305 —
    //     see blobStorageService.create()). The Organization is the
    //     uploader's org identity = the admin's org DID here. Missing key →
    //     entityStorageVaultConnector.keyNotFound → blobStorageService.createFailed
    //     on every document upload. Same implicit-bootstrap gap as auth-signing.
    //     Idempotent: overwrite-mode=skip keeps an existing key.
    await runTwinCmd({
      node, tmpDir,
      command: 'vault-key-create',
      params: {
        identity: orgDid,
        'key-id': VAULT_KEY.BLOB_ENCRYPTION.id,
        'key-type': VAULT_KEY.BLOB_ENCRYPTION.type,
        'overwrite-mode': 'skip',
      },
    });

    // 7. Tenant — `user-create` on this image version requires
    //    `--tenant-id` (the help text labels it "optional" but the CLI's
    //    constructor rejects user-create without it). `tenant-create`
    //    generates a random one and writes it to its output JSON.
    //    next.63 (node next.53 "organization identifiers") makes
    //    `--organization-id` REQUIRED (extendedType did): the tenant is now
    //    bound to an organization DID. For the node tenant that is the node's
    //    own org identity (same DID passed to user-create's organization-identity).
    const tenantOut = await runTwinCmd({
      node, tmpDir,
      command: 'tenant-create',
      params: { label: `${node}-demo`, 'organization-id': orgDid },
      outputName: 'tenant.json',
    });
    const tenantId = tenantOut?.tenantId ?? tenantOut?.['tenant-id'] ?? tenantOut?.tenant_id;
    if (!tenantId) {
      throw new Error(`tenant-create on ${node}: could not find tenantId in output: ${JSON.stringify(tenantOut).slice(0, 200)}`);
    }
    const tenantApiKey = tenantOut?.apiKey ?? tenantOut?.['api-key'] ?? tenantOut?.api_key ?? null;
    info(`  [${node}] tenantId: ${tenantId}${tenantApiKey ? ` (api-key captured)` : ''}`);

    // 8. (twin-node next.48) No tenant pinning. The `node-set-tenant` CLI
    //    command was removed (twin-node #186) and `INodeEngineState.nodeTenantId`
    //    no longer exists. The runtime resolves the tenant per request from the
    //    `x-api-key` header, so we rely on the `tenantApiKey` captured above
    //    (persisted to data/tenant-state.json by the caller and attached on
    //    every request by server/twin/kitsune-client.ts). Without it the node
    //    tenant is unreachable, so fail fast.
    if (!tenantApiKey) {
      throw new Error(`tenant-create on ${node}: no api key returned. twin-node next.48 resolves tenants per request via x-api-key (node-set-tenant was removed), so the api key is mandatory.`);
    }

    // 9. Admin user — credentials from ADMIN_USERS match the values
    //    baked into twin/<node>/bootstrap.env so the post-anchor runtime
    //    accepts the same credentials the existing adapter code expects.
    const admin = ADMIN_USERS[node];
    await runTwinCmd({
      node, tmpDir,
      command: 'user-create',
      params: {
        'tenant-id': tenantId,
        'user-identity': orgDid,
        'organization-identity': orgDid,
        email: admin.name,
        password: admin.password,
        scope: ADMIN_SCOPE,
      },
    });

    // 10. T-324: generate the url-transformer ENCRYPTED tenant token that gates
    //     this node's DSP data-plane (/dataspace/inbox + entity reads). Without
    //     it a cross-node share's notify is rejected with
    //     tenantProcessor.missingTenantToken. The adapter attaches the RECIPIENT
    //     node's token (?x-enc-tenant-token=…) when pushing to its inbox.
    //     Best-effort: a failure must not abort provisioning (the share then
    //     degrades to WS peering, as before DSP).
    let encTenantToken = null;
    try {
      const tokenOut = await runTwinCmd({
        node, tmpDir,
        command: 'tenant-token',
        params: { 'tenant-id': tenantId },
        outputName: `${node}-tenant-token.json`,
      });
      encTenantToken = tokenOut?.token ?? tokenOut?.Token ?? null;
      info(`  [${node}] encTenantToken: ${encTenantToken ? 'captured' : 'MISSING'}`);
    } catch (e) {
      info(`  [${node}] tenant-token generation failed (${e.message}); DSP cross-node notify will fall back to WS until provisioned`);
    }

    info(`  [${node}] engine-state.json populated`);
    return { nodeDid, orgDid, tenantId, tenantApiKey, encTenantToken };
  } finally {
    // 9. Cleanup: remove the tmpdir (env file + all json outputs). The
    //    encrypted bundle in data/wallets.enc.json remains the only
    //    persistent copy of the mnemonic.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Some TWIN commands wrap the DID under different json keys. Tolerant
// extractor: tries common shapes and falls back to a shallow search.
function pickDid(out, context) {
  if (!out || typeof out !== 'object') {
    throw new Error(`${context}: command output is not a JSON object — got ${typeof out}`);
  }
  if (typeof out.identity === 'string') return out.identity;
  if (typeof out.did === 'string') return out.did;
  // Shallow search: first string value that looks like a DID.
  for (const v of Object.values(out)) {
    if (typeof v === 'string' && /^did:iota:/.test(v)) return v;
  }
  throw new Error(`${context}: could not find DID in command output: ${JSON.stringify(out).slice(0, 200)}`);
}

// ── T-316: per-org tenant + funded wallet + seed-bound DID ─────────────────
//
// Generalises the validated PoC (one org, end-to-end) into a config-driven,
// idempotent provisioning unit per org. Per node, in ONE container run (to
// avoid the Docker-Desktop wedge that repeated `compose run` triggers):
//   tenant-create → identity-create --mnemonic → 3 VMs → blob-encryption key
//   → user-create.
// Funding happens host-side first as ONE multi-output transfer per node
// (node wallet → all org addresses), so the org wallets hold gas before
// VM-create (which the org wallet pays for). See task T-316 §"PoC validation".

// Read the active corridor config (CONFIG_FILE env or the demo default).
// Standalone JSON read — wallets.mjs is intentionally decoupled from the
// server/config.js loader (no theming/validation needed here, just orgs).
async function loadCorridorConfig() {
  const configFile = process.env.CONFIG_FILE
    ? path.resolve(process.env.CONFIG_FILE)
    : path.join(ROOT, 'configs', 'vietnam-us.json');
  let raw;
  try {
    raw = await fs.readFile(configFile, 'utf8');
  } catch (e) {
    die(`cannot read corridor config ${path.relative(ROOT, configFile)}: ${e.message} (set CONFIG_FILE)`);
  }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { die(`corridor config is not valid JSON: ${e.message}`); }
  if (!cfg?.corridor?.id) die(`corridor config ${path.relative(ROOT, configFile)} has no corridor.id`);
  return { configFile: path.relative(ROOT, configFile), corridor: cfg.corridor.id, cfg };
}

function orgsForNode(cfg, node) {
  return cfg?.nodes?.[node]?.orgs ?? [];
}

// One multi-output funding transaction: node wallet → each org address, all
// in a single signed transaction (one gas payment, atomic). Only funds the
// addresses passed in (the caller filters out already-funded orgs). Returns
// the transaction digest.
async function fundOrgWallets({ node, nodeMnemonic, recipients, amountNano }) {
  if (recipients.length === 0) return null;
  const kp = Ed25519Keypair.deriveKeypair(nodeMnemonic);
  const sender = kp.toIotaAddress();
  const client = new IotaClient({ url: TESTNET_RPC });
  const tx = new Transaction();
  tx.setSender(sender);
  const coins = tx.splitCoins(tx.gas, recipients.map(() => tx.pure.u64(amountNano)));
  recipients.forEach((r, i) => tx.transferObjects([coins[i]], tx.pure.address(r.address)));
  info(`  [${node}] funding ${recipients.length} org wallet(s) × ${formatIota(amountNano.toString())} from ${sender.slice(0, 12)}…`);
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  const status = res.effects?.status?.status;
  if (status !== 'success') {
    throw new Error(`[${node}] funding tx failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: res.digest });
  ok(`  [${node}] funding tx ${res.digest} confirmed`);
  return res.digest;
}

// Generate the inner shell script that provisions every org for a node in a
// single container. Each org is a `provision_org` call that fails soft (logs
// FAILED, continues to the next org) and only writes <orgId>-done.json after
// user-create succeeds — so the host persists exactly the orgs that fully
// completed, and a re-run retries the rest. Mnemonics/passwords are
// interpolated into the script written to the 0700 tmpdir (same threat model
// as runTwinCmd's --mnemonic flag, documented in wallet-funding-workflow.md).
function buildOrgChainScript(orgs) {
  const vmLoop = ORG_VERIFICATION_METHODS.map(vm =>
    `  node src/index.js identity-verification-method-create --identity="$DID" --verification-method-id=${vm} --verification-method-type=assertionMethod --controller="$DID" || return 1`,
  ).join('\n');
  const fn = `provision_org() {
  ORGID="$1"; MNEMONIC="$2"; EMAIL="$3"; PASSWORD="$4"; LABEL="$5"
  echo "[$ORGID] identity-create"
  node src/index.js identity-create --mnemonic="$MNEMONIC" --fund-wallet=false --output-json=/work/$ORGID-id.json || return 1
  DID=$(node -e "const d=require('/work/'+process.argv[1]+'-id.json');console.log(d.identity||d.did)" "$ORGID") || return 1
  echo "[$ORGID] tenant-create"
  node src/index.js tenant-create --label="$LABEL" --organization-id="$DID" --output-json=/work/$ORGID-tenant.json || return 1
  TID=$(node -e "console.log(require('/work/'+process.argv[1]+'-tenant.json').tenantId)" "$ORGID") || return 1
  echo "[$ORGID] verification methods"
${vmLoop}
  echo "[$ORGID] blob-encryption key"
  node src/index.js vault-key-create --identity="$DID" --key-id=blob-encryption --key-type=ChaCha20Poly1305 --overwrite-mode=skip || return 1
  echo "[$ORGID] user-create"
  node src/index.js user-create --tenant-id="$TID" --user-identity="$DID" --organization-identity="$DID" --email="$EMAIL" --password="$PASSWORD" --scope=user || return 1
  node -e "require('fs').writeFileSync('/work/'+process.argv[1]+'-done.json', JSON.stringify({orgDid:process.argv[2],tenantId:process.argv[3]}))" "$ORGID" "$DID" "$TID"
  echo "[$ORGID] DONE did=$DID tenant=$TID"
}`;
  const calls = orgs.map(o => {
    // Single-quote-escape each value for safe embedding inside double quotes
    // is unnecessary (mnemonics are [a-z ], passwords are [A-Za-z0-9+!], ids
    // are config-controlled); pass them as positional args in double quotes.
    return `provision_org "${o.orgId}" "${o.mnemonic}" "${o.email}" "${o.password}" "${o.label}" || echo "[${o.orgId}] FAILED"`;
  }).join('\n');
  return `#!/bin/sh\n${fn}\n\n${calls}\n`;
}

// Run the batched org-provisioning script inside one bootstrap container.
async function runOrgChain({ node, tmpDir }) {
  const args = [
    'compose', '--progress=plain', '-f', COMPOSE_FILE,
    '--profile', 'bootstrap',
    'run', '--rm', '-T',
    '-v', `${tmpDir}:/work`,
    `twin-bootstrap-${node}`,
    'sh', '/work/provision-orgs.sh',
  ];
  const t = Date.now();
  info(`  [${node}] running batched org chain in one container…`);
  await spawnCmd('docker', args);
  info(`  [${node}] org chain container exited (${Date.now() - t}ms)`);
}

// Provision all not-yet-provisioned orgs for a single node. Returns a map
// orgId → { orgDid, tenantId, tenantApiKey, address, email, password, mnemonic }.
async function provisionOrgsOnNode({ node, nodeMnemonic, orgs, existing, force }) {
  const todo = force ? orgs : orgs.filter(o => !existing[o.id]?.orgDid);
  const already = orgs.length - todo.length;
  if (force && orgs.length > 0) info(`  [${node}] --force: re-provisioning all ${orgs.length} org(s) (ignoring existing tenant-state)`);
  else if (already > 0) info(`  [${node}] ${already} org(s) already provisioned — skipping`);
  if (todo.length === 0) { info(`  [${node}] nothing to provision`); return {}; }
  info(`  [${node}] provisioning ${todo.length} org(s): ${todo.map(o => o.id).join(', ')}`);

  // 1. Generate a wallet per new org (offline).
  const prepared = todo.map(org => {
    const mnemonic = generateFreshMnemonic();
    const address = deriveAddress(mnemonic);
    return {
      orgId: org.id,
      name: org.name,
      mnemonic,
      address,
      email: `${org.id}@${node}.demo.local`,
      password: genPolicyPassword(),
      label: org.id,
    };
  });

  // 2. Fund the org wallets that are under the floor (one multi-output tx).
  const client = new IotaClient({ url: getFullnodeUrl('testnet') });
  const underfunded = [];
  for (const p of prepared) {
    const bal = await client.getBalance({ owner: p.address }).then(b => BigInt(b.totalBalance)).catch(() => 0n);
    if (bal < ORG_FUNDING_NANO) underfunded.push(p);
  }
  await fundOrgWallets({ node, nodeMnemonic, recipients: underfunded, amountNano: ORG_FUNDING_NANO });

  // 3. One container run: the full CLI chain for every org.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `twin-orgs-${node}-`));
  await fs.chmod(tmpDir, 0o700);
  try {
    await fs.writeFile(path.join(tmpDir, 'provision-orgs.sh'), buildOrgChainScript(prepared), { mode: 0o600 });
    await ensureDbHealthy(node);
    await runOrgChain({ node, tmpDir });

    // 4. Read back per-org results. Only orgs with a -done.json fully
    //    completed (tenant + DID + VMs + key + user). Others are left
    //    unpersisted and retried on the next run.
    const results = {};
    for (const p of prepared) {
      let done, tenant;
      try { done = JSON.parse(await fs.readFile(path.join(tmpDir, `${p.orgId}-done.json`), 'utf8')); }
      catch { warn(`  [${node}] ${p.orgId} did not complete (no done marker) — will retry on re-run`); continue; }
      try { tenant = JSON.parse(await fs.readFile(path.join(tmpDir, `${p.orgId}-tenant.json`), 'utf8')); }
      catch { warn(`  [${node}] ${p.orgId} missing tenant output despite done marker — skipping`); continue; }
      const tenantApiKey = tenant.apiKey ?? tenant.api_key ?? tenant['api-key'] ?? null;
      results[p.orgId] = {
        orgDid: done.orgDid,
        tenantId: done.tenantId,
        tenantApiKey,
        address: p.address,
        email: p.email,
        password: p.password,
        mnemonic: p.mnemonic,
      };
      ok(`  [${node}] ${p.orgId} (${p.name}) → ${done.orgDid}  tenant=${done.tenantId}`);
    }
    return results;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdProvisionOrgs({ nodeArg, force = false }) {
  const passphrase = requirePassphrase();
  const bundle = await loadBundle();
  if (!bundle) die(`no bundle at ${path.relative(ROOT, bundlePath())} — run \`twin:wallets:create\` then \`anchor\` first`);
  const addresses = await loadAddresses();
  if (!addresses) die(`no addresses file — run \`twin:wallets:create\` first`);
  const { configFile, corridor, cfg } = await loadCorridorConfig();
  info(`config: ${configFile} (corridor=${corridor})`);

  const nodes = nodesFromArg(nodeArg);

  // Load existing tenant state so we can append org provisioning and stay
  // idempotent across re-runs.
  const tenantStatePath = path.join(path.dirname(bundlePath()), 'tenant-state.json');
  let tenantState = {};
  try { tenantState = JSON.parse(await fs.readFile(tenantStatePath, 'utf8')); } catch {}
  tenantState.orgs ??= {};

  for (const node of nodes) {
    const orgs = orgsForNode(cfg, node);
    info('');
    info(`── provision-orgs [${node}] ── ${orgs.length} org(s) in config`);
    if (orgs.length === 0) { info(`  [${node}] no orgs in config.nodes.${node}.orgs — skipping`); continue; }

    const rec = bundle.wallets[node];
    if (!rec) die(`no node wallet for "${node}" — run \`anchor\` first`);
    const nodeMnemonic = decryptMnemonic(rec, passphrase);

    tenantState.orgs[node] ??= {};
    const results = await provisionOrgsOnNode({
      node, nodeMnemonic, orgs, existing: tenantState.orgs[node], force,
    });

    // Persist org wallets (encrypted) into the bundle and org tenant/DID/creds
    // into tenant-state.json, per org. The vault (<orgDID>/mnemonic on the
    // node) is the source of truth for minting; these are the CI/re-anchor
    // convenience copies (encrypted bundle + 0600 tenant-state), gitignored.
    bundle.orgWallets ??= {};
    bundle.orgWallets[node] ??= {};
    for (const [orgId, r] of Object.entries(results)) {
      bundle.orgWallets[node][orgId] = {
        ...encryptMnemonic(r.mnemonic, passphrase),
        address: r.address,
        mnemonicFingerprint: mnemonicFingerprint(r.mnemonic),
      };
      tenantState.orgs[node][orgId] = {
        orgDid: r.orgDid,
        tenantId: r.tenantId,
        tenantApiKey: r.tenantApiKey,
        address: r.address,
        email: r.email,
        password: r.password,
      };
    }
  }

  await saveBundle(bundle);
  tenantState.updatedAt = new Date().toISOString();
  await fs.writeFile(tenantStatePath, JSON.stringify(tenantState, null, 2) + '\n', { mode: 0o600 });
  info('');
  ok('provision-orgs complete');
  for (const node of nodes) {
    const n = Object.keys(tenantState.orgs[node] ?? {}).length;
    info(`  ${node}: ${n} org(s) provisioned (tenant + funded wallet + DID + VMs + user)`);
  }
  info('');
  info(`tenant-state.json updated at ${path.relative(ROOT, tenantStatePath)}`);
  info(`Next: \`CONFIG_FILE=${configFile} npm run twin:seed -- --reset-state\` (identity stage now consumes these orgs).`);
}

async function cmdAnchor({ nodeArg }) {
  const passphrase = requirePassphrase();
  const bundle = await loadBundle();
  if (!bundle) die(`no bundle at ${path.relative(ROOT, bundlePath())} — run \`twin:wallets:create\` first`);
  const addresses = await loadAddresses();
  if (!addresses) die(`no addresses file — run \`twin:wallets:create\` first`);

  const nodes = nodesFromArg(nodeArg);

  // Decrypt + fingerprint-verify all requested wallets upfront so we
  // don't start docker work and then fail on the second wallet.
  const decrypted = {};
  for (const node of nodes) {
    const rec = bundle.wallets[node];
    if (!rec) die(`no wallet for node "${node}" — known: ${Object.keys(bundle.wallets).join(', ')}`);
    const mnemonic = decryptMnemonic(rec, passphrase);
    const expectedFp = addresses.wallets[node]?.mnemonicFingerprint;
    if (expectedFp && mnemonicFingerprint(mnemonic) !== expectedFp) {
      die(`[${node}] mnemonic fingerprint mismatch — addresses.json was tampered with, or bundle and addresses are out of sync`);
    }
    decrypted[node] = { mnemonic, address: rec.address };
  }

  const results = {};
  for (const node of nodes) {
    const { mnemonic, address } = decrypted[node];
    try {
      results[node] = await anchorNode({ node, mnemonic, address });
    } catch (e) {
      err(`anchor failed for ${node}: ${e.message}`);
      throw e;
    }
  }

  // Persist tenant state for follow-up tooling (admin-API endpoints,
  // future reset diagnostics, etc.). Captured here because the
  // tenant-create container is `--rm` ephimeral: the bundle is the
  // only place we can store its outputs after the run. Path mirrors
  // the wallet bundle convention.
  const tenantStatePath = path.join(path.dirname(bundlePath()), 'tenant-state.json');
  let existingTenantState = {};
  try { existingTenantState = JSON.parse(await fs.readFile(tenantStatePath, 'utf8')); } catch {}
  const tenantState = {
    ...existingTenantState,
    updatedAt: new Date().toISOString(),
    nodes: { ...(existingTenantState.nodes ?? {}) },
  };
  for (const node of nodes) {
    const r = results[node];
    if (r) tenantState.nodes[node] = { nodeDid: r.nodeDid, orgDid: r.orgDid, tenantId: r.tenantId, tenantApiKey: r.tenantApiKey, encTenantToken: r.encTenantToken };
  }
  await fs.writeFile(tenantStatePath, JSON.stringify(tenantState, null, 2) + '\n', { mode: 0o600 });
  info(`tenant-state.json updated at ${path.relative(ROOT, tenantStatePath)}`);

  // Auto-start the runtime: with `engine-state.json` populated by the
  // chain, the runtime container starts cleanly. Operators previously
  // had to remember `npm run twin:up` after anchor — surprising. Wait
  // for the public root endpoint to confirm liveness.
  for (const node of nodes) {
    info('');
    info(`  [${node}] starting runtime…`);
    await spawnCmd(
      'docker',
      ['compose', '--progress=plain', '-f', COMPOSE_FILE, 'up', '-d', '--wait', `twin-node-${node}`],
      { quiet: true },
    );
    const port = node === 'alpha' ? 3000 : 3001;
    const deadline = Date.now() + 60_000;
    let alive = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/`);
        if (res.ok) { alive = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!alive) warn(`  [${node}] runtime not responding on :${port}/ after 60s — check \`docker logs twin-showcase-node-${node}\``);
    else info(`  [${node}] runtime ready on http://localhost:${port}`);
  }

  info('');
  ok('anchor complete');
  for (const node of nodes) {
    const r = results[node];
    if (r) info(`  ${node}: nodeDID=${r.nodeDid}  orgDID=${r.orgDid}  tenantId=${r.tenantId}`);
  }
  info('');
  info(`Next: \`npm run twin:status\` to verify, then \`CONFIG_FILE=… npm run twin:seed -- --reset-state\`.`);
}

// `err` is normally only used internally by main(); expose it for the
// anchor pipeline's failure path.
function err(msg) { console.error(`[wallets] ERROR: ${msg}`); }

// ── Help ──────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`Usage: node scripts/twin/wallets.mjs <subcommand> [--node=alpha|beta|both]

Subcommands:
  create    Generate-or-reuse wallet(s). Writes the encrypted bundle and
            the cleartext addresses file. Offline; no network.
  show      Print current addresses from the addresses file (no decrypt).
  reveal    Decrypt and print the mnemonic. Requires WALLET_PASSPHRASE.
  balance   Query IOTA testnet RPC for current balance.
  rekey     Rotate WALLET_PASSPHRASE_OLD → WALLET_PASSPHRASE. Same
            mnemonic + address, new salt+nonce+ciphertext.
  anchor    Run the granular identity-create chain against the bootstrap
            container, using a pre-funded wallet. Never calls the faucet.
  provision-orgs
            T-316: per-org tenant + funded wallet + seed-bound DID. Reads the
            active corridor config (CONFIG_FILE), and for every org generates a
            wallet, funds it from the node wallet (one multi-output transfer
            per node), and provisions tenant + DID (CLI identity-create
            --mnemonic) + VMs + user in ONE container run per node. Idempotent:
            skips orgs already in tenant-state.json. Run AFTER \`anchor\`.
            Pass --force to re-provision all orgs ignoring existing state
            (use after \`twin:reset\`, which wipes the node but leaves stale
            orgs.* in tenant-state.json).

Env:
  WALLET_PASSPHRASE       Required for create/reveal/rekey/anchor/provision-orgs.
  WALLET_PASSPHRASE_OLD   Required for rekey (the current passphrase).
  CONFIG_FILE             Corridor config for provision-orgs (default:
                          configs/vietnam-us.json).
  ORG_FUNDING_IOTA        IOTA per org wallet (default: 2; floor is >1 — each
                          on-chain op reserves a 1-IOTA gas budget).
  WALLET_BUNDLE_PATH      Optional override for the encrypted bundle path
                          (default: ${path.relative(ROOT, DEFAULT_BUNDLE_PATH)}).
                          The addresses file is derived from this path.
`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }
  const subcommand = argv[0];
  const opts = parseArgs(argv.slice(1));
  if (opts.help) { printHelp(); return; }

  switch (subcommand) {
    case 'create':  return cmdCreate({ nodeArg: opts.node });
    case 'show':    return cmdShow({ nodeArg: opts.node });
    case 'reveal':  return cmdReveal({ nodeArg: opts.node });
    case 'balance': return cmdBalance({ nodeArg: opts.node });
    case 'rekey':   return cmdRekey({ nodeArg: opts.node });
    case 'anchor':  return cmdAnchor({ nodeArg: opts.node });
    case 'provision-orgs': return cmdProvisionOrgs({ nodeArg: opts.node, force: opts.force });
    default: die(`unknown subcommand: ${subcommand}. Run with --help.`);
  }
}

main().catch(e => {
  // Expected user-facing failures (bad passphrase, missing files) carry
  // their own readable message; suppress the stack trace so the operator
  // sees a clean error. The DEBUG env var brings the stack back for
  // genuine bugs.
  if (process.env.DEBUG) console.error(`[wallets] FATAL: ${e.stack || e.message}`);
  else console.error(`[wallets] FATAL: ${e.message}`);
  process.exit(1);
});
