import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck, ShieldX, ShieldAlert, Loader2, FileCheck2, Link as LinkIcon,
  WifiOff, UploadCloud, CheckCircle2, XCircle, Info,
} from 'lucide-react';

// T-4V03 (WP4) — public verification landing page (QR target).
//
// Deliberately standalone: no NodeContext, no login, no session. The target
// user is a customs officer at destination who is NOT a platform account
// holder — they scan the QR on a printed/PDF document and land here.
//
// The URL fragment carries a self-describing payload (docId, UCR, docType,
// issuer, node) readable even with the server unreachable; integrity facts
// (sha256, anchor, verified) come from the metadata-only public endpoint.

function decodeFragmentPayload() {
  try {
    const frag = window.location.hash.replace(/^#/, '');
    if (!frag) return null;
    // UTF-8-safe: payload is base64url of UTF-8 bytes; atob alone yields a
    // Latin1 binary string → mojibake on diacritics.
    const bin = atob(frag.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function Row({ label, children, mono }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
      <div style={{ width: 150, color: '#64748b', flexShrink: 0 }}>{label}</div>
      <div style={{ fontWeight: 600, color: '#0f172a', wordBreak: 'break-all', fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 12 : 13 }}>
        {children ?? '—'}
      </div>
    </div>
  );
}

function Banner({ tone, icon: Icon, title, children }) {
  const tones = {
    green: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    red: { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
    amber: { bg: '#fffbeb', border: '#fde68a', fg: '#b45309' },
    slate: { bg: '#f8fafc', border: '#e2e8f0', fg: '#475569' },
  };
  const t = tones[tone];
  return (
    <div style={{ background: t.bg, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: '18px 20px', display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <Icon style={{ width: 30, height: 30, color: t.fg, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 16, fontWeight: 800, color: t.fg, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.5 }}>{children}</div>
      </div>
    </div>
  );
}

export default function PublicVerify() {
  const docId = decodeURIComponent(window.location.pathname.replace(/^\/verify\//, '').replace(/\/+$/, ''));
  const payload = decodeFragmentPayload();
  const [state, setState] = useState('loading'); // loading | found | unknown | offline
  const [data, setData] = useState(null);
  const [fileCheck, setFileCheck] = useState(null); // { match: bool, hash }
  const fileRef = useRef(null);

  useEffect(() => {
    // UX P0-1: route the API call explicitly to the node named in the QR
    // payload (fallback: the page's own ?node= param). Cookie-based proxy
    // routing alone is fragile in in-app QR browsers and when the presenter's
    // browser already holds the other node's cookie — without this, a
    // cross-node scan shows a false "No record found".
    const node = payload?.node ?? new URLSearchParams(window.location.search).get('node');
    const nodeQ = node ? `?node=${encodeURIComponent(node)}` : '';
    fetch(`/api/public/verify/${encodeURIComponent(docId)}${nodeQ}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (r.ok && body?.status === 'found') { setData(body); setState('found'); }
        else setState('unknown');
      })
      .catch(() => setState('offline'));
    // payload is derived from the immutable URL fragment — stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const handleFile = async (file) => {
    if (!file || !data?.integrity?.sha256) return;
    const hash = await sha256Hex(await file.arrayBuffer());
    // Server-side hashes carry a 0x prefix (sha256OfBuffer) — normalize.
    const registered = data.integrity.sha256.replace(/^0x/, '').toLowerCase();
    setFileCheck({ match: hash === registered, hash });
  };

  const integrity = data?.integrity;
  const verified = integrity?.liveVerified === true || (integrity?.verified && integrity?.liveVerified !== false);
  const anchoredOnly = integrity?.proofId && !verified;
  const demoMode = integrity && !integrity.proofId && integrity.notarizationMode !== 'docker' && integrity.notarizationMode !== 'hosted';
  // Cause analysis so the "not verified" states can say WHY + WHAT TO DO.
  const servingNode = data?.node;                              // node that served this page
  const originNode = integrity?.notarizationNode;              // node that anchored the proof
  const isCrossNode = originNode && servingNode && originNode !== servingNode;
  const hasOnChainRef = Boolean(integrity?.anchorObjectId);    // on-chain object id propagated here?

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', padding: '32px 16px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '2px', color: '#64748b' }}>TWIN TRADE CORRIDOR</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a' }}>Document Verification</div>
          <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
            Public check — no account required. Integrity metadata only; the document content is not disclosed.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {state === 'loading' && (
            <Banner tone="slate" icon={Loader2} title="Checking…">Querying the corridor node for this document's integrity record.</Banner>
          )}

          {state === 'unknown' && (
            <Banner tone="red" icon={ShieldX} title="No record found">
              This node has no record for document id <code style={{ fontFamily: 'ui-monospace, monospace' }}>{docId}</code>.
              The document may be forged, altered, or registered on a different corridor node{payload?.node ? ` (the QR claims node "${payload.node}" — try opening this page with ?node=${payload.node})` : ''}.
            </Banner>
          )}

          {state === 'offline' && (
            <Banner tone="amber" icon={WifiOff} title="Verification service unreachable">
              The corridor node could not be reached. The QR payload below is still readable offline
              {payload ? '' : ' (none present in this URL)'} and the on-chain anchor can be checked
              independently on the public IOTA explorer.
            </Banner>
          )}

          {state === 'found' && verified && (
            <Banner tone="green" icon={ShieldCheck} title="Verified">
              The document's fingerprint is anchored on the IOTA ledger and the proof verifies right now.
              Issuer identity and integrity are cryptographically backed — not taken on trust.
              {isCrossNode && (
                <div style={{ marginTop: 8 }}>
                  Issued on the <b>{originNode}</b> node and verified here from <b>{servingNode}</b>, directly on the
                  public ledger — <b>no account, no access to the issuing system required</b>.
                </div>
              )}
            </Banner>
          )}

          {/* Cross-node, on-chain reference not propagated to this node yet */}
          {state === 'found' && anchoredOnly && isCrossNode && !hasOnChainRef && (
            <Banner tone="amber" icon={ShieldAlert} title={`Anchored on the ${originNode} node — not yet verifiable from here`}>
              This document was notarized on the <b>{originNode}</b> node; you opened it on <b>{servingNode}</b>.
              Its on-chain reference hasn't reached <b>{servingNode}</b> yet, so this node can't re-check it on the ledger.
              <div style={{ marginTop: 8 }}><b>What to do:</b> open it on the issuing node —{' '}
                <a href={`/verify/${encodeURIComponent(docId)}?node=${originNode}`} style={{ color: '#0369a1', fontWeight: 700 }}>verify on {originNode}</a>{' '}
                — or have the exporter re-share it <i>after</i> its proof has finished anchoring, then scan again.
                The fingerprint below still lets you check a file by hand.</div>
            </Banner>
          )}

          {/* Cross-node, anchor reference present but the live re-check didn't return */}
          {state === 'found' && anchoredOnly && isCrossNode && hasOnChainRef && (
            <Banner tone="amber" icon={ShieldAlert} title="Anchored — on-chain re-check didn't complete">
              Notarized on the <b>{originNode}</b> node and anchored on the IOTA testnet
              . The live re-check from <b>{servingNode}</b> didn't return just now.
              <div style={{ marginTop: 8 }}><b>What to do:</b> confirm the anchor directly on the public IOTA explorer (link below) — it proves the object exists on chain — or retry in a moment.</div>
            </Banner>
          )}

          {/* Same node: proof exists but the local check is still settling */}
          {state === 'found' && anchoredOnly && !isCrossNode && (
            <Banner tone="amber" icon={ShieldAlert} title="Anchored — verifying">
              The on-chain proof exists but the live check didn't confirm just now
              . Testnet anchoring can take ~5–15&nbsp;s after upload.
              <div style={{ marginTop: 8 }}><b>What to do:</b> retry in a few seconds, or confirm the anchor on the IOTA explorer link below.</div>
            </Banner>
          )}

          {state === 'found' && demoMode && (
            <Banner tone="slate" icon={Info} title="Demo mode — no public-ledger anchor">
              This corridor instance runs in <b>simulated mode</b>: the integrity record is held on the node but is
              not anchored on the public IOTA testnet, so there is nothing to re-check on chain. Running against real
              TWIN nodes (docker / hosted) shows a <b>live IOTA verification</b> here, with an explorer link.
              <div style={{ marginTop: 8 }}><b>You can still:</b> check a file against the registered fingerprint below.</div>
            </Banner>
          )}

          {/* Document facts (from the node when found, from the offline payload otherwise) */}
          {(data || payload) && (
            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 4px' }}>
                {data ? 'Registered document' : 'QR payload (offline view)'}
              </div>
              <Row label="Document type">{data?.document?.docType ?? payload?.docType}</Row>
              <Row label="Title / reference">{data ? `${data.document.title}${data.document.reference ? ` · ${data.document.reference}` : ''}` : null}</Row>
              <Row label="Issuer">{data?.document?.issuer ?? payload?.issuer}</Row>
              {(data?.document?.issuerDid) && <Row label="Issuer DID" mono>{data.document.issuerDid}</Row>}
              <Row label="Consignment (UCR)" mono>{data?.document?.ucr ?? payload?.ucr}</Row>
              {data?.document?.uneceCode && <Row label="UNECE code">{data.document.uneceCode}{data.document.sourceSystem ? ` · via ${data.document.sourceSystem}` : ''}</Row>}
              {data?.document?.issuedAt && <Row label="Issued">{new Date(data.document.issuedAt).toLocaleString()}</Row>}
              <Row label="Corridor node">{data?.nodeName ?? payload?.node}</Row>
            </div>
          )}

          {/* Integrity facts */}
          {integrity && (
            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 4px' }}>Integrity</div>
              <Row label="SHA-256 fingerprint" mono>{integrity.sha256}</Row>
              {integrity.proofId && <Row label="On-chain proof" mono>{integrity.proofId}</Row>}
              {integrity.anchorObjectId && <Row label="Anchor object" mono>{integrity.anchorObjectId}</Row>}
              {integrity.lastVerifiedAt && <Row label="Last verified">{new Date(integrity.lastVerifiedAt).toLocaleString()}</Row>}
              {integrity.explorerUrl && (
                <div style={{ marginTop: 10 }}>
                  <a href={integrity.explorerUrl} target="_blank" rel="noreferrer"
                     style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#0369a1', textDecoration: 'none' }}>
                    <LinkIcon style={{ width: 14, height: 14 }} /> Check the anchor on the public IOTA explorer
                  </a>
                </div>
              )}
            </div>
          )}

          {/* File integrity check — the tamper demo beat */}
          {state === 'found' && integrity?.sha256 && (
            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 8px' }}>
                Check a file against this record
              </div>
              <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 10 }}>
                Select the document file you received (e.g. by email). It is hashed locally in your browser —
                nothing is uploaded — and compared with the registered fingerprint.
              </div>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: '#0f172a', background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 9, padding: '8px 14px', cursor: 'pointer' }}>
                <UploadCloud style={{ width: 15, height: 15 }} /> Select file to check
              </button>
              {fileCheck && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, fontWeight: 700, color: fileCheck.match ? '#15803d' : '#b91c1c' }}>
                  {fileCheck.match
                    ? <><CheckCircle2 style={{ width: 16, height: 16, flexShrink: 0 }} /> Fingerprint match — this file is byte-identical to the registered document.</>
                    : <><XCircle style={{ width: 16, height: 16, flexShrink: 0 }} /> Fingerprint MISMATCH — this file differs from the registered document. Do not trust it.</>}
                </div>
              )}
            </div>
          )}

          <div style={{ textAlign: 'center', fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
            <FileCheck2 style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> Today the alternative is an emailed PDF with no provenance.
          </div>
        </div>
      </div>
    </div>
  );
}
