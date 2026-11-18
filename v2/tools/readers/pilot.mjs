// One arm of the pilot (Engine v2 V2, #2711), all on this machine: V1's live world (`stream-check world`, even load)
// writes its stream; the origin serves it; <nodes> stand-in cache nodes (../origin/cache.mjs) sit in front; the check
// runs through the first node; then <readers> readers read for <seconds>, spread over the nodes. Prints one
// `pilot {json}` line: the readers' summary, the origin's requests per part and processor seconds, the nodes' counts.
// Usage: node pilot.mjs <stream-check binary> <work dir> <readers> <seconds> [nodes=2] [processes=4]
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { readers } from './readers.mjs';

const [bin, work, count, seconds, nodes = '2', procs = '4'] = process.argv.slice(2);
if (!seconds) throw new Error('usage: node pilot.mjs <stream-check binary> <work dir> <readers> <seconds> [nodes] [processes]');
const here = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(work, 'www'), { recursive: true, force: true });

/** Starts a child and resolves with it and the first line that starts with `prefix`. */
function start(cmd, args, prefix) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const wanted = new Map();
  lines.on('line', (l) => {
    for (const [p, ok] of wanted) if (l.startsWith(p)) { wanted.delete(p); ok(l.slice(p.length)); }
  });
  const line = (p) => new Promise((ok) => wanted.set(p, ok));
  return { child, line, first: line(prefix) };
}

async function stats(proc) {
  const s = proc.line('stats ');
  proc.child.kill('SIGTERM');
  return JSON.parse(await s);
}

const world = start(bin, ['world', work, String(Number(seconds) + 30), 'even'], 'stream ');
const stream = await world.first;
const origin = start(process.execPath, [join(here, '../origin/origin.mjs'), resolve(work, 'www')], 'origin ');
const originUrl = `http://127.0.0.1:${await origin.first}`;
const caches = [];
for (let i = 0; i < Number(nodes); i++) caches.push(start(process.execPath, [join(here, '../origin/cache.mjs'), originUrl], 'cache '));
const bases = [];
for (const c of caches) bases.push(`http://127.0.0.1:${await c.first}`);

const checked = await check(bases[0], stream);
const r = await readers(bases, stream, Number(count), Number(seconds), Number(procs));
const o = await stats(origin);
const nodeStats = [];
for (const c of caches) nodeStats.push(await stats(c));
world.child.kill('SIGTERM');

const digests = r.digests;
delete r.digests;
console.log(`pilot ${JSON.stringify({
  readers: Number(count), seconds: Number(seconds), nodes: Number(nodes),
  originRequestsPerPart: { max: o.perPartMax, mean: +o.perPartMean.toFixed(3), parts: o.parts },
  originPointerRequests: o.pointer, originMisses: o.miss, originCpuSeconds: +o.cpuSeconds.toFixed(3),
  partsChecksummed: Object.keys(digests).length, check: checked, readersSummary: r, nodeStats,
})}`);
process.exit(0);
