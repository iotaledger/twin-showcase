import http from 'http';
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, NODE_NAME, NODE_ID, store, hydrateLedgerFromAis, hydratePermissionsFromOdrl, hydratePeerOrgsFromCatalog } from './store.js';
import { seedConsignments, seedFinanceData } from './seed.js';
import { setupWebSocket } from './ws.js';
import { startAnchorBackfill } from './anchor-backfill.js';
import { createAndInitAdapter, resolveAdapterMode } from './adapter/index.js';
import { assertNodeCompat, parseNodeVersion } from './twin/compat/index.js';

// Route modules
import configRoutes from './routes/config.js';
import authRoutes from './routes/auth.js';
import nodeRoutes from './routes/node.js';
import orgRoutes from './routes/orgs.js';
import consignmentRoutes from './routes/consignments.js';
import documentRoutes from './routes/documents.js';
import customsRoutes from './routes/customs.js';
import publicVerifyRoutes from './routes/public-verify.js';
import publicShipmentRoutes from './routes/public-shipment.js';
import verifyApiRoutes from './routes/verify-api.js';
import twinProxyRoutes from './routes/twin-proxy.js';
import permissionRoutes from './routes/permissions.js';
import financeRoutes from './routes/finance.js';
import ledgerRoutes from './routes/ledger.js';
import notificationRoutes from './routes/notifications.js';
import { requireSession } from './middleware/session.js';
import { securityHeaders, corsPolicy, loginRateLimiter, rateLimitEnabled } from './middleware/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// T-407: behind Traefik the client IP is in X-Forwarded-For. Trust the proxy so
// (opt-in) rate limiting keys on the real client, and req.ip is accurate — this
// does NOT change routing or block traffic.
app.set('trust proxy', true);
// T-407: safe security headers (CSP/COEP/CORP off for infra compatibility) +
// origin-reflecting credentialed CORS. Header-level only — never blocks traffic.
app.use(securityHeaders());
app.use(corsPolicy());
app.use(express.json({ limit: '50mb' }));

// T-407: login brute-force limiter — OPT-IN (RATE_LIMIT_ENABLED=1), default OFF
// so Traefik-fronted traffic is never throttled by accident. Scoped to
// /api/login only; reads, pollers and public QR/verify surfaces are untouched.
if (rateLimitEnabled()) app.use('/api/login', loginRateLimiter());

const publicDir = path.join(__dirname, 'public');
if (existsSync(publicDir)) app.use(express.static(publicDir));

// T-410: require an authenticated session for state-mutating requests. Reads,
// the public QR/verify + shipment surfaces, the x-service-token verify API, the
// TWIN proxy, /api/login itself, static assets and the SPA fallback stay open
// (see server/middleware/session.js for the exemption list). Mounted before the
// routers so it covers every mutation. Static + GETs above are unaffected.
app.use(requireSession);

// Mount routes
app.use(configRoutes);
app.use(authRoutes);
app.use(nodeRoutes);
app.use(orgRoutes);
app.use(consignmentRoutes);
app.use(documentRoutes);
app.use(customsRoutes); // T-4V03: customs queue + pre-clearance + draft import declaration
app.use(publicVerifyRoutes); // T-4V03: public no-auth verification (QR landing), metadata only
app.use(publicShipmentRoutes); // T-4V04: public no-auth shipment view (shipment QR landing) + transport pass PDF
app.use(verifyApiRoutes); // T-4V03: system-to-system verification API (token auth + Swagger at /api/verify/docs)
app.use(twinProxyRoutes); // T-315: transparent proxy to the TWIN node verification API + Swagger (before the SPA wildcard)
app.use(permissionRoutes);
app.use(financeRoutes);
app.use(notificationRoutes);
app.use(ledgerRoutes); // must be last (contains SPA wildcard fallback)

// Initialise the TWIN adapter (T-209). Default mode is `docker`; override with
// ADAPTER_MODE=simulated|hosted. T-210: eagerly warm up the adapter so the
// JWT is cached before the first request. Failure here is logged but does
// NOT abort startup -- a TWIN node outage degrades but doesn't kill the demo.
const adapterMode = resolveAdapterMode();
store.adapter = await createAndInitAdapter(adapterMode, NODE_ID);
const targetUrl = store.adapter.nodeUrl ?? '(no remote target)';
console.log(`[${NODE_NAME}] Adapter mode: ${adapterMode}${adapterMode === 'simulated' ? '' : ` -> ${targetUrl}`}`);
try {
  const status = await store.adapter.warmUp();
  if (status.authenticated && status.expiresInSeconds != null) {
    console.log(`[${NODE_NAME}] Adapter authenticated (token expires in ${status.expiresInSeconds}s${status.subjectDid ? `, sub=${status.subjectDid}` : ''})`);
  }
} catch (e) {
  console.warn(`[${NODE_NAME}] Adapter warm-up failed (${adapterMode}): ${e.message}. Server will keep running; first user request will retry.`);
}

// TWIN node compatibility check (server/twin/compat). Reads the node's
// reported version from its root endpoint and warns loudly on drift from
// NODE_COMPAT_VERSION, so a node-image bump surfaces the shim inventory
// instead of silently keeping a dead workaround. Non-fatal; docker/hosted only.
if (adapterMode !== 'simulated' && store.adapter.nodeUrl) {
  try {
    const res = await fetch(`${store.adapter.nodeUrl}/`, { signal: AbortSignal.timeout(3000) });
    assertNodeCompat(parseNodeVersion(await res.text()), {
      logger: {
        warn: (m) => console.warn(`[${NODE_NAME}] ${m}`),
        log: (m) => console.log(`[${NODE_NAME}] ${m}`),
      },
    });
  } catch (e) {
    console.warn(`[${NODE_NAME}] [twin-compat] node version check skipped: ${e.message}`);
  }
}

// T-303: pull recent AIS entries into the in-memory ledger cache so
// the WS LEDGER_UPDATE broadcast carries prior-session events too. Seed
// runs after this so seedLog's dedupe-by-details can skip entries that
// already exist in AIS. Best-effort: failure is logged inside the helper.
await hydrateLedgerFromAis().catch(() => {});

// T-304: replay ODRL policies stored on the TWIN node back into the
// in-memory permission cache so cross-restart authorisation matches the
// signed source of truth. Best-effort.
await hydratePermissionsFromOdrl().catch(() => {});

// T-306: discover peer-node orgs through the federated catalogue
// instead of the legacy WS ORG_DIRECTORY handshake. Falls back to the
// WS path when the catalogue is empty / unreachable.
await hydratePeerOrgsFromCatalog().catch(() => {});

// Seed demo data
seedConsignments();
seedFinanceData();

// Start server — skipped on Vercel (serverless handles the lifecycle)
const IS_VERCEL = !!process.env.VERCEL;
const httpServer = http.createServer(app);

if (!IS_VERCEL) {
  setupWebSocket(httpServer);
  httpServer.listen(PORT, () => { console.log(`[${NODE_NAME}] Listening on port ${PORT} (HTTP + WS on same port)`); });
  // T-4V03: heal "Writing to ledger" docs whose proof anchored after the
  // seed's wait window — re-poll the node until the on-chain link lands.
  // After setupWebSocket so the refresh broadcast reaches connected clients.
  startAnchorBackfill();
}

// Export for Vercel's @vercel/node runner
export default app;
