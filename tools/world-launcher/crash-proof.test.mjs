// #2366: a real world (apps/server main.ts, fake minds, Eden core with its durable clock) under the launcher's ChildPool,
// failing on purpose (SIM_FAULT_INJECT=1). A1: an error in a tick, a timer, a promise or a request handler is logged by
// name and the same process keeps ticking. A2/A3: a hang or a memory runaway ends in its watchdog's kill and the
// launcher's restart; measured from the fault to serving again, and the restart is exact: every accepted event kept,
// the replayed engine and kernel hashes equal to the live world's durable clock frontier, the clock caught up.
// The timings are printed as test diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as request_ } from 'node:http';
import { ChildPool } from './children.mjs';
import { Db } from '../../apps/server/src/db.ts';
import { testPort } from '../../apps/server/test/test-port.ts';

const P0 = await testPort(6), root = new URL('../../', import.meta.url).pathname, main = new URL('../../apps/server/src/main.ts', import.meta.url).pathname;
const WORLD = 'crash-proof-20261114';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a world survives its own errors, and comes back exactly from a hang and a memory runaway', { timeout: 600_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crash-proof-')), dataDir = join(dir, 'data'), logDir = join(dir, 'logs');
  const env = (port) => ({ PATH: process.env.PATH, DATA_DIR: dataDir, WORLD_KEY: 'eden', WORLD_ID: WORLD, WORLD_PATH: '/w/eden', ENGINE: 'mars', ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1',
    ENABLE_CLOSED_HUMAN_GOALS: '1', ENABLE_REGISTERED_HUMAN_ACTIVITIES: '1', ENABLE_LIVING_WORLD: '1', SEED_NATIVES: '0', DEV_AUTH: '1', WORLD_OWNER_ID: 'dev:admin', MIND_DRIVER: 'central',
    BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', ARCHIVE_TAKES: '0', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}/w/eden`, BUILD_ID: 'crash-proof',
    SIM_FAULT_INJECT: '1', SIM_BOOT_HASH: '1', NODE_OPTIONS: '--max-old-space-size=768', SIM_HANG_KILL_MS: '5000', SIM_HEAP_KILL_MS: '2000', SIM_STALL_STACK_MS: '1000' });
  const frontiers = [];
  // (five restarts in a row here: the breaker and the backoff are widened, so the test sees each restart, not the hold)
  const pool = new ChildPool({ root, range: [P0, P0 + 5], logDir, publicOrigin: 'http://127.0.0.1', healthPath: () => '/w/eden/healthz', guard: { breakerN: 10, backoffCapMs: 2000 },
    command: (w, port) => ({ cmd: process.execPath, args: [main], env: env(port) }),
    // the durable clock frontier the killed process left, read the moment the launcher saw it exit (before the restart)
    onChange: (slug) => { const s = pool.status(slug).status; if (s === 'restarting') try { const db = new Db(join(dataDir, 'sim.db')); try { frontiers.push(JSON.parse(db.db.prepare('SELECT body FROM clock_frontiers_v1 WHERE world_id=?').get(WORLD).body)); } finally { db.close(); } } catch (e) { frontiers.push({ error: e.message }); } } });
  const world = { slug: 'eden', dataDir };
  t.after(async () => { await pool.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const log = () => readFileSync(join(logDir, 'eden.log'), 'utf8');
  const base = () => `http://127.0.0.1:${pool.status('eden').port}`;
  const health = async () => (await fetch(`${base()}/w/eden/healthz`, { signal: AbortSignal.timeout(2000) })).json();
  // a fresh connection each time (a kept-alive one the world has just closed would reset the request)
  const fault = (kind) => new Promise((yes, no) => request_(`${base()}/__sim/fault?kind=${kind}`, { method: 'POST', agent: false }, (r) => { r.resume(); r.on('end', () => yes({ status: r.statusCode })); }).on('error', (e) => no(new Error(`fault ${kind}: ${e.message}`))).end());
  const pid = () => pool.status('eden').pid;
  const say = (m) => t.diagnostic(m);

  await pool.ensure(world);
  const pid0 = pid();

  // A1: each kind of thrown error, the same process ticking on
  // (a listener's afterTick that throws is its own step: world.fault.step, named, and the rest of the tick runs on)
  for (const [kind, name] of [['tick', 'world.fault.step'], ['timer', 'world.fault.uncaught'], ['rejection', 'world.fault.rejection'], ['request', 'world.fault.request']]) {
    const before = (await health()).tick, r = await fault(kind);
    assert.equal(r.status, kind === 'request' ? 500 : 202, kind);
    await wait(300);
    const after = await health();
    assert.ok(after.tick > before, `${kind}: still ticking (${before} -> ${after.tick})`);
    assert.equal(pid(), pid0, `${kind}: the same process`);
    assert.match(log(), new RegExp(`\\[world\\] fault ${name.replace(/\./g, '\\.')}${kind === 'tick' ? ' in afterTick [0-9a-f]{8} \\(.*\\) at tick \\d+' : ''} \\(\\d+ in 60 s\\): Error: injected ${kind} fault`), kind);
  }
  assert.deepEqual(Object.keys((await health()).faults ?? {}).sort(), ['world.fault.rejection', 'world.fault.request', 'world.fault.step', 'world.fault.uncaught'], 'healthz counts the faults by name');

  // an accepted act before the failures: a Soul created through its lifecycle (logged before it is answered)
  const request = (path, owner, data) => fetch(`${base()}/w/eden${path}`, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer dev:${owner}`, ...(data ? { 'content-type': 'application/json' } : {}), 'X-Sim-Lifecycle': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) })
    .then(async (r) => { const text = await r.text(); return { status: r.status, json: () => JSON.parse(text) }; });   // (every body read: an unread one fails later, when its world is killed)
  const { code } = (await request('/v1/admin', 'admin', { action: 'invite', uses: 1 })).json();
  assert.equal((await request('/v1/invite', 'alice', { code })).status, 200);
  const created = await request('/v1/souls', 'alice', { name: 'Alice', description: 'crash-proof fixture' });
  assert.equal(created.status, 202); const { lifecycle } = created.json();
  let admitted = false;
  for (let i = 0; i < 600 && !admitted; i++) { const r = await request(`/v1/lifecycle/${lifecycle.requestId}`, 'alice'); admitted = r.status === 200 && r.json().lifecycle?.ready === true; if (!admitted) await wait(50); }
  assert.ok(admitted, 'the Soul is admitted before the faults');

  // A2 hang, A3 a runaway in one turn (alloc) and a heap that grows across turns (leak); a tick fault that stops the clock
  // (stop) and a step that throws on every tick (storm): each ends as a crash (exit 70) the breaker counts, restarted exactly
  for (const kind of ['hang', 'alloc', 'leak', 'stop', 'storm']) {
    const db = new Db(join(dataDir, 'sim.db')), events = JSON.stringify(db.events(WORLD)); db.close();
    const n0 = frontiers.length, pidBefore = pid(), t0 = Date.now();
    assert.equal((await fault(kind)).status, 202);
    let killedAt = null;
    for (let i = 0; i < 3600; i++) { const s = pool.status('eden'); if (!killedAt && s.pid !== pidBefore) killedAt = Date.now(); if (s.status === 'running' && s.pid && s.pid !== pidBefore) break; await wait(50); }
    const back = Date.now(); const h = await health();
    assert.notEqual(pid(), pidBefore, `${kind}: restarted`);
    const exit = pool.status('eden').lastExit;
    // exact: every event logged before the fault is there, in order; the boot verified its replay against the frontier
    const db2 = new Db(join(dataDir, 'sim.db')); assert.equal(JSON.stringify(db2.events(WORLD)).slice(0, events.length - 1), events.slice(0, -1), `${kind}: the log prefix is kept`);
    assert.ok(db2.soul(lifecycle.soulId), `${kind}: the accepted Soul is kept`); db2.close();
    const fr = frontiers[n0], hashes = [...log().matchAll(/\[boot\] state at tick (\d+): ([0-9a-f]+)/g)].at(-1);
    assert.ok(fr, `${kind}: a frontier was read`);
    assert.equal(Number(hashes[1]), fr.tick, `${kind}: the boot restored the frontier tick`);
    assert.equal(hashes[2], fr.engineHash, `${kind}: the restored engine state is the live world's at the frontier`);
    assert.doesNotMatch(log(), /replay differs|clock-frontier\./, `${kind}: no replay difference`);
    // the clock: what this boot owed the wall and what it ran (#2235's catch-up), as the boot logged it once done
    const segment = () => log().split(/\n--- [^\n]* start eden /).at(-1);
    for (let i = 0; i < 1200 && !/\[clock\] caught up/.test(segment()); i++) await wait(100);
    const caught = [...segment().matchAll(/\[clock\][^\n]*/g)].map((m) => m[0]).join(' | ');
    say(`${kind}: fault -> process gone ${killedAt ? killedAt - t0 : '?'} ms, -> serving again ${back - t0} ms; exit ${exit?.signal ?? exit?.code} (${exit?.reason ?? 'no reason'}); frontier tick ${fr.tick}, now tick ${h.tick}; ${caught}`);
    if (kind === 'hang') assert.match(exit?.reason ?? '', /wedged: main thread stuck \d+ s \(its watchdog ended it\)/);
    if (kind === 'stop' || kind === 'storm') {
      assert.equal(exit?.code, 70, `${kind}: a crash exit, not the planned 75`);
      assert.match(log(), kind === 'stop' ? /\[world\] world\.fault\.clock-stopped: exiting 70/ : /\[world\] world\.fault\.storm: 50 faults in a minute \(step fault-inject storm, 50 faults, ticks \d+\.\.\d+\): exiting 70/);
      assert.equal(JSON.parse(readFileSync(join(dataDir, 'fault-exit.json'), 'utf8')).reason.split(':')[0], kind === 'stop' ? 'world.fault.clock-stopped' : 'world.fault.storm');
    }
  }
  assert.match(log(), /\[load\] watchdog: world\.killed\.hang: main thread stuck \d+ s/);
});
