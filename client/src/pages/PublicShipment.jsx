import React, { useState, useEffect } from 'react';
import {
  ShieldCheck, ShieldX, ShieldAlert, Loader2, FileCheck2, Truck,
  Link as LinkIcon, WifiOff, CheckCircle2, Clock, AlertTriangle, Mail, Eye,
} from 'lucide-react';

// T-4V04 — public shipment landing page (shipment-QR target). Standalone:
// no NodeContext, no login, no session — the target user is a border officer
// or truck driver at a checkpoint who is NOT an account holder. Mirrors
// PublicVerify.jsx (T-4V03) one scope up: the whole consignment's curated
// border dossier instead of one document's integrity.

function decodeFragmentPayload() {
  try {
    const frag = window.location.hash.replace(/^#/, '');
    if (!frag) return null;
    // UTF-8-safe: the payload is base64url of UTF-8 bytes (route arrow "→",
    // diacritics). atob alone yields a Latin1 binary string → mojibake.
    const bin = atob(frag.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function Row({ label, children, mono }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
      <div style={{ width: 150, color: '#64748b', flexShrink: 0 }}>{label}</div>
      <div style={{ fontWeight: 600, color: '#0f172a', wordBreak: 'break-word', fontFamily: mono ? 'ui-monospace, monospace' : undefined, fontSize: mono ? 12 : 13 }}>
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

const CHANNEL_TONE = { green: '#15803d', yellow: '#b45309', red: '#b91c1c' };

function DocRow({ d, node }) {
  const n = d.notarization ?? {};
  const verified = n.verified;
  const anchored = n.proofId && !verified;
  const verifyHref = `/verify/${encodeURIComponent(d.id)}?node=${node ?? ''}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid #f1f5f9' }}>
      <FileCheck2 style={{ width: 15, height: 15, color: '#0369a1', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{d.title}</div>
        <div style={{ fontSize: 10.5, color: '#64748b' }}>
          {d.issuer}{d.uneceCode ? ` · UNECE ${d.uneceCode}` : ''}
        </div>
      </div>
      {verified && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: '#15803d' }}><CheckCircle2 style={{ width: 13, height: 13 }} /> Verified</span>}
      {anchored && <span style={{ fontSize: 11, fontWeight: 600, color: '#b45309' }}>Anchored</span>}
      {!n.proofId && <span style={{ fontSize: 11, color: '#94a3b8' }}>No proof</span>}
      {/* Per-document access policy: 'content' docs get a View action; the rest
          stay verification-only with an explicit label so the boundary is clear. */}
      {d.contentAvailable
        ? <a href={d.contentUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: '#0369a1', textDecoration: 'none' }}><Eye style={{ width: 12, height: 12 }} /> View</a>
        : <span title="This document type is verification-only — its content is not disclosed on the public view." style={{ fontSize: 10.5, color: '#94a3b8' }}>verification only</span>}
      <a href={verifyHref} style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textDecoration: 'none' }}>Verify →</a>
    </div>
  );
}

export default function PublicShipment() {
  const id = decodeURIComponent(window.location.pathname.replace(/^\/shipment\//, '').replace(/\/+$/, ''));
  const payload = decodeFragmentPayload();
  const [state, setState] = useState('loading'); // loading | found | unknown | offline
  const [data, setData] = useState(null);

  useEffect(() => {
    const node = payload?.node ?? new URLSearchParams(window.location.search).get('node');
    const nodeQ = node ? `?node=${encodeURIComponent(node)}` : '';
    fetch(`/api/public/shipment/${encodeURIComponent(id)}${nodeQ}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (r.ok && body?.status === 'found') { setData(body); setState('found'); }
        else setState('unknown');
      })
      .catch(() => setState('offline'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const s = data?.shipment;
  const node = data?.node ?? payload?.node;
  const dossier = data?.dossier;
  const oc = data?.originComposition;
  const cust = s?.customs;
  const channel = data?.channel?.current ?? cust?.channel;
  const verified = dossier?.dossierVerified;

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', padding: '32px 16px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '2px', color: '#64748b' }}>TWIN TRADE CORRIDOR</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Truck style={{ width: 22, height: 22 }} /> Shipment Dossier
          </div>
          <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
            Public checkpoint view — no account required. One shipment only; no payment data.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {state === 'loading' && <Banner tone="slate" icon={Loader2} title="Loading…">Fetching the shipment dossier from the corridor node.</Banner>}

          {state === 'unknown' && (
            <Banner tone="red" icon={ShieldX} title="Shipment not found">
              This node has no shipment for id <code style={{ fontFamily: 'ui-monospace, monospace' }}>{id}</code>.
              The pass may be forged or registered on a different corridor node{payload?.node ? ` (the QR claims node "${payload.node}").` : '.'}
            </Banner>
          )}

          {state === 'offline' && (
            <Banner tone="amber" icon={WifiOff} title="Verification service unreachable">
              The corridor node could not be reached. The QR's offline summary is shown below
              {payload ? '' : ' (none present in this link)'}; scan again when back online for the full verified dossier.
            </Banner>
          )}

          {state === 'found' && (
            verified
              ? <Banner tone="green" icon={ShieldCheck} title="Verified shipment dossier">Every notarization-required document in this shipment is provenance-backed on the IOTA ledger — not taken on trust. Drill into any document below to re-verify it live.</Banner>
              : <Banner tone="amber" icon={ShieldAlert} title="Dossier not fully verified">Some supporting documents are not yet provenance-backed ({dossier?.anchoredCount}/{dossier?.requiredCount} anchored). Today's alternative is a folder of emailed PDFs with no provenance at all.</Banner>
          )}

          {/* Offline summary from the fragment when the node is unreachable */}
          {state !== 'found' && payload && (
            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 4px' }}>QR summary (offline)</div>
              <Row label="UCR" mono>{payload.ucr}</Row>
              <Row label="Exporter">{payload.exporter}</Row>
              <Row label="Importer">{payload.importer}</Row>
              <Row label="Route">{payload.route}</Row>
            </div>
          )}

          {state === 'found' && s && (
            <>
              {s.errorType && (
                <Banner tone="red" icon={AlertTriangle} title={s.errorType}>{cust?.channelReason ?? 'This shipment is flagged for reconciliation.'}</Banner>
              )}

              {/* Shipment facts */}
              <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 4px' }}>Shipment</div>
                <Row label="UCR" mono>{s.ucr}</Row>
                <Row label="Exporter / consignor">{s.exporter}</Row>
                <Row label="Importer / consignee">{s.importer}</Row>
                <Row label="Route">{s.fromCountry && s.toCountry ? `${s.fromCountry} → ${s.toCountry}` : '—'}</Row>
                <Row label="Goods">{s.product}{s.hsCode ? ` · HS ${s.hsCode}` : ''}</Row>
                <Row label="Quantity">{s.quantity}</Row>
                <Row label="Customs value">{s.customsValue ? `${s.customsValue.currency} ${Number(s.customsValue.value).toLocaleString('en-US')}` : '—'}</Row>
                <Row label="Vessel">{s.vessel}</Row>
                <Row label="Status">{s.status}</Row>
                {channel && (
                  <Row label="Customs channel">
                    <span style={{ color: CHANNEL_TONE[channel] ?? '#475569', fontWeight: 800 }}>{channel.toUpperCase()}</span>
                    {cust?.releasedAt ? <span style={{ color: '#15803d', marginLeft: 8, fontWeight: 600 }}><CheckCircle2 style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> released</span>
                      : <span style={{ color: '#b45309', marginLeft: 8, fontWeight: 600 }}><Clock style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> held</span>}
                  </Row>
                )}
              </div>

              {/* Customs / declaration */}
              {cust?.declarationNo && (
                <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 4px' }}>Export declaration</div>
                  <Row label="Declaration no." mono>{cust.declarationNo} {cust.declarationType ? `(${cust.declarationType})` : ''}</Row>
                  <Row label="Customs office">{cust.customsOffice}</Row>
                  {cust.eCo?.ref && <Row label="Certificate of origin" mono>{cust.eCo.ref} · {cust.eCo.formType}</Row>}
                  {cust.logistics?.containerNo && <Row label="Container / seal" mono>{cust.logistics.containerNo} / {cust.logistics.sealNo}</Row>}
                  {cust.destination?.htsCode && <Row label="Destination HTS" mono>{cust.destination.htsCode}</Row>}
                  {cust.destination?.mrn && <Row label="MRN" mono>{cust.destination.mrn}</Row>}
                </div>
              )}

              {/* Origin composition / evidence chain */}
              {oc && (
                <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 8px' }}>Origin composition</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: oc.evidenceIncomplete ? '#b91c1c' : '#15803d' }}>{oc.localContentPercent}%</span>
                    <span style={{ fontSize: 11.5, color: '#64748b' }}>local content ({oc.calculationMethod}, threshold {oc.threshold}%)</span>
                  </div>
                  {oc.evidenceIncomplete && (
                    <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' }}>
                      Supplier evidence incomplete — declared origin cannot be reconstructed from recorded inputs.
                    </div>
                  )}
                </div>
              )}

              {/* Documents */}
              <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 2px' }}>
                  Supporting documents ({data.documents?.length ?? 0})
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
                  Documents the consignment owner made inspectable show <b>View</b>; the rest are
                  <b> verification only</b> (content not disclosed). Every document is independently verifiable.
                  <br />Which document types expose their content publicly is <b>configurable per corridor</b> — the
                  owner/operator sets each type to public content or verification-only (e.g. commercial invoices and
                  bills of material are verification-only by default).
                </div>
                {(data.documents ?? []).map(d => <DocRow key={d.id} d={d} node={node} />)}
              </div>
            </>
          )}

          <div style={{ textAlign: 'center', fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
            <Mail style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> The alternative at the checkpoint today is a folder of emailed PDFs with no provenance.
          </div>
        </div>
      </div>
    </div>
  );
}
