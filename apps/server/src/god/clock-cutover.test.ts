// #1649 part 4 (A10): existing data survives the cut-over to real time with the documented mapping. A world that ran 300
// days on the accelerated clock comes onto real time: every reminder, poster and chalk drawing is still there (counted);
// pending world-clock reminders keep their time of day and distance in world days; stamps keep their age; history and
// real-clock reminders are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { PersonalReminders } from '../edge/reminders/reminders.ts';
import { freshBootClock } from '../edge/boot/clock.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { cutOverWorld, installWorldClock, syncWorldClock } from './world-clock.ts';
import { REAL_DAY_TICKS, installRealClock } from './real-clock.ts';
import { engineDayAt, mapStamp, mapWorldMinute, stampShift, unmappedCutOver, worldMinuteAt, type CutOver } from './clock-cutover.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('the mapping: same distance in world days and time of day; stamps keep their age, never below day 0', () => {
  // the old clock is 300 accelerated days in at 14:00; the new one reads day 37 at 09:30
  const tick = 30_000_000, from = { origin: tick - (300 * 72_000 + 8 * 3_000), dayTicks: 72_000 };
  const toMin = 37 * 1440 + 9 * 60 + 30, to = { origin: tick - Math.round((toMin - 6 * 60) * 1200), dayTicks: REAL_DAY_TICKS };
  const c: CutOver = { tick, from, to };
  assert.equal(worldMinuteAt(tick, to), toMin);
  const oldNow = worldMinuteAt(tick, from), oldDay = Math.floor(oldNow / 1440);
  assert.equal(oldNow - oldDay * 1440, 14 * 60, 'old clock reads 14:00');
  assert.equal(mapWorldMinute((oldDay + 1) * 1440 + 18 * 60, c), 38 * 1440 + 18 * 60, 'tomorrow 18:00 stays tomorrow 18:00');
  assert.equal(mapWorldMinute((oldDay + 3) * 1440 + 7 * 60 + 30, c), 40 * 1440 + 7 * 60 + 30, 'in three days at 07:30');
  assert.equal(mapWorldMinute(oldDay * 1440 + 20 * 60, c), 37 * 1440 + 20 * 60, 'today at 20:00 stays today at 20:00');
  const shift = stampShift(c);
  assert.equal(shift, engineDayAt(tick, from) - engineDayAt(tick, to));
  assert.equal(engineDayAt(tick, to) - mapStamp(engineDayAt(tick, from) - 2, c), 2, 'a stamp two days old is still two days old');
  assert.equal(mapStamp(3, c), 0, 'an old stamp floors at day 0 (already stale)');
});

test('a world 300 accelerated days in comes onto real time: every entry survives, mapped as documented', { timeout: 600000 }, async (t) => {
  const wall = Date.UTC(2026, 10, 10, 14, 30);   // 09:30 in New York
  const rtWas = process.env.SIM_REAL_TIME; process.env.SIM_REAL_TIME = '1';
  t.after(() => { if (rtWas === undefined) delete process.env.SIM_REAL_TIME; else process.env.SIM_REAL_TIME = rtWas; });
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  f.brain.quiesce();
  t.after(() => { f.brain.quiesce(); f.host.stop(); f.db.close(); });
  installEngineBridge({ host: f.host, god, edge, log: () => {}, worldClock: false });
  await settle(2);

  // before: the accelerated clock, 300 days and 14:00 in (as an old world restores it)
  const tick0 = f.host.engine.world.tick;
  const applied = f.host.enqueue('rules', 'world', { dayConfig: { origin: tick0 + 2 - (300 * 72_000 + 8 * 3_000), dayTicks: 72_000, customs: [] }, why: 'an old accelerated clock' });
  await settle(3); await applied;
  const old = { ...f.host.living! } as any;
  const oldDay = engineDayAt(f.host.engine.world.tick, old);
  assert.ok(oldDay >= 300, `old day ${oldDay}`);

  // what the world holds: reminders (pending world, pending real, delivered), a poster wall and a chalk drawing
  const reminders = new PersonalReminders(f.db.db, f.host.worldId, { publish: () => {} } as any, () => freshBootClock(f.host as any));
  const nowMin = freshBootClock(f.host as any).absoluteWorldMinutes!, today = Math.floor(nowMin / 1440);
  const make = (ref: string, at: unknown) => reminders.create('soul-a', { clientRef: ref, text: ref, at }).reminder as any;
  const tomorrow = make('tomorrow', { clock: 'world', worldDayIndex: today + 1, time: '18:00' });
  const later = make('in-three', { clock: 'world', worldDayIndex: today + 3, time: '07:30' });
  const real = make('real', { clock: 'real', time: new Date(wall + 86_400_000).toISOString() });
  const done = make('done', { clock: 'world', worldDayIndex: today + 2, time: '12:00' });
  f.db.db.prepare("UPDATE edge_personal_reminders_v1 SET state='delivered' WHERE id=?").run(done.id);
  const rows = () => f.db.db.prepare('SELECT id,state,kind,due_world_minute d,due_real_ms r,request FROM edge_personal_reminders_v1 ORDER BY id').all() as any[];
  const before = rows();
  const posters = [{ s: 0, t: 'Choir tonight', d: '', by: 's1', n: 'Ana', day: oldDay - 1 }, { s: 1, t: 'Lost cat', d: '', by: 's2', n: 'Bo', day: oldDay - 5 }];
  assert.equal((god.act({ ops: [
    { op: 'place', def: coreRef('poster-wall', 1), name: 'wall', p: [4, 4], state: { text: 'x', textBy: JSON.stringify(posters) } },
    { op: 'place', def: coreRef('chalk-square', 1), name: 'chalk', p: [8, 4], state: { media: '', title: 'a sun', maker: 'Ana', day: oldDay - 1 } },
  ] as any }, 'stamped things') as any).accepted, true);
  const ent = (name: string) => [...god.model.entities.values()].find((e: any) => e.name === name) as any;
  const edits0 = god.model.editSeq;

  // the cut-over: real time comes on for this world
  installWorldClock(f.host, god, () => {}, { realTime: true, slug: 'some-world', now: () => wall, checkMs: 3_600_000 });
  const p = syncWorldClock(god); await settle(4); await p; await settle(2);
  const living = f.host.living as any;
  assert.equal(living.dayTicks, REAL_DAY_TICKS); assert.equal(living.zone, 'America/New_York');
  const newDay = engineDayAt(f.host.engine.world.tick, living), newToday = Math.floor(freshBootClock(f.host as any).absoluteWorldMinutes! / 1440);
  assert.ok(newDay < oldDay, `the day number goes back once: ${oldDay} -> ${newDay}`);

  // every entry survives
  const after = rows();
  assert.equal(after.length, before.length, 'every reminder survives');
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id));
  assert.equal(posterListOf(ent('wall')).length, 2, 'both posters stay up');
  assert.ok(ent('chalk'), 'the chalk drawing stays');

  // pending world-clock reminders: same distance in world days, same time of day
  const by = (id: string) => after.find((r) => r.id === id);
  assert.equal(by(tomorrow.id).d, (newToday + 1) * 1440 + 18 * 60);
  assert.equal(by(later.id).d, (newToday + 3) * 1440 + 7 * 60 + 30);
  assert.equal(JSON.parse(by(later.id).request).at.worldDayIndex, newToday + 3, 'the request reads in the new count');
  // real-clock and delivered reminders: untouched
  assert.deepEqual(by(real.id), before.find((r) => r.id === real.id));
  assert.deepEqual(by(done.id), before.find((r) => r.id === done.id));
  // stamps keep their age
  const ages = posterListOf(ent('wall')).map((x: any) => newDay - x.day);
  assert.deepEqual(ages, [1, 5]);
  assert.equal(newDay - ent('chalk').state.day, 1);
  assert.equal(god.model.editSeq, edits0 + 2, 'one migration edit and one stamp edit, both recorded');

  // the clock event names the cut-over; mapping it again (a retry, a restart) moves nothing
  assert.equal(living.cutOver?.from.dayTicks, 72_000, 'the clock event names the cut-over');
  const again0 = rows(), wall0 = posterListOf(ent('wall'));
  cutOverWorld(f.host, god, living.cutOver);
  assert.deepEqual(rows(), again0); assert.deepEqual(posterListOf(ent('wall')), wall0); assert.equal(god.model.editSeq, edits0 + 2);

  // a later re-alignment is not a cut-over: nothing moves again
  const again = rows();
  installWorldClock(f.host, god, () => {}, { realTime: true, slug: 'some-world', now: () => wall + 600_000, checkMs: 3_600_000 });
  const q = syncWorldClock(god); await settle(4); await q; await settle(2);
  assert.deepEqual(rows(), again, 'reminders mapped once');
  assert.deepEqual(posterListOf(ent('wall')).map((x: any) => newDay - x.day), [1, 5], 'stamps mapped once');
  assert.equal((f.host.living as any).cutOver?.tick, living.cutOver.tick, 're-alignments carry the cut-over on');
});

test('a cut-over whose mapping failed is finished by the next keeper (a restart)', { timeout: 600000 }, async (t) => {
  const wall = Date.UTC(2026, 10, 10, 14, 30);
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  f.brain.quiesce();
  t.after(() => { f.brain.quiesce(); f.host.stop(); f.db.close(); });
  const tick0 = f.host.engine.world.tick;
  const applied = f.host.enqueue('rules', 'world', { dayConfig: { origin: tick0 + 2 - 120 * 72_000, dayTicks: 72_000, customs: [] }, why: 'an old accelerated clock' });
  await settle(3); await applied;
  const reminders = new PersonalReminders(f.db.db, f.host.worldId, { publish: () => {} } as any, () => freshBootClock(f.host as any));
  const today = Math.floor(freshBootClock(f.host as any).absoluteWorldMinutes! / 1440);
  reminders.create('soul-a', { clientRef: 'r', text: 'r', at: { clock: 'world', worldDayIndex: today + 2, time: '08:15' } });
  // review: a reminder made before the cut-over whose old due minute reads as past in the new count (a young world)
  reminders.create('soul-a', { clientRef: 'early', text: 'early', at: { clock: 'world', worldDayIndex: today + 1, time: '00:01' } });
  f.db.db.prepare("UPDATE edge_personal_reminders_v1 SET due_world_minute=1 WHERE client_ref='early'").run();
  const pump = new PersonalReminders(f.db.db, f.host.worldId, { publish: () => {} } as any, () => freshBootClock(f.host as any), () => unmappedCutOver(f.db.db, f.host.worldId, f.host.living as any));
  const state = (ref: string) => (f.db.db.prepare('SELECT state FROM edge_personal_reminders_v1 WHERE client_ref=?').get(ref) as any).state as string;
  const due = () => (f.db.db.prepare("SELECT due_world_minute d FROM edge_personal_reminders_v1 WHERE client_ref='r'").get() as any).d as number;
  const d0 = due();
  // the first keeper's mapping throws (a locked database, say): the clock still comes onto real time
  const logs: string[] = [];
  const first = installRealClock(f.host as any, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000, log: (m) => logs.push(m), onCutOver: () => { throw new Error('database is locked'); } });
  const p = first.sync(); await settle(4); await p; first.stop();
  assert.equal(f.host.living?.dayTicks, REAL_DAY_TICKS);
  assert.equal(due(), d0, 'not mapped yet');
  assert.ok(logs.some((m) => /tried again later/.test(m)));
  // until the mapping has run, the pump holds world reminders made before the cut-over (unmapped rows never fire)
  assert.equal(unmappedCutOver(f.db.db, f.host.worldId, f.host.living as any), (f.host.living as any).cutOver.tick);
  assert.equal(pump.collectDue(), 0, 'an unmapped reminder is held');
  assert.equal(state('early'), 'active');
  // a reminder made after the cut-over is already in the new count: the late mapping leaves it alone
  await settle(2);
  const nowToday = Math.floor(freshBootClock(f.host as any).absoluteWorldMinutes! / 1440);
  reminders.create('soul-a', { clientRef: 'late', text: 'late', at: { clock: 'world', worldDayIndex: nowToday + 1, time: '09:00' } });
  const late = () => (f.db.db.prepare("SELECT due_world_minute d FROM edge_personal_reminders_v1 WHERE client_ref='late'").get() as any).d as number;
  const late0 = late();
  // the next boot's keeper finds the cut-over named by the clock and finishes it, once
  const second = installRealClock(f.host as any, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000, onCutOver: (c) => cutOverWorld(f.host, god, c) });
  await second.sync(); await second.sync(); second.stop();
  const newToday = Math.floor(freshBootClock(f.host as any).absoluteWorldMinutes! / 1440);
  assert.equal(due(), (newToday + 2) * 1440 + 8 * 60 + 15, 'mapped by the next keeper: two days ahead at 08:15');
  assert.equal(late(), late0, 'a reminder made after the cut-over is not moved');
  // mapped: the hold lifts, and the reminder fires in the new count
  assert.equal(unmappedCutOver(f.db.db, f.host.worldId, f.host.living as any), null);
  assert.equal(pump.collectDue(), 1); assert.equal(state('early'), 'due'); assert.equal(state('r'), 'active');
});

test('backward cut-over survives a restart: a 300-day world cut over, the process restarted from its database', { timeout: 600000 }, async (t) => {
  // review (#1708, non-blocking 1): every production world takes the backward direction at the first deploy. Boot the
  // same SQLite file twice: the first boot cuts over, the second replays the clock event (with its cut-over) and maps
  // nothing again; a crash before the mapping is finished by the next boot, and the pump holds until then.
  let wall = Date.UTC(2026, 10, 10, 14, 30);   // 09:30 in New York
  const dir = mkdtempSync(join(tmpdir(), 'souls-1649-restart-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rtWas = process.env.SIM_REAL_TIME; process.env.SIM_REAL_TIME = '1';
  t.after(() => { if (rtWas === undefined) delete process.env.SIM_REAL_TIME; else process.env.SIM_REAL_TIME = rtWas; });
  const boot = async (file: string) => {
    const f = fixture(join(dir, file), factory, { durableClockV1: true, worldId: 'w-1649-restart' });
    const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
    const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
    f.brain.quiesce();
    installEngineBridge({ host: f.host, god, edge: new EdgeLedger(f.host, f.db), log: () => {}, worldClock: false });
    await settle(2);
    const pump = new PersonalReminders(f.db.db, f.host.worldId, { publish: () => {} } as any, () => freshBootClock(f.host as any), () => unmappedCutOver(f.db.db, f.host.worldId, f.host.living as any));
    const close = () => { f.brain.quiesce(); f.host.stop(); f.db.close(); };
    return { f, god, settle, pump, close };
  };
  const seed = async (file: string) => {
    const b = await boot(file);
    const tick0 = b.f.host.engine.world.tick;
    const a = b.f.host.enqueue('rules', 'world', { dayConfig: { origin: tick0 + 2 - (300 * 72_000 + 8 * 3_000), dayTicks: 72_000, customs: [] }, why: 'an old accelerated clock' });
    await b.settle(3); await a;
    const today = Math.floor(freshBootClock(b.f.host as any).absoluteWorldMinutes! / 1440);
    b.pump.create('soul-a', { clientRef: 'tomorrow', text: 'tomorrow', at: { clock: 'world', worldDayIndex: today + 1, time: '18:00' } });
    return b;
  };
  const due = (b: { f: any }) => (b.f.db.db.prepare("SELECT due_world_minute d FROM edge_personal_reminders_v1 WHERE client_ref='tomorrow'").get() as any).d as number;
  const today = (b: { f: any }) => Math.floor(freshBootClock(b.f.host as any).absoluteWorldMinutes! / 1440);
  const clockEvents = (b: { f: any }) => (b.f.db.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='rules' AND payload LIKE '%dayConfig%'").get() as any)?.n as number;

  // 1. a clean cut-over, then a restart
  let b = await seed('clean.db');
  const oldToday = today(b);
  installWorldClock(b.f.host, b.god, () => {}, { realTime: true, slug: 'some-world', now: () => wall, checkMs: 3_600_000 });
  let p = syncWorldClock(b.god); await b.settle(4); await p; await b.settle(2);
  const cut = (b.f.host.living as any).cutOver, newToday = today(b);
  assert.ok(cut && newToday < oldToday - 200, `the day count goes back: ${oldToday} -> ${newToday}`);
  assert.equal(due(b), (newToday + 1) * 1440 + 18 * 60, 'tomorrow at 18:00, local');
  const events1 = clockEvents(b), edits1 = b.god.model.editSeq;
  b.close();
  wall += 120_000;   // the restart takes two minutes
  b = await boot('clean.db');
  assert.deepEqual((b.f.host.living as any).cutOver, cut, 'the replayed clock names the same cut-over');
  assert.equal(b.f.host.living?.dayTicks, REAL_DAY_TICKS);
  assert.equal(unmappedCutOver(b.f.db.db, b.f.host.worldId, b.f.host.living as any), null, 'already mapped: the pump holds nothing at boot');
  installWorldClock(b.f.host, b.god, () => {}, { realTime: true, slug: 'some-world', now: () => wall, checkMs: 3_600_000 });
  p = syncWorldClock(b.god); await b.settle(4); await p; await b.settle(2);
  assert.equal(today(b), newToday, 'the same local day after the restart');
  assert.equal(due(b), (newToday + 1) * 1440 + 18 * 60, 'not mapped twice');
  assert.equal(b.god.model.editSeq, edits1, 'no second stamp or migration edit');
  assert.ok(clockEvents(b) <= events1 + 1, 'at most one re-alignment for the restart');
  t.diagnostic(`clean: day ${oldToday} -> ${newToday} at the cut-over (tick ${cut.tick}); after the restart day ${today(b)}, clock events ${events1} -> ${clockEvents(b)}, edits ${edits1} -> ${b.god.model.editSeq}`);
  assert.equal((b.f.host.living as any).cutOver?.tick, cut.tick);
  assert.equal(b.pump.collectDue(), 0, 'nothing fires early');
  b.close();

  // 2. the process dies after the clock event and before the mapping; the next boot holds, then finishes it
  b = await seed('crash.db');
  const first = installRealClock(b.f.host as any, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000, onCutOver: () => { throw new Error('killed'); } });
  p = first.sync(); await b.settle(4); await p; first.stop();
  const d0 = due(b), cut2 = (b.f.host.living as any).cutOver;
  b.close();
  b = await boot('crash.db');
  assert.equal(unmappedCutOver(b.f.db.db, b.f.host.worldId, b.f.host.living as any), cut2.tick, 'booted with an unmapped cut-over');
  assert.equal(due(b), d0);
  assert.equal(b.pump.collectDue(), 0, 'the pump holds the unmapped row');
  installWorldClock(b.f.host, b.god, () => {}, { realTime: true, slug: 'some-world', now: () => wall, checkMs: 3_600_000 });
  p = syncWorldClock(b.god); await b.settle(4); await p; await b.settle(2);
  assert.equal(due(b), (today(b) + 1) * 1440 + 18 * 60, 'mapped at the next boot: tomorrow at 18:00');
  t.diagnostic(`crash: unmapped due minute ${d0} held across the restart, mapped at the next boot to ${due(b)} (day ${today(b)} + 1, 18:00)`);
  assert.equal(unmappedCutOver(b.f.db.db, b.f.host.worldId, b.f.host.living as any), null);
  b.close();
});

function posterListOf(e: any) { return JSON.parse(e.state.textBy || '[]'); }
