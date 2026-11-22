// A stopped daemon leaves its Soul's home removable (#3960, #3929 flakes): `{"op":"stop"}` answers only once nothing
// more is written into the home, so `souls retire` or a test can remove it the moment the answer arrives. No gateway
// is needed: the daemon's gateway refuses, so it keeps logging its reconnects, a writer that runs until it stops.
// Run from v2/ with replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_PKG, request, start } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';

const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_stoptest';
const ROUNDS = Number(process.env.STOP_ROUNDS ?? 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'souls-stop-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = [];

after(() => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root` with its size and change time: what a writer would change. */
function snapshot(root) {
  const out = {};
  for (const name of readdirSync(root, { recursive: true }).sort()) {
    const s = statSync(join(root, name), { throwIfNoEntry: false });
    if (s) out[name] = `${s.size} ${s.mtimeMs}`;
  }
  return out;
}

function makeHome(n) {
  const home = join(dir, `h${n}`, '.souls');
  mkdirSync(home, { recursive: true });
  // A gateway on a port nothing listens on: the daemon reconnects and logs each attempt while it runs.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: 'ws://127.0.0.1:1/v2/ws' } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token: `soul-${'5d'.repeat(16)}-2.${randomBytes(32).toString('hex')}` } } } }), { mode: 0o600 });
  return home;
}

test('stop answers only after its last write: the home is removed at once, every round, and nothing changes after', async () => {
  for (let n = 0; n < ROUNDS; n++) {
    const home = makeHome(n), rt = runtimeOf(home, SOUL);
    const pid = start(home, SOUL, PKG);
    pids.push(pid);
    for (const until = Date.now() + 20_000; ;) {
      const s = await request(rt.socket, { op: 'status' }, 1000).catch(() => null);
      if (s?.pid === pid) break;
      assert.ok(Date.now() < until && alive(pid), `round ${n}: the daemon did not answer`);
      await sleep(20);
    }
    await sleep(n % 4 * 25); // stop at different points of its reconnect loop
    const said = await request(rt.socket, { op: 'stop' });
    assert.equal(said.ok, true, JSON.stringify(said));
    // The answer means done: what is in the home now is what stays, through the process's end.
    const at = snapshot(home);
    for (const until = Date.now() + 5000; alive(pid);) {
      assert.ok(Date.now() < until, `round ${n}: the daemon did not end after its stop answer`);
      await sleep(5);
    }
    assert.deepEqual(snapshot(home), at, `round ${n}: the home changed after stop answered`);
    assert.equal(at['souls/s_stoptest/runtime/daemon.lock'], undefined, 'the lock is released before the answer');
    rmSync(join(dir, `h${n}`), { recursive: true }); // as `souls retire` or a test's teardown: no force, no retry
  }
});
