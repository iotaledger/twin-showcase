/**
 * TWIN Proxy — single port (4002) routing to both nodes.
 *
 * Usage:
 *   node server/proxy.js
 *
 * Share ONE tunnel URL:
 *   cloudflared tunnel --url http://localhost:4002
 *   (or: npx localtunnel --port 4002)
 *
 * Stakeholders open:
 *   https://your-tunnel-url/?node=alpha   → Node Alpha (exporters / customs)
 *   https://your-tunnel-url/?node=beta    → Node Beta  (importers)
 *
 * The choice is stored in a cookie so all subsequent requests stay on
 * the right node without keeping the query param in the URL.
 */

import http from 'http';
import net  from 'net';

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '4002');
const ALPHA_HOST = process.env.ALPHA_HOST || '127.0.0.1';
const ALPHA_PORT = parseInt(process.env.ALPHA_PORT || '4000');
const BETA_HOST  = process.env.BETA_HOST  || '127.0.0.1';
const BETA_PORT  = parseInt(process.env.BETA_PORT  || '4001');
const ALPHA = { host: ALPHA_HOST, port: ALPHA_PORT };
const BETA  = { host: BETA_HOST,  port: BETA_PORT };

// Resolve target — URL param always beats cookie (so sharing /?node=alpha
// works even if the browser already has an twin-node=beta cookie)
function target(req) {
  if (req.url?.includes('node=alpha')) return ALPHA;
  if (req.url?.includes('node=beta'))  return BETA;
  // Fall back to cookie
  return /twin-node=beta/.test(req.headers.cookie || '') ? BETA : ALPHA;
}

// Build a Set-Cookie header when the ?node= param is present so all
// subsequent requests (no query param) keep routing to the right node
function nodeCookie(req) {
  if (req.url?.includes('node=alpha')) return 'twin-node=alpha; Path=/; HttpOnly; SameSite=Lax';
  if (req.url?.includes('node=beta'))  return 'twin-node=beta; Path=/; HttpOnly; SameSite=Lax';
  return null;
}

// ── HTTP proxy ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const t = target(req);
  const cookie = nodeCookie(req);

  const opts = {
    host: t.host, port: t.port,
    path: req.url, method: req.method,
    headers: { ...req.headers, host: `${t.host}:${t.port}` },
  };

  const proxy = http.request(opts, (pr) => {
    const headers = { ...pr.headers };
    if (cookie) {
      const existing = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : headers['set-cookie'] ? [headers['set-cookie']] : [];
      headers['set-cookie'] = [...existing, cookie];
    }
    res.writeHead(pr.statusCode, headers);
    pr.pipe(res, { end: true });
  });

  proxy.on('error', (e) => {
    res.writeHead(502).end(`Proxy error: ${e.message}\nIs the node running on port ${t.port}?`);
  });

  req.pipe(proxy, { end: true });
});

// ── WebSocket proxy ──────────────────────────────────────────────────────────
server.on('upgrade', (req, clientSocket, head) => {
  const t = target(req);

  const serverSocket = net.connect(t.port, t.host, () => {
    // Forward the original upgrade request headers verbatim
    const headerLines = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    serverSocket.write(
      `GET ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`
    );
    if (head?.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket, { end: true });
    clientSocket.pipe(serverSocket, { end: true });
  });

  serverSocket.on('error', (e) => {
    console.error(`[proxy] WS error on port ${t.port}:`, e.message);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => serverSocket.destroy());
});

server.listen(PROXY_PORT, () => {
  const base = `http://localhost:${PROXY_PORT}`;
  console.log(`\n  TWIN Proxy running on port ${PROXY_PORT}`);
  console.log(`\n  Node Alpha  →  ${base}/?node=alpha`);
  console.log(`  Node Beta   →  ${base}/?node=beta`);
  console.log(`\n  Tunnel with:`);
  console.log(`    cloudflared tunnel --url http://localhost:${PROXY_PORT}`);
  console.log(`    npx localtunnel --port ${PROXY_PORT}`);
  console.log(`\n  Then share:`);
  console.log(`    https://<tunnel-url>/?node=alpha   (Node Alpha)`);
  console.log(`    https://<tunnel-url>/?node=beta    (Node Beta)\n`);
});
