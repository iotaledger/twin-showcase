import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_STATE_PATH = path.join(__dirname, '../data/seed-state.json');

// Read data/seed-state.json (written by scripts/seed-twin-nodes.js) and return
// the orgs/consignments/documents block for the given nodeId, or null when
// the file is missing or the corridor doesn't match the loaded config.
//
// Corridor mismatch: a leftover seed-state from a previous vietnam-us run
// would otherwise hydrate DIDs into a cambodia-eu boot, which would silently
// associate the wrong on-chain identity with each org.
export function loadSeedStateForNode(nodeId, corridorId) {
  if (!existsSync(SEED_STATE_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SEED_STATE_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`[seed-state] could not parse ${SEED_STATE_PATH}: ${e.message}`);
    return null;
  }
  if (corridorId && parsed.corridor && parsed.corridor !== corridorId) {
    console.warn(`[seed-state] corridor mismatch (state=${parsed.corridor}, config=${corridorId}) — ignoring seed-state.json. Re-run npm run twin:seed for the active corridor.`);
    return null;
  }
  return parsed?.[nodeId] ?? null;
}
