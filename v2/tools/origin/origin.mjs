// The viewer's origin (Engine v2 V2, #2711): a plain file server over the directory V1's stream writer fills
// (worldd::view_out), run apart from the world process. Caches in front of it keep what its headers say
// (v2/docs/viewer-cache.md):
//
// - a part, and a bundle's header: `public, max-age=31536000, immutable, no-transform` (never changes once written);
// - the pointer: `public, max-age=1, no-transform`, the shortest whole number of seconds at or above half a period
//   (max-age takes whole seconds; half of V1's 0.5 s period would round to 0, and every read would reach here);
// - every 404, a temporary file (`*.tmp`) and any URL with a query string: `no-store`.
//
// Each 200 carries a strong ETag, the SHA-256 of the bytes, which the reader tool checks.
// Usage: node origin.mjs <dir> [port] [host]. Prints `origin <port>`; on SIGTERM or SIGINT prints `stats {json}`
// (requests by kind, requests per part path, processor seconds) and exits.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMMUTABLE = 'public, max-age=31536000, immutable, no-transform';
export const POINTER = 'public, max-age=1, no-transform';
export const MISS = 'no-store';

/** What a path is: the pointer, an immutable file (a part or a header), or nothing to serve. */
export function kindOf(path) {
  const name = basename(path);
  if (name.endsWith('.tmp')) return null;
  if (name === 'pointer') return 'pointer';
  return 'immutable';
}

/** An origin over `dir`. `stats` counts what it served. */
export function createOrigin(dir) {
  const root = resolve(dir);
  const stats = { pointer: 0, immutable: 0, miss: 0, perPath: new Map() };
  const etags = new Map();
  const server = createServer(async (req, res) => {
    const miss = () => {
      stats.miss++;
      res.writeHead(404, { 'cache-control': MISS, 'content-length': 0 }).end();
    };
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
    let body;
    try {
      body = await readFile(file);
    } catch {
      return miss();
    }
    stats[kind]++;
    stats.perPath.set(rel, (stats.perPath.get(rel) ?? 0) + 1);
    let etag = kind === 'immutable' ? etags.get(file) : undefined;
    if (!etag) {
      etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      if (kind === 'immutable') etags.set(file, etag);
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'cache-control': kind === 'pointer' ? POINTER : IMMUTABLE,
      etag,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.keepAliveTimeout = 60_000;
  return { server, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, port = '0', host = '127.0.0.1'] = process.argv.slice(2);
  if (!dir) throw new Error('usage: node origin.mjs <dir> [port] [host]');
  const { server, stats } = createOrigin(dir);
  server.listen(Number(port), host, () => console.log(`origin ${server.address().port}`));
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
