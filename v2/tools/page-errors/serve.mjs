#!/usr/bin/env node
// The page-error service (Engine v2 O25, #3336): the one address `/__sim/client-errors`. A POST is a page's beacon
// (anyone: body-capped, per-address and site-wide limits, page-errors.mjs); a GET is the operator's summary and is
// answered only to this machine itself (loopback, no proxy header), else 404. It writes `health.json` in its data
// folder, `{at_unix_ms, build, newSinceRelease, new: [{fp, kind, message, source}]}`, which O15's look carries to the
// watcher (v2/tools/ops/watch). Runbook: v2/docs/runbook/page-errors.md.
//
//   node serve.mjs --data <folder> [--build <id>] [--port 7330] [--host 127.0.0.1]
// `--build` (or SOULS_BUILD) names the page build that is live: kinds first seen from then on are new.
import { renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_ERROR_LIMITS, clientErrors } from './page-errors.mjs';

export const PATH = '/__sim/client-errors';
export const HEALTH_MS = 5_000;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** What "the same address" means for the per-address limit, carried over from today's address-key.ts (#2543): the first
 *  `x-forwarded-for` entry (the visitor the proxy saw) or the peer; IPv4 itself, IPv6 by its /64, mapped IPv4 as IPv4. */
export function addressKey(forwarded) {
  const a = String(forwarded ?? '').split(',').map((s) => s.trim()).find(Boolean);
  if (!a) return '';
  if (isIP(a) !== 6) return a;
  const s = a.split('%')[0].toLowerCase(), tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  const v6 = tail ? `${s.slice(0, tail.index)}${((+tail[1] << 8) | +tail[2]).toString(16)}:${((+tail[3] << 8) | +tail[4]).toString(16)}` : s;
  const [head, rest] = v6.split('::'), h = head ? head.split(':') : [], r = rest ? rest.split(':') : [];
  const g = (rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r]).map((x) => parseInt(x, 16));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

const direct = (req) => !req.headers['x-forwarded-for'] && LOOPBACK.includes(req.socket.remoteAddress ?? '');

/** The service: `{server, errors, writeHealth, close}`; listen with `server.listen(port, host)`. */
export function pageErrors({ dir, build = 'dev', limits = {}, now = Date.now, log = (l) => console.warn(l), healthMs = HEALTH_MS } = {}) {
  const errors = clientErrors({ dir, build, limits, now, log });
  const L = { ...CLIENT_ERROR_LIMITS, ...limits };
  let dirty = true;
  const writeHealth = () => {
    dirty = false;
    const h = { at_unix_ms: now(), build, newSinceRelease: errors.newSinceRelease(), new: errors.newKinds() };
    try { writeFileSync(join(dir, 'health.json.tmp'), JSON.stringify(h)); renameSync(join(dir, 'health.json.tmp'), join(dir, 'health.json')); } catch (e) { log(`page-errors: cannot write health.json: ${e.message}`); }
    return h;
  };
  writeHealth();
  const tick = setInterval(() => { if (dirty) writeHealth(); }, healthMs);
  tick.unref?.();
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== PATH) return json(res, 404, { ok: false, code: 'not-found' });
    if (req.method === 'POST') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > L.bodyBytes) return json(res, 413, { ok: false, code: 'too-large' }); chunks.push(c); }
      const [st, out] = errors.ingest(addressKey(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress), req.headers['user-agent'], Buffer.concat(chunks));
      if (st === 204) dirty = true;
      return out ? json(res, st, out) : res.writeHead(st, { 'cache-control': 'no-store' }).end();
    }
    if (req.method === 'GET' && direct(req)) return json(res, 200, errors.summary({ limit: url.searchParams.get('limit'), world: url.searchParams.get('world') || undefined }));
    return json(res, 404, { ok: false, code: 'not-found' });
  });
  const close = () => { clearInterval(tick); errors.flush(); writeHealth(); server.close(); };
  return { server, errors, writeHealth, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const data = opt('data');
  if (!data) throw new Error('usage: node serve.mjs --data <folder> [--build <id>] [--port 7330] [--host 127.0.0.1]');
  const svc = pageErrors({ dir: data, build: opt('build', process.env.SOULS_BUILD || 'dev') });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { svc.close(); process.exit(0); });
  svc.server.listen(Number(opt('port', 7330)), opt('host', '127.0.0.1'), () => console.log(`page-errors ${svc.server.address().port}`));
}
