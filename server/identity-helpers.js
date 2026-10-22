import { getConfig } from './config.js';

// Map an org to the authority that attests its credential, using the
// config's credentials.attestationAuthorities list (matched by role
// substring) with credentials.defaultAuthority as fallback.
//
// Lives here (not in routes/orgs.js) because server/store.js also needs
// it to hydrate seed-loaded orgs at boot.
export function getAttestingAuthority(org) {
  const authorities = getConfig()?.credentials?.attestationAuthorities;
  if (authorities) {
    const match = authorities.find(a => org.role?.includes(a.roleMatch));
    if (match) return match.authority;
  }
  return getConfig()?.credentials?.defaultAuthority ?? 'National Business Registry';
}
