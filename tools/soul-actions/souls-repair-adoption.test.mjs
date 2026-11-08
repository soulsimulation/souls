// #1323 (hotfix 4.16.1): the repair rules on by default. A world whose history began without them boots under its own rules,
// adopts them in one logged fact at its head, and a later boot (clean or crash) replays that fact and reaches the same world.
// The fault is the Eden incident's: the world sets a still body down inside a static at a fixed tick, in every runtime, as
// the balloon's step-out did to Kino. Under 4.16 that halts, and a reboot halts again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, seed, worldId} from '../../apps/server/test/native-owner-fixture.ts';
import {Db} from '../../apps/server/src/db.ts';
import {WorldHost} from '../../apps/server/src/world.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {marsFactory, GREEN_FIELD_WORLD} from '../../packages/engine-mars/src/engine.ts';
import {soulsRepairReaderV1} from '../../packages/engine-mars/src/souls-repair-reader.ts';
import {acknowledgeRelocation} from '../../mars/viewer/engine/runtime/invariants.ts';
import {kernelHash} from '../../apps/server/src/fold.ts';

// 4.16 as production runs it: no repair rules, no shared carry
const old = await marsFactory({...GREEN_FIELD_WORLD, soulsRepairV1: false});
const plan = {at: -1, who: '', to: null};   // at tick `at` the world itself sets body `who` down at `to` (inside a table)
const wrap = (e) => {
  const rt = e.rt, fired = new WeakSet();
  rt.invariants = [(r) => { if (r.tick === plan.at && !fired.has(r)) { fired.add(r); const b = r.world.entities[plan.who]; if (b) { b.pose.p = [plan.to[0], b.pose.p[1], plan.to[1]]; acknowledgeRelocation(r, plan.who); } } return []; }, ...rt.invariants];
  return e;
};
const faulted = (f) => ({...f, create: (w) => wrap(f.create(w)), restore: (s) => wrap(f.restore(s))});
const reader = (adopt) => soulsRepairReaderV1(faulted(old), {adopt});
const REPAIR = /\+souls-repair\/1/;
const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };
const boot = (path, factory) => { const db = new Db(path), h = new WorldHost(db, factory, seed, 1e9, worldId, {durableClockV1: true}); h.recoveryForEdge = true; return {db, h}; };
const head = (h) => ({tick: h.engine.world.tick, rules: h.engine.rulesVersion, engine: h.engine.stateHash(), kernel: kernelHash(h.kernel)});
const adoptions = (db) => db.db.prepare("SELECT seq,tick,payload FROM events WHERE world_id=? AND kind='rules' AND json_extract(payload,'$.soulsRepairAdoptV1.contract') IS NOT NULL").all(worldId);
const refusals = (db) => db.db.prepare("SELECT payload FROM events WHERE author='world:refusal'").all().map((e) => JSON.parse(e.payload).refusal);
const halts = (h) => Object.values(h.glitches.byRule).reduce((n, r) => n + (r.halt ?? 0), 0);
const run = async (h, n) => { for (let i = 0; i < n && h.clockAvailable && !h.paused; i++) { h.tickOnce(); if (i % 10 === 0) await setImmediate(); if (h.clockAvailable && !h.paused) h.drainInputs(); } };

/** The incident world, halted under 4.16's rules: a durable clock, two Souls, a god's table, a snapshot before the fault. */
async function haltedWorld(t, path, moving) {
  const f = fixture(path, faulted(old), {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: false}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => null});
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const host = f.host;
  await run(host, 5);
  const souls = {};
  for (const name of ['Ada', 'Bo']) {
    await invite(f, name.toLowerCase());
    const row = await accept(host, f.souls.create(`dev:${name.toLowerCase()}`, {name, description: 'Repair adoption fixture'}));
    souls[name] = {soulId: row.id, entityId: row.entity_id};
  }
  await run(host, 30);
  const {Bo} = souls, [x, , z] = host.engine.world.entities[Bo.entityId].pose.p;
  assert.notEqual(god.act({ops: [{op: 'place', def: 'core/table@1', name: 'reading-table', p: [x + 4, z]}]}).accepted, false);
  if (moving) assert.notEqual(god.act({ops: [{op: 'place', def: 'core/zone@1', name: 'yard', shape: {area: [[x - 14, z - 2], [x - 10, z - 2], [x - 10, z + 2], [x - 14, z + 2]]}}]}).accepted, false);
  await run(host, 10);
  if (moving) { const r = await accept(host, edge.act({...Bo, name: 'Bo', owner: 'dev:bo'}, {capability: 'walk:yard'})); assert.notEqual(r.accepted, false, JSON.stringify(r)); await run(host, 3); assert.ok(host.engine.programOf(Bo.entityId), 'Bo walks'); }
  host.saveSnapshot(true);
  plan.at = host.engine.world.tick + 5; plan.who = Bo.entityId; plan.to = [x + 4, z];
  await run(host, 40);
  assert.equal(host.clockAvailable, false, '4.16 halts'); assert.deepEqual(Object.keys(host.glitches.byRule), ['collision.human-static']);
  const rules = host.engine.rulesVersion; assert.doesNotMatch(rules, REPAIR);
  comms.close(); host.stop(); f.db.close();
  // a plain restart under 4.16's reader halts again
  { const {db, h} = boot(path, faulted(old)); h.boot(); await run(h, 20); assert.equal(h.clockAvailable, false, 'a 4.16 restart halts again'); h.stop(); db.close(); }
  return {Bo, rules};
}

for (const moving of [false, true])
test(`R2 R3 R4 R5 R7 R8 the halted world (${moving ? 'body walking under a programme' : 'still body'}) adopts the repair rules at its head, carries on, and every later boot reaches the same world`, async (t) => {
  quiet(t);
  const dir = mkdtempSync(join(tmpdir(), 'repair-adopt-')), path = join(dir, 'world.db'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const {Bo, rules} = await haltedWorld(t, path, moving);

  // R2: the old history boots under its own rules, then one logged fact at the head
  let live, fact;
  { const {db, h} = boot(path, reader(true)); const from = h.boot(); assert.equal(h.engine.rulesVersion, rules); const at = h.engine.world.tick, haltsBefore = halts(h);
    fact = await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default'));
    assert.ok(fact, 'adopted'); const a = fact.payload.soulsRepairAdoptV1;
    assert.deepEqual({contract: a.contract, tick: a.tick, from: a.fromRulesVersion}, {contract: 'souls-repair-adoption/1', tick: at, from: rules});
    assert.match(a.toRulesVersion, REPAIR); assert.equal(a.toRulesVersion.replace('+souls-repair/1', ''), rules);
    assert.equal(h.engine.rulesVersion, a.toRulesVersion); assert.equal(db.world(worldId).rules_version, a.toRulesVersion, 'the header moves in the same acceptance');
    assert.equal(adoptions(db).length, 1); assert.equal(from.from, 'snapshot');
    // R7: the clock runs on past the fault, nothing halts, nothing stands broken, the body is put somewhere legal
    await run(h, 1200);
    assert.equal(h.clockAvailable, true, 'no halt'); assert.equal(halts(h), haltsBefore, 'no new halt'); assert.ok(h.engine.world.tick >= plan.at + 1100, 'a minute of world time on');
    assert.deepEqual(h.engine.runtime.violations.filter((v) => v.tick > at), [], 'no standing violation');
    const mine = refusals(db).filter((r) => r.bodies?.includes(Bo.entityId));
    assert.ok(mine.length >= 1, 'the bad step is refused or repaired'); assert.equal(mine[0].rule, 'collision.human-static');
    if (!moving) { assert.equal(mine[0].relocated, true, 'a still body is relocated'); const to = mine[0].poses[Bo.entityId].p;
      assert.ok(Math.hypot(to[0] - plan.to[0], to[2] - plan.to[1]) > 0.3, `the row records where it was put: ${JSON.stringify(to)}`); }
    // R8: no re-landing loop
    assert.ok(mine.filter((r) => r.relocated).length <= 1, `relocated once at most: ${JSON.stringify(mine)}`);
    const b = h.engine.world.entities[Bo.entityId];
    assert.ok(Math.hypot(b.pose.p[0] - plan.to[0], b.pose.p[2] - plan.to[1]) > 0.3, 'not left inside the table');
    assert.ok(!Object.keys(h.glitches.byRule).includes('clock-frontier.replay-differs'));
    live = head(h); h.stop(); db.close(); }

  // R3 + R4: a clean boot reaches the live head and adopts nothing more
  { const {db, h} = boot(path, reader(true)); h.boot(); assert.deepEqual(head(h), live);
    assert.equal(await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')), null); assert.equal(adoptions(db).length, 1);
    assert.ok(!Object.keys(h.glitches.byRule).includes('clock-frontier.replay-differs')); h.stop(); db.close(); }
  // R3: a crash boot with no snapshot since the adoption replays the fact before the clock check, through the fault
  { const db0 = new Db(path); db0.db.prepare('DELETE FROM snapshots WHERE world_id=? AND tick>=?').run(worldId, fact.tick); db0.close();
    const {db, h} = boot(path, reader(true)); assert.equal(h.boot().from, 'snapshot'); assert.deepEqual(head(h), live);
    assert.equal(await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')), null); assert.equal(adoptions(db).length, 1);
    assert.ok(!Object.keys(h.glitches.byRule).includes('clock-frontier.replay-differs')); h.stop(); db.close(); }
  // R5: SIM_SOULS_REPAIR=0 is ignored for an adopted world (it boots under the rules it has), and 4.16's reader refuses it
  { const {db, h} = boot(path, reader(false)); h.boot(); assert.deepEqual(head(h), live); await run(h, 20); assert.equal(h.clockAvailable, true); h.stop(); db.close(); }
  { const {db, h} = boot(path, faulted(old)); assert.throws(() => h.boot(), /clock-frontier\.rules-incompatible|history rules are incompatible/); db.close(); }
});

test('R5 SIM_SOULS_REPAIR=0 adopts nothing: an unadopted world boots and runs exactly as under 4.16', async (t) => {
  quiet(t); plan.at = -1;
  const dir = mkdtempSync(join(tmpdir(), 'repair-off-')), path = join(dir, 'world.db'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const f = fixture(path, reader(false), {durableClockV1: true}); f.brain.quiesce();
  assert.equal(await accept(f.host, f.host.adoptSoulsRepairV1('operator:souls-repair-default')), null);
  await invite(f, 'ada'); await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'Opt-out fixture'})); await run(f.host, 100);
  const live = head(f.host); assert.doesNotMatch(live.rules, REPAIR); assert.equal(adoptions(f.db).length, 0); f.host.saveSnapshot(true); f.host.stop(); f.db.close();
  // 4.16's own reader boots it to the same world, from its snapshot and from genesis
  for (const mode of ['snapshot', 'genesis']) {
    if (mode === 'genesis') { const db0 = new Db(path); db0.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(worldId); db0.close(); }
    const {db, h} = boot(path, faulted(old)); assert.equal(h.boot().from, mode); assert.deepEqual(head(h), live, mode); h.stop(); db.close();
  }
});

test('R1 R4 a new world adopts at tick 0, and a history that began under the repair rules is never adopted twice', async (t) => {
  quiet(t); plan.at = -1;
  const dir = mkdtempSync(join(tmpdir(), 'repair-born-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  // a new world under the server's default reader: born under the old rules, adopts at its first boot, before any tick
  { const path = join(dir, 'new.db'), f = fixture(path, reader(true), {durableClockV1: true}); f.brain.quiesce();
    const tick = f.host.engine.world.tick, fact = await accept(f.host, f.host.adoptSoulsRepairV1('operator:souls-repair-default'));
    assert.equal(fact.payload.soulsRepairAdoptV1.tick, tick); assert.match(f.host.engine.rulesVersion, REPAIR); assert.match(f.db.world(worldId).rules_version, REPAIR);
    await invite(f, 'ada'); await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'New world'})); await run(f.host, 100);
    const live = head(f.host); f.host.saveSnapshot(true); f.host.stop(); f.db.close();
    for (const mode of ['snapshot', 'genesis']) {
      if (mode === 'genesis') { const db0 = new Db(path); db0.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(worldId); db0.close(); }
      const {db, h} = boot(path, reader(true)); assert.equal(h.boot().from, mode); assert.deepEqual(head(h), live, mode);
      assert.equal(await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')), null); assert.equal(adoptions(db).length, 1); h.stop(); db.close();
    } }
  // a world made under the rules (SIM_SOULS_REPAIR=1 or shared building in 4.16): no adoption fact, genesis runs them
  { const path = join(dir, 'born.db'), born = faulted(await marsFactory({...GREEN_FIELD_WORLD, soulsRepairV1: true})), f = fixture(path, born, {durableClockV1: true}); f.brain.quiesce();
    await invite(f, 'ada'); await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'Born under repair'})); await run(f.host, 100);
    const live = head(f.host); assert.match(live.rules, REPAIR); f.host.saveSnapshot(true); f.host.stop(); f.db.close();
    for (const mode of ['snapshot', 'genesis']) {
      if (mode === 'genesis') { const db0 = new Db(path); db0.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(worldId); db0.close(); }
      const {db, h} = boot(path, reader(true)); assert.equal(h.boot().from, mode); assert.deepEqual(head(h), live, mode);
      assert.equal(await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')), null); assert.equal(adoptions(db).length, 0, 'never adopted'); h.stop(); db.close();
    } }
});
