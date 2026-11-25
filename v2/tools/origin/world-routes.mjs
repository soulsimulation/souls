// Trusted placement metadata connects a public world to its native gateway. Requests never supply an upstream.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

export const WORLD_ROUTES = '/var/lib/souls/routes/worlds.json';
const WORLD = /^\/(preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/;
const local = (host) => host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
/** K3 (0.133): an allowed upload a creator's kind names (gatewayd's `GET /v2/uploads/<hash>`, immutable by hash). */
const UPLOAD = /^\/v2\/uploads\/1220[0-9a-f]{64}$/;
const publicPath = (s) => typeof s === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(s) && !s.split('/').some(p => p === '.' || p === '..');

/** Only operator/placement-owned file bytes may name native listeners. Invalid metadata refuses closed. */
export function readWorldRoutes(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || value.schema !== 'souls/world-routes/1' || !value.worlds || Array.isArray(value.worlds)) throw Error('world-routing-unconfigured');
  const worlds = Object.create(null);
  for (const [world, entry] of Object.entries(value.worlds)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(world) || !entry || !publicPath(entry.stream) || (entry.history !== undefined && !publicPath(entry.history)) || (entry.canonical !== undefined && typeof entry.canonical !== 'boolean') || (entry.archived !== undefined && typeof entry.archived !== 'boolean')) throw Error('world-routing-unconfigured');
    const gateway = new URL(entry.gateway);
    if (gateway.protocol !== 'http:' || !local(gateway.hostname) || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/' || entry.gateway !== gateway.origin) throw Error('world-routing-unconfigured');
    worlds[world] = { gateway: gateway.origin, stream: entry.stream, ...(entry.history ? { history: entry.history } : {}), canonical: entry.canonical === true, archived: entry.archived === true };
  }
  return worlds;
}

const reply = (res, status, refused, head = false) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' }).end(head ? undefined : JSON.stringify({ refused }));
const socketReply = (socket, status, refused) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${JSON.stringify({ refused })}`);

/** A creator's own gateway endpoints (#1960), each a POST: an upload (#3697), a bulk edit (#3695), a helper's token (#3727). */
const CREATOR_POSTS = ['/v2/creator-token', '/v2/creator-upload', '/v2/creator-edit', '/v2/creator-helper'];

/** The public bootstrap and the native gateway endpoints (the socket, the creator's posts, the entries, the kinds text, allowed uploads), on canonical and preview world paths. */
export function worldRoutes(file = process.env.SOULS_WORLD_ROUTES || WORLD_ROUTES) {
  const selected = (req) => {
    const url = new URL(req.url, 'http://origin'), match = WORLD.exec(url.pathname);
    if (!match) return null;
    const [, preview = '', world, path = '/'] = match, base = `/${preview}w/${world}`;
    if (!['/v1/bootstrap', '/views/world.json', '/v2/ws', '/v2/entries', '/v2/kinds', ...CREATOR_POSTS].includes(path) && !UPLOAD.test(path)) return null;
    let entry;
    try { entry = readWorldRoutes(file)[world]; } catch { return { status: 503, refused: 'world-routing-unconfigured' }; }
    if (!entry) return { status: 404, refused: 'world-not-routed' };
    if (entry.archived) return { status: 410, refused: 'world-archived' };
    if (!preview && !entry.canonical) return { status: 404, refused: 'world-preview-only' };
    if (url.search) return { status: 400, refused: 'world-route-query' };
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    const origin = `${protocol}//${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) return { status: 403, refused: 'origin-refused' };
    let host;
    try { host = new URL(origin).hostname; } catch { return { status: 400, refused: 'world-route-host' }; }
    if (/^Bearer test:/i.test(req.headers.authorization ?? '') && (protocol !== 'http:' || !local(host))) return { status: 403, refused: 'test-sign-in-public-address' };
    return { entry, world, path, base };
  };
  const headers = (req) => {
    const out = { ...req.headers };
    // The native server receives the real browser Origin and bearer unchanged, never fabricated identity headers.
    for (const name of Object.keys(out)) if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'proxy-authorization' || name.startsWith('x-souls-')) delete out[name];
    return out;
  };
  const handle = (req, res) => {
    const route = selected(req);
    if (!route) return false;
    if (route.refused) { reply(res, route.status, route.refused, req.method === 'HEAD'); return true; }
    const { entry, world, path, base } = route;
    if (path === '/v1/bootstrap' || path === '/views/world.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { reply(res, 405, 'read-only'); return true; }
      const body = JSON.stringify({ world, stream: entry.stream, ...(entry.history ? { history: entry.history } : {}), directory: '/', gateway: `${base}/v2/ws`, creatorToken: `${base}/v2/creator-token` });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    // #3760: a paired client's kind entries (GET, revalidated by its tag) pass through as the gateway answers them, and
    // so does a creator's kinds text (#1960).
    const entries = (path === '/v2/entries' || path === '/v2/kinds') && req.method === 'GET';
    // K3: an allowed upload's bytes, which the page draws a creator's kind with; cached as the gateway says (immutable)
    const upload = UPLOAD.test(path) && (req.method === 'GET' || req.method === 'HEAD');
    if (!entries && !upload && (!CREATOR_POSTS.includes(path) || req.method !== 'POST')) { reply(res, 405, path === '/v2/ws' ? 'websocket-required' : 'method'); return true; }
    // An upload's check and a bulk edit's answer take longer than a token's (the client waits 30 s and 10 s).
    const within = path === '/v2/creator-upload' ? 35_000 : path === '/v2/creator-edit' ? 15_000 : 5000;
    const upstream = request(new URL(path, entry.gateway), { method: req.method, headers: headers(req), timeout: within }, answer => {
      res.writeHead(answer.statusCode, { ...answer.headers, ...(upload ? {} : { 'cache-control': entries ? 'private, no-cache' : 'no-store' }), 'x-robots-tag': 'noindex, nofollow' }); answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (res.destroyed) return; if (!res.headersSent) reply(res, 502, 'gateway-unreachable'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
    return true;
  };
  const upgrade = (req, socket, head) => {
    let route;
    try { route = selected(req); } catch { return socketReply(socket, 400, 'world-route-request'); }
    if (!route) return socketReply(socket, 404, 'world-not-routed');
    if (route.refused) return socketReply(socket, route.status, route.refused);
    if (route.path !== '/v2/ws' || req.method !== 'GET') return socketReply(socket, 405, 'method');
    const upstream = request(new URL('/v2/ws', route.entry.gateway), { headers: headers(req), timeout: 5000 });
    let upgraded = false;
    socket.on('close', () => upstream.destroy());
    upstream.on('upgrade', (answer, native, nativeHead) => {
      if (socket.destroyed) { native.destroy(); return; }
      upgraded = true;
      upstream.setTimeout(0);
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${answer.rawHeaders.reduce((all, item, i) => all + item + (i % 2 ? '\r\n' : ': '), '')}\r\n`);
      if (head.length) native.write(head);
      if (nativeHead.length) socket.write(nativeHead);
      native.on('error', () => socket.destroy()); socket.on('error', () => native.destroy());
      native.on('close', () => socket.destroy()); socket.on('close', () => native.destroy());
      socket.pipe(native).pipe(socket);
    });
    upstream.on('response', answer => { socketReply(socket, answer.statusCode, 'gateway-refused'); answer.resume(); });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!socket.destroyed) { if (upgraded) socket.destroy(); else socketReply(socket, 502, 'gateway-unreachable'); } });
    socket.on('error', () => upstream.destroy()); upstream.end();
  };
  return { handle, upgrade };
}
