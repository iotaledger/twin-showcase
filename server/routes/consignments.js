import { Router } from 'express';
import { genId, now } from '../utils.js';
import { store, addLog, NODE_ID } from '../store.js';
import { consignmentToUnece } from '../twin/unece.js';

const router = Router();

// Status values allowed by the demo lifecycle. The UI exposes a subset of
// these via the status-update flow; arbitrary strings are rejected so the
// AIG audit log can't be polluted with typos.
const VALID_STATUSES = ['Draft', 'Released', 'In Transit', 'Customs', 'Delivered', 'Cancelled'];

// T-305: AIG vertex annotations now follow the UNECE D23B vocabulary
// (ISupplyChainAppConsignment) via consignmentToUnece(). The in-memory
// `store.consignments` keeps its flat shape so the React UI doesn't
// need to be rewritten; the UNECE structure only appears at the AIG
// boundary.

// Access check: an org sees a consignment it OWNS (creatorOrgId, authoritative
// from the node) or that was GRANTED to it (the share permission).
function canSee(c, orgId) {
  if (c.creatorOrgId && c.creatorOrgId === orgId) return true;
  const p = store.permissions[c.id] || {};
  return p[orgId] === 'owner' || p[orgId] === 'viewer';
}

router.get('/api/consignments', async (req, res) => {
  const { orgId } = req.query;

  // Node-authoritative (docker/hosted): the consignment records come from the
  // TWIN node's Auditable Item Graph — the source of truth — not the in-memory
  // store. We UNION the node's consignments with any in-memory ones not yet on
  // the node (e.g. peer-shared via WS before cross-node replication lands), so
  // the list is correct during the transition. Falls back to in-memory on error.
  if (store.adapter && store.adapter.mode !== 'simulated' && typeof store.adapter.listConsignments === 'function') {
    try {
      const fromNode = await store.adapter.listConsignments();
      const nodeIds = new Set(fromNode.map(c => c.id));
      const inMemoryExtra = store.consignments.filter(c => !nodeIds.has(c.id));
      const all = [...fromNode, ...inMemoryExtra];
      // documentCount reflects the documents actually held locally.
      for (const c of all) c.documentCount = store.documents.filter(d => d.consignmentId === c.id).length;
      return res.json(all.filter(c => canSee(c, orgId)));
    } catch (e) {
      console.warn(`[${NODE_ID}] consignments node read failed, falling back to in-memory: ${e.message}`);
    }
  }

  // Simulated mode / fallback: the in-memory store.
  res.json(store.consignments.filter(c => canSee(c, orgId)));
});

router.post('/api/consignments', async (req, res) => {
  const { ucr, commercialInvoiceNo, exportDeclarationNo, creatorOrgId, description } = req.body;
  const org = store.orgs.find(o => o.id === creatorOrgId);
  if (!org) return res.status(400).json({ error: 'Org not found' });

  const c = {
    id: genId(),
    ucr,
    commercialInvoiceNo: commercialInvoiceNo || '',
    exportDeclarationNo: exportDeclarationNo || '',
    description: description || '',
    creatorOrgId,
    creatorOrgName: org.name,
    createdAt: now(),
    documentCount: 0,
    status: 'Draft',
    aigVertexId: null,
    aigError: null,
    // T-311: the node where this consignment was created. Propagated on
    // SHARE_CONSIGNMENT so the receiving node knows it holds a peer-owned
    // copy and can render "Shared from {peer}" in the UI.
    originNode: NODE_ID,
  };

  // Shadow-write to the TWIN node's Auditable Item Graph. The in-memory
  // store is the primary source — if AIG fails the consignment is still
  // created (per T-217 acceptance criteria: "If AIG write fails, the
  // in-memory operation still succeeds (log warning, don't fail the
  // request)").
  try {
    const result = await store.adapter.createAigVertex({
      annotationObject: consignmentToUnece(c),
      // UCR is the natural cross-system identifier — surface it as an
      // alias so future code can look up the vertex by UCR alone.
      aliases: [{ id: ucr, aliasFormat: 'ucr' }],
    });
    if (result?.aigVertexId) c.aigVertexId = result.aigVertexId;
  } catch (e) {
    c.aigError = e.message;
    console.warn(`[consignments] AIG shadow write failed for ${ucr}: ${e.message}`);
  }

  store.consignments.push(c);
  store.permissions[c.id] = { [creatorOrgId]: 'owner' };

  const anchorDescr = c.aigVertexId
    ? `Audit log vertex ${c.aigVertexId} on AIG.`
    : (c.aigError ? `AIG shadow skipped (${c.aigError}).` : 'AIG shadow skipped (simulated mode).');
  addLog(
    'document',
    'Consignment Created',
    org.name,
    `Digital twin created: ${ucr}. ${anchorDescr}`,
    { aigVertexId: c.aigVertexId },
  );
  res.json(c);
});

router.put('/api/consignments/:id/status', async (req, res) => {
  const { status, actorOrgId } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}` });
  }
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const perm = store.permissions[c.id]?.[actorOrgId];
  if (perm !== 'owner') {
    return res.status(403).json({ error: 'Only the consignment owner can change its status' });
  }

  const prev = c.status;
  c.status = status;
  c.lastStatusChangeAt = now();

  // Mirror the status change onto the AIG vertex. Each update creates a
  // changeset, so the vertex's `/aig/:id/changesets` endpoint becomes a
  // tamper-evident lifecycle log.
  let updateError = null;
  if (c.aigVertexId) {
    try {
      await store.adapter.updateAigVertex({
        id: c.aigVertexId,
        annotationObject: consignmentToUnece(c),
        aliases: [{ id: c.ucr, aliasFormat: 'ucr' }],
      });
    } catch (e) {
      updateError = e.message;
      console.warn(`[consignments] AIG update failed for ${c.aigVertexId}: ${e.message}`);
    }
  }

  const actor = store.orgs.find(o => o.id === actorOrgId);
  addLog(
    'document',
    'Consignment Status Changed',
    actor?.name || actorOrgId,
    `${c.ucr}: ${prev} → ${status}.${c.aigVertexId ? ` Changeset added to AIG vertex ${c.aigVertexId}.` : ''}${updateError ? ` AIG update skipped: ${updateError}.` : ''}`,
    { aigVertexId: c.aigVertexId, previous: prev, next: status },
  );
  res.json({ ...c, aigUpdateError: updateError });
});

// Audit trail: list every changeset on the consignment's AIG vertex.
// Used by the UI "View audit log" action. Simulated mode returns an
// empty list — the badge surfaces that explicitly.
router.get('/api/consignments/:id/audit', async (req, res) => {
  const c = store.consignments.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!c.aigVertexId) {
    return res.json({ aigVertexId: null, changesets: [], mode: store.adapter?.mode });
  }
  try {
    const result = await store.adapter.getAigChangesets(c.aigVertexId, 100);
    res.json({ aigVertexId: c.aigVertexId, ...result, mode: store.adapter?.mode });
  } catch (e) {
    res.status(502).json({ error: 'TWIN Node unavailable', mode: store.adapter?.mode, detail: e.message });
  }
});

export default router;
