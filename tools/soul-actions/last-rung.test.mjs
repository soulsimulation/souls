// #1150 rung 3: when rung 2's replays fault too, the world goes back to its last clean state, keeps everything but
// decisions, and continues. A halt stays only for durability. The fault is real in every replay: a factory wrapper puts the
// bad step in each runtime at a fixed tick, as a bug in the engine would be.
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
import {kernelHash} from '../../apps/server/src/fold.ts';
import {clearanceAt} from '../../mars/viewer/engine/spatial/grid.ts';

const repair = await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: true}), today = await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: false});
function faulted(base, control) {
  const wrap = (e) => {
    const rt = e.rt, fired = new WeakSet(), step = e.step.bind(e);
    rt.invariants = [(r) => { if (r.tick === control.at && !fired.has(r)) { fired.add(r); return control.fault(r) ?? []; } if (control.every) return control.every(r) ?? []; return []; }, ...rt.invariants];
    e.step = () => { const o = step(); if (control.throwEvery || e.world.tick === control.throwAt) throw new Error('fixture.engine-bug'); return o; };   // after a whole step
    const clock = e.updateClock.bind(e), m = Object.create(e.m);
    m.stepCarriers = (...x) => { if (control.preThrow?.(e)) throw new Error('fixture.pre-tick-bug'); return Object.getPrototypeOf(m).stepCarriers(...x); }; e.m = m;   // before the tick moves
    e.updateClock = () => { if (control.midThrow?.(e)) throw new Error('fixture.mid-step-bug'); return clock(); };   // a real partial tick: actions and invariants ran, programmes didn't advance
    return e;
  };
  return {...base, create: (w) => wrap(base.create(w)), restore: (s) => wrap(base.restore(s))};
}
async function world(t, base = repair, path = ':memory:') {
  const control = {at: -1, fault() {}}, factory = faulted(base, control), f = fixture(path, factory, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: true}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => null});
  t.after(() => { try { comms.close(); f.host.stop(); f.db.close(); } catch { /* a restart test closed them itself */ } });
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  const bridge = installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => { for (let i = 0; i < n && !f.host.paused; i++) { f.host.tickOnce(); await setImmediate(); if (!f.host.paused) f.host.drainInputs(); } };
  await tick();
  const souls = {};
  for (const name of ['Ada', 'Bo']) {
    await invite(f, name.toLowerCase());
    const row = await accept(f.host, f.souls.create(`dev:${name.toLowerCase()}`, {name, description: 'Last rung test'}));
    souls[name] = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  }
  await tick();
  const [ax, , az] = f.host.engine.world.entities[souls.Ada.entityId].pose.p;
  assert.notEqual(god.act({ops: [
    {op: 'place', def: 'core/zone@1', name: 'shed', shape: {area: [[ax + 7, az - 2], [ax + 10, az - 2], [ax + 10, az + 2], [ax + 7, az + 2]]}},
    {op: 'place', def: 'core/zone@1', name: 'yard', shape: {area: [[ax - 10, az - 2], [ax - 7, az - 2], [ax - 7, az + 2], [ax - 10, az + 2]]}},
  ]}).accepted, false);
  await tick(30);
  return {f, edge, god, comms, tick, souls, control, factory, bridge};
}
const ok = (r) => { assert.notEqual(r.accepted, false, JSON.stringify(r)); return r; };
const act = (w, s, input) => accept(w.f.host, w.edge.act(s, input));
const read = (w, s, r) => w.edge.receipt(s.soulId, r.receipt?.id ?? r.id);
const byRung = (h) => Object.values(h.glitches.byRule).reduce((n, r) => { for (const [k, v] of Object.entries(r)) n[k] = (n[k] ?? 0) + v; return n; }, {});
const violate = (code, subjects) => () => [{code, message: 'forced', subjects}];

// The god bridge walks a body clear of what a god places (#1066), so this is the backstop: the body is put inside a real table
// between ticks, as an edit that got past the bridge would, and it never moved itself.
test('L1 the world lands on a still body: it stands at the nearest free spot and is told, and nobody else loses anything', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const w = await world(t), host = w.f.host, {Ada, Bo} = w.souls, E = host.engine.world.entities, [x, y, z] = E[Bo.entityId].pose.p;
  ok(w.god.act({ops: [{op: 'place', def: 'core/table@1', name: 'over-him', p: [x + 4, z]}]})); await w.tick(5);
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  E[Bo.entityId].pose.p = [x + 4, y, z]; forgetMotion(host.engine.rt);
  await w.tick(1);
  const [nx, , nz] = E[Bo.entityId].pose.p, refusal = w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:refusal'").all().map((e) => JSON.parse(e.payload).refusal);
  assert.ok(Math.hypot(nx - (x + 4), nz - z) > 0.3, 'moved clear of the table'); assert.equal(refusal.length, 1); assert.equal(refusal[0].relocated, true); assert.deepEqual(refusal[0].bodies, [Bo.entityId]);
  assert.deepEqual(byRung(host), {refusal: 1}); assert.deepEqual(host.engine.runtime.violations, []);
  assert.ok(w.comms.streams.read(Bo.soulId, 0).events.some((e) => e.kind === 'world.relocated'), 'he hears it');
  await w.tick(5); assert.equal(read(w, Ada, walk).phase, 'started', 'Ada walks on'); ok(await act(w, Bo, {capability: 'walk:yard'}));
});

for (const rule of ['support.floating', 'beam.unseated', 'deck.unsupported', 'stair.unsupported', 'raise.dropped'])
  test(`L2 ${rule}, with every replay faulting: today a halt, now a rewind, and the world runs on`, async (t) => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const old = await world(t, today); old.control.fault = violate(rule, [old.souls.Ada.entityId]); old.control.at = old.f.host.engine.world.tick + 3; await old.tick(10);
    assert.equal(old.f.host.paused, true, 'it really halts today');
    const w = await world(t), {Ada, Bo} = w.souls, host = w.f.host;
    const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
    const at = host.engine.world.tick + 3; w.control.fault = violate(rule, [Ada.entityId]); w.control.at = at; await w.tick(10);
    assert.equal(host.paused, false); assert.equal(host.engineFault, null); assert.equal(byRung(host).rewind, 1); assert.equal(byRung(host).halt ?? 0, 0);
    assert.ok(host.engine.world.tick >= at, 'ticks stay monotonic');
    const x = read(w, Ada, walk); assert.equal(x.phase, 'failed', JSON.stringify(x)); assert.equal(x.code, 'world.rewound'); assert.match(x.reason, /did not happen/);
    await w.tick(10); ok(await act(w, Ada, {capability: 'walk:yard'})); ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(30);
    assert.equal(host.paused, false); assert.deepEqual(host.engine.runtime.violations.filter((v) => v.tick > at), []);
  });

test('L2 a thrown step, every replay throwing: a rewind, not a halt', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host; ok(await act(w, w.souls.Ada, {capability: 'walk:shed'})); await w.tick(10);
  w.control.throwAt = host.engine.world.tick + 3; await w.tick(10);
  assert.equal(host.paused, false); assert.equal(byRung(host).rewind, 1); assert.equal(byRung(host).halt ?? 0, 0);
});

test('a step that throws every tick cannot rewind every tick', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, rows = () => w.f.db.db.prepare('SELECT COUNT(*) n FROM events').get().n, before = rows();
  w.control.throwEvery = true; await w.tick(60);
  assert.equal(host.paused, false); assert.equal(byRung(host).rewind <= 2, true, JSON.stringify(byRung(host))); assert.ok(rows() - before <= 3, `log grew by ${rows() - before}`);
  assert.equal(w.f.db.db.prepare("SELECT COUNT(*) n FROM events WHERE author='world:recovery'").get().n <= 1, true);
});

test('an invariant that throws every tick is contained once, and Souls still act', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada} = w.souls;
  w.control.every = () => { throw new Error('fixture.invariant-bug'); }; await w.tick(40);
  assert.equal(host.paused, false); assert.equal(byRung(host).rewind, 1); assert.deepEqual(host.engine.world.containedV1?.map((c) => c.code), ['engine.thrown']);
  const walk = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(400);
  assert.equal(read(w, Ada, walk).phase, 'completed'); assert.equal(byRung(host).rewind, 1);
});

test('a cancel that throws does not stop the rung', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, def = host.engine.rt.registry.get('walk_to'), cancel = def.cancel; t.after(() => { def.cancel = cancel; });
  ok(await act(w, w.souls.Ada, {capability: 'walk:shed'})); await w.tick(10);
  def.cancel = () => { throw new Error('fixture.cancel-bug'); }; host.recoveryCapture = null;
  await assert.doesNotReject(async () => { host.lastRewindTick = host.engine.world.tick; w.control.fault = violate('support.floating', [w.souls.Ada.entityId]); w.control.at = host.engine.world.tick + 2; await w.tick(6); });
  assert.equal(host.paused, false); assert.equal(byRung(host).halt ?? 0, 0); assert.equal(host.engine.programOf(w.souls.Ada.entityId), null);
});

test('one event that will not re-apply costs only itself, and the recipe says which', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada} = w.souls, [x, , z] = host.engine.world.entities[w.souls.Bo.entityId].pose.p;
  assert.notEqual(w.god.act({ops: [{op: 'place', def: 'core/bowl@2', name: 'kept', p: [x + 2, z]}]}).accepted, false); await w.tick(3);
  const bad = await accept(host, host.enqueue('rules', 'test', {note: 'will not re-apply'})), apply = host.apply.bind(host);
  host.apply = (e, r) => { if (r && e.seq === bad.seq) throw new Error('fixture.bad-event'); return apply(e, r); };
  w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = host.engine.world.tick + 2; await w.tick(6);
  const r = JSON.parse(w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:recovery' ORDER BY seq DESC").get().payload).recovery;
  assert.deepEqual(r.lastRung.skipped, [bad.seq]); assert.ok(host.engine.world.entities[w.god.model.get('kept').id], 'the god edit still applied');
});

test('L4 a refusal while something is contained does not rewind anyone', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada} = w.souls; w.control.every = violate('support.floating', ['g-standing']); await w.tick(10);
  assert.equal(byRung(host).rewind, 1);
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
  const rt = host.engine.rt; let done = false; rt.invariants = [(r) => { if (!done) { done = true; r.world.entities[Ada.entityId].pose.p[0] += 1; } return []; }, ...rt.invariants];
  await w.tick(3);
  assert.equal(byRung(host).refusal, 1); assert.equal(byRung(host).rewind, 1);
});

test('L6 a Soul whose walk finished since the baseline hears it did not happen, and one born in the window keeps its body', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada, Bo} = w.souls;
  t.mock.method(host, 'snapshotHead', () => ({tick: 0, stateHash: ''}));
  const done = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(300); assert.equal(read(w, Bo, done).phase, 'completed');
  await invite(w.f, 'cy'); const cy = await accept(host, w.f.souls.create('dev:cy', {name: 'Cy', description: 'Born in the window'})); await w.tick(3);
  w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = host.engine.world.tick + 2; await w.tick(6);
  assert.equal(byRung(host).rewind, 1); assert.ok(w.comms.streams.read(Bo.soulId, 0).events.some((e) => e.kind === 'world.rewound'), 'Bo is told');
  assert.ok(host.engine.world.entities[cy.entity_id], 'the newcomer has a body'); assert.ok(host.minds.get(cy.id), 'and a mind');
});

test('L3 decisions are left out, and god edits and Souls are kept', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada} = w.souls;
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  const [x, , z] = host.engine.world.entities[w.souls.Bo.entityId].pose.p;
  assert.notEqual(w.god.act({ops: [{op: 'place', def: 'core/bowl@2', name: 'kept', p: [x + 2, z]}]}).accepted, false); await w.tick(5);
  const id = w.god.model.get('kept').id, tick = host.engine.world.tick + 3; w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = tick; await w.tick(10);
  assert.equal(byRung(host).rewind, 1); assert.ok(host.engine.world.entities[id], 'the god edit survives'); assert.equal(host.engine.programOf(Ada.entityId), null);
  const e = w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:recovery' ORDER BY seq DESC").get(), r = JSON.parse(e.payload).recovery;
  assert.ok(r.lastRung); assert.equal(r.untilTick, tick); assert.equal(r.events.filter((x) => x.kind === 'decision').length, 0); assert.ok(r.events.some((x) => x.kind === 'world-edit'));
});

test('L4 what still fires is contained: counted once, no second fault, gone a hold after it stops firing, and no key when empty', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host, {Ada} = w.souls, eng = () => host.engine; let firing = true;
  await w.tick(5); const before = eng().stateHash();
  const wrapAlways = (e) => { const rt = e.rt; rt.invariants = [() => (firing ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []), ...rt.invariants]; };
  wrapAlways(eng()); const restore = w.factory.restore; w.factory.restore = (s) => { const e = restore(s); wrapAlways(e); return e; };
  assert.ok(before);
  w.f.host.factory.restore = w.factory.restore;
  await w.tick(20);
  assert.equal(host.paused, false); assert.deepEqual(eng().world.containedV1.map(({code, subjects}) => ({code, subjects})), [{code: 'support.floating', subjects: ['g-standing']}]); assert.equal(byRung(host).rewind, 1, 'counted once');
  firing = false; await w.tick(3); assert.equal(eng().world.containedV1?.length, 1, 'it stays through a hold, so a flicker is not a fault'); await w.tick(1205);
  assert.equal('containedV1' in eng().world, false, 'off the list, and no key'); ok(await act(w, Ada, {capability: 'walk:shed'}));
});

for (const [why, arrange] of [['with no baseline', (h) => { h.recoveryBaseline = null; h.recoveryCapture = null; }], ['soon after the last one', (h) => { h.lastRewindTick = h.engine.world.tick; }]])
  test(`L5 ${why} it stays on the head: programmes stop, the rule is contained, the world runs on`, async (t) => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const w = await world(t), host = w.f.host, {Ada} = w.souls;
    const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10); arrange(host);
    const tick = host.engine.world.tick; w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = tick + 3; await w.tick(10);
    assert.equal(host.paused, false); assert.equal(byRung(host).rewind, 1); assert.ok(host.engine.world.tick > tick, 'it stayed on the head');
    assert.equal(w.f.db.db.prepare("SELECT COUNT(*) n FROM events WHERE author='world:rewind'").get().n, 1);
    assert.equal(read(w, Ada, walk).code, 'world.rewound'); await w.tick(5); ok(await act(w, Ada, {capability: 'walk:yard'}));
  });

test('L5 a thrown step contained on the head still boots: the replay survives what the live tick survived', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'last-rung-')), path = join(dir, 'world.db'), w = await world(t, repair, path); let db2, h2;
  t.after(() => { try { h2?.stop(); db2?.close(); } catch { /* the first failure is the one that matters */ } rmSync(dir, {recursive: true, force: true}); });
  await w.tick(5); w.f.host.lastRewindTick = w.f.host.engine.world.tick; w.control.throwAt = w.f.host.engine.world.tick + 2; await w.tick(10);
  assert.equal(byRung(w.f.host).contained, 1); assert.equal(byRung(w.f.host).rewind, undefined, 'nothing stopped, so nobody lost anything');
  const hash = w.f.host.engine.stateHash(), tick = w.f.host.engine.world.tick; w.comms.close(); w.f.host.stop(); w.f.db.close();
  db2 = new Db(path); h2 = new WorldHost(db2, w.factory, seed, 1e9, worldId, {durableClockV1: true}); h2.boot();
  assert.equal(h2.engine.world.tick, tick); assert.equal(h2.engine.stateHash(), hash);
});

for (const clean of [false, true])
  test(`L7 a ${clean ? 'clean' : 'crash'} restart after a rewind reaches the live state`, async (t) => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
    const dir = mkdtempSync(join(tmpdir(), 'last-rung-')), path = join(dir, 'world.db'), w = await world(t, repair, path), {Ada} = w.souls; let db2, h2;
    t.after(() => { try { h2?.stop(); db2?.close(); } catch { /* the first failure is the one that matters */ } rmSync(dir, {recursive: true, force: true}); });
    if (!clean) t.mock.method(w.f.host, 'snapshotHead', () => ({tick: 0, stateHash: ''}));   // no snapshot after it, so the boot replays the recipe
    ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
    w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = w.f.host.engine.world.tick + 3; await w.tick(30);
    assert.equal(byRung(w.f.host).rewind, 1);
    const hash = w.f.host.engine.stateHash(), tick = w.f.host.engine.world.tick;
    w.comms.close(); w.f.host.stop();
    if (clean) { w.f.host.drainInputs(); w.f.host.saveSnapshot(true); }
    w.f.db.close();
    db2 = new Db(path); h2 = new WorldHost(db2, w.factory, seed, 1e9, worldId, {durableClockV1: true}); h2.boot();
    assert.equal(h2.engine.world.tick, tick); assert.equal(h2.engine.stateHash(), hash); assert.equal(h2.paused, false);
  });

const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); };
const onDisk = (t) => { const dir = mkdtempSync(join(tmpdir(), 'last-rung-')); t.after(() => rmSync(dir, {recursive: true, force: true})); return join(dir, 'world.db'); };
const reboot = (t, w, path) => {
  w.comms.close(); w.f.host.stop(); w.f.db.close();
  const db2 = new Db(path), h2 = new WorldHost(db2, w.factory, seed, 1e9, worldId, {durableClockV1: true}); t.after(() => { try { h2.stop(); db2.close(); } catch { /* the first failure is the one that matters */ } });
  h2.boot(); return h2;
};
const rows = (w, where = '1') => w.f.db.db.prepare(`SELECT COUNT(*) n FROM events WHERE ${where}`).get().n;
// each fires at the ticks it was armed for, live and in every replay, as a bug in the engine would
const armed = (w) => { const at = w.control.ticks ??= new Set(); at.add(w.f.host.engine.world.tick + 2); return at; };
const faultOnce = {
  // who it names is a function of the tick, so a replay fires the same rule
  'a violation': async (w, s) => { const at = armed(w), whom = w.control.whom ??= new Map(); whom.set(w.f.host.engine.world.tick + 2, s.entityId); w.control.every = (r) => at.has(r.tick) ? [{code: 'support.floating', message: 'forced', subjects: [whom.get(r.tick)]}] : []; await w.tick(4); },
  'a thrown step': async (w) => { const at = armed(w); w.control.midThrow = (e) => at.has(e.world.tick); await w.tick(4); },
  'a throw before the tick moves': async (w) => { const at = armed(w); w.control.preThrow = (e) => at.has(e.world.tick); await w.tick(4); },
};
for (const [kind, once] of Object.entries(faultOnce))
  test(`L7 ${kind} again in the cooldown, with a Soul acting: the stop is written, and a crash restart reaches the same world`, async (t) => {
    quiet(t);
    const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, {Ada, Bo} = w.souls;
    host.lastRewindTick = host.engine.world.tick;
    await once(w, Ada); assert.equal(rows(w, "author='world:rewind'"), 1);
    const walk = ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(10); assert.ok(host.engine.programOf(Bo.entityId));
    await once(w, Bo); await w.tick(8);   // a new one: the same rule on the same subjects is held, and stops nobody again
    assert.equal(rows(w, "author='world:rewind'"), 2); assert.equal(host.engine.programOf(Bo.entityId), null);
    assert.equal(read(w, Bo, walk).code, 'world.rewound');
    const hash = host.engine.stateHash(), tick = host.engine.world.tick, h2 = reboot(t, w, path);
    assert.equal(h2.engine.world.tick, tick); assert.equal(h2.engine.stateHash(), hash); assert.equal(h2.engine.programOf(Bo.entityId), null);
  });

test('L7 a step that throws part way with a programme running: live and a crash restart agree, kernel too', async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, {Bo} = w.souls;
  ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(10);
  host.lastRewindTick = host.engine.world.tick; const at = host.engine.world.tick + 2; w.control.midThrow = (e) => e.world.tick === at; await w.tick(6);
  const hash = host.engine.stateHash(), kernel = kernelHash(host.kernel), tick = host.engine.world.tick, h2 = reboot(t, w, path);
  assert.equal(h2.engine.world.tick, tick); assert.equal(h2.engine.stateHash(), hash); assert.equal(kernelHash(h2.kernel), kernel);
});

test('L2 a step that throws before its tick moves still moves the clock, so the cooldown ends', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, t0 = host.engine.world.tick;
  w.control.preThrow = () => true; await w.tick(50);
  assert.equal(host.engine.world.tick, t0 + 50); assert.equal(host.paused, false); assert.equal(host.clockAvailable, true);
});

for (const [kind, key] of [['before its tick moves', 'preThrow'], ['part way through', 'midThrow']])
  test(`L2 a step that throws ${kind} on every tick for minutes: one named state, acts refused, no more rewinds, and it ends when the faults do`, async (t) => {
    quiet(t);
    const w = await world(t), host = w.f.host, {Ada, Bo} = w.souls;
    w.control[key] = () => true; await w.tick(20);
    const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(200);
    assert.equal(read(w, Ada, walk).phase, 'failed'); assert.equal(read(w, Ada, walk).code, 'world.rewound');
    assert.match(host.stepFailing, /fixture\./); assert.equal(host.glitches.byRule['engine.step-failing'].halt, 1);
    const refused = await w.edge.act(Bo, {capability: 'walk:shed'}); assert.equal(refused.accepted, false); assert.equal(refused.code, 'world.step-failing'); assert.ok(refused.reason);
    const before = rows(w), recipes = rows(w, "author='world:recovery'"); await w.tick(2600);
    assert.equal(rows(w), before, 'nothing new to say'); assert.ok(recipes <= 1, `${recipes} recipes`);
    assert.equal(host.glitches.byRule['engine.step-failing'].halt, 1); assert.equal(host.paused, false); assert.equal(host.clockAvailable, true);
    w.control[key] = null; await w.tick(200);
    assert.equal(host.stepFailing, null); ok(await act(w, Bo, {capability: 'walk:shed'})); const x = host.engine.world.entities[Bo.entityId].pose.p[0]; await w.tick(10);
    assert.notEqual(host.engine.world.entities[Bo.entityId].pose.p[0], x, 'bodies move again');
  });

test('L2 faults on half the ticks are the same named state, so they stop rewinding', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, {Bo} = w.souls;
  w.control.midThrow = (e) => e.world.tick % 2 === 0; await w.tick(400);
  assert.match(host.stepFailing, /fixture\./);
  assert.equal((await w.edge.act(Bo, {capability: 'walk:shed'})).code, 'world.step-failing');
  const recipes = rows(w, "author='world:recovery'"); await w.tick(2600);
  assert.equal(rows(w, "author='world:recovery'"), recipes); assert.ok(recipes <= 1, `${recipes} recipes`); assert.ok(host.stepFailing);
});

test('L7 a world whose steps keep failing still snapshots under continuous ticks, and boots from it with a link that expired meanwhile', async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, {Ada, Bo} = w.souls, head = host.engine.world.tick;
  host.kernel.links['test|a|b'] = {kind: 'said', from: Ada.soulId, to: Bo.soulId, since: head, until: head + 320, data: {act: 'tell'}};
  await w.tick(1); host.saveSnapshot(true);
  w.control.midThrow = () => true; await w.tick(260); assert.ok(host.stepFailing);
  const snap = () => w.f.db.latestSnapshot(host.worldId).tick, first = snap(); host.snapshotEvery = 100;
  for (let i = 0; i < 150; i++) host.tickOnce();   // one turn of the event loop for all of them: a sliced job could never land
  assert.ok(snap() > first, `snapshot stayed at ${first}`); assert.equal(host.kernel.tick, host.engine.world.tick);
  const landed = snap(), h2 = reboot(t, w, path);   // a faulted tick writes nothing, so a crash lands on the last durable one
  assert.equal(h2.engine.world.tick, landed); assert.equal(h2.paused, false);
});

test('a programme already on its way down keeps its reason; its deadline is written once, so a repeat fault after that has nothing to write', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, {Bo} = w.souls;
  ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(5);
  const p = host.engine.programs.get(host.engine.programOf(Bo.entityId)), own = {code: 'world.refused:carry.load-static', message: 'its own'}; p.stopping = own;
  assert.equal(host.engine.stopAllV1({code: 'world.rewound', message: 'x'}), 1); assert.equal(p.stopping, own); const by = p.stopByV1; assert.ok(by > host.engine.world.tick);
  assert.equal(host.engine.stopAllV1({code: 'world.rewound', message: 'x'}), 0); assert.equal(p.stopByV1, by);
});

test('L7 a burst, a clean gap, then a fault that never ends: a crash after a snapshot from the faulted head still boots', async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, T = host.engine.world.tick;
  w.control.midThrow = (e) => { const k = e.world.tick; return k === T + 3 || k === T + 6 || k >= T + 40; };   // nothing more is logged after the gap, so the snapshot's seq is the frontier's
  await w.tick(170); assert.ok(host.stepFailing);
  host.snapshotEvery = 50; await w.tick(60);
  const snap = w.f.db.latestSnapshot(host.worldId).tick, h2 = reboot(t, w, path);
  assert.ok(snap > T + 40); assert.equal(h2.engine.world.tick, snap);
});

test('a snapshot from a faulted head never becomes what a rewind goes back to', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host; w.control.midThrow = () => true; await w.tick(260); assert.ok(host.stepFailing);   // its own rung 3 re-baselined at the repaired head
  const clean = host.recoveryBaseline, at = w.f.db.latestSnapshot(host.worldId).tick; assert.ok(clean);
  host.snapshotEvery = 50; await w.tick(60);
  assert.ok(w.f.db.latestSnapshot(host.worldId).tick > at, 'a snapshot landed'); assert.equal(host.recoveryBaseline, clean);
});

for (const [what, breakIt] of [['a capture', (e) => { e.snapshot = () => { throw new Error('fixture.capture-bug'); }; }], ['canSnapshot', (e) => { e.canSnapshot = () => { throw new Error('fixture.capture-bug'); }; }]])
  test(`L2 ${what} that throws on a faulted head is no halt and no throw: it waits until one is next due`, async (t) => {
    quiet(t);
    const w = await world(t), host = w.f.host;
    w.control.midThrow = () => true; await w.tick(260); assert.ok(host.stepFailing);
    host.snapshotEvery = 1; breakIt(host.engine); host.tickOnce();
    assert.equal(host.paused, false); assert.equal(host.clockAvailable, true); assert.equal(host.glitches.byRule['durability.repair'], undefined);
  });

test('L6 a programme that finishes on a tick that faults on a repeat still closes its receipt', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, {Ada, Bo} = w.souls, e = host.engine, real = e.step.bind(e); let arm = 1;
  const forced = () => e.rt.violations.push({tick: e.world.tick, code: 'support.floating', message: 'forced', subjects: [Bo.entityId]});
  e.step = () => { const o = real(); if (arm === 1) { forced(); arm = 0; } else if (arm === 2 && o.programs.some((p) => p.kind === 'completed' && p.actor === Ada.entityId)) { forced(); arm = 0; } return o; };
  host.lastRewindTick = e.world.tick; await w.tick(2);
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); arm = 2; await w.tick(400);
  assert.equal(arm, 0, 'the fault landed on the finishing tick'); assert.notEqual(read(w, Ada, walk).phase, 'started');
});

for (const graceful of [false, true]) test(`L3 after a ${graceful ? 'graceful' : 'crash'} restart a faulted head is still no baseline: the next fault stays on the head instead of rewinding to it`, async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), host = w.f.host;
  w.control.midThrow = () => true; await w.tick(260); host.snapshotEvery = 50; await w.tick(60);
  if (graceful) host.saveSnapshot(true);   // what an operator's restart does, and the alert is what sends them there
  const h2 = reboot(t, w, path), count = (who) => h2.db.db.prepare(`SELECT COUNT(*) n FROM events WHERE author='${who}'`).get().n, recipes = count('world:recovery'), stops = count('world:rewind');
  assert.equal(h2.recoveryBaseline, null); assert.equal(h2.recoveryCapture, null);
  h2.lastRewindTick = -Infinity; h2.inPlaceAt.clear(); h2.tickOnce();   // no cooldown to hide behind: only the missing baseline keeps it on the head
  assert.equal(count('world:recovery'), recipes); assert.equal(count('world:rewind'), stops + 1);
});

test('a live snapshot in a failing stretch leaves the baseline, and a boot from a marked head gets a clean one at its first clean tick', async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), host = w.f.host;
  w.control.midThrow = () => true; await w.tick(260); const clean = host.recoveryBaseline; host.saveSnapshot(true); assert.equal(host.recoveryBaseline, clean);
  w.control.midThrow = null; const h2 = reboot(t, w, path); assert.equal(h2.bootedFaulted, true);
  h2.saveSnapshot(true); assert.equal(h2.recoveryBaseline, null, 'still no clean tick');
  h2.tickOnce(); assert.equal(h2.bootedFaulted, false); for (let i = 0; i < 20; i++) await setImmediate();
  assert.ok(h2.recoveryBaseline || h2.recoveryCapture);
  assert.equal(h2.db.latestSnapshot(h2.worldId).body.faultedHeadV1, undefined, 'the durable snapshot is the clean one');
});

test('a head that will not capture is tried once per interval, not every tick', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host; w.control.midThrow = () => true; await w.tick(260); assert.ok(host.stepFailing);
  let tries = 0; host.engine.snapshot = () => { tries++; throw new Error('fixture.capture-bug'); }; host.snapshotEvery = 1000; host.requestSnapshot('test');
  await w.tick(40); assert.equal(tries, 1);
});

test('a failing stretch that ends asks for a clean snapshot at once', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, at = () => w.f.db.latestSnapshot(host.worldId).tick;
  w.control.midThrow = () => true; await w.tick(260); assert.ok(host.stepFailing); const before = at();
  w.control.midThrow = null; await w.tick(200); for (let i = 0; i < 20; i++) await setImmediate();
  assert.equal(host.stepFailing, null); assert.ok(at() > before); assert.ok(host.recoveryBaseline || host.recoveryCapture);
});

test('L5 a head too broken to report on still takes a stop in place without throwing', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host; t.mock.method(host, 'heartbeat', () => { throw new Error('fixture.view-bug'); });
  host.lastRewindTick = host.engine.world.tick; w.control.midThrow = () => true; await w.tick(3);
  assert.equal(host.paused, false);
});

test('saveSnapshot after a repair that could not be written adds no snapshot and no frontier', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host; host.lastRewindTick = host.engine.world.tick;
  const apply = host.apply.bind(host); host.apply = (e, r, d) => { if (e.payload?.bad && !r) throw new Error('fixture.fold-bug'); return apply(e, r, d); };
  const append = w.f.db.appendEvent.bind(w.f.db); w.f.db.appendEvent = (id, e) => { if (e.payload?.lastRungInPlace) throw new Error('fixture.disk-full'); return append(id, e); };
  const frontier = t.mock.method(host, 'persistClockFrontier'), before = w.f.db.latestSnapshot(host.worldId)?.tick;
  void host.enqueue('rules', 'test', {bad: 1}); host.saveSnapshot(true);
  assert.equal(host.clockAvailable, false); assert.equal(frontier.mock.callCount(), 0); assert.equal(w.f.db.latestSnapshot(host.worldId)?.tick, before);
});

test('the rewind cooldown survives a restart', async (t) => {
  quiet(t);
  const path = onDisk(t), w = await world(t, repair, path), {Ada} = w.souls;
  w.control.fault = violate('support.floating', [Ada.entityId]); w.control.at = w.f.host.engine.world.tick + 2; await w.tick(5);
  const at = w.f.host.lastRewindTick; assert.ok(Number.isFinite(at));
  assert.equal(reboot(t, w, path).lastRewindTick, at);
});

test('L2 construction.unsafe-failure thrown from a step takes the same way down, and never a halt', async (t) => {
  quiet(t);
  const w = await world(t), host = w.f.host, at = host.engine.world.tick + 2;
  w.control.midThrow = (e) => { if (e.world.tick === at) throw new Error('construction.unsafe-failure: forced'); return false; }; await w.tick(6); w.control.midThrow = null; await w.tick(3);
  assert.equal(host.paused, false); assert.equal(byRung(host).rewind, 1); assert.equal(byRung(host).halt ?? 0, 0);
});

for (const [rung, why] of [['a rewind', 'support.floating'], ['a stop in place', 'beam.unseated']])
  test(`L2 ${rung} that can't be written is a named durability halt, not a crash`, async (t) => {
    quiet(t);
    const w = await world(t), host = w.f.host, {Ada} = w.souls;
    if (rung !== 'a rewind') host.lastRewindTick = host.engine.world.tick;
    t.mock.method(w.f.db, 'appendEvent', (_, e) => { if (e.kind === 'rules') throw new Error('fixture.disk-full'); });
    w.control.fault = violate(why, [Ada.entityId]); w.control.at = host.engine.world.tick + 2; await w.tick(4);
    assert.equal(host.paused, true); assert.equal(host.clockAvailable, false); assert.equal(host.glitches.byRule['durability.repair'].halt, 1);
  });

for (const inPlace of [true, false])
  test(`L2 a fault inside a drain whose ${inPlace ? 'stop in place' : 'rewind'} can't be written: a named halt, nothing more written, no throw`, async (t) => {
    quiet(t);
    const w = await world(t), host = w.f.host; if (inPlace) host.lastRewindTick = host.engine.world.tick;
    const apply = host.apply.bind(host); host.apply = (e, r, d) => { if (e.payload?.bad && !r) throw new Error('fixture.fold-bug'); return apply(e, r, d); };
    const append = w.f.db.appendEvent.bind(w.f.db); w.f.db.appendEvent = (id, e) => { if (e.payload?.lastRungInPlace || e.payload?.recovery) throw new Error('fixture.disk-full'); return append(id, e); };
    void host.enqueue('rules', 'test', {bad: 1}); void host.enqueue('rules', 'test', {after: 1}).catch(() => {});
    const tick = host.engine.world.tick; host.tickOnce();
    assert.equal(rows(w, "json_extract(payload, '$.after') = 1"), 0); assert.equal(host.engine.world.tick, tick, 'no step from that head');
    assert.equal(host.paused, true); assert.equal(host.glitches.byRule['durability.repair'].halt, 1);
  });

// The steward's three, forced: a rule that could be contained must be, whatever the host was doing when it began.
const loose = (w, code = 'support.floating') => ({stuck: () => !!w.f.host.stepFailing, contained: () => (w.f.host.engine.world.containedV1 ?? []).some((c) => c.code === code)});
const settles = async (t, w, Ada, baseRows) => {
  const l = loose(w); await w.tick(300);
  assert.equal(l.contained(), true, 'contained'); assert.equal(l.stuck(), false, 'not refused'); ok(await act(w, Ada, {capability: 'walk:shed'}));
  assert.ok(rows(w, "author='world:rewind'") - baseRows <= 12, `a bounded number of rows: ${rows(w, "author='world:rewind'") - baseRows}`);
};
test('a rule that drops out twice inside a minute and then fires steadily is contained, and Souls act', async (t) => {
  quiet(t); const w = await world(t), {Ada} = w.souls, at = w.f.host.engine.world.tick + 5, off = new Set([at + 2, at + 4]), base = rows(w, "author='world:rewind'");
  w.control.every = (r) => (r.tick >= at && !off.has(r.tick) ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []);
  await settles(t, w, Ada, base);
});
test('a rule whose subjects change and settle on one seen before is contained, and Souls act', async (t) => {
  quiet(t); const w = await world(t), {Ada} = w.souls, at = w.f.host.engine.world.tick + 5, base = rows(w, "author='world:rewind'");
  w.control.every = (r) => { const n = r.tick - at; if (n < 0) return []; const subjects = n < 3 ? ['g-a'] : n < 6 ? ['g-b'] : n < 9 ? ['g-c'] : ['g-b']; return [{code: 'support.floating', message: 'forced', subjects}]; };
  await settles(t, w, Ada, base);
});
test('a rule that begins in a stretch of thrown steps, which then end, is contained, and Souls act', async (t) => {
  quiet(t); const w = await world(t), {Ada} = w.souls, host = w.f.host, base = rows(w, "author='world:rewind'");
  w.control.throwEvery = true; await w.tick(160); assert.ok(host.stepFailing, 'failing');
  w.control.every = () => [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}]; await w.tick(10);
  w.control.throwEvery = false; await settles(t, w, Ada, base);
});
test('a rule that flickers every other tick costs a row, not a row a flicker', async (t) => {
  quiet(t); const w = await world(t), {Ada} = w.souls, base = rows(w, "author='world:rewind'");
  w.control.every = (r) => (r.tick % 2 ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []);
  await w.tick(600); assert.ok(rows(w, "author='world:rewind'") - base <= 2, String(rows(w, "author='world:rewind'") - base)); assert.equal(w.f.host.stepFailing, null); ok(await act(w, Ada, {capability: 'walk:shed'}));
});
test('C2 a stop in place carries what the fault named, and a replay of those keys gives the same world, until included', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, at = host.engine.world.tick + 5, subjects = (r) => [`g-${Math.min(r.tick - at, 3)}`];
  host.lastRewindTick = host.engine.world.tick;
  w.control.every = (r) => (r.tick >= at && r.tick !== at + 2 ? [{code: 'support.floating', message: 'forced', subjects: subjects(r)}] : []);
  await w.tick(120);
  const named = w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:rewind'").all().map((e) => JSON.parse(e.payload).lastRungInPlace.contained);
  assert.deepEqual(named, [[{code: 'support.floating', subjects: ['g-0']}], [{code: 'support.floating', subjects: ['g-1']}], [{code: 'support.floating', subjects: ['g-3']}]], 'each row says what it contained');
  const was = host.engine.world.containedV1, hash = host.engine.stateHash(), tick = host.engine.world.tick; assert.ok(was.every((c) => c.until > tick));
  const h = reboot(t, w, path); assert.equal(h.engine.world.tick, tick); assert.deepEqual(h.engine.world.containedV1, was); assert.equal(h.engine.stateHash(), hash);
});
test('C2 a rung 3 carries what the fault named, and a restart agrees', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, at = host.engine.world.tick + 5;
  w.control.every = (r) => (r.tick >= at ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []);
  await w.tick(30);
  const recipe = JSON.parse(w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:recovery' ORDER BY seq DESC LIMIT 1").get().payload).recovery;
  assert.deepEqual(recipe.lastRung.contained, [{code: 'support.floating', subjects: ['g-standing']}]);
  const was = host.engine.world.containedV1, hash = host.engine.stateHash(), h = reboot(t, w, path); assert.deepEqual(h.engine.world.containedV1, was); assert.equal(h.engine.stateHash(), hash);
});
// A read of the invariants the live world makes and a replay doesn't moves the step check's memory: this is the shape that bricked a boot.
test('C1 a throw before the tick moves, a jump, then a restart: every boot reaches the live hash', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada} = w.souls, id = Ada.entityId, c = w.control;
  await w.tick(5); h.lastRewindTick = h.engine.world.tick;
  const first = h.engine.world.tick + 2, second = first + 5, jump = second + 2, jumped = new WeakSet();
  c.preThrow = (e) => e.world.tick === first || e.world.tick === second;
  c.every = (r) => { const e = r.world.entities[id]; if (r.tick === jump && !jumped.has(r)) { jumped.add(r); e.pose.p = [e.pose.p[0] - 1, e.pose.p[1], e.pose.p[2]]; } return []; };
  while (h.engine.world.tick < second) { h.tickOnce(); await setImmediate(); }
  h.tickOnce(); w.edge.act(Ada, {capability: 'walk:shed'}); h.tickOnce();
  await w.tick(30);
  const hash = h.engine.stateHash(), tick = h.engine.world.tick; w.comms.close(); h.stop(); w.f.db.close();
  for (let boot = 0; boot < 3; boot++) {
    const db = new Db(path), b = new WorldHost(db, w.factory, seed, 1e9, worldId, {durableClockV1: true}); b.boot();
    assert.equal(b.engine.world.tick, tick, `boot ${boot}`); assert.equal(b.engine.stateHash(), hash, `boot ${boot}`); b.stop(); db.close();
  }
});
// The step check's memory after a step that didn't finish: a boot from that head remembers the head, so a live world must too.
const bootsAgree = (w, path, h) => {
  const hash = h.engine.stateHash(), tick = h.engine.world.tick; w.comms.close(); h.stop(); w.f.db.close();
  for (let boot = 0; boot < 2; boot++) { const db = new Db(path), b = new WorldHost(db, w.factory, seed, 1e9, worldId, {durableClockV1: true}); b.boot(); assert.equal(b.engine.world.tick, tick, `boot ${boot}`); assert.equal(b.engine.stateHash(), hash, `boot ${boot}`); b.stop(); db.close(); }
};
const jumpNext = async (w, h, id) => {
  const at = h.engine.world.tick + 1, jumped = new WeakSet();
  w.control.every = (r) => { const e = r.world.entities[id]; if (r.tick === at && !jumped.has(r)) { jumped.add(r); e.pose.p = [e.pose.p[0] - 1, e.pose.p[1], e.pose.p[2]]; } return []; };
  w.edge.act(w.souls.Ada, {capability: 'walk:shed'}); h.drainInputs(); for (let i = 0; i < 8; i++) { await setImmediate(); h.drainInputs(); }
  for (let i = 0; i < 30; i++) { h.tickOnce(); await setImmediate(); }
};
test('C1 a jump on the first step after a rung 3 is refused live, and every boot agrees', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, c = w.control; await w.tick(5);
  c.at = h.engine.world.tick + 3; c.fault = violate('support.floating', ['g-standing']); while (h.engine.world.tick < c.at) { h.tickOnce(); await setImmediate(); }
  assert.equal(byRung(h).rewind, 1); const before = rows(w, "author='world:refusal'");
  await jumpNext(w, h, w.souls.Ada.entityId); assert.equal(rows(w, "author='world:refusal'") - before, 1, 'rung 1 saw it'); bootsAgree(w, path, h);
});
for (const [kind, knob] of [['before the tick moves', 'preThrow'], ['part way through a tick', 'midThrow']])
  test(`C1 a jump on the first step after a throw ${kind}, with a snapshot on that head: every boot agrees`, async (t) => {
    quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, c = w.control; await w.tick(5); h.lastRewindTick = h.engine.world.tick;
    const at = h.engine.world.tick + 2; c[knob] = (e) => e.world.tick === at; while (h.engine.world.tick <= at) { h.tickOnce(); await setImmediate(); }
    h.saveSnapshot(true); await jumpNext(w, h, w.souls.Ada.entityId); bootsAgree(w, path, h);
  });
const throwOnce = async (t, w, h, Ada) => {
  const def = h.engine.rt.registry.get('walk_to'), {step} = def; t.after(() => { def.step = step; });
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
  let once = true; def.step = (rt, exec, dt) => { if (once && exec.actor === Ada.entityId) { once = false; throw new RangeError('Maximum call stack size exceeded'); } return step(rt, exec, dt); };
  await w.tick(1); def.step = step; assert.equal(once, false); return h.engine.world.tick;
};
test('C1 a throw the replay does not repeat, before any snapshot: a crash boot goes on from the replay, says so, and runs', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada} = w.souls; t.mock.method(h, 'snapshotDue', () => false);
  await throwOnce(t, w, h, Ada); await w.tick(3);
  const b = reboot(t, w, path); assert.equal(b.glitches.byRule['clock-frontier.replay-differs'].recovery, 1); assert.equal(b.paused, false); for (let i = 0; i < 20; i++) b.tickOnce();
});
test('C1 a snapshot follows a throw, so a boot starts past it', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada} = w.souls, at = await throwOnce(t, w, h, Ada);
  for (let i = 0; i < 40 && !(w.f.db.latestSnapshot(h.worldId)?.tick >= at); i++) await w.tick(1);
  assert.ok(w.f.db.latestSnapshot(h.worldId)?.tick >= at); await w.tick(3); const hash = h.engine.stateHash(), b = reboot(t, w, path); assert.equal(b.engine.stateHash(), hash); assert.equal(b.glitches.byRule['clock-frontier.replay-differs'], undefined);
});
test('C1 a repeated throw with nothing to write leaves the step check where a boot would', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, c = w.control; await w.tick(5); h.lastRewindTick = h.engine.world.tick;
  const first = h.engine.world.tick + 2, second = first + 4; c.preThrow = (e) => e.world.tick === first || e.world.tick === second; while (h.engine.world.tick <= second) { h.tickOnce(); await setImmediate(); }
  assert.equal(rows(w, "author='world:rewind'"), 1, 'the second wrote nothing'); h.saveSnapshot(true); await jumpNext(w, h, w.souls.Ada.entityId); bootsAgree(w, path, h);
});
test('a recorder that throws closing a take costs that take, not every tick after', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada} = w.souls; await w.tick(5); h.lastRewindTick = h.engine.world.tick;
  const e = h.engine, sample = e.recorder.sample?.bind(e.recorder); e.recorder.finish = () => { e.recorder.finish = () => { throw new Error('TakeRecorder.finish() called twice'); }; throw new Error('fixture.recorder-bug'); }; assert.ok(sample !== null);
  w.control.throwAt = e.world.tick + 2; await w.tick(300); assert.equal(h.stepFailing, null); ok(await act(w, Ada, {capability: 'walk:shed'}));
});
test('C3 a real motion.teleport every tick, with no plan to undo it, is contained, and Souls act', async (t) => {
  quiet(t); const w = await world(t), host = w.f.host, {Ada, Bo} = w.souls, id = Ada.entityId; let last = -1, dir = 1;
  w.control.every = (r) => { const e = r.world.entities[id]; if (!e) return []; e.human.activity = 'climb-wait'; if (r.tick !== last) { last = r.tick; e.pose.p = [e.pose.p[0] + dir * 0.3, e.pose.p[1], e.pose.p[2]]; dir = -dir; } return []; };
  await w.tick(300);
  assert.deepEqual(host.engine.world.containedV1?.map(({code, subjects}) => ({code, subjects})), [{code: 'motion.teleport', subjects: [id]}]); assert.equal(host.stepFailing, null, 'not refused');
  ok(await act(w, Bo, {capability: 'walk:shed'})); assert.equal(host.paused, false);
});
const intoTable = async (t, held, firing = false) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls, id = Ada.entityId, E = () => h.engine.world.entities, [x, , z] = E()[id].pose.p, [bx, , bz] = E()[Bo.entityId].pose.p;
  const n = Math.hypot(x - bx, z - bz) || 1, dx = (x - bx) / n, dz = (z - bz) / n, tx = x + dx * 2.5, tz = z + dz * 2.5;
  ok(w.god.act({ops: [{op: 'place', def: 'core/table@1', name: 'tb', p: [tx, tz]}]})); await w.tick(8);
  if (held) { const a = h.engine.world.tick + 3; w.control.every = (r) => (r.tick >= a && (firing || r.tick < a + 10) ? [{code: 'collision.human-static', message: 'forced', subjects: [id]}] : []); await w.tick(30); if (!firing) w.control.every = null; assert.equal(h.engine.world.containedV1?.length, 1, 'held'); }
  const before = rows(w, "author='world:refusal'"), walk = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(2);
  const cur = E()[id].pose.p; let last = -1, px = cur[0], pz = cur[2];
  const dist = () => { const p = E()[id].pose.p; return Math.hypot(p[0] - tx, p[2] - tz); };
  w.control.every = (r) => { const e = r.world.entities[id]; if (r.tick !== last) { last = r.tick; if (h.engine.programOf(id) && Math.hypot(px - tx, pz - tz) > 0.05) { px += dx * 0.1; pz += dz * 0.1; e.pose.p = [px, e.pose.p[1], pz]; } } return firing ? [{code: 'collision.human-static', message: 'forced', subjects: [id]}] : []; };
  await w.tick(45); w.control.every = null;
  return {w, read: read(w, Ada, walk), refused: rows(w, "author='world:refusal'") - before, dist: dist()};
};
test('C4 a body that moves into a table under a held key is refused, as one with nothing held is', async (t) => {
  const clear = await intoTable(t, false), held = await intoTable(t, true);
  assert.equal(clear.refused, 1, 'the control'); assert.equal(held.refused, 1, 'the hold changes nothing'); assert.equal(held.read.code, 'world.refused:collision.human-static'); assert.ok(Math.abs(held.dist - clear.dist) < 0.2, `${held.dist} against ${clear.dist}`);
});
test('C4 a key still firing is no way through: a body shoved into a table is refused all the same', async (t) => {
  const held = await intoTable(t, true, true);
  assert.equal(held.refused, 1); assert.equal(held.read.code, 'world.refused:collision.human-static'); assert.ok(held.dist > 0.5, `${held.dist} m from the table's middle`);
});
test('C4 a body still inside something can walk out of it, and a rule that flickers on a still body is absorbed', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada} = w.souls, id = Ada.entityId, a = h.engine.world.tick + 3; let steady = true;
  w.control.every = (r) => (r.tick >= a && (steady || r.tick % 2) ? [{code: 'collision.human-static', message: 'forced', subjects: [id]}] : []); await w.tick(20);
  assert.equal(h.engine.world.containedV1?.length, 1); const before = rows(w, "author='world:refusal'"), [x, , z] = h.engine.world.entities[id].pose.p;
  const walk = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(40);
  assert.equal(rows(w, "author='world:refusal'"), before, 'no refusal'); assert.equal(read(w, Ada, walk).phase, 'started'); const [nx, , nz] = h.engine.world.entities[id].pose.p; assert.ok(Math.hypot(nx - x, nz - z) > 1, 'she is walking');
  const pid = h.engine.programOf(id); if (pid) h.engine.stop(pid); await w.tick(5); steady = false; const stops = rows(w, "author='world:rewind'"), back = rows(w, "author='world:recovery'"); await w.tick(3000);
  assert.equal(rows(w, "author='world:rewind'"), stops, 'held, not faulted, past two holds'); assert.equal(rows(w, "author='world:recovery'"), back);
  const again = ok(await act(w, Ada, {capability: 'walk:yard'})); await w.tick(30); assert.notEqual(read(w, Ada, again).code, 'world.relocated', 'it never says she was moved');
});
for (const [what, every] of [['every tick', 1], ['every third tick', 3]])
  test(`C5 a rule that names someone new ${what} writes a few rows and stops, and Souls act`, async (t) => {
    quiet(t); const w = await world(t), host = w.f.host, {Bo} = w.souls, at = host.engine.world.tick + 5, base = rows(w, "author='world:rewind'");
    w.control.every = (r) => (r.tick >= at && r.tick % every === 0 ? [{code: 'support.floating', message: 'forced', subjects: [`g-${r.tick}`]}] : []);
    await w.tick(150); const first = rows(w, "author='world:rewind'") - base; assert.ok(first <= 10, `${first} rows`);
    await w.tick(1500); assert.equal(rows(w, "author='world:rewind'") - base, first, 'and none after'); assert.equal(host.stepFailing, null);
    const list = host.engine.world.containedV1; assert.ok(list.length <= 9, `${list.length} entries`); assert.ok(list.some((c) => c.subjects[0] === '*'), 'the rule, whole');
    assert.ok(w.f.db.db.prepare("SELECT COALESCE(SUM(LENGTH(payload)), 0) n FROM events WHERE author='world:rewind'").get().n < 8000); assert.ok(host.inPlaceAt.size <= 2, 'one per rule');
    ok(await act(w, Bo, {capability: 'walk:shed'}));
  });
test('C5 a fault naming many bodies at once keeps a few, and a restart agrees', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), host = w.f.host, at = host.engine.world.tick + 5;
  w.control.every = (r) => (r.tick >= at ? Array.from({length: 40}, (_, i) => ({code: 'support.floating', message: 'forced', subjects: [`g-${i}`]})) : []);
  await w.tick(60); const list = host.engine.world.containedV1; assert.ok(list.length <= 9, String(list.length)); assert.equal(host.stepFailing, null);
  const hash = host.engine.stateHash(), h = reboot(t, w, path); assert.deepEqual(h.engine.world.containedV1, list); assert.equal(h.engine.stateHash(), hash);
});
test('C5 a rule that comes back just past the hold goes back once, not every time', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, a = h.engine.world.tick + 5, base = rows(w, "author='world:recovery'");
  w.control.every = (r) => (r.tick >= a && (r.tick - a) % 1300 === 0 ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []);
  await w.tick(4000); assert.equal(rows(w, "author='world:recovery'") - base, 1, 'one whole-world row'); assert.ok(rows(w, "author='world:rewind'") >= 2, 'the rest stay on the head'); assert.equal(h.paused, false);
});
test('C5 a step that throws just past the hold goes back once too', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, a = h.engine.world.tick + 5, base = rows(w, "author='world:recovery'");
  w.control.preThrow = (e) => e.world.tick >= a && (e.world.tick - a) % 1300 === 0; await w.tick(4000);
  assert.equal(rows(w, "author='world:recovery'") - base, 1); assert.equal(h.paused, false); assert.equal(h.stepFailing, null);
});
test('C5 a long stretch of thrown steps keeps what the runtime holds bounded', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, subjects = Array.from({length: 10}, (_, i) => `g-${i}`);
  w.control.every = () => subjects.map((s) => ({code: 'support.floating', message: 'forced', subjects: [s]})); w.control.midThrow = () => true;
  await w.tick(2500); assert.ok(h.engine.rt.violations.length <= 1100, String(h.engine.rt.violations.length)); assert.ok(h.engine.rt.events.length <= 21000, String(h.engine.rt.events.length));
});
// What a step can throw from an action, with the fixture's walk standing in for any verb. The rest of the world goes on.
const brokenAction = (t, h, when) => { const def = h.engine.rt.registry.get('walk_to'), {step} = def; t.after(() => { def.step = step; }); def.step = (rt, exec, dt) => { if (when(rt, exec)) throw new Error('fixture.action-bug'); return step(rt, exec, dt); }; return def; };
test('C9 an action whose step throws ends alone: its Soul is told and acts again, and nobody else stops', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada, Bo} = w.souls, bo = ok(await act(w, Bo, {capability: 'walk:yard'})), ada = ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(5);
  const from = h.engine.world.tick + 2; brokenAction(t, h, (rt, exec) => exec.actor === Ada.entityId && rt.tick >= from); await w.tick(5);
  assert.equal(read(w, Ada, ada).code, 'engine.action-threw'); assert.equal(read(w, Bo, bo).phase, 'started', 'Bo walks on'); assert.equal(h.stepFailing, null); assert.equal(byRung(h).rewind, undefined);
  assert.equal(JSON.parse(w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:refusal' ORDER BY seq DESC LIMIT 1").get().payload).refusal.why, 'fixture.action-bug');
  const hash = h.engine.stateHash(), r = reboot(t, w, path); assert.equal(r.engine.stateHash(), hash);
});
test('C9 a child action that throws ends its whole tree, and the parent does not start it again', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls, rt = h.engine.rt, [bx, , bz] = h.engine.world.entities[Bo.entityId].pose.p, parent = rt.submit('walk_to', {actor: Bo.entityId, x: bx + 20, z: bz, level: 0}, {preempt: false}); await w.tick(2);
  assert.ok(rt.isActive(parent.id), JSON.stringify(parent)); const child = {id: 'fixture-child', parent: parent.id}; rt.records.set(child.id, child); const was = rt.isActive.bind(rt); t.mock.method(rt, 'isActive', (id) => id === child.id ? true : was(id));
  h.engine.abandonV1(child.id, new Error('fixture.action-bug')); assert.equal(was(parent.id), false, 'the parent ended with it'); rt.records.delete(child.id); await w.tick(3); ok(await act(w, Ada, {capability: 'walk:shed'}));
});
test('C9 a stop already under way whose action throws for ever ends, and the world and a reboot run on', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada, Bo} = w.souls;
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
  const def = brokenAction(t, h, (rt, exec) => [...rt.live.values()].find((l) => l.exec === exec)?.cancelling), {cancel} = def; t.after(() => { def.cancel = cancel; }); def.cancel = () => ({ok: true, deferred: true});
  w.control.fault = violate('support.floating', ['g-standing']); w.control.at = h.engine.world.tick + 3; await w.tick(400);
  assert.equal(h.engine.programOf(Ada.entityId), null); assert.equal(h.stepFailing, null); ok(await act(w, Bo, {capability: 'walk:yard'})); ok(await act(w, Ada, {capability: 'walk:yard'}));
  const hash = h.engine.stateHash(), r = reboot(t, w, path); assert.equal(r.stepFailing, null); assert.equal(r.engine.stateHash(), hash);
});
test('C9 a stop whose retried cancel throws ends too', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada} = w.souls; ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(10);
  const def = h.engine.rt.registry.get('walk_to'), {cancel} = def; t.after(() => { def.cancel = cancel; }); let asked = 0;
  def.cancel = () => { if (asked++ === 0) return {ok: false, diagnostic: {code: 'fixture.not-yet', message: 'not yet'}}; throw new Error('fixture.cancel-bug'); };
  h.engine.stop(h.engine.programOf(Ada.entityId)); await w.tick(30); assert.equal(h.stepFailing, null); assert.equal(h.engine.programOf(Ada.entityId), null); ok(await act(w, Ada, {capability: 'walk:yard'}));
});
test('C2 a stop in place finds two bodies in one spot: it moves one clear, says so, and a restart agrees', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada, Bo} = w.souls, E = h.engine.world.entities; h.lastRewindTick = h.engine.world.tick;
  const at = h.engine.world.tick + 2, moved = new WeakSet(); w.control.every = (r) => { if (r.tick === at && !moved.has(r)) { moved.add(r); const e = r.world.entities, [x, y, z] = e[Ada.entityId].pose.p; e[Bo.entityId].pose.p = [x + 0.1, y, z]; } return []; }; await w.tick(5);
  const row = JSON.parse(w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:rewind' ORDER BY seq DESC LIMIT 1").get().payload).lastRungInPlace;
  assert.ok(row.relocated.length >= 1, JSON.stringify(row)); assert.ok(Math.hypot(E[Ada.entityId].pose.p[0] - E[Bo.entityId].pose.p[0], E[Ada.entityId].pose.p[2] - E[Bo.entityId].pose.p[2]) > 0.5, 'apart');
  assert.ok(row.relocated.some((id) => w.comms.streams.read((id === Ada.entityId ? Ada : Bo).soulId, 0).events.some((e) => e.kind === 'world.relocated')), 'told');
  const hash = h.engine.stateHash(), b = reboot(t, w, path); assert.equal(b.engine.stateHash(), hash);
});
test('an event that throws live throws in the replay too, and the boot goes past it', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host; h.lastRewindTick = h.engine.world.tick;
  void h.enqueue('rules', 'test', {nativeSleepSnapshotPolicy: {}, extra: 1}).catch(() => {}); await w.tick(5); assert.equal(h.paused, false);
  const hash = h.engine.stateHash(), b = reboot(t, w, path); assert.equal(b.engine.stateHash(), hash);
});
test('while steps fail, an object act is refused as a walk is', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host; w.control.throwEvery = true; await w.tick(160); assert.ok(h.stepFailing);
  assert.equal((await w.edge.performBodies(w.souls.Bo, 'use', 'use', [])).code, 'world.step-failing');
});
test('a stop in place clears what a mind was waiting on, in a replay too', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, m = [...h.minds.values()][0]; m.pending = {card: 'c', program: 'p'};
  h.apply({seq: h.seq + 1, tick: h.engine.world.tick, kind: 'rules', author: 'world:rewind', payload: {lastRungInPlace: {contained: [], stopped: 0}}, at: 0}, true); assert.equal(m.pending, null);
});
test('C4 a body wider than a person inside something is relocated by its own width', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls, e = () => h.engine.world.entities[Ada.entityId], [x, , z] = e().pose.p;
  ok(w.god.act({ops: [{op: 'place', def: 'core/bench@1', name: 'bn', p: [x + 6, z + 6]}]})); await w.tick(5);
  e().body = {...(e().body ?? {}), family: 'floater', radius: 0.35}; await w.tick(2);
  const grid = h.engine.rt.services.spatial.levelAt(0, [x + 6, z + 6]); let spot = null;
  for (let dx = -3; dx <= 3 && !spot; dx += 0.03) for (let dz = -3; dz <= 3 && !spot; dz += 0.03) { const c = clearanceAt(grid, [x + 6 + dx, z + 6 + dz]); if (c >= 0.285 && c <= 0.335) spot = [x + 6 + dx, z + 6 + dz]; }
  assert.ok(spot, 'a spot clear for a person and not for her'); const bo = ok(await act(w, Bo, {capability: 'walk:yard'})); await w.tick(5);
  const b = e(); b.pose.p = [spot[0], b.pose.p[1], spot[1]]; forgetMotion(h.engine.rt); await w.tick(3);
  assert.ok(clearanceAt(grid, [e().pose.p[0], e().pose.p[2]]) >= 0.35, 'moved clear by her own radius'); assert.equal(read(w, Bo, bo).phase, 'started', 'and Bo never knew'); assert.equal(byRung(h).rewind, undefined);
});
test('C6 SIM_SOULS_REPAIR=0 turns repair off under shared building, and a shared world from before the ladder boots', async (t) => {
  quiet(t); const was = process.env.SIM_SOULS_REPAIR; t.after(() => { if (was === undefined) delete process.env.SIM_SOULS_REPAIR; else process.env.SIM_SOULS_REPAIR = was; });
  const shared = {...GREEN_FIELD_WORLD, sharedCarryV1: true};
  delete process.env.SIM_SOULS_REPAIR; const on = await marsFactory(shared); assert.match(on.rulesVersion, /\+souls-repair\//);
  process.env.SIM_SOULS_REPAIR = '0'; const off = await marsFactory(shared); assert.equal(off.rulesVersion, today.rulesVersion);
  assert.equal(on.canReplayHistory(today.rulesVersion), false, 'it takes the switch');
  const path = onDisk(t), w = await world(t, today, path); await w.tick(10); const hash = w.f.host.engine.stateHash();
  w.factory = faulted(off, w.control); const h = reboot(t, w, path); assert.equal(h.engine.stateHash(), hash); assert.equal(h.engine.rulesVersion, today.rulesVersion);
});
test('C7 a stop in place that stopped nothing tells no Soul it was rewound', async (t) => {
  quiet(t); const w = await world(t), host = w.f.host, {Bo} = w.souls, at = host.engine.world.tick + 5, told = () => w.comms.streams.read(Bo.soulId, 0).events.filter((e) => e.kind === 'world.rewound').length;
  host.lastRewindTick = host.engine.world.tick; const before = told(), base = rows(w, "author='world:rewind'");
  w.control.every = (r) => (r.tick === at ? [{code: 'support.floating', message: 'forced', subjects: ['g-standing']}] : []); await w.tick(15);
  assert.equal(rows(w, "author='world:rewind'") - base, 1, 'it is written'); assert.equal(told(), before, 'and nobody is told');
  const walk = ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(5);
  const again = host.engine.world.tick + 2; w.control.every = (r) => (r.tick === again ? [{code: 'support.floating', message: 'forced', subjects: ['g-other']}] : []); await w.tick(4); w.control.every = null;
  assert.equal(told(), before + 1, 'one that stopped a walk still is'); assert.equal(read(w, Bo, walk).code, 'world.rewound');
});

test('a durability failure still halts, and says so', async (t) => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {});
  const w = await world(t), host = w.f.host; t.mock.method(host, 'persistClockFrontier', () => { throw new Error('fixture.disk-full'); });
  await assert.rejects(async () => { await w.tick(3); }, /fixture\.disk-full/);
});

// Review of 450beab72: what a world keeps doing after a rung 3, and what a repeat fault leaves behind.
const fall = (w, s) => { w.control.fault = violate('support.floating', [s.entityId]); w.control.at = w.f.host.engine.world.tick + 2; };
test('R after a rung 3 the god side reads the engine that runs: a Soul puts down what it picked up, and context still answers', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls, was = h.engine, [x, , z] = was.world.entities[Ada.entityId].pose.p;
  ok(w.god.act({ops: [{op: 'place', def: 'core/bowl@2', name: 'bowl', p: [x + 1, z]}]})); await w.tick(30); const id = w.god.model.get('bowl').id;
  fall(w, Bo); await w.tick(6); assert.notEqual(h.engine, was, 'the engine was replaced'); assert.equal(byRung(h).rewind, 1);
  const up = ok(await act(w, Ada, {capability: `pick-up:${id}`})); await w.tick(200); assert.equal(read(w, Ada, up).phase, 'completed');
  const down = ok(await act(w, Ada, {capability: `put-down:${id}`})); await w.tick(200); assert.equal(read(w, Ada, down).phase, 'completed');
  await w.tick(40); assert.doesNotThrow(() => w.bridge.contextReady());
  ok(w.god.act({ops: [{op: 'place', def: 'core/bowl@2', name: 'bowl-after', p: [x + 3, z]}]})); await w.tick(40);
  assert.doesNotThrow(() => w.bridge.contextReady()); 
});
test('R a repeat fault that gives a stop under way its deadline writes it, so a crash boot agrees and the body comes free', async (t) => {
  quiet(t); const path = onDisk(t), w = await world(t, repair, path), h = w.f.host, {Ada} = w.souls;
  h.lastRewindTick = h.engine.world.tick; w.control.throwAt = h.engine.world.tick + 2; await w.tick(4);
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(6);
  const def = h.engine.rt.registry.get('walk_to'), {cancel, step} = def; t.after(() => { def.cancel = cancel; def.step = step; });
  def.cancel = () => ({ok: false, diagnostic: {code: 'support.release-premature', message: 'not yet'}}); def.step = () => ({status: 'running'});
  const id = h.engine.programOf(Ada.entityId); void h.enqueue('edge-stop', 'world:test', {programId: id}); await w.tick(3);
  assert.equal(h.engine.programs.get(id).stopByV1, undefined); const n = rows(w, "author='world:rewind'");
  w.control.throwAt = h.engine.world.tick + 2; await w.tick(4); assert.equal(rows(w, "author='world:rewind'"), n + 1, 'the deadline is a row'); const by = h.engine.programs.get(id).stopByV1; assert.ok(by);
  await w.tick(20); const hash = h.engine.stateHash(), r = reboot(t, w, path);
  assert.equal(r.engine.stateHash(), hash); assert.equal(r.engine.programs.get(id).stopByV1, by);
  for (let i = 0; i < 450 && r.engine.programOf(Ada.entityId); i++) r.tickOnce();
  assert.equal(r.engine.programOf(Ada.entityId), null, 'free by the deadline');
});
for (const age of [50, 600]) test(`R a stop's twenty seconds start at the rewind, with a baseline ${age} ticks old: cleanup runs and nothing is abandoned`, async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls, def = h.engine.rt.registry.get('walk_to'), {cancel, step} = def; t.after(() => { def.cancel = cancel; def.step = step; });
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(4);
  const began = new WeakMap(); let left = 0; def.cancel = () => ({ok: true, deferred: true});
  def.step = (rt, exec) => { if (![...rt.live.values()].find(x => x.exec === exec)?.cancelling) return {status: 'running'}; if (!began.has(exec)) began.set(exec, rt.tick); left = rt.tick - began.get(exec); return left >= 30 ? {status: 'completed', outputs: {}} : {status: 'running'}; };
  await w.tick(2); h.saveSnapshot(true); await w.tick(age); const id = h.engine.programOf(Ada.entityId);
  fall(w, Bo); await w.tick(3); assert.equal(byRung(h).rewind, 1); const p = h.engine.programs.get(id); assert.ok(p?.stopByV1 >= h.engine.world.tick + 390, `by ${p?.stopByV1} at ${h.engine.world.tick}`);
  const n = rows(w, "author='world:refusal'"); await w.tick(45);
  assert.equal(left, 30, 'its own cleanup ran'); assert.equal(h.engine.programOf(Ada.entityId), null); assert.equal(rows(w, "author='world:refusal'"), n, 'nothing abandoned');
});
test('R a repeat stop that ended a Soul\'s work is counted, and a thrown step asks for a snapshot', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Bo} = w.souls; h.lastRewindTick = h.engine.world.tick;
  const at = () => w.f.db.latestSnapshot(h.worldId)?.tick ?? -1, before = at(); w.control.throwAt = h.engine.world.tick + 2; await w.tick(6); assert.ok(at() > before, 'a boot needn\'t repeat that throw');
  const n = byRung(h).rewind ?? 0, walk = ok(await act(w, Bo, {capability: 'walk:shed'})); await w.tick(8); w.control.throwAt = h.engine.world.tick + 2; await w.tick(4);
  assert.equal(read(w, Bo, walk).code, 'world.rewound'); assert.equal(byRung(h).rewind, n + 1); assert.equal(h.rewinds, n + 1);
});
test('R a failing stretch keeps the ordinary beat: batches go out, the log drains, and heartbeats stay rare', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host; let batches = 0, beats = 0; h.listeners.push({onBatch() { batches++; }, onHeartbeat() { beats++; }});
  w.control.throwEvery = true; await w.tick(300); assert.ok(h.stepFailing); batches = beats = 0;
  for (let i = 0; i < 200; i++) { void h.enqueue('rules', 'system', {note: `chatter ${i}`}); await w.tick(1); }
  assert.ok(batches >= 15, `${batches} batches`); assert.ok(beats <= 6, `${beats} heartbeats`); assert.ok(h.acc.log.length <= 25, `${h.acc.log.length} held`);
});
test('R a burst that passes leaves no refusal behind: one tick in five still throwing acts as it would with no burst', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Bo} = w.souls; w.control.midThrow = () => true; await w.tick(260); assert.ok(h.stepFailing);
  w.control.midThrow = (e) => e.world.tick % 5 === 0; await w.tick(300); assert.equal(h.stepFailing, null); ok(await act(w, Bo, {capability: 'wave:here'}));
});
test('L3 stops and refusals since the baseline are left out too: what they answered did not happen', async (t) => {
  quiet(t); const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls; h.saveSnapshot(true); await w.tick(2);
  ok(await act(w, Ada, {capability: 'walk:shed'})); await w.tick(4); void h.enqueue('edge-stop', 'world:test', {programId: h.engine.programOf(Ada.entityId)});
  void h.enqueue('rules', 'world:refusal', {refusal: {tick: 0, rule: 'collision.human-static', bodies: [], programs: [], poses: {}}}); await w.tick(4);
  fall(w, Bo); await w.tick(6); const recipe = JSON.parse(w.f.db.db.prepare("SELECT payload FROM events WHERE author='world:recovery' ORDER BY seq DESC LIMIT 1").get().payload).recovery;
  assert.ok(recipe.lastRung); assert.deepEqual(recipe.events.filter(e => e.kind === 'edge-stop' || e.kind === 'decision' || e.author === 'world:refusal'), []);
  assert.equal(w.f.host.engine.programOf(Ada.entityId), null);
});
