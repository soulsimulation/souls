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
import { engineDayAt, mapStamp, mapWorldMinute, stampShift, worldMinuteAt, type CutOver } from './clock-cutover.ts';

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
  const due = () => (f.db.db.prepare('SELECT due_world_minute d FROM edge_personal_reminders_v1').get() as any).d as number;
  const d0 = due();
  // the first keeper's mapping throws (a locked database, say): the clock still comes onto real time
  const logs: string[] = [];
  const first = installRealClock(f.host as any, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000, log: (m) => logs.push(m), onCutOver: () => { throw new Error('database is locked'); } });
  const p = first.sync(); await settle(4); await p; first.stop();
  assert.equal(f.host.living?.dayTicks, REAL_DAY_TICKS);
  assert.equal(due(), d0, 'not mapped yet');
  assert.ok(logs.some((m) => /tried again later/.test(m)));
  // the next boot's keeper finds the cut-over named by the clock and finishes it, once
  const second = installRealClock(f.host as any, { zone: () => 'America/New_York', now: () => wall, checkMs: 3_600_000, onCutOver: (c) => cutOverWorld(f.host, god, c) });
  await second.sync(); await second.sync(); second.stop();
  const newToday = Math.floor(freshBootClock(f.host as any).absoluteWorldMinutes! / 1440);
  assert.equal(due(), (newToday + 2) * 1440 + 8 * 60 + 15, 'mapped by the next keeper: two days ahead at 08:15');
});

function posterListOf(e: any) { return JSON.parse(e.state.textBy || '[]'); }
