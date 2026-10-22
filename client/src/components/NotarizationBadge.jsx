/**
 * NotarizationBadge — compact pill that summarises a document's notarization
 * status, with an inline expand that reveals the full receipt (file
 * fingerprint, on-chain Ledger record, internal references). Designed by the
 * ux-designer agent to disambiguate "file SHA-256" from "IOTA object id"
 * for non-technical demo audiences.
 *
 * States:
 *   simulated — demo mode, no real anchor; dashed grey pill
 *   pending   — proofId set, no explorerUrl yet; amber spinner
 *   anchored  — explorerUrl set, not yet verified; orange Link2
 *   verified  — explorerUrl set + proofVerified=true; green ShieldCheck
 *   failed    — notarizationError or documentStorageError set; red AlertTriangle
 */
import React, { useState } from 'react';
import {
  FlaskConical, Loader, Link2, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronUp, ExternalLink, Copy, RefreshCw, Network,
} from 'lucide-react';
import { api } from '../utils/api';
import { useNode } from '../context/NodeContext';

// The badge's main state is driven by the IMMUTABLE PROOF (the on-chain
// anchor), not the optional document-management composite call. Storage
// errors are surfaced as a soft warning inside the detail panel but do
// NOT downgrade the badge — the doc is still validly notarized on chain.
//
// T-311: when the proof was anchored on the peer's TWIN node (cross-node
// document received via UPLOAD_DOCUMENT), the local TWIN cannot verify or
// fetch the full VC. The badge returns 'peer-anchored' in that case and
// the detail panel gates the verify button + FullProofViewer.
export function notarizationState(doc, localNodeId) {
  if (doc?.notarizationMode === 'simulated' || !doc?.notarizationMode) return 'simulated';
  if (doc?.notarizationError && !doc?.proofId) return 'failed';
  // T-312: a cross-node proof (anchored on the peer's TWIN). This check must
  // distinguish whether it has since been verified — otherwise the badge
  // stays 'peer-anchored' forever and a successful "Verify on ledger now"
  // (which sets proofVerified=true) never turns the pill green.
  if (doc?.notarizationNode && localNodeId && doc.notarizationNode !== localNodeId) {
    return doc?.proofVerified ? 'peer-verified' : 'peer-anchored';
  }
  if (doc?.proofVerified && doc?.proofExplorerUrl) return 'verified';
  if (doc?.proofExplorerUrl) return 'anchored';
  if (doc?.proofId) return 'pending';
  return 'failed';
}

const META = {
  simulated:     { Icon: FlaskConical, label: 'Demo mode',          className: 'nb--sim' },
  pending:       { Icon: Loader,       label: 'Writing to ledger',  className: 'nb--pending' },
  anchored:      { Icon: Link2,        label: 'On ledger',          className: 'nb--anchored' },
  verified:      { Icon: ShieldCheck,  label: 'Verified on ledger', className: 'nb--verified' },
  failed:        { Icon: AlertTriangle, label: 'Not on ledger',     className: 'nb--failed' },
  'peer-anchored':{ Icon: Network,     label: 'On peer ledger',     className: 'nb--peer' },
  'peer-verified':{ Icon: ShieldCheck, label: 'Verified on peer ledger', className: 'nb--peer-verified' },
};

export default function NotarizationBadge({ doc, onDocUpdated }) {
  const [open, setOpen] = useState(false);
  const { nodeInfo } = useNode();
  const localNodeId = nodeInfo?.nodeId;
  const state = notarizationState(doc, localNodeId);
  const { Icon, label, className } = META[state];
  const showSpinner = state === 'pending';

  return (
    <div className="nb-wrap">
      <button className={`nb ${className}`} onClick={() => setOpen(o => !o)} type="button" aria-expanded={open}>
        <Icon style={{ width: 12, height: 12, animation: showSpinner ? 'spin 1.2s linear infinite' : undefined }} />
        <span>{label}</span>
        {open ? <ChevronUp style={{ width: 11, height: 11 }} /> : <ChevronDown style={{ width: 11, height: 11 }} />}
      </button>
      {open && <NotarizationDetails doc={doc} onDocUpdated={onDocUpdated} localNodeId={localNodeId} />}
    </div>
  );
}

function NotarizationDetails({ doc, onDocUpdated, localNodeId }) {
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);
  const state = notarizationState(doc, localNodeId);
  const isPeerAnchored = state === 'peer-anchored' || state === 'peer-verified';
  const isPeerVerified = state === 'peer-verified';

  const handleVerify = async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await api.verifyDocument(doc.id);
      if (result?.error) throw new Error(result.error);
      onDocUpdated?.({ ...doc, ...result });
    } catch (e) {
      setVerifyError(e.message || 'Verify failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="nb-detail">
      {state === 'simulated' && (
        <div className="nb-detail__row">
          <div className="nb-detail__label">Demo mode</div>
          <div className="nb-detail__hint">No ledger entry — this document was processed in simulated mode (no real on-chain anchor).</div>
        </div>
      )}

      {/* T-311: cross-node proof — local TWIN cannot resolve a proofId that
          lives on the peer's chain. Show what we know (hash, receipt,
          explorer link) but disable verify + full-VC fetch until T-312. */}
      {isPeerAnchored && !isPeerVerified && (
        <div className="nb-detail__row" style={{ background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 8, padding: '10px 12px' }}>
          <div className="nb-detail__label" style={{ color: '#155e75' }}>
            <Network style={{ width: 13, height: 13, verticalAlign: -2, marginRight: 4 }} />
            Anchored on the peer's TWIN ledger
          </div>
          <div className="nb-detail__hint" style={{ color: '#155e75' }}>
            This document was notarized on <strong>{doc.notarizationNode}</strong>'s TWIN node. Cross-node verification works — use <em>"Verify on ledger now"</em> below (federated immutable-proof, with an IOTA on-chain fallback on the public receipt). The full W3C VC fetch over DSP is still in progress, and the IOTA Explorer link below works too (the anchor is public).
          </div>
        </div>
      )}

      {/* T-312: cross-node proof that has just been verified. Surface the
          real verification outcome (which path resolved it + when) so the
          user gets the confirmation that the green pill promises. */}
      {isPeerVerified && (
        <div className="nb-detail__row" style={{ background: '#ecfdf5', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 12px' }}>
          <div className="nb-detail__label" style={{ color: '#166534' }}>
            <ShieldCheck style={{ width: 13, height: 13, verticalAlign: -2, marginRight: 4 }} />
            Verified on the peer's TWIN ledger
          </div>
          <div className="nb-detail__hint" style={{ color: '#166534' }}>
            The proof anchored on <strong>{doc.notarizationNode}</strong>'s TWIN node was resolved {verificationSourceLabel(doc.verificationSource)}.
            {doc.lastVerifiedAt && <> Last checked <strong>{new Date(doc.lastVerifiedAt).toLocaleString()}</strong>.</>}
            {doc.proofExplorerUrl && <> The on-chain anchor is public — see the IOTA Explorer link below.</>}
          </div>
        </div>
      )}

      {state !== 'simulated' && (
        <>
          <Block title="Document fingerprint" hint="SHA-256 of the file content. Computed locally — the same file produces the same fingerprint on any computer. Embedded as the `sha256` field inside the JSON-LD envelope that TWIN then hashes and anchors on-chain.">
            <Mono value={doc.hash} />
            <CopyBtn value={doc.hash} />
          </Block>

          <Block title="Ledger record" hint={doc.proofExplorerUrl
              ? `Written by the TWIN node on IOTA testnet. Always signed by the node's own admin DID — this is the neutral notary stamp. The org's own signature (if present) is shown below in "Organisation signature".`
              : 'Writing to the public ledger is still in progress. TWIN finalises the on-chain anchor asynchronously (5–15 s).'}>
            {doc.receipt?.objectId
              ? (
                <>
                  <Mono value={doc.receipt.objectId} />
                  <CopyBtn value={doc.receipt.objectId} />
                  {doc.proofExplorerUrl && (
                    <a className="nb-detail__link" href={doc.proofExplorerUrl} target="_blank" rel="noreferrer">
                      Open in Explorer <ExternalLink style={{ width: 11, height: 11 }} />
                    </a>
                  )}
                </>
              ) : (
                <span className="nb-detail__pending">— pending —</span>
              )}
            {doc.receipt?.proofIntegrity && (
              <div className="nb-detail__kv" style={{ marginTop: 8 }}>
                <span className="nb-detail__kv-key" title="Hash of the JSON-LD envelope. This is what TWIN actually anchored on chain.">Envelope hash</span>
                <span className="nb-detail__kv-val mono">{doc.receipt.proofIntegrity}</span>
              </div>
            )}
            {doc.receipt && (
              <div className="nb-detail__meta">
                <span title="The immutable-proof VC is always issued by the TWIN node's admin DID — never the uploading org. This is by design: it's the neutral notary stamp.">Issued by: <strong>TWIN node admin</strong></span>
                {doc.receipt.network && <span>Network: <strong>{doc.receipt.network}</strong></span>}
                {typeof doc.receipt.epoch === 'number' && <span>Epoch: <strong>{doc.receipt.epoch}</strong></span>}
                {doc.lastVerifiedAt && <span>Last check: <strong>{new Date(doc.lastVerifiedAt).toLocaleString()}</strong> — {doc.proofVerified ? 'signature valid' : 'signature not yet valid'}</span>}
              </div>
            )}
          </Block>

          {doc.orgAttestationId && (
            <Block title="Organisation signature" hint="A second anchor signed by the uploading organisation's own DID (in addition to the node-issued ledger record above). Proves the org — not just the TWIN node — endorsed this document.">
              <Mono value={doc.orgAttestationId} />
              <CopyBtn value={doc.orgAttestationId} />
              {doc.orgAttestationExplorerUrl && (
                <a className="nb-detail__link" href={doc.orgAttestationExplorerUrl} target="_blank" rel="noreferrer">
                  Open in Explorer <ExternalLink style={{ width: 11, height: 11 }} />
                </a>
              )}
              <div className="nb-detail__meta">
                <span>Signed by <strong>{doc.creatorOrgName}</strong></span>
              </div>
            </Block>
          )}

          {doc.envelope && (
            <Block title="JSON-LD envelope" hint="The exact JSON-LD object whose canonical hash became the on-chain proofIntegrity. With this envelope you can verify the full chain locally — no TWIN node required. Includes the issuer DID under creator.identifier.">
              <details className="nb-detail__envelope">
                <summary>Show envelope</summary>
                <pre className="nb-detail__envelope-pre">{JSON.stringify(doc.envelope, null, 2)}</pre>
                <CopyBtn value={JSON.stringify(doc.envelope, null, 2)} />
              </details>
            </Block>
          )}

          {/* T-311: hide full-VC fetch for cross-node proofs — local TWIN
              cannot return them (returns 409). T-312 will restore via DSP
              data plane query. */}
          {doc.proofId && doc.notarizationMode !== 'simulated' && !isPeerAnchored && (
            <Block title="Full on-chain VC" hint="The complete W3C VerifiableCredential as TWIN returns it (issuer, signature, immutableReceipt). Lazy-loaded — fetched live from the TWIN node when you expand. Note: the `issuer` field here is the TWIN node admin DID (notary stamp), NOT the uploading org. The org's DID appears inside credentialSubject.creator.identifier and signs the separate attestation NFT above.">
              <FullProofViewer docId={doc.id} />
            </Block>
          )}

          <Block title="Internal references" hint="">
            {doc.proofId && <KV k="Proof handle"  v={doc.proofId}  mono />}
            {doc.documentManagementId && <KV k="Document vertex" v={doc.documentManagementId} mono />}
            {doc.notarizationMode && <KV k="Mode" v={doc.notarizationMode === 'docker' ? 'Docker (local TWIN node)' : doc.notarizationMode} />}
          </Block>
        </>
      )}

      {/* Hard failure: no proof at all (notarization itself failed) */}
      {doc.notarizationError && !doc.proofId && (
        <div className="nb-detail__error">
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
          <div><strong>Notarization error:</strong> {doc.notarizationError}</div>
        </div>
      )}

      {/* Soft warning: notarization OK but the optional composite storage
          (blob + AIG vertex) failed. The doc is still validly anchored on
          chain via the immutable-proof above, and the org-signed
          attestation below stands independently. */}
      {doc.documentStorageError && (
        <div className="nb-detail__warn">
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Document vertex skipped:</strong> {doc.documentStorageError}
            <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
              The on-chain proof and the org signature are still valid. The
              optional TWIN composite storage (blob + audit graph) couldn't
              be created. Common causes: file larger than ~1 MB after base64
              (Fastify body limit), or a transient TWIN-side error during AIG vertex
              insertion. Retry by re-uploading; if it persists check
              `docker logs twin-showcase-node-alpha`.
            </div>
          </div>
        </div>
      )}

      {/* Soft warning: the org attestation (per-org signature) failed.
          Same logic as above — the doc still has the node's immutable
          proof; only the org's own signature is missing. */}
      {doc.orgAttestationError && (
        <div className="nb-detail__warn">
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Organisation signature skipped:</strong> {doc.orgAttestationError}
            <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
              The TWIN node still issued an immutable proof. To get the
              additional org-signed attestation, ensure the org has been
              registered via Identity → Register DID before uploading.
            </div>
          </div>
        </div>
      )}

      {state !== 'simulated' && doc.proofId && (
        <div className="nb-detail__actions">
          {verifyError && <div className="nb-detail__error-text">{verifyError}</div>}
          <button
            className="btn btn-p btn-sm"
            onClick={handleVerify}
            disabled={verifying}
            title={isPeerAnchored
              ? `Verify the proof anchored on ${doc.notarizationNode}'s TWIN node — cross-node via federated DSP, with an IOTA on-chain fallback (T-312).`
              : undefined}
            type="button">
            {verifying
              ? <><Loader style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} /> Checking ledger…</>
              : <><RefreshCw style={{ width: 11, height: 11 }} /> Verify on ledger now</>}
          </button>
        </div>
      )}
    </div>
  );
}

// T-312: map the adapter's verificationSource (returned by the cross-node
// verify route) to a human phrase. 'dsp' = federated immutable-proof query
// to the peer; 'iota-testnet'/'iota-mainnet' = direct on-chain object lookup.
function verificationSourceLabel(source) {
  if (source === 'dsp') return 'via a federated DSP query to the peer node';
  if (source === 'iota-testnet') return 'directly on the IOTA testnet ledger';
  if (source === 'iota-mainnet') return 'directly on the IOTA mainnet ledger';
  return 'on the peer ledger';
}

function Block({ title, hint, children }) {
  return (
    <div className="nb-detail__block">
      <div className="nb-detail__block-title">{title}</div>
      {hint && <div className="nb-detail__block-hint">{hint}</div>}
      <div className="nb-detail__block-body">{children}</div>
    </div>
  );
}

function KV({ k, v, mono }) {
  return (
    <div className="nb-detail__kv">
      <span className="nb-detail__kv-key">{k}</span>
      <span className={`nb-detail__kv-val${mono ? ' mono' : ''}`}>{v}</span>
    </div>
  );
}

function Mono({ value }) {
  return <span className="nb-detail__mono" title={value}>{value}</span>;
}

function FullProofViewer({ docId }) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !proof && !error) {
      setLoading(true);
      try {
        const result = await api.getDocumentProof(docId);
        setProof(result.proof);
      } catch (e) {
        setError(e.message || 'Failed to fetch proof');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <details className="nb-detail__envelope" open={open}>
      <summary onClick={(e) => { e.preventDefault(); handleToggle(); }}>
        {open ? 'Hide full VC' : 'Show full on-chain VC'}
      </summary>
      {loading && <div className="nb-detail__pending" style={{ marginTop: 6 }}>Fetching from TWIN node…</div>}
      {error && <div className="nb-detail__error-text" style={{ marginTop: 6 }}>{error}</div>}
      {proof && (
        <>
          <pre className="nb-detail__envelope-pre">{JSON.stringify(proof, null, 2)}</pre>
          <CopyBtn value={JSON.stringify(proof, null, 2)} />
        </>
      )}
    </details>
  );
}

function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  const handle = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };
  return (
    <button className="nb-detail__copy" onClick={handle} type="button" title="Copy to clipboard">
      <Copy style={{ width: 11, height: 11 }} />
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
