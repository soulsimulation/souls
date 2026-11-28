// N12: a first sync with many records requests in flight, through the real gateway (`gatewayd`) from `worldd
// gateway-link`, over a link with a round trip (a proxy that holds every chunk 20 ms each way), cut once mid-sync.
// The daemon keeps up to 16 requests out (`SYNC_WINDOW`); after the cut it signs in again and resumes: what the cut
// sync took is taken again without being asked for (`reused`), the rest is fetched, and no record is copied twice
// (`fetched + reused` is the scope). Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request, start } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { stopAll } from '../../../tools/teardown/stop.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_n12test';
const ITEMS = 6_000;
const SCOPE = '2c'.repeat(16);
const HALF_MS = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-n12-'));
const home = join(dir, '.souls');
const token = `soul-${SCOPE}-2.${randomBytes(32).toString('hex')}`; // the world's first body
const procs = [];
let rt, proxy;

async function waitFor(f, ms) {
  const until = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await f(); } catch { /* the daemon not listening yet */ }
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out\n${(() => { try { return readFileSync(rt.log, 'utf8').split('\n').slice(-30).join('\n'); } catch { return ''; } })()}`);
    await sleep(20);
  }
}

/** One direction of a connection: each chunk written HALF_MS after it arrived, in order; `onChunk` sees its size. */
function delayed(from, to, onChunk = () => {}) {
  const q = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    while (q.length && q[0].at <= now) to.write(q.shift().chunk);
    if (q.length) timer = setTimeout(pump, Math.max(0, q[0].at - now));
  };
  from.on('data', (chunk) => { onChunk(chunk.length); q.push({ at: performance.now() + HALF_MS, chunk }); timer ??= setTimeout(pump, HALF_MS); });
  from.on('error', () => to.destroy());
}

after(async () => {
  if (rt) await request(rt.socket, { op: 'stop' }).catch(() => {});
  proxy?.close();
  await stopAll(procs);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

test('N12: a first sync keeps many requests in flight; a connection dropped mid-sync resumes and copies each record once', async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `soul-${SCOPE}-2 ${createHash('sha256').update(token).digest('hex')}\n`);
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--rooms', '1', '--bodies', '50', '--items', String(ITEMS), '--watchdog-ms', '10000'], { stdio: 'ignore' }));
  await waitFor(() => statSync(world).isSocket(), 30_000);
  const g = spawn(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(g);
  let gatewayOut = '';
  const addr = await new Promise((ok) => {
    g.stdout.on('data', (d) => { gatewayOut += d; const m = /listening (\S+)\n/.exec(gatewayOut); if (m) ok(m[1]); });
    g.stderr.on('data', (d) => { gatewayOut += d; });
  });
  // The first connection is cut once the gateway has sent it about half the scope's bytes, mid-sync.
  const [gh, gp] = addr.split(':');
  let connections = 0;
  proxy = createServer((c) => {
    const mine = ++connections;
    const u = connect(Number(gp), gh);
    let down = 0;
    delayed(c, u);
    delayed(u, c, (n) => { down += n; if (mine === 1 && down > 400_000) { c.destroy(); u.destroy(); } });
    c.on('close', () => u.destroy()); u.on('close', () => c.destroy());
  });
  await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { gateway: `ws://127.0.0.1:${proxy.address().port}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);

  start(home, SOUL, PKG);
  const s = await waitFor(async () => { const x = await request(rt.socket, { op: 'status' }); return x.connected && !x.syncing && x.syncs.length > 0 && x; }, 120_000);
  assert.ok(connections >= 2 && s.drops >= 1, `the first connection was cut mid-sync: ${connections} connections, ${s.drops} drops`);
  const sync = s.syncs.at(-1);
  assert.equal(s.syncs.length, 1, 'the cut sync never finished');
  assert.equal(sync.kind, 'snapshot');
  assert.ok(sync.held > ITEMS, `held ${sync.held}`);
  assert.equal(sync.inFlight, 16, 'many requests in flight');
  assert.ok(sync.reused > 0, `the cut sync's records were taken again without asking: ${JSON.stringify(sync)}`);
  assert.equal(sync.fetched + sync.reused, sync.held, `each record copied once: ${JSON.stringify(sync)}`);
  assert.doesNotMatch(readFileSync(rt.log, 'utf8'), /sync-missing|sync refused|agent\.slow-down/);
});
