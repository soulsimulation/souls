// #2458: an engine error thrown inside a tick (WorldHost.stepFaultV1, as fault-inject's `throw`) on an edge world under
// the repair rules. The recovery replays from its baseline and logs its main-thread hold; a boot that replays the same
// log reaches the recovered world's state hash. A recovery that ended the last process (its step quarantined) is not
// replayed again: the fault is contained in place, named, and the clock goes on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory, GREEN_FIELD_WORLD, soulsRepairReaderV1} from '@souls/engine-mars';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {WorldHost} from './world.ts';
import {RECOVERY_STEP_ID} from './load/restart-loop.ts';

const repair = soulsRepairReaderV1(await marsFactory({...GREEN_FIELD_WORLD, safeCrewRemoval: true}), {adopt: true});

async function world(t: test.TestContext, names = ['kino', 'ada']) {
  const lines: string[] = [], keep = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  t.mock.method(console, 'log', keep); t.mock.method(console, 'warn', keep); t.mock.method(console, 'error', keep);
  const f = fixture(':memory:', repair, {durableClockV1: true}); f.brain.quiesce(); f.souls.enableLifecycle();
  t.after(() => { f.host.stop(); f.db.close(); });
  await accept(f.host, f.host.adoptSoulsRepairV1('test'));
  new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: false});
  const run = (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); f.host.drainInputs(); } };
  run(5);
  for (const name of names) { await invite(f, name); await accept(f.host, f.souls.create(`dev:${name}`, {name, description: 'recovery probe'})); }
  run(30);
  let throws = 0; f.host.stepFaultV1 = (_tick, replay) => { if (!replay && throws > 0) { throws--; throw new Error('fault-inject.thrown: a test engine error inside the tick'); } };
  const fault = () => { throws = 1; run(1); };
  return {...f, lines, run, fault};
}
const holds = (lines: string[]) => lines.filter(l => l.startsWith('[world] recovery hold'));

test('an engine error inside a tick: one replay from the baseline, its hold logged; the log replays to the same state', async t => {
  const w = await world(t);
  w.host.saveSnapshot(true); w.run(100);
  const before = w.host.engine.world.tick;
  w.fault();
  assert.equal(w.host.engine.world.tick, before + 1, 'the clock moved through the faulted tick');
  assert.deepEqual(w.host.glitches.byRule['engine.thrown'], {recovery: 1});
  const [hold] = holds(w.lines);
  assert.match(hold, new RegExp(`^\\[world\\] recovery hold \\d+ ms at tick ${before + 1}: 1 replays \\(101 ticks\\), [\\d.]+ ms per replayed tick; since the last snapshot 101 ticks`));
  w.run(40); w.host.stop();
  const head = {tick: w.host.engine.world.tick, hash: w.host.engine.stateHash()};
  w.db.db.prepare('DELETE FROM snapshots').run();   // the boot applies the logged recovery and replays what followed it
  const again = new WorldHost(w.db, repair, 'native-owner-lifecycle', 1e9, 'eden-local-lifecycle', {durableClockV1: true});
  t.after(() => again.stop());
  again.boot();
  while (again.engine.world.tick < head.tick) again.tickOnce();
  assert.equal(again.engine.stateHash(), head.hash, 'a boot that replays the log reaches the recovered world');
  assert.ok(!w.lines.some(l => /replay differs/.test(l)));
});

test('a recovery that ended the last process is not replayed again in its window: contained in place, named, the clock goes on', async t => {
  const w = await world(t);
  w.host.saveSnapshot(true); w.run(100);
  const at = w.host.engine.world.tick + 1;
  w.host.quarantinedStep = {id: RECOVERY_STEP_ID, name: 'step 2da2deea', fromTick: at, untilTick: at + 1200, deaths: 1};
  w.fault();
  assert.match(holds(w.lines)[0], /: 0 replays \(none ticks\)/, 'no replay');
  assert.ok(w.lines.some(l => l.startsWith(`[world] world.recovery-quarantined: a recovery ended the last process at tick ${at} (1 in a row); until tick ${at + 1200}`)));
  assert.equal(w.host.glitches.byRule['world.recovery-quarantined']?.contained, 1);
  w.run(20);
  assert.equal(w.host.engine.world.tick, at + 20, 'the clock goes on');
  assert.ok(w.host.clockAvailable && !w.host.paused);
});

test('a jump over still ticks adds them to the replay debt at the running whole-tick cost: a recovery replays each of them', async t => {
  const w = await world(t, []);
  w.host.saveSnapshot(true); w.run(20);
  assert.ok(w.host.tickCostMs > 0, 'computed ticks keep the running cost');
  const debt = w.host.replayDebtMs, jumped = w.host.skipStats.ticksJumped, cost = w.host.tickCostMs;
  // the host's side of a jump: the world says it is still and the engine skips (here by stepping, as a replay would)
  const e = w.host.engine as unknown as {skipToV1(to: number): {ok: boolean}; step(): unknown; world: {tick: number}};
  w.host.skip = true; (w.host as unknown as {stillUntil(): unknown}).stillUntil = () => ({still: true, untilTick: null});
  e.skipToV1 = (to) => { while (e.world.tick < to) e.step(); return {ok: true}; };
  w.host.advanceTo(w.host.engine.world.tick + 2000);
  const n = w.host.skipStats.ticksJumped - jumped;
  assert.ok(n > 1000, `the still world jumped (${n} ticks)`);
  assert.ok(w.host.replayDebtMs - debt >= n * cost * 0.5, `${n} jumped ticks added ${Math.round(w.host.replayDebtMs - debt)} ms of debt (cost ${cost.toFixed(2)} ms a tick)`);
});
