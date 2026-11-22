#!/usr/bin/env node
// The site owner's health page (Engine v2 O21, #3325): GET /ops/health.
//   plain GET   the shell, v2/web/health.html (phone width, light and dark), with no data in it; it fetches ?json=1
//               every 30 s.
//   ?json=1     each world's numbers and the Soul client versions in use over 24 h, as counts (read.mjs), for a signed-in site owner only. The session token comes by
//               `Authorization: Bearer` or the `__session` cookie and is checked by the directory's sign-in (W1,
//               `POST /v1/account/session`), which answers the account id; the account must be on the site owners'
//               list. No token: 401. A token the directory refuses: 401. Another account: 403. Neither gets a number.
// Reading wakes no world: the numbers are files on this machine (read.mjs); the only request made is the sign-in.
//
//   node page.mjs --root <worlds root> --directory <directoryd URL> --owners <site-owners.json> [--port 8090] [--host 127.0.0.1]
// site-owners.json: {"owners": ["<account id>", ...]}, the account ids W1 issues.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_METERED, clientsInUse, readWorlds } from './read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHELL = join(HERE, '..', '..', '..', 'web', 'health.html');
export const PATH = '/ops/health';
const VERIFY_TTL_MS = 60_000;

const cookie = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

/** The request's session token, or null. */
export function tokenOf(req) {
  const auth = String(req.headers.authorization ?? '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return cookie(req, '__session');
}

/** Checks a session token with the directory's sign-in; the account id, or null. Answers are cached a minute, by
 *  the token's hash (never the token). */
export function directoryVerifier(url, { fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.account;
    let account = null;
    try {
      const r = await fetchImpl(`${url}/v1/account/session`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
      });
      if (r.ok) account = (await r.json())?.account ?? null;
    } catch { /* the directory out of reach: not signed in */ }
    if (cache.size > 1000) cache.clear();
    cache.set(key, { account, until: now() + VERIFY_TTL_MS });
    return account;
  };
}

/** The page's handler: `(req, res)`, true when it answered. */
export function healthPage({ root, owners, verify, cost, now = Date.now, shell = SHELL }) {
  const ownerSet = new Set(owners);
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== PATH || req.method !== 'GET') return false;
    if (url.searchParams.get('json') !== '1') {
      send(res, 200, readFileSync(shell), 'text/html; charset=utf-8');
      return true;
    }
    const token = tokenOf(req);
    if (!token) return send(res, 401, { error: 'not-signed-in' }), true;
    const account = await verify(token);
    if (!account) return send(res, 401, { error: 'not-signed-in' }), true;
    if (!ownerSet.has(account)) return send(res, 403, { error: 'not-a-site-owner' }), true;
    const t = now();
    send(res, 200, { at: t, worlds: readWorlds(root, t, { cost }), clients: clientsInUse(root, t), not_metered: NOT_METERED });
    return true;
  };
}

/** A server for the page alone. */
export function serve(opts) {
  const handle = healthPage(opts);
  return createServer(async (req, res) => {
    if (!(await handle(req, res))) res.writeHead(404, { 'cache-control': 'no-store' }).end();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const root = opt('root', process.env.WORLDS_ROOT ?? '/var/lib/souls/worlds');
  const owners = JSON.parse(readFileSync(opt('owners'), 'utf8')).owners ?? [];
  const server = serve({ root, owners, verify: directoryVerifier(opt('directory')) });
  server.listen(Number(opt('port', 8090)), opt('host', '127.0.0.1'), () => console.log(`health page ${server.address().port}`));
}
