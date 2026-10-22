import React, { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { useNode } from '../context/NodeContext';
import { useConfig } from '../context/ConfigContext';
import { api } from '../utils/api';

// Initial guess from URL param, cookie, or port (synchronous, before /api/node responds)
function guessNode() {
  const nodeParam = new URLSearchParams(window.location.search).get('node');
  if (nodeParam === 'beta') return 'beta';
  if (nodeParam === 'alpha') return 'alpha';
  const cookieNode = document.cookie.match(/twin-node=(\w+)/)?.[1];
  if (cookieNode) return cookieNode;
  if (window.location.port === '4001') return 'beta';
  return null; // unknown — wait for /api/node
}

function CredRow({ cred, selected, onSelect }) {
  const { username, label, role } = cred;
  return (
    <div
      className={`cred-row${selected ? ' cred-row--selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(username)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(username); } }}
      aria-label={`Sign in as ${label}, ${role}`}
    >
      <div className="cred-row-icon">{label.charAt(0).toUpperCase()}</div>
      <div className="cred-row-body">
        <span className="cred-row-org">{label}</span>
        <div className="cred-row-meta">
          <span className="cred-row-role">{role}</span>
          <span className="cred-row-login">{username} / demo</span>
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { login } = useNode();
  const config = useConfig();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nodeId, setNodeId] = useState(guessNode);
  const [orgs, setOrgs] = useState([]);

  // Fetch the authoritative node identity from the server
  useEffect(() => {
    api.getNode().then(info => {
      if (info.nodeId) setNodeId(info.nodeId);
    }).catch(() => {});
  }, []);

  // Fetch orgs from the API (returned without passwords)
  useEffect(() => {
    api.getOrgs()
      .then(list => setOrgs(list.map(o => ({ username: o.username, label: o.name, role: o.role }))))
      .catch(() => {});
  }, [nodeId]);

  const isBeta = nodeId === 'beta';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message || 'Invalid credentials');
    }
    setLoading(false);
  };

  const handleQuick = (u) => {
    setUsername(u);
    setPassword('demo');
  };

  const [collapsed, setCollapsed] = useState({});

  // Group orgs by role category (text before the dash)
  const groupByCategory = (list) => {
    const groups = {};
    for (const c of list) {
      const cat = c.role.includes(' - ') ? c.role.split(' - ')[0].trim() : 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(c);
    }
    return groups;
  };

  const toggleGroup = (cat) => {
    setCollapsed(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const creds = orgs;

  const logoSrc = config?.branding?.logo || '/logo.png';
  const appName = config?.branding?.appName || 'TWIN';
  const tagline = config?.branding?.tagline || 'Trade & Logistics Platform';
  const alphaDesc = config?.branding?.alpha?.description || 'Alpha';
  const betaDesc = config?.branding?.beta?.description || 'Beta';

  return (
    <div className="login-pg">
      <div className="login-box">
        <div className="login-brand" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
          <img src={logoSrc} alt="Logo" className="login-logo-img" style={{ height: 36, width: 36, objectFit: 'contain' }} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, textAlign: 'left' }}>
            <span style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>{appName}</span>

          </div>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>{tagline} — Sign in to your organisation</p>

        <div className="node-badge">
          Node: <strong>{isBeta ? `Beta — ${betaDesc}` : `Alpha — ${alphaDesc}`}</strong>
        </div>

        {error && <div className="err">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="fg">
            <label>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter username" autoFocus />
          </div>
          <div className="fg">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" />
          </div>
          <button type="submit" className="btn btn-p" style={{ width: '100%', justifyContent: 'center', padding: '10px 16px' }} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="demo-creds">
          <div className="dc-header">
            <span className="dc-title">Quick Sign-In</span>
            <span className="dc-hint">Select to pre-fill</span>
          </div>
          {creds.length <= 8 ? (
            <div className="cred-list">
              {creds.map(c => (
                <CredRow key={c.username} cred={c} selected={username === c.username} onSelect={handleQuick} />
              ))}
            </div>
          ) : creds.length <= 12 ? (
            <div className="cred-scroll">
              <div className="cred-list">
                {creds.map(c => (
                  <CredRow key={c.username} cred={c} selected={username === c.username} onSelect={handleQuick} />
                ))}
              </div>
            </div>
          ) : (
            <div className="cred-scroll" style={{ maxHeight: 360 }}>
              {Object.entries(groupByCategory(creds)).map(([cat, items]) => (
                <div key={cat} className="cred-group">
                  <button className="cred-group-header" onClick={() => toggleGroup(cat)} aria-expanded={!collapsed[cat]}>
                    <ChevronRight size={12} className="cred-group-chevron" style={{ transform: collapsed[cat] ? 'rotate(0deg)' : 'rotate(90deg)' }} />
                    {cat}
                    <span className="cred-group-count">{items.length}</span>
                  </button>
                  {!collapsed[cat] && (
                    <div className="cred-group-items">
                      {items.map(c => (
                        <CredRow key={c.username} cred={c} selected={username === c.username} onSelect={handleQuick} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
