import express from 'express';
import { store } from '../../server/store.js';
import { createAndInitAdapter } from '../../server/adapter/index.js';
import configRoutes from '../../server/routes/config.js';
import authRoutes from '../../server/routes/auth.js';
import nodeRoutes from '../../server/routes/node.js';
import orgRoutes from '../../server/routes/orgs.js';
import consignmentRoutes from '../../server/routes/consignments.js';
import documentRoutes from '../../server/routes/documents.js';
import customsRoutes from '../../server/routes/customs.js';
import publicVerifyRoutes from '../../server/routes/public-verify.js';
import publicShipmentRoutes from '../../server/routes/public-shipment.js';
import verifyApiRoutes from '../../server/routes/verify-api.js';
import twinProxyRoutes from '../../server/routes/twin-proxy.js';
import permissionRoutes from '../../server/routes/permissions.js';
import financeRoutes from '../../server/routes/finance.js';
import ledgerRoutes from '../../server/routes/ledger.js';
import { seedConsignments, seedFinanceData } from '../../server/seed.js';

// Tests always run against the simulated adapter (no Docker / no network).
// Done at module load via top-level await; tests then use createApp() sync.
store.adapter = await createAndInitAdapter('simulated', 'alpha');

/**
 * Create a fresh Express app instance with all routes mounted.
 * Does NOT start an HTTP server — use with supertest.
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(configRoutes);
  app.use(authRoutes);
  app.use(nodeRoutes);
  app.use(orgRoutes);
  app.use(consignmentRoutes);
  app.use(documentRoutes);
  app.use(customsRoutes);
  app.use(publicVerifyRoutes);
  app.use(publicShipmentRoutes);
  app.use(verifyApiRoutes);
  app.use(twinProxyRoutes);
  app.use(permissionRoutes);
  app.use(financeRoutes);
  app.use(ledgerRoutes);
  return app;
}

/**
 * Reset the store to a clean state (preserving orgs from config).
 * Call in beforeEach to isolate tests.
 */
export function resetStore() {
  store.consignments = [];
  store.documents = [];
  store.permissions = {};
  store.docPermissions = {};
  store.payments = [];
  store.letterOfCredits = [];
  store.smartContracts = [];
  store.financePermissions = {};
  store.ledgerLog = [];
  store.peerOrgs = [];
  store.peerConnected = false;
}

/**
 * Seed demo consignments and finance data into the store.
 */
export function seedStore() {
  seedConsignments();
  seedFinanceData();
}

export { store };
