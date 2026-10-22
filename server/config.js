import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _config = null;

/**
 * Load corridor configuration from JSON file.
 * Priority: CONFIG_FILE env var > default configs/vietnam-us-customs.json
 * (T-4V03: the customs-perspective corridor is the demo default).
 * Returns the parsed config object, or null if no file found.
 */
export function loadConfig() {
  const configPath = process.env.CONFIG_FILE
    ? path.resolve(process.env.CONFIG_FILE)
    : path.join(__dirname, '../configs/vietnam-us-customs.json');

  if (existsSync(configPath)) {
    try {
      _config = JSON.parse(readFileSync(configPath, 'utf-8'));
      console.log(`[Config] Loaded corridor: ${_config.corridor?.id} (${_config.corridor?.name})`);
    } catch (e) {
      console.error(`[Config] Failed to parse ${configPath}:`, e.message);
      _config = null;
    }
  } else {
    console.log(`[Config] No config file at ${configPath}, using built-in defaults`);
    _config = null;
  }

  return _config;
}

/**
 * Get the currently loaded config (or null if none loaded).
 */
export function getConfig() {
  return _config;
}

// Neutral, corridor-agnostic URN/policy namespace. Used as the first label of
// ODRL policy ids (`policy:<ns>:…`) and entity URNs (`urn:<ns>:org|consignment|
// document:…`) so the demo scales to ANY corridor without Vietnam-specific
// branding baked in. Default is the neutral `corridor`; override per corridor
// with `corridor.urnNamespace` in the config JSON if a corridor wants its own
// (e.g. "vietnam-us"). Note: the ODRL policy id's FIRST segment must stay
// `policy` (the TWIN PolicyAdministrationPoint enforces it) — this namespace is
// the SECOND segment.
export const DEFAULT_URN_NAMESPACE = 'corridor';
export function getUrnNamespace() {
  return getConfig()?.corridor?.urnNamespace || DEFAULT_URN_NAMESPACE;
}
