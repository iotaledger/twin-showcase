// T-315 (redesigned) — transparent reverse proxy to the TWIN node's
// verification interface. NOT an abstraction layer: it forwards requests
// (method, path, query, body and headers — including `Authorization` and
// `x-api-key`) straight to the TWIN node core and returns its response
// verbatim. The caller authenticates exactly as it would against the node.
//
// Scope: verification + auth only —
//   /twin/authentication/*   (login → JWT, refresh, logout)
//   /twin/immutable-proof/*  (get proof, verify)
//   /twin/verifiable/*       (on-chain verifiable-storage object)
//
// Swagger UI (/twin/docs) serves the TWIN node's own OpenAPI spec (fetched
// from the node, filtered to the scope, `servers` rewritten to the proxy),
// so the page shows the node's native interface with the node's auth.
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { store, NODE_ID } from '../store.js';
import { resolveAdapterConfig } from '../adapter/index.js';

const router = Router();

const PROXY_BASE = '/twin';
// Path prefixes (relative to the node root) the proxy forwards. Verification
// + the auth needed to perform it (login → JWT, refresh, logout, password).
// The auth *admin* surface (/authentication/admin/*, /authentication/audit)
// is intentionally NOT exposed — this is a verification proxy, not a node
// admin console.
const ALLOWED = [
  /^\/authentication\/(login|logout|refresh|password)(\/|$)/,
  /^\/immutable-proof(\/|$)/,
  /^\/verifiable(\/|$)/,
];

// The live TWIN node base URL (null in simulated mode → proxy unavailable).
function nodeBase() {
  return store.adapter?.nodeUrl ?? null;
}
// The tenant api-key for the server-side spec fetch (the node's /spec needs
// only x-api-key). The per-request proxy uses the CALLER's key, not this.
function specApiKey() {
  return resolveAdapterConfig(store.adapter?.mode ?? 'simulated', NODE_ID).apiKey ?? null;
}

// Replace every external ($ref to an absolute http(s) URL) schema reference
// with a permissive empty schema. The node spec points them at
// https://schema.twindev.org/ which is 404, breaking swagger-ui's resolver.
function sanitizeExternalRefs(node) {
  if (Array.isArray(node)) return node.map(sanitizeExternalRefs);
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && /^https?:\/\//.test(node.$ref)) return {};
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = sanitizeExternalRefs(v);
    return out;
  }
  return node;
}

// ── OpenAPI spec (the node's own, scoped + re-based) ──────────────────────

let cachedSpec = null;
async function loadNodeSpec() {
  if (cachedSpec) return cachedSpec;
  const base = nodeBase();
  const key = specApiKey();
  if (!base || !key) return null;
  let raw;
  try {
    const r = await fetch(`${base}/spec`, { headers: { 'x-api-key': key, accept: 'application/json' } });
    if (!r.ok) return null;
    raw = await r.json();
  } catch {
    return null;
  }
  // Keep only the verification + auth paths.
  const paths = {};
  for (const [p, item] of Object.entries(raw.paths ?? {})) {
    if (ALLOWED.some(rx => rx.test(p))) paths[p] = item;
  }
  raw.paths = paths;
  // The node spec (OpenAPI 3.1) references external schemas under
  // https://schema.twindev.org/ — that host now returns 404, so swagger-ui
  // can't resolve them ("Elements in allOf must be objects" resolver errors).
  // Neutralize every external $ref to a permissive empty schema: the page
  // renders cleanly and "Try it out" still works — only the schema *models*
  // are relaxed (the endpoints, requests and responses are unaffected).
  raw = sanitizeExternalRefs(raw);
  raw.servers = [{ url: PROXY_BASE, description: 'TWIN node, via the demo proxy (same endpoints, same auth)' }];

  // Security: keep the node's own bearer scheme (jwtBearerAuthScheme, used by
  // the protected ops) and ADD an api-key scheme — the node needs `x-api-key`
  // on every request but doesn't declare it in the spec. Then make every op
  // require the api-key (plus the JWT it already required), so Swagger sends
  // both headers and the "Authorize" / preauthorize wiring lines up.
  raw.components = raw.components ?? {};
  raw.components.securitySchemes = {
    ...(raw.components.securitySchemes ?? {}),
    jwtBearerAuthScheme: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT from POST /authentication/login (the organisation\'s session).' },
    ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Tenant API key (multi-tenant mode) — required on EVERY call.' },
  };
  // Plain text (no inline `code`) — swagger-ui's markdown renderer overlaps
  // long inline-code tokens onto the previous line.
  const OP_DESCRIPTIONS = {
    'POST /authentication/login': 'Authenticate as an organisation. Requires the tenant x-api-key header. Returns a JWT (in the Set-Cookie access_token) — set it as the Bearer token to call the endpoints below.',
    'POST /authentication/logout': 'Invalidate the current session.',
    'POST /authentication/refresh': 'Refresh the JWT before it expires.',
    'PUT /authentication/password': 'Change the current user password.',
    'GET /immutable-proof/{id}': 'Fetch the full immutable-proof Verifiable Credential — the issuer DID (the signer), the DataIntegrityProof signature, the proofIntegrity (the signed document-envelope hash) and the on-chain receipt (verifiableStorageId / objectId). Auth: x-api-key + Bearer JWT.',
    'GET /immutable-proof/{id}/verify': 'Verify the proof on-chain. Returns verified plus a failure reason. verified=true means the document hash is signed by the org DID and anchored on IOTA, independently confirmable by anyone. Auth: x-api-key + Bearer JWT.',
    'GET /verifiable/{id}': 'Fetch the raw on-chain verifiable-storage object (the anchor itself) by its verifiable:iota id.',
  };
  for (const [p, item] of Object.entries(raw.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'delete']) {
      const op = item[method];
      if (!op) continue;
      // The TWIN node spec declares a `requestBody` even on GET ops (e.g.
      // GET /verifiable/{id}, GET /immutable-proof/{id}/verify). swagger-ui
      // then renders an editable body and tries to send a GET *with* a body,
      // which the browser's fetch rejects: "Request with GET/HEAD method
      // cannot have body." Strip the body on GET/HEAD so "Try it out" works.
      if ((method === 'get' || method === 'head') && op.requestBody) delete op.requestBody;
      // Require api-key on every op (added to whatever it already required).
      op.security = Array.isArray(op.security) && op.security.length
        ? op.security.map(req => ({ ...req, ApiKeyAuth: [] }))
        : [{ ApiKeyAuth: [] }];
      const desc = OP_DESCRIPTIONS[`${method.toUpperCase()} ${p}`];
      if (desc) op.description = desc;
    }
  }
  raw.info = {
    ...(raw.info ?? {}),
    title: 'TWIN Node — verification interface (proxied)',
    description: 'The TWIN node\'s native verification + auth API, forwarded verbatim by the demo server. Authenticate the same way you would against the node: set the `x-api-key`, then `POST /authentication/login` to get a JWT and set it as the Bearer token. This is NOT an abstraction — requests hit the node core directly.\n\n**Demo shortcut:** this page auto-applies a **node-tenant** session on load — the seed-derived api-key + a freshly-minted JWT for the identity shown in the panel below — so you can expand `GET /immutable-proof/{id}/verify` and click *Execute* straight away. Consignments, documents and immutable proofs live in the **node tenant**, so the auto-applied identity is a node-tenant one: a REST-provisioned org if the seed has one, otherwise the node admin (every org is its own tenant under the per-org-tenant model — a per-org-tenant token logs in fine but gets `proofNotFound` on node-tenant proofs). The exact identity + credentials are always current (re-read from the live seed on each load) — see `GET /twin/demo-session`. The login endpoint is still here to demonstrate the real auth.',
  };
  cachedSpec = raw;
  return raw;
}

router.get('/twin/openapi.json', async (_req, res) => {
  const base = await loadNodeSpec();
  if (!base) return res.status(503).json({ error: 'TWIN node spec unavailable (simulated mode or node unreachable)' });
  // Inject a live, seed-derived example proof id into the immutable-proof path
  // params, so the Swagger "Try it out" field is pre-filled with a real proof
  // for the client demo. Done per-request (cheap clone) so it tracks the seed.
  const spec = JSON.parse(JSON.stringify(base));
  // Pre-fill the "Try it out" fields: the proof id (a live seeded proof) and
  // the required `accept` header (the verify op ships without an example).
  const seeded = store.documents.find(d => d.proofId && d.notarizationMode !== 'simulated');
  for (const p of ['/immutable-proof/{id}', '/immutable-proof/{id}/verify']) {
    const params = spec.paths?.[p]?.get?.parameters ?? [];
    const idParam = params.find(x => x.name === 'id' && x.in === 'path');
    if (idParam && seeded?.proofId) idParam.example = seeded.proofId;
    const acceptParam = params.find(x => x.name === 'accept' && x.in === 'header');
    if (acceptParam && !acceptParam.example) acceptParam.example = 'application/json';
  }
  // Make the logged-in identity visible + list every org so the presenter can
  // log in manually as a custom one (DEMO ONLY — exposes testnet credentials).
  const nodeKey = specApiKey();
  const ident = pickVerificationIdentity(resolveAdapterConfig(store.adapter?.mode ?? 'simulated', NODE_ID));
  const orgs = listDemoOrgs(nodeKey);
  // Pre-fill the login body with the SAME node-tenant identity that the page
  // auto-applies, so the example matches the api-key in Authorize.
  const loginJson = spec.paths?.['/authentication/login']?.post?.requestBody?.content?.['application/json'];
  if (loginJson) loginJson.example = { email: ident.email, password: ident.password };
  if (orgs.length) {
    let md = '\n\n## Identities in this seed (DEMO ONLY)\n\n';
    md += `🔓 **Auto-authorized as _${ident.as.name}_** (${ident.as.email}, ${ident.as.scope} scope, node tenant) — the verification endpoints below are ready to *Try it out* immediately.\n\n`;
    md += `This is node **${NODE_ID}** — it shows only this side's organisations. The other corridor side is on its own demo server: alpha at :4000/twin/docs, beta at :4001/twin/docs.\n\n`;
    md += '### How to test any endpoint\n\nEvery call needs BOTH: an `x-api-key` header (tenant) AND a Bearer JWT (identity) — set both under **Authorize**. The two MUST belong to the same tenant.\n\n';
    md += '- **To verify a proof** (`/immutable-proof/*`): use the auto-applied node-tenant session above — nothing to do, just *Try it out*.\n';
    md += '- **To log in as a specific organisation**: each row below is a self-contained triple — copy its **x-api-key** into Authorize, then run POST /authentication/login with the SAME row\'s username + password. Using one org\'s key with another org\'s credentials fails with `userNotFound`.\n\n';
    md += '> ⚠️ Org sessions live in their OWN tenant — they authenticate, but they canNOT read the node-tenant proofs (`proofNotFound`). They exist for org-signed attestations. Proof verification is a node-tenant operation (the auto-applied session).\n\n';
    md += '| Organisation | Role | Username | Password | x-api-key (this org\'s tenant) |\n|---|---|---|---|---|\n';
    for (const o of orgs) {
      md += `| ${o.name} | ${o.role ?? ''} | \`${o.email}\` | \`${o.password}\` | \`${o.apiKey ?? '—'}\`${o.ownTenant ? '' : ' (node tenant)'} |\n`;
    }
    spec.info = { ...(spec.info ?? {}), description: (spec.info?.description ?? '') + md };
  }
  res.json(spec);
});

// ── Demo session (DEMO ONLY) ──────────────────────────────────────────────
// A one-call, seed-derived auth bundle so the Swagger page can be presented
// to a client without manual key/token wrangling: the tenant api-key, a JWT
// minted by logging in as a REGISTERED ORGANISATION (not the node admin), and
// a live example proof id from the loaded seed. The Swagger UI auto-applies
// these on load. NOTE: exposes testnet org credentials — never enable in prod.

// Pick a registered org that has provisioned TWIN user credentials (from the
// seed). Prefer an exporter for a natural demo persona.
// The identity the Swagger page auto-applies for "Try it out". The verification
// endpoints read the NODE tenant (where consignments, documents and immutable
// proofs live), so this MUST be a node-tenant identity — a per-org-tenant org
// can log in but sees `proofNotFound`. Prefer a REST-provisioned org (it lives
// in the node tenant); if every org is its own tenant (wallets.mjs
// provision-orgs), fall back to the node admin so verification still works.
function pickVerificationIdentity(cfg) {
  const org = (store.orgs ?? []).find(
    o => o?.twinCredentials?.email && o?.twinCredentials?.password && o?.did && !o.twinCredentials.tenantApiKey,
  );
  if (org) {
    return {
      email: org.twinCredentials.email,
      password: org.twinCredentials.password,
      as: { orgId: org.id, name: org.name, did: org.did, role: org.role ?? null, email: org.twinCredentials.email, scope: 'user', tenant: 'node' },
    };
  }
  return {
    email: cfg.email,
    password: cfg.password,
    as: { name: `${NODE_ID} node admin`, email: cfg.email, scope: 'admin', tenant: 'node' },
  };
}

async function mintToken(base, apiKey, email, password) {
  try {
    const r = await fetch(`${base}/authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) return null;
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const m = cookies.join('; ').match(/access_token=([^;]+)/);
    if (m) return m[1];
    const body = await r.json().catch(() => ({}));
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

router.get('/twin/demo-session', async (_req, res) => {
  const base = nodeBase();
  const cfg = resolveAdapterConfig(store.adapter?.mode ?? 'simulated', NODE_ID);
  if (!base || !cfg.apiKey) {
    return res.status(503).json({ error: 'Demo session unavailable (simulated mode or node unreachable)' });
  }
  // Authenticate as a NODE-TENANT identity so the auto-applied JWT can actually
  // read the proofs (a per-org-tenant org logs in but gets proofNotFound).
  const ident = pickVerificationIdentity(cfg);
  const token = await mintToken(base, cfg.apiKey, ident.email, ident.password);
  const seeded = store.documents.find(d => d.proofId && d.notarizationMode !== 'simulated');
  res.json({
    note: 'DEMO ONLY — node-tenant session (api-key + JWT match), so the verification endpoints work out of the box. Testnet credentials from the loaded seed; do not enable in production.',
    node: NODE_ID,
    apiKey: cfg.apiKey, // node tenant scoping key — pairs with the JWT below
    token,              // JWT minted with the SAME tenant key (node tenant)
    as: ident.as,
    login: { url: '/twin/authentication/login', email: ident.email, password: ident.password, apiKey: cfg.apiKey },
    exampleProofId: seeded?.proofId ?? null,
    tryItOut: seeded?.proofId ? `/twin/immutable-proof/${seeded.proofId}/verify` : null,
  });
});

// All registered organisations from the loaded seed, with their TWIN user
// credentials — so a presenter can log in manually as ANY of them.
function listDemoOrgs(nodeKey) {
  return (store.orgs ?? [])
    .filter(o => o?.twinCredentials?.email && o?.twinCredentials?.password)
    .map(o => ({
      orgId: o.id,
      name: o.name,
      role: o.role ?? null,
      did: o.did ?? null,
      email: o.twinCredentials.email,
      password: o.twinCredentials.password,
      // The x-api-key to log in AS this org. Per-org-tenant orgs carry their
      // own key; REST-provisioned orgs live in the node tenant (node key).
      apiKey: o.twinCredentials.tenantApiKey ?? nodeKey ?? null,
      ownTenant: Boolean(o.twinCredentials.tenantApiKey),
    }));
}

router.get('/twin/demo-orgs', (_req, res) => {
  const nodeKey = resolveAdapterConfig(store.adapter?.mode ?? 'simulated', NODE_ID).apiKey ?? null;
  const orgs = listDemoOrgs(nodeKey);
  if (!orgs.length) {
    return res.status(503).json({ error: 'No registered organisations with TWIN credentials in the loaded seed (re-run twin:seed)' });
  }
  res.json({
    note: 'DEMO ONLY — testnet org credentials from the loaded seed. Each org\'s apiKey is the x-api-key to log in AS that org; pair it ONLY with the same row\'s email/password.',
    node: NODE_ID,
    count: orgs.length,
    organisations: orgs,
  });
});

// Auto-apply the seed-derived api-key + JWT in the Swagger UI on load, so the
// page is ready to "Try it out" for a client demo (the manual login endpoint
// is still visible to demonstrate the real auth).
const PREAUTH_JS = `
(function () {
  function apply(tries) {
    if (!window.ui || !window.ui.preauthorizeApiKey) {
      if (tries > 0) return setTimeout(function () { apply(tries - 1); }, 200);
      return;
    }
    fetch('/twin/demo-session').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      try { if (s.apiKey) window.ui.preauthorizeApiKey('ApiKeyAuth', s.apiKey); } catch (e) {}
      try { if (s.token) window.ui.preauthorizeApiKey('jwtBearerAuthScheme', s.token); } catch (e) {}
    }).catch(function () {});
  }
  window.addEventListener('load', function () { apply(25); });
})();
`;

router.use(
  '/twin/docs',
  swaggerUi.serve,
  swaggerUi.setup(null, {
    customSiteTitle: 'TWIN Node — verification (proxied)',
    customJsStr: PREAUTH_JS,
    swaggerOptions: { url: '/twin/openapi.json', persistAuthorization: true, defaultModelsExpandDepth: -1 },
  }),
);

// ── Transparent reverse proxy (scoped) ────────────────────────────────────

router.use('/twin', async (req, res) => {
  const sub = req.url; // path (+query) after the /twin mount, e.g. /immutable-proof/x/verify
  const pathname = sub.split('?')[0];
  if (!ALLOWED.some(rx => rx.test(pathname))) {
    return res.status(404).json({
      error: 'Out of scope for this proxy',
      allowed: ['/authentication/*', '/immutable-proof/*', '/verifiable/*'],
    });
  }
  const base = nodeBase();
  if (!base) {
    return res.status(503).json({ error: 'No TWIN node configured (simulated mode) — start the demo with ADAPTER_MODE=docker/hosted' });
  }

  // Forward method, path, query, headers and body verbatim. The caller's
  // Authorization / x-api-key pass straight through — same auth as the node.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  const init = { method: req.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    init.body = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
  }

  try {
    const upstream = await fetch(base + sub, init);
    res.status(upstream.status);
    // Forward set-cookie (the login JWT) properly, then the other headers.
    const setCookie = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (setCookie.length) res.set('set-cookie', setCookie);
    upstream.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (['set-cookie', 'transfer-encoding', 'content-encoding', 'content-length', 'connection'].includes(key)) return;
      res.set(k, v);
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'TWIN node proxy failed', detail: e.message });
  }
});

export default router;
