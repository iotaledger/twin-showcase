#!/usr/bin/env node
/**
 * T-241 — Config-driven TWIN Node seeder.
 *
 * Reads the active corridor config (CONFIG_FILE env or configs/vietnam-us.json
 * by default) and populates both TWIN Nodes (Alpha :3000, Beta :3001) with
 * the demo's initial data via the DockerAdapter REST calls. Switching the
 * config and re-running produces a different corridor's data set on the
 * same nodes — that's the whole point of a corridor-agnostic demo.
 *
 * Categories (--only filter):
 *   identity      — createDid + provisionOrgUser per org in nodes.{alpha,beta}.orgs
 *   consignments  — createAigVertex per consignment in consignments.{alpha,beta}
 *   documents     — generate PDF/XML from documentTemplates, storeDocument
 *                   (which also issues the org-signed attestation)
 *   finance       — NOT IMPLEMENTED: T-219 (finance adapter routes) is still
 *                   in backlog, so the corresponding adapter methods don't
 *                   exist yet. Listed for forward-compat — selecting it will
 *                   print a warning and skip.
 *
 * Idempotency:
 *   Results are persisted to data/seed-state.json keyed by configFile +
 *   corridor + node + category + sourceId. Re-running skips entries that
 *   already have a TWIN resource id. Use --force to ignore the state file.
 *
 * Usage:
 *   node scripts/seed-twin-nodes.js                       # full seed, default config, both nodes
 *   node scripts/seed-twin-nodes.js --only=identity       # only orgs+DIDs
 *   node scripts/seed-twin-nodes.js --only=identity,consignments
 *   node scripts/seed-twin-nodes.js --node=alpha          # only Alpha
 *   node scripts/seed-twin-nodes.js --config=configs/cambodia-eu.json
 *   node scripts/seed-twin-nodes.js --dry-run             # no network calls, print plan
 *   node scripts/seed-twin-nodes.js --force               # re-seed even if state has entry
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig } from '../server/config.js';
import { createAndInitAdapter, resolveOrgTenant } from '../server/adapter/index.js';
import { makeSeedPdf } from '../server/generators/pdf.js';
import { makeSeedXml } from '../server/generators/xml.js';
import { buildVerifyUrl } from '../server/qr.js';
import { sha256OfBuffer, explorerUrlFromImmutableProof, extractImmutableReceipt, iotaExplorerUrlFromDid, iotaExplorerUrlFromAttestationId } from '../server/utils.js';
import { consignmentToUnece } from '../server/twin/unece.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SEED_STATE_PATH = path.join(ROOT, 'data', 'seed-state.json');

const CATEGORIES = ['identity', 'consignments', 'documents', 'finance'];
const NODES = ['alpha', 'beta'];

// Seed defaults — every consignment + doc template in the active corridor
// config gets an on-chain anchor so the demo UI shows "On ledger" green
// on every visible doc, never the misleading "Demo mode" pill. T-244
// (2026-05-27) removed the previous caps (was 2 / 3): the partial-
// coverage default produced confusing mixed-mode UI when light defaults
// silently skipped the 4th / 5th doc template. Pass --max-consignments=N
// / --max-docs=N explicitly to opt back into the old light-seed behaviour.
const DEFAULTS = {
  maxConsignments: 0,  // 0 = no cap
  maxDocs:         0,  // 0 = no cap
  throttleMs:    500,  // sleep between successful TWIN calls
};
// Per-document poll for the asynchronous TWIN signing pass. After
// createImmutableProof returns the proofId, the node still needs ~5-15 s
// (observed up to ~35 s on the testnet) to sign + index the proof. Poll
// getImmutableProof for up to PROOF_READY_TIMEOUT_MS so seed-state.json
// carries proofExplorerUrl / receipt right away — the demo then shows
// "On ledger" instead of "Writing to ledger" without the user clicking
// the verify button.
const PROOF_READY_TIMEOUT_MS  = 50_000;
const PROOF_READY_INTERVAL_MS =  2_000;
const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

// Retry a single node call that can transiently fail. Late in a long seed the
// TWIN node can briefly stop responding under load (observed as
// `fetchHelper.general`), which previously dropped the last documents of the
// last consignment to "Demo mode" (T-4V03: 00107-PL/-BL). A couple of
// backoff retries let the node recover and the doc anchor on a later attempt.
const RETRY_TRIES   = 3;
const RETRY_BASE_MS = 4_000;
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_TRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_TRIES) {
        warn(`  retry ${attempt}/${RETRY_TRIES - 1} after ${label} failed: ${String(e.message).slice(0, 60)}`);
        await sleep(RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastErr;
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    only: null, node: 'both', dryRun: false, force: false, resetState: false,
    full: false,
    maxConsignments: DEFAULTS.maxConsignments,
    maxDocs:         DEFAULTS.maxDocs,
    throttleMs:      DEFAULTS.throttleMs,
    help: false,
  };
  const parseInt0 = (s, name) => {
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n) || n < 0) die(`--${name} must be a non-negative integer, got "${s}"`);
    return n;
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--reset-state') out.resetState = true;
    else if (arg === '--full') out.full = true;
    else if (arg.startsWith('--only=')) {
      out.only = arg.slice(7).split(',').map(s => s.trim()).filter(Boolean);
      const unknown = out.only.filter(c => !CATEGORIES.includes(c));
      if (unknown.length) die(`unknown --only category: ${unknown.join(', ')}. Valid: ${CATEGORIES.join(', ')}`);
    } else if (arg.startsWith('--node=')) {
      const v = arg.slice(7);
      if (v !== 'alpha' && v !== 'beta' && v !== 'both') die(`--node must be alpha|beta|both, got ${v}`);
      out.node = v;
    } else if (arg.startsWith('--config=')) {
      process.env.CONFIG_FILE = path.resolve(arg.slice(9));
    } else if (arg.startsWith('--max-consignments=')) {
      out.maxConsignments = parseInt0(arg.slice('--max-consignments='.length), 'max-consignments');
    } else if (arg.startsWith('--max-docs=')) {
      out.maxDocs = parseInt0(arg.slice('--max-docs='.length), 'max-docs');
    } else if (arg.startsWith('--throttle=')) {
      out.throttleMs = parseInt0(arg.slice('--throttle='.length), 'throttle');
    } else {
      die(`unknown argument: ${arg}. Run with --help.`);
    }
  }
  // --full disables the light-seed caps and removes throttle, unless any of
  // those flags was also passed explicitly (the explicit value wins).
  if (out.full) {
    if (!argv.includes('--max-consignments=' + out.maxConsignments)) out.maxConsignments = 0;
    if (!argv.some(a => a.startsWith('--max-docs='))) out.maxDocs = 0;
    if (!argv.some(a => a.startsWith('--throttle='))) out.throttleMs = 0;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/seed-twin-nodes.js [options]

Options:
  --only=cat1,cat2     Seed only these categories. Valid: ${CATEGORIES.join(', ')}.
                       Default: all except finance (not yet implemented).
  --node=alpha|beta|both    Which TWIN node(s) to seed (default: both).
  --config=path/to/config.json    Override the corridor config file.
                                  Equivalent to CONFIG_FILE=path.
  --max-consignments=N        Cap consignments per node (default: ${DEFAULTS.maxConsignments}, 0 = no cap).
                              Identity (orgs) is never capped — it's foundational.
                              Set to N>0 for the old light-seed shape.
  --max-docs=N                Cap documents per consignment (default: ${DEFAULTS.maxDocs}, 0 = no cap).
                              Set to N>0 for the old light-seed shape.
  --throttle=MS               Sleep MS between successful TWIN calls
                              (default: ${DEFAULTS.throttleMs}ms). Prevents saturating the
                              node's background-task queue on a real deploy.
  --full                      Shortcut: --throttle=0 (caps are already 0 by
                              default since T-244). Explicit flags above
                              override.
  --dry-run            Plan only — no network calls, no state file write.
  --force              Re-seed entries already present in data/seed-state.json.
  --reset-state        Delete data/seed-state.json before seeding (forgets which
                       resources were already created locally; on-chain
                       resources stay anchored on the TWIN nodes — to wipe
                       those too, use 'npm run twin:reseed').
  -h, --help           Show this help.

Defaults anchor every consignment + doc template in the active corridor
config (no caps, so the demo UI shows "On ledger" on every visible doc
instead of a mix of "On ledger" / "Demo mode"). Per-doc seeding adds
storeDocument + createImmutableProof + a ~5-15 s poll for the on-chain
anchor to land. Pass --max-consignments=N / --max-docs=N to restore the
old light-seed behaviour. Resumes from data/seed-state.json by default.
For a clean TWIN node state, use 'npm run twin:reseed' (chains
twin:reset + twin:bootstrap + twin:seed).`);
}

const die = (msg) => { console.error(`[seed] ERROR: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`[seed] ${msg}`);
const warn = (msg) => console.warn(`[seed] WARN: ${msg}`);
const ok   = (msg) => console.log(`[seed] OK ${msg}`);

// ── State file ────────────────────────────────────────────────────────────
async function loadSeedState() {
  try {
    const buf = await fs.readFile(SEED_STATE_PATH, 'utf8');
    return JSON.parse(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`could not read ${SEED_STATE_PATH}: ${e.message} — starting fresh`);
    return null;
  }
}

function emptyState(configFile, corridor) {
  return {
    configFile,
    corridor,
    timestamp: new Date().toISOString(),
    alpha: { orgs: {}, consignments: {}, documents: {} },
    beta:  { orgs: {}, consignments: {}, documents: {} },
  };
}

async function saveSeedState(state) {
  state.timestamp = new Date().toISOString();
  await fs.mkdir(path.dirname(SEED_STATE_PATH), { recursive: true });
  await fs.writeFile(SEED_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── Per-category seeders ─────────────────────────────────────────────────
async function seedIdentity({ adapter, nodeId, state, orgs, dryRun, force, throttleMs }) {
  let created = 0, skipped = 0, partial = 0, errored = 0, preprovisioned = 0;
  for (const org of orgs) {
    const existing = state[nodeId].orgs[org.id];
    if (existing?.did && !force) { skipped++; continue; }

    if (dryRun) {
      const pp = resolveOrgTenant(nodeId, org.id);
      info(`  [${nodeId}/identity] ${pp?.orgDid ? `would consume pre-provisioned tenant ${pp.tenantId}` : 'would createDid + provisionOrgUser'} for ${org.id} (${org.name})`);
      state[nodeId].orgs[org.id] = { did: '<dry-run>', email: '<dry-run>', password: '<dry-run>', dryRun: true };
      created++;
      continue;
    }

    // T-316: prefer the per-org tenant provisioned by `wallets.mjs
    // provision-orgs` (own tenant + funded wallet + seed-bound DID + user).
    // Its DID has <orgDID>/mnemonic in the vault, so this org can mint the
    // standard attestation NFT. The REST path below (adapter.createDid) is the
    // fallback for orgs not pre-provisioned (no wallet → can't mint).
    const provisioned = resolveOrgTenant(nodeId, org.id);
    if (provisioned?.orgDid && provisioned?.email && provisioned?.password) {
      state[nodeId].orgs[org.id] = {
        did: provisioned.orgDid,
        explorerUrl: iotaExplorerUrlFromDid(provisioned.orgDid) ?? '',
        verificationMethodId: 'org-assertion',
        email: provisioned.email,
        password: provisioned.password,
        tenantApiKey: provisioned.tenantApiKey ?? null,
        provisionedTenant: provisioned.tenantId,
      };
      await saveSeedState(state);
      ok(`  [${nodeId}/identity] ${org.id} (${org.name}) → ${provisioned.orgDid} (pre-provisioned tenant ${provisioned.tenantId})`);
      created++; preprovisioned++;
      continue;
    }

    // Outer try so a transient testnet error on one org doesn't kill the run.
    let did, explorerUrl, verificationMethodId;
    const t = Date.now();
    try {
      ({ did, explorerUrl, verificationMethodId } = await adapter.createDid());
    } catch (e) {
      warn(`  [${nodeId}/identity] ${org.id} (${org.name}) → createDid failed: ${e.message} (continuing)`);
      errored++;
      continue;
    }

    // Persist the DID before attempting provisionOrgUser — if provisioning
    // fails, we'd otherwise lose the just-paid-for DID on a re-run.
    state[nodeId].orgs[org.id] = { did, explorerUrl, verificationMethodId };
    await saveSeedState(state);

    try {
      const creds = await adapter.provisionOrgUser({ orgId: org.id, did });
      state[nodeId].orgs[org.id] = { ...state[nodeId].orgs[org.id], ...creds };
      ok(`  [${nodeId}/identity] ${org.id} (${org.name}) → ${did} (${Date.now() - t}ms)`);
      created++;
      await sleep(throttleMs);
    } catch (e) {
      // Two known failure modes the DID-was-minted recovery path handles:
      //   userExists       — a prior UI registration already created the
      //                      {orgId}@{node}.demo.local user. DID kept, no creds.
      //   repeatedCharacters — provisionOrgUser's random password failed TWIN's
      //                       password policy. Pre-existing bug in docker.js;
      //                       --force re-runs may eventually generate a valid one.
      const userExists = /userExists/.test(e.message);
      const badPassword = /repeatedCharacters/.test(e.message);
      const reason = userExists ? `TWIN user ${org.id}@${nodeId}.demo.local already exists (prior provision)`
                   : badPassword ? `random password tripped TWIN policy (repeatedCharacters) — re-run with --force to retry`
                   : `provisionOrgUser failed: ${e.message}`;
      warn(`  [${nodeId}/identity] ${org.id} (${org.name}) → ${did} — DID saved, ${reason}`);
      partial++;
    }
    await saveSeedState(state);
  }
  info(`[${nodeId}/identity] done (${created} seeded${preprovisioned ? ` — ${preprovisioned} from pre-provisioned tenants` : ''}, ${partial} partial — DID only, ${skipped} skipped, ${errored} errored)`);
}

async function seedConsignmentsCategory({ adapter, nodeId, state, consignments, dryRun, force, throttleMs, maxItems }) {
  let created = 0, skipped = 0, errored = 0;
  const slice = maxItems > 0 ? consignments.slice(0, maxItems) : consignments;
  const capped = maxItems > 0 && consignments.length > maxItems;
  if (capped) info(`  [${nodeId}/consignments] capping to first ${maxItems} of ${consignments.length} (override with --max-consignments=0 or --full)`);
  for (const c of slice) {
    const existing = state[nodeId].consignments[c.ucr];
    if (existing?.aigVertexId && !force) { skipped++; continue; }

    if (dryRun) {
      info(`  [${nodeId}/consignments] would createAigVertex for ${c.ucr} (${c.product})`);
      state[nodeId].consignments[c.ucr] = { aigVertexId: '<dry-run>', dryRun: true };
      created++;
      continue;
    }

    // T-305: serialise the seed consignment with the UNECE D23B vocabulary
    // so AIG vertices match what the TWIN Supply Chain module + downstream
    // gov-interop consumers expect. The transformer also preserves the
    // demo-specific fields (status, exportDeclarationNo) under
    // additionalProperty so AIG round-trips them losslessly.
    // The seed config calls the invoice field `invoiceRef`; map it onto
    // `commercialInvoiceNo` (the demo's runtime field name) so the
    // transformer picks it up under `transactionalReference`.
    const annotation = consignmentToUnece({
      ...c,
      // Deterministic id matching the in-memory store (server/seed.js: `seed-${ucr}`)
      // so the node-authoritative read-back yields the same consignment id the UI,
      // sharing, and permissions key by — see flatFromAigVertex.
      id: c.id ?? `seed-${c.ucr}`,
      // The node this consignment is seeded on (the demo runs the seed per node).
      originNode: nodeId,
      commercialInvoiceNo: c.commercialInvoiceNo ?? c.invoiceRef,
      exportDeclarationNo: c.exportDeclarationNo ?? c.declRef,
    });
    const aliases = [{ id: c.ucr, aliasFormat: 'urn:moit:ucr' }];

    try {
      const t = Date.now();
      const vertex = await adapter.createAigVertex({ annotationObject: annotation, aliases });
      // kitsune-client.ts returns { aigVertexId: string }
      const aigVertexId = typeof vertex === 'string' ? vertex : (vertex?.aigVertexId ?? null);
      state[nodeId].consignments[c.ucr] = { aigVertexId, status: c.status };
      ok(`  [${nodeId}/consignments] ${c.ucr} → ${aigVertexId} (${Date.now() - t}ms)`);
      created++;
      await saveSeedState(state);
      await sleep(throttleMs);
    } catch (e) {
      warn(`  [${nodeId}/consignments] ${c.ucr} failed: ${e.message}`);
      errored++;
    }
  }
  info(`[${nodeId}/consignments] done (${created} created, ${skipped} skipped, ${errored} errored${capped ? `, ${consignments.length - maxItems} not attempted (cap)` : ''})`);
}

async function seedDocumentsCategory({ adapter, nodeId, state, consignments, docTemplates, dryRun, force, throttleMs, maxConsignments, maxDocs }) {
  if (!docTemplates?.length) {
    warn(`[${nodeId}/documents] no document templates in config.documents.${nodeId} — skipping`);
    return;
  }
  let created = 0, skipped = 0, errored = 0;
  // Cap to the same consignment slice the consignments seeder used, so we
  // don't generate orphan docs for consignments that have no AIG vertex.
  const cSlice = maxConsignments > 0 ? consignments.slice(0, maxConsignments) : consignments;
  const dSlice = maxDocs > 0 ? docTemplates.slice(0, maxDocs) : docTemplates;
  if (maxConsignments > 0 && consignments.length > maxConsignments) {
    info(`  [${nodeId}/documents] capping consignments to first ${maxConsignments} of ${consignments.length}`);
  }
  if (maxDocs > 0 && docTemplates.length > maxDocs) {
    info(`  [${nodeId}/documents] capping doc templates per consignment to first ${maxDocs} of ${docTemplates.length}`);
  }
  for (const c of cSlice) {
    for (const d of dSlice) {
      const docId = `seed-${c.ucr}-${d.suffix}`;
      const existing = state[nodeId].documents[docId];
      if (existing?.documentManagementId && !force) { skipped++; continue; }

      const ref = d.suffix === 'INV' ? c.invoiceRef
                : d.suffix === 'ED'  ? c.declRef
                : `${d.suffix}-${c.ucr.split('-').pop()}`;
      // Same XML-eligible suffix set as server/seed.js. If the docType has no
      // matching xmlTemplate in the config, makeSeedXml returns null and we
      // fall back to the PDF generator (mirrors seed.js behavior).
      const xmlEligible = ['BL', 'ED', 'BOM', 'CO'].includes(d.suffix);
      const issuer = d.issuerOrgId === 'creator' ? c.creatorOrgName : (d.issuerName || c.creatorOrgName);
      const xmlContent = xmlEligible ? makeSeedXml(d.docType, c, ref) : null;
      const isXml = !!xmlContent;
      // T-4V03 (WP4): embed the same verification QR the server generator
      // embeds, so the docker-seeded blob is byte-identical to what
      // server/seed.js generates for the same config (the seed-state hash
      // must match the blob the UI serves). Requires the SAME
      // PUBLIC_BASE_URL at seed time and at server run time.
      const blob = isXml
        ? Buffer.from(xmlContent, 'utf8')
        : Buffer.from(
            makeSeedPdf(d.docType, ref, issuer, c.ucr, c.shipDate, c.exporter, c.importer, c.fromCountry, c.toCountry,
              { verifyUrl: buildVerifyUrl({ docId, ucr: c.ucr, docType: d.docType, issuer, nodeId }) }),
            'base64',
          );
      const filename = isXml ? `${ref}.xml` : `${ref}.pdf`;
      const contentType = isXml ? 'application/xml' : 'application/pdf';
      const sha256 = sha256OfBuffer(blob);

      if (dryRun) {
        info(`  [${nodeId}/documents] would storeDocument ${docId} (${filename}, ${blob.length}B, sha256=${sha256.slice(0,18)}…)`);
        state[nodeId].documents[docId] = { documentManagementId: '<dry-run>', hash: sha256, dryRun: true };
        created++;
        continue;
      }

      try {
        const t = Date.now();
        // Retried: storeDocument uses a fixed documentId, so a retry after a
        // transient node error is idempotent (same id) and recovers the doc
        // instead of dropping it to "Demo mode".
        const result = await withRetry(() => adapter.storeDocument(blob, {
          documentId: docId,
          documentCode: 'unece:DocumentCodeList#380', // commercial document — refinement deferred
          filename,
          contentType,
          sha256,
          title: d.name,
          creator: { name: c.creatorOrgName },
          relatedTo: c.ucr,
          createAttestation: false, // T-316: the org-signed attestation is minted separately below via createAttestationAs (issuer org's own tenant + funded wallet), not the document-management bundled one (node-admin signed)
        }), `storeDocument ${docId}`);

        // T-243: also anchor an immutable proof so the seeded doc matches
        // what POST /api/documents produces from the UI. Without this step
        // the NotarizationBadge falls back to "Demo mode" because
        // notarizationMode is undefined. Envelope shape mirrors the one
        // built in server/routes/documents.js so the on-chain hash is
        // identical to a freshly-uploaded copy of the same file.
        const envelope = {
          '@context': 'https://schema.org',
          '@type': 'DigitalDocument',
          identifier: docId,
          name: d.name,
          contentSize: blob.length,
          sha256,
          dateCreated: new Date().toISOString(),
          creator: { '@type': 'Organization', name: c.creatorOrgName },
          about: { '@type': 'Thing', identifier: c.ucr },
        };
        let proofId = null, proofExplorerUrl = null, receipt = null, notarizationError = null;
        try {
          const p = await withRetry(() => adapter.createImmutableProof(envelope), `createImmutableProof ${docId}`);
          proofId = p.proofId;
          // T-244: TWIN signs the proof asynchronously (~5-15 s on testnet).
          // Poll getImmutableProof up to PROOF_READY_TIMEOUT_MS so the
          // verifiableStorageId / proofExplorerUrl land in seed-state.json
          // and the demo can show "On ledger" green immediately, instead of
          // "Writing to ledger" until the user clicks the verify button.
          // Times out gracefully — the demo's POST /verify endpoint still
          // backfills missing fields on demand.
          const proofDeadline = Date.now() + PROOF_READY_TIMEOUT_MS;
          while (Date.now() < proofDeadline) {
            try {
              const proof = await adapter.getImmutableProof(proofId);
              const url = explorerUrlFromImmutableProof(proof);
              const r = extractImmutableReceipt(proof);
              if (url || r?.verifiableStorageId) {
                proofExplorerUrl = url;
                receipt = r;
                break;
              }
            } catch { /* transient — keep polling until the deadline */ }
            await sleep(PROOF_READY_INTERVAL_MS);
          }
          if (!proofExplorerUrl) {
            warn(`  [${nodeId}/documents] ${docId} proof ${proofId} not anchored within ${PROOF_READY_TIMEOUT_MS/1000}s — /verify in the demo will backfill`);
          }
        } catch (e) {
          notarizationError = e.message;
        }

        // T-316: org-signed attestation (standard NFT) by the document's
        // issuer org, mirroring the runtime POST /api/documents flow. Uses the
        // issuer's pre-provisioned per-org tenant creds (own DID + funded
        // wallet + <orgDID>/mnemonic). Skipped silently if the issuer wasn't
        // provisioned with a wallet (REST-only org → can't mint) — the
        // immutable proof above still anchors the doc node-side.
        let orgAttestationId = null, orgAttestationExplorerUrl = null, orgAttestationError = null;
        const issuerOrgId = (!d.issuerOrgId || d.issuerOrgId === 'creator') ? c.creatorOrgId : d.issuerOrgId;
        const issuerOrg = issuerOrgId ? state[nodeId].orgs[issuerOrgId] : null;
        if (issuerOrg?.email && issuerOrg?.password && issuerOrg?.did) {
          try {
            const r = await withRetry(() => adapter.createAttestationAs(
              { orgId: issuerOrgId, email: issuerOrg.email, password: issuerOrg.password, did: issuerOrg.did, tenantApiKey: issuerOrg.tenantApiKey },
              envelope,
            ), `createAttestationAs ${docId}`);
            orgAttestationId = r.attestationId;
            orgAttestationExplorerUrl = iotaExplorerUrlFromAttestationId(orgAttestationId);
          } catch (e) {
            orgAttestationError = e.message;
          }
        }

        state[nodeId].documents[docId] = {
          documentManagementId: result.documentManagementId,
          hash: result.hash ?? sha256,
          size: result.size ?? blob.length,
          docType: d.docType,
          consignmentUcr: c.ucr,
          // T-243: fields hydrated by server/seed.js into store.documents[]
          // so the NotarizationBadge reaches the "anchored"/"verified"
          // state on a seeded doc, not "Demo mode".
          notarizationMode: adapter.mode,
          proofId,
          proofExplorerUrl,
          receipt,
          envelope,
          // T-316: org-signed attestation NFT (null for REST-only orgs).
          orgAttestationId,
          orgAttestationExplorerUrl,
          ...(orgAttestationError ? { orgAttestationError } : {}),
          ...(notarizationError ? { notarizationError } : {}),
        };
        const proofPart = proofId
          ? ` proof=${proofId.slice(0, 28)}…`
          : (notarizationError ? ` proof=FAILED:${notarizationError.slice(0, 40)}` : '');
        const attPart = orgAttestationId
          ? ` orgAtt=${orgAttestationId.slice(0, 24)}…`
          : (orgAttestationError ? ` orgAtt=FAILED:${orgAttestationError.slice(0, 40)}` : '');
        ok(`  [${nodeId}/documents] ${docId} → ${result.documentManagementId}${proofPart}${attPart} (${Date.now() - t}ms)`);
        created++;
        await saveSeedState(state);
        await sleep(throttleMs);
      } catch (e) {
        errored++;
        warn(`  [${nodeId}/documents] ${docId} failed: ${e.message}`);
      }
    }
  }
  info(`[${nodeId}/documents] done (${created} created, ${skipped} skipped, ${errored} errored)`);
}

function seedFinanceCategory({ nodeId }) {
  warn(`[${nodeId}/finance] not implemented — T-219 (adapter finance routes) is in backlog. ` +
       `Once finance routes are wired, this seeder will populate payments, LCs, and smart contracts ` +
       `from config.finance.seedData. For now, the demo server's in-memory seedFinanceData() at ` +
       `server/seed.js still covers the demo UI.`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }

  const cfg = loadConfig();
  if (!cfg) die('no corridor config found. Set CONFIG_FILE or check configs/vietnam-us.json exists.');
  if (!cfg.corridor?.id) die('config has no corridor.id field');

  const configFile = process.env.CONFIG_FILE
    ? path.resolve(process.env.CONFIG_FILE)
    : path.join(ROOT, 'configs', 'vietnam-us.json');

  // Default categories: everything except finance (not implementable yet).
  const categories = opts.only ?? CATEGORIES.filter(c => c !== 'finance');
  const nodes = opts.node === 'both' ? NODES : [opts.node];

  info(`config: ${path.relative(ROOT, configFile)} (corridor=${cfg.corridor.id})`);
  info(`nodes: ${nodes.join(', ')}`);
  info(`categories: ${categories.join(', ')}`);
  info(`limits: max-consignments=${opts.maxConsignments || 'none'}, max-docs=${opts.maxDocs || 'none'}, throttle=${opts.throttleMs}ms${opts.full ? ' (--full)' : ''}`);
  if (opts.dryRun) info('mode: DRY RUN (no network, no state write)');
  if (opts.force) info('mode: FORCE (re-seed entries already in state)');
  if (opts.resetState) info('mode: RESET STATE (forget local state — on-chain data stays anchored)');

  // Optional local state reset (does NOT touch the TWIN nodes — that's
  // 'npm run twin:reseed').
  if (opts.resetState && !opts.dryRun) {
    try { await fs.unlink(SEED_STATE_PATH); info(`deleted ${path.relative(ROOT, SEED_STATE_PATH)}`); }
    catch (e) { if (e.code !== 'ENOENT') warn(`could not delete state file: ${e.message}`); }
  }

  // Load or initialise state.
  let state = await loadSeedState();
  if (!state || state.corridor !== cfg.corridor.id) {
    if (state && state.corridor !== cfg.corridor.id) {
      info(`state corridor mismatch (was=${state.corridor}, now=${cfg.corridor.id}) — starting fresh`);
    }
    state = emptyState(path.relative(ROOT, configFile), cfg.corridor.id);
  }

  // Initialise adapters.
  const adapters = {};
  if (!opts.dryRun) {
    for (const nodeId of nodes) {
      try {
        info(`init adapter for ${nodeId}…`);
        adapters[nodeId] = await createAndInitAdapter('docker', nodeId);
        await adapters[nodeId].warmUp();
      } catch (e) {
        die(`could not connect to TWIN node ${nodeId}: ${e.message}. Is it running? (npm run twin:up)`);
      }
    }
  }

  // Run seeders.
  for (const nodeId of nodes) {
    const orgs = cfg.nodes?.[nodeId]?.orgs ?? [];
    const consignments = cfg.consignments?.[nodeId] ?? [];
    const docTemplates = cfg.documents?.[nodeId] ?? [];
    info('');
    info(`── ${nodeId.toUpperCase()} ── orgs=${orgs.length} consignments=${consignments.length} docTemplates=${docTemplates.length}`);

    if (categories.includes('identity')) {
      await seedIdentity({ adapter: adapters[nodeId], nodeId, state, orgs, dryRun: opts.dryRun, force: opts.force, throttleMs: opts.throttleMs });
    }
    if (categories.includes('consignments')) {
      await seedConsignmentsCategory({ adapter: adapters[nodeId], nodeId, state, consignments, dryRun: opts.dryRun, force: opts.force, throttleMs: opts.throttleMs, maxItems: opts.maxConsignments });
    }
    if (categories.includes('documents')) {
      await seedDocumentsCategory({ adapter: adapters[nodeId], nodeId, state, consignments, docTemplates, dryRun: opts.dryRun, force: opts.force, throttleMs: opts.throttleMs, maxConsignments: opts.maxConsignments, maxDocs: opts.maxDocs });
    }
    if (categories.includes('finance')) {
      seedFinanceCategory({ nodeId });
    }
  }

  if (!opts.dryRun) await saveSeedState(state);
  info('');
  ok(`seed complete. state: ${path.relative(ROOT, SEED_STATE_PATH)}`);
}

main().catch(e => {
  console.error('[seed] FATAL:', e.stack || e.message);
  process.exit(1);
});
