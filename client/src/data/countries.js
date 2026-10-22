// Country data is now config-driven. These empty defaults exist for backward
// compatibility but should not be relied upon. Use the config-based functions
// (getCountryData, countryFromRoleWithConfig) instead.

export const ISO_TO_COUNTRY = {};
export const COUNTRY_COORDS = {};
export const COUNTRY_SPREAD = {};

// Legacy fallback (returns null when no config)
export function countryFromRole(role) {
  return null;
}

// Build country data from corridor config
export function getCountryData(config) {
  const countries = config?.geography?.countries;
  if (!countries) return { isoToCountry: {}, countryCoords: {}, countrySpread: {} };
  const isoToCountry = {};
  const countryCoords = {};
  const countrySpread = {};
  for (const [name, data] of Object.entries(countries)) {
    isoToCountry[data.iso] = name;
    countryCoords[name] = data.coords;
    countrySpread[name] = data.spread;
  }
  return { isoToCountry, countryCoords, countrySpread };
}

// Parse country from org.role strings like "Manufacturer - Vietnam"
export function countryFromRoleWithConfig(role, config) {
  if (!role) return null;
  const sep = role.includes(' · ') ? ' · ' : ' - ';
  const parts = role.split(sep).map(s => s.trim());
  if (parts.length < 2) return null;
  const candidate = parts[parts.length - 1];
  const mappings = config?.geography?.specialMappings || {};
  if (candidate in mappings) return mappings[candidate];
  const { countryCoords } = getCountryData(config);
  return countryCoords[candidate] ? candidate : null;
}
