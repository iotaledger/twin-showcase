import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNode } from '../context/NodeContext';
import { api } from '../utils/api';
import { fmtValue } from '../utils/format';
import VerifyQr from './shared/VerifyQr';
import ShipmentQr from './shared/ShipmentQr';
import {
  ShieldCheck, FileCheck2, AlertTriangle, CheckCircle2, XCircle, Clock,
  ChevronLeft, Landmark, Mail, Link as LinkIcon, Loader2, FileWarning, Send,
} from 'lucide-react';

// T-4V03 (WP1) — the customs-perspective view, gated by the org's
// customsDeskRole (config-driven):
//   exportCustoms          declaration queue with channel state + dossier verification
//   importCustoms/importer import pre-clearance: verified dossier → draft declaration
//
// Framing rule (call-prep A2): channeling decisions belong to the authority.
// The simulation only shows what data the risk engine would have — it never
// says a channel decision was wrong.

const CHANNEL_STYLES = {
  green: { bg: '#dcfce7', fg: '#15803d', label: 'GREEN' },
  yellow: { bg: '#fef3c7', fg: '#b45309', label: 'YELLOW' },
  red: { bg: '#fee2e2', fg: '#b91c1c', label: 'RED' },
};

function ChannelPill({ channel }) {
  const s = CHANNEL_STYLES[channel] ?? { bg: '#f1f5f9', fg: '#64748b', label: channel ?? '—' };
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 10, fontWeight: 800, letterSpacing: '0.5px', padding: '3px 9px', borderRadius: 999 }}>
      {s.label}
    </span>
  );
}

function DossierPill({ dossier }) {
  if (dossier?.dossierVerified) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#15803d' }}>
        <ShieldCheck style={{ width: 13, height: 13 }} /> Verified dossier
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#b45309' }}>
      <Mail style={{ width: 13, height: 13 }} /> Unverified (emailed PDFs)
    </span>
  );
}

// Per-field provenance badge: which source document the value comes from.
function ProvenanceField({ f }) {
  return (
    <tr>
      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', padding: '6px 10px' }}>{f.label}</td>
      <td style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', padding: '6px 10px', wordBreak: 'break-word' }}>{String(f.value)}</td>
      <td style={{ padding: '6px 10px' }}>
        {f.sourceDoc && (
          <span title={`Pre-filled from ${f.sourceDoc}`} style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: '#e0f2fe', padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
            {f.sourceDoc}
          </span>
        )}
      </td>
    </tr>
  );
}

function DocVerifyRow({ d, ucr, nodeId, onVerify, verifying }) {
  const n = d.notarization ?? {};
  const state = n.verified ? 'verified' : n.proofId ? 'anchored' : n.mode === null && !n.proofId ? 'none' : 'pending';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, border: '1px solid var(--card-border)' }}>
      <FileCheck2 style={{ width: 15, height: 15, color: 'var(--accent)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
          {d.title} {d.uneceCode && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>· UNECE {d.uneceCode}</span>}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          {d.issuer}{d.sourceSystem ? ` via ${d.sourceSystem}` : ''}
          {d.issuerDid && <span style={{ fontFamily: 'var(--mono)' }}> · {d.issuerDid.slice(0, 24)}…</span>}
        </div>
      </div>
      {state === 'verified' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: '#15803d' }}><CheckCircle2 style={{ width: 13, height: 13 }} /> Verified</span>}
      {state === 'anchored' && (
        <button className="btn btn-s btn-sm" onClick={() => onVerify(d)} disabled={verifying}>
          {verifying ? <Loader2 style={{ width: 11, height: 11 }} className="spin" /> : <ShieldCheck style={{ width: 11, height: 11 }} />} Verify
        </button>
      )}
      {state === 'none' && (
        d.requiresNotarization
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#b45309' }}><FileWarning style={{ width: 13, height: 13 }} /> No provenance</span>
          : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Not required</span>
      )}
      {n.explorerUrl && (
        <a href={n.explorerUrl} target="_blank" rel="noreferrer" title="View anchor on IOTA Explorer" style={{ display: 'inline-flex' }}>
          <LinkIcon style={{ width: 12, height: 12, color: 'var(--text-muted)' }} />
        </a>
      )}
      <VerifyQr doc={{ id: d.id, title: d.title, docType: d.docType, issuer: d.issuer, ucr }} nodeId={nodeId} />
    </div>
  );
}

function OriginChain({ oc }) {
  if (!oc) return null;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
        Origin composition — supplier evidence chain
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: oc.evidenceIncomplete ? '#b91c1c' : '#15803d' }}>
          {oc.localContentPercent}%
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          local content ({oc.calculationMethod}, threshold {oc.threshold}%)
          {oc.cptppCumulationApplied ? ' · CPTPP cumulation applied' : ''}
        </span>
      </div>
      {oc.evidenceIncomplete && (
        <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
          <span>Supplier evidence incomplete — the declared origin cannot be reconstructed from the recorded inputs. Provenance proves document integrity, not content: this gap needs source-side evidence (input C/O, BOM).</span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {(oc.inputMaterials ?? []).map((m, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 130, color: 'var(--text-secondary)', fontWeight: 500 }}>{m.material}</span>
            <span style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 11, color: m.inputCoMissing ? '#b91c1c' : 'var(--text-muted)' }}>{m.supplierCountry}</span>
            <div style={{ flex: 1, height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${m.valuePercent}%`, height: '100%', background: m.inputCoMissing ? '#dc2626' : m.ftaMember ? '#16a34a' : '#94a3b8' }} />
            </div>
            <span style={{ width: 44, textAlign: 'right', fontSize: 11, fontWeight: 600 }}>{m.valuePercent}%</span>
            {m.inputCoMissing && <span style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c' }}>NO INPUT C/O</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CustomsDesk() {
  const { user, nodeInfo, refreshKey, refresh } = useNode();
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // queue row
  const [detail, setDetail] = useState(null);     // preclearance view model
  const [verifyingId, setVerifyingId] = useState(null);
  const [accepting, setAccepting] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  // UX P0-3: async handlers re-check this ref before applying results, so a
  // response for consignment A can never overwrite the panel after the
  // presenter has clicked consignment B mid-flight.
  const selectedIdRef = useRef(null);

  const isExportSide = queue?.role === 'exportCustoms';
  const canAccept = ['importer', 'importCustoms'].includes(user.customsDeskRole);

  useEffect(() => {
    api.getCustomsQueue(user.id).then(setQueue).catch(e => setError(e.message));
  }, [user.id, refreshKey]);

  const refreshDetail = useCallback(async (cId) => {
    try {
      const fresh = await api.getPreclearance(cId, user.id);
      if (selectedIdRef.current === cId) setDetail(fresh);
    } catch { /* leave state as-is */ }
  }, [user.id]);

  const loadDetail = useCallback((row) => {
    setSelected(row);
    selectedIdRef.current = row.id;
    setDetail(null);
    setActionMsg('');
    setCorrectionOpen(false);
    setCorrectionText('');
    api.getPreclearance(row.id, user.id)
      .then(d => { if (selectedIdRef.current === row.id) setDetail(d); })
      .catch(e => setError(e.message));
  }, [user.id]);

  const handleVerify = async (d) => {
    const cId = selected.id;
    setVerifyingId(d.id);
    try {
      await api.verifyDocument(d.id);
      await refreshDetail(cId);
    } catch { /* leave state as-is */ }
    setVerifyingId(null);
  };

  const handleVerifyAll = async () => {
    if (!detail) return;
    const cId = selected.id;
    for (const d of detail.documents) {
      if (d.notarization?.proofId && !d.notarization?.verified) {
        setVerifyingId(d.id);
        try { await api.verifyDocument(d.id); } catch { /* best-effort */ }
      }
    }
    setVerifyingId(null);
    refreshDetail(cId);
  };

  const handleAccept = async () => {
    const cId = selected.id;
    setAccepting(true);
    try {
      const doc = await api.acceptPrelodged(cId, user.id);
      if (selectedIdRef.current === cId) {
        setActionMsg(`Draft import declaration ${doc.reference} created from the verified dossier.`);
      }
      refresh();
      refreshDetail(cId);
    } catch (e) {
      // UX P1-4: friendly text for the double-accept race instead of the raw error.
      if (selectedIdRef.current === cId) {
        setActionMsg(/already exists/i.test(e.message)
          ? 'A draft import declaration already exists for this consignment — see the dossier checklist.'
          : e.message);
      }
    }
    setAccepting(false);
  };

  // UX P1-5: inline correction form instead of window.prompt (un-demoable).
  const handleSendCorrection = async () => {
    const cId = selected.id;
    const reason = correctionText.trim();
    if (!reason) return;
    try {
      await api.requestCorrection(cId, user.id, reason);
      if (selectedIdRef.current === cId) {
        setActionMsg('Correction request logged — the exporter side sees it in its activity feed.');
        setCorrectionOpen(false);
        setCorrectionText('');
      }
    } catch (e) {
      if (selectedIdRef.current === cId) setActionMsg(e.message);
    }
  };

  if (error) return <div className="card" style={{ padding: 20, color: '#b91c1c' }}>{error}</div>;
  if (!queue) return <div className="empty">Loading customs desk…</div>;

  // ── Detail view ──────────────────────────────────────────────────────
  if (selected) {
    const cust = detail?.consignment?.customs ?? selected;
    const eCo = cust?.eCo ?? selected.eCo;
    const dest = cust?.destination ?? selected.destination;
    return (
      <div className="stack">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-s btn-sm" onClick={() => { setSelected(null); setDetail(null); }}>
            <ChevronLeft style={{ width: 13, height: 13 }} /> Back to queue
          </button>
          <span className="ucr-ref" style={{ fontSize: 15 }}>{selected.ucr}</span>
          <ChannelPill channel={selected.channel} />
          <DossierPill dossier={detail?.dossier ?? selected.dossier} />
          {/* T-4V04: shipment QR for the checkpoint / truck-driver pass. */}
          <div style={{ marginLeft: 'auto' }}>
            <ShipmentQr consignment={{ id: selected.id, ucr: selected.ucr, exporter: selected.exporter, importer: selected.importer, fromCountry: detail?.consignment?.fromCountry, toCountry: selected.toCountry }} nodeId={nodeInfo?.nodeId} />
          </div>
        </div>

        {/* The "before" beat: unverified dossier = today's reality */}
        {!(detail?.dossier ?? selected.dossier)?.dossierVerified && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px' }}>
            <Mail style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1 }} />
            <span><strong>Today's reality:</strong> these supporting documents arrived as emailed PDF scans — no provenance, authenticity taken on trust, every value re-keyed by hand. This is the competition: email with no provenance.</span>
          </div>
        )}

        {selected.errorType && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px' }}>
            <AlertTriangle style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1 }} />
            <span><strong>{selected.errorType}:</strong> {detail?.consignment?.errorDescription ?? selected.channelReason}</span>
          </div>
        )}

        {/* Declaration facts */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
            Export declaration
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '8px 18px', fontSize: 12.5 }}>
            <div><span style={{ color: 'var(--text-muted)' }}>Declaration no.</span><div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{selected.declarationNo} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({selected.declarationType})</span></div></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Customs office</span><div style={{ fontWeight: 600 }}>{selected.customsOffice}</div></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Trader tax code (MST)</span><div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{selected.traderTaxCode}</div></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Declared</span><div style={{ fontWeight: 600 }}>{selected.declaredAt ? new Date(selected.declaredAt).toLocaleString() : '—'}</div></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Released</span><div style={{ fontWeight: 600 }}>{selected.releasedAt ? new Date(selected.releasedAt).toLocaleString() : (selected.channel === 'green' ? 'Pending release' : 'Held')}</div></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Export duty</span><div style={{ fontWeight: 600 }}>0% (garments) — document-driven clearance</div></div>
            {selected.logistics && <div><span style={{ color: 'var(--text-muted)' }}>Container / seal</span><div style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{selected.logistics.containerNo} / {selected.logistics.sealNo}</div></div>}
            {selected.logistics && <div><span style={{ color: 'var(--text-muted)' }}>Gross weight / packages</span><div style={{ fontWeight: 600 }}>{selected.logistics.grossWeightKg?.toLocaleString('en-US')} kg · {selected.logistics.packages} {selected.logistics.packageType}</div></div>}
            {selected.inspectionResult && <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--text-muted)' }}>Inspection</span><div style={{ fontWeight: 600 }}>{selected.inspectionResult}</div></div>}
          </div>
        </div>

        {/* eCO linkage */}
        {eCo && (
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
              Certificate of origin (eCO)
            </div>
            <div style={{ fontSize: 12.5 }}>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{eCo.ref}</span>
              <span style={{ margin: '0 8px', color: 'var(--text-muted)' }}>·</span>
              Form <strong>{eCo.formType}</strong> issued by {eCo.issuer} via {eCo.issuedVia}
            </div>
            {eCo.paperOriginalRequired && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
                <strong>Evidence twin, not the legal instrument:</strong> {eCo.paperRule}
              </div>
            )}
          </div>
        )}

        {/* Origin composition chain */}
        <OriginChain oc={detail?.consignment?.originComposition} />

        {/* Dossier checklist */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Dossier checklist {detail && `(${detail.dossier.anchoredCount}/${detail.dossier.requiredCount} anchored)`}
            </div>
            {detail?.documents?.some(d => d.notarization?.proofId && !d.notarization?.verified) && (
              <button className="btn btn-p btn-sm" onClick={handleVerifyAll} disabled={!!verifyingId}>
                <ShieldCheck style={{ width: 11, height: 11 }} /> Verify all
              </button>
            )}
          </div>
          {!detail ? <div className="empty" style={{ padding: 14 }}>Loading dossier…</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {detail.documents.map(d => (
                <DocVerifyRow key={d.id} d={d} ucr={selected.ucr} nodeId={nodeInfo?.nodeId} onVerify={handleVerify} verifying={verifyingId === d.id} />
              ))}
            </div>
          )}
        </div>

        {/* Import side: draft declaration from verified dossier */}
        {detail && !isExportSide && (
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
              Import declaration — pre-filled from the verified dossier
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              One dossier, two declarations: every field below is traceable to a provenance-backed source document. No re-keying.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {detail.draftDeclaration.fields.map(f => <ProvenanceField key={f.key} f={f} />)}
              </tbody>
            </table>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>Importer-side fields outstanding:</strong> {detail.draftDeclaration.missing.join(' · ')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              {canAccept && !detail.draftDeclaration.alreadyAccepted && (
                <button className="btn btn-p" onClick={handleAccept} disabled={accepting}>
                  {accepting ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <FileCheck2 style={{ width: 13, height: 13 }} />}
                  Accept pre-lodged data
                </button>
              )}
              {detail.draftDeclaration.alreadyAccepted && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: '#15803d' }}>
                  <CheckCircle2 style={{ width: 14, height: 14 }} /> Draft import declaration created
                </span>
              )}
              {canAccept && !correctionOpen && (
                <button className="btn btn-s" onClick={() => setCorrectionOpen(true)}>
                  <Send style={{ width: 12, height: 12 }} /> Request correction
                </button>
              )}
              {actionMsg && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{actionMsg}</span>}
            </div>
            {correctionOpen && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <textarea
                  autoFocus
                  rows={2}
                  value={correctionText}
                  onChange={e => setCorrectionText(e.target.value)}
                  placeholder="Describe the correction needed — sent back to the exporter side"
                  style={{ flex: 1, fontSize: 12.5, padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <button className="btn btn-p btn-sm" onClick={handleSendCorrection} disabled={!correctionText.trim()}>
                  <Send style={{ width: 11, height: 11 }} /> Send
                </button>
                <button className="btn btn-s btn-sm" onClick={() => { setCorrectionOpen(false); setCorrectionText(''); }}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Queue view ───────────────────────────────────────────────────────
  const rows = queue.declarations;
  return (
    <div className="stack">
      <div className="g4">
        <div className="stat-card">
          <div className="stat-icon orange"><Landmark /></div>
          <div className="stat-label">{isExportSide ? 'Export Declarations' : 'Inbound Dossiers'}</div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">{isExportSide ? 'filed in the national customs system' : 'pre-lodged from the export side'}</div>
        </div>
        {['green', 'yellow', 'red'].map(ch => (
          <div className="stat-card" key={ch}>
            <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ChannelPill channel={ch} /> Channel
            </div>
            <div className="stat-value">{queue.counts[ch]}</div>
            {/* UX P2: the published base rates are export-side context; on the
                import side show only the clear-time reference. */}
            <div className="stat-sub">
              {isExportSide ? `base rate ${queue.baseRates[ch]}% · ` : ''}{queue.referenceClearTimes[ch]}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {isExportSide ? 'Declaration queue'
              : queue.role === 'importCustoms' ? 'Inbound dossiers — customs review'
              : 'Import pre-clearance'}
          </h3>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Verified dossiers clear {queue.referenceClearTimes.green}; unverified wait {queue.referenceClearTimes.yellow} on manual review.
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <span>
              {isExportSide ? 'No declarations on this node.' : 'No consignments shared with your organisation yet — ask the exporter to share a dossier from the Alpha node.'}
            </span>
            {/* UX P0-2: manual refresh affordance — if the cross-node share
                lands while this screen is open and the WS push is missed,
                the presenter is one click from recovery instead of stuck. */}
            <button className="btn btn-s btn-sm" onClick={refresh}>
              <Loader2 style={{ width: 11, height: 11 }} /> Check again
            </button>
          </div>
        ) : (
          <div className="desktop-table" style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Declaration</th>
                  <th>Exporter → Importer</th>
                  <th>Goods</th>
                  <th>Channel</th>
                  <th>Dossier</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} onClick={() => loadDetail(r)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700 }}>{r.declarationNo ?? '—'}</div>
                      <div className="ucr-date">{r.ucr}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div style={{ fontWeight: 600 }}>{r.exporter}</div>
                      <div style={{ color: 'var(--text-muted)' }}>→ {r.importer} ({r.toCountry})</div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div>{r.product?.slice(0, 34)}</div>
                      <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>HS {r.hsCode}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <ChannelPill channel={r.channel} />
                        {r.errorType && <AlertTriangle title={r.errorType} style={{ width: 13, height: 13, color: '#b91c1c' }} />}
                        {/* UX P1-7: this is the A2 punchline — make it a real badge, not fine print. */}
                        {r.channel !== 'green' && r.wouldImproveIfVerified && (
                          <span title="With a verified dossier, the risk engine would have everything it needs to keep this green"
                                style={{ fontSize: 10, fontWeight: 800, color: '#15803d', background: '#dcfce7', border: '1px solid #86efac', padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                            → GREEN if verified
                          </span>
                        )}
                        {/* UX P1-8: surface the EUR.1 paper-rule case in the queue. */}
                        {r.eCo?.formType === 'EUR.1' && (
                          <span title="EUR.1 above EUR 6,000 requires the printed original — the digital copy is an evidence twin"
                                style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                            EUR.1 paper
                          </span>
                        )}
                      </div>
                      {r.releasedAt
                        ? <div style={{ fontSize: 10.5, color: '#15803d', display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}><CheckCircle2 style={{ width: 11, height: 11 }} /> released</div>
                        : <div style={{ fontSize: 10.5, color: '#b45309', display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}><Clock style={{ width: 11, height: 11 }} /> held</div>}
                    </td>
                    <td><DossierPill dossier={r.dossier} /></td>
                    <td style={{ textAlign: 'right' }}><span className="value-cell">{fmtValue(r.totalValue, r.currency)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
