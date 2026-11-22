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
//
// Several processes serve one port (`processCount`, ORIGIN_PROCESSES; #4018: one thread saturated near 1,000 viewers):
// this one then only starts them, starts again any that ends, and sums their figures (`supervise`).
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism } from 'node:os';
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

/**
 * How many origin processes share its port: `ORIGIN_PROCESSES`, else the host's cores less `ORIGIN_RESERVE_CORES`
 * (default 2: the worlds and gateway need under 2 cores at goal load, v2/docs/machines.md), at least 1. Processes
 * share one port through the kernel's SO_REUSEPORT (`listen({ reusePort })`, Linux with Node 22.12 or later); where
 * that is missing the default is 1 and more is refused.
 */
export function processCount(env = process.env, cores = availableParallelism(), platform = process.platform, node = process.versions.node) {
  const [major, minor] = node.split('.').map(Number);
  const shares = platform === 'linux' && (major > 22 || (major === 22 && minor >= 12));
  if (env.ORIGIN_PROCESSES !== undefined && env.ORIGIN_PROCESSES !== '') {
    const n = Number(env.ORIGIN_PROCESSES);
    if (!Number.isInteger(n) || n < 1) throw new Error(`ORIGIN_PROCESSES must be a whole number of at least 1, not ${env.ORIGIN_PROCESSES}`);
    if (n > 1 && !shares) throw new Error('ORIGIN_PROCESSES above 1 needs Linux and Node 22.12 or later (one port shared with reusePort)');
    return n;
  }
  if (!shares) return 1;
  const reserve = Number(env.ORIGIN_RESERVE_CORES || 2);
  return Math.max(1, cores - (Number.isFinite(reserve) && reserve >= 0 ? reserve : 2));
}

/** The `stats` line printed at exit, from one or more processes' ends (`{ pointer, immutable, miss, parts, cpuSeconds }`). */
export function endStats(ends) {
  const perPart = new Map();
  for (const e of ends) for (const [p, n] of Object.entries(e.parts)) perPart.set(p, (perPart.get(p) ?? 0) + n);
  const parts = [...perPart.values()], sum = (k) => ends.reduce((a, e) => a + e[k], 0);
  return {
    pointer: sum('pointer'), immutable: sum('immutable'), miss: sum('miss'),
    parts: parts.length, perPartMax: Math.max(0, ...parts),
    perPartMean: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0,
    cpuSeconds: sum('cpuSeconds'),
  };
}

const writeStats = (file, value) => writeFile(`${file}.tmp`, JSON.stringify(value)).then(() => rename(`${file}.tmp`, file)).catch(() => {});

/**
 * One serving process: alone (prints `origin <port>`, writes ORIGIN_STATS, prints `stats {json}` at exit), or one of
 * several (ORIGIN_INDEX, set by `supervise`: it listens with reusePort and sends the same to the supervisor).
 */
function serveOne(dir, port, host, every) {
  const child = process.env.ORIGIN_INDEX !== undefined && Boolean(process.send);
  const index = child ? Number(process.env.ORIGIN_INDEX) : 0;
  const { server, stats } = createOrigin(dir);
  const started = Date.now();
  const figures = () => {
    const cpu = process.cpuUsage();
    return { index, pid: process.pid, started, pointer: stats.pointer, immutable: stats.immutable, miss: stats.miss,
      reads: stats.reads, bytes: stats.bytes, cpu_s: (cpu.user + cpu.system) / 1e6, rss_bytes: process.memoryUsage.rss() };
  };
  const end = () => {
    const f = figures();
    const parts = Object.fromEntries([...stats.perPath].filter(([p]) => /(^|\/)\d+$/.test(p)));
    return { pointer: f.pointer, immutable: f.immutable, miss: f.miss, parts, cpuSeconds: f.cpu_s };
  };
  server.listen({ port: Number(port), host, reusePort: child }, () => {
    if (child) process.send({ listening: server.address().port });
    else console.log(`origin ${server.address().port}`);
  });
  if (child) {
    setInterval(() => process.send({ figures: figures() }), every).unref();
    process.on('disconnect', () => process.exit(0)); // the supervisor is gone: never serve unsupervised
    process.on('SIGINT', () => {}); // a terminal's ^C reaches the whole group; the supervisor ends this one
    process.on('SIGTERM', () => process.send({ figures: figures(), end: end() }, () => process.exit(0)));
    return;
  }
  // O11 (#2721): bytes served by first path segment (a world's name), every 10 s, for v2/tools/ops/cost.
  const statsFile = process.env.ORIGIN_STATS;
  if (statsFile) setInterval(() => writeStats(statsFile, { started, bytes: stats.bytes, processes: [{ ...figures(), restarts: 0 }] }), every).unref();
  const stop = () => {
    console.log(`stats ${JSON.stringify(endStats([end()]))}`);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * `n` serving processes on one port, this one not among them: the kernel spreads connections across them, so no
 * process sits in the path. The first takes the port (0: any free one), the rest join it there. One that ends is
 * started again a second later (its row's `restarts`) while the others keep serving. ORIGIN_STATS gets `bytes`
 * summed over every process this supervisor ran (an ended one's last figures kept) and `processes`, a row each.
 * Each process holds its own buffers: ORIGIN_CACHE_MB applies per process, default 32 here.
 */
async function supervise(n, dir, port, host, every) {
  const self = fileURLToPath(import.meta.url), started = Date.now(), slots = [], ends = [], retired = {};
  let shared = Number(port), stopping = false, done;
  const start = (i) => new Promise((ok, fail) => {
    const slot = (slots[i] ??= { restarts: -1 });
    slot.restarts++;
    slot.figures = null;
    slot.child = fork(self, [dir, String(shared), host], {
      env: { ...process.env, ORIGIN_INDEX: String(i), ORIGIN_CACHE_MB: process.env.ORIGIN_CACHE_MB ?? '32' },
    });
    let up = false;
    slot.child.on('message', (m) => {
      if (m.listening) { up = true; ok(m.listening); }
      if (m.figures) slot.figures = m.figures;
      if (m.end) ends.push(m.end);
    });
    slot.child.on('exit', (code, signal) => {
      for (const [w, b] of Object.entries(slot.figures?.bytes ?? {})) retired[w] = (retired[w] ?? 0) + b;
      slot.figures = null;
      slot.child = null;
      if (stopping) return slots.every((s) => !s.child) && done();
      if (!up) return fail(new Error(`origin: process ${i} ended before it listened (${signal ?? code})`));
      console.error(`origin: process ${i} ended (${signal ?? code}); starting it again in 1 s`);
      setTimeout(() => start(i).catch((e) => { console.error(String(e)); process.exit(1); }), 1000);
    });
  });
  shared = await start(0);
  await Promise.all(Array.from({ length: n - 1 }, (_, i) => start(i + 1)));
  console.log(`origin ${shared}`);
  const statsFile = process.env.ORIGIN_STATS;
  if (statsFile) setInterval(() => {
    const bytes = { ...retired };
    for (const s of slots) for (const [w, b] of Object.entries(s.figures?.bytes ?? {})) bytes[w] = (bytes[w] ?? 0) + b;
    writeStats(statsFile, { started, bytes, processes: slots.map((s, i) => ({ index: i, ...s.figures, restarts: s.restarts })) });
  }, every).unref();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    done = () => {
      console.log(`stats ${JSON.stringify({ ...endStats(ends), processes: n, restarts: slots.reduce((a, s) => a + s.restarts, 0) })}`);
      process.exit(0);
    };
    setTimeout(() => { for (const s of slots) s.child?.kill('SIGKILL'); done(); }, 5000).unref();
    for (const s of slots) s.child?.kill('SIGTERM');
    if (slots.every((s) => !s.child)) done();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, port = '0', host = '127.0.0.1'] = process.argv.slice(2);
  if (!dir) throw new Error('usage: node origin.mjs <dir> [port] [host]');
  const every = Number(process.env.ORIGIN_STATS_MS || 10_000);
  const n = process.env.ORIGIN_INDEX !== undefined ? 1 : processCount();
  if (n > 1) await supervise(n, dir, port, host, every);
  else serveOne(dir, port, host, every);
}
