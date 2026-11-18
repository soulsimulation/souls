// Scripted readers of the viewer's stream (Engine v2 V2, #2711), for measuring an origin through caches or a CDN.
// Each reader keeps one connection (one TLS connection on https) and, once a second on its own clock, asks for the
// pointer, then for every part the pointer names that it has not had, in order. It never asks for a part the pointer
// has not named. Every part is checksummed: its SHA-256 must equal its ETag when one is sent, and all readers must
// get the same bytes for a number. Lateness is the time a part arrives after the wall time its world-time end fell at
// (the pointer's anchor); a part counts as late past the page's two-second playback delay.
// Usage: node readers.mjs <base URL[,base URL…]> <stream path> <readers> <seconds> [processes]
// Reader i uses base i mod the number of bases. Prints one `readers {json}` line.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

export const PLAYBACK_DELAY_MS = 2000;
const BUCKET_MS = 10;

/** A small CBOR reader: the unsigned and negative integers, byte and text strings, arrays and maps V1's files use. */
export function cbor(buf) {
  let i = 0;
  const arg = (info) => {
    if (info < 24) return info;
    const n = 1 << (info - 24);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + buf[i++];
    return v;
  };
  const item = () => {
    const b = buf[i++];
    const major = b >> 5;
    const a = arg(b & 31);
    switch (major) {
      case 0: return a;
      case 1: return -1 - a;
      case 2: return buf.subarray(i, (i += a));
      case 3: return buf.subarray(i, (i += a)).toString('utf8');
      case 4: return Array.from({ length: a }, item);
      case 5: {
        const m = new Map();
        for (let k = 0; k < a; k++) m.set(item(), item());
        return m;
      }
      default: throw new Error(`cbor: major type ${major} is not read here`);
    }
  };
  return item();
}

/** The pointer's fields (replica::stream::Pointer). */
export function readPointer(buf) {
  const m = cbor(buf);
  return { newest: m.get(1), period: m.get(2), newestTo: m.get(4), anchorWorld: m.get(5), anchorWallMs: m.get(6) };
}

/** One GET over `agent`; resolves with status, headers, body and the response's header bytes. */
export function get(base, path, agent) {
  const url = new URL(path, base);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((ok, fail) => {
    const req = request(url, { agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        headerBytes: res.rawHeaders.reduce((n, h) => n + h.length + 2, 0),
      }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

export const agentFor = (base) => (new URL(base).protocol === 'https:'
  ? new HttpsAgent({ keepAlive: true, maxSockets: 1 })
  : new HttpAgent({ keepAlive: true, maxSockets: 1 }));

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Runs readers `ids` for `seconds`; returns their counts, a lateness histogram and each part's digests. */
async function run(bases, stream, ids, total, seconds) {
  const out = {
    readers: ids.length, pointerReads: 0, partReads: 0, bytes: 0, headerBytes: 0, responses: 0,
    errors: 0, errorSamples: [], badChecksum: 0, noEtag: 0, late: 0, hist: {}, digests: {}, cache: {},
  };
  const fail = (what) => {
    out.errors++;
    if (out.errorSamples.length < 5) out.errorSamples.push(what);
  };
  const end = Date.now() + seconds * 1000;
  const one = async (id) => {
    const base = bases[id % bases.length];
    const agent = agentFor(base);
    const dir = `${stream.replace(/^\/|\/$/g, '')}/`;
    const at = (path) => get(base, `/${dir}${path}`, agent);
    const count = (r) => {
      out.bytes += r.body.length;
      out.headerBytes += r.headerBytes;
      out.responses++;
      const how = r.headers['x-cache'] ?? r.headers['cf-cache-status'] ?? r.headers['cdn-cache'] ?? 'none';
      out.cache[how] = (out.cache[how] ?? 0) + 1;
    };
    let next = null;
    let tick = Date.now() + Math.floor((id / total) * 1000);
    while (tick < end) {
      await new Promise((ok) => setTimeout(ok, Math.max(0, tick - Date.now())));
      tick += 1000;
      try {
        const p = await at('pointer');
        out.pointerReads++;
        count(p);
        if (p.status !== 200) {
          fail(`pointer ${p.status}`);
          continue;
        }
        const ptr = readPointer(p.body);
        if (ptr.newest === undefined) continue;
        next ??= ptr.newest;
        for (; next <= ptr.newest && Date.now() < end; next++) {
          const r = await at(String(next));
          out.partReads++;
          count(r);
          if (r.status !== 200) {
            fail(`part ${next} ${r.status}`);
            continue;
          }
          const arrived = Date.now();
          const digest = sha256(r.body);
          const etag = r.headers.etag?.replace(/^W\//, '').replaceAll('"', '');
          if (etag === undefined) out.noEtag++;
          else if (etag !== digest) out.badChecksum++;
          const seen = (out.digests[next] ??= []);
          if (!seen.includes(digest)) seen.push(digest);
          const part = cbor(r.body);
          const due = ptr.anchorWallMs + (part.get(3) - ptr.anchorWorld) / 1000;
          const delay = arrived - due;
          if (delay > PLAYBACK_DELAY_MS) out.late++;
          const b = Math.max(0, Math.floor(delay / BUCKET_MS));
          out.hist[b] = (out.hist[b] ?? 0) + 1;
        }
      } catch (e) {
        fail(String(e.code ?? e.message));
      }
    }
    agent.destroy();
  };
  await Promise.all(ids.map(one));
  return out;
}

const quantile = (hist, q) => {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const n = keys.reduce((s, k) => s + hist[k], 0);
  let seen = 0;
  for (const k of keys) {
    seen += hist[k];
    if (seen >= q * n) return k * BUCKET_MS;
  }
  return null;
};

/** Merges the processes' results into one summary. */
export function summarise(parts, seconds) {
  const sum = { readers: 0, pointerReads: 0, partReads: 0, bytes: 0, headerBytes: 0, responses: 0, errors: 0, badChecksum: 0, noEtag: 0, late: 0 };
  const hist = {};
  const digests = {};
  const cache = {};
  const errorSamples = [];
  for (const p of parts) {
    for (const k of Object.keys(sum)) sum[k] += p[k];
    for (const [k, v] of Object.entries(p.hist)) hist[k] = (hist[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.digests)) digests[k] = [...new Set([...(digests[k] ?? []), ...v])];
    for (const [k, v] of Object.entries(p.cache)) cache[k] = (cache[k] ?? 0) + v;
    errorSamples.push(...p.errorSamples);
  }
  const numbers = Object.keys(digests).map(Number);
  return {
    ...sum, seconds, errorSamples: errorSamples.slice(0, 5), cache,
    partsSeen: numbers.length, partsWithTwoDigests: numbers.filter((n) => digests[n].length > 1).length,
    requestsPerReaderSecond: +((sum.pointerReads + sum.partReads) / sum.readers / seconds).toFixed(2),
    bytesPerReaderSecond: Math.round(sum.bytes / sum.readers / seconds),
    headerBytesPerResponse: Math.round(sum.headerBytes / Math.max(1, sum.responses)),
    delayMs: { p50: quantile(hist, 0.5), p90: quantile(hist, 0.9), p99: quantile(hist, 0.99), max: quantile(hist, 1) },
    lateShare: +(sum.late / Math.max(1, sum.partReads)).toFixed(5),
    digests,
  };
}

/** Runs `readers` readers across `procs` processes and returns the summary. */
export async function readers(bases, stream, count, seconds, procs = 1) {
  const slices = Array.from({ length: procs }, (_, p) => Array.from({ length: count }, (_, i) => i).filter((i) => i % procs === p));
  const parts = await Promise.all(slices.map((ids) => new Promise((ok, fail) => {
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, READERS_CHILD: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', ok);
    child.once('error', fail);
    child.send({ bases, stream, ids, total: count, seconds });
  })));
  return summarise(parts, seconds);
}

if (process.env.READERS_CHILD === '1') {
  process.once('message', async ({ bases, stream, ids, total, seconds }) => {
    process.send(await run(bases, stream, ids, total, seconds), () => process.exit(0));
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [bases, stream, count, seconds, procs = '1'] = process.argv.slice(2);
  if (!seconds) throw new Error('usage: node readers.mjs <base URL[,base URL…]> <stream path> <readers> <seconds> [processes]');
  const s = await readers(bases.split(','), stream, Number(count), Number(seconds), Number(procs));
  delete s.digests;
  console.log(`readers ${JSON.stringify(s)}`);
}
