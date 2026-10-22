#!/usr/bin/env node
// T-4V03 (WP3) — customs declaration system simulator.
//
// Plays the role of a customs declaration system calling the demo's
// verification API over plain REST: given a declaration reference (UCR or
// 12-digit declaration number), it pulls provenance verification for every
// supporting document and prints a channeling recommendation — exactly the
// integration a real customs risk engine would run. This is the artifact
// for the "data contributor" conversation.
//
// Usage:
//   node scripts/customs-system-simulator.mjs --ref VN-2026-EXP-00101
//   node scripts/customs-system-simulator.mjs --ref 304126011890 --base http://localhost:4000
//   node scripts/customs-system-simulator.mjs --list            # show seeded refs first
//
// Options:
//   --ref <ucr|declarationNo>   declaration to verify (required unless --list)
//   --base <url>                demo node base URL    (default http://localhost:4000)
//   --token <token>             service-account token (default demo-customs-integration)

const args = process.argv.slice(2).reduce((a, c, i, arr) => {
  if (c.startsWith('--')) a[c.slice(2)] = arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? true : arr[i + 1];
  return a;
}, {});

const BASE = (args.base ?? 'http://localhost:4000').replace(/\/+$/, '');
const TOKEN = args.token ?? 'demo-customs-integration';

const COLORS = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m' };
const paint = (color, s) => `${COLORS[color] ?? ''}${s}${COLORS.reset}`;

async function api(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-service-token': TOKEN } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
  return body;
}

async function main() {
  if (args.list) {
    // The queue endpoint is UI-facing (orgId), so listing rides the public
    // consignment list of the seeded export customs org would need auth —
    // instead just probe the documented seed refs.
    console.log('Seeded declaration refs follow the pattern VN-2026-EXP-001xx / VN-2026-EXP-E001.');
    console.log('Try: node scripts/customs-system-simulator.mjs --ref VN-2026-EXP-00101');
    return;
  }
  if (!args.ref || args.ref === true) {
    console.error('Missing --ref <ucr|declarationNo>. Try --ref VN-2026-EXP-00101');
    process.exit(1);
  }

  console.log(`${COLORS.bold}Customs declaration system simulator${COLORS.reset} ${COLORS.dim}(system-to-system REST, token auth)${COLORS.reset}`);
  console.log(`${COLORS.dim}GET ${BASE}/api/verify/consignment/${args.ref}${COLORS.reset}\n`);

  const d = await api(`/api/verify/consignment/${encodeURIComponent(args.ref)}`);

  console.log(`Declaration ${COLORS.bold}${d.declarationNo ?? '—'}${COLORS.reset} (${d.declarationType ?? '—'})  UCR ${d.ucr}`);
  console.log(`Office: ${d.customsOffice ?? '—'}   Status: ${d.status}`);
  console.log(`Current channel: ${paint(d.channel, (d.channel ?? '—').toUpperCase())}\n`);

  console.log('Supporting documents:');
  for (const doc of d.documents) {
    const mark = doc.verified ? paint('green', 'VERIFIED ')
      : doc.anchored ? paint('yellow', 'ANCHORED ')
      : doc.simulatedProvenance ? paint('green', 'SIM-OK   ')
      : paint('red', 'NO PROOF ');
    const issuer = doc.issuerDid ? `${doc.issuerName} ${COLORS.dim}${doc.issuerDid.slice(0, 28)}…${COLORS.reset}` : doc.issuerName;
    console.log(`  ${mark} ${doc.docType.padEnd(28)} ${doc.reference ?? ''}  ${COLORS.dim}issuer:${COLORS.reset} ${issuer}`);
  }

  if (d.originComposition) {
    const oc = d.originComposition;
    const flag = oc.evidenceIncomplete ? paint('red', ' EVIDENCE INCOMPLETE') : '';
    console.log(`\nOrigin composition: ${oc.localContentPercent}% local (${oc.calculationMethod}, threshold ${oc.threshold}%)${flag}`);
  }

  const rec = d.channelRecommendation;
  console.log(`\nDossier: ${d.dossier.anchoredCount}/${d.dossier.requiredCount} required documents anchored — ${d.dossier.dossierVerified ? paint('green', 'verified') : paint('yellow', 'NOT fully verified')}`);
  console.log(`Channel recommendation: ${paint(rec.recommended, rec.recommended.toUpperCase())}`);
  console.log(`${COLORS.dim}Basis: ${rec.basis}${COLORS.reset}`);
  console.log(`${COLORS.dim}${rec.decisionOwner}.${COLORS.reset}`);
}

main().catch(e => {
  console.error(paint('red', `Error: ${e.message}`));
  process.exit(1);
});
