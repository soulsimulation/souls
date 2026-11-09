// #1378 (on #1369's fixture): one body's faults never stop everyone else's acts. A body quarantined again within the cooldown
// is held whole (every rule on it contained), so a fault that comes back under a new rule each tick ends by itself; and while
// steps do fail, only the bodies the window's faults named are refused `world.step-failing`. Fixture notes from #1369:
// #1369 quarantine/1: the repair ladder's end never halts the world. When rung 3 can't go back (its baseline won't restore, as
// #1368's make-way wait wouldn't), the bodies the fault named stop where they stand and are contained, and the clock and
// everyone else go on. The fault is real in every replay (a factory wrapper puts it in each runtime at a fixed tick), and every
// restore the ladder tries is refused, as the reader refused the stair baseline in both #1369 runs.
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
import {forgetMotion} from '../../mars/viewer/engine/runtime/invariants.ts';
import {rowsOf as glitchRows} from '../../apps/server/test/glitch-rows.ts';
import {SnapshotError} from '../../mars/viewer/engine/runtime/snapshot.ts';

const repair = await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: true});
const REFUSED = 'fixture.restore-refused: waiting directive a16 has invalid graph provenance';
function faulted(base, control) {
  const wrap = (e) => {
    const rt = e.rt, fired = new WeakSet(), step = e.step.bind(e);
    rt.invariants = [(r) => { if (r.tick === control.at && !fired.has(r)) { fired.add(r); return control.fault(r) ?? []; } if (control.every) return control.every(r) ?? []; return []; }, ...rt.invariants];
    e.step = () => { if (control.breakEvery) control.breakEvery(e); const o = step(); if (control.throwEvery) throw new Error('fixture.engine-bug'); if (control.throwNaming) throw new Error(JSON.stringify([{code: 'fixture.engine-bug', message: 'forced', subjects: [control.throwNaming]}])); return o; };
    return e;
  };
  return {...base, create: (w) => wrap(base.create(w)), restore: (s) => { if (control.restoreFails && !(control.restoreOk > 0 && control.restoreOk--)) throw new Error(REFUSED); return wrap(base.restore(s)); }};
}
async function world(t, {quarantine = true, mark = false, path = ':memory:'} = {}) {
  const control = {at: -1, fault() {}}, factory = faulted(repair, control), f = fixture(path, factory, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: true}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => null});
  t.after(() => { try { comms.close(); f.host.stop(); f.db.close(); } catch { /* a restart test closed them itself */ } });
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => { for (let i = 0; i < n && !f.host.paused; i++) { f.host.tickOnce(); await setImmediate(); if (!f.host.paused) f.host.drainInputs(); } };
  await tick();
  if (quarantine) await accept(f.host, f.host.enableQuarantineV1('test'));
  if (mark) await accept(f.host, f.host.enableQuarantineMarkV1('test'));
  const souls = {};
  for (const name of ['Ada', 'Bo', 'Cy']) {
    await invite(f, name.toLowerCase());
    const row = await accept(f.host, f.souls.create(`dev:${name.toLowerCase()}`, {name, description: 'Quarantine test'}));
    souls[name] = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  }
  await tick();
  const [ax, , az] = f.host.engine.world.entities[souls.Ada.entityId].pose.p;
  assert.notEqual(god.act({ops: [
    {op: 'place', def: 'core/zone@1', name: 'shed', shape: {area: [[ax + 7, az - 2], [ax + 10, az - 2], [ax + 10, az + 2], [ax + 7, az + 2]]}},
    {op: 'place', def: 'core/zone@1', name: 'yard', shape: {area: [[ax - 10, az - 2], [ax - 7, az - 2], [ax - 7, az + 2], [ax - 10, az + 2]]}},
  ]}).accepted, false);
  await tick(30);
  return {f, edge, god, comms, tick, souls, control, factory};
}
const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); };
const onDisk = (t) => { const dir = mkdtempSync(join(tmpdir(), 'quarantine-')); t.after(() => rmSync(dir, {recursive: true, force: true})); return join(dir, 'world.db'); };
const ok = (r) => { assert.notEqual(r.accepted, false, JSON.stringify(r)); return r; };
const act = (w, s, input) => accept(w.f.host, w.edge.act(s, input));
const read = (w, s, r) => w.edge.receipt(s.soulId, r.receipt?.id ?? r.id);
const byRung = (h) => Object.values(h.glitches.byRule).reduce((n, r) => { for (const [k, v] of Object.entries(r)) n[k] = (n[k] ?? 0) + v; return n; }, {});
const rowsOf = (w) => glitchRows(w.f.db);
const running = (h) => h.clockAvailable && !h.paused && !h.engineFault;
// every boot of the log, from its snapshot and from genesis, reaches the live head (restores work again: the reader was fixed)
const bootsAgree = (w, path) => {
  const h = w.f.host, hash = h.engine.stateHash(), tick = h.engine.world.tick; w.control.restoreFails = false; w.comms.close(); h.stop(); w.f.db.close();
  for (const from of ['snapshot', 'genesis']) {
    const db = new Db(path); if (from === 'genesis') db.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(worldId);
    const b = new WorldHost(db, w.factory, seed, 1e9, worldId, {durableClockV1: true}), booted = b.boot();
    if (from === 'genesis') assert.equal(booted.from, 'genesis');
    assert.equal(b.engine.world.tick, tick, from); assert.equal(b.engine.stateHash(), hash, from); b.stop(); db.close();
  }
};
// rung 1 has no answer for a floating body (nothing moved it), rung 2's replays fault the same way, and rung 3's restore is refused
async function unrestorable(w, s, rule = 'support.floating') {
  const h = w.f.host; w.control.restoreFails = true; w.control.fault = () => [{code: rule, message: 'forced', subjects: [s.entityId]}]; w.control.at = h.engine.world.tick + 3;
  await w.tick(8); return h.engine.world.tick;
}


const glitchRowsQ = (w) => rowsOf(w).filter((r) => r.evidence?.quarantine);

test('#1378 A2 A4 a body faulting under a new rule every tick is held whole after its second quarantine: nobody else is refused, the stretch ends, every boot agrees', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  w.control.restoreFails = true; let n = 0;
  w.control.every = () => [{code: `support.floating-${++n}`, message: 'forced', subjects: [Ada.entityId]}];
  await w.tick(250);
  const report = () => JSON.stringify({stepFailing: h.stepFailing?.slice(0, 120), glitches: h.glitches.byRule}).slice(0, 600);
  assert.ok(n >= 250, 'the fault kept coming');
  assert.equal(h.stepFailing, null, `never step-failing: ${report()}`); assert.equal(byRung(h).halt ?? 0, 0, report());
  const q = glitchRowsQ(w); assert.equal(q.length, 2, `two quarantines, then held whole: ${report()}`);
  assert.ok(q.every((r) => r.bodies.length === 1 && r.bodies[0] === Ada.entityId));
  const second = w.f.db.events(worldId, 0).filter((e) => e.payload?.quarantineV1).at(-1).payload.quarantineV1;
  assert.ok(second.contained.some((c) => c.code === '*' && c.subjects[0] === Ada.entityId), 'the second holds every rule on her, logged');
  const bo = ok(await act(w, Bo, {capability: 'walk:yard'})), cy = ok(await act(w, Cy, {capability: 'walk:shed'}));
  await w.tick(500);
  assert.equal(read(w, Bo, bo).phase, 'completed', report()); assert.equal(read(w, Cy, cy).phase, 'completed', report());
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);   // the fault stays on: it is real in every replay too
});

test('#1378 A1 A3 while steps fail on one body, a bystander acts and completes; the body named is refused', {timeout: 300000}, async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const far = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(5);
  w.control.restoreFails = true; w.control.throwNaming = Ada.entityId;   // every restore refused, as in #1369; a step bug that names her: containing her rules can't stop a throw
  await w.tick(150);
  const report = () => JSON.stringify({stepFailing: h.stepFailing?.slice(0, 120), glitches: h.glitches.byRule}).slice(0, 600);
  assert.ok(h.stepFailing, `steps are failing: ${report()}`); assert.ok(running(h), report());
  assert.equal(h.stepFailingFor(Ada.entityId), true); assert.equal(h.stepFailingFor(Cy.entityId), false);
  const refused = await act(w, Ada, {capability: 'walk:shed'}); assert.equal(refused.accepted, false); assert.equal(refused.code, 'world.step-failing');
  const cy = ok(await act(w, Cy, {capability: 'walk:shed'}));
  assert.notEqual(read(w, Bo, far).code, 'world.rewound', 'Bo was not stopped world-wide');
  assert.equal(rowsOf(w).filter((r) => r.evidence?.inPlace).length, 0, `nothing stopped world-wide: ${report()}`);
  w.control.throwNaming = null; await w.tick(600);
  assert.equal(h.stepFailing, null, 'the stretch ends'); assert.equal(read(w, Cy, cy).phase, 'completed', report());
  assert.equal(read(w, Bo, far).phase, 'completed', report());
  assert.equal(h.glitches.byRule['engine.step-failing']?.halt, 1); assert.deepEqual(rowsOf(w).find((r) => r.rule === 'engine.step-failing').evidence.refused, [Ada.entityId]);
});

test('#1378 A1 a step-failing stretch whose faults name no body still refuses everyone (#1377 attributes those)', {timeout: 300000}, async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Cy} = w.souls;
  w.control.throwEvery = true; await w.tick(150);
  assert.ok(h.stepFailing); assert.equal(h.stepFailingFor(Cy.entityId), true);
  const r = await act(w, Cy, {capability: 'walk:shed'}); assert.equal(r.accepted, false); assert.equal(r.code, 'world.step-failing');
  w.control.throwEvery = false; await w.tick(200); assert.equal(h.stepFailing, null);
});

// #1377 (b): a body a bug breaks again every tick. Each time only its own programmes stop and it is held whole again; the glitch
// row is written at most twice a cooldown; nobody else is stopped and the world never halts (engine.unhashable included).
test('#1377 B1-B4 a body broken every tick is held again each time, alone: bystanders complete, nothing stops world-wide, rows are bounded, boots agree', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const early = ok(await act(w, Bo, {capability: 'walk:yard'})); ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  w.control.restoreFails = true;
  // in the engine's own step, for a fixed stretch of ticks: real in every replay too
  let broken = 0; const from = h.engine.world.tick + 1, to = from + 400;
  w.control.breakEvery = (e) => { const tk = e.world.tick; if (tk < from || tk >= to) return; const b = e.world.entities[Ada.entityId]; if (b?.pose) { b.pose.p = [NaN, b.pose.p[1], b.pose.p[2]]; broken++; forgetMotion(e.rt); } };
  await w.tick(30);
  const mid = ok(await act(w, Cy, {capability: 'walk:shed'}));
  for (let i = 0; i < 370; i++) { h.tickOnce(); if (i % 10 === 0) { await setImmediate(); h.drainInputs(); } }
  const report = () => JSON.stringify({clock: h.clockAvailable, paused: h.paused, fault: String(h.engineFault ?? "").slice(0, 200), glitches: h.glitches.byRule, stepFailing: h.stepFailing?.slice(0, 100)}).slice(0, 700);
  assert.ok(broken >= 390, 'broken every tick: ' + broken);
  // every tick faults by construction, so steps are failing: that names Ada alone (#1378), and nothing else halts
  assert.ok(running(h), report()); assert.equal((byRung(h).halt ?? 0) - (h.glitches.byRule['engine.step-failing']?.halt ?? 0), 0, report());
  if (h.stepFailing) { assert.equal(h.stepFailingFor(Cy.entityId), false); assert.equal(h.stepFailingFor(Ada.entityId), true); }
  assert.equal(rowsOf(w).filter((r) => r.evidence?.inPlace).length, 0, `no stop-all: ${report()}`);
  assert.equal(w.f.db.events(worldId, 0).filter((e) => e.payload?.lastRungInPlace).length, 0, 'no stop-all event');
  assert.ok(rowsOf(w).filter((r) => r.evidence?.quarantine).length <= 2, `glitch rows bounded: ${report()}`);
  assert.ok(h.engine.world.entities[Ada.entityId].pose.p.every(Number.isFinite), 'held whole again');
  await w.tick(400);
  assert.equal(read(w, Bo, early).phase, 'completed', report()); assert.equal(read(w, Cy, mid).phase, 'completed', report());
  const again = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(500); assert.equal(read(w, Ada, again).phase, 'completed', 'Ada acts again once the bug stops');
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});

test('#1440 under quarantine-mark/1 a body broken every tick writes a bounded number of events: a standing mark holds it, bystanders complete, boots agree', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path, mark: true}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const early = ok(await act(w, Bo, {capability: 'walk:yard'})); ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  w.control.restoreFails = true;
  // in the engine's own step, for a fixed stretch of ticks: real in every replay too
  let broken = 0; const from = h.engine.world.tick + 1, to = from + 400;
  w.control.breakEvery = (e) => { const tk = e.world.tick; if (tk < from || tk >= to) return; const b = e.world.entities[Ada.entityId]; if (b?.pose) { b.pose.p = [NaN, b.pose.p[1], b.pose.p[2]]; broken++; forgetMotion(e.rt); } };
  await w.tick(30);
  const mid = ok(await act(w, Cy, {capability: 'walk:shed'}));
  for (let i = 0; i < 370; i++) { h.tickOnce(); if (i % 10 === 0) { await setImmediate(); h.drainInputs(); } }
  const report = () => JSON.stringify({clock: h.clockAvailable, paused: h.paused, fault: String(h.engineFault ?? "").slice(0, 200), glitches: h.glitches.byRule, stepFailing: h.stepFailing?.slice(0, 100)}).slice(0, 700);
  assert.ok(broken >= 390, 'broken every tick: ' + broken);
  // every tick faults by construction, so steps are failing: that names Ada alone (#1378), and nothing else halts
  assert.ok(running(h), report()); assert.equal((byRung(h).halt ?? 0) - (h.glitches.byRule['engine.step-failing']?.halt ?? 0), 0, report());
  if (h.stepFailing) { assert.equal(h.stepFailingFor(Cy.entityId), false); assert.equal(h.stepFailingFor(Ada.entityId), true); }
  assert.equal(rowsOf(w).filter((r) => r.evidence?.inPlace).length, 0, `no stop-all: ${report()}`);
  assert.equal(w.f.db.events(worldId, 0).filter((e) => e.payload?.lastRungInPlace).length, 0, 'no stop-all event');
  assert.ok(rowsOf(w).filter((r) => r.evidence?.quarantine).length <= 2, `glitch rows bounded: ${report()}`);
  assert.ok(h.engine.world.entities[Ada.entityId].pose.p.every(Number.isFinite), 'held whole again');
  const events = w.f.db.events(worldId, 0).filter((e) => e.payload?.quarantineV1);
  assert.ok(events.length <= 3 + 2, `bounded: ${events.length} quarantine events for ${broken} broken ticks`);
  assert.equal(events.filter((e) => e.payload.quarantineV1.standing?.length).length, 1, 'one standing mark');
  await w.tick(400);
  assert.equal(read(w, Bo, early).phase, 'completed', report()); assert.equal(read(w, Cy, mid).phase, 'completed', report());
  const again = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(500); assert.equal(read(w, Ada, again).phase, 'completed', 'Ada acts again once the bug stops');
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});

test('#1440 under quarantine-mark/1 a body broken inside the engine step every tick (review) is held by the mark too: bounded events, bystanders complete, boots agree', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path, mark: true}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const early = ok(await act(w, Bo, {capability: 'walk:yard'})); ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  w.control.restoreFails = true;
  // in the engine's own step, for a fixed stretch of ticks: real in every replay too
  let broken = 0; const from = h.engine.world.tick + 1, to = from + 400;
  // inside rt.step, in its end-of-tick invariant pass (the fixture's first invariant), after every other system has moved
  let last = -1; w.control.every = (r) => { const tk = r.tick; if (tk < from || tk >= to || tk === last) return []; last = tk; const b = r.world.entities[Ada.entityId]; if (b?.pose) { b.pose.p = [NaN, b.pose.p[1], b.pose.p[2]]; broken++; forgetMotion(r); } return []; };
  await w.tick(30);
  const mid = ok(await act(w, Cy, {capability: 'walk:shed'}));
  for (let i = 0; i < 370; i++) { h.tickOnce(); if (i % 10 === 0) { await setImmediate(); h.drainInputs(); } }
  const report = () => JSON.stringify({clock: h.clockAvailable, paused: h.paused, fault: String(h.engineFault ?? "").slice(0, 200), glitches: h.glitches.byRule, stepFailing: h.stepFailing?.slice(0, 100)}).slice(0, 700);
  assert.ok(broken >= 390, 'broken every tick: ' + broken);
  // every tick faults by construction, so steps are failing: that names Ada alone (#1378), and nothing else halts
  assert.ok(running(h), report()); assert.equal((byRung(h).halt ?? 0) - (h.glitches.byRule['engine.step-failing']?.halt ?? 0), 0, report());
  if (h.stepFailing) { assert.equal(h.stepFailingFor(Cy.entityId), false); assert.equal(h.stepFailingFor(Ada.entityId), true); }
  assert.equal(rowsOf(w).filter((r) => r.evidence?.inPlace).length, 0, `no stop-all: ${report()}`);
  assert.equal(w.f.db.events(worldId, 0).filter((e) => e.payload?.lastRungInPlace).length, 0, 'no stop-all event');
  assert.ok(rowsOf(w).filter((r) => r.evidence?.quarantine).length <= 2, `glitch rows bounded: ${report()}`);
  assert.ok(h.engine.world.entities[Ada.entityId].pose.p.every(Number.isFinite), 'held whole again');
  const events = w.f.db.events(worldId, 0).filter((e) => e.payload?.quarantineV1);
  assert.ok(events.length <= 3 + 2, `bounded: ${events.length} quarantine events for ${broken} broken ticks`);
  assert.equal(events.filter((e) => e.payload.quarantineV1.standing?.length).length, 1, 'one standing mark');
  await w.tick(400);
  assert.equal(read(w, Bo, early).phase, 'completed', report()); assert.equal(read(w, Cy, mid).phase, 'completed', report());
  const again = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(500); assert.equal(read(w, Ada, again).phase, 'completed', 'Ada acts again once the bug stops');
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});
