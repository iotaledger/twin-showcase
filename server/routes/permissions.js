import { Router } from 'express';
import { WebSocket } from 'ws';
import { store, addLog, wsRefs, NODE_NAME } from '../store.js';
import { getUrnNamespace } from '../config.js';

const router = Router();

// T-218: ODRL 2.2 policy-stub generator. The structure mirrors what the TWIN
// node's POST /rights-management/policy/admin accepts (see TWIN API ref \u00a716),
// so the Phase 3 migration (T-304) becomes "feed this object to the adapter"
// instead of "rewrite the shape". Phase 2 only stores the stub in-memory next
// to the existing permission grants \u2014 no TWIN call.
//
// One stub per (consignment, recipient). For selective sharing, the same
// stub carries one `permission[]` entry per shared document so revoke can
// drop the whole policy at once.
function odrlKey(consignmentId, orgId) { return `${consignmentId}:${orgId}`; }

function buildOdrlPolicy({ consignmentId, recipientOrg, targets, action = 'odrl:read', expiresAt }) {
  // In-memory ODRL preview stub (T-218, display-only via /odrl — never sent to
  // the node). Kept in the same `policy:<ns>:` namespace as the node-facing
  // policy (buildOdrlOfferPolicy in adapter/docker.js) for consistency. `ns` is
  // the corridor-agnostic namespace (config-driven, neutral default).
  const ns = getUrnNamespace();
  const uid = `policy:${ns}:${consignmentId}:${recipientOrg.id}`;
  const permission = targets.map(target => ({
    target,
    action,
    assignee: recipientOrg.did || `urn:${ns}:org:${recipientOrg.id}`,
    constraint: expiresAt ? [{
      leftOperand: 'odrl:dateTime',
      operator: 'odrl:lteq',
      rightOperand: expiresAt,
    }] : [],
  }));
  return {
    '@context': 'http://www.w3.org/ns/odrl.jsonld',
    '@type': 'odrl:Set',
    uid,
    policyId: uid,
    permission,
    prohibition: [],
    obligation: [],
    issued: new Date().toISOString(),
  };
}

// Existing shape preserved (frontend treats this as { orgId: 'role' }).
router.get('/api/permissions/:consignmentId', (req, res) =>
  res.json(store.permissions[req.params.consignmentId] || {})
);

// T-218: ODRL stubs exposed via a dedicated route so the existing
// {orgId:role} shape above isn't polluted. UI / inspectors can pull these
// to preview the Phase 3 enforcement payload.
router.get('/api/permissions/:consignmentId/odrl', (req, res) => {
  const cid = req.params.consignmentId;
  const policies = Object.entries(store.odrlPolicies)
    .filter(([k]) => k.startsWith(`${cid}:`))
    .map(([, p]) => p);
  res.json(policies);
});

router.post('/api/permissions/share', async (req, res) => {
  const { consignmentId, recipientOrgId, recipientOrgName, sharerOrgName, shareMode, selectedDocIds } = req.body;
  const consignment = store.consignments.find(c => c.id === consignmentId);
  if (!consignment) return res.status(400).json({ error: 'Not found' });
  if (!store.permissions[consignmentId]) store.permissions[consignmentId] = {};
  store.permissions[consignmentId][recipientOrgId] = 'viewer';
  const allDocs = store.documents.filter(d => d.consignmentId === consignmentId);
  let docsForOdrl;
  if (shareMode === 'selective' && selectedDocIds?.length > 0) {
    for (const docId of selectedDocIds) { if (!store.docPermissions[docId]) store.docPermissions[docId] = {}; store.docPermissions[docId][recipientOrgId] = 'viewer'; }
    const names = allDocs.filter(d => selectedDocIds.includes(d.id)).map(d => d.title).join(', ');
    addLog('permission', 'Selective Share', sharerOrgName, `${consignment.ucr}: shared ${selectedDocIds.length}/${allDocs.length} docs with ${recipientOrgName}. [${names}]`);
    docsForOdrl = allDocs.filter(d => selectedDocIds.includes(d.id));
  } else {
    // Full share = consignment-level access. Do NOT write per-document grants:
    // a full viewer sees every doc (incl. docs uploaded AFTER the share) via the
    // consignment 'viewer' role. Writing per-doc grants here caused the
    // visibility bug \u2014 the GET filter then treated the viewer as "selective" and
    // hid any doc they lacked an explicit grant for the moment ANY per-doc grant
    // appeared on the consignment (e.g. a downstream selective/cross-node share).
    // Per-doc grants are now reserved for genuine SELECTIVE shares (above).
    addLog('permission', 'Full Share', sharerOrgName, `"${consignment.ucr}" \u2014 all ${allDocs.length} docs shared with ${recipientOrgName}. Access granted via a verifiable ODRL policy.`);
    docsForOdrl = allDocs;
  }

  // T-218: generate the ODRL stub. Targets are per-document for selective
  // shares (Phase 3 enforcement happens at the document level) and a single
  // consignment-level target for full shares (the recipient gets blanket
  // read access to the consignment + every doc under it).
  const recipientOrg =
    store.orgs.find(o => o.id === recipientOrgId)
    ?? store.peerOrgs.find(o => o.id === recipientOrgId)
    ?? { id: recipientOrgId, name: recipientOrgName, did: null };
  const ns = getUrnNamespace();
  const targets = shareMode === 'selective' && selectedDocIds?.length
    ? docsForOdrl.map(d => `urn:${ns}:document:${d.id}`)
    : [`urn:${ns}:consignment:${consignmentId}`];
  const odrlPolicy = buildOdrlPolicy({
    consignmentId,
    recipientOrg,
    targets,
  });
  store.odrlPolicies[odrlKey(consignmentId, recipientOrgId)] = odrlPolicy;

  const isPeer = store.peerOrgs.some(o => o.id === recipientOrgId);
  const peerSock = [wsRefs.peerWs, wsRefs.peerInWs].find(w => w?.readyState === WebSocket.OPEN);
  const docsToSend = shareMode === 'selective' && selectedDocIds?.length
    ? allDocs.filter(d => selectedDocIds.includes(d.id))
    : allDocs;
  // Simulated/legacy path: WebSocket P2P. Still used in simulated mode
  // and as a fallback when DSP isn't reachable (the WS broadcast guarantees
  // the local UI updates synchronously even when TWIN is slow).
  if (isPeer && peerSock) {
    peerSock.send(JSON.stringify({
      type: 'SHARE_CONSIGNMENT',
      consignment,
      // Carry the file blobs over the demo P2P channel so the recipient node can
      // actually OPEN the shared documents (download / XML view). Without this
      // the recipient only had metadata and every file showed "not available".
      // (The DSP/notify path stays metadata-only; in production the recipient
      // fetches blobs from the storage connector. For the demo, the WS channel
      // delivers them directly.)
      documents: docsToSend,
      permissions: store.permissions[consignmentId],
      docPermissions: Object.fromEntries(docsToSend.map(d => [d.id, store.docPermissions[d.id] || {}])),
    }));
  }

  // T-302 / DSP federation: in docker/hosted mode, run the share over the
  // standards-based protocol — anchor a verifiable ODRL policy and push the
  // consignment + docs into the RECIPIENT node's Dataspace-Protocol data plane.
  // We await it (a couple of seconds) so the response can carry the real
  // federation artifacts the UI's "Federation Receipt" surfaces; the WS
  // broadcast above already updated the peer UI synchronously, so the await
  // never blocks cross-node propagation. Best-effort: a DSP error degrades to
  // a `federation.error` field, the local share still succeeds.
  let federation = null;
  if (isPeer && store.adapter && store.adapter.mode !== 'simulated') {
    const sharerOrg = store.orgs.find(o => o.name === sharerOrgName)
      ?? { id: 'unknown', name: sharerOrgName, did: null };
    try {
      const result = await store.adapter.dspShareConsignment({
        consignment,
        recipientOrg,
        sharerOrg,
        documents: docsToSend,
        policyTargets: targets,
        urnNamespace: ns,
      });
      if (result?.policyId) {
        // Remember the TWIN-side policy id so revoke can delete it.
        const stored = store.odrlPolicies[odrlKey(consignmentId, recipientOrgId)];
        if (stored) stored.twinPolicyId = result.policyId;
      }
      federation = {
        policyId: result?.policyId ?? null,           // verifiable ODRL grant (governance)
        activityLogId: result?.activityLogId ?? null, // DSP data-plane transfer id
        federatedToNode: result?.federatedToNode ?? null,
        delivered: result?.delivered ?? Boolean(result?.activityLogId), // notify accepted by the recipient node's inbox
        // T-325: the recipient node's DataspaceApp.handleActivity confirmed it
        // ingested the consignment (acceptance returned over the DSP reply).
        accepted: Boolean(result?.acceptance?.accepted),
        acceptance: result?.acceptance ?? null,
        permitted: ['use', 'modify'],
        documentCount: docsToSend.length,
        sharer: { id: sharerOrg.id, name: sharerOrg.name, did: sharerOrg.did ?? null },
        recipient: { id: recipientOrg.id, name: recipientOrg.name, did: recipientOrg.did ?? null },
      };
    } catch (e) {
      console.warn(`[${NODE_NAME}] DSP share failed for ${consignmentId}->${recipientOrgId}: ${e.message}`);
      federation = { error: e.message };
    }
  }
  res.json({ success: true, odrlPolicy, federation });
});

router.post('/api/permissions/revoke', (req, res) => {
  const { consignmentId, recipientOrgId, recipientOrgName, revokerOrgName } = req.body;
  const c = store.consignments.find(c => c.id === consignmentId);
  if (store.permissions[consignmentId]) delete store.permissions[consignmentId][recipientOrgId];
  store.documents.filter(d => d.consignmentId === consignmentId).forEach(d => { if (store.docPermissions[d.id]) delete store.docPermissions[d.id][recipientOrgId]; });
  // T-218: drop the stub. T-302: also drives the DSP revoke below.
  const removedPolicy = store.odrlPolicies[odrlKey(consignmentId, recipientOrgId)] ?? null;
  delete store.odrlPolicies[odrlKey(consignmentId, recipientOrgId)];

  addLog('permission', 'Access Revoked', revokerOrgName, `Access to "${c?.ucr}" revoked for ${recipientOrgName}.`);
  const isPeer = store.peerOrgs.some(o => o.id === recipientOrgId);
  const peerSock = isPeer ? [wsRefs.peerWs, wsRefs.peerInWs].find(w => w?.readyState === WebSocket.OPEN) : null;
  if (peerSock) {
    peerSock.send(JSON.stringify({ type: 'REVOKE_CONSIGNMENT', consignmentId, recipientOrgId }));
  }

  // T-302: DSP path. Delete the TWIN-side ODRL policy + emit a Remove
  // activity. Fire-and-forget — the in-memory revoke above is already
  // committed to the local UI.
  if (isPeer && c && store.adapter && store.adapter.mode !== 'simulated') {
    (async () => {
      try {
        const recipientOrg =
          store.orgs.find(o => o.id === recipientOrgId)
          ?? store.peerOrgs.find(o => o.id === recipientOrgId)
          ?? { id: recipientOrgId, name: recipientOrgName, did: null };
        const revokerOrg = store.orgs.find(o => o.name === revokerOrgName)
          ?? { id: 'unknown', name: revokerOrgName, did: null };
        await store.adapter.dspRevokeConsignment({
          consignment: c,
          recipientOrg,
          revokerOrg,
          policyId: removedPolicy?.twinPolicyId ?? null,
          urnNamespace: getUrnNamespace(),
        });
      } catch (e) {
        console.warn(`[${NODE_NAME}] DSP revoke failed for ${consignmentId}->${recipientOrgId}: ${e.message}`);
      }
    })();
  }
  res.json({ success: true, revokedPolicy: removedPolicy?.policyId ?? null });
});

export default router;
