import React, { useState, useEffect, useRef } from 'react';
import { useNode } from '../context/NodeContext';
import { api } from '../utils/api';
import { fmtValue } from '../utils/format';
import { StatusPill, DocsPill, DocTypeIcon } from './shared/Pills';
import XmlViewer from './XmlViewer';
import { Plus, Upload, Send, Download, FileText, Lock, X, AlertTriangle, ChevronLeft, Eye, Code2, Loader, ArrowRight, Fingerprint, History, ExternalLink, Network, ArrowLeftRight, ShieldCheck, ChevronRight, Inbox } from 'lucide-react';
import NotarizationBadge from './NotarizationBadge';
import VerifyQr from './shared/VerifyQr';
import ShipmentQr from './shared/ShipmentQr';
import FederationReceipt from './FederationReceipt';

// T-311: capitalize originNode (e.g. 'alpha' -> 'Alpha') for the
// "Shared from X" pill. Returns null when the consignment was created
// locally so callers can short-circuit the pill render.
function sharedFromLabel(consignment, localNodeId) {
  if (!consignment?.originNode || !localNodeId) return null;
  if (consignment.originNode === localNodeId) return null;
  const v = String(consignment.originNode);
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// Capitalize a node id for display (e.g. 'beta' -> 'Beta').
function capNode(id) {
  const v = String(id || '');
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// Persistent "Federated" badge label, shown on the SENDER's side once a
// consignment has been federated to one or more peer-node orgs over DSP.
// `nodes` is a Set of peer node ids the consignment was federated to,
// tracked client-side from the share response. Returns null when none.
//   single node:  ⇄ Federated → Beta
//   multiple:     ⇄ Federated · N nodes
function federatedLabel(nodes) {
  if (!nodes || nodes.size === 0) return null;
  if (nodes.size === 1) return `Federated → ${capNode([...nodes][0])}`;
  return `Federated · ${nodes.size} nodes`;
}

export default function Consignments({ searchQ = '', targetConsignment = null, onClearTarget, onNavigate }) {
  const { user, nodeInfo, peerOrgs, refresh, refreshKey, peerConnected, trackPendingAnchor } = useNode();
  const [consignments, setConsignments] = useState([]);
  const [selectedC, setSelectedC] = useState(null);
  const detailRef = React.useRef(null);
  const [docs, setDocs] = useState([]);
  const [allOrgs, setAllOrgs] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [viewingXml, setViewingXml] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [showAudit, setShowAudit] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  // Client-side federation tracking: consignmentId -> Set<peerNodeId>.
  // Seeded from each successful cross-node share response (the backend does
  // not yet persist a federatedTo field on the consignment). Drives the
  // persistent "⇄ Federated" badge on the sender's table row + detail header.
  const [federatedMap, setFederatedMap] = useState({});
  const recordFederation = (consignmentId, nodeId) => {
    if (!consignmentId || !nodeId) return;
    setFederatedMap(prev => {
      const next = new Set(prev[consignmentId] || []);
      next.add(nodeId);
      return { ...prev, [consignmentId]: next };
    });
  };

  const reloadConsignments = async () => {
    const list = await api.getConsignments(user.id).catch(() => []);
    setConsignments(list);
    if (selectedC) {
      const refreshed = list.find(x => x.id === selectedC.id);
      if (refreshed) setSelectedC(refreshed);
    }
  };

  const STATUS_OPTIONS = ['Draft', 'Released', 'In Transit', 'Customs', 'Delivered', 'Cancelled'];
  const handleStatusChange = async (next) => {
    if (!selectedC || next === selectedC.status) return;
    setStatusBusy(true);
    try {
      await api.updateConsignmentStatus(selectedC.id, { status: next, actorOrgId: user.id });
      await reloadConsignments();
    } catch (e) {
      alert(`Status change failed: ${e.message}`);
    } finally {
      setStatusBusy(false);
    }
  };

  useEffect(() => {
    api.getConsignments(user.id).then(setConsignments).catch(() => {});
    api.getAllOrgs().then(setAllOrgs).catch(() => {});
  }, [user.id, refreshKey]);

  // Auto-select when navigated from Dashboard
  useEffect(() => {
    if (targetConsignment) {
      setSelectedC(targetConsignment);
      onClearTarget?.();
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [targetConsignment]);

  useEffect(() => {
    if (selectedC) api.getDocuments(user.id, selectedC.id).then(setDocs).catch(() => {});
    else setDocs([]);
  }, [selectedC, user.id, refreshKey]);

  const filters = [
    { id: 'all', label: 'All' },
    { id: 'In Transit', label: 'In Transit' },
    { id: 'Customs', label: 'Customs' },
    { id: 'Under Review', label: 'Under Review' },
    { id: 'Delivered', label: 'Delivered' },
  ];

  const filtered = consignments.filter(c => {
    const matchFilter = activeFilter === 'all' || c.status === activeFilter;
    const matchSearch = !searchQ || c.ucr?.toLowerCase().includes(searchQ.toLowerCase()) || c.product?.toLowerCase().includes(searchQ.toLowerCase()) || c.exporter?.toLowerCase().includes(searchQ.toLowerCase());
    return matchFilter && matchSearch;
  });

  if (viewingXml) {
    return (
      <div className="stack">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <button className="btn btn-s btn-sm" onClick={() => setViewingXml(null)}>
            <ChevronLeft style={{ width: 13, height: 13 }} /> Back to Documents
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{viewingXml.title}</span>
        </div>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Code2 style={{ width: 16, height: 16, color: 'var(--amber)' }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{viewingXml.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{viewingXml.format} · Ref: {viewingXml.reference}</div>
              </div>
            </div>
            <a href={api.downloadUrl(viewingXml.id)} className="btn btn-s btn-sm">
              <Download style={{ width: 12, height: 12 }} /> Download XML
            </a>
          </div>
          <div style={{ padding: 16 }}>
            <XmlViewer
              docId={viewingXml.id}
              docType={viewingXml.docType}
              errorType={selectedC?.errorType}
              errorDescription={selectedC?.errorDescription}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Consignments</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>TWIN trade documents anchored on ledger</div>
        </div>
        <button className="btn btn-p" onClick={() => setShowCreate(true)}><Plus style={{ width: 14, height: 14 }} /> New Consignment</button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {filters.map(f => (
          <button
            key={f.id}
            className={`btn btn-sm ${activeFilter === f.id ? 'btn-p' : 'btn-s'}`}
            onClick={() => setActiveFilter(f.id)}
          >
            {f.label}
            <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 10 }}>
              ({f.id === 'all' ? consignments.length : consignments.filter(c => c.status === f.id).length})
            </span>
          </button>
        ))}
      </div>

      {/* Consignments table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="empty">No consignments match your filter.</div>
        ) : (
          <>
            <div className="desktop-table">
              <table>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Route & Product</th>
                    <th>Parties</th>
                    <th>Docs</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => {
                    const sharedFrom = sharedFromLabel(c, nodeInfo?.nodeId);
                    const fedLabel = !sharedFrom && federatedLabel(federatedMap[c.id]);
                    return (
                    <tr key={c.id} onClick={() => setSelectedC(selectedC?.id === c.id ? null : c)} style={{ background: selectedC?.id === c.id ? 'var(--accent-light)' : undefined }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <button className="ucr-link" onClick={e => { e.stopPropagation(); setSelectedC(selectedC?.id === c.id ? null : c); setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }}>{c.ucr}</button>
                          {sharedFrom && (
                            <span className="pill pill-b" style={{ fontSize: 9.5, padding: '2px 7px' }} title={`This consignment was created on the peer node (${sharedFrom}) and shared with us. The authoritative copy lives on the peer's TWIN.`}>
                              <Network style={{ width: 9, height: 9 }} /> Shared from {sharedFrom}
                            </span>
                          )}
                          {fedLabel && (
                            <span className="pill pill-b" style={{ fontSize: 9.5, padding: '2px 7px' }} title="This consignment was federated to an organisation on the peer's TWIN node over the Dataspace Protocol. The data was delivered to their sovereign node — not just shared as a link.">
                              <ArrowLeftRight style={{ width: 9, height: 9 }} /> {fedLabel}
                            </span>
                          )}
                        </div>
                        <div className="ucr-date">{c.shipDate || new Date(c.createdAt || Date.now()).toLocaleDateString()}</div>
                      </td>
                      <td>
                        {c.fromCountry && c.toCountry ? (
                          <div className="route-display">
                            <span>{c.fromCountry}</span>
                            <span className="route-arrow">→</span>
                            <span>{c.toCountry}</span>
                          </div>
                        ) : (
                          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{c.creatorOrgName}</div>
                        )}
                        <div className="route-product">{c.product || c.description || '—'}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.exporter || c.creatorOrgName}</div>
                        {c.importer && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.importer}</div>}
                      </td>
                      <td><DocsPill count={c.documentCount || 0} total={6} /></td>
                      <td>
                        <StatusPill status={c.status} />
                        {c.errorType && (
                          <span title={c.errorDescription} style={{ marginLeft: 5 }}>
                            <AlertTriangle style={{ width: 12, height: 12, color: '#a16207', verticalAlign: 'middle' }} />
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="value-cell">{fmtValue(c.totalValue, c.currency)}</span>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobile-cards" style={{ padding: 12 }}>
              {filtered.map(c => {
                const sharedFrom = sharedFromLabel(c, nodeInfo?.nodeId);
                const fedLabel = !sharedFrom && federatedLabel(federatedMap[c.id]);
                return (
                <div key={c.id} className="mobile-card" onClick={() => { setSelectedC(selectedC?.id === c.id ? null : c); setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} style={{ cursor: 'pointer', background: selectedC?.id === c.id ? 'var(--accent-light)' : undefined }}>
                  <div className="mobile-card-header">
                    <div>
                      <div className="mobile-card-title">
                        {c.ucr}
                        {sharedFrom && (
                          <span className="pill pill-b" style={{ fontSize: 9.5, padding: '2px 7px', marginLeft: 6 }}>
                            <Network style={{ width: 9, height: 9 }} /> Shared
                          </span>
                        )}
                        {fedLabel && (
                          <span className="pill pill-b" style={{ fontSize: 9.5, padding: '2px 7px', marginLeft: 6 }} title="Federated to the peer's TWIN node over the Dataspace Protocol.">
                            <ArrowLeftRight style={{ width: 9, height: 9 }} /> Federated
                          </span>
                        )}
                      </div>
                      <div className="mobile-card-sub">{c.shipDate || new Date(c.createdAt || Date.now()).toLocaleDateString()}</div>
                    </div>
                    <StatusPill status={c.status} />
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Route</span>
                    <span className="mobile-card-value">{c.fromCountry && c.toCountry ? `${c.fromCountry} → ${c.toCountry}` : (c.creatorOrgName || '—')}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Product</span>
                    <span className="mobile-card-value">{(c.product || c.description || '—').slice(0, 30)}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Docs</span>
                    <span className="mobile-card-value"><DocsPill count={c.documentCount || 0} total={6} /></span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Value</span>
                    <span className="mobile-card-value" style={{ fontWeight: 700 }}>{fmtValue(c.totalValue, c.currency)}</span>
                  </div>
                </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Selected consignment detail */}
      {selectedC && (
        <div ref={detailRef} className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header */}
          <div className="csg-detail-header">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <span className="ucr-ref" style={{ fontSize: 15 }}>{selectedC.ucr}</span>
                <StatusPill status={selectedC.status} />
                {selectedC.errorType && <span className="pill pill-review pill-dot">{selectedC.errorType?.replace(/_/g, ' ')}</span>}
                {sharedFromLabel(selectedC, nodeInfo?.nodeId) && (
                  <span className="pill pill-b" style={{ fontSize: 10 }} title="This consignment was created on the peer node and shared with us.">
                    <Network style={{ width: 10, height: 10 }} /> Shared from {sharedFromLabel(selectedC, nodeInfo?.nodeId)}
                  </span>
                )}
                {!sharedFromLabel(selectedC, nodeInfo?.nodeId) && federatedLabel(federatedMap[selectedC.id]) && (
                  <span className="pill pill-b" style={{ fontSize: 10 }} title="This consignment was federated to an organisation on the peer's TWIN node over the Dataspace Protocol. The data was delivered to their sovereign node.">
                    <ArrowLeftRight style={{ width: 10, height: 10 }} /> {federatedLabel(federatedMap[selectedC.id])}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font)' }}>
                {selectedC.commercialInvoiceNo && `CI: ${selectedC.commercialInvoiceNo}`}
                {selectedC.commercialInvoiceNo && selectedC.exportDeclarationNo && ' · '}
                {selectedC.exportDeclarationNo && `ED: ${selectedC.exportDeclarationNo}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {selectedC.creatorOrgId === user.id && (
                <select
                  className="csg-status-select"
                  value={selectedC.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  disabled={statusBusy}
                  title="Change consignment status (owner only). Each change is logged as a tamper-evident changeset on the TWIN AIG.">
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              {selectedC.aigVertexId && (
                <button
                  className="btn btn-s btn-sm"
                  onClick={() => setShowAudit(true)}
                  title="View the AIG audit trail — every status change is anchored as a signed changeset.">
                  <History style={{ width: 12, height: 12 }} /> Audit log
                </button>
              )}
              {/* T-4V04: shipment-level QR — anyone who can see the consignment may mint it. */}
              <ShipmentQr consignment={selectedC} nodeId={nodeInfo?.nodeId} />
              <button className="btn btn-p btn-sm"
                onClick={() => setShowUpload(true)}
                disabled={!user?.did}
                title={user?.did ? undefined : "Register your organization's DID to upload documents"}>
                <Upload style={{ width: 12, height: 12 }} /> Upload
              </button>
              <button className="btn btn-s btn-sm" onClick={() => setShowShare(true)}><Send style={{ width: 12, height: 12 }} /> Share</button>
              <button className="btn btn-s btn-sm" onClick={() => setSelectedC(null)}><X style={{ width: 12, height: 12 }} /></button>
            </div>
          </div>

          {/* Metadata grid */}
          {(selectedC.product || selectedC.vessel || selectedC.incoterms) && (
            <div className="csg-meta-grid" style={{ borderBottom: '1px solid var(--card-border)' }}>
              {selectedC.product && <div className="csg-meta-item"><div className="meta-label">Product</div><div className="meta-value">{selectedC.product}</div></div>}
              {selectedC.hsCode && <div className="csg-meta-item"><div className="meta-label">HS Code</div><div className="meta-value">{selectedC.hsCode}</div></div>}
              {selectedC.quantity && <div className="csg-meta-item"><div className="meta-label">Quantity</div><div className="meta-value">{selectedC.quantity} {selectedC.unit}</div></div>}
              {selectedC.vessel && <div className="csg-meta-item"><div className="meta-label">Vessel</div><div className="meta-value">{selectedC.vessel}</div></div>}
              {selectedC.originPort && <div className="csg-meta-item"><div className="meta-label">Origin Port</div><div className="meta-value">{selectedC.originPort}</div></div>}
              {selectedC.destinationPort && <div className="csg-meta-item"><div className="meta-label">Destination Port</div><div className="meta-value">{selectedC.destinationPort}</div></div>}
              {selectedC.incoterms && <div className="csg-meta-item"><div className="meta-label">Incoterms</div><div className="meta-value">{selectedC.incoterms}</div></div>}
              {selectedC.shipDate && <div className="csg-meta-item"><div className="meta-label">Ship Date</div><div className="meta-value">{selectedC.shipDate}</div></div>}
              {selectedC.totalValue && <div className="csg-meta-item"><div className="meta-label">Total Value</div><div className="meta-value">{fmtValue(selectedC.totalValue, selectedC.currency)}</div></div>}
            </div>
          )}

          {selectedC.errorDescription && (
            <div style={{ padding: '10px 20px', background: '#fefce8', borderBottom: '1px solid #fde68a', display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
              <AlertTriangle style={{ width: 15, height: 15, color: '#a16207', flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong style={{ color: '#a16207' }}>Reconciliation Alert:</strong>
                <span style={{ color: '#a16207', marginLeft: 6 }}>{selectedC.errorDescription}</span>
              </div>
            </div>
          )}

          {/* Documents */}
          <div style={{ padding: '16px 20px 6px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
              Documents ({docs.length})
            </div>
            {!user?.did && (
              <div className="identity-gate-banner">
                <Fingerprint style={{ width: 18, height: 18, flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="identity-gate-banner__title">Identity required to upload documents</div>
                  <div className="identity-gate-banner__body">
                    {user?.regNumber
                      ? <>You've started registering <strong>{user.name}</strong> but the DID hasn't been issued yet. Finish the registration to start uploading signed documents.</>
                      : <>Every document uploaded to TWIN is cryptographically signed with your organization's Decentralized Identifier (DID). <strong>{user?.name}</strong> hasn't registered a DID yet, so uploads are disabled.</>}
                  </div>
                  <div className="identity-gate-banner__actions">
                    <button className="btn btn-p btn-sm" onClick={() => onNavigate?.('identity')}>
                      {user?.regNumber ? 'Complete Registration' : 'Register DID'} <ArrowRight style={{ width: 12, height: 12 }} />
                    </button>
                    <span className="identity-gate-banner__hint">Takes about 30 seconds</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          {docs.length === 0 ? (
            <div className="empty" style={{ paddingTop: 16 }}>No documents anchored yet.</div>
          ) : (
            <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {docs.map(d => {
                const isXml = d.filename?.endsWith('.xml');
                return (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', background: '#f8fafc', borderRadius: 10, border: '1px solid var(--card-border)' }}>
                    <DocTypeIcon docType={d.docType} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{d.title}</div>
                      {d.issuer && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, fontWeight: 500 }}>
                          Issued by {d.issuer}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                        {d.reference && <span>{d.reference}</span>}
                        {d.format && <span>· {d.format}</span>}
                        {d.fileSize > 0 && <span>· {Math.round(d.fileSize / 1024)}KB</span>}
                      </div>
                    </div>
                    <NotarizationBadge doc={d} onDocUpdated={updated => setDocs(prev => prev.map(x => x.id === updated.id ? { ...x, ...updated } : x))} />
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {/* T-4V03 (WP4): public-verification QR — same affordance as
                          the Dashboard detail and the Customs Desk dossier rows. */}
                      <VerifyQr doc={{ ...d, ucr: selectedC?.ucr }} nodeId={nodeInfo?.nodeId} />
                      {isXml && (
                        <button className="btn btn-s btn-sm" onClick={() => setViewingXml(d)}>
                          <Eye style={{ width: 11, height: 11 }} /> View XML
                        </button>
                      )}
                      {d.filename && (
                        <a href={api.downloadUrl(d.id)} className="btn btn-s btn-sm" style={{ textDecoration: 'none' }} target="_blank" rel="noreferrer">
                          <Download style={{ width: 11, height: 11 }} />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showCreate && <CreateModal onClose={() => { setShowCreate(false); refresh(); }} userId={user.id} />}
      {showUpload && selectedC && <UploadModal consignment={selectedC} userId={user.id}
        onUploaded={(doc) => {
          // If the on-chain reference is already populated (rare fast path)
          // we let the row's ↗ icon speak for itself. Otherwise register
          // the doc with the anchor poller so the user gets a toast when
          // TWIN finishes signing (~5-15s later).
          if (doc?.notarizationMode !== 'simulated' && doc?.proofId && !doc?.proofExplorerUrl) {
            trackPendingAnchor?.(doc.id, doc.title);
          }
        }}
        onClose={() => { setShowUpload(false); refresh(); }} />}
      {showShare && selectedC && <ShareModal consignment={selectedC} user={user} allOrgs={allOrgs} peerOrgs={peerOrgs} peerConnected={peerConnected} nodeInfo={nodeInfo} onFederated={recordFederation} onClose={() => { setShowShare(false); refresh(); }} />}
      {showAudit && selectedC && <AuditLogModal consignment={selectedC} onClose={() => setShowAudit(false)} />}
    </div>
  );
}

function AuditLogModal({ consignment, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getConsignmentAudit(consignment.id)
      .then(r => { if (!cancelled) { setData(r); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [consignment.id]);

  const entries = data?.changesets?.itemListElement ?? [];

  const opClass = (op) => {
    const o = String(op || '').toLowerCase();
    if (o === 'add') return 'audit-op--add';
    if (o === 'replace') return 'audit-op--replace';
    if (o === 'remove') return 'audit-op--remove';
    return 'audit-op--default';
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: 760 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}><History style={{ width: 16, height: 16, verticalAlign: -3 }} /> AIG Audit Log</h3>
            <div className="audit-head__sub">
              <span>{consignment.ucr}</span>
              <span className="audit-head__dot" aria-hidden="true" />
              <span>{entries.length} changeset{entries.length === 1 ? '' : 's'}</span>
              {data?.aigVertexId && (
                <>
                  <span className="audit-head__dot" aria-hidden="true" />
                  <span>vertex <span className="audit-head__vertex">{data.aigVertexId}</span></span>
                </>
              )}
            </div>
          </div>
          <button className="btn btn-s btn-sm" onClick={onClose}><X style={{ width: 12, height: 12 }} /></button>
        </div>
        <div style={{ maxHeight: '60vh', overflow: 'auto', marginTop: 8 }}>
          {loading && (
            <div className="audit-state">
              <Loader style={{ width: 15, height: 15 }} className="spin" />
              Loading audit trail from TWIN node…
            </div>
          )}
          {error && (
            <div className="audit-state audit-state--err">
              <AlertTriangle style={{ width: 15, height: 15 }} />
              {error}
            </div>
          )}
          {!loading && !error && !data?.aigVertexId && (
            <div className="audit-state--empty">
              <strong><Inbox style={{ width: 14, height: 14, verticalAlign: -2, marginRight: 6 }} />No AIG vertex for this consignment</strong>
              {data?.mode === 'simulated'
                ? 'Audit shadowing is inactive in simulated mode.'
                : 'AIG write may have failed at creation time — check the server log.'}
            </div>
          )}
          {!loading && !error && entries.length > 0 && (
            <ol className="audit-list">
              {entries.map((cs) => (
                <li key={cs.id} className="audit-item">
                  <span className="audit-item__badge">v{cs.version}</span>
                  <span className="audit-item__rail" aria-hidden="true" />
                  <div className="audit-item__header">
                    <span className="audit-item__time">{new Date(cs.dateCreated).toLocaleString()}</span>
                    {cs.proofId && (
                      <span className="audit-proof" title="Each AIG changeset is anchored by its own immutable-proof VC.">
                        <ShieldCheck /> {cs.proofId.slice(-12)}
                      </span>
                    )}
                  </div>
                  <ul className="audit-patches">
                    {(cs.patches || []).map((p, i) => (
                      <li key={i} className="audit-patch">
                        <span className={`audit-op ${opClass(p.patchOperation)}`}>{p.patchOperation}</span>
                        <span className="audit-path">{p.patchPath}</span>
                        {p.patchValue && typeof p.patchValue === 'object' && (
                          <details className="audit-value">
                            <summary><ChevronRight /> show value</summary>
                            <pre className="audit-patch-pre">{JSON.stringify(p.patchValue, null, 2)}</pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="modal-act"><button className="btn btn-p" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

function CreateModal({ onClose, userId }) {
  const [ucr, setUcr] = useState('UCR-2026-' + String(Math.floor(Math.random() * 99999)).padStart(5, '0'));
  const [ci, setCi] = useState('');
  const [ed, setEd] = useState('');
  const [desc, setDesc] = useState('');
  const submit = async (e) => {
    e?.preventDefault?.();
    await api.createConsignment({ ucr, commercialInvoiceNo: ci, exportDeclarationNo: ed, description: desc, creatorOrgId: userId });
    onClose();
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>Create Consignment (Digital Twin)</h3>
        <div className="fg"><label>UCR Number (Primary ID)</label><input value={ucr} onChange={e => setUcr(e.target.value)} /></div>
        <div className="g2">
          <div className="fg"><label>Commercial Invoice No.</label><input value={ci} onChange={e => setCi(e.target.value)} placeholder="e.g. INV-2026-001" /></div>
          <div className="fg"><label>Export Declaration No.</label><input value={ed} onChange={e => setEd(e.target.value)} placeholder="e.g. EXD-2026-001" /></div>
        </div>
        <div className="fg"><label>Description</label><textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Consignment description..." /></div>
        <div className="modal-act">
          <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-p"><Plus style={{ width: 13, height: 13 }} /> Create & Anchor</button>
        </div>
      </form>
    </div>
  );
}

function UploadModal({ consignment, userId, onClose, onUploaded }) {
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('General');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef();
  const submit = async (e) => {
    e?.preventDefault?.();
    if (uploading || !title.trim()) return;
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append('consignmentId', consignment.id);
    fd.append('title', title);
    fd.append('docType', docType);
    fd.append('creatorOrgId', userId);
    if (file) fd.append('file', file);
    try {
      const result = await api.uploadDocument(fd);
      if (result?.error) throw new Error(result.error + (result.detail ? ` — ${result.detail}` : ''));
      onUploaded?.(result);
      onClose();
    } catch (e) {
      setError(e.message || 'Upload failed');
      setUploading(false);
    }
  };
  const handleBackdrop = () => { if (!uploading) onClose(); };
  return (
    <div className="modal-bg" onClick={handleBackdrop}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>Upload Document — {consignment.ucr}</h3>
        <div className="fg">
          <label>Document Title <span style={{ color: '#dc2626' }}>*</span></label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Commercial Invoice" autoFocus disabled={uploading} />
          {!title.trim() && !uploading && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Required — fill the title to enable upload.</div>
          )}
        </div>
        <div className="fg">
          <label>Document Type</label>
          <select value={docType} onChange={e => setDocType(e.target.value)} disabled={uploading}>
            {['General','Commercial Invoice','Certificate of Origin','Bill of Lading','Export Declaration','Import Declaration','Health Certificate','Phytosanitary Certificate','Packing List','Insurance Certificate'].map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="fg">
          <label>Attach File</label>
          <div style={{ border: '2px dashed var(--card-border)', borderRadius: 10, padding: 24, textAlign: 'center', cursor: uploading ? 'not-allowed' : 'pointer', background: file ? '#f0fdf4' : 'white', opacity: uploading ? 0.6 : 1, transition: 'all 0.15s' }} onClick={() => { if (!uploading) fileRef.current?.click(); }}>
            {file
              ? <><FileText style={{ width: 22, height: 22, color: '#16a34a', margin: '0 auto 6px' }} /><div style={{ fontSize: 12.5, color: '#166534', fontWeight: 500 }}>{file.name} ({Math.round(file.size / 1024)}KB)</div></>
              : <><Upload style={{ width: 22, height: 22, color: 'var(--text-muted)', margin: '0 auto 6px' }} /><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Click to select file</div></>}
          </div>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => setFile(e.target.files[0])} disabled={uploading} />
          {/* TWIN composite storage limit: /documents has a 1 MB Fastify body
              limit. After base64 encoding (~33% overhead) the practical safe
              threshold is ~700 KB nominal file size. Larger files are still
              notarized AND org-signed on chain — only the optional audit
              vertex (blob + AIG) is skipped. */}
          {file && file.size > 700 * 1024 && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <AlertTriangle style={{ width: 14, height: 14, color: '#92400e', flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11.5, color: '#92400e', lineHeight: 1.4 }}>
                File is {Math.round(file.size / 1024)} KB. The TWIN composite-storage endpoint has a 1 MB body limit (after base64 encoding); audit vertex creation may be skipped. The on-chain proof of your file hash + the org-signed attestation are still created.
              </div>
            </div>
          )}
          {!file && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Up to ~700 KB is stored end-to-end on the TWIN node (composite blob + AIG). Larger files still get notarized + org-signed — only the full audit vertex is skipped.
            </div>
          )}
        </div>
        {uploading && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader style={{ width: 16, height: 16, color: '#2563eb', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: '#1e40af' }}>Anchoring on IOTA testnet. This usually takes 5–15 seconds — please don't close this window.</span>
          </div>
        )}
        {error && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <AlertTriangle style={{ width: 16, height: 16, color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12.5, color: '#991b1b', wordBreak: 'break-word' }}>{error}</span>
          </div>
        )}
        <div className="modal-act">
          <button type="button" className="btn btn-s" onClick={onClose} disabled={uploading}>Cancel</button>
          <button type="submit" className="btn btn-p" disabled={!title.trim() || uploading}>
            {uploading
              ? <><Loader style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} /> Anchoring...</>
              : <><Upload style={{ width: 13, height: 13 }} /> Upload & Anchor</>}
          </button>
        </div>
      </form>
    </div>
  );
}

function ShareModal({ consignment, user, allOrgs, peerOrgs, peerConnected, nodeInfo, onFederated, onClose }) {
  const [perms, setPerms] = useState({});
  const [loading, setLoading] = useState(true);
  const [shareMode, setShareMode] = useState('all');
  const [selectedDocIds, setSelectedDocIds] = useState([]);
  const [docs, setDocs] = useState([]);
  const [sharingId, setSharingId] = useState(null);
  // When a CROSS-NODE share completes, we swap the modal body to a
  // FederationReceipt. `receipt` holds the federation object + the two
  // parties (sender / recipient) needed to render the two-node diagram.
  const [receipt, setReceipt] = useState(null);

  const shareableOrgs = [...allOrgs.filter(o => o.id !== user.id), ...peerOrgs.filter(po => !allOrgs.some(ao => ao.id === po.id))];

  useEffect(() => {
    api.getPermissions(consignment.id).then(p => { setPerms(p); setLoading(false); }).catch(() => setLoading(false));
    api.getDocuments(user.id, consignment.id).then(setDocs).catch(() => {});
  }, [consignment.id, user.id]);

  const toggleDoc = id => setSelectedDocIds(prev => prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id]);

  const doShare = async (org) => {
    setSharingId(org.id);
    try {
      const res = await api.shareConsignment({ consignmentId: consignment.id, recipientOrgId: org.id, recipientOrgName: org.name, sharerOrgName: user.name, shareMode, selectedDocIds: shareMode === 'selective' ? selectedDocIds : undefined });
      setPerms(p => ({ ...p, [org.id]: 'viewer' }));

      const fed = res?.federation;
      // Same-node (or simulated) share: federation is null — keep today's
      // lightweight success (the row now shows the "viewer" pill). Only a
      // real cross-node DSP federation surfaces the receipt.
      if (fed) {
        const recipientNode = fed.federatedToNode || org.nodeId || org.originNode;
        if (recipientNode && !fed.error) onFederated?.(consignment.id, recipientNode);
        setReceipt({
          federation: fed,
          sender: {
            name: fed.sharer?.name || user.name,
            role: user.role,
            nodeLabel: nodeInfo?.nodeName || capNode(nodeInfo?.nodeId) || 'This node',
          },
          recipient: {
            name: fed.recipient?.name || org.name,
            role: org.role,
            nodeLabel: org.nodeName || (recipientNode ? capNode(recipientNode) : 'Peer node'),
          },
        });
      }
    } finally {
      setSharingId(null);
    }
  };

  const doRevoke = async (org) => {
    await api.revokeAccess({ consignmentId: consignment.id, recipientOrgId: org.id, recipientOrgName: org.name, revokerOrgName: user.name });
    setPerms(p => { const n = { ...p }; delete n[org.id]; return n; });
  };

  // Receipt mode — keep the modal frame, swap the body.
  if (receipt) {
    return (
      <div className="modal-bg" onClick={onClose}>
        <div className="modal modal-lg fed-receipt" onClick={e => e.stopPropagation()}>
          <FederationReceipt
            federation={receipt.federation}
            ucr={consignment.ucr}
            sender={receipt.sender}
            recipient={receipt.recipient}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <h3>Share — {consignment.ucr}</h3>
        {docs.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.3px' }}>Share Mode</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={`btn btn-sm ${shareMode === 'all' ? 'btn-p' : 'btn-s'}`} onClick={() => setShareMode('all')}>All documents ({docs.length})</button>
              <button className={`btn btn-sm ${shareMode === 'selective' ? 'btn-p' : 'btn-s'}`} onClick={() => setShareMode('selective')}>Select specific</button>
            </div>
          </div>
        )}
        {shareMode === 'selective' && docs.length > 0 && (
          <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', borderRadius: 10, border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Select documents:</div>
            {docs.map(d => (
              <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedDocIds.includes(d.id)} onChange={() => toggleDoc(d.id)} />
                <FileText style={{ width: 13, height: 13, color: 'var(--text-muted)' }} />
                <span style={{ fontWeight: 500 }}>{d.title}</span>
                <span className="pill pill-b" style={{ marginLeft: 4, fontSize: 10, padding: '1px 7px' }}>{d.docType}</span>
              </label>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.3px' }}>Organisations</div>
        {!peerConnected && <div style={{ padding: '8px 12px', background: '#fef2f2', borderRadius: 8, fontSize: 11.5, color: '#991b1b', marginBottom: 10, display: 'flex', gap: 6 }}><Lock style={{ width: 12, height: 12 }} /> Peer node offline — cross-node sharing unavailable.</div>}
        {loading ? <div className="empty">Loading...</div> : shareableOrgs.length === 0 ? <div className="empty">No other organisations available.</div> : (
          shareableOrgs.map(o => {
            const has = !!perms[o.id];
            const isRemote = !o.local && !allOrgs.some(a => a.id === o.id);
            const disabled = isRemote && !peerConnected;
            return (
              <div className="sr" key={o.id} style={{ opacity: disabled ? 0.4 : 1 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{o.name}{isRemote && <span className="pill pill-a" style={{ marginLeft: 6, fontSize: 10 }}>peer node</span>}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{o.role}{o.nodeName ? ` — ${o.nodeName}` : ''}</div>
                </div>
                {has
                  ? <button className="btn btn-sm btn-d" onClick={() => doRevoke(o)} disabled={sharingId === o.id}>Revoke</button>
                  : <button className="btn btn-sm btn-p" onClick={() => doShare(o)} disabled={disabled || sharingId === o.id || (shareMode === 'selective' && selectedDocIds.length === 0)}>
                      {sharingId === o.id
                        ? <><Loader style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} /> Sharing…</>
                        : <><Send style={{ width: 11, height: 11 }} /> Share</>}
                    </button>}
              </div>
            );
          })
        )}
        <div className="modal-act"><button className="btn btn-p" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
