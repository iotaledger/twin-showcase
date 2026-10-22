// T-410 — BFF session layer (demo-safe scope).
//
// Today every state-mutating endpoint is reachable unauthenticated. This adds a
// stateless, HMAC-signed httpOnly session cookie issued at /api/login, and a
// middleware that requires it on WRITE methods (POST/PUT/PATCH/DELETE) — reads,
// the public QR/verify surfaces, the system-to-system token lane, the login
// endpoint itself, the TWIN proxy, static assets and the SPA fallback stay
// open, so the no-login QR verification keeps working and the demo UX is
// unchanged for a logged-in user (same-origin requests carry the cookie
// automatically).
//
// Deliberately demo-safe / scoped (documented follow-ons in the task):
//   - authentication only; per-route AUTHORIZATION stays where it is (e.g. the
//     consignment-owner check). RBAC-in-config is a follow-on.
//   - credential check + cookie signing reuse the existing demo password flow;
//     bcrypt-hashing the config passwords is a follow-on.
//   - no server-side session store: the cookie IS the session (signed).
import crypto from 'crypto';

const COOKIE = 'twin_session';
const TTL_MS = 8 * 60 * 60 * 1000; // 8h — long enough for a demo session
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function secret() {
  // Override in production. The default keeps the demo self-contained; it only
  // protects against trivially-forged sessions, which is the demo's bar.
  return process.env.SESSION_SECRET || 'twin-demo-session-secret-change-me';
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

// Stateless token: base64url(JSON{orgId,role,exp}).<hmac>
export function signSession(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS }));
  return `${body}.${sign(body)}`;
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  // Constant-time compare to avoid signature-timing leaks.
  const expected = sign(body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueSession(res, org) {
  const token = signSession({ orgId: org.id, role: org.role ?? null });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// Methods that never mutate state — always allowed (reads, preflight).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths exempt from the session requirement even on write methods. These are
// the intentionally-public or self-authenticating surfaces (see T-410 spec):
//   - /api/login           issues the session
//   - /api/logout          clears it
//   - /api/public/*        public verify + shipment (no-login QR landing)
//   - /api/verify/*        system-to-system, gated by x-service-token
//   - /twin/*              TWIN node proxy, carries the node's own auth
// (Static assets, the SPA HTML fallback and all GETs are covered by SAFE_METHODS
//  / not matching /api, so the QR pages load fine.)
const EXEMPT = [
  /^\/api\/login(\/|$|\?)/,
  /^\/api\/logout(\/|$|\?)/,
  /^\/api\/public\//,
  /^\/api\/verify\//,
  /^\/twin\//,
];

export function requireSession(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const path = req.path || req.url;
  if (EXEMPT.some((rx) => rx.test(path))) return next();
  const payload = verifySession(readCookie(req, COOKIE));
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required', detail: 'Log in to perform this action.' });
  }
  req.session = payload;
  return next();
}
