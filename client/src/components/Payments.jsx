import React, { useState, useEffect } from 'react';
import { useNode } from '../context/NodeContext';
import { useConfig } from '../context/ConfigContext';
import { api } from '../utils/api';
import { fmtValue as fmtVal } from '../utils/format';
import { CreditCard, Plus, X, ChevronRight, CheckCircle, Clock, AlertCircle, Share2, DollarSign, TrendingUp, AlertTriangle } from 'lucide-react';
import Modal from './shared/Modal';

const STATUS_STYLES = {
  'Unpaid':          { bg: '#fff4eb', color: '#c2410c', dot: '#FF7200' },
  'Partially Paid':  { bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
  'Paid':            { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  'Overdue':         { bg: '#fef2f2', color: '#991b1b', dot: '#ef4444' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES['Unpaid'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20, background: s.bg, color: s.color, fontSize: 11, fontWeight: 600 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
      {status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  const colors = { orange: '#FF7200', green: '#22c55e', red: '#ef4444', blue: '#3b82f6' };
  return (
    <div className="stat-card">
      <div className="stat-icon" style={{ background: `${colors[color]}18`, color: colors[color] }}><Icon style={{ width: 18, height: 18 }} /></div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

export default function Payments() {
  const { user, refreshKey, refresh } = useNode();
  const config = useConfig();
  const [consignments, setConsignments] = useState([]);
  const [allOrgs, setAllOrgs] = useState([]);
  const [payments, setPayments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [shareConsignment, setShareConsignment] = useState(null);
  const [loading, setLoading] = useState(true);

  // New payment form
  const [form, setForm] = useState({ consignmentId: '', invoiceRef: '', amount: '', currency: 'USD', dueDate: '', paymentMethod: 'Bank Transfer', notes: '' });
  // Confirm receipt
  const [confirmAmt, setConfirmAmt] = useState('');
  // Finance share
  const [shareOrgId, setShareOrgId] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getConsignments(user.id),
      api.getPayments(user.id),
      api.getAllOrgs(),
    ]).then(([cs, ps, orgs]) => {
      setConsignments(cs);
      setPayments(ps);
      setAllOrgs(orgs);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [user.id, refreshKey]);

  // Keep selected in sync after status changes
  useEffect(() => {
    if (selected) setSelected(payments.find(p => p.id === selected.id) || null);
  }, [payments]);

  const outstanding = payments.filter(p => p.status !== 'Paid').reduce((s, p) => s + (p.amount - p.paidAmount), 0);
  const received = payments.reduce((s, p) => s + p.paidAmount, 0);
  const overdue = payments.filter(p => p.status === 'Overdue').length;
  const hasData = payments.length > 0;

  const consignmentName = (cid) => consignments.find(c => c.id === cid)?.ucr || cid;
  const orgName = (oid) => allOrgs.find(o => o.id === oid)?.name || oid || '—';

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const c = consignments.find(c => c.id === form.consignmentId);
      await api.createPayment({
        ...form,
        amount: Number(form.amount),
        payorOrgId: c?.importer || '',
        payeeOrgId: user.id,
        creatorOrgId: user.id,
      });
      setShowNew(false);
      setForm({ consignmentId: '', invoiceRef: '', amount: '', currency: 'USD', dueDate: '', paymentMethod: 'Bank Transfer', notes: '' });
      const ps = await api.getPayments(user.id);
      setPayments(ps);
    } catch (err) { alert(err.message); }
  };

  const handleStatusUpdate = async (status, amt) => {
    if (!selected) return;
    try {
      await api.updatePaymentStatus(selected.id, { status, paidAmount: amt ?? selected.paidAmount, orgId: user.id, orgName: user.name });
      const ps = await api.getPayments(user.id);
      setPayments(ps);
      refresh();
    } catch (err) { alert(err.message); }
  };

  const handleShare = async (e) => {
    e.preventDefault();
    if (!shareOrgId || !shareConsignment) return;
    const targetOrg = allOrgs.find(o => o.id === shareOrgId);
    try {
      await api.shareFinanceAccess({ consignmentId: shareConsignment, targetOrgId: shareOrgId, role: 'viewer', sharerOrgName: user.name, targetOrgName: targetOrg?.name || shareOrgId });
      setShowShare(false); setShareOrgId('');
      refresh();
    } catch (err) { alert(err.message); }
  };

  // Orgs the user can share with (not self, not already having access)
  const sharable = allOrgs.filter(o => o.id !== user.id);

  if (loading) return <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>Loading payments...</div>;

  return (
    <div className="stack">
      {/* Stats */}
      <div className="g4">
        <StatCard icon={DollarSign} label="Outstanding" value={hasData ? fmtVal(outstanding, 'USD') : '—'} sub={hasData ? `${payments.filter(p => p.status !== 'Paid').length} invoices` : 'No active payments'} color="orange" />
        <StatCard icon={TrendingUp} label="Total Received" value={hasData ? fmtVal(received, 'USD') : '—'} sub={hasData ? `${payments.filter(p => p.status === 'Paid').length} settled` : 'Updates on access'} color="green" />
        <StatCard icon={AlertCircle} label="Overdue" value={hasData ? overdue : '—'} sub={hasData ? 'require action' : 'Updates on access'} color="red" />
        <StatCard icon={CreditCard} label="Total Payments" value={payments.length || '—'} sub={`across ${[...new Set(payments.map(p => p.consignmentId))].length} consignments`} color="blue" />
      </div>

      <div className={`pay-grid${selected ? ' pay-grid--detail' : ''}`}>
        {/* Payments table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--card-border)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Payment Records</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-s btn-sm" onClick={() => { setShowShare(true); setShareConsignment(consignments[0]?.id || ''); }}>
                <Share2 style={{ width: 13, height: 13 }} /> Share Finance Access
              </button>
              <button className="btn btn-p btn-sm" onClick={() => setShowNew(true)}>
                <Plus style={{ width: 13, height: 13 }} /> New Payment
              </button>
            </div>
          </div>

          {payments.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <CreditCard style={{ width: 32, height: 32, opacity: 0.3, margin: '0 auto 12px' }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No payment records yet</div>
              <div>Create a payment record to track invoice settlements.</div>
            </div>
          ) : (
            <>
              <div className="desktop-table">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['UCR', 'Invoice Ref', 'Amount', 'Due Date', 'Status', 'Method', ''].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--card-border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map(p => (
                      <tr key={p.id} onClick={() => setSelected(selected?.id === p.id ? null : p)} style={{ cursor: 'pointer', background: selected?.id === p.id ? '#fff4eb' : 'transparent', borderBottom: '1px solid var(--card-border)' }}>
                        <td style={{ padding: '11px 14px', fontWeight: 600, color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 11.5 }}>{p.ucr}</td>
                        <td style={{ padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11.5 }}>{p.invoiceRef}</td>
                        <td style={{ padding: '11px 14px', fontWeight: 600 }}>{fmtVal(p.amount, p.currency)}</td>
                        <td style={{ padding: '11px 14px', color: p.status === 'Overdue' ? '#ef4444' : 'var(--text-secondary)' }}>{p.dueDate}</td>
                        <td style={{ padding: '11px 14px' }}><StatusPill status={p.status} /></td>
                        <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{p.paymentMethod}</td>
                        <td style={{ padding: '11px 14px' }}><ChevronRight style={{ width: 14, height: 14, color: 'var(--text-muted)' }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mobile-cards" style={{ padding: 12 }}>
                {payments.map(p => (
                  <div key={p.id} className="mobile-card" onClick={() => setSelected(selected?.id === p.id ? null : p)} style={{ cursor: 'pointer', background: selected?.id === p.id ? '#fff4eb' : undefined }}>
                    <div className="mobile-card-header">
                      <div>
                        <div className="mobile-card-title">{p.invoiceRef}</div>
                        <div className="mobile-card-sub">{p.ucr}</div>
                      </div>
                      <StatusPill status={p.status} />
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Amount</span>
                      <span className="mobile-card-value" style={{ fontWeight: 700 }}>{fmtVal(p.amount, p.currency)}</span>
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Due Date</span>
                      <span className="mobile-card-value" style={{ color: p.status === 'Overdue' ? '#ef4444' : undefined }}>{p.dueDate || '—'}</span>
                    </div>
                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Method</span>
                      <span className="mobile-card-value">{p.paymentMethod}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Payment Detail</div>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}><X style={{ width: 16, height: 16 }} /></button>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <StatusPill status={selected.status} />

              {/* Key fields */}
              {[
                ['UCR', selected.ucr],
                ['Invoice', selected.invoiceRef],
                ['Total Amount', fmtVal(selected.amount, selected.currency)],
                ['Paid So Far', fmtVal(selected.paidAmount, selected.currency)],
                ['Balance', fmtVal(selected.amount - selected.paidAmount, selected.currency)],
                ['Due Date', selected.dueDate],
                ['Method', selected.paymentMethod],
                ['Notes', selected.notes || '—'],
              ].map(([l, v]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0 }}>{l}</span>
                  <span style={{ fontSize: l === 'UCR' || l === 'Invoice' ? 11 : 12, fontWeight: 500, color: 'var(--text-primary)', textAlign: 'right', fontFamily: l === 'UCR' || l === 'Invoice' ? 'var(--mono)' : 'inherit' }}>{v}</span>
                </div>
              ))}

              <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: 12, marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)', marginBottom: 10 }}>Update Status</div>

                {selected.status !== 'Paid' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="number" placeholder="Amount received" value={confirmAmt} onChange={e => setConfirmAmt(e.target.value)}
                        style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--card-border)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--font)' }} />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selected.currency}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-s btn-sm" onClick={() => { const amt = Number(confirmAmt) || selected.paidAmount; const newAmt = selected.paidAmount + amt; handleStatusUpdate(newAmt >= selected.amount ? 'Paid' : 'Partially Paid', newAmt); setConfirmAmt(''); }}>
                        <CheckCircle style={{ width: 12, height: 12 }} /> Confirm Receipt
                      </button>
                      <button className="btn btn-s btn-sm" style={{ borderColor: '#ef4444', color: '#ef4444' }} onClick={() => handleStatusUpdate('Overdue', selected.paidAmount)}>
                        <AlertTriangle style={{ width: 12, height: 12 }} /> Mark Overdue
                      </button>
                    </div>
                  </div>
                )}
                {selected.status === 'Paid' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#15803d', fontSize: 12, fontWeight: 500 }}>
                    <CheckCircle style={{ width: 14, height: 14 }} /> Payment fully settled
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* New Payment Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Payment Record" width={480}>
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="fg">
            <label>Consignment</label>
            <select value={form.consignmentId} onChange={e => setForm(f => ({ ...f, consignmentId: e.target.value }))} required>
              <option value="">Select consignment…</option>
              {consignments.map(c => <option key={c.id} value={c.id}>{c.ucr} — {c.product}</option>)}
            </select>
          </div>
          <div className="fg">
            <label>Invoice Reference</label>
            <input value={form.invoiceRef} onChange={e => setForm(f => ({ ...f, invoiceRef: e.target.value }))} placeholder="e.g. INV-APM-2026-0821" required />
          </div>
          <div className="pay-form-amount">
            <div className="fg">
              <label>Amount</label>
              <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" required />
            </div>
            <div className="fg">
              <label>Currency</label>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                {(config?.finance?.currencies || ['USD', 'EUR']).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="pay-form-2col">
            <div className="fg">
              <label>Due Date</label>
              <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} required />
            </div>
            <div className="fg">
              <label>Payment Method</label>
              <select value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}>
                {(config?.finance?.paymentMethods || ['Bank Transfer', 'Letter of Credit', 'Open Account', 'Cash Against Documents']).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="fg">
            <label>Notes</label>
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes…" />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn btn-s" onClick={() => setShowNew(false)}>Cancel</button>
            <button type="submit" className="btn btn-p">Create Payment</button>
          </div>
        </form>
      </Modal>

      {/* Finance Share Modal */}
      <Modal open={showShare} onClose={() => setShowShare(false)} title="Share Finance Access" width={400}>
        <form onSubmit={handleShare} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="fg">
            <label>Consignment</label>
            <select value={shareConsignment} onChange={e => setShareConsignment(e.target.value)} required>
              <option value="">Select…</option>
              {consignments.map(c => <option key={c.id} value={c.id}>{c.ucr}</option>)}
            </select>
          </div>
          <div className="fg">
            <label>Share With</label>
            <select value={shareOrgId} onChange={e => setShareOrgId(e.target.value)} required>
              <option value="">Select organisation…</option>
              {sharable.map(o => <option key={o.id} value={o.id}>{o.name} ({o.role})</option>)}
            </select>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            The selected organisation will gain viewer access to payment records, letters of credit, and smart contracts for this consignment.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-s" onClick={() => setShowShare(false)}>Cancel</button>
            <button type="submit" className="btn btn-p"><Share2 style={{ width: 13, height: 13 }} /> Grant Access</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
