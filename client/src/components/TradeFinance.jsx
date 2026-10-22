import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import { useNode } from '../context/NodeContext';
import { useConfig } from '../context/ConfigContext';
import { useApiResource } from '../hooks/useApiResource';
import { fmtCurrency as fmtVal } from '../utils/format';
import { Plus, ChevronRight, CheckCircle, Circle, Clock, Zap, Hash, RefreshCw, Share2, X } from 'lucide-react';
import Modal from './shared/Modal';

const LC_STATUSES = ['Draft', 'Issued', 'Advised', 'Confirmed', 'Presented', 'Drawn'];
const CONTRACT_STATUSES = ['Draft', 'Active', 'Conditions Met', 'Released', 'Settled'];

/* ─── Status Pills ─── */
const lcPillStyle = {
  Draft:     { background: '#f1f5f9', color: '#64748b' },
  Issued:    { background: '#eff6ff', color: '#3b82f6' },
  Advised:   { background: '#f0fdf4', color: '#16a34a' },
  Confirmed: { background: '#faf5ff', color: '#9333ea' },
  Presented: { background: '#fff7ed', color: '#f97316' },
  Drawn:     { background: '#f0fdf4', color: '#15803d' },
  Expired:   { background: '#fef2f2', color: '#ef4444' },
};
const contractPillStyle = {
  Draft:            { background: '#f1f5f9', color: '#64748b' },
  Active:           { background: '#eff6ff', color: '#3b82f6' },
  'Conditions Met': { background: '#fff7ed', color: '#f97316' },
  Released:         { background: '#faf5ff', color: '#9333ea' },
  Settled:          { background: '#f0fdf4', color: '#15803d' },
  Cancelled:        { background: '#fef2f2', color: '#ef4444' },
};

const Pill = ({ label, styles }) => (
  <span style={{ ...styles, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, display: 'inline-block' }}>
    {label}
  </span>
);

/* ─── LC Status Stepper ─── */
const LCStepper = ({ status }) => {
  const idx = LC_STATUSES.indexOf(status);
  return (
    <div className="lc-stepper">
      {LC_STATUSES.map((s, i) => (
        <div key={s} className="lc-step">
          <div className="lc-step-node">
            <div style={{
              width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: i < idx ? '#16a34a' : i === idx ? '#3b82f6' : '#e2e8f0',
              color: i <= idx ? '#fff' : '#94a3b8', fontSize: 9, fontWeight: 700
            }}>
              {i < idx ? '✓' : i + 1}
            </div>
            <span style={{ fontSize: 8, color: i === idx ? '#3b82f6' : '#94a3b8', fontWeight: i === idx ? 700 : 400, whiteSpace: 'nowrap' }}>{s}</span>
          </div>
          {i < LC_STATUSES.length - 1 && (
            <div className="lc-connector" style={{ background: i < idx ? '#16a34a' : '#e2e8f0' }} />
          )}
        </div>
      ))}
    </div>
  );
};

/* ─── Contract Status Timeline ─── */
const ContractTimeline = ({ status }) => {
  const idx = CONTRACT_STATUSES.indexOf(status);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {CONTRACT_STATUSES.map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: i < idx ? '#16a34a' : i === idx ? '#3b82f6' : '#e2e8f0',
              color: i <= idx ? '#fff' : '#94a3b8', fontSize: 11, fontWeight: 700, flexShrink: 0
            }}>
              {i < idx ? '✓' : i === idx ? '●' : ''}
            </div>
            {i < CONTRACT_STATUSES.length - 1 && (
              <div style={{ width: 2, height: 20, background: i < idx ? '#16a34a' : '#e2e8f0' }} />
            )}
          </div>
          <span style={{ fontSize: 13, color: i === idx ? '#3b82f6' : i < idx ? '#16a34a' : '#94a3b8', fontWeight: i === idx ? 700 : 400, paddingTop: 4 }}>{s}</span>
        </div>
      ))}
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
   LETTER OF CREDIT TAB
══════════════════════════════════════════════════════════ */
function LCTab({ user, consignments, allOrgs, refresh, refreshKey, config }) {
  const [lcs, setLcs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [shareConsId, setShareConsId] = useState('');
  const [shareOrgId, setShareOrgId] = useState('');

  // New LC form state
  const [form, setForm] = useState({
    consignmentId: '', lcNumber: '', issuingBank: '', advisingBank: '',
    beneficiary: '', applicant: '', amount: '', currency: 'USD', expiryDate: '',
  });

  const loadLCs = useCallback(async () => {
    try {
      const data = await api.getLCs(user.id);
      setLcs(data);
    } catch (e) { console.error(e); }
  }, [user.id]);

  useEffect(() => { loadLCs(); }, [loadLCs, refreshKey]);

  const selectedLC = lcs.find(l => l.id === selected);
  const selectedCons = consignments.find(c => c.id === selectedLC?.consignmentId);

  const handleCreate = async () => {
    if (!form.consignmentId || !form.lcNumber || !form.issuingBank || !form.amount) return;
    const cons = consignments.find(c => c.id === form.consignmentId);
    if (!cons) return;
    try {
      await api.createLC({ ...form, ucr: cons.ucr, creatorOrgId: user.id, amount: parseFloat(form.amount) });
      setShowCreate(false);
      setForm({ consignmentId: '', lcNumber: '', issuingBank: '', advisingBank: '', beneficiary: '', applicant: '', amount: '', currency: 'USD', expiryDate: '' });
      loadLCs();
      refresh();
    } catch (e) { alert(e.message); }
  };

  const advanceStatus = async (lc) => {
    const idx = LC_STATUSES.indexOf(lc.status);
    if (idx >= LC_STATUSES.length - 1) return;
    try {
      await api.updateLCStatus(lc.id, { status: LC_STATUSES[idx + 1] });
      loadLCs();
      refresh();
    } catch (e) { alert(e.message); }
  };

  const handleShare = async () => {
    if (!shareConsId || !shareOrgId) return;
    try {
      await api.shareFinanceAccess({ consignmentId: shareConsId, targetOrgId: shareOrgId, role: 'viewer' });
      setShowShare(false);
      setShareConsId(''); setShareOrgId('');
    } catch (e) { alert(e.message); }
  };

  return (
    <div className={`tf-grid${selectedLC ? ' tf-grid--detail' : ' tf-grid--single'}`}>
      {/* Left: list */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Letters of Credit</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => setShowShare(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Share2 size={14} /> Share Finance Access
            </button>
            <button className="btn-primary" onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> New LC
            </button>
          </div>
        </div>

        {lcs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
            <div>No letters of credit yet</div>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
            <div className="desktop-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                    {['LC Number', 'UCR', 'Issuing Bank', 'Amount', 'Expiry', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lcs.map(lc => (
                    <tr key={lc.id} onClick={() => setSelected(lc.id === selected ? null : lc.id)}
                      style={{ borderBottom: '1px solid #f8fafc', cursor: 'pointer', background: lc.id === selected ? '#f0f9ff' : 'white' }}>
                      <td style={{ padding: '12px 14px', fontWeight: 600, fontSize: 13 }}>{lc.lcNumber}</td>
                      <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>{lc.ucr}</td>
                      <td style={{ padding: '12px 14px', fontSize: 13 }}>{lc.issuingBank}</td>
                      <td style={{ padding: '12px 14px', fontWeight: 600, fontSize: 13 }}>{fmtVal(lc.amount, lc.currency)}</td>
                      <td style={{ padding: '12px 14px', fontSize: 12, color: '#64748b' }}>{lc.expiryDate ? new Date(lc.expiryDate).toLocaleDateString() : '—'}</td>
                      <td style={{ padding: '12px 14px' }}><Pill label={lc.status} styles={lcPillStyle[lc.status] || {}} /></td>
                      <td style={{ padding: '12px 14px' }}><ChevronRight size={14} color="#94a3b8" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-cards" style={{ padding: 12 }}>
              {lcs.map(lc => (
                <div key={lc.id} className="mobile-card" onClick={() => setSelected(lc.id === selected ? null : lc.id)} style={{ cursor: 'pointer', background: lc.id === selected ? '#f0f9ff' : undefined }}>
                  <div className="mobile-card-header">
                    <div>
                      <div className="mobile-card-title">{lc.lcNumber}</div>
                      <div className="mobile-card-sub">{lc.ucr}</div>
                    </div>
                    <Pill label={lc.status} styles={lcPillStyle[lc.status] || {}} />
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Issuing Bank</span>
                    <span className="mobile-card-value">{lc.issuingBank}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Amount</span>
                    <span className="mobile-card-value" style={{ fontWeight: 700 }}>{fmtVal(lc.amount, lc.currency)}</span>
                  </div>
                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Expiry</span>
                    <span className="mobile-card-value">{lc.expiryDate ? new Date(lc.expiryDate).toLocaleDateString() : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: detail panel */}
      {selectedLC && (
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{selectedLC.lcNumber}</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{selectedLC.ucr}</div>
            </div>
            <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={16} color="#94a3b8" /></button>
          </div>

          <LCStepper status={selectedLC.status} />

          <div className="g2" style={{ marginBottom: 16 }}>
            {[
              ['Issuing Bank', selectedLC.issuingBank],
              ['Advising Bank', selectedLC.advisingBank || '—'],
              ['Beneficiary', selectedLC.beneficiary || '—'],
              ['Applicant', selectedLC.applicant || '—'],
              ['Amount', fmtVal(selectedLC.amount, selectedLC.currency)],
              ['Expiry', selectedLC.expiryDate ? new Date(selectedLC.expiryDate).toLocaleDateString() : '—'],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{k}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Document compliance */}
          {selectedLC.documentCompliance && selectedLC.documentCompliance.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>Document Compliance</div>
              {selectedLC.documentCompliance.map((dc, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f8fafc' }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: dc.compliant ? '#16a34a' : dc.submitted ? '#f97316' : '#e2e8f0'
                  }} />
                  <span style={{ fontSize: 12, flex: 1 }}>{dc.docType}</span>
                  <span style={{ fontSize: 11, color: dc.compliant ? '#16a34a' : dc.submitted ? '#f97316' : '#94a3b8' }}>
                    {dc.compliant ? 'Compliant' : dc.submitted ? 'Pending Review' : 'Not Submitted'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Advance status */}
          {selectedLC.status !== 'Drawn' && selectedLC.status !== 'Expired' && selectedLC.creatorOrgId === user.id && (
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => advanceStatus(selectedLC)}>
              Advance to {LC_STATUSES[LC_STATUSES.indexOf(selectedLC.status) + 1]}
            </button>
          )}
        </div>
      )}

      {/* Create LC Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New Letter of Credit" width={520}>
        <div className="tf-form-2col">
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Consignment *</label>
            <select className="input" value={form.consignmentId} onChange={e => setForm(f => ({ ...f, consignmentId: e.target.value }))}>
              <option value="">Select consignment…</option>
              {consignments.map(c => <option key={c.id} value={c.id}>{c.ucr} — {c.description}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>LC Number *</label>
            <input className="input" placeholder="LC-2026-001" value={form.lcNumber} onChange={e => setForm(f => ({ ...f, lcNumber: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Expiry Date</label>
            <input className="input" type="date" value={form.expiryDate} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Issuing Bank *</label>
            <input className="input" placeholder="Issuing bank" value={form.issuingBank} onChange={e => setForm(f => ({ ...f, issuingBank: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Advising Bank</label>
            <input className="input" placeholder="Advising bank" value={form.advisingBank} onChange={e => setForm(f => ({ ...f, advisingBank: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Beneficiary</label>
            <input className="input" placeholder="Exporter name" value={form.beneficiary} onChange={e => setForm(f => ({ ...f, beneficiary: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Applicant</label>
            <input className="input" placeholder="Importer name" value={form.applicant} onChange={e => setForm(f => ({ ...f, applicant: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Amount *</label>
            <input className="input" type="number" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Currency</label>
            <select className="input" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              {(config?.finance?.currencies || ['USD', 'EUR']).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreate(false)}>Cancel</button>
          <button className="btn-primary" style={{ flex: 1 }} onClick={handleCreate}>Create LC</button>
        </div>
      </Modal>

      {/* Share Finance Modal */}
      <Modal open={showShare} onClose={() => setShowShare(false)} title="Share Finance Access" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Consignment</label>
            <select className="input" value={shareConsId} onChange={e => setShareConsId(e.target.value)}>
              <option value="">Select consignment…</option>
              {consignments.map(c => <option key={c.id} value={c.id}>{c.ucr}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Organisation</label>
            <select className="input" value={shareOrgId} onChange={e => setShareOrgId(e.target.value)}>
              <option value="">Select org…</option>
              {allOrgs.filter(o => o.id !== user.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setShowShare(false)}>Cancel</button>
          <button className="btn-primary" style={{ flex: 1 }} onClick={handleShare}>Share</button>
        </div>
      </Modal>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SMART CONTRACTS TAB
══════════════════════════════════════════════════════════ */
function ContractsTab({ user, consignments, allOrgs, refresh, refreshKey, config }) {
  const [contracts, setContracts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  // New contract form
  const [form, setForm] = useState({
    consignmentId: '', payorOrgId: '', payeeOrgId: '',
    amount: '', currency: 'USD', autoRelease: true,
    conditions: [{ description: '', docType: '' }],
  });

  const loadContracts = useCallback(async () => {
    try {
      const data = await api.getContracts(user.id);
      setContracts(data);
    } catch (e) { console.error(e); }
  }, [user.id]);

  useEffect(() => { loadContracts(); }, [loadContracts, refreshKey]);

  const selectedContract = contracts.find(c => c.id === selected);

  const handleCreate = async () => {
    if (!form.consignmentId || !form.amount || form.conditions.some(c => !c.description)) return;
    const cons = consignments.find(c => c.id === form.consignmentId);
    if (!cons) return;
    try {
      await api.createContract({
        ...form,
        ucr: cons.ucr,
        creatorOrgId: user.id,
        amount: parseFloat(form.amount),
        conditions: form.conditions.filter(c => c.description),
      });
      setShowCreate(false);
      setForm({ consignmentId: '', payorOrgId: '', payeeOrgId: '', amount: '', currency: 'USD', autoRelease: true, conditions: [{ description: '', docType: '' }] });
      loadContracts();
      refresh();
    } catch (e) { alert(e.message); }
  };

  const markCondition = async (contract, condId) => {
    try {
      await api.verifyCondition(contract.id, condId, { met: true });
      loadContracts();
      refresh();
      // refresh selected
    } catch (e) { alert(e.message); }
  };

  const advanceContract = async (contract, nextStatus) => {
    try {
      await api.updateContractStatus(contract.id, { status: nextStatus });
      loadContracts();
      refresh();
    } catch (e) { alert(e.message); }
  };

  const addCondition = () => setForm(f => ({ ...f, conditions: [...f.conditions, { description: '', docType: '' }] }));
  const removeCondition = (i) => setForm(f => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }));
  const updateCondition = (i, field, val) => setForm(f => ({
    ...f, conditions: f.conditions.map((c, idx) => idx === i ? { ...c, [field]: val } : c)
  }));

  return (
    <div className={`tf-grid${selectedContract ? ' tf-grid--detail-lg' : ' tf-grid--single'}`}>
      {/* Left: list */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Smart Contracts</h3>
          <button className="btn-primary" onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New Contract
          </button>
        </div>

        {contracts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
            <div>No smart contracts yet</div>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
            <div className="desktop-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                    {['Contract Ref', 'UCR', 'Amount', 'Conditions', 'Auto-Release', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {contracts.map(c => {
                    const met = c.conditions.filter(x => x.met).length;
                    const total = c.conditions.length;
                    return (
                      <tr key={c.id} onClick={() => setSelected(c.id === selected ? null : c.id)}
                        style={{ borderBottom: '1px solid #f8fafc', cursor: 'pointer', background: c.id === selected ? '#f0f9ff' : 'white' }}>
                        <td style={{ padding: '12px 14px', fontWeight: 600, fontSize: 13 }}>{c.contractRef}</td>
                        <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>{c.ucr}</td>
                        <td style={{ padding: '12px 14px', fontWeight: 600, fontSize: 13 }}>{fmtVal(c.amount, c.currency)}</td>
                        <td style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden', minWidth: 60 }}>
                              <div style={{ height: '100%', background: met === total ? '#16a34a' : '#3b82f6', width: `${total ? (met / total) * 100 : 0}%` }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>{met}/{total}</span>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <span style={{ fontSize: 11, color: c.autoRelease ? '#16a34a' : '#94a3b8', fontWeight: 600 }}>
                            {c.autoRelease ? '⚡ On' : 'Off'}
                          </span>
                        </td>
                        <td style={{ padding: '12px 14px' }}><Pill label={c.status} styles={contractPillStyle[c.status] || {}} /></td>
                        <td style={{ padding: '12px 14px' }}><ChevronRight size={14} color="#94a3b8" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobile-cards" style={{ padding: 12 }}>
              {contracts.map(c => {
                const met = c.conditions.filter(x => x.met).length;
                const total = c.conditions.length;
                return (
                  <div key={c.id} className="mobile-card" onClick={() => setSelected(c.id === selected ? null : c.id)} style={{ cursor: 'pointer', background: c.id === selected ? '#f0f9ff' : undefined }}>
                    <div className="mobile-card-header">
                      <div>
                        <div className="mobile-card-title">{c.contractRef}</div>
                        <div className="mobile-card-sub">{c.ucr}</div>
                      </div>
                      <Pill label={c.status} styles={contractPillStyle[c.status] || {}} />
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Amount</span>
                      <span className="mobile-card-value" style={{ fontWeight: 700 }}>{fmtVal(c.amount, c.currency)}</span>
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Conditions</span>
                      <span className="mobile-card-value">{met}/{total} met</span>
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Auto-Release</span>
                      <span className="mobile-card-value" style={{ color: c.autoRelease ? '#16a34a' : '#94a3b8' }}>{c.autoRelease ? '⚡ On' : 'Off'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Right: detail panel */}
      {selectedContract && (() => {
        const c = selectedContract;
        const metCount = c.conditions.filter(x => x.met).length;
        const allMet = metCount === c.conditions.length && c.conditions.length > 0;
        const canRelease = allMet && c.status === 'Conditions Met';
        const nextStatusMap = { Draft: 'Active', Active: null, 'Conditions Met': 'Released', Released: 'Settled' };
        const nextManual = nextStatusMap[c.status];

        return (
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{c.contractRef}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{c.ucr}</div>
              </div>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={16} color="#94a3b8" /></button>
            </div>

            {/* Amount + status */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
              <div style={{ flex: 1, background: '#f8fafc', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Contract Amount</div>
                <div style={{ fontWeight: 700, fontSize: 18, color: '#1e293b' }}>{fmtVal(c.amount, c.currency)}</div>
              </div>
              <div>
                <Pill label={c.status} styles={contractPillStyle[c.status] || {}} />
                {c.autoRelease && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, justifyContent: 'flex-end' }}>
                    <Zap size={11} color="#16a34a" />
                    <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>Auto-Release</span>
                  </div>
                )}
              </div>
            </div>

            {/* Contract hash */}
            {c.contractHash && (
              <div style={{ background: '#f8fafc', borderRadius: 6, padding: '8px 12px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Hash size={12} color="#64748b" />
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#475569', wordBreak: 'break-all' }}>{c.contractHash}</span>
              </div>
            )}

            {/* Conditions */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>
                Conditions — {metCount}/{c.conditions.length} Met
              </div>
              <div style={{ height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ height: '100%', background: allMet ? '#16a34a' : '#3b82f6', width: `${c.conditions.length ? (metCount / c.conditions.length) * 100 : 0}%`, transition: 'width 0.3s' }} />
              </div>
              {c.conditions.map((cond) => (
                <div key={cond.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f8fafc' }}>
                  {cond.met
                    ? <CheckCircle size={16} color="#16a34a" />
                    : <Circle size={16} color="#e2e8f0" />
                  }
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: cond.met ? '#16a34a' : '#1e293b', fontWeight: cond.met ? 600 : 400 }}>{cond.description}</div>
                    {cond.docType && <div style={{ fontSize: 11, color: '#94a3b8' }}>{cond.docType}</div>}
                    {cond.metAt && <div style={{ fontSize: 10, color: '#94a3b8' }}>{new Date(cond.metAt).toLocaleString()}</div>}
                  </div>
                  {!cond.met && c.status !== 'Released' && c.status !== 'Settled' && c.status !== 'Cancelled' && c.creatorOrgId === user.id && (
                    <button
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #3b82f6', color: '#3b82f6', background: 'none', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => markCondition(c, cond.id)}
                    >Mark Met</button>
                  )}
                </div>
              ))}
            </div>

            {/* Timeline */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>Status Timeline</div>
              <ContractTimeline status={c.status} />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {c.status === 'Draft' && c.creatorOrgId === user.id && (
                <button className="btn-primary" onClick={() => advanceContract(c, 'Active')}>
                  Activate Contract
                </button>
              )}
              {canRelease && !c.autoRelease && c.creatorOrgId === user.id && (
                <button className="btn-primary" style={{ background: '#9333ea', borderColor: '#9333ea', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => advanceContract(c, 'Released')}>
                  <Zap size={14} /> Simulate Release
                </button>
              )}
              {c.status === 'Released' && c.creatorOrgId === user.id && (
                <button className="btn-primary" style={{ background: '#15803d', borderColor: '#15803d' }} onClick={() => advanceContract(c, 'Settled')}>
                  Mark Settled
                </button>
              )}
              {(c.status === 'Draft' || c.status === 'Active') && c.creatorOrgId === user.id && (
                <button className="btn-secondary" style={{ color: '#ef4444', borderColor: '#ef4444' }} onClick={() => advanceContract(c, 'Cancelled')}>
                  Cancel Contract
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Create Contract Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New Smart Contract" width={560}>
        <div className="tf-form-2col">
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Consignment *</label>
            <select className="input" value={form.consignmentId} onChange={e => setForm(f => ({ ...f, consignmentId: e.target.value }))}>
              <option value="">Select consignment…</option>
              {consignments.map(c => <option key={c.id} value={c.id}>{c.ucr} — {c.description}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Payor Org</label>
            <select className="input" value={form.payorOrgId} onChange={e => setForm(f => ({ ...f, payorOrgId: e.target.value }))}>
              <option value="">Select…</option>
              {allOrgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Payee Org</label>
            <select className="input" value={form.payeeOrgId} onChange={e => setForm(f => ({ ...f, payeeOrgId: e.target.value }))}>
              <option value="">Select…</option>
              {allOrgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Amount *</label>
            <input className="input" type="number" placeholder="0.00" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Currency</label>
            <select className="input" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              {(config?.finance?.currencies || ['USD', 'EUR']).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="autoRelease" checked={form.autoRelease} onChange={e => setForm(f => ({ ...f, autoRelease: e.target.checked }))} />
            <label htmlFor="autoRelease" style={{ fontSize: 13, color: '#1e293b', cursor: 'pointer' }}>
              <Zap size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4, color: '#f97316' }} />
              Auto-release when all conditions met
            </label>
          </div>
        </div>

        {/* Conditions */}
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Conditions *</label>
            <button type="button" style={{ fontSize: 12, color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }} onClick={addCondition}>
              + Add Condition
            </button>
          </div>
          {form.conditions.map((cond, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 2 }}>
                <input className="input" placeholder="Condition description *" value={cond.description}
                  onChange={e => updateCondition(i, 'description', e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <input className="input" placeholder="Doc type (optional)" value={cond.docType}
                  onChange={e => updateCondition(i, 'docType', e.target.value)} />
              </div>
              {form.conditions.length > 1 && (
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px' }} onClick={() => removeCondition(i)}>
                  <X size={14} color="#ef4444" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreate(false)}>Cancel</button>
          <button className="btn-primary" style={{ flex: 1 }} onClick={handleCreate}>Create Contract</button>
        </div>
      </Modal>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN TradeFinance COMPONENT
══════════════════════════════════════════════════════════ */
export default function TradeFinance() {
  const { user, refreshKey, refresh } = useNode();
  const config = useConfig();
  const [tab, setTab] = useState('lc');
  const { data: consignments } = useApiResource(
    () => api.getConsignments(user.id), [user, refreshKey], { initial: [], enabled: !!user },
  );
  const { data: allOrgs } = useApiResource(
    () => api.getAllOrgs(), [user, refreshKey], { initial: [], enabled: !!user },
  );

  if (!user) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1e293b' }}>Trade Finance</h2>
        <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 14 }}>Letters of credit and smart contract simulations</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '2px solid #f1f5f9' }}>
        {[
          { id: 'lc', label: '📄 Letters of Credit' },
          { id: 'contracts', label: '⚡ Smart Contracts' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: tab === t.id ? 700 : 400,
            color: tab === t.id ? '#3b82f6' : '#64748b',
            borderBottom: `2px solid ${tab === t.id ? '#3b82f6' : 'transparent'}`,
            marginBottom: -2,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'lc' && (
        <LCTab user={user} consignments={consignments} allOrgs={allOrgs} refresh={refresh} refreshKey={refreshKey} config={config} />
      )}
      {tab === 'contracts' && (
        <ContractsTab user={user} consignments={consignments} allOrgs={allOrgs} refresh={refresh} refreshKey={refreshKey} config={config} />
      )}
    </div>
  );
}
