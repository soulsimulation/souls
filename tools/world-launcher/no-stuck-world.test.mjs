// #2378: no stuck world. Real worlds (apps/server main.ts, fake minds) under the launcher's ChildPool and its guard, failing
// on purpose (SIM_FAULT_INJECT=1), one test per freeze cause the crash-proofing of #2366 left:
//  1 invariant corruption: a Soul's body broken in memory is quarantined and the same process runs on
//  2 a restart loop (A2): a step that hangs on every boot (on a durable-clock world, one tick later each boot) is
//    quarantined by its stable identity on the third boot, for a window of ticks
//  3 a database wait: another process holds the write lock; the world's write waits its limit, halts by name, and the
//    launcher restarts it once the lock is gone, exactly
//  4 a disk under its headroom: an alert in the log, a prune by the retention rules (no more), and the world runs on
// (5, a launcher hold that never ends, is guard.test.mjs (c2, c3).) On a failure the world's log tail is printed. The timings are printed as test diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as request_ } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ChildPool } from './children.mjs';
import { Db } from '../../apps/server/src/db.ts';
import { testPort } from '../../apps/server/test/test-port.ts';

const P0 = await testPort(12), root = new URL('../../', import.meta.url).pathname, main = new URL('../../apps/server/src/main.ts', import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = { PATH: process.env.PATH, DEV_AUTH: '1', WORLD_OWNER_ID: 'dev:admin', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', ARCHIVE_TAKES: '0', HOST: '127.0.0.1', BUILD_ID: 'no-stuck',
  SIM_FAULT_INJECT: '1', SIM_BOOT_HASH: '1', SIM_HANG_KILL_MS: '3000', SIM_STALL_STACK_MS: '1000', SEED_NATIVES: '0' };

function harness(t, { slug, worldId, env, range, guard }) {
  const dir = mkdtempSync(join(tmpdir(), `no-stuck-${slug}-`)), dataDir = join(dir, 'data'), logDir = join(dir, 'logs');
  const frontiers = [];
  const pool = new ChildPool({ root, range, logDir, publicOrigin: 'http://127.0.0.1', healthPath: () => `/w/${slug}/healthz`, guard,
    command: (w, port) => ({ cmd: process.execPath, args: [main], env: { ...base, ...env, DATA_DIR: dataDir, WORLD_KEY: slug, WORLD_ID: worldId, WORLD_PATH: `/w/${slug}`, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}/w/${slug}` } }),
    // the durable clock frontier the ended process left, read the moment the launcher saw it go (before the restart)
    onChange: (s) => { if (pool.status(s).status !== 'restarting') return; try { const db = new DatabaseSync(join(dataDir, 'sim.db'), { readOnly: true }); try { const r = db.prepare('SELECT body FROM clock_frontiers_v1 WHERE world_id=?').get(worldId); frontiers.push(r ? JSON.parse(r.body) : null); } finally { db.close(); } } catch (e) { frontiers.push({ error: e.message }); } } });
  t.after(async () => { pool.stopGuard(); await pool.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${pool.status(slug).port}`;
  const h = {
    dataDir, frontiers, pool, world: { slug, dataDir },
    log: () => { try { return readFileSync(join(logDir, `${slug}.log`), 'utf8'); } catch { return ''; } },
    pid: () => pool.status(slug).pid,
    health: async () => (await fetch(`${url()}/w/${slug}/healthz`, { signal: AbortSignal.timeout(3000) })).json(),
    fault: (q) => new Promise((yes, no) => request_(`${url()}/__sim/fault?${q}`, { method: 'POST', agent: false }, (r) => { r.resume(); r.on('end', () => yes(r.statusCode)); }).on('error', no).end()),
    request: (path, owner, data) => fetch(`${url()}/w/${slug}${path}`, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer dev:${owner}`, ...(data ? { 'content-type': 'application/json' } : {}), 'X-Sim-Lifecycle': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) })
      .then(async (r) => { const text = await r.text(); return { status: r.status, json: () => JSON.parse(text) }; }),
    events: () => { const db = new Db(join(dataDir, 'sim.db')); try { return JSON.stringify(db.events(worldId)); } finally { db.close(); } },
    /** Wait for a process other than `pid` to be running; the time it was gone and the time it served again. */
    back: async (pid, t0, ms = 180_000) => { let goneAt = null; for (const end = Date.now() + ms; Date.now() < end;) { const s = pool.status(slug); if (!goneAt && s.pid !== pid) goneAt = Date.now(); if (s.status === 'running' && s.pid && s.pid !== pid) return { gone: goneAt - t0, serving: Date.now() - t0 }; await wait(50); } throw new Error(`${slug}: not serving again in ${ms} ms`); },
  };
  return h;
}
/** Run `body`; on a failure print the world's log tail first, so a failure in CI says what the world did. */
async function withLogTail(h, body) {
  try { await body(); } catch (e) { console.error(`--- the world's log, last 80 lines:\n${h.log().split('\n').slice(-80).join('\n')}`); throw e; }
}
async function admitSoul(h) {
  const { code } = (await h.request('/v1/admin', 'admin', { action: 'invite', uses: 1 })).json();
  assert.equal((await h.request('/v1/invite', 'alice', { code })).status, 200);
  const created = await h.request('/v1/souls', 'alice', { name: 'Alice', description: 'no-stuck fixture' });
  assert.equal(created.status, 202); const { lifecycle } = created.json();
  for (let i = 0; i < 600; i++) { const r = await h.request(`/v1/lifecycle/${lifecycle.requestId}`, 'alice'); if (r.status === 200 && r.json().lifecycle?.ready === true) return lifecycle.soulId; await wait(50); }
  throw new Error('the Soul was not admitted');
}

test('causes 1, 3, 4 on an Eden core world: corruption quarantined in place, a held database lock recovered exactly, a full disk pruned by retention', { timeout: 600_000 }, async (t) => {
  const WORLD = 'no-stuck-eden-20261114';
  const h = harness(t, { slug: 'eden', worldId: WORLD, range: [P0, P0 + 5], guard: { pollMs: 1000 },
    env: { ENGINE: 'mars', ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1', ENABLE_CLOSED_HUMAN_GOALS: '1', ENABLE_REGISTERED_HUMAN_ACTIVITIES: '1', ENABLE_LIVING_WORLD: '1', MIND_DRIVER: 'central', NODE_OPTIONS: '--max-old-space-size=1024', SIM_HANG_KILL_MS: '10000' } });   // (the production hang limit: a write's 5 s lock wait ends first)
  await withLogTail(h, async () => {
  await h.pool.ensure(h.world); h.pool.startGuard();
  const soulId = await admitSoul(h);

  // 1: a Soul's body broken in memory (its pose no number), then the broken-body sweep run at once, as the next sweep tick
  // would (fault-inject.ts: no race with the tick that would otherwise sweep it). Quarantined, held whole, the same process on.
  { const pid0 = h.pid(), t0 = Date.now(), before = (await h.health()).tick;
    assert.equal(await h.fault('kind=corrupt'), 202);
    let seen = null; for (let i = 0; i < 200 && !seen; i++) { seen = /\[world\] glitch rung=\w+ rule=entity\.corrupt tick=\d+ [^\n]*/.exec(h.log()); if (!seen) await wait(50); }
    assert.ok(seen, 'the broken body is quarantined (a glitch named entity.corrupt)');
    const at = Date.now() - t0; await wait(500); const after = (await h.health()).tick;
    assert.equal(h.pid(), pid0, 'the same process'); assert.ok(after > before, `still ticking (${before} -> ${after})`);
    t.diagnostic(`1 corruption: quarantined ${at} ms after the fault (${seen[0]}); the same process ticking on (${before} -> ${after}); never down`); }

  // 4: the disk under its headroom (the world is told it has 10 MB free). The log says so; the hourly backups' retention rule
  // runs (eight old hourly files: the two newest are kept, as the rule says (#2542), never fewer); the world runs on.
  { const pid0 = h.pid(), before = (await h.health()).tick;
    const old = Array.from({ length: 8 }, (_, i) => `backup-20200101${String(i + 1).padStart(2, '0')}.db`);
    for (const f of old) writeFileSync(join(h.dataDir, f), '');
    assert.equal(await h.fault('kind=disk&mb=10'), 202);
    await wait(300);
    assert.match(h.log(), /\[load\] disk\.low: 10 MB free, under the 1024 MB headroom: pruning by the retention rules; the hourly backup waits/);
    const left = readdirSync(h.dataDir).filter((f) => /^backup-2020/.test(f)).sort();
    assert.deepEqual(left, old.slice(6), 'pruned by the retention rule: the newest two hourly files kept');
    assert.equal(await h.fault('kind=disk'), 202); await wait(300);
    assert.match(h.log(), /\[load\] disk\.ok: \d+ MB free/);
    const after = (await h.health()).tick;
    assert.equal(h.pid(), pid0); assert.ok(after > before, `still ticking (${before} -> ${after})`);
    t.diagnostic(`4 disk: alert and prune at once (6 of 8 old hourly backups removed, 2 kept by the rule); the same process ticking on (${before} -> ${after}); never down`); }

  // 3: another process holds the database's write lock for 12 s. The world's next write waits its 5 s limit (busy_timeout)
  // and the world halts by name; the launcher's guard restarts it, and it serves again once the lock is gone, exactly.
  { const events = h.events(), pid0 = h.pid(), n0 = h.frontiers.length, t0 = Date.now();
    const lock = new DatabaseSync(join(h.dataDir, 'sim.db')); lock.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    const release = setTimeout(() => { try { lock.exec('ROLLBACK'); } finally { lock.close(); } }, 12_000);
    t.after(() => { clearTimeout(release); try { lock.close(); } catch { /* closed */ } });
    const r = await h.back(pid0, t0);
    const exit = h.pool.status('eden').lastExit, health = await h.health();
    assert.equal(h.events().slice(0, events.length - 1), events.slice(0, -1), 'every event logged before the lock is kept, in order');
    const db = new Db(join(h.dataDir, 'sim.db')); assert.ok(db.soul(soulId), 'the accepted Soul is kept'); db.close();
    const fr = h.frontiers[n0], hashes = [...h.log().matchAll(/\[boot\] state at tick (\d+): ([0-9a-f]+)/g)].at(-1);
    assert.ok(fr && !fr.error, `a frontier was read (${JSON.stringify(fr)})`);
    assert.equal(Number(hashes[1]), fr.tick, 'the boot restored the frontier tick');
    assert.equal(hashes[2], fr.engineHash, 'the restored engine state is the live world\'s at the frontier');
    assert.doesNotMatch(h.log(), /replay differs/);
    const halt = /\[world\] glitch rung=halt rule=([\w.-]+)/.exec(h.log());
    t.diagnostic(`3 database lock 12 s: process gone ${r.gone} ms, serving again ${r.serving} ms after the lock was taken (${halt ? `halted ${halt[1]}` : 'no halt line'}; exit ${exit?.signal ?? exit?.code} ${exit?.reason ?? ''}); frontier tick ${fr.tick} restored with the same hash; now tick ${health.tick}`); }
  });
});

test('A2 (cause 2) on an Eden core world (durable clock): a step that hangs on every boot is quarantined by its identity, and the world comes up and runs', { timeout: 600_000 }, async (t) => {
  // the durable clock frontier is written before the listeners, so a boot restores the tick its step hung at and dies at the
  // next one: the step hangs for 30 ticks (K) from T. bootStallMs 8 s: a catch-up step may run before the world serves,
  // where the launcher's boot guard ends it
  const K = 30;
  const h = harness(t, { slug: 'eden', worldId: 'no-stuck-loop-20261115', range: [P0 + 6, P0 + 11], guard: { pollMs: 1000, bootStallMs: 8000 },
    env: { ENGINE: 'mars', ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1', ENABLE_CLOSED_HUMAN_GOALS: '1', ENABLE_REGISTERED_HUMAN_ACTIVITIES: '1', ENABLE_LIVING_WORLD: '1', MIND_DRIVER: 'central', NODE_OPTIONS: '--max-old-space-size=1024' } });
  await withLogTail(h, async () => {
  await h.pool.ensure(h.world); h.pool.startGuard();
  const pid0 = h.pid(), tick0 = (await h.health()).tick, T = tick0 + 100, events = h.events(), t0 = Date.now();
  assert.equal(await h.fault(`kind=hang-at&tick=${T}&ticks=${K}`), 202);
  // the first death, then the boots that meet it again, until one comes up with the step quarantined
  const re = /\[world\] step quarantined: (fault-inject hang-at) skipped from tick (\d+) until tick (\d+) \(it ended the world on (\d+) boots in a row: [^\n]*\)/;
  let line = null, pid = pid0;
  for (let boots = 0; boots < 5 && !line; boots++) {
    await h.back(pid, t0); pid = h.pid();
    for (let i = 0; i < 100 && !line; i++) { line = re.exec(h.log()); if (!line) await wait(100); }
    if (!line && h.pid() === pid && h.pool.status('eden').status === 'running') { await wait(6000); }   // (this boot may yet meet it)
  }
  assert.ok(line, 'a boot came up with the step quarantined by name');
  const from = Number(line[2]), until = Number(line[3]);
  assert.ok(from >= T && from < T + K, `skipped inside the ticks it hangs at (${T}..${T + K - 1}): ${from}`); assert.ok(until >= T + K, `the window covers them (until ${until})`);
  assert.ok(Number(line[4]) >= 2);
  const deaths = [...h.log().matchAll(/--- exit [^\n]*/g)].length;
  for (let i = 0; i < 600 && h.pool.status('eden').status !== 'running'; i++) await wait(50);
  pid = h.pid();
  const served = Date.now() - t0;
  await wait(2000);
  const a = (await h.health()).tick; await wait(1000); const b = (await h.health()).tick;
  assert.ok(a > T + K && b > a, `the world runs on past the ticks (${T + K} -> ${a} -> ${b})`);
  assert.equal(h.pid(), pid, 'and stays up');
  { const hz = await h.health(); if (hz.tick < until) assert.deepEqual(hz.quarantine && { untilTick: hz.quarantine.untilTick, deaths: hz.quarantine.deaths }, { untilTick: until, deaths: Number(line[4]) }, 'healthz shows the skipped step while it is skipped'); }
  assert.equal(h.events().slice(0, events.length - 1), events.slice(0, -1), 'every event logged before the fault is kept');
  assert.doesNotMatch(h.log(), /replay differs/);
  const glitch = /\[world\] glitch rung=contained rule=world\.step-quarantined tick=(\d+)/.exec(h.log());
  assert.ok(glitch && Number(glitch[1]) === from, 'counted once as a glitch (world.step-quarantined)');
  assert.equal(h.log().match(/\[world\] step quarantined:/g).length, 1, 'named once, not once a tick');
  const exits = h.pool.status('eden');
  t.diagnostic(`A2 restart loop (durable clock): fault -> serving with the step quarantined ${served} ms (${deaths} deaths; restarts ${JSON.stringify(exits.restartsByReason ?? {})}); ${line[1]} skipped from tick ${from} (hangs ${T}..${T + K - 1}) until ${until} after ${line[4]} deaths; now tick ${b}`);
  });
});
