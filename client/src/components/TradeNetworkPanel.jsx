import React, { useMemo, useState, useEffect } from 'react';
import { ComposableMap, Geographies, Geography, ZoomableGroup, useMapContext } from 'react-simple-maps';
import { AnimatePresence, motion } from 'framer-motion';
import { Wifi, WifiOff, Unlink, Radio, Plus, Minus, Maximize2, X, ShieldCheck, Building2, MapPin, Server } from 'lucide-react';
import { useConfig } from '../context/ConfigContext';
import { getCountryData, countryFromRoleWithConfig } from '../data/countries';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const COLOR_BY_SIDE = {
  local: '#11224E',
  peer:  '#FF7200',
  mixed: '#16a34a',
};
const ACTOR_LAYER_ZOOM = 2.2;  // dots appear
const ACTOR_LABEL_ZOOM = 3.5;  // labels appear

// ── Data ──────────────────────────────────────────────────────────────────

function aggregateOrgs(localOrgs, peerOrgs, config) {
  const { countryCoords } = getCountryData(config);
  const byCountry = new Map();
  const add = (org, side) => {
    const country = countryFromRoleWithConfig(org.role, config);
    if (!country || !countryCoords[country]) return;
    const existing = byCountry.get(country);
    if (existing) {
      existing.orgs.push({ ...org, side });
      if (existing.side !== side) existing.side = 'mixed';
    } else {
      byCountry.set(country, { country, orgs: [{ ...org, side }], side, coords: countryCoords[country] });
    }
  };
  localOrgs.forEach(o => add(o, 'local'));
  peerOrgs.forEach(o => add(o, 'peer'));
  for (const c of byCountry.values()) {
    c.orgs.sort((a, b) => (a.side === b.side ? 0 : a.side === 'local' ? -1 : 1));
  }
  return Array.from(byCountry.values());
}

function aggregateRoutes(consignments, config) {
  const { countryCoords } = getCountryData(config);
  const byPair = new Map();
  consignments.forEach(c => {
    if (!c.fromCountry || !c.toCountry) return;
    if (!countryCoords[c.fromCountry] || !countryCoords[c.toCountry]) return;
    const key = `${c.fromCountry}→${c.toCountry}`;
    const existing = byPair.get(key);
    if (existing) existing.count++;
    else byPair.set(key, { from: c.fromCountry, to: c.toCountry, count: 1 });
  });
  return Array.from(byPair.values());
}

function arcPath(p1, p2) {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dr = Math.sqrt(dx * dx + dy * dy) * 0.75;
  return `M ${x1} ${y1} A ${dr} ${dr} 0 0 1 ${x2} ${y2}`;
}

function dominantCountry(entries, side) {
  const candidates = entries.filter(e => e.orgs.some(o => o.side === side));
  if (!candidates.length) return null;
  return candidates
    .map(e => ({ country: e.country, n: e.orgs.filter(o => o.side === side).length, coords: e.coords }))
    .sort((a, b) => b.n - a.n)[0];
}

// Spread orgs as a small ring inside the country centroid.
// Radius kept small (0.55°) so they stay within typical country borders.
// Angles rotated 30° so 2-org cases aren't strictly N/S and 3-org cases
// don't sit on a horizontal line.
// TWIN stays at country centroid. Actors are placed at compass points around
// it: South, East, North, West (then diagonals for n > 4). Positive Y in
// offsets = north. East is pulled inward so its right-extending label stays
// inside the country border; N is squashed slightly to avoid TWIN's name label.
// Fractions of COUNTRY_SPREAD. Values close to ±1 push the actor near the
// border; 0 = at centroid. Vertical-only compass points keep margin for
// labels (E pulled in so label fits; N reduced so it doesn't crowd TWIN).
const COMPASS_POINTS = {
  S:  [ 0.00, -0.90],
  E:  [ 0.65,  0.00],
  N:  [ 0.00,  0.80],
  W:  [-0.90,  0.00],
  SE: [ 0.50, -0.65],
  NE: [ 0.50,  0.60],
  NW: [-0.70,  0.60],
  SW: [-0.70, -0.65],
};
const COMPASS_ORDER = ['S', 'E', 'N', 'W', 'SE', 'NE', 'NW', 'SW'];

// Per-org compass overrides (by org id). Falls back to COMPASS_ORDER index.
// Position hints are layout logic, not displayed content.
const ORG_COMPASS_OVERRIDE = {
  org1: 'S',
  org2: 'N',
  org3: 'NW',
};

function orgPositions(entry, countrySpread) {
  const [clng, clat] = entry.coords;
  const orgs = entry.orgs;
  const spread = (countrySpread && countrySpread[entry.country]) ?? 1.6;
  const cx = clng - spread * 0.05;
  const used = new Set();
  for (const o of orgs) {
    const ov = ORG_COMPASS_OVERRIDE[o.id];
    if (ov) used.add(ov);
  }
  const fallback = COMPASS_ORDER.filter(p => !used.has(p));
  let fi = 0;
  return orgs.map(org => {
    const point = ORG_COMPASS_OVERRIDE[org.id] ?? fallback[fi++ % fallback.length];
    const [ox, oy] = COMPASS_POINTS[point];
    return { org, coords: [cx + ox * spread, clat + oy * spread] };
  });
}

// Straight path
function straightPath(x1, y1, x2, y2) {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

// Quadratic-bezier arc — bow is perpendicular to the line and always points
// toward the upper half of the screen, so curves read as elegant arcs.
function curvedPath(x1, y1, x2, y2, curvature = 0.4) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  // perpendicular unit vector; choose the one with negative Y (bow up)
  let nx = -dy / dist;
  let ny =  dx / dist;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const bow = dist * curvature;
  const mx = (x1 + x2) / 2 + nx * bow;
  const my = (y1 + y2) / 2 + ny * bow;
  return `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
}

// Hub-and-spoke lines from each actor to its node's TWIN marker. Lines that
// cross country borders are curved as elegant arcs; same-country lines stay
// straight to keep the local cluster clean.
function ActorConnections({ entries, localAnchor, peerAnchor, zoom, yLift, countrySpread }) {
  const { projection } = useMapContext();
  if (!projection) return null;
  const localP = localAnchor ? projection(localAnchor.coords) : null;
  const peerP  = peerAnchor  ? projection(peerAnchor.coords)  : null;
  const paths = [];
  for (const entry of entries) {
    for (const pos of orgPositions(entry, countrySpread)) {
      const ap = projection(pos.coords);
      if (!ap) continue;
      const isLocal = pos.org.side === 'local';
      const hub = isLocal ? localP : peerP;
      const hubCountry = isLocal ? localAnchor?.country : peerAnchor?.country;
      if (!hub) continue;
      const crossCountry = hubCountry && hubCountry !== entry.country;
      const x1 = hub[0];
      const y1 = hub[1] - yLift * 0.4;
      const x2 = ap[0];
      const y2 = ap[1];
      paths.push({
        key: `${pos.org.side}-${pos.org.id}`,
        d: crossCountry ? curvedPath(x1, y1, x2, y2, 0.4) : straightPath(x1, y1, x2, y2),
        color: COLOR_BY_SIDE[pos.org.side],
      });
    }
  }
  return (
    <g style={{ pointerEvents: 'none' }} fill="none">
      {paths.map(p => (
        <path
          key={p.key}
          d={p.d}
          stroke={p.color}
          strokeWidth={0.9 / zoom}
          strokeOpacity={0.55}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

// ── Map layers ────────────────────────────────────────────────────────────

function TradeArcs({ routes, countryCoords }) {
  const { projection } = useMapContext();
  if (!projection) return null;
  return (
    <g style={{ pointerEvents: 'none' }}>
      {routes.map(r => {
        const p1 = projection(countryCoords[r.from]);
        const p2 = projection(countryCoords[r.to]);
        if (!p1 || !p2) return null;
        return (
          <path
            key={`${r.from}-${r.to}`}
            d={arcPath(p1, p2)}
            fill="none"
            stroke="#FF7200"
            strokeWidth={Math.min(0.7 + r.count * 0.1, 1.6)}
            strokeOpacity={0.3}
            strokeLinecap="round"
          />
        );
      })}
    </g>
  );
}

// Beam between two TWIN markers (lifted above their country centroids)
function NodeConnectionBeam({ from, to, active, zoom, yLift }) {
  const { projection } = useMapContext();
  if (!projection || !from || !to) return null;
  const p1 = projection(from.coords);
  const p2 = projection(to.coords);
  if (!p1 || !p2) return null;
  const d = curvedPath(p1[0], p1[1] - yLift, p2[0], p2[1] - yLift);
  if (!active) {
    return <path d={d} fill="none" stroke="#cbd5e1" strokeWidth={1 / zoom} strokeDasharray={`${3 / zoom} ${4 / zoom}`} strokeOpacity={0.5} />;
  }
  return (
    <g style={{ pointerEvents: 'none' }}>
      <motion.path d={d} fill="none" stroke="#16a34a" strokeWidth={3 / zoom}
        animate={{ opacity: [0.06, 0.16, 0.06] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        style={{ filter: `blur(${2 / zoom}px)` }}
      />
      <motion.path d={d} fill="none" stroke="#16a34a"
        strokeWidth={1.1 / zoom} strokeDasharray={`${5 / zoom} ${4 / zoom}`} strokeOpacity={0.6}
        animate={{ strokeDashoffset: [0, -60 / zoom] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
      />
    </g>
  );
}

// Country label — small text at centroid. Faded at high zoom so actor labels can shine.
function CountryLabel({ entry, zoom }) {
  const { projection } = useMapContext();
  if (!projection) return null;
  const pos = projection(entry.coords);
  if (!pos) return null;
  const opacity = zoom >= ACTOR_LAYER_ZOOM ? 0.25 : 0.85;
  return (
    <g transform={`translate(${pos[0]}, ${pos[1]})`} style={{ pointerEvents: 'none', opacity }}>
      <text
        y={2 / zoom}
        textAnchor="middle"
        fontSize={9 / zoom}
        fontWeight={800}
        fill={COLOR_BY_SIDE[entry.side]}
        style={{ letterSpacing: `${0.6 / zoom}px` }}
      >
        {entry.country.toUpperCase()}
      </text>
      <text
        y={11 / zoom}
        textAnchor="middle"
        fontSize={7 / zoom}
        fontWeight={600}
        fill="#64748b"
      >
        {entry.orgs.length} org{entry.orgs.length > 1 ? 's' : ''}
      </text>
    </g>
  );
}

// TWIN node marker — rounded square with "TWIN" text floating above the country label.
// Clickable: invokes onClick with the anchor country entry.
function TwinNodeMarker({ anchor, label, side, zoom, yLift, onClick, isSelected }) {
  const { projection } = useMapContext();
  const [hovered, setHovered] = useState(false);
  if (!projection || !anchor) return null;
  const p = projection(anchor.coords);
  if (!p) return null;
  const color = side === 'local' ? COLOR_BY_SIDE.local : COLOR_BY_SIDE.peer;
  const w = 58 / zoom;
  const h = 34 / zoom;
  const scale = hovered || isSelected ? 1.08 : 1;
  const x = p[0] - (w * scale) / 2;
  const y = p[1] - yLift - (h * scale) / 2;
  return (
    <g
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick ? () => onClick(anchor) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* tether down to country centroid */}
      <line
        x1={p[0]} y1={y + h * scale}
        x2={p[0]} y2={p[1] - 6 / zoom}
        stroke={color}
        strokeWidth={0.7 / zoom}
        opacity={0.5}
        style={{ pointerEvents: 'none' }}
      />
      <rect
        x={x} y={y}
        width={w * scale} height={h * scale}
        rx={5 / zoom}
        fill={color}
        stroke={isSelected ? '#FF7200' : '#ffffff'}
        strokeWidth={(isSelected ? 2 : 1.4) / zoom}
        style={{ filter: `drop-shadow(0 ${1.5 / zoom}px ${3 / zoom}px rgba(15,23,42,0.25))` }}
      />
      <text
        x={p[0]} y={y + (h * scale) / 2 + 6 / zoom}
        textAnchor="middle"
        fontSize={18 / zoom}
        fontWeight={800}
        fill="#ffffff"
        style={{ letterSpacing: `${1 / zoom}px`, pointerEvents: 'none' }}
      >
        TWIN
      </text>
      <text
        x={p[0]} y={y - 6 / zoom}
        textAnchor="middle"
        fontSize={11 / zoom}
        fontWeight={700}
        fill={color}
        style={{ letterSpacing: `${0.5 / zoom}px`, pointerEvents: 'none' }}
      >
        {label}
      </text>
    </g>
  );
}

// Individual actor marker — small dot + name pill, visible only at high zoom.
// Label sits in a white pill for readability on top of tinted country fills.
function ActorMarker({ position, org, zoom, isSelected, onSelect }) {
  const { projection } = useMapContext();
  const [hovered, setHovered] = useState(false);
  if (!projection) return null;
  const p = projection(position.coords);
  if (!p) return null;
  const color = COLOR_BY_SIDE[org.side];
  const baseR = 7 / zoom;
  const r = (hovered || isSelected) ? baseR * 1.3 : baseR;
  const labelFs = 16 / zoom;
  const labelPx = 7 / zoom;
  const labelPy = 4 / zoom;
  const labelW = (org.name.length * 8 + 14) / zoom;
  const labelH = 22 / zoom;
  const labelX = r + 6 / zoom;
  const labelY = -labelH / 2;
  return (
    <g
      transform={`translate(${p[0]}, ${p[1]})`}
      style={{ cursor: 'pointer' }}
      onClick={() => onSelect(org)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <circle r={r + 2 / zoom} fill={color} fillOpacity={hovered ? 0.28 : 0.14} />
      <circle r={r} fill={color} stroke={isSelected ? '#FF7200' : '#ffffff'} strokeWidth={(isSelected ? 1.6 : 1) / zoom} />
      {(zoom >= ACTOR_LABEL_ZOOM || hovered || isSelected) && (
        <>
          <rect
            x={labelX} y={labelY}
            width={labelW} height={labelH}
            rx={3 / zoom}
            fill="#ffffff"
            stroke={color}
            strokeWidth={0.5 / zoom}
            fillOpacity={0.94}
            style={{ pointerEvents: 'none', filter: `drop-shadow(0 ${0.8 / zoom}px ${1.5 / zoom}px rgba(15,23,42,0.18))` }}
          />
          <text
            x={labelX + labelPx} y={labelY + labelH - labelPy - 0.3 / zoom}
            fontSize={labelFs}
            fontWeight={700}
            fill="#0f172a"
            style={{ pointerEvents: 'none' }}
          >
            {org.name}
          </text>
        </>
      )}
    </g>
  );
}

function ActorLayer({ entries, zoom, onSelectOrg, selectedOrgKey, countrySpread }) {
  if (zoom < ACTOR_LAYER_ZOOM) return null;
  const all = entries.flatMap(entry =>
    orgPositions(entry, countrySpread).map(pos => ({ pos, country: entry.country }))
  );
  return (
    <g>
      {all.map(({ pos, country }) => {
        const key = `${pos.org.side}-${pos.org.id}`;
        return (
          <ActorMarker
            key={`${country}-${key}`}
            position={pos}
            org={pos.org}
            zoom={zoom}
            isSelected={selectedOrgKey === key}
            onSelect={onSelectOrg}
          />
        );
      })}
    </g>
  );
}

// ── Side panel ────────────────────────────────────────────────────────────

function CountryDetailPanel({ country, onClose, peerNodeName, nodeName, expandedOrgKey, onToggleExpand }) {
  if (!country) return null;
  const sideLabel = {
    local: nodeName || 'This node',
    peer:  peerNodeName || 'Peer node',
    mixed: 'Both nodes',
  };
  return (
    <motion.div
      className="tn-detail"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      <div className="tn-detail-header">
        <div>
          <div className="tn-detail-eyebrow"><MapPin style={{ width: 11, height: 11 }} /> Country</div>
          <div className="tn-detail-title">{country.country}</div>
          <div className="tn-detail-sub">
            <span className="tn-detail-pill" style={{ background: `${COLOR_BY_SIDE[country.side]}15`, color: COLOR_BY_SIDE[country.side] }}>
              {sideLabel[country.side]}
            </span>
            <span>{country.orgs.length} organization{country.orgs.length > 1 ? 's' : ''}</span>
          </div>
        </div>
        <button className="tn-detail-close" onClick={onClose}><X style={{ width: 14, height: 14 }} /></button>
      </div>
      <div className="tn-detail-list">
        {country.orgs.map((org, i) => {
          const key = `${org.side}-${org.id}`;
          const isOpen = expandedOrgKey === key;
          return (
            <button
              key={`${org.id}-${i}`}
              type="button"
              className={`tn-org-card ${isOpen ? 'tn-org-card--open' : ''}`}
              onClick={() => onToggleExpand(isOpen ? null : key)}
            >
              <div className="tn-org-icon" style={{ background: `${COLOR_BY_SIDE[org.side]}15`, color: COLOR_BY_SIDE[org.side] }}>
                <Building2 style={{ width: 14, height: 14 }} />
              </div>
              <div className="tn-org-body">
                <div className="tn-org-name-row">
                  <span className="tn-org-name">{org.name}</span>
                  {org.verified && (
                    <span className="tn-org-verified" title={org.did || 'DID issued'}>
                      <ShieldCheck style={{ width: 11, height: 11 }} /> DID
                    </span>
                  )}
                </div>
                <div className="tn-org-role">{org.role}</div>
                <div className="tn-org-meta">
                  <span>{org.side === 'local' ? (nodeName || 'This node') : (peerNodeName || 'Peer node')}</span>
                  {org.regNumber && <span>· {org.regNumber}</span>}
                </div>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      className="tn-org-expanded"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                    >
                      <div className="tn-org-detail-row">
                        <span className="tn-org-detail-k">Org ID</span>
                        <span className="tn-org-detail-v mono">{org.id}</span>
                      </div>
                      {org.orgType && (
                        <div className="tn-org-detail-row">
                          <span className="tn-org-detail-k">Type</span>
                          <span className="tn-org-detail-v">{org.orgType === 'public' ? 'Public sector' : 'Private sector'}</span>
                        </div>
                      )}
                      {org.username && (
                        <div className="tn-org-detail-row">
                          <span className="tn-org-detail-k">Login</span>
                          <span className="tn-org-detail-v mono">{org.username}</span>
                        </div>
                      )}
                      {org.regNumber && (
                        <div className="tn-org-detail-row">
                          <span className="tn-org-detail-k">Reg #</span>
                          <span className="tn-org-detail-v mono">{org.regNumber}</span>
                        </div>
                      )}
                      {org.did && (
                        <div className="tn-org-detail-row">
                          <span className="tn-org-detail-k">DID</span>
                          <span className="tn-org-detail-v mono tn-org-did">{org.did}</span>
                        </div>
                      )}
                      {!org.verified && (
                        <div className="tn-org-detail-note">
                          No decentralised identifier issued yet — this organization has not gone through identity registration.
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

// Node-detail side panel — opens when a TWIN marker is clicked.
// Lists every org on that node grouped by country.
function NodeDetailPanel({ side, nodeName, orgs, peerConnected, onClose, config }) {
  if (!orgs) return null;
  const color = COLOR_BY_SIDE[side] || COLOR_BY_SIDE.local;
  const byCountry = orgs.reduce((acc, o) => {
    const c = countryFromRoleWithConfig(o.role, config) || 'Unknown';
    if (!acc[c]) acc[c] = [];
    acc[c].push(o);
    return acc;
  }, {});
  const verifiedCount = orgs.filter(o => o.verified).length;
  return (
    <motion.div
      className="tn-detail"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      <div className="tn-detail-header">
        <div>
          <div className="tn-detail-eyebrow"><Server style={{ width: 11, height: 11 }} /> Node</div>
          <div className="tn-detail-title">{nodeName}</div>
          <div className="tn-detail-sub">
            <span className="tn-detail-pill" style={{ background: `${color}15`, color }}>
              {side === 'local' ? 'This node' : 'Peer node'}
            </span>
            <span>{orgs.length} org{orgs.length === 1 ? '' : 's'} · {verifiedCount} DID</span>
            {side === 'peer' && (
              <span className="tn-detail-pill" style={{ background: peerConnected ? '#dcfce7' : '#fee2e2', color: peerConnected ? '#15803d' : '#b91c1c' }}>
                {peerConnected ? 'Connected' : 'Offline'}
              </span>
            )}
          </div>
        </div>
        <button className="tn-detail-close" onClick={onClose}><X style={{ width: 14, height: 14 }} /></button>
      </div>
      <div className="tn-detail-list">
        {Object.entries(byCountry).map(([country, list]) => (
          <div key={country} className="tn-detail-group">
            <div className="tn-detail-group-title">
              <MapPin style={{ width: 11, height: 11 }} /> {country}
              <span className="tn-detail-group-count">{list.length}</span>
            </div>
            {list.map(org => (
              <div key={org.id} className="tn-org-card tn-org-card--static">
                <div className="tn-org-icon" style={{ background: `${color}15`, color }}>
                  <Building2 style={{ width: 14, height: 14 }} />
                </div>
                <div className="tn-org-body">
                  <div className="tn-org-name-row">
                    <span className="tn-org-name">{org.name}</span>
                    {org.verified && (
                      <span className="tn-org-verified" title={org.did || 'DID issued'}>
                        <ShieldCheck style={{ width: 11, height: 11 }} /> DID
                      </span>
                    )}
                  </div>
                  <div className="tn-org-role">{org.role}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export default function TradeNetworkPanel({
  localOrgs = [],
  peerOrgs = [],
  consignments = [],
  peerConnected = false,
  nodeInfo,
  peerNodeName,
  onConnect,
  onDisconnect,
  connecting = false,
  selection = { countryName: null, expandedOrgKey: null },
  onSelectionChange,
}) {
  const config = useConfig();
  const { isoToCountry, countryCoords, countrySpread } = useMemo(() => getCountryData(config), [config]);
  const countryEntries = useMemo(() => aggregateOrgs(localOrgs, peerOrgs, config), [localOrgs, peerOrgs, config]);
  const routes = useMemo(() => aggregateRoutes(consignments, config), [consignments, config]);
  const localAnchor = useMemo(() => dominantCountry(countryEntries, 'local'), [countryEntries]);
  const peerAnchor  = useMemo(() => dominantCountry(countryEntries, 'peer'),  [countryEntries]);

  const DEFAULT_CENTER = [80, 25];
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const zoomIn  = () => setZoom(z => Math.min(z * 1.5, 8));
  const zoomOut = () => setZoom(z => Math.max(z / 1.5, 1));
  const reset   = () => { setZoom(1); setCenter(DEFAULT_CENTER); };

  // Auto-zoom when selection changes from outside (e.g., bottom org list)
  useEffect(() => {
    if (!selection.countryName) return;
    const entry = countryEntries.find(e => e.country === selection.countryName);
    if (!entry) return;
    setCenter(entry.coords);
    setZoom(z => Math.max(z, 3.2));
  }, [selection.countryName, selection.expandedOrgKey, countryEntries]);

  const liveSelected = useMemo(
    () => (selection.countryName ? countryEntries.find(e => e.country === selection.countryName) || null : null),
    [selection.countryName, countryEntries]
  );

  const handleSelectCountry = (entry) => {
    onSelectionChange?.({ countryName: entry.country, expandedOrgKey: null, nodeSide: null });
  };
  const handleSelectOrg = (org) => {
    const entry = countryEntries.find(e => e.orgs.some(o => o.id === org.id && o.side === org.side));
    onSelectionChange?.({
      countryName: entry?.country || null,
      expandedOrgKey: `${org.side}-${org.id}`,
      nodeSide: null,
    });
  };
  const handleSelectNode = (anchor, side) => {
    onSelectionChange?.({ countryName: anchor.country, expandedOrgKey: null, nodeSide: side });
  };
  const handleToggleExpand = (key) => {
    onSelectionChange?.({ ...selection, expandedOrgKey: key });
  };
  const handleClose = () => onSelectionChange?.({ countryName: null, expandedOrgKey: null, nodeSide: null });

  // Lift used by TWIN markers (y above country centroid in SVG units)
  const yLift = 32 / zoom;

  return (
    <div className="card tn-panel">
      <div className="tn-header">
        <div className="tn-title">
          <span className="tn-title-text">Trade Network</span>
          <span className={`tn-status ${peerConnected ? 'tn-status-on' : 'tn-status-off'}`}>
            {peerConnected
              ? <><Wifi style={{ width: 12, height: 12 }} /> Peer connected</>
              : <><WifiOff style={{ width: 12, height: 12 }} /> Local only</>}
          </span>
        </div>
        <div className="tn-actions">
          <div className="tn-legend">
            <span><span className="tn-dot tn-dot-local" /> {nodeInfo?.nodeName || 'This node'}</span>
            <span><span className="tn-dot tn-dot-peer" /> {peerConnected ? (peerNodeName || 'Peer node') : 'Peer (offline)'}</span>
            <span><span className="tn-dot tn-dot-mixed" /> Both</span>
            <span><span className="tn-arc-swatch" /> Trade route</span>
          </div>
          {peerConnected
            ? <button className="btn btn-sm btn-d" onClick={onDisconnect}><Unlink style={{ width: 11, height: 11 }} /> Disconnect</button>
            : <button className="btn btn-sm btn-p" onClick={onConnect} disabled={connecting}>
                <Radio style={{ width: 11, height: 11 }} /> {connecting ? 'Connecting…' : 'Connect to peer'}
              </button>}
        </div>
      </div>

      <div className="tn-map-wrap">
        <ComposableMap
          projection="geoNaturalEarth1"
          projectionConfig={{ scale: 360 }}
          style={{ width: '100%', height: '100%' }}
        >
          <ZoomableGroup
            zoom={zoom}
            center={center}
            minZoom={1}
            maxZoom={8}
            onMoveEnd={({ zoom: z, coordinates }) => { setZoom(z); setCenter(coordinates); }}
          >
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map(geo => {
                  const countryName = isoToCountry[geo.id];
                  const entry = countryName ? countryEntries.find(e => e.country === countryName) : null;
                  const isSelected = entry && liveSelected?.country === entry.country;
                  const baseColor = entry ? COLOR_BY_SIDE[entry.side] : null;
                  const defaultFill = entry ? `${baseColor}28` : '#eef2f7';
                  const hoverFill  = entry ? `${baseColor}45` : '#eef2f7';
                  const selectedFill = entry ? `${baseColor}5e` : '#eef2f7';
                  const stroke = isSelected ? baseColor : (entry ? `${baseColor}80` : '#cbd5e1');
                  const strokeWidth = (isSelected ? 1.4 : (entry ? 0.8 : 0.5)) / zoom;
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      onClick={entry ? () => handleSelectCountry(entry) : undefined}
                      style={{
                        default: {
                          fill: isSelected ? selectedFill : defaultFill,
                          stroke, strokeWidth, outline: 'none',
                          cursor: entry ? 'pointer' : 'default',
                          transition: 'fill 0.15s',
                        },
                        hover:   { fill: hoverFill, outline: 'none' },
                        pressed: { outline: 'none' },
                      }}
                    />
                  );
                })
              }
            </Geographies>

            <NodeConnectionBeam from={localAnchor} to={peerAnchor} active={peerConnected} zoom={zoom} yLift={yLift} />
            {zoom >= ACTOR_LAYER_ZOOM && (
              <ActorConnections
                entries={countryEntries}
                localAnchor={localAnchor}
                peerAnchor={peerAnchor}
                zoom={zoom}
                yLift={yLift}
                countrySpread={countrySpread}
              />
            )}

            {countryEntries.map(entry => (
              <CountryLabel key={entry.country} entry={entry} zoom={zoom} />
            ))}

            <ActorLayer
              entries={countryEntries}
              zoom={zoom}
              onSelectOrg={handleSelectOrg}
              selectedOrgKey={selection.expandedOrgKey}
              countrySpread={countrySpread}
            />

            {localAnchor && (
              <TwinNodeMarker
                anchor={localAnchor}
                label={nodeInfo?.nodeName || 'This node'}
                side="local"
                zoom={zoom}
                yLift={yLift}
                onClick={(anchor) => handleSelectNode(anchor, 'local')}
                isSelected={selection.nodeSide === 'local'}
              />
            )}
            {peerConnected && peerAnchor && (
              <TwinNodeMarker
                anchor={peerAnchor}
                label={peerNodeName || 'Peer node'}
                side="peer"
                zoom={zoom}
                yLift={yLift}
                onClick={(anchor) => handleSelectNode(anchor, 'peer')}
                isSelected={selection.nodeSide === 'peer'}
              />
            )}
          </ZoomableGroup>
        </ComposableMap>

        <div className="tn-zoom">
          <button className="tn-zoom-btn" onClick={zoomIn} title="Zoom in"><Plus style={{ width: 14, height: 14 }} /></button>
          <button className="tn-zoom-btn" onClick={zoomOut} title="Zoom out"><Minus style={{ width: 14, height: 14 }} /></button>
          <button className="tn-zoom-btn" onClick={reset} title="Reset view"><Maximize2 style={{ width: 13, height: 13 }} /></button>
        </div>

        <AnimatePresence>
          {selection.nodeSide ? (
            <NodeDetailPanel
              key={`node-${selection.nodeSide}`}
              side={selection.nodeSide}
              nodeName={selection.nodeSide === 'local' ? (nodeInfo?.nodeName || 'This node') : (peerNodeName || 'Peer node')}
              orgs={selection.nodeSide === 'local' ? localOrgs : peerOrgs}
              peerConnected={peerConnected}
              onClose={handleClose}
              config={config}
            />
          ) : liveSelected && (
            <CountryDetailPanel
              key="country"
              country={liveSelected}
              onClose={handleClose}
              nodeName={nodeInfo?.nodeName}
              peerNodeName={peerNodeName}
              expandedOrgKey={selection.expandedOrgKey}
              onToggleExpand={handleToggleExpand}
            />
          )}
        </AnimatePresence>

        {countryEntries.length === 0 && (
          <div className="tn-empty">
            <span>No organizations on the network yet.</span>
          </div>
        )}
      </div>
    </div>
  );
}
