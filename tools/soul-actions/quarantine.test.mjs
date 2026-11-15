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
    e.step = () => { const o = step(); if (control.throwEvery) throw new Error('fixture.engine-bug'); return o; };
    return e;
  };
  return {...base, create: (w) => wrap(base.create(w)), restore: (s) => { if (control.restoreFails && !(control.restoreOk > 0 && control.restoreOk--)) throw new Error(REFUSED); return wrap(base.restore(s)); }};
}
async function world(t, {quarantine = true, path = ':memory:'} = {}) {
  const control = {at: -1, fault() {}}, factory = faulted(repair, control), f = fixture(path, factory, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: true}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => null});
  t.after(() => { try { comms.close(); f.host.stop(); f.db.close(); } catch { /* a restart test closed them itself */ } });
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => { for (let i = 0; i < n && !f.host.paused; i++) { f.host.tickOnce(); await setImmediate(); if (!f.host.paused) f.host.drainInputs(); } };
  await tick();
  if (quarantine) await accept(f.host, f.host.enableQuarantineV1('test'));
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

test('without quarantine/1 a refused rung 3 restore halts the world (the #1369 shape)', async (t) => {
  quiet(t); const w = await world(t, {quarantine: false}), h = w.f.host;
  ok(await act(w, w.souls.Ada, {capability: 'walk:shed'})); await w.tick(10);
  await unrestorable(w, w.souls.Ada);
  assert.equal(running(h), false, 'halted'); assert.deepEqual(h.glitches.byRule['durability.checkpoint'], {halt: 1});
});

test('Q1 a refused rung 3 restore quarantines the one body: no halt, a contained row, the others walk on, the clock runs 600 ticks, and every boot agrees', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})), far = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(10);
  const seq0 = h.seq, at = await unrestorable(w, Ada);
  assert.ok(running(h), 'the clock is available'); assert.equal(byRung(h).halt ?? 0, 0, JSON.stringify(h.glitches));
  const rows = rowsOf(w).filter((r) => r.evidence?.quarantine);
  assert.equal(rows.length, 1, JSON.stringify(rowsOf(w))); assert.equal(rows[0].rung, 'contained'); assert.equal(rows[0].rule, 'support.floating'); assert.deepEqual(rows[0].bodies, [Ada.entityId]);
  assert.match(String(rows[0].evidence.restore), /fixture\.restore-refused/, 'the restore error is the evidence');
  const ev = w.f.db.events(worldId, seq0).filter((e) => e.payload?.quarantineV1);
  assert.equal(ev.length, 1); assert.deepEqual(ev[0].payload.quarantineV1.bodies, [Ada.entityId]); assert.deepEqual(ev[0].payload.quarantineV1.souls, [Ada.soulId]);
  const x = read(w, Ada, walk); assert.equal(x.phase, 'failed', JSON.stringify(x)); assert.equal(x.code, 'world.quarantined');
  assert.equal(read(w, Bo, far).phase, 'started', 'Bo was not stopped');
  assert.ok(w.comms.streams.read(Ada.soulId, 0).events.some((e) => e.kind === 'world.quarantined'), 'Ada hears it');
  assert.ok(!w.comms.streams.read(Bo.soulId, 0).events.some((e) => e.kind === 'world.quarantined' || e.kind === 'world.rewound'), 'Bo hears nothing');
  w.control.fault = () => []; await w.tick(20); for (let i = 0; i < 8; i++) await setImmediate();
  assert.ok((w.f.db.latestSnapshot(worldId)?.tick ?? -1) > ev[0].tick, 'a snapshot past the fault is taken at once, so a restart never boots from the baseline that would not restore');
  await w.tick(580);
  assert.ok(h.engine.world.tick >= at + 590, `600 ticks on (${h.engine.world.tick - at})`); assert.ok(running(h));
  assert.equal(read(w, Bo, far).phase, 'completed', 'Bo arrives');
  const again = ok(await act(w, Ada, {capability: 'walk:yard'})), cy = ok(await act(w, Cy, {capability: 'walk:shed'})); await w.tick(500);
  assert.equal(read(w, Ada, again).phase, 'completed', 'Ada acts again'); assert.equal(read(w, Cy, cy).phase, 'completed');
  assert.equal(byRung(h).halt ?? 0, 0);
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});

test('Q1 the same fault coming back on the head is quarantined again, never rewound world-wide or halted', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls;
  const far = ok(await act(w, Bo, {capability: 'walk:yard'})); await unrestorable(w, Ada); w.control.fault = () => [];
  await w.tick(20); ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  const at2 = h.engine.world.tick + 3; w.control.every = (r) => (r.tick === at2 ? [{code: 'stair.unsupported', message: 'forced', subjects: [Ada.entityId]}] : []); await w.tick(8);   // the wrapper fires `fault` once per runtime
  assert.ok(running(h)); assert.equal(byRung(h).halt ?? 0, 0); assert.equal(byRung(h).rewind ?? 0, 0, JSON.stringify(h.glitches));
  assert.equal(rowsOf(w).filter((r) => r.evidence?.quarantine).length, 2, JSON.stringify(rowsOf(w).map((r) => [r.rung, r.rule, r.tick, r.evidence.quarantine, String(r.evidence.reason).slice(0, 80)]))); assert.notEqual(read(w, Bo, far).code, 'world.rewound');
});

test('Q1 rung 2 restores and replays part way, rung 3 is refused: the world goes on from the head it had, not a half-replayed one', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path}), h = w.f.host, {Ada, Bo} = w.souls;
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})), far = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(10);
  const head = h.engine, prog = h.engine.programOf(Bo.entityId);
  w.control.restoreOk = 2; await unrestorable(w, Ada);   // rung 2's two plans restore and fault again in their replays; rung 3's restores are refused
  assert.equal(w.control.restoreOk, 0, 'rung 2 really restored twice'); assert.equal(h.engine, head, 'the head engine runs');
  assert.ok(running(h)); assert.equal(byRung(h).halt ?? 0, 0); assert.equal(read(w, Ada, walk).code, 'world.quarantined');
  assert.equal(h.engine.programOf(Bo.entityId), prog, "Bo's programme is the one he had"); w.control.fault = () => []; await w.tick(600);
  assert.equal(read(w, Bo, far).phase, 'completed'); h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});

test('Q1 a baseline that will not materialize is no halt either', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada} = w.souls;
  h.recoveryCapture = () => { throw new Error('fixture.checkpoint-iterator-broke'); };
  w.control.fault = () => [{code: 'support.floating', message: 'forced', subjects: [Ada.entityId]}]; w.control.at = h.engine.world.tick + 2; await w.tick(6);
  assert.ok(running(h)); assert.equal(byRung(h).halt ?? 0, 0); assert.match(String(rowsOf(w).find((r) => r.evidence?.quarantine)?.evidence.restore), /checkpoint-iterator-broke/);
});

test('Q2 a failed write is still the one halt', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, append = w.f.db.appendEvent.bind(w.f.db);
  w.f.db.appendEvent = (id, e) => { if (e.payload?.quarantineV1) throw new Error('fixture.disk-full'); return append(id, e); };
  await unrestorable(w, w.souls.Ada);
  assert.equal(running(h), false); assert.deepEqual(h.glitches.byRule['durability.repair'], {halt: 1});
});

test('Q4 quarantine/1 is one logged rule, adopted once', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host; await accept(h, h.enableQuarantineV1('again'));
  const rows = w.f.db.db.prepare("SELECT payload FROM events WHERE kind='rules' AND payload LIKE '%quarantineV1%'").all();
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].payload).runtimePolicy.quarantineV1, true);
});

// #1376: the manual and the repair snapshot, as #1375 made the periodic one
test('Q5 a refused manual snapshot is named and contained: the caller hears pending, and the world ticks on', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, before = w.f.db.latestSnapshot(worldId)?.tick ?? -1;
  const mock = t.mock.method(h.engine, 'snapshot', () => { throw new SnapshotError('snapshot.unencodable', 'fixture: a function in the state'); });
  const seq0 = h.seq, r = h.saveSnapshot(true); assert.equal(r.pending, true); mock.mock.restore();
  assert.ok(w.f.db.events(worldId, seq0).some((e) => e.payload?.checkpoint === 'unsnappable-head'), 'the head is logged as not durable, as for a head that cannot snapshot');
  assert.ok(running(h)); assert.deepEqual(h.glitches.byRule['durability.snapshot-skipped'], {contained: 1});
  assert.equal(w.f.db.latestSnapshot(worldId)?.tick ?? -1, before, 'nothing written');
  const t0 = h.engine.world.tick; await w.tick(30); assert.equal(h.engine.world.tick, t0 + 30);
  assert.throws(() => { t.mock.method(h.engine, 'snapshot', () => { throw new Error('fixture.corrupt'); }); h.saveSnapshot(true); }, /fixture\.corrupt/, 'other capture faults still propagate');
});

test('Q5 a refused repair snapshot leaves the repair standing and the world running', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada} = w.souls;
  t.mock.method(h, 'captureHead', () => { throw new SnapshotError('snapshot.unencodable', 'fixture: a function in the state'); });
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  w.control.fault = () => [{code: 'support.floating', message: 'forced', subjects: [Ada.entityId]}]; w.control.at = h.engine.world.tick + 2; await w.tick(10);
  assert.ok(running(h)); assert.equal(byRung(h).halt ?? 0, 0, JSON.stringify(h.glitches)); assert.ok((h.glitches.byRule['durability.snapshot-skipped']?.contained ?? 0) >= 1, JSON.stringify(h.glitches));
});

// A6(b) chaos: one entity's state is corrupted between ticks, as a bug elsewhere would leave it, and every restore the ladder
// tries is refused. Whatever the ladder makes of it, the tick loop never stops: 600 ticks later the clock has moved 600 ticks,
// nothing halted, and a bystander who sets off after the corruption gets where she was going.
const CHAOS = {
  'a body put inside another': (h, s, o) => { const e = h.engine.world.entities, p = e[o.entityId].pose.p; e[s.entityId].pose.p = [p[0] + 0.1, p[1], p[2]]; },
  'a body with a non-finite pose': (h, s) => { const e = h.engine.world.entities[s.entityId]; e.pose.p = [NaN, e.pose.p[1], Infinity]; },
  'a body whose human state is gone': (h, s) => { delete h.engine.world.entities[s.entityId].human; },
  'a body with no human state and no pose, and no whole pose on record': (h, s, o, w) => { const e = h.engine.world.entities[s.entityId]; delete e.human; delete e.pose; w.f.host.wholePoses.delete(s.entityId); },
  'a body whose human state holds a number that is no number': (h, s) => { h.engine.world.entities[s.entityId].human.speed = NaN; },
  'an invariant that throws whenever it reads one body': (h, s, o, w) => { w.control.every = (r) => { if (r.world.entities[s.entityId]) throw new Error('fixture.invariant-bug on one body'); return []; }; },
};
for (const [name, corrupt] of Object.entries(CHAOS))
  test(`chaos: ${name} never stops the tick loop`, {timeout: 300000}, async (t) => {
    quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo, Cy} = w.souls;
    const bystander = !/inside another/.test(name), far = bystander ? ok(await act(w, Bo, {capability: 'walk:yard'})) : null;
    ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
    w.control.restoreFails = true; corrupt(h, Ada, Bo, w); forgetMotion(h.engine.rt);
    const t0 = h.engine.world.tick; await w.tick(20);
    const walk = await act(w, Cy, {capability: 'walk:yard'});
    for (let i = 0; i < 580; i++) { h.tickOnce(); if (i % 10 === 0) { await setImmediate(); h.drainInputs(); } }
    const report = JSON.stringify({glitches: h.glitches, stepFailing: h.stepFailing, walk: read(w, Cy, walk)});
    assert.equal(h.engine.world.tick, t0 + 600, `the clock moved every tick: ${report}`); assert.ok(running(h), report);
    assert.equal(byRung(h).halt ?? 0, 0, report);
    assert.notEqual(walk.accepted, false, report); await w.tick(400); assert.equal(read(w, Cy, walk).phase, 'completed', report);
    if (far) { const r = read(w, Bo, far); assert.equal(r.phase, 'completed', `a bystander walking all along gets there: ${JSON.stringify(r).slice(0, 300)} ${report}`); }
    if (bystander) { const e = h.engine.world.entities[Ada.entityId]; assert.ok(e.human && e.pose.p.every(Number.isFinite), 'the broken body is whole again'); assert.ok((h.glitches.byRule['entity.corrupt']?.contained ?? 0) <= 2, report); }
    if (process.env.CHAOS_REPORT) console.info(`[chaos] ${name}: ${JSON.stringify(h.glitches.byRule)}`);
  });

// #1377: an invariant that throws whenever it reads one body names nobody (`engine.thrown`). With restores working, as on a
// real world, rung 3 went back and stopped every programme. What it was reading is found on a scratch restore of the head,
// so that body alone is quarantined, and a bystander walking all along gets there.
test('#1377 an invariant that throws reading one body stops that body alone: a bystander walking all along arrives, nothing is stopped world-wide, and every boot agrees', {timeout: 300000}, async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, {path}), h = w.f.host, {Ada, Bo, Cy} = w.souls;
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})), far = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(10);
  const seq0 = h.seq, from = h.engine.world.tick + 1, to = from + 300;   // by tick, so every replay meets the same throws
  w.control.every = (r) => { if (r.tick >= from && r.tick < to && r.world.entities[Ada.entityId]) throw new Error('fixture.invariant-bug on one body'); return []; };
  await w.tick(20);
  const hash = h.engine.stateHash(), n = Object.keys(h.engine.world.entities).length;   // #2168: the probe reads the live head in place
  assert.deepEqual(h.engine.thrownSourcesV1(), [Ada.entityId]); assert.equal(h.engine.stateHash(), hash, 'the probe leaves the live head as it was'); assert.equal(Object.keys(h.engine.world.entities).length, n);
  // one that reads the navigation scene and breaks on a bench: taking the bench out moves the scene; the live epoch stays
  const [ax, , az] = h.engine.world.entities[Ada.entityId].pose.p, before = new Set(Object.keys(h.engine.world.entities));
  assert.notEqual(w.god.act({ops: [{op: 'place', def: 'core/bench@1', name: 'far-bench', p: [ax, az + 30]}]}).accepted, false); await w.tick(2);
  const bench = Object.keys(h.engine.world.entities).find((id) => !before.has(id)), sp = h.engine.rt.services.spatial, every = w.control.every;
  sp.sync(h.engine.world); const epoch = sp.epoch;
  w.control.every = (r) => { r.services.spatial.sync(r.world); if (r === h.engine.rt && r.world.entities[bench]) return []; if (r.world.entities[bench]) throw new Error('fixture.invariant-bug on a bench'); return []; };
  assert.deepEqual(h.engine.thrownSourcesV1(), [bench]); w.control.every = every; sp.sync(h.engine.world);
  assert.equal(sp.epoch, epoch, 'the probe leaves the live navigation epoch as it was');
  const later = ok(await act(w, Cy, {capability: 'walk:shed'}));
  await w.tick(600);
  const events = w.f.db.events(worldId, seq0), report = JSON.stringify({glitches: h.glitches, bo: read(w, Bo, far), rules: events.filter((e) => e.kind === 'rules').map((e) => [e.author, Object.keys(e.payload ?? {})])});
  assert.ok(running(h), report); assert.equal(byRung(h).halt ?? 0, 0, report); assert.equal(byRung(h).rewind ?? 0, 0, report);
  assert.ok(!events.some((e) => e.payload?.lastRungInPlace || e.payload?.recovery?.lastRung), `no stop-all, in place or by a rewind: ${report}`);
  const q = events.filter((e) => e.payload?.quarantineV1); assert.ok(q.length >= 1, report);
  for (const e of q) assert.deepEqual(e.payload.quarantineV1.bodies, [Ada.entityId], 'only the body the invariant was reading');
  assert.equal(read(w, Ada, walk).code, 'world.quarantined');
  assert.equal(read(w, Bo, far).phase, 'completed', `the bystander walking all along arrives: ${report}`);
  assert.equal(read(w, Cy, later).phase, 'completed', report);
  assert.ok(!w.comms.streams.read(Bo.soulId, 0).events.some((e) => e.kind === 'world.quarantined' || e.kind === 'world.rewound'), 'Bo hears nothing');
  h.drainInputs(); h.saveSnapshot(true); bootsAgree(w, path);
});
