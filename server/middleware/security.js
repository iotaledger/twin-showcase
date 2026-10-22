// T-407 — application-level hardening, scoped to be FULLY COMPATIBLE with the
// current infrastructure (Traefik in front, single-URL proxy, tunnels) and to
// never block legitimate incoming traffic.
//
// Design rules (from the deployment constraints):
//   - Headers only by default. helmet adds safe response headers but its
//     traffic-affecting features are OFF: no CSP (the UI is inline-style-heavy),
//     no COEP/CORP (so QR pages, PDFs and assets load through Traefik/tunnels).
//   - CORS reflects the request origin and allows credentials (the session
//     cookie) — never a wildcard, never a hard block.
//   - Rate limiting is OPT-IN (RATE_LIMIT_ENABLED=1) and DEFAULT OFF, so it
//     cannot throttle Traefik-fronted traffic by accident. When enabled it is
//     proxy-aware (keys on the real client IP via X-Forwarded-For) and applies
//     only to the login brute-force surface with a generous threshold — reads,
//     pollers and the public QR/verify surfaces are never rate-limited.
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,       // UI uses inline styles throughout
    crossOriginEmbedderPolicy: false,   // don't break cross-origin embeds/tunnels
    crossOriginResourcePolicy: false,   // let PDFs/QR pages/assets load anywhere
  });
}

export function corsPolicy() {
  // Reflect the caller's origin (same-origin demo, proxy, and tunnels all work)
  // and allow the session cookie to ride. Not a wildcard (incompatible with
  // credentials) and not a deny — so Traefik-fronted traffic is unaffected.
  return cors({ origin: true, credentials: true });
}

// Login brute-force limiter — only constructed/applied when explicitly enabled.
export function loginRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,                 // generous: a real user logs in a handful of times
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please retry shortly.' },
  });
}

// True only when an operator explicitly opts in. Default OFF = zero impact on
// the current Traefik infrastructure.
export const rateLimitEnabled = () => process.env.RATE_LIMIT_ENABLED === '1';
