// #1649: worlds run on real time in their own time zone. World time = f(real UTC, zone): pinned instants and zones give
// the expected local hour and calendar day; the engine reads it from a logged dayConfig (no wall clock in the engine);
// a world without a zone is migrated once by its slug; drift is corrected by one logged re-alignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { advanceNeeds, clockAt, newLife } from '@souls/brain';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { installWorldClock, syncWorldClock, worldTimeZone } from './world-clock.ts';
import { setEnv } from './world-env.ts';
import { CLOCK_BASE_MS, REAL_DAY_TICKS, hasRealClock, productionWorld, realTimeEnabled, installRealClock, defaultTimeZone, isTimeZone, localDateTime, realClockConfig, realClockDriftMs } from './real-clock.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('world time is the local wall time of a UTC instant in the world zone', () => {
  const at = Date.UTC(2026, 10, 9, 17, 30); // 2026-11-09 17:30 UTC
  assert.equal(localDateTime(at, 'America/New_York').slice(0, 16), '2026-11-09T12:30', 'EST is UTC-5 in November');
  assert.equal(localDateTime(at, 'America/Los_Angeles').slice(0, 16), '2026-11-09T09:30', 'PST is UTC-8');
  assert.equal(localDateTime(at, 'Europe/Lisbon').slice(0, 16), '2026-11-09T17:30', 'WET is UTC+0 in winter');
  assert.equal(localDateTime(at, 'Asia/Tokyo').slice(0, 16), '2026-11-10T02:30', 'east of UTC: already the next calendar day');
  assert.equal(localDateTime(Date.UTC(2027, 6, 1, 11), 'Europe/Lisbon').slice(0, 16), '2027-07-01T12:00', 'WEST is UTC+1 in summer');
  // daylight saving ends in New York on 2026-11-01 at 02:00 local (06:00 UTC)
  assert.equal(localDateTime(Date.UTC(2026, 10, 1, 5, 59), 'America/New_York').slice(11, 16), '01:59');
  assert.equal(localDateTime(Date.UTC(2026, 10, 1, 6, 0), 'America/New_York').slice(11, 16), '01:00');
});

test('the engine clock reads the local time: the dayConfig origin for a tick and instant', () => {
  const at = Date.UTC(2026, 10, 9, 17, 30, 0), tick = 123_456;
  for (const zone of ['America/New_York', 'Europe/Lisbon', 'Asia/Kolkata']) {
    const { dayConfig } = realClockConfig(tick, at, zone);
    assert.equal(dayConfig.dayTicks, REAL_DAY_TICKS);
    assert.ok(Number.isSafeInteger(dayConfig.origin));
    const c = clockAt(tick, dayConfig.origin, dayConfig.dayTicks);
    assert.equal(c.datetime, localDateTime(at, zone), `${zone}: the engine reads the local time`);
    // one real hour of ticks later the engine reads one hour later
    const later = clockAt(tick + 72_000, dayConfig.origin, dayConfig.dayTicks);
    assert.equal(Date.parse(later.datetime) - Date.parse(c.datetime), 3_600_000, 'one world hour is one real hour');
    assert.equal(realClockDriftMs(dayConfig, tick, at, zone), 0);
    assert.equal(realClockDriftMs(dayConfig, tick, at + 90_000, zone), 90_000, 'ninety seconds behind the wall');
  }
  assert.ok(Date.parse(localDateTime(Date.UTC(2026, 10, 9), 'Pacific/Kiritimati')) > CLOCK_BASE_MS);
});

test('zones: validity and the migration defaults', () => {
  for (const z of ['America/New_York', 'Europe/Lisbon', 'UTC', 'Asia/Kolkata']) assert.equal(isTimeZone(z), true, z);
  for (const z of ['', 'Mars/Olympus', 'EST5EDT; drop', 42, null, 'a'.repeat(80)]) assert.equal(isTimeZone(z), false, String(z));
  assert.equal(defaultTimeZone('mars-college-2026'), 'America/Los_Angeles');
  assert.equal(defaultTimeZone('mars-college-2027'), 'America/Los_Angeles');
  assert.equal(defaultTimeZone('rna-studio'), 'Europe/Lisbon');
  assert.equal(defaultTimeZone('eden'), 'America/New_York');
  assert.equal(defaultTimeZone('some-world'), 'America/New_York');
  assert.equal(defaultTimeZone(undefined), 'America/New_York');
  // part 3: the zone chosen in the New world dialog (the launcher's WORLD_TIME_ZONE) wins over the slug's default
  assert.equal(defaultTimeZone('some-world', { WORLD_TIME_ZONE: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(defaultTimeZone('rna-studio', { WORLD_TIME_ZONE: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(defaultTimeZone('rna-studio', { WORLD_TIME_ZONE: 'Mars/Olympus' }), 'Europe/Lisbon', 'an invalid one is ignored');
});

test('a god world on real time: migrated once, reads the wall, re-aligns after drift, refuses a bad zone', { timeout: 600000 }, async (t) => {
  let wall = Date.UTC(2026, 10, 9, 17, 30); // noon in New York, 09:30 in Los Angeles
  const rtWas = process.env.SIM_REAL_TIME; process.env.SIM_REAL_TIME = '1';   // the server's flag (god act reads it)
  t.after(() => { if (rtWas === undefined) delete process.env.SIM_REAL_TIME; else process.env.SIM_REAL_TIME = rtWas; });
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const logs: string[] = [];
  const clockRules = () => f.db.db.prepare("SELECT payload FROM events WHERE kind='rules' AND payload LIKE '%dayConfig%'").all().length;
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  // the clock's rules apply on the next ticks: step the host while the sync waits for them
  const synced = async (n: number) => { const p = syncWorldClock(god); await settle(n + 1); await p; };
  f.brain.quiesce();
  t.after(() => { f.brain.quiesce(); f.host.stop(); f.db.close(); });
  const realTime = { realTime: true, slug: 'mars-college-2027', now: () => wall, checkMs: 3_600_000 };
  installEngineBridge({ host: f.host, god, edge, log: () => {}, worldClock: false });
  installWorldClock(f.host, god, (m) => logs.push(m), realTime);
  await settle(3);
  assert.equal((god.model.state.time as any).timeZone, 'America/Los_Angeles', 'migrated by its slug');
  assert.equal(worldTimeZone(god, 'mars-college-2027'), 'America/Los_Angeles');
  const migrations = () => f.db.db.prepare("SELECT count(*) n FROM world_edits_v1 WHERE note LIKE '%real-time migration%'").get() as { n: number };
  assert.equal(migrations().n, 1, 'the migration is one recorded edit');
  assert.equal(f.host.living?.dayTicks, REAL_DAY_TICKS);
  const env = () => (f.host.engine.world as any).env.datetime as string;
  assert.equal(env().slice(0, 16), '2026-11-09T09:30', 'the engine reads 09:30 local in Los Angeles');
  const n0 = clockRules();

  // the wall moves on with the ticks: nothing new is logged
  for (let i = 0; i < 1200; i++) f.host.tickOnce(); wall += 60_000;
  await synced(1);
  assert.equal(clockRules(), n0, 'in step with the wall: no new clock event');
  assert.equal(env().slice(0, 16), '2026-11-09T09:31');

  // the tick loop fell 10 minutes behind (a restart, a stall): one re-alignment, which keeps the day's state
  (f.host as any).extra.living.lastDay = 5; (f.host as any).extra.living.event = 'the market opens';
  wall += 600_000;
  await synced(2);
  assert.equal(clockRules(), n0 + 1, 'one logged re-alignment');
  assert.equal((f.host.living as any).lastDay, 5, 'a re-alignment keeps the last day turn');
  assert.equal((f.host.living as any).event, 'the market opens', 'and the day\'s event');
  assert.equal(env().slice(0, 16), '2026-11-09T09:41');

  // the owner moves the world to Lisbon (a world op, recorded): the clock follows the zone
  assert.equal((god.act({ ops: [{ op: 'world', state: { time: { timeZone: 'Europe/Lisbon' } } }] }, 'zone') as any).accepted, true);
  await synced(2);
  assert.equal(env().slice(0, 16), '2026-11-09T17:41', 'Lisbon local time');
  assert.equal((f.host.living as any).zone, 'Europe/Lisbon');
  const bad = god.act({ ops: [{ op: 'world', state: { time: { timeZone: 'Mars/Olympus' } } }] }, 'bad zone') as any;
  assert.equal(bad.accepted, false);
  assert.match(JSON.stringify(bad.failures), /time\.zone-invalid/);

  // part 3: the owner's API (POST /v1/god/env {timeZone}) is the same world op: recorded, undoable, a bad zone refused by name
  const rules = clockRules();
  assert.equal((setEnv(god, { timeZone: 'Asia/Tokyo' }, 'zone') as any).accepted, true);
  await synced(2);
  assert.equal(env().slice(0, 16), '2026-11-10T02:41', 'Tokyo local time: already the next calendar day');
  assert.equal(clockRules(), rules + 1, 'one clock event for the zone change');
  assert.throws(() => setEnv(god, { timeZone: 'Mars/Olympus' }), (e: any) => e.code === 'time.zone-invalid');
  god.undo(); await synced(2);
  assert.equal((god.model.state.time as any).timeZone, 'Europe/Lisbon', 'undo restores the previous zone');
  assert.equal(env().slice(0, 16), '2026-11-09T17:41', 'and the clock follows it back');

  assert.equal((god.model.state.time as any).clock, 'real', 'the migration put the world on the real clock');

  // a dev world's god chooses the accelerated clock (the dev-only option), then real time again
  assert.equal((god.act({ ops: [{ op: 'world', state: { time: { clock: 'accelerated', dayTicks: 72000 } } }] }, 'fast days') as any).accepted, true);
  await synced(3);
  assert.equal(f.host.living?.dayTicks, 72000, 'accelerated: one world day per real hour');
  assert.equal(env().slice(11, 16), '17:41', 'the time of day carries over');
  assert.equal((god.act({ ops: [{ op: 'world', state: { time: { clock: 'real' } } }] }, 'real time') as any).accepted, true);
  await synced(3);
  assert.equal(f.host.living?.dayTicks, REAL_DAY_TICKS);
  assert.equal(env().slice(0, 16), '2026-11-09T17:41', 'back on the wall in Lisbon');

  // production (#1649 review): the act route holds the same rules as the env route
  const saved = { stage: process.env.SIM_STAGE, rt: process.env.SIM_REAL_TIME };
  try {
    process.env.SIM_STAGE = 'production'; process.env.SIM_REAL_TIME = '1';
    for (const time of [{ clock: 'accelerated' }, { set: { hour: 19, n: 99 } }, { dayTicks: 1200 }]) {
      const r = god.act({ ops: [{ op: 'world', state: { time } }] }, 'sneak') as any;
      assert.equal(r.accepted, false, JSON.stringify(time)); assert.equal(r.failures[0].code, 'time.accelerated-production');
    }
    assert.equal((god.act({ ops: [{ op: 'world', state: { time: { paused: true } } }] }, 'pause') as any).accepted, true, 'pausing is allowed');
    assert.equal((god.act({ ops: [{ op: 'world', state: { time: { paused: false } } }] }, 'resume') as any).accepted, true);
    process.env.SIM_REAL_TIME = '0';
    assert.equal((god.act({ ops: [{ op: 'world', state: { time: { clock: 'real' } } }] }, 'real') as any).failures[0].code, 'time.real-clock-off');
  } finally { if (saved.stage === undefined) delete process.env.SIM_STAGE; else process.env.SIM_STAGE = saved.stage; process.env.SIM_REAL_TIME = saved.rt; }

  // a second boot over the same database writes no second migration
  const god2 = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  assert.equal((god2.model.state.time as any).timeZone, 'Europe/Lisbon');
  assert.equal(migrations().n, 1, 'idempotent');
  // real time turned off again (a rollback): the world drops `clock: 'real'` so nothing reads a clock it does not run
  installWorldClock(f.host, god2, () => {}, { realTime: false, slug: 'mars-college-2027' });
  assert.equal((god2.model.state.time as any).clock ?? null, null);
});

test('an authored world (no god) keeps real time through the same keeper; customs carry over; slowed worlds wait', async () => {
  let wall = Date.UTC(2026, 10, 9, 23, 0), tick = 5000;
  const events: any[] = [];
  const host: any = { engine: { world: { get tick() { return tick; } } }, living: { origin: 0, dayTicks: 72000, customs: ['supper at the long table'] }, pace: 1, paused: false, running: true,
    enqueue(_k: string, _a: string, p: any) { events.push(p); host.living = { ...p.dayConfig }; return Promise.resolve(); } };
  const keeper = installRealClock(host, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000 });
  await keeper.sync();
  assert.equal(hasRealClock(host), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].realign, undefined, 'from the accelerated clock: a fresh day state, not a re-alignment');
  assert.deepEqual(host.living.customs, ['supper at the long table'], 'customs carry over');
  assert.equal(clockAt(tick, host.living.origin, host.living.dayTicks).datetime.slice(0, 16), '2026-11-09T18:00', '18:00 in New York');
  tick += 20 * 30; wall += 30_000; await keeper.sync();
  assert.equal(events.length, 1, 'in step: nothing logged');
  wall += 3_600_000; host.pace = 0.25;   // nobody watching; the periodic check skips a slowed world (sync on demand still works)
  await keeper.sync();
  assert.equal(events.length, 2, 'an explicit sync re-aligns');
  assert.equal(events[1].realign, true, 'already on real time: a re-alignment');
  assert.equal(clockAt(tick, host.living.origin, host.living.dayTicks).datetime.slice(11, 16), '19:00');
  keeper.stop();
});

test('#2235: a boot catch-up still owed is read as done, so the keeper does not move the clock by the time away', async () => {
  let wall = Date.UTC(2026, 10, 9, 12, 0), tick = 1000;
  const events: any[] = [];
  const host: any = { engine: { world: { get tick() { return tick; } } }, living: undefined, pace: 1, paused: false, running: true, owedTicks: 0,
    enqueue(_k: string, _a: string, p: any) { events.push(p); host.living = { ...p.dayConfig }; return Promise.resolve(); } };
  const keeper = installRealClock(host, { zone: () => 'UTC', now: () => wall, checkMs: 3_600_000 });
  await keeper.sync();
  assert.equal(events.length, 1);
  wall += 3 * 3_600_000; host.owedTicks = 3 * 3600 * 20;   // the process was gone 3 h; the boot owes those ticks
  await keeper.sync();
  assert.equal(events.length, 1, 'in step once the owed ticks have run: nothing logged');
  tick += host.owedTicks; host.owedTicks = 0;
  assert.equal(clockAt(tick, host.living.origin, host.living.dayTicks).datetime.slice(11, 16), '15:00', 'after the catch-up the clock reads the wall');
  keeper.stop();
});

test('the periodic check re-aligns a watched, running world and leaves slowed, paused or stopped ones alone', async () => {
  let wall = Date.UTC(2026, 10, 9, 12, 0), tick = 0;
  const events: any[] = [];
  const host: any = { engine: { world: { get tick() { return tick; } } }, living: undefined, pace: 1, paused: false, running: true,
    enqueue(_k: string, _a: string, p: any) { events.push(p); host.living = { ...p.dayConfig }; return Promise.resolve(); } };
  const keeper = installRealClock(host, { zone: () => 'UTC', now: () => wall, checkMs: 20, customs: ['tea at four'] });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(60);
  assert.equal(events.length, 1, 'started once'); assert.deepEqual(host.living.customs, ['tea at four']); assert.equal(events[0].realign, undefined);
  for (const [k, v] of [['pace', 0.25], ['paused', true], ['running', false]] as const) {
    const n: number = events.length; host[k] = v; wall += 120_000; await wait(80);
    assert.equal(events.length, n, `${k}: no re-alignment`);
    host[k] = k === 'pace' ? 1 : !v; await wait(80);
    assert.equal(events.at(-1).realign, true);
  }
  assert.equal(events.length, 4, 'one re-alignment each time it runs at full pace again');
  keeper.stop();
});

test('needs move over the clock day: a real day is 24 times slower than the accelerated one', () => {
  const a = newLife(0), b = newLife(0);
  advanceNeeds(a, 72000, 'idle', false);                       // one accelerated day
  advanceNeeds(b, 72000, 'idle', false, false, false, REAL_DAY_TICKS); // one real hour
  assert.ok(a.needs.hunger > b.needs.hunger + 50, `accelerated ${a.needs.hunger} vs real ${b.needs.hunger}`);
  const c = newLife(0); advanceNeeds(c, REAL_DAY_TICKS, 'idle', false, false, false, REAL_DAY_TICKS);
  assert.equal(c.needs.hunger, a.needs.hunger, 'one real day of a real clock = one accelerated day of the old one');
});

test('#1649 review: the production marker fails closed when no stage is set', () => {
  // a named stage decides
  assert.equal(productionWorld({ SIM_STAGE: 'production' }), true);
  assert.equal(productionWorld({ SIM_STAGE: 'legacy', DEV_AUTH: '1' }), true);
  assert.equal(productionWorld({ SIM_STAGE: 'staging', PUBLIC_URL: 'https://sim.eden.art' }), false);
  // no stage (an older keeper kept by activate.sh --reload): production unless an explicit dev signal is present
  assert.equal(productionWorld({ PUBLIC_URL: 'https://soul.game', DEV_AUTH: '0' }), true);
  assert.equal(productionWorld({ PUBLIC_URL: 'https://sim.eden.art' }), true);
  assert.equal(productionWorld({ PUBLIC_URL: 'not a url' }), true);
  assert.equal(productionWorld({ PUBLIC_URL: 'https://soul.game', DEV_AUTH: '1' }), false);
  assert.equal(productionWorld({}), false, 'unset PUBLIC_URL reads http://localhost');
  for (const u of ['http://localhost:4500', 'http://127.0.0.1:4980', 'http://[::1]:4500', 'http://app.localhost:3000', 'http://sim.test'])
    assert.equal(productionWorld({ PUBLIC_URL: u, DEV_AUTH: '0' }), false, u);
});

test('#1649 review: the SIM_REAL_TIME rollback switch accepts 0, false and off', () => {
  for (const v of ['0', 'false', 'off', 'OFF', ' False ', 'no']) assert.equal(realTimeEnabled({ SIM_REAL_TIME: v }), false, v);
  for (const v of [undefined, '', '1', 'true', 'on']) assert.equal(realTimeEnabled({ SIM_REAL_TIME: v }), true, String(v));
});
