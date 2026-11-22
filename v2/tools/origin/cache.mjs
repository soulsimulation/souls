// A stand-in cache node (Engine v2 V2, #2711) for proving the cache rules with no CDN: an HTTP caching proxy that
// keeps a 200 for its `max-age`, never keeps a `no-store` answer or any non-200, keys on the whole URL, and collapses
// concurrent misses for one key into one request upstream, as nginx's `proxy_cache_lock` does. It is not a CDN and
// not for production; the owner's alternative to a CDN is nginx itself (v2/docs/viewer-cache.md).
// Usage: node cache.mjs <upstream origin, e.g. http://127.0.0.1:8080> [port] [host]. Prints `cache <port>`; on
// SIGTERM or SIGINT prints `stats {json}` (hits, misses, collapsed, upstream requests, upstream and served body bytes)
// and exits. Forked with an IPC channel, it answers a `{take: true}` message with `{stats}` (the viewers bench, #4159).
import { Agent, createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Seconds a response may be kept, or 0: only a 200 with `max-age` and no `no-store`/`private`/`no-cache`. */
export function keepFor(status, cacheControl = '') {
  if (status !== 200) return 0;
  const cc = cacheControl.toLowerCase();
  if (/(^|,)\s*(no-store|private|no-cache)\b/.test(cc)) return 0;
  const m = /(^|,)\s*(?:s-maxage|max-age)=(\d+)/.exec(cc);
  return m ? Number(m[2]) : 0;
}

/** A cache node in front of `upstream`. `stats` counts what it did. */
export function createCache(upstream) {
  const base = new URL(upstream);
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  const store = new Map();
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, collapsed: 0, upstream: 0, upstreamBytes: 0, servedBytes: 0 };

  const fetchUpstream = (url) => new Promise((ok, fail) => {
    stats.upstream++;
    const req = request({ host: base.hostname, port: base.port, path: url, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const headers = { ...res.headers };
        delete headers.connection;
        delete headers['keep-alive'];
        const body = Buffer.concat(chunks);
        stats.upstreamBytes += body.length;
        ok({ status: res.statusCode, headers, body });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });

  const server = createServer(async (req, res) => {
    const key = req.url;
    const send = (e, how) => {
      res.writeHead(e.status, { ...e.headers, 'x-cache': how });
      if (req.method !== 'HEAD') stats.servedBytes += e.body.length;
      res.end(req.method === 'HEAD' ? undefined : e.body);
    };
    const now = Date.now();
    const kept = store.get(key);
    if (kept && kept.until > now) {
      stats.hits++;
      return send(kept, 'HIT');
    }
    let pending = inflight.get(key);
    let how = 'COLLAPSED';
    if (pending) stats.collapsed++;
    else {
      how = 'MISS';
      stats.misses++;
      pending = fetchUpstream(key).then((e) => {
        const s = keepFor(e.status, e.headers['cache-control']);
        if (s > 0) store.set(key, { ...e, until: Date.now() + s * 1000 });
        else store.delete(key);
        return e;
      }).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      send(await pending, how);
    } catch {
      res.writeHead(502, { 'cache-control': 'no-store' }).end();
    }
  });
  server.keepAliveTimeout = 60_000;
  return { server, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [upstream, port = '0', host = '127.0.0.1'] = process.argv.slice(2);
  if (!upstream) throw new Error('usage: node cache.mjs <upstream> [port] [host]');
  const { server, stats } = createCache(upstream);
  server.listen(Number(port), host, () => console.log(`cache ${server.address().port}`));
  const end = () => {
    console.log(`stats ${JSON.stringify(stats)}`);
    process.exit(0);
  };
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
  process.on('message', (m) => m?.take && process.send({ stats }));
}
