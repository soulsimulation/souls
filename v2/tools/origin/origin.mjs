// The viewer's origin (Engine v2 V2, #2711): a plain file server over the directory V1's stream writer fills
// (worldd::view_out), run apart from the world process. Caches in front of it keep what its headers say
// (v2/docs/viewer-cache.md):
//
// - a part, and a bundle's header: `public, max-age=31536000, immutable, no-transform` (never changes once written);
// - the pointer: `public, max-age=1, no-transform`, the shortest whole number of seconds at or above half a period
//   (max-age takes whole seconds; half of V1's 0.5 s period would round to 0, and every read would reach here);
// - every 404, a temporary file (`*.tmp`) and any URL with a query string: `no-store`. A 404 a browser asked for as a
//   page (Accept naming text/html, not an API path) carries site.mjs's "No page here" page (C1, #3673).
//
// Each 200 carries a strong ETag, the SHA-256 of the bytes, which the reader tool checks.
//
// An immutable file is read once and its one buffer is shared by every request for it (#4018: a join wave of 250
// viewers, each with its own copy of a 9 MB baseline, took the origin past its unit's 256 MB). Requests in flight
// share one read; the newest `cacheBytes` (ORIGIN_CACHE_MB, default 64) stay held after it, and a buffer a slow
// response still holds is found again. Each request checks the file's inode, size and modification time, so a file
// removed or replaced on disk answers as it does on disk. The pointer is read afresh for every request.
//
// The site's own pages (/changelog, /changelog.md, /v1/feed, /ops; O23, #3324) are answered first, by site.mjs, from
// the page's files and the release's news (SOULS_WEB, SOULS_DATA); every other path is a stream file as above.
// Usage: node origin.mjs <dir> [port] [host]. Prints `origin <port>`; on SIGTERM or SIGINT prints `stats {json}`
// (requests by kind, requests per part path, processor seconds) and exits.
import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noPage, siteRoutes, wantsPage } from './site.mjs';
import { worldRoutes } from './world-routes.mjs';

export const IMMUTABLE = 'public, max-age=31536000, immutable, no-transform';
export const POINTER = 'public, max-age=1, no-transform';
export const MISS = 'no-store';

/** What a path is: the pointer, an immutable file (a part or a header), or nothing to serve. */
export function kindOf(path) {
  const name = basename(path);
  if (name.endsWith('.tmp')) return null;
  if (name === 'pointer' || /(?:^|\/)history\/live$/.test(path)) return 'pointer';
  return 'immutable';
}

/**
 * Immutable files shared by path: `get(file)` gives `{ body, etag }` for the file as it is on disk now, reading it
 * only when no request in flight, no held buffer and no buffer a response still holds has that version (inode,
 * size, modification time). `held` is the newest buffers up to `cacheBytes`; `live` finds any other still in use.
 * `stats.reads` counts reads from disk.
 */
export function sharedFiles(cacheBytes, stats = {}) {
  const held = new Map(); // file -> entry, oldest first
  const live = new Map(); // file -> { version, etag, ref: WeakRef(body) }
  const reading = new Map(); // file -> { version, promise }
  const gone = new FinalizationRegistry(({ file, ref }) => { if (live.get(file)?.ref === ref) live.delete(file); });
  let heldBytes = 0;
  stats.reads = 0;
  const hold = (file, e) => {
    const old = held.get(file);
    if (old) { held.delete(file); heldBytes -= old.body.length; }
    if (e.body.length > cacheBytes) return;
    held.set(file, e);
    heldBytes += e.body.length;
    for (const [f, o] of held) {
      if (heldBytes <= cacheBytes) break;
      held.delete(f);
      heldBytes -= o.body.length;
    }
  };
  return async (file) => {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const version = `${s.ino}:${s.size}:${s.mtimeMs}`;
    let e = held.get(file);
    if (e?.version === version) { hold(file, e); return e; }
    const l = live.get(file), body = l?.version === version ? l.ref.deref() : undefined;
    if (body) { e = { version, etag: l.etag, body }; hold(file, e); return e; }
    let r = reading.get(file);
    if (r?.version !== version) {
      r = { version, promise: readFile(file).then((b) => {
        stats.reads++;
        const n = { version, body: b, etag: `"${createHash('sha256').update(b).digest('hex')}"` };
        const ref = new WeakRef(b);
        live.set(file, { version, etag: n.etag, ref });
        gone.register(b, { file, ref });
        hold(file, n);
        return n;
      }).finally(() => { if (reading.get(file) === r) reading.delete(file); }) };
      reading.set(file, r);
    }
    return r.promise;
  };
}

/**
 * An origin over `dir`, with the site's pages from `site` ({web, data}; site.mjs). `stats` counts what it served.
 * `cacheBytes` bounds the immutable buffers held after their requests end (sharedFiles).
 */
export function createOrigin(dir, site = {}, { cacheBytes = Number(process.env.ORIGIN_CACHE_MB ?? 64) * 2 ** 20 } = {}) {
  const root = resolve(dir), pages = siteRoutes(site), worlds = worldRoutes(site.worldRoutes);
  const stats = { pointer: 0, immutable: 0, miss: 0, perPath: new Map(), bytes: {} }; // bytes: served, by first segment (O11)
  const shared = sharedFiles(cacheBytes, stats);
  const server = createServer(async (req, res) => {
    const miss = () => {
      stats.miss++;
      if (wantsPage(req)) return noPage(req, res); // C1 (#3673): a person gets a page, a program the empty 404
      res.writeHead(404, { 'cache-control': MISS, 'content-length': 0 }).end();
    };
    try {
      if (worlds.handle(req, res)) return;
      if (pages.handle(req, res)) return;
    } catch {
      return miss();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return miss();
    if (req.url.includes('?')) return miss();
    let rel;
    try {
      rel = decodeURIComponent(req.url.slice(1));
    } catch {
      return miss();
    }
    const file = normalize(resolve(root, rel));
    if (!file.startsWith(root + sep)) return miss();
    const kind = kindOf(file);
    if (!kind) return miss();
    let body, etag;
    try {
      if (kind === 'immutable') ({ body, etag } = await shared(file));
      else {
        body = await readFile(file);
        etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      }
    } catch {
      return miss();
    }
    stats[kind]++;
    stats.perPath.set(rel, (stats.perPath.get(rel) ?? 0) + 1);
    if (req.method === 'GET') stats.bytes[rel.split('/')[0]] = (stats.bytes[rel.split('/')[0]] ?? 0) + body.length;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'cache-control': kind === 'pointer' ? POINTER : IMMUTABLE,
      etag,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.on('upgrade', worlds.upgrade);
  server.keepAliveTimeout = 60_000;
  return { server, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, port = '0', host = '127.0.0.1'] = process.argv.slice(2);
  if (!dir) throw new Error('usage: node origin.mjs <dir> [port] [host]');
  const { server, stats } = createOrigin(dir);
  server.listen(Number(port), host, () => console.log(`origin ${server.address().port}`));
  // O11 (#2721): bytes served by first path segment (a world's name), every 10 s, for v2/tools/ops/cost.
  const statsFile = process.env.ORIGIN_STATS, started = Date.now();
  if (statsFile) setInterval(() => writeFile(`${statsFile}.tmp`, JSON.stringify({ started, bytes: stats.bytes }))
    .then(() => rename(`${statsFile}.tmp`, statsFile)).catch(() => {}), 10_000).unref();
  const end = () => {
    const cpu = process.cpuUsage();
    const parts = [...stats.perPath].filter(([p]) => /(^|\/)\d+$/.test(p)).map(([, n]) => n);
    console.log(`stats ${JSON.stringify({
      pointer: stats.pointer, immutable: stats.immutable, miss: stats.miss,
      parts: parts.length, perPartMax: Math.max(0, ...parts),
      perPartMean: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
    })}`);
    process.exit(0);
  };
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
}
