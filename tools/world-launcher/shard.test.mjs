// #2444 (docs/design/world-cost.md B5): the shard program under the launcher's ChildPool with SIM_SHARDS on. Real worlds
// (apps/server main.ts, fake minds) in one program:
//  A1 one world stops and loads again by message while the others run on, in the same program
//  A2 a fault in one world of a shard of 3 (the `stop` and `storm` kinds of #2366) ends the shard; every world reloads in
//     another program, exactly (its replay equals the durable clock frontier it left, the clock caught up), and ticks on;
//     the world that ended it reloads in a program of its own
//  A5 two worlds at different loads in one shard: a god edit in one leaves the other as it was, and each keeps its own
//     day, load level and state hash, saved and restored exactly
//  review (#2445) a world dropped while it loads (a handover's settle, a stalled boot, a stop past its grace) stops alone:
//     its program and the world beside it run on, and its next load is sent only once it has exited (one writer)
// On a failure the worlds' and shards' log tails are printed. The timings are printed as test diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as request_ } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ChildPool } from './children.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const root = new URL('../../', import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = { PATH: process.env.PATH, DEV_AUTH: '1', WORLD_OWNER_ID: 'dev:admin', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', ARCHIVE_TAKES: '0', HOST: '127.0.0.1',
  BUILD_ID: 'shard', SIM_FAULT_INJECT: '1', SIM_BOOT_HASH: '1', SEED_NATIVES: '0', ENGINE: 'mars', MIND_DRIVER: 'central', NODE_OPTIONS: '--max-old-space-size=1024', ENABLE_LIVING_WORLD: '1' };
// Eden core (worlds keyed eden): a durable clock frontier to compare a reload with. These are the program's settings: a
// shard holds only worlds whose settings are equal, so every world of a harness gets the same ones
const EDEN = { ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1', ENABLE_CLOSED_HUMAN_GOALS: '1', ENABLE_REGISTERED_HUMAN_ACTIVITIES: '1' };

/** A ChildPool with shards of `size` over worlds by slug: { slug: { key, env } }. */
function harness(t, { size, worlds, range, program = {}, options = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'shard-')), logDir = join(dir, 'logs'), frontiers = {};
  const dataDir = (slug) => join(dir, slug), worldId = (slug) => `shard-${slug}-20261115`;
  const pool = new ChildPool({ root, range, logDir, publicOrigin: 'http://127.0.0.1', healthPath: (s) => `/w/${s}/healthz`, shards: size, guard: { breakerN: 10, backoffCapMs: 2000 }, ...options,
    command: (w, port) => ({ cmd: process.execPath, args: ['apps/server/src/main.ts'], env: { ...BASE, ...program, ...worlds[w.slug].env, WORLD_KEY: worlds[w.slug].key, WORLD_ID: worldId(w.slug), WORLD_PATH: `/w/${w.slug}`,
      DATA_DIR: dataDir(w.slug), PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}/w/${w.slug}` } }),
    // the durable clock frontier each ended world left, read the moment the launcher saw it go (before its reload)
    onChange: (s) => { if (pool.status(s).status !== 'restarting') return; try { const db = new DatabaseSync(join(dataDir(s), 'sim.db'), { readOnly: true }); try { const r = db.prepare('SELECT body FROM clock_frontiers_v1 WHERE world_id=?').get(worldId(s)); (frontiers[s] ??= []).push(r ? JSON.parse(r.body) : null); } finally { db.close(); } } catch (e) { (frontiers[s] ??= []).push({ error: e.message }); } } });
  const log = (slug) => { try { return readFileSync(join(logDir, `${slug}.log`), 'utf8'); } catch { return ''; } };
  t.after(async () => {
    pool.stopGuard?.(); await pool.closeAll();
    if (process.env.SHARD_TEST_LOGS) for (const f of readdirSync(logDir)) t.diagnostic(`--- ${f}\n${readFileSync(join(logDir, f), 'utf8').slice(-4000)}`);
    if (!process.env.SHARD_TEST_LOGS) rmSync(dir, { recursive: true, force: true });
  });
  const url = (slug) => `http://127.0.0.1:${pool.status(slug).port}/w/${slug}`;
  return {
    pool, frontiers, log, url, dataDir, worldId,
    world: (slug) => ({ slug, dataDir: dataDir(slug) }),
    pid: (slug) => pool.status(slug).pid,
    health: async (slug) => (await fetch(`${url(slug)}/healthz`, { signal: AbortSignal.timeout(3000) })).json(),
    fault: (slug, kind) => new Promise((yes, no) => request_(`http://127.0.0.1:${pool.status(slug).port}/__sim/fault?kind=${kind}`, { method: 'POST', agent: false }, (r) => { r.resume(); r.on('end', () => yes(r.statusCode)); }).on('error', no).end()),
    look: (slug) => pool.shards.look(slug),
  };
}
/** Every named world running in a program other than the one it was in (pids), within `ms`. */
async function reloaded(h, pids, ms = 180_000) {
  const t0 = Date.now();
  for (;;) {
    if (Object.entries(pids).every(([s, p]) => { const st = h.pool.status(s); return st.status === 'running' && st.pid && st.pid !== p; })) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`not reloaded in ${ms / 1000} s: ${JSON.stringify(Object.fromEntries(Object.keys(pids).map((s) => [s, h.pool.status(s).status])))}`);
    await wait(50);
  }
}
const ticking = async (h, slug) => { const a = (await h.health(slug)).tick; await wait(400); const b = (await h.health(slug)).tick; assert.ok(b > a, `${slug} ticks on (${a} -> ${b})`); };

test('A1, A2: a shard of 3 loads and stops one world alone; a fault in one ends the shard and every world reloads exactly', { timeout: 900_000 }, async (t) => {
  const P0 = await testPort(8), say = (m) => t.diagnostic(m);
  const worlds = Object.fromEntries(['ea', 'eb', 'ec'].map((s) => [s, { key: 'eden', env: { SIM_HANG_KILL_MS: '10000' } }]));
  const h = harness(t, { size: 3, worlds, range: [P0, P0 + 7], program: EDEN });
  await Promise.all(Object.keys(worlds).map((s) => h.pool.ensure(h.world(s), { timeoutMs: 300_000 })));
  const pid0 = h.pid('ea');
  assert.ok(pid0 && h.pid('eb') === pid0 && h.pid('ec') === pid0, 'the three worlds are in one program');
  for (const s of Object.keys(worlds)) await ticking(h, s);
  // A1: one watchdog thread for the program: each world's live.json is written by it, with the program's pid
  for (const s of Object.keys(worlds)) assert.equal(JSON.parse(readFileSync(join(h.dataDir(s), 'live.json'), 'utf8')).pid, pid0, `${s}: watched in its program`);

  // A1: one world stops (its snapshot saved) and loads again by message; the others never stop ticking
  const before = { ea: (await h.health('ea')).tick, ec: (await h.health('ec')).tick };
  await h.pool.stop('eb');
  assert.equal(h.pool.status('eb').status, 'stopped');
  assert.match(h.log('eb'), /\[world\] SIGTERM: snapshot saved/);
  await wait(400);   // (a small world's stop can take less than one tick)
  for (const s of ['ea', 'ec']) { assert.equal(h.pid(s), pid0, `${s}: same program`); assert.ok((await h.health(s)).tick > before[s], `${s}: ticked on through the stop`); }
  await h.pool.ensure(h.world('eb'), { timeoutMs: 300_000 });
  assert.equal(h.pid('eb'), pid0, 'eb loads back into the same program');
  const [saved, restored] = [[...h.log('eb').matchAll(/\[world\] SIGTERM: state at tick (\d+): ([0-9a-f]+)/g)].at(-1), [...h.log('eb').matchAll(/\[boot\] state at tick (\d+): ([0-9a-f]+)/g)].at(-1)];
  assert.deepEqual(restored.slice(1), saved.slice(1), 'eb: restored the state it saved, exactly');
  await ticking(h, 'eb');

  // A2: a fault in one world (stop: a tick fault that stops its clock; storm: a step that throws every tick) ends the shard
  for (const [kind, culprit] of [['stop', 'ea'], ['storm', 'eb']]) {
    const pids = Object.fromEntries(Object.keys(worlds).map((s) => [s, h.pid(s)])), n0 = Object.fromEntries(Object.keys(worlds).map((s) => [s, h.frontiers[s]?.length ?? 0]));
    assert.equal(new Set(Object.values(pids)).size, 1, `${kind}: the three in one shard before the fault`);
    const t0 = Date.now();
    assert.equal(await h.fault(culprit, kind), 202);
    const ms = await reloaded(h, pids);
    for (const s of Object.keys(worlds)) {
      const exit = h.pool.status(s).lastExit, fr = h.frontiers[s]?.[n0[s]];
      assert.equal(exit?.code, s === culprit ? 70 : 75, `${kind}: ${s} exits ${s === culprit ? 'as the crash it was' : 'as a planned reload'}`);
      // exact: the reload's replay ends on the frontier the ended program left (the boot also checks the kernel hash and the log)
      assert.ok(fr && !fr.error, `${kind}: ${s}: a frontier was read`);
      const segment = h.log(s).split(/\n--- [^\n]* start /).at(-1), hash = [...segment.matchAll(/\[boot\] state at tick (\d+): ([0-9a-f]+)/g)].at(-1);
      assert.deepEqual([Number(hash?.[1]), hash?.[2]], [fr.tick, fr.engineHash], `${kind}: ${s}: restored exactly at the frontier`);
      assert.doesNotMatch(segment, /replay differs|clock-frontier\.|ticks still owed/, `${kind}: ${s}: no replay difference, no tick owed`);
      for (let i = 0; i < 1200 && !/\[clock\] caught up/.test(h.log(s).split(/\n--- [^\n]* start /).at(-1)); i++) await wait(100);
      await ticking(h, s);
    }
    assert.match(h.log(culprit), kind === 'stop' ? /world\.fault\.clock-stopped: exiting 70/ : /world\.fault\.storm: 50 faults in a minute/);
    const others = Object.keys(worlds).filter((s) => s !== culprit);
    assert.equal(h.pid(others[0]), h.pid(others[1]), `${kind}: the other two reload together`);
    assert.notEqual(h.pid(culprit), h.pid(others[0]), `${kind}: the world that ended the shard reloads in a program of its own`);
    say(`${kind} in ${culprit}: all three serving again in another program ${ms} ms after the fault (fault at ${t0})`);
    // the culprit joins the others again once it is stopped and loaded afresh (the shard of 3 for the next fault)
    await h.pool.stop(culprit);
    await h.pool.ensure(h.world(culprit), { timeoutMs: 300_000 });
    assert.equal(h.pid(culprit), h.pid(others[0]), `${kind}: ${culprit} back in the shard`);
  }
});

test('A5: two worlds at different loads in one shard keep their own edits, day, level and state', { timeout: 600_000 }, async (t) => {
  const P0 = await testPort(6);
  // two small worlds with the world engine and a living day; `edited` held at the red load level, `other` green
  const worlds = { edited: { key: 'edited', env: { SIM_LOAD_DRILL_LEVEL: 'red' } }, other: { key: 'other', env: {} } };
  const h = harness(t, { size: 2, worlds, range: [P0, P0 + 5] });
  await Promise.all(Object.keys(worlds).map((s) => h.pool.ensure(h.world(s), { timeoutMs: 300_000 })));
  assert.equal(h.pid('edited'), h.pid('other'), 'one program');
  const status = async (s) => (await fetch(`${h.url(s)}/v1/god/status`)).json();
  const [e0, d0] = [await status('edited'), await status('other')];

  // a god edit in one world
  const post = (s, path, body, token = 'dev:admin') => fetch(`${h.url(s)}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await post('edited', '/v1/god/claim', {})).status, 200);
  const { token } = (await post('edited', '/v1/god/mint', { label: 'shard-test' })).json;
  const act = await post('edited', '/v1/god/act', { ops: [{ op: 'place', def: 'core/bench@1', name: 'shard-bench', p: [100, 100] }] }, token);
  assert.equal(act.json.accepted, true, JSON.stringify(act.json).slice(0, 300));
  const [e1, d1] = [await status('edited'), await status('other')];
  assert.equal(e1.entities, e0.entities + 1, 'the edited world has the bench');
  assert.ok(e1.seq > e0.seq, 'and one more edit');
  assert.deepEqual([d1.entities, d1.seq, d1.hasOwner], [d0.entities, d0.seq, d0.hasOwner], 'the other world: no entity, no edit, no owner from it');

  // each its own load level, day and state
  // (every world boots red, its first ticks slow; the other then reads its own gauges and leaves red, while the edited
  // world is held there. Not green on a loaded machine: a world alone there sits at amber too)
  for (let i = 0; i < 120 && (await h.health('other')).load?.level === 'red'; i++) await wait(500);
  const [xe, xd] = [await h.look('edited'), await h.look('other')];
  assert.equal(xe.level, 'red', 'the edited world holds red');
  assert.notEqual(xd.level, 'red', `the other left red (${xd.level}): its own gauges`);
  assert.equal((await h.health('edited')).load?.level, 'red', 'and its /healthz says so');
  assert.notEqual(xe.stateHash, xd.stateHash);
  // each world's day is read from its own clock and its own day length, never from another world's
  for (const x of [xe, xd]) assert.equal(x.day, x.living ? Math.floor(Math.max(0, x.tick - x.living.origin) / x.living.dayTicks) : 0, `day ${JSON.stringify(x)}`);
  // stopped and loaded again, each restores exactly the state it saved
  for (const s of Object.keys(worlds)) {
    await h.pool.stop(s);
    await h.pool.ensure(h.world(s), { timeoutMs: 300_000 });
    const saved = [...h.log(s).matchAll(/\[world\] SIGTERM: state at tick (\d+): ([0-9a-f]+)/g)].at(-1), restored = [...h.log(s).matchAll(/\[boot\] state at tick (\d+): ([0-9a-f]+)/g)].at(-1);
    assert.deepEqual(restored.slice(1), saved.slice(1), `${s}: restored the state it saved`);
  }
  assert.equal(h.pid('edited'), h.pid('other'), 'back in one program');
  assert.equal((await status('edited')).entities, e1.entities, 'the bench is still there');
  assert.equal((await status('other')).entities, d0.entities, 'and still only there');
});

test('review: a world dropped while it loads stops alone; its program and the world beside it run on; one writer per data dir', { timeout: 600_000 }, async (t) => {
  const P0 = await testPort(6);
  const worlds = { stay: { key: 'stay', env: {} }, drop: { key: 'drop', env: {} } };
  // (a long drop grace: on a loaded machine a small world's boot can outlast the 3 s default, which would end the program)
  const h = harness(t, { size: 2, worlds, range: [P0, P0 + 5], options: { shardDropGraceMs: 300_000 } });
  await h.pool.ensure(h.world('stay'), { timeoutMs: 300_000 });
  const pid0 = h.pid('stay'), tick0 = (await h.health('stay')).tick;
  const boot = h.pool.ensure(h.world('drop'), { timeoutMs: 300_000 }).catch((e) => e);
  let first = null;
  for (let i = 0; i < 12_000 && !(first = h.pool.state('drop')?.child)?.pid; i++) await wait(5);
  assert.equal(first?.pid, pid0, 'drop loads into the program of stay');
  assert.equal(first.loaded, false, 'and is still loading');
  // a handover's prepare abandons the boot (SIGKILL, as healthy() and stopChild() send too)
  const settling = h.pool.settled({ waitMs: 0, goneMs: 300_000 });
  // a second load of the same data dir meanwhile is not sent to any program while the first may still write
  const port = h.pool.state('drop').port;
  const load = () => { const x = h.pool.shards.spawn('drop', h.pool.o.command(h.world('drop'), port)); x.stdout.resume(); x.stderr.resume(); return x; };
  const second = load();
  assert.equal(second.pid, undefined, 'the second load waits for the first to exit');
  // the waiting second load is given up before the first has exited: a third still waits for the first
  second.kill('SIGTERM'); await once(second, 'exit');
  assert.ok(first.exitCode === null && first.signalCode === null, 'the first is still loading');
  const again = load();
  assert.equal(again.pid, undefined, 'the third load waits for the first too (one writer per data dir)');
  const abandoned = await settling;
  assert.deepEqual(abandoned.map((b) => b.slug), ['drop']);
  assert.ok(first.exitCode !== null || first.signalCode !== null, 'the dropped world exited');
  assert.match(h.log('drop'), /\[world\] SIGTERM: snapshot saved/, 'it ended its boot and stopped, saving its snapshot');
  assert.equal(second.pid, undefined, 'the given-up load was never sent');
  assert.equal(again.pid, pid0, 'then the third load went to the program, which ran on');
  assert.equal(h.pid('stay'), pid0, 'stay: the same program');
  assert.ok((await h.health('stay')).tick > tick0, 'stay: ticked on through the drop');
  for (let i = 0; i < 6000 && !again.loaded; i++) await wait(50);
  assert.ok(again.loaded, 'the third load served');
  again.kill('SIGTERM'); await once(again, 'exit');
  assert.equal(again.exitCode, 0);
  assert.equal(h.pid('stay'), pid0); await ticking(h, 'stay');
  await boot;
});
