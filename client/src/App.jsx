import React, { useState } from 'react';
import { useNode } from './context/NodeContext';
import { useConfig } from './context/ConfigContext';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Network from './components/Network';
import Identity from './components/Identity';
import Consignments from './components/Consignments';
import Payments from './components/Payments';
import TradeFinance from './components/TradeFinance';
import Permissions from './components/Permissions';
import LedgerExplorer from './components/LedgerExplorer';
import NotificationBell from './components/NotificationBell';
import CustomsDesk from './components/CustomsDesk';
import { LayoutDashboard, FileStack, Fingerprint, Shield, Activity, LogOut, Wifi, WifiOff, CreditCard, Landmark, Globe, Menu, Search, X, ScanLine } from 'lucide-react';

const PAGES = [
  { id: 'dashboard',     label: 'Dashboard',      icon: LayoutDashboard },
  { id: 'network',       label: 'Network',         icon: Globe },
  { id: 'consignments',  label: 'Consignments',    icon: FileStack },
  { id: 'payments',      label: 'Payments',        icon: CreditCard },
  { id: 'trade-finance', label: 'Trade Finance',   icon: Landmark },
  { id: 'identity',      label: 'Identity',        icon: Fingerprint },
  { id: 'permissions',   label: 'Access Control',  icon: Shield },
  { id: 'ledger',        label: 'Analytics',       icon: Activity },
];

// T-4V03: the Customs Desk entry appears only for orgs flagged with a
// customsDeskRole in the corridor config (export/import customs authority,
// importer/broker) — config-driven, no hardcoded org names.
const CUSTOMS_PAGE_LABELS = {
  exportCustoms: 'Customs Desk',
  importCustoms: 'Customs Review',     // the destination authority reviews inbound dossiers
  importer: 'Import Pre-clearance',    // the importer/broker prepares the declaration
};

export default function App() {
  const { user, nodeInfo, peerConnected, logout } = useNode();
  const config = useConfig();
  const [page, setPage] = useState('dashboard');
  const [searchQ, setSearchQ] = useState('');
  const [targetConsignment, setTargetConsignment] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  if (!user) return <Login />;

  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const handleViewDocs = (consignment) => {
    setTargetConsignment(consignment);
    setPage('consignments');
  };

  const navigateTo = (id) => {
    setPage(id);
    setSidebarOpen(false);
  };

  // T-4V03: insert the customs view (role-gated) right after Consignments.
  const customsLabel = CUSTOMS_PAGE_LABELS[user.customsDeskRole];
  const pages = customsLabel
    ? [...PAGES.slice(0, 3), { id: 'customs', label: customsLabel, icon: ScanLine }, ...PAGES.slice(3)]
    : PAGES;

  const BOTTOM_TABS = pages.filter(p =>
    ['dashboard', 'consignments', 'customs', 'trade-finance', 'network'].includes(p.id)
  ).slice(0, 5);

  return (
    <div className="layout">
      {/* Sidebar overlay (mobile/tablet) */}
      <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sb-brand">
          <img src={config?.branding?.logo || '/logo.png'} alt="Logo" style={{ height: 22, width: 22, objectFit: 'contain', flexShrink: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{config?.branding?.appName || 'TWIN'}</span>

          </div>
        </div>

        <nav className="sb-nav">
          {pages.map(p => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => navigateTo(p.id)}>
              <p.icon /> {p.label}
            </button>
          ))}
        </nav>

        <div className="sb-ft">
          <div className="entity-status">
            <div className="es-label">Entity Status</div>
            <div className="es-value">
              <div className={`dot ${peerConnected ? 'dot-on' : 'dot-off'}`} />
              <span>{user.name}</span>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 13 }}>
              {peerConnected ? 'Peer synced' : 'Local only'} — {nodeInfo?.nodeName || 'Node'}
            </div>
          </div>
          <div className="sb-links">
            <button>
              {peerConnected
                ? <><Wifi style={{ width: 13, height: 13, color: '#22c55e' }} /> <span>Node Online</span></>
                : <><WifiOff style={{ width: 13, height: 13 }} /> <span>No Peer</span></>}
            </button>
            <button onClick={logout}>
              <LogOut style={{ width: 13, height: 13 }} /> Sign Out
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="hdr">
          <div className="hdr-left">
            <button className="hamburger" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} />
            </button>
            <div className="hdr-org">{user.name}</div>
            <div className="hdr-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                placeholder="Search consignments, documents, entities..."
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
              />
            </div>
          </div>
          <div className="hdr-right">
            <button className="search-btn-mobile" onClick={() => setSearchOpen(true)}>
              <Search size={18} />
            </button>
            <NotificationBell onView={handleViewDocs} />
            <div className="hdr-user">
              <div className="hdr-user-info" style={{ textAlign: 'right' }}>
                <div className="name">{user.name}</div>
                <div className="sub">{user.role} — {nodeInfo?.nodeName}</div>
              </div>
              <div className="avatar">{initials}</div>
            </div>
          </div>
        </header>

        <div className="cnt">
          {page === 'dashboard'     && <Dashboard searchQ={searchQ} onViewDocs={handleViewDocs} onNavigate={setPage} />}
          {page === 'customs'       && <CustomsDesk />}
          {page === 'network'       && <Network />}
          {page === 'consignments'  && <Consignments searchQ={searchQ} targetConsignment={targetConsignment} onClearTarget={() => setTargetConsignment(null)} onNavigate={setPage} />}
          {page === 'payments'      && <Payments />}
          {page === 'trade-finance' && <TradeFinance />}
          {page === 'identity'      && <Identity />}
          {page === 'permissions'   && <Permissions />}
          {page === 'ledger'        && <LedgerExplorer />}
        </div>
      </main>

      {/* Mobile search overlay */}
      {searchOpen && (
        <div className="search-overlay open">
          <div className="search-overlay-bar">
            <input
              autoFocus
              placeholder="Search consignments, documents, entities..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
            <button className="search-overlay-close" onClick={() => setSearchOpen(false)}>
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Bottom tab bar (mobile) */}
      <nav className="bottom-tabs">
        {BOTTOM_TABS.map(t => (
          <button key={t.id} className={`bottom-tab${page === t.id ? ' active' : ''}`} onClick={() => navigateTo(t.id)}>
            <t.icon />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
