// #2297: a world says whether it is still and until which tick (WorldHost.stillUntil, GET /__sim/still), and over long
// runs every answer it gave is checked against what really happened (the still check, A6). Nothing is skipped here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { fixture, invite, accept } from '../test/native-owner-fixture.ts';
import { Hono } from 'hono';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { mountEdgeRoutes } from './edge/routes.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import { LivingWorld } from './living.ts';
import { REAL_DAY_TICKS } from './god/real-clock.ts';

/** STILL_FULL=1: the A6 runs as accepted, 24 h of ticks each (20 ticks a second) with the real wind-down; about 40 min for
 *  a world with two Souls, so the server shards run 20 minutes of ticks with a short wind-down (400 + 600 ticks) instead. */
const FULL = process.env.STILL_FULL === '1';
const SHORT = { wanderTicks: 400, zombieTicks: 600, legMinTicks: 100, legMaxTicks: 200, boundTicks: 1500 };
const TICKS = Number(process.env.STILL_TICKS) || (FULL ? REAL_DAY_TICKS : 24_000);
/** Ticks from the last act until both are surely asleep (the wind-down is under two hours; the short one under 2,000 ticks). */
const SETTLE = FULL ? 2 * 72_000 : 4_000;
/** The state hash is compared on every claimed tick that is a multiple of this (1: every one; the log and the RNG always). */
const HASH_EVERY = Number(process.env.STILL_HASH_EVERY) || 1;

type W = Awaited<ReturnType<typeof world>>;
async function world(t: test.TestContext, souls: number) {
  const dir = mkdtempSync(join(tmpdir(), 'still-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // as a god world runs (the durable clock frontier is Eden core's)
  const f = fixture(join(dir, 'world.db')); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  // a god world as the launcher serves it: the edge ledger and its routes (comms, events, reminders, plans), the god's
  // entity world through the engine bridge (gardens, projects), the day. Not the real-time keeper: these ticks run faster
  // than the wall, so it would re-align the clock every 15 s (its daylight-saving deadline is checked on its own).
  const ledger = new EdgeLedger(f.host, f.db), rule = ledger.startBodyRule(FULL ? undefined : SHORT)!;
  const comms = mountEdgeRoutes(new Hono(), { host: f.host, db: f.db, souls: f.souls, ledger, soul: () => { throw new Error('no requests'); } } as never);
  t.after(() => comms.close());
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  installEngineBridge({ host: f.host, god, edge: ledger, log: () => {}, worldLore: false, worldClock: false });
  const living = new LivingWorld(f.host);
  // a real-time day, as installRealClock gives every served world (one world day per real day)
  await accept(f.host, f.host.enqueue('rules', 'world', { dayConfig: { origin: f.host.engine.world.tick, dayTicks: REAL_DAY_TICKS, customs: [], zone: 'UTC' }, why: 'test: a real-time day' }));
  await accept<unknown>(f.host, f.host.enableHeldActivitiesV1());
  for (const n of ['ana', 'ben'].slice(0, souls)) { await invite(f, n); await accept(f.host, f.souls.create('dev:' + n, { name: n, description: 'quiet' })); }
  // each agent's last act: read a book for ten seconds
  for (const m of f.host.minds.values()) await accept(f.host, f.host.enqueue('decision', `edge:${m.soulId}`, { soulId: m.soulId, entityId: m.entityId, option: 'rest', label: 'Read a book',
    steps: [{ verb: 'mars:pose_v1', params: { activity: 'read', prop: 'book', seconds: 10 } }], reevalTicks: 1e9, fallback: false, trigger: 'edge-act:r_last' }));
  void living;
  return { f, rule };
}
const run = async (w: W, ticks: number) => { const end = w.f.host.engine.world.tick + ticks; for (let i = 0; w.f.host.engine.world.tick < end; i++) { w.f.host.tickOnce(); if (i % 2000 === 0) await setImmediate(); } };
const check = (w: W) => { w.f.host.stillCheck = { claimed: 0, failures: [], fell: new Map(), every: HASH_EVERY }; return w.f.host.stillCheck; };
const report = (t: test.TestContext, name: string, w: W, c: NonNullable<W['f']['host']['stillCheck']>, ticks: number) => {
  const r = { world: name, ticks, claimed: c.claimed, failures: c.failures.length, firstFailures: c.failures.slice(0, 5), fell: Object.fromEntries(c.fell), events: w.f.host.seq };
  t.diagnostic(JSON.stringify(r)); console.log('[still-check]', JSON.stringify(r)); return r;
};

test('A1: stillUntil names the engine, the queue and the body rule; the step that reaches no deadline changes nothing (#2315 bar)', async (t) => {
  const w = await world(t, 2), h = w.f.host;
  assert.deepEqual([h.stillUntil().still, h.stillUntil().why], [false, 'engine'], 'not still while the act starts');
  await run(w, 300);   // the read (10 s) is over; the short wind-down starts at 400
  void h.enqueue('rules', 'world', { why: 'test: something queued' });
  assert.deepEqual([h.stillUntil().still, h.stillUntil().why], [false, 'queued']);
  h.drainInputs();
  h.owedTicks = 5; assert.equal(h.stillUntil().why, 'catching-up'); h.owedTicks = 0;
  const s = h.stillUntil();
  assert.equal(s.still, true, 'two Souls holding a read are still');
  assert.ok(s.untilTick !== null && s.moveTick !== null && s.moveTick >= s.untilTick - 0 && s.untilTick > s.tick, JSON.stringify(s));
  assert.equal(s.moveTick, Math.min(...[(h.engine as unknown as { stillnessV1(): { untilTick: number } }).stillnessV1().untilTick, w.rule.nextMoveTick()!].filter((x) => x !== null)), 'moveTick: the earlier of the held end and the rule\'s next step');
  // from a tick the world reports still, one more step changes nothing but the clock
  const e = h.engine as unknown as { stillCheckV1(): { hash: string; rng: string } }, before = e.stillCheckV1(), seq = h.seq;
  h.tickOnce();
  assert.deepEqual([e.stillCheckV1(), h.seq], [before, seq], 'one more step changes nothing');
});

for (const [name, souls, settle] of [['empty', 0, 0], ['two Souls asleep after the wind-down', 2, SETTLE], ['two Souls from the last act through the wind-down', 2, 0]] as const) {
  test(`A6: the still check holds over ${FULL ? '24 h' : '20 minutes'} of ticks: ${name}`, { timeout: 3_600_000 }, async (t) => {
    const w = await world(t, souls);
    if (settle) { await run(w, settle); assert.deepEqual([...w.f.host.minds.values()].map((m) => w.rule.view(m.soulId)?.state), ['asleep', 'asleep'], 'both asleep before the check'); }
    const c = check(w), at = performance.now();
    await run(w, TICKS);
    const r = report(t, name, w, c, TICKS);
    t.diagnostic(`${Math.round(performance.now() - at)} ms`);
    assert.deepEqual(c.failures.slice(0, 5), [], 'no claimed tick changed the world');
    assert.ok(c.claimed > TICKS * (souls && !settle ? 0.8 : 0.9), `most ticks were claimed still (${c.claimed} of ${TICKS})`);
    void r;
  });
}

test('A4: the overdue quiet is timed from when the engine could last snapshot, never from when a snapshot was taken', () => {
  const at = (lastSnapshotTick: (tick: number) => number) => {
    const logged: number[] = []; let tick = 0;
    const host = { living: { origin: 0, dayTicks: 1e9, customs: [], lastDay: 0, event: '', quiet: false }, extra: {} as Record<string, unknown>, listeners: [] as { afterTick?(t: number): void }[],
      engine: { canSnapshot: () => tick < 1000, world: { tick: 0 } }, get lastSnapshotTick() { return lastSnapshotTick(tick); },
      enqueue: (_k: string, _a: string, p: { quiet?: boolean }) => { if (p.quiet) logged.push(tick); return Promise.resolve(); } };
    new LivingWorld(host as never);
    for (tick = 1; tick <= 20_000; tick++) for (const l of host.listeners) l.afterTick?.(tick);
    return logged;
  };
  const a = at(() => 0), b = at((t) => t - (t % 6000));   // never snapshotted, and snapshotted every 6,000 ticks
  assert.deepEqual(a, [13_000], 'overdue 12,000 ticks after the last check at which it could snapshot (every 200 ticks)');
  assert.deepEqual(b, a, 'the snapshot schedule changes nothing');
});

test('A5: GET /__sim/still answers the #2241 contract to the launcher only', { timeout: 60_000 }, async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'still-route-')), port = 4300 + Math.floor(Math.random() * 400), logs: string[] = [];
  const child = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], { env: { PATH: process.env.PATH, DATA_DIR: data, WORLD_ID: 'still-route', WORLD_KEY: 'toy', ENGINE: 'toy', SEED_NATIVES: '0', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => logs.push(String(d))); child.stderr!.on('data', (d) => logs.push(String(d)));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(data, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 500 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* booting */ } if (!up) await delay(20); }
  assert.ok(up, logs.join(''));
  const r = await fetch(`http://127.0.0.1:${port}/__sim/still`), b = await r.json() as Record<string, unknown>;
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(b).sort(), ['jumps', 'lastHorizon', 'moveTick', 'moveWallMs', 'still', 'tick', 'ticksComputed', 'ticksJumped', 'untilTick', 'untilWallMs', 'wallMs']);
  assert.equal(b.still, false, 'the toy engine has no stillness: never still');
  assert.ok(Number.isSafeInteger(b.tick) && Math.abs((b.wallMs as number) - Date.now()) < 5000);
  assert.equal((await fetch(`http://127.0.0.1:${port}/__sim/still`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404, 'a forwarded request is not the launcher');
});
