// #3706 (today's `--key`): a write sent again with the same key is one write, against the real gateway (`gatewayd`)
// and the world's end of it (`worldd gateway-link`), through the thin command as a harness runs it. The repeat sends
// nothing and answers with the first answer and, once the world answered, its receipt; that holds across a daemon
// restart. Run from v2/ after `cargo build -p gatewayd -p worldd --locked`, with replica's wasm-bindgen package in
// target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const CLI = join(v2, 'client/src/cli/souls.mjs');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_keytest';
const WORLD_SCOPE = '2b'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`; // the Soul's own lamp (daemon.test.mjs says why)
const GRANT = `soul-${WORLD_SCOPE}-2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-key-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const procs = [];
let rt;

async function waitFor(f, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

const ask = (req, ms = 5000) => request(rt.socket, req, ms);
const souls = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
};
const arrivals = () => { try { return readFileSync(join(dir, 'world', 'arrivals.txt'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  const wl = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4'], { stdio: 'ignore' });
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const gw = spawn(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(gw);
  const gateway = await new Promise((ok) => { let out = ''; gw.stdout.on('data', (d) => { out += d; const m = /listening (\S+)\n/.exec(out); if (m) ok(m[1]); }); });
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected);
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  await stopThenRemove(procs, dir);
});

test('#3706 A1: a command sent twice with the same --key is one write; the second time answers with the first receipt', async () => {
  const before = { sent: (await ask({ op: 'status' })).sent, arrived: arrivals() };
  const first = souls('act', `r2:switch_on:${LAMP}`, '--key', 'lamp-on-1');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.repeat, undefined);
  await waitFor(() => arrivals() > before.arrived);
  // The world's answer is kept with the key: a retry once it came gets it.
  const again = await waitFor(() => { const a = souls('act', `r2:switch_on:${LAMP}`, '--key', 'lamp-on-1'); return a.receipt && a; });
  assert.deepEqual([again.ok, again.repeat, again.sent, again.sequence], [true, true, false, first.sequence], JSON.stringify(again));
  assert.equal(again.receipt.answer, 1, `the first receipt: ${JSON.stringify(again.receipt)}`);
  await sleep(300);
  assert.equal((await ask({ op: 'status' })).sent, before.sent + 1, 'one intent sent');
  assert.equal(arrivals(), before.arrived + 1, 'one reached the world');
  // Two at once with one key: one write.
  const [a, b] = await Promise.all([ask({ op: 'act', verb: 'r2:switch_off', target: LAMP, key: 'off-1' }), ask({ op: 'act', verb: 'r2:switch_off', target: LAMP, key: 'off-1' })]);
  assert.equal(a.sequence, b.sequence, 'the same write');
  assert.equal([a, b].filter((x) => x.repeat).length, 1);
  // A new key is a new write; a key is refused on a read, and outside today's limits.
  const other = souls('act', `r2:switch_on:${LAMP}`, '--key', 'lamp-on-2');
  assert.notEqual(other.sequence, first.sequence);
  assert.equal(souls('look', '--key', 'k').code, 'key-not-a-write');
  assert.equal(souls('act', `r2:switch_on:${LAMP}`, '--key', 'x'.repeat(101)).code, 'key-form');
  // Across a restart of the daemon: still the first answer, nothing sent.
  await ask({ op: 'stop' });
  await waitFor(() => !existsSync(rt.lock));
  const arrived = arrivals();
  const after = souls('act', `r2:switch_on:${LAMP}`, '--key', 'lamp-on-1');
  assert.deepEqual([after.repeat, after.sequence, after.receipt?.answer], [true, first.sequence, 1], JSON.stringify(after));
  await sleep(500);
  assert.equal(arrivals(), arrived, 'nothing reached the world');
});
