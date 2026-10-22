/**
 * FederationReceipt — confirmation modal body shown after a CROSS-NODE
 * consignment share completes over the Dataspace Protocol (DSP).
 *
 * It replaces the old silent success with a receipt that installs the
 * mental model: a share to an org on the peer's TWIN node is a REAL
 * protocol exchange between two sovereign nodes — not a file copy. Two
 * distinct, independently verifiable artifacts are surfaced:
 *
 *   1. Access granted (governance) — the ODRL policy (`policyId`): who may
 *      do what, machine-readable. Navy / pill-b treatment, ScrollText icon.
 *   2. Data delivered (transfer)   — the DSP data-plane push
 *      (`activityLogId`, `delivered`): the data actually moved to the
 *      recipient's own node. --accent treatment, ArrowLeftRight icon.
 *
 * The `federation` object comes straight from POST /api/permissions/share.
 * Same-node shares return federation === null and never reach this modal.
 * A federation that attempted DSP but failed arrives as { error } and is
 * rendered as a degraded receipt (the transfer step shows the reason).
 *
 * Components: FederationReceipt (body), FederationFlow (two nodes + arc),
 * FederationStep (icon-state + title + body + chip), ArtifactChip (mono id
 * + copy). The animated dashed arc reuses the NodeConnectionBeam idiom from
 * TradeNetworkPanel (motion.path with an animated strokeDashoffset).
 */
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ScrollText, ArrowLeftRight, ShieldCheck, Check, Loader, Copy,
  AlertTriangle, X,
} from 'lucide-react';

// Truncate a long id keeping head…tail so the copy target stays meaningful
// on mobile. e.g. policy:moit:cf3a…9b1 / urn:x-activity-log:7d2e…
function truncId(id, head = 22, tail = 6) {
  if (!id) return '';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function ArtifactChip({ value, tone = 'navy', extra }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };
  return (
    <div className={`fed-chip-row`}>
      <span className={`fed-chip fed-chip--${tone}`} title={value}>
        <span className="fed-chip__id">{truncId(value)}</span>
      </span>
      <button className="fed-chip__copy" onClick={copy} type="button" title="Copy full id to clipboard">
        <Copy style={{ width: 11, height: 11 }} />
        {copied ? 'copied' : 'copy'}
      </button>
      {extra}
    </div>
  );
}

// Two small node "cards" with org name + role, joined by a short SVG arc
// whose dashed stroke animates sender → recipient. Reuses the
// NodeConnectionBeam idiom (motion.path + strokeDashoffset) from the map.
function FederationFlow({ sender, recipient }) {
  return (
    <div className="fed-flow">
      <FedNodeCard party={sender} side="sender" />
      <div className="fed-flow__arc" aria-hidden="true">
        <svg viewBox="0 0 120 40" preserveAspectRatio="none" className="fed-flow__svg">
          <defs>
            <marker id="fedArrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
            </marker>
          </defs>
          {/* faint static base line */}
          <path d="M 4 20 Q 60 4 116 20" fill="none" stroke="var(--accent)" strokeOpacity="0.18" strokeWidth="2" />
          {/* animated dashed flow, sender → recipient */}
          <motion.path
            d="M 4 20 Q 60 4 116 20"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="6 6"
            markerEnd="url(#fedArrow)"
            animate={{ strokeDashoffset: [0, -24] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          />
        </svg>
        <span className="fed-flow__verb">DSP</span>
      </div>
      <FedNodeCard party={recipient} side="recipient" />
    </div>
  );
}

function FedNodeCard({ party, side }) {
  const color = side === 'sender' ? '#11224E' : 'var(--accent)';
  return (
    <div className="fed-node" style={{ borderColor: color }}>
      <div className="fed-node__dot" style={{ background: color }} />
      <div className="fed-node__node" style={{ color }}>{party.nodeLabel}</div>
      <div className="fed-node__org" title={party.name}>{party.name}</div>
      {party.role && <div className="fed-node__role">{party.role}</div>}
      <div className="fed-node__tag">{side === 'sender' ? 'Sender · sovereign node' : 'Recipient · sovereign node'}</div>
    </div>
  );
}

// status: 'pending' | 'done' | 'error'
function FederationStep({ status, Icon, tone, title, children, chip }) {
  return (
    <div className={`fed-step fed-step--${status}`}>
      <div className={`fed-step__icon fed-step__icon--${tone} fed-step__icon--${status}`}>
        {status === 'pending'
          ? <Loader style={{ width: 14, height: 14, animation: 'spin 1.2s linear infinite' }} />
          : status === 'error'
            ? <AlertTriangle style={{ width: 14, height: 14 }} />
            : <Icon style={{ width: 14, height: 14 }} />}
      </div>
      <div className="fed-step__body">
        <div className="fed-step__title">{title}</div>
        <div className="fed-step__text">{children}</div>
        {chip}
      </div>
    </div>
  );
}

export default function FederationReceipt({ federation, ucr, sender, recipient, onClose }) {
  const errored = !!federation?.error;

  // Stage the reveal client-side for effect. All data is already present in
  // the single response; we just unveil step-by-step. We NEVER show "done"
  // for an artifact that is missing or errored.
  const [stage, setStage] = useState(errored ? 3 : 0);

  useEffect(() => {
    if (errored) return;
    const timers = [
      setTimeout(() => setStage(1), 500),
      setTimeout(() => setStage(2), 1050),
      setTimeout(() => setStage(3), 1600),
    ];
    return () => timers.forEach(clearTimeout);
  }, [errored]);

  const policyId = federation?.policyId;
  const activityLogId = federation?.activityLogId;
  const delivered = federation?.delivered;
  // T-325: the recipient node's DataspaceApp confirmed it INGESTED the
  // consignment (stronger than `delivered`, which is just notify-processed).
  const accepted = federation?.accepted;
  const confirmed = accepted || delivered;
  // T-325 acceptance evidence (from the recipient's handleActivity reply).
  const acceptance = federation?.acceptance;
  const acceptedAt = acceptance?.acceptedAt;
  const acceptanceVertexId = acceptance?.vertexId;
  const rejectionReason =
    acceptance && acceptance.accepted === false ? (acceptance.reason || 'not accepted') : null;
  const acceptedTimeText = (() => {
    if (!acceptedAt) return null;
    try { return new Date(acceptedAt).toLocaleString(); } catch { return acceptedAt; }
  })();
  const documentCount = federation?.documentCount;
  const permitted = federation?.permitted ?? [];
  const recipientName = recipient?.name || federation?.recipient?.name || 'the recipient';
  const senderName = sender?.name || federation?.sharer?.name || 'the sender';

  // Per-step status. In the error case we degrade: whichever artifact is
  // missing renders in an error state with a plain-language reason.
  const accessStatus = errored
    ? (policyId ? 'done' : 'error')
    : (stage >= 1 ? (policyId ? 'done' : 'error') : 'pending');
  const transferStatus = errored
    ? 'error'
    : (stage >= 2 ? (delivered ? 'done' : 'error') : 'pending');
  const receivedStatus = errored
    ? (confirmed ? 'done' : 'error')
    : (stage >= 3 ? (confirmed ? 'done' : 'error') : 'pending');

  const permittedText = permitted.length
    ? permitted.join(' + ')
    : 'access';

  return (
    <>
      <div className="fed-receipt__head">
        <div>
          <h3 style={{ margin: 0 }}>Federating consignment {ucr}</h3>
          <div className="fed-receipt__sub">Across the trade corridor, node-to-node</div>
        </div>
        <button className="btn btn-s btn-sm" onClick={onClose} type="button" aria-label="Close">
          <X style={{ width: 12, height: 12 }} />
        </button>
      </div>

      <FederationFlow sender={sender} recipient={recipient} />

      <div className="fed-steps">
        {/* 1 — Access granted (governance / ODRL policy) */}
        <FederationStep
          status={accessStatus}
          Icon={ScrollText}
          tone="navy"
          title="Access granted"
          chip={policyId && (
            <ArtifactChip value={policyId} tone="navy" />
          )}
        >
          {accessStatus === 'error' && !policyId
            ? <>The access grant could not be anchored. {federation?.error || 'No policy id was returned.'}</>
            : <>A verifiable permission was anchored: <strong>{senderName}</strong> grants <strong>{recipientName}</strong> {permittedText} on this consignment.</>}
        </FederationStep>

        {/* 2 — Delivered over the data space (DSP data-plane transfer) */}
        <FederationStep
          status={transferStatus}
          Icon={ArrowLeftRight}
          tone="accent"
          title="Delivered over the data space"
          chip={activityLogId && (
            <ArtifactChip
              value={activityLogId}
              tone="accent"
              extra={transferStatus === 'done' && (
                <span className="fed-chip__status">status: completed</span>
              )}
            />
          )}
        >
          {transferStatus === 'error' && !activityLogId
            ? <>The Dataspace Protocol transfer did not complete. {federation?.error || 'The data may not have reached the recipient node.'}</>
            : <>Pushed the consignment{typeof documentCount === 'number' ? <> + {documentCount} document{documentCount === 1 ? '' : 's'}</> : ''} to {recipientName}'s node through the Dataspace Protocol (DSP).</>}
        </FederationStep>

        {/* 3 — Received on the recipient's node (notify confirmed) */}
        <FederationStep
          status={receivedStatus}
          Icon={ShieldCheck}
          tone="green"
          title={`Received on ${recipient?.nodeLabel || 'the recipient node'}`}
        >
          {receivedStatus === 'error'
            ? <>The recipient node has not confirmed receipt yet{rejectionReason ? <> ({rejectionReason})</> : null}. Their live view may update once the transfer is reprocessed.</>
            : accepted
              ? <>
                  {recipientName}'s node ingested the consignment into its own ledger (AIG) over the Dataspace Protocol{acceptedTimeText ? <> at <strong>{acceptedTimeText}</strong></> : null}; their live view updated.
                  {acceptanceVertexId ? (
                    <div style={{ marginTop: 6 }}>
                      <ArtifactChip value={acceptanceVertexId} tone="green" />
                    </div>
                  ) : null}
                </>
              : <>Delivered to {recipientName}'s node over the Dataspace Protocol; it ingests the consignment asynchronously and its live view updates.</>}
        </FederationStep>
      </div>

      <div className={`fed-claim ${errored ? 'fed-claim--muted' : ''}`}>
        <Check style={{ width: 13, height: 13, flexShrink: 0, marginTop: 1 }} />
        <span>
          {errored
            ? 'A protocol exchange between two independent nodes was attempted. Resolve the issue above and re-share to complete federation.'
            : 'A real protocol exchange between two independent nodes — not a copy. Both proofs above are independently verifiable.'}
        </span>
      </div>

      <div className="modal-act">
        <button className="btn btn-p" onClick={onClose} type="button">Done</button>
      </div>
    </>
  );
}
