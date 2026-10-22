import { FileText } from 'lucide-react';

export function StatusPill({ status }) {
  const map = {
    'In Transit':   'pill pill-dot pill-active',
    'Customs':      'pill pill-dot pill-active',
    'Submitted':    'pill pill-dot pill-active',
    'Released':     'pill pill-dot pill-active',
    'Delivered':    'pill pill-dot pill-delivered',
    'Draft':        'pill pill-dot pill-draft',
    'Under Review': 'pill pill-dot pill-review',
  };
  return <span className={map[status] || 'pill pill-dot pill-draft'}>{status || 'Draft'}</span>;
}

export function DocsPill({ count, total }) {
  const cls = count === total ? 'docs-pill docs-complete' : count < total / 2 ? 'docs-pill docs-low' : 'docs-pill docs-partial';
  return <span className={cls}>{count}/{total}</span>;
}

export const DOC_COLORS = {
  'Bill of Lading':        { bg: '#fff4eb', color: '#FF7200' },
  'Insurance Certificate': { bg: '#fff4eb', color: '#FF7200' },
  'Certificate of Origin': { bg: '#f0fdf4', color: '#16a34a' },
  'Commercial Invoice':    { bg: '#e8ecf4', color: '#11224E' },
  'Packing List':          { bg: '#e8ecf4', color: '#11224E' },
  'Export Declaration':    { bg: '#e8ecf4', color: '#11224E' },
};

export function DocTypeIcon({ docType }) {
  const c = DOC_COLORS[docType] || { bg: '#f1f5f9', color: '#64748b' };
  return (
    <div style={{ width: 30, height: 30, borderRadius: 7, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <FileText style={{ width: 14, height: 14, color: c.color }} />
    </div>
  );
}
