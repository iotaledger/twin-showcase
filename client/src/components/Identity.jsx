import React, { useState, useEffect } from 'react';
import { useNode } from '../context/NodeContext';
import { useConfig } from '../context/ConfigContext';
import { api } from '../utils/api';
import { CheckCircle, XCircle, Loader, Shield, Edit3, Search, AlertTriangle, ExternalLink } from 'lucide-react';

export default function Identity() {
  const { user, peerOrgs, peerConnected, refresh, refreshKey } = useNode();
  const config = useConfig();
  const [orgs, setOrgs] = useState([]);
  const [verifying, setVerifying] = useState(null);
  const [regNum, setRegNum] = useState('');
  const [stage, setStage] = useState('input');
  const [steps, setSteps] = useState([]);
  const [failMsg, setFailMsg] = useState('');
  const [editing, setEditing] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [attestedBy, setAttestedBy] = useState('');
  const [credentialOrg, setCredentialOrg] = useState(null);

  useEffect(() => { api.getOrgs().then(setOrgs).catch(() => {}); }, [refreshKey]);

  const STEP_LABELS = [
    'Checking registration number format',
    'Querying national business registry',
    'Verifying licence status with issuing authority',
    'Generating Decentralised Identifier (DID)',
    'Issuing Verifiable Credential — anchoring on ledger',
  ];

  const runVerification = async () => {
    if (regNum.length < 4) return;
    setStage('running');
    setFailMsg('');
    setAttestedBy('');
    setSteps(STEP_LABELS.map((t, i) => ({ text: t, status: i === 0 ? 'checking' : 'pending', flash: '' })));

    let validation;
    try { validation = await api.validateCredential(regNum, verifying.id); } catch { validation = { valid: false, reason: 'Server error', failStep: 0 }; }

    const failAt = validation.valid ? -1 : (validation.failStep ?? 0);
    const authority = validation.attestedBy || '';

    for (let i = 0; i < STEP_LABELS.length; i++) {
      await new Promise(r => setTimeout(r, 700));
      if (i === failAt) {
        setSteps(prev => prev.map((s, j) => j === i ? { ...s, status: 'failed' } : s));
        setFailMsg(validation.reason);
        setStage('failed');
        return;
      }
      setSteps(prev => prev.map((s, j) => {
        if (j === i) {
          // Step 2 (index 2) = "Government authority confirms..." — flash attestor name
          const flash = (j === 2 && authority) ? `Confirmed by ${authority} ✓` : '';
          return { ...s, status: 'passed', flash };
        }
        if (j === i + 1) return { ...s, status: 'checking' };
        return s;
      }));
      if (i === 2 && authority) setAttestedBy(authority);
    }

    try {
      await api.registerOrg(verifying.id, regNum);
      setStage('passed');
      refresh();
    } catch (err) {
      setFailMsg(err.message);
      setStage('failed');
    }
  };

  const saveEdit = async (org) => {
    await api.updateOrg(org.id, { name: org.name, role: org.role });
    setEditing(null);
    refresh();
  };

  const filteredPeer = peerOrgs.filter(o => !searchQ || o.name.toLowerCase().includes(searchQ.toLowerCase()) || o.role.toLowerCase().includes(searchQ.toLowerCase()));

  // Each logged-in user only sees / manages their own organization card in
  // the "My organisation" section. Peer organisations from the other node
  // remain searchable below as usual.
  const myOrg = orgs.find(o => o.id === user?.id);
  const privateOrgs = myOrg && myOrg.orgType === 'private' ? [myOrg] : [];
  const publicOrgs  = myOrg && myOrg.orgType === 'public'  ? [myOrg] : [];

  const OrgCard = ({ org }) => (
    <div className={`did-card ${org.verified ? 'v' : ''}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        {editing === org.id ? (
          <div style={{ flex: 1 }}>
            <input value={org.name} onChange={e => setOrgs(orgs.map(o => o.id === org.id ? { ...o, name: e.target.value } : o))} onBlur={() => saveEdit(org)} style={{ fontSize: 14, fontWeight: 600, padding: '3px 8px', border: '1px solid var(--card-border)', borderRadius: 6, width: '100%', marginBottom: 4 }} />
            <input value={org.role} onChange={e => setOrgs(orgs.map(o => o.id === org.id ? { ...o, role: e.target.value } : o))} onBlur={() => saveEdit(org)} style={{ fontSize: 11.5, padding: '2px 8px', border: '1px solid var(--card-border)', borderRadius: 6, width: '100%' }} />
          </div>
        ) : (
          <div>
            <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{org.name}</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{org.role}</p>
          </div>
        )}
        <button onClick={() => setEditing(editing === org.id ? null : org.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
          <Edit3 style={{ width: 13, height: 13 }} />
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 10 }}>User: <span style={{ fontFamily: 'var(--mono)' }}>{org.username}</span></div>
      {org.verified ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <CheckCircle style={{ width: 15, height: 15, color: '#16a34a' }} />
            <span className="pill pill-g">Verified</span>
          </div>
          <div className="did-str" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>{org.did}</span>
            {org.explorerUrl && (
              <a href={org.explorerUrl} target="_blank" rel="noreferrer"
                 title="Open on IOTA Explorer (testnet)"
                 style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--primary)', textDecoration: 'none' }}>
                <ExternalLink style={{ width: 12, height: 12 }} />
              </a>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Reg: <span style={{ fontFamily: 'var(--mono)' }}>{org.regNumber}</span></div>
          {org.attestedBy && (
            <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 20, padding: '3px 10px' }}>
              <CheckCircle style={{ width: 11, height: 11, color: '#16a34a', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>Attested by {org.attestedBy}</span>
            </div>
          )}
        </>
      ) : (
        <button className="btn btn-p btn-sm" style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { setVerifying(org); setRegNum(''); setStage('input'); setSteps([]); setFailMsg(''); setAttestedBy(''); }}>
          <Shield style={{ width: 12, height: 12 }} /> Register DID
        </button>
      )}
    </div>
  );

  return (
    <div className="stack">
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Digital Identity</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>W3C DIDs anchored on ledger — verifiable credentials for each organisation</div>
      </div>

      {/* Contextual hint when the logged-in user hasn't registered a DID yet.
          Blue (info) tone, not amber — on this page the message is guidance,
          not a block. After registration it disappears. */}
      {myOrg && !myOrg.did && (
        <div className="identity-why">
          <Shield style={{ width: 18, height: 18, color: '#2563eb', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div className="identity-why__title">Why register?</div>
            <div className="identity-why__body">
              Your DID is the cryptographic key used to sign documents,
              consignments, and trade finance instructions. Without it,
              <strong> {myOrg.name}</strong> cannot upload documents or
              issue credentials. Use the Register DID button below to issue
              one — it takes about 30 seconds.
            </div>
          </div>
        </div>
      )}

      {/* Private organisations — DID registration */}
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />
          Private Organisations
        </div>
        <div className="g3">
          {privateOrgs.map(org => <OrgCard key={org.id} org={org} />)}
        </div>
      </div>

      {/* Public organisations — attestors, read-only */}
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#6366f1' }} />
          Public / Government Authorities
        </div>
        <div className="g3">
          {publicOrgs.map(org => (
            <div className="did-card" key={org.id} style={{ opacity: 0.85 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{org.name}</h4>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{org.role}</p>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 10 }}>User: <span style={{ fontFamily: 'var(--mono)' }}>{org.username}</span></div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 20, padding: '3px 10px' }}>
                <Shield style={{ width: 11, height: 11, color: '#6366f1', flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#4338ca', fontWeight: 600 }}>Attestation Authority</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Credential reference */}
      <div className="card">
        <div className="card-h">
          <h3>Credential Validation Rules</h3>
          <span className="pill pill-a">For demo</span>
        </div>
        <div className="g2">
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 8 }}>✓ Will PASS verification</div>
            <table>
              <tbody>
                {(config?.credentials?.testCredentials?.pass || []).map(({ code, description }) => (
                  <tr key={code}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, paddingRight: 12 }}>{code}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#991b1b', marginBottom: 8 }}>✗ Will FAIL verification</div>
            <table>
              <tbody>
                {(config?.credentials?.testCredentials?.fail || []).map(({ code, description }) => (
                  <tr key={code}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, paddingRight: 12 }}>{code}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Peer organisations */}
      <div className="card">
        <div className="card-h">
          <h3>Peer Node Organisations</h3>
          <span className={`pill ${peerConnected ? 'pill-b' : 'pill-gr'}`}>{peerConnected ? `${peerOrgs.length} discovered` : 'Not connected'}</span>
        </div>
        {!peerConnected ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Connect to a peer node from the Dashboard to discover their organisations.</div>
          </div>
        ) : (
          <>
            <div className="fg" style={{ marginBottom: 12 }}>
              <div style={{ position: 'relative' }}>
                <Search style={{ position: 'absolute', left: 10, top: 9, width: 14, height: 14, color: 'var(--text-muted)' }} />
                <input placeholder="Search peer organisations..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ paddingLeft: 32 }} />
              </div>
            </div>
            {filteredPeer.length === 0 ? <div className="empty">No matches.</div> : (
              <>
                <div className="desktop-table">
                  <table>
                    <thead><tr><th>Organisation</th><th>Role</th><th>Node</th><th>DID</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {filteredPeer.map(o => (
                        <tr key={o.id}>
                          <td style={{ fontWeight: 600 }}>{o.name}</td>
                          <td>{o.role}</td>
                          <td>{o.nodeName}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                            {o.did ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {o.did.slice(0, 22) + '...'}
                                {o.explorerUrl && (
                                  <a href={o.explorerUrl} target="_blank" rel="noreferrer"
                                     title="Open on IOTA Explorer (testnet)"
                                     style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--primary)' }}>
                                    <ExternalLink style={{ width: 10, height: 10 }} />
                                  </a>
                                )}
                              </span>
                            ) : '—'}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {o.verified ? <span className="pill pill-g">Verified</span> : <span className="pill pill-gr">Unverified</span>}
                              {o.verified && o.attestedBy && (
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 20, padding: '2px 8px', width: 'fit-content' }}>
                                  <CheckCircle style={{ width: 10, height: 10, color: '#16a34a', flexShrink: 0 }} />
                                  <span style={{ fontSize: 10, color: '#166534', fontWeight: 600, whiteSpace: 'nowrap' }}>Attested by {o.attestedBy}</span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td>
                            {o.verified && (
                              <button className="btn btn-s btn-sm" style={{ fontSize: 10.5, padding: '4px 10px' }} onClick={() => setCredentialOrg(o)}>
                                <ExternalLink style={{ width: 11, height: 11 }} /> View Credential
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mobile-cards" style={{ padding: 12 }}>
                  {filteredPeer.map(o => (
                    <div key={o.id} className="mobile-card">
                      <div className="mobile-card-header">
                        <div>
                          <div className="mobile-card-title">{o.name}</div>
                          <div className="mobile-card-sub">{o.role}</div>
                        </div>
                        {o.verified ? <span className="pill pill-g">Verified</span> : <span className="pill pill-gr">Unverified</span>}
                      </div>
                      <div className="mobile-card-row">
                        <span className="mobile-card-label">Node</span>
                        <span className="mobile-card-value">{o.nodeName}</span>
                      </div>
                      {o.did && (
                        <div className="mobile-card-row">
                          <span className="mobile-card-label">DID</span>
                          <span className="mobile-card-value" style={{ fontFamily: 'var(--mono)', fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {o.did.slice(0, 22)}...
                            {o.explorerUrl && (
                              <a href={o.explorerUrl} target="_blank" rel="noreferrer"
                                 title="Open on IOTA Explorer (testnet)"
                                 style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--primary)' }}>
                                <ExternalLink style={{ width: 10, height: 10 }} />
                              </a>
                            )}
                          </span>
                        </div>
                      )}
                      {o.verified && (
                        <div style={{ marginTop: 8 }}>
                          <button className="btn btn-s btn-sm" style={{ fontSize: 10.5, padding: '4px 10px', width: '100%', justifyContent: 'center' }} onClick={() => setCredentialOrg(o)}>
                            <ExternalLink style={{ width: 11, height: 11 }} /> View Credential
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Verification modal */}
      {verifying && (
        <div className="modal-bg" onClick={() => setVerifying(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Register {verifying.name}</h3>
            {stage === 'input' && (
              <form onSubmit={(e) => { e.preventDefault(); if (regNum.length >= 4) runVerification(); }}>
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>Enter a business registration number. Use {config?.credentials?.testCredentials?.pass?.[0]?.code || 'a valid code'} to pass or {config?.credentials?.testCredentials?.fail?.[0]?.code || 'an invalid code'} to see a denial.</p>
                <div className="fg"><label>Registration Number</label><input value={regNum} onChange={e => setRegNum(e.target.value)} placeholder={`e.g. ${config?.credentials?.testCredentials?.pass?.[0]?.code || 'REG-123456'}`} autoFocus /></div>
                <div className="modal-act">
                  <button type="button" className="btn btn-s" onClick={() => setVerifying(null)}>Cancel</button>
                  <button type="submit" className="btn btn-p" disabled={regNum.length < 4}>Verify & Register</button>
                </div>
              </form>
            )}
            {(stage === 'running' || stage === 'passed' || stage === 'failed') && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '10px 0' }}>
                  {steps.map((s, i) => (
                    <div key={i}>
                      <div className={`vs ${s.status}`} style={s.status === 'failed' ? { background: '#fef2f2', color: '#991b1b' } : {}}>
                        {s.status === 'checking' && <Loader style={{ width: 14, height: 14, animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
                        {s.status === 'passed' && <CheckCircle style={{ width: 14, height: 14, flexShrink: 0, color: '#16a34a' }} />}
                        {s.status === 'failed' && <XCircle style={{ width: 14, height: 14, flexShrink: 0, color: '#ef4444' }} />}
                        {s.status === 'pending' && <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--card-border)', flexShrink: 0 }} />}
                        <span>{s.text}</span>
                      </div>
                      {s.status === 'passed' && s.flash && (
                        <div style={{ marginLeft: 28, marginTop: 2, fontSize: 11, fontWeight: 700, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <CheckCircle style={{ width: 11, height: 11 }} /> {s.flash}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {stage === 'passed' && (
                  <div style={{ padding: 12, background: '#f0fdf4', borderRadius: 10, border: '1px solid #bbf7d0', fontSize: 12.5, color: '#166534', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CheckCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
                    <div>
                      <div>Identity verified. DID issued and anchored on ledger.</div>
                      {attestedBy && <div style={{ marginTop: 3, fontWeight: 700 }}>Attested by {attestedBy}</div>}
                    </div>
                  </div>
                )}
                {stage === 'failed' && (
                  <div style={{ padding: 12, background: '#fef2f2', borderRadius: 10, border: '1px solid #fecaca', fontSize: 12.5, color: '#991b1b', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <AlertTriangle style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
                    <div><div style={{ fontWeight: 700, marginBottom: 2 }}>Verification Failed</div>{failMsg}</div>
                  </div>
                )}
                <div className="modal-act">
                  {stage === 'failed' && <button className="btn btn-s" onClick={() => { setStage('input'); setSteps([]); setFailMsg(''); setAttestedBy(''); }}>Try Again</button>}
                  <button className="btn btn-p" onClick={() => setVerifying(null)}>{stage === 'passed' ? 'Done' : 'Close'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Credential modal — shown when viewing a peer org's credential */}
      {credentialOrg && (
        <div className="modal-bg" onClick={() => setCredentialOrg(null)}>
          <div className="modal modal-md" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Shield style={{ width: 18, height: 18, color: '#fff' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>Verifiable Credential</h3>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>Issued and anchored on the distributed ledger</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border)' }}>
              {[
                ['Organisation', credentialOrg.name],
                ['DID', credentialOrg.did],
                ['Issued by', credentialOrg.attestedBy || 'TWIN participant'],
                ['Reg. number', credentialOrg.regNumber || '—'],
                ['Node', credentialOrg.nodeName],
                ['Ledger hash', credentialOrg.did ? '0x' + credentialOrg.did.split('0x')[1]?.slice(0, 16) + '...' : '—'],
              ].map(([label, value], idx) => (
                <div key={label} style={{ display: 'flex', padding: '10px 14px', background: idx % 2 === 0 ? 'var(--bg-page)' : 'var(--bg-card)', borderBottom: idx < 5 ? '1px solid var(--card-border)' : 'none' }}>
                  <span style={{ width: 110, fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>{label}</span>
                  <span style={{ fontSize: 11.5, fontFamily: label === 'DID' || label === 'Ledger hash' ? 'var(--mono)' : 'inherit', wordBreak: 'break-all' }}>{value}</span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 16, padding: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, fontSize: 11.5, color: '#92400e', display: 'flex', gap: 8 }}>
              <Shield style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
              <span>This credential was verified by <strong>{credentialOrg.attestedBy || 'a TWIN participant'}</strong> and anchored on the distributed ledger. Any party can confirm this identity without contacting the issuing authority directly.</span>
            </div>

            <div className="modal-act" style={{ marginTop: 16 }}>
              <button className="btn btn-p" onClick={() => setCredentialOrg(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
