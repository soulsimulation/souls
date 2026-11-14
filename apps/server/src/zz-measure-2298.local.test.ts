// #2298 A6 measurement (not a test of record): CPU per wall second of a live still world, skipping on and off, and the
// time to catch up 24 h away. MEASURE_SOULS=0|2, MEASURE_SECONDS (default 30).
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Hono } from 'hono';
import { fixture, invite, accept } from '../test/native-owner-fixture.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { mountEdgeRoutes } from './edge/routes.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import { LivingWorld } from './living.ts';

const SOULS = Number(process.env.MEASURE_SOULS ?? 0), SECONDS = Number(process.env.MEASURE_SECONDS ?? 30);
test(`measure ${SOULS} souls`, { timeout: 3_600_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(join(dir, 'world.db'), undefined, { durableClockV1: true }); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  const ledger = new EdgeLedger(f.host, f.db); ledger.startBodyRule({ wanderTicks: 400, zombieTicks: 600, legMinTicks: 100, legMaxTicks: 200, boundTicks: 1500 });
  const comms = mountEdgeRoutes(new Hono(), { host: f.host, db: f.db, souls: f.souls, ledger, soul: () => { throw new Error('no'); } } as never); t.after(() => comms.close());
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  installEngineBridge({ host: f.host, god, edge: ledger, log: () => {}, worldLore: false, worldClock: false });
  new LivingWorld(f.host);
  if (!SOULS) await accept(f.host, f.host.enqueue('rules', 'world', { dayConfig: { origin: f.host.engine.world.tick, dayTicks: 1_728_000, customs: [], zone: 'UTC' }, why: 'measure' }));
  await accept<unknown>(f.host, f.host.enableHeldActivitiesV1());
  for (const n of ['ana', 'ben'].slice(0, SOULS)) { await invite(f, n); await accept(f.host, f.souls.create('dev:' + n, { name: n, description: 'quiet' })); }
  for (const m of f.host.minds.values()) await accept(f.host, f.host.enqueue('decision', `edge:${m.soulId}`, { soulId: m.soulId, entityId: m.entityId, option: 'rest', label: 'Read',
    steps: [{ verb: 'mars:pose_v1', params: { activity: 'read', prop: 'book', seconds: 10 } }], reevalTicks: 1e9, fallback: false, trigger: 'edge-act:r_last' }));
  f.host.skip = false;
  for (let i = 0; i < 4000; i++) { f.host.tickOnce(); if (i % 500 === 0) await setImmediate(); }   // asleep by now
  const out: Record<string, unknown> = { souls: SOULS };
  for (const skip of [false, true]) {
    f.host.skip = skip; f.host.start();
    const c0 = process.cpuUsage(), w0 = performance.now(), t0 = f.host.engine.world.tick;
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    const c = process.cpuUsage(c0), wall = performance.now() - w0; f.host.stop();
    out[skip ? 'after' : 'before'] = { cpuMsPerWallHour: Math.round((c.user + c.system) / 1000 / wall * 3_600_000), ticks: f.host.engine.world.tick - t0, wallMs: Math.round(wall) };
  }
  f.host.skip = true;
  const w = performance.now(), c0 = f.host.skipStats.ticksComputed; await f.host.catchUp(1_728_000, () => setImmediate());
  out.catchUp24h = { ms: Math.round(performance.now() - w), ticksComputed: f.host.skipStats.ticksComputed - c0 };
  console.log('[measure]', JSON.stringify(out));
});
