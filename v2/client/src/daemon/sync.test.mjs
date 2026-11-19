// An Eden-sized copy (Engine v2 C11, #3424): the daemon's first sync of a scope of 30,000 records through the real
// gateway (`gatewayd`) from `worldd gateway-link`, then a restart that signs in again from its cursor. One room holds
// them all, so its record (each child's hash, 36 bytes each) is 1.08 MB: over both limits C11 lifted, the gateway's
// 64 KiB to its sockets (1006 mid-sync at about 1,800 children) and the world link's 1 MiB ("a frame from the world
// was too long", which Eden's 5.4 MB open ground also met). Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// C11_REPORT=1 prints the sync's time and the daemon's memory, for the PR.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request, start } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_c11test';
const ITEMS = 30_000;
const SCOPE = '2b'.repeat(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-c11-'));
const home = join(dir, '.souls');
const token = `soul-${SCOPE}-2.${randomBytes(32).toString('hex')}`; // the world's first body
const procs = [];
let rt, gatewayOut = '';

function tails() {
  let daemon = '';
  try { daemon = readFileSync(rt.log, 'utf8'); } catch { /* not started yet */ }
  return `daemon.log:\n${daemon.split('\n').slice(-30).join('\n')}\ngatewayd:\n${gatewayOut.split('\n').slice(-20).join('\n')}`;
}

async function waitFor(f, ms) {
  const until = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await f(); } catch { /* the daemon not listening yet */ }
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out\n${tails()}`);
    await sleep(20);
  }
}

const credentials = () => {
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
};
const status = () => request(rt.socket, { op: 'status' });
const current = () => waitFor(async () => { const s = await status(); return s.connected && !s.syncing && s; }, 60_000);

after(async () => {
  if (rt) await request(rt.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); // the stopped daemon may still be closing its files
});

test('C11 A2, A3: a first sync of 30,000 records completes; it emits synced, which wakes no wait; a restart resumes', async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `soul-${SCOPE}-2 ${createHash('sha256').update(token).digest('hex')}\n`);
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--rooms', '1', '--bodies', '50', '--items', String(ITEMS),
    // A debug build answers an Eden-sized sync slowly: K18's watchdog is given room for it.
    '--watchdog-ms', '10000'], { stdio: 'ignore' }));
  await waitFor(() => statSync(world).isSocket(), 30_000);
  const g = spawn(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(g);
  const addr = await new Promise((ok) => {
    g.stdout.on('data', (d) => { gatewayOut += d; const m = /listening (\S+)\n/.exec(gatewayOut); if (m) ok(m[1]); });
    g.stderr.on('data', (d) => { gatewayOut += d; });
  });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { gateway: `ws://${addr}/v2/ws` } } }));
  credentials();
  rt = runtimeOf(home, SOUL);

  // A2: the first sync takes the whole scope on one socket, with no drop.
  const t0 = performance.now();
  start(home, SOUL, PKG);
  const s = await current();
  const ms = Math.round(performance.now() - t0);
  const sync = s.syncs.at(-1);
  assert.equal(sync.kind, 'snapshot');
  assert.ok(sync.held > ITEMS, `held ${sync.held} records`);
  assert.equal(s.drops, 0, tails());
  assert.equal(s.connects, 1);

  // A3: the sync is an event of its own kind, `synced`, and a wait is not woken by it.
  const w = await request(rt.socket, { op: 'wait', seconds: 1 });
  assert.equal(w.timedOut, true, JSON.stringify(w.events));
  assert.deepEqual(w.events.map((e) => [e.kind, e.sync]), [['synced', 'snapshot']]);

  // A2: a later sign-in resumes, with no sync-missing. The Soul acts once first, so the gateway keeps a frame for
  // it to resume after (a grant it has sent nothing is told stream.cannot-resume, I1). A new process holds no copy, so
  // it takes the scope again, on one socket.
  await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: `${SCOPE}-3` });
  await waitFor(async () => (await status()).answered === 1, 10_000);
  await request(rt.socket, { op: 'stop' });
  await waitFor(async () => { try { await status(); return false; } catch { return true; } }, 5000);
  credentials();
  start(home, SOUL, PKG);
  const again = await current();
  assert.equal(again.resumed, 1, tails());
  assert.equal(again.cannotResume, 0);
  assert.equal(again.drops, 0, tails());
  assert.deepEqual(again.syncs.map((x) => [x.kind, x.held]), [['snapshot', sync.held]]);
  assert.deepEqual(Object.keys(again.roots), Object.keys(s.roots)); // the same scope (its hash moved: the lamp is on)
  assert.doesNotMatch(readFileSync(rt.log, 'utf8'), /sync-missing|frame refused/);
  if (process.env.C11_REPORT) {
    console.log(JSON.stringify({ items: ITEMS, firstSyncMs: ms, sync, rssMB: Math.round(s.rssBytes / 1e6), heapMB: Math.round(s.heapBytes / 1e6) }));
  }
});
