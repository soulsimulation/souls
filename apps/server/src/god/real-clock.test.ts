// #1649: worlds run on real time in their own time zone. World time = f(real UTC, zone): pinned instants and zones give
// the expected local hour and calendar day; the engine reads it from a logged dayConfig (no wall clock in the engine);
// a world without a zone is migrated once by its slug; drift is corrected by one logged re-alignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { clockAt } from '@souls/brain';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { installWorldClock, syncWorldClock, worldTimeZone } from './world-clock.ts';
import { CLOCK_BASE_MS, REAL_DAY_TICKS, defaultTimeZone, isTimeZone, localDateTime, realClockConfig, realClockDriftMs } from './real-clock.ts';

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
});

test('a god world on real time: migrated once, reads the wall, re-aligns after drift, refuses a bad zone', { timeout: 600000 }, async (t) => {
  let wall = Date.UTC(2026, 10, 9, 17, 30); // noon in New York, 09:30 in Los Angeles
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

  // the tick loop fell 10 minutes behind (a restart, a stall): one re-alignment
  wall += 600_000;
  await synced(2);
  assert.equal(clockRules(), n0 + 1, 'one logged re-alignment');
  assert.equal(env().slice(0, 16), '2026-11-09T09:41');

  // the owner moves the world to Lisbon (a world op, recorded): the clock follows the zone
  assert.equal((god.act({ ops: [{ op: 'world', state: { time: { timeZone: 'Europe/Lisbon' } } }] }, 'zone') as any).accepted, true);
  await synced(2);
  assert.equal(env().slice(0, 16), '2026-11-09T17:41', 'Lisbon local time');
  assert.equal((f.host.living as any).zone, 'Europe/Lisbon');
  const bad = god.act({ ops: [{ op: 'world', state: { time: { timeZone: 'Mars/Olympus' } } }] }, 'bad zone') as any;
  assert.equal(bad.accepted, false);
  assert.match(JSON.stringify(bad.failures), /time\.zone-invalid/);

  // a second boot over the same database writes no second migration
  const god2 = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  assert.equal((god2.model.state.time as any).timeZone, 'Europe/Lisbon');
  assert.equal(migrations().n, 1, 'idempotent');
});
