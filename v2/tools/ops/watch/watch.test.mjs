// The watcher (Engine v2 O15, #2808): node --test v2/tools/ops/watch/watch.test.mjs
// Real look servers on temporary worlds roots, real requests, the waits between looks skipped.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWorlds } from '../health/read.mjs';
import { look, serve } from './look.mjs';
import { run } from './watch.mjs';

const W = (n) => `00aa${n}-01-0`;

/** A worlds root with fake worlds: `set(world, {state, ticks, written, ageMs, oldestUs})` writes its files as O1 and O4 would. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'o15-'));
  for (const d of ['health', 'worlds', 'cache', 'directory/alarms']) mkdirSync(join(root, d), { recursive: true });
  const worlds = {};
  const write = (w) => {
    const s = worlds[w];
    writeFileSync(join(root, 'health', `${w}.json`), JSON.stringify({ state: s.state, count: s.starts ?? 1, failures: 0, last_exit: s.lastExit ?? null }));
    if (s.health === false) return;
    mkdirSync(join(root, 'worlds', w), { recursive: true });
    writeFileSync(join(root, 'worlds', w, 'health.json'), JSON.stringify({
      at_unix_ms: Date.now() - (s.ageMs ?? 0), written: s.written, budget_us: 50_000, ticks: { count: s.ticks },
      queues: { arrivals: { items: s.oldestUs ? 1 : 0, oldest_us: s.oldestUs ?? 0 } },
    }));
  };
  return {
    root,
    alarms: join(root, 'directory', 'alarms', 'local'),
    set(w, s) { worlds[w] = { written: 1, ticks: 1, ...worlds[w], ...s }; write(w); },
    /** One health write, as O4's thread does every 2 s; a ticking world counts 40 ticks meanwhile. */
    beat() {
      for (const [w, s] of Object.entries(worlds)) {
        if (s.health === false || s.frozen) continue;
        s.written += 1;
        if (!s.stalled) s.ticks += 40;
        write(w);
      }
    },
    sleep(w) { writeFileSync(this.alarms, `${w} 1900000000000000\n`); },
  };
}

async function instance(name, m) {
  const server = serve({ root: m.root, alarms: m.alarms, token: 'look-token', pause: async () => m.beat() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, inst: { name, url: `http://127.0.0.1:${port}/ops/watch`, token_env: 'LOOK_TOKEN' } };
}

const env = { LOOK_TOKEN: 'look-token' };

test('a look: down, stalled, lag, restart-loop; asleep and stopped are healthy; the last look reaches the page (A4)', async () => {
  const m = machine();
  m.set(W(1), { state: 'running' });
  m.set(W(2), { state: 'running', frozen: true, ageMs: 30_000 });          // killed and held down: no health written
  m.set(W(3), { state: 'running', stalled: true });                       // its clock stuck, its health thread alive
  m.set(W(4), { state: 'running', oldestUs: 9_000_000 });                  // an act waiting 9 s
  m.set(W(5), { state: 'restart-loop', starts: 5, lastExit: 'oom-kill', health: false });
  m.set(W(6), { state: 'stopped', frozen: true, ageMs: 600_000 });         // a planned stop
  m.set(W(7), { state: 'running', frozen: true, ageMs: 600_000 });         // gone to sleep: the directory says so
  m.sleep(W(7));
  const t = Date.now();
  const r = await look(m.root, { alarms: m.alarms, now: () => t, pause: async () => m.beat() });
  const trouble = Object.fromEntries(r.worlds.map((w) => [w.world, w.trouble]));
  assert.deepEqual(trouble, { [W(1)]: null, [W(2)]: 'down', [W(3)]: 'stalled', [W(4)]: 'lag', [W(5)]: 'restart-loop', [W(6)]: null, [W(7)]: null });
  assert.equal(r.worlds.find((w) => w.world === W(7)).state, 'asleep');
  assert.ok(readWorlds(m.root, t).every((row) => row.watcher === t), 'every row shows the last look');
});

test('no look wakes a world: no request is made and a sleeping world\'s files are left as they are (A3)', async () => {
  const m = machine();
  m.set(W(1), { state: 'stopped', frozen: true, ageMs: 600_000 });
  m.sleep(W(1));
  const dir = join(m.root, 'worlds', W(1));
  const before = readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs, readFileSync(join(dir, f), 'utf8')]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a look made a request'); };
  try {
    for (let i = 0; i < 3; i++) await look(m.root, { alarms: m.alarms, pause: async () => {} });
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs, readFileSync(join(dir, f), 'utf8')]), before);
  assert.equal(JSON.parse(readFileSync(join(m.root, 'health', `${W(1)}.json`), 'utf8')).state, 'stopped');
});

test('one message when a world is killed, its clock stalls or a machine is gone, one on recovery, none while down (A1)', async () => {
  const a = machine(), b = machine();
  a.set(W(1), { state: 'running' }); a.set(W(2), { state: 'running' }); b.set(W(3), { state: 'running' });
  const A = await instance('a', a), B = await instance('b', b);
  const sent = [], send = async (text) => (sent.push(text), true);
  const io = { sleep: async () => {}, env };
  let state = await run([A.inst, B.inst], {}, send, io);
  assert.deepEqual(sent, []);
  a.set(W(1), { frozen: true, ageMs: 30_000 });                 // killed and held down
  a.set(W(2), { stalled: true });                               // stalled clock
  B.server.close(); B.server.closeAllConnections();             // the whole instance unreachable
  state = await run([A.inst, B.inst], state, send, io);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /world 00aa1-01-0 on a: down: no health written for 30 s/);
  assert.match(sent[0], /world 00aa2-01-0 on a: stalled/);
  assert.match(sent[0], /instance b: unreachable/);
  state = await run([A.inst, B.inst], state, send, io);
  assert.equal(sent.length, 1, 'nothing while it stays down');
  a.set(W(1), { frozen: false, ageMs: 0 }); a.set(W(2), { stalled: false });
  const B2 = serve({ root: b.root, alarms: b.alarms, token: 'look-token', pause: async () => b.beat() });
  await new Promise((r) => B2.listen(B.port, '127.0.0.1', r));
  state = await run([A.inst, B.inst], state, send, io);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^Souls recovered:/);
  for (const c of ['world 00aa1-01-0 on a', 'world 00aa2-01-0 on a', 'instance b']) assert.ok(sent[1].includes(`- ${c} (down since`), c);
  assert.deepEqual(state.checks, {});
  A.server.close(); B2.close();
});

test('a deploy\'s restart, a planned stop and a sleeping world send nothing (A2)', async () => {
  const a = machine();
  a.set(W(1), { state: 'running' }); a.set(W(2), { state: 'running' }); a.set(W(3), { state: 'running' });
  const A = await instance('a', a);
  const sent = [], send = async (text) => (sent.push(text), true);
  let state = await run([A.inst], {}, send, { sleep: async () => {}, env });
  // A deploy restarts the world: its old health file is stale and the supervisor says restarting for the first look,
  // then the new process writes with its count from zero.
  a.set(W(1), { state: 'restarting', frozen: true, ageMs: 15_000 });
  let gap = 0;
  const restartAfterFirstLook = async () => { if (gap++ === 0) a.set(W(1), { state: 'running', frozen: false, ageMs: 0, ticks: 0, written: 1 }); };
  a.set(W(2), { state: 'stopped', frozen: true, ageMs: 120_000 });                  // a planned stop
  a.set(W(3), { state: 'stopped', frozen: true, ageMs: 120_000 }); a.sleep(W(3));   // gone to sleep
  state = await run([A.inst], state, send, { sleep: restartAfterFirstLook, env });
  assert.deepEqual(state.last.seen[`world ${W(1)} on a`].map((v) => v && v.split(':')[0]), ['down', null, null]);
  state = await run([A.inst], state, send, { sleep: async () => {}, env });
  assert.deepEqual(sent, []);
  assert.deepEqual(state.checks, {});
  A.server.close();
});

test('a message that is not delivered is sent again next run', async () => {
  const a = machine();
  a.set(W(1), { state: 'running', frozen: true, ageMs: 30_000 });
  const A = await instance('a', a);
  const tries = [];
  let state = await run([A.inst], {}, async (t) => (tries.push(t), false), { sleep: async () => {}, env });
  assert.deepEqual(state.checks, {});
  state = await run([A.inst], state, async (t) => (tries.push(t), true), { sleep: async () => {}, env });
  assert.equal(tries.length, 2); assert.equal(tries[0], tries[1]);
  assert.ok(state.checks[`world ${W(1)} on a`]);
  A.server.close();
});

test('a look without the watcher\'s token is refused', async () => {
  const A = await instance('a', machine());
  assert.equal((await fetch(A.inst.url)).status, 401);
  A.server.close();
});
