// #1323 review finding 1: a recovery after the repair adoption must not lose it. The recovery baseline is still the one from
// before the adoption until the next snapshot, and the fold accepts the fact over it, so a rung 2 or 3 always comes out under
// the rules the header names, and a later boot reaches the same world.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture, invite, accept, seed, worldId} from '../../apps/server/test/native-owner-fixture.ts';
import {Db} from '../../apps/server/src/db.ts';
import {WorldHost} from '../../apps/server/src/world.ts';
import {marsFactory, GREEN_FIELD_WORLD} from '../../packages/engine-mars/src/engine.ts';
import {soulsRepairReaderV1} from '../../packages/engine-mars/src/souls-repair-reader.ts';
import {kernelHash} from '../../apps/server/src/fold.ts';

const old = await marsFactory({...GREEN_FIELD_WORLD});
const plan = {at: -1, fault: null};   // at tick `at`, in every runtime, an invariant the ladder can't refuse fires once
const faulted = (f) => { const wrap = (e) => { const fired = new WeakSet(); e.rt.invariants = [(r) => { if (r.tick === plan.at && !fired.has(r)) { fired.add(r); return plan.fault(r); } return []; }, ...e.rt.invariants]; return e; };
  return {...f, create: (w) => wrap(f.create(w)), restore: (s) => wrap(f.restore(s))}; };
const reader = soulsRepairReaderV1(faulted(old), {adopt: true});
const REPAIR = /\+souls-repair\/1/;
const head = (h) => ({tick: h.engine.world.tick, rules: h.engine.rulesVersion, engine: h.engine.stateHash(), kernel: kernelHash(h.kernel)});
const rungs = (h) => Object.values(h.glitches.byRule).reduce((n, r) => { for (const [k, v] of Object.entries(r)) n[k] = (n[k] ?? 0) + v; return n; }, {});
const run = async (h, n) => { for (let i = 0; i < n && h.clockAvailable && !h.paused; i++) { h.tickOnce(); if (i % 10 === 0) await setImmediate(); if (h.clockAvailable && !h.paused) h.drainInputs(); } };

test('a fault the ladder rewinds, just after the adoption, keeps the repair rules, and a crash boot reaches the same world', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'repair-rewind-')), path = join(dir, 'world.db'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  plan.at = -1;
  // a world made under 4.16's rules, with a snapshot from before the adoption
  const f = fixture(path, faulted(old), {durableClockV1: true}); f.brain.quiesce();
  const souls = [];
  for (const n of ['ada', 'bo']) { await invite(f, n); souls.push(await accept(f.host, f.souls.create('dev:' + n, {name: n.toUpperCase() + 'x', description: 'Rewind fixture'}))); }
  await run(f.host, 40); f.host.saveSnapshot(true); await run(f.host, 20); f.host.stop(); f.db.close();
  let live;
  { const db = new Db(path), h = new WorldHost(db, reader, seed, 1e9, worldId, {durableClockV1: true}); h.recoveryForEdge = true; h.boot();
    assert.ok(await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')));
    // the very first tick after the adoption faults, with a rule the ladder can't refuse, before any snapshot has moved the
    // baseline past the adoption (the boot's, from tick 40): rung 2 has nothing to drop, so rung 3 re-applies the adoption
    plan.at = h.engine.world.tick + 1; plan.fault = () => [{code: 'support.floating', message: 'forced', subjects: [souls[0].entity_id]}];
    await run(h, 300);
    assert.equal(h.clockAvailable, true, 'no halt'); assert.ok((rungs(h).rewind ?? 0) + (rungs(h).contained ?? 0) >= 1, JSON.stringify(h.glitches));
    const recipes = db.db.prepare("SELECT payload FROM events WHERE world_id=? AND author='world:recovery'").all(worldId).map((r) => JSON.parse(r.payload).recovery);
    assert.ok(recipes.some((r) => r.events?.some((e) => e.payload?.soulsRepairAdoptV1)), 'a recovery went back past the adoption and re-applied it: ' + JSON.stringify(recipes.map((r) => ({n: r.events.length, kinds: r.events.map((e) => e.kind + ':' + Object.keys(e.payload ?? {}).join('/')), lastRung: r.lastRung, bseq: r.baseline?.seq}))));
    assert.match(h.engine.rulesVersion, REPAIR, 'still under the repair rules after the rewind'); assert.equal(db.world(worldId).rules_version, h.engine.rulesVersion);
    live = head(h); h.stop(); db.close(); }
  for (const crash of [false, true]) {
    if (crash) { const db0 = new Db(path); db0.db.prepare('DELETE FROM snapshots WHERE world_id=? AND tick>?').run(worldId, 60); db0.close(); }
    const db = new Db(path), h = new WorldHost(db, reader, seed, 1e9, worldId, {durableClockV1: true}); h.recoveryForEdge = true; h.boot();
    assert.deepEqual(head(h), live, crash ? 'crash boot' : 'clean boot'); assert.ok(!Object.keys(h.glitches.byRule).includes('clock-frontier.replay-differs'));
    await run(h, 20); assert.equal(h.clockAvailable, true); live = head(h); h.stop(); db.close();   // the next boot starts here
  }
});

test('the adoption re-applied over a baseline from before it (another tick and state) still turns the rules on', () => {
  plan.at = -1;
  const e = reader.create(old.genesis('repair-rebase'));
  for (let i = 0; i < 10; i++) e.step();
  const before = e.snapshot();
  for (let i = 0; i < 10; i++) e.step();
  const p = e.previewSoulsRepairAdoptionV1(); assert.ok(p.ok); e.adoptSoulsRepairV1(p.transition);
  const r = reader.restore(before); assert.notEqual(r.world.tick, p.transition.tick); assert.doesNotMatch(r.rulesVersion, REPAIR);
  r.adoptSoulsRepairV1(p.transition); assert.equal(r.rulesVersion, p.transition.toRulesVersion);
  assert.throws(() => r.adoptSoulsRepairV1(p.transition), /already-adopted/);
  const forged = {...p.transition, toRulesVersion: p.transition.toRulesVersion + '+x/1'}, r2 = reader.restore(before);
  assert.throws(() => r2.adoptSoulsRepairV1(forged), /stale-or-forged/);
});

test('a launcher world whose header still names its first, older rules adopts too, and its header moves to the adopted version', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'repair-header-')), path = join(dir, 'world.db'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  plan.at = -1;
  const f = fixture(path, faulted(old), {durableClockV1: false}); f.brain.quiesce(); await run(f.host, 20);
  const first = old.rulesVersion.replace('+bodies/1', '').replace('activities/31', 'activities/29');
  assert.notEqual(first, old.rulesVersion); assert.notEqual(old.canReplayHistory?.(first), false);
  f.db.db.prepare('UPDATE worlds SET rules_version=? WHERE id=?').run(first, worldId); f.host.stop(); f.db.close();
  const db = new Db(path), h = new WorldHost(db, reader, seed, 1e9, worldId); h.boot();
  const fact = await accept(h, h.adoptSoulsRepairV1('operator:souls-repair-default')); assert.ok(fact);
  assert.equal(fact.payload.soulsRepairAdoptV1.fromRulesVersion, old.rulesVersion); assert.equal(db.world(worldId).rules_version, h.engine.rulesVersion); assert.match(h.engine.rulesVersion, REPAIR);
  await run(h, 20); const live = head(h); h.saveSnapshot(true); h.stop(); db.close();
  const db2 = new Db(path), h2 = new WorldHost(db2, reader, seed, 1e9, worldId); h2.boot(); assert.deepEqual(head(h2), live);
  assert.equal(await accept(h2, h2.adoptSoulsRepairV1('operator:souls-repair-default')), null); h2.stop(); db2.close();
});
