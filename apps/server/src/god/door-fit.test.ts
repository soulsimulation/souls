// #2383 door-fit/1 on a copy of a template world: Hello Hamlet as it was before its buildings were door-fitted (the fitted
// revisions mapped back, their doors left out) boots, the boot rule fits it, one recorded edit per building, and logs one rules event,
// the result equals the fitted template's own buildings and doors, nobody moves, and a second boot does nothing.
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_DOORS_FROM, DOOR_FIT_FROM } from '@souls/world-compiler';
import { bootEden } from '../../test/eden-capabilities-timing.ts';
import { adoptBootRuntimePoliciesV1, doorFitBoot, doorFitV1, doorFitV2, enableDoorFitV1, enableDoorFitV2 } from '../edge-runtime-rules.ts';
import { doorFit, doorFitted, doorHandBlocked, fitWorldDoorsV2, DOOR_FIT_DOOR, type HandObstacle } from './door-fit.ts';
import { accept, fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';

// #2434: door-fit/1's templates as #2383 left them (outside ground-floor doors only); worlds/templates now carry door-fit/2
const template = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/door-fit1/${name}.json`, import.meta.url), 'utf8'));
const current = (name: string) => JSON.parse(readFileSync(new URL(`../../../../worlds/templates/${name}.json`, import.meta.url), 'utf8'));
const fitted = template('hello-hamlet');
const back = new Map([...DOOR_FIT_FROM].map(([from, to]) => [to.ref, from]));
type PlaceOp = { op: string; def: string; name?: string; p?: number[]; r?: number; params?: Record<string, unknown>; state?: Record<string, unknown> };
const places = (tpl: { batches: { ops: PlaceOp[] }[] }) => tpl.batches.flatMap((b) => b.ops).filter((o) => o.op === 'place');

/** Runs a boot rule while the world ticks, as a serving world does between the rule's slices (door-fit/2's reach check
 *  waits for the engine to take each edit in). */
async function ticking<T>(host: { tickOnce(): void; drainInputs(): void }, p: Promise<T>): Promise<T> {
  let done = false; p.then(() => done = true, () => done = true);
  while (!done) { host.tickOnce(); await setImmediate(); host.drainInputs(); }
  return p;
}

/** A template as it was before door-fit (the fitted revisions mapped back, their doors left out), booted. */
async function before(t: { after: (f: () => void) => void }, fitted: { batches: { ops: PlaceOp[] }[] }) {
  const before = structuredClone(fitted) as { batches: { ops: PlaceOp[] }[] };
  for (const b of before.batches) b.ops = b.ops.filter((o) => !(o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? ''))).map((o) => back.has(o.def) ? { ...o, def: back.get(o.def)! } : o);
  const file = join(mkdtempSync(join(tmpdir(), 'door-fit-')), 'before.json'); writeFileSync(file, JSON.stringify(before));
  const w = await bootEden(() => {}, pathToFileURL(file)); t.after(w.close);
  return { w, old: places(before).filter((o) => DOOR_FIT_FROM.has(o.def)) };
}

test('door-fit/1: a template world from before is fitted once, like the fitted template, and nobody moves', { timeout: 300000 }, async (t) => {
  const { w, old } = await before(t, fitted);
  assert.equal(old.length, 3, 'a cottage and two halls on their old revisions');
  const { god, host, soul } = w;
  const ents = () => host.engine.world.entities as Record<string, { pose: { p: number[] } }>;
  const pose0 = structuredClone(ents()[soul.entityId]!.pose);
  const ids0 = [...god.model.entities.values()].filter((e) => doorFitted(e.def)).map((e) => [e.id, god.model.subtree(e.id)] as const);
  const seq0 = god.model.editSeq;

  const fact = await accept<unknown>(host, enableDoorFitV1(host, god) as Promise<never>) as { payload: { doorFitV1: unknown; runtimePolicy: { doorFitV1: boolean } } };
  assert.deepEqual(fact.payload.doorFitV1, { buildings: 3, doors: 3, series: 0, held: 0 }, 'logged with what it fitted');
  assert.equal(fact.payload.runtimePolicy.doorFitV1, true);
  assert.equal(god.model.editSeq, seq0 + 3, 'one recorded edit per building (review of #2438: in slices)');
  await w.settle(10);

  // the same ids and contents, on the fitted revisions; the doors the fitted template places, open (until #2434)
  for (const [id, sub] of ids0) { assert.equal(god.model.entities.get(id)!.def.replace('core-', 'core/'), DOOR_FIT_FROM.get(old.find((o) => o.name === god.model.entities.get(id)!.name)!.def)!.ref); assert.deepEqual(god.model.subtree(id), sub, 'contents kept'); }
  assert.equal([...god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0, 'nothing left on an old revision');
  const doors = [...god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => ({ name: e.name, p: [e.p![0], e.p![e.p!.length - 1]], r: e.r, sx: e.params?.sx, sy: e.params?.sy, open: e.state?.open }));
  const want = places(fitted).filter((o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '')).map((o) => ({ name: o.name, p: [o.p![0], o.p![o.p!.length - 1]], r: o.r, sx: o.params?.sx, sy: o.params?.sy, open: o.state?.open }));
  assert.equal(doors.length, 3);
  assert.deepEqual(new Set(doors.map((d) => JSON.stringify(d))), new Set(want.map((d) => JSON.stringify(d))), 'the live world and the template agree');
  assert.ok(doors.every((d) => d.open === true), 'placed open until the multi-door passage (#2434)');
  assert.deepEqual(ents()[soul.entityId]!.pose.p, pose0.p, 'nobody moved');
  assert.deepEqual(host.engine.runtime.violations, []);

  assert.equal(await enableDoorFitV1(host, god), undefined, 'once: a second boot queues nothing');
  assert.equal(god.model.editSeq, seq0 + 3, 'and edits nothing');
});

test('door-fit/1: every door is placed open (until #2434), a body in its doorway or not', () => {
  const cottage = places(fitted).find((o) => o.def === 'core/cottage@2')!;
  const fit = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name)!;
  const at = fit.doors[0]!.p as [number, number];
  const busy = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name, [[at[0] + 0.3, at[1]]])!;
  assert.ok(fit.doors.length > 0 && [...fit.doors, ...busy.doors].every((d) => d.state!.open === true), 'open');
  assert.equal(doorFit('core/hall@2', {}, [0, 0], 0, 'x'), null, 'core/hall@2 already has its doors');
});

// Review of #2397: a door a hand cannot work is held back as an open gap. Mars Camp's living room has a bench where the body
// steps while closing its door from inside (contact.step-blocked): door-fit/1 places its other doors and leaves that
// doorway bare, as the fitted template does.
test('door-fit/1: a door a hand cannot work is held back; the rest are placed, as in the template', { timeout: 300000 }, async (t) => {
  const camp = template('mars-camp');
  const { w } = await before(t, camp);
  const fact = await accept<unknown>(w.host, enableDoorFitV1(w.host, w.god) as Promise<never>) as { payload: { doorFitV1: { held: number; doors: number } } };
  assert.equal(fact.payload.doorFitV1.held, 1, 'one held back');
  const names = [...w.god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => e.name).sort();
  const want = places(camp).filter((o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '')).map((o) => o.name).sort();
  assert.deepEqual(names, want, 'the doors the fitted template has');
  assert.ok(!names.includes('living-room-door-1'), 'the living room doorway stays an open gap');
  assert.equal(fact.payload.doorFitV1.doors, want.length);
});

// Review of #2397: no refusal is final. A building the world refuses (a code other than body.protected) keeps its old
// revision this boot, the rules event waits, and the next boot fits it.
test('door-fit/1: a refused building is tried again at the next boot', { timeout: 300000 }, async (t) => {
  const { w } = await before(t, fitted);
  const real = w.god.engineAct.bind(w.god);
  w.god.engineAct = (() => ({ accepted: false, failures: [{ op: 0, code: 'overlap.solid', detail: 'test: refused' }] })) as never;
  assert.equal(await enableDoorFitV1(w.host, w.god), undefined, 'refused: no event');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 3, 'kept on the old revisions');
  w.god.engineAct = real;
  const fact = await accept<unknown>(w.host, enableDoorFitV1(w.host, w.god) as Promise<never>) as { payload: { doorFitV1: { buildings: number } } };
  assert.equal(fact.payload.doorFitV1.buildings, 3, 'the next boot fits them');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0);
});

// #2434 door-fit/2: a world as door-fit/1 left it (outside ground-floor doors only) gets a real door in every other
// doorway in one recorded edit and one logged event, the same doors the template now carries; a door both of whose
// swings a prop blocks moves the prop (Mars Camp's living-room bench, 0.25 m); a second boot does nothing.
for (const name of ['hello-hamlet', 'mars-camp']) {
  test(`door-fit/2: ${name} as door-fit/1 left it gets every doorway's door, like the template`, { timeout: 300000 }, async (t) => {
    const w = await bootEden(() => {}, new URL(`../../test/fixtures/door-fit1/${name}.json`, import.meta.url)); t.after(w.close);
    const { god, host, soul } = w;
    const ents = () => host.engine.world.entities as Record<string, { pose: { p: number[] } }>;
    const pose0 = structuredClone(ents()[soul.entityId]!.pose);
    const doorNames = () => [...god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => e.name).sort();
    const before = doorNames();
    // its own edits, counted (a resident's acts may edit too while the world ticks)
    let edits = 0; const act = god.engineAct.bind(god);
    god.engineAct = ((ops, note, ...rest) => { const x = act(ops, note, ...rest); if (x.accepted && note.startsWith('door-fit/2')) edits++; return x; }) as typeof god.engineAct;
    const fact = await ticking(host, enableDoorFitV2(host, god) as Promise<never>) as { payload: { doorFitV2: { buildings: number; doors: number; moved: number; held: number }; runtimePolicy: { doorFitV2: boolean } } };
    assert.equal(fact.payload.runtimePolicy.doorFitV2, true);
    assert.equal(fact.payload.doorFitV2.held, 0, 'no doorway left without a door');
    assert.equal(edits, fact.payload.doorFitV2.buildings, 'one recorded edit per building (review of #2438: in slices)');
    const want = places(current(name)).filter((o) => o.def === DOOR_FIT_DOOR).map((o) => o.name).sort();
    assert.deepEqual(doorNames(), want, 'the doors the template carries');
    assert.equal(fact.payload.doorFitV2.doors, want.length - before.length, 'door-fit/1\'s doors kept, the rest added');
    assert.ok([...god.model.entities.values()].filter((e) => /^core-\w[\w-]*@\d+$/.test(e.def) && e.in.parent === 'world').every((e) => !doorFitted(e.def)));
    if (name === 'mars-camp') {
      assert.equal(fact.payload.doorFitV2.moved, 1, 'the living-room bench moved clear');
      const bench = [...god.model.entities.values()].find((e) => e.name === 'living-bench')!, tpl = places(current(name)).find((o) => o.name === 'living-bench')!;
      assert.deepEqual(bench.p, tpl.p, 'where the template has it');
    }
    await w.settle(10);
    assert.deepEqual(ents()[soul.entityId]!.pose.p, pose0.p, 'nobody moved');
    assert.deepEqual(host.engine.runtime.violations, []);
    const edits1 = edits;
    assert.equal(await ticking(host, enableDoorFitV2(host, god)), undefined, 'once: a second boot queues nothing');
    assert.equal(edits, edits1, 'and edits nothing');
  });
}

// Review of #2438: a prop moved clear of a door touches no body, no other solid and no doorway, and every door of its
// building a hand could work before still works. A two-floor cottage with a bench between its two inside doorways (0.6 m
// from the second, turned across the way): door-fit/2 moves it 0.75 m clear of house-door-2, towards house-door-1.
async function cottageWithBench(t: { after: (f: () => void) => void }) {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'dev:admin', tick: () => w.host.engine.world.tick, emit() {} });
  installEngineBridge({ host: w.host, god, edge: new EdgeLedger(w.host, w.db, undefined, { ambient: false }), log() {}, worldClock: false, worldLore: false });
  t.after(() => { w.brain.quiesce(); w.host.stop(); w.db.close(); });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  assert.equal((god.engineAct([{ op: 'place', def: 'core/cottage@1', name: 'house', p: [10, 10], r: 0, params: { floors: 2 } }] as never, 'test: a house') as { accepted: boolean }).accepted, true);
  const house = [...god.model.entities.values()].find((e) => e.name === 'house')!;
  assert.equal((god.engineAct([{ op: 'place', def: 'core/bench-seat@1', name: 'prop', in: { parent: house.id }, p: [-1.1, 0, 0.6], r: 1.571 }] as never, 'test: a bench') as { accepted: boolean }).accepted, true);
  await tick(6);
  // the engine's walk graph as it stands now (synced; the service may be replaced after an edit)
  const solidsNow = () => { const sp = (w.host.engine as unknown as { rt: { services: { spatial: { sync(x: unknown): void; scene: { obstacles: HandObstacle[] } } } } }).rt.services.spatial; sp.sync(w.host.engine.world); return sp.scene.obstacles; };
  return { w, god, house, tick, solidsNow };
}
const rectGapTo = (o: HandObstacle, x: number, z: number) => { const c = Math.cos(o.obb.yaw), s = Math.sin(o.obb.yaw), dx = x - o.obb.c[0], dz = z - o.obb.c[1]; return Math.hypot(Math.max(0, Math.abs(dx * c + dz * s) - o.obb.half[0]), Math.max(0, Math.abs(-dx * s + dz * c) - o.obb.half[1])); };

test('door-fit/2: a prop between two doors moves clear of one and leaves the other workable and its doorway clear', { timeout: 300000 }, async (t) => {
  const { w, god, house, tick, solidsNow } = await cottageWithBench(t);
  const before = solidsNow(), prop = [...god.model.entities.values()].find((e) => e.name === 'prop')!, p0 = god.model.worldPose(prop);
  const rep = await fitWorldDoorsV2(god, [], () => {}, before, { pause: () => tick(1) });
  assert.deepEqual(rep.moved, ['prop moved 0.75 m clear of house-door-2']);
  // #2438: the move reaches the engine, so the walk graph has the bench where the model has it
  await tick(4);
  const E = w.host.engine.world.entities as Record<string, { def: string; pose: { p: number[] } }>;
  assert.ok(god.model.subtree(house.id).filter((id) => god.model.entities.get(id)!.def.replace('core-', 'core/') === DOOR_FIT_DOOR).every((id) => E[id]), 'its doors are in the engine');
  assert.match(E[house.id]!.def, new RegExp(`:${god.model.entities.get(house.id)!.def}:`), 'and its every-doorway revision');
  const eng = E[prop.id]!.pose.p, mp = god.model.worldPose(god.model.entities.get(prop.id)!);
  assert.ok(Math.hypot(eng[0]! - mp.x, eng[2]! - mp.z) < 1e-3, `engine ${eng} vs model ${[mp.x, mp.z]}`);
  // the walk graph's solids with the bench where the model now has it (as the fit judged it)
  const p1 = god.model.worldPose(god.model.entities.get(prop.id)!), mine = (o: HandObstacle) => o.id === prop.id || o.id.startsWith(prop.id + '#');
  const after = before.filter((o) => !o.id.startsWith(house.id + '#')).map((o) => mine(o) ? { ...o, obb: { ...o.obb, c: [o.obb.c[0] + p1.x - p0.x, o.obb.c[1] + p1.z - p0.z] as [number, number] } } : o);
  const doors = god.model.subtree(house.id).map((id) => god.model.entities.get(id)!).filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR);
  assert.ok(doors.length >= 4, 'the inside and upstairs doors');
  // no door's hand is stopped by the bench where it now stands
  for (const d of doors) { const hit: { id?: string } = {}, why = doorHandBlocked(god.model, d.id, after, () => false, hit); assert.notEqual(hit.id?.split('#')[0], prop.id, `${d.name}: not the bench: ${why}`); }
  // the bench stands clear of every doorway's opening
  const ways = doorFit('core/cottage@1', { floors: 2 }, [10, 0, 10], 0, 'house', [], () => false, undefined, { baseY: 0, existing: () => false, parent: house.id })!.ways.filter((w) => w.floor === 0);
  for (const w of ways) assert.ok(after.filter(mine).every((o) => rectGapTo(o, w.p[0], w.p[1]) > 0.3), `clear of the doorway at ${w.p}`);
});

test('door-fit/2: a prop never moves onto a Soul standing beside it', { timeout: 300000 }, async (t) => {
  const { god, tick, solidsNow } = await cottageWithBench(t);
  // she stands beside the bench's end, clear of it, where it goes without her (0.75 m along -z)
  const body: [number, number] = [8.9, 9.4];
  const prop0 = [...god.model.entities.values()].find((e) => e.name === 'prop')!, start = solidsNow();
  for (const o of start.filter((x) => x.id === prop0.id || x.id.startsWith(prop0.id + '#'))) assert.ok(rectGapTo(o, body[0], body[1]) >= HUMAN_RADIUS, 'beside it, clear: ' + JSON.stringify(o.obb));
  const rep = await fitWorldDoorsV2(god, [body], () => {}, start, { pause: () => tick(1) });
  assert.ok(!rep.moved.includes('prop moved 0.75 m clear of house-door-2'), 'not onto her: ' + JSON.stringify(rep.moved));
  const p0 = god.model.worldPose(prop0), p1 = god.model.worldPose(god.model.entities.get(prop0.id)!);
  for (const o of start.filter((x) => x.id === prop0.id || x.id.startsWith(prop0.id + '#'))) assert.ok(rectGapTo(o, body[0] - (p1.x - p0.x), body[1] - (p1.z - p0.z)) >= HUMAN_RADIUS, 'a body radius clear of her');
});

// Coordinator, push of 15 Nov: live-world door migration is off until a fit can run in slices under 1 s. One building's
// engine edit took up to 15.9 s on Eden, so the boot rules (door-fit/1 and door-fit/2) run only with DOOR_FIT_BOOT=1;
// templates, and so new worlds, keep their doors.
test('door-fit at boot is opt-in: DOOR_FIT_BOOT=1, off by default', () => {
  assert.equal(doorFitBoot({}), false, 'off when unset');
  assert.equal(doorFitBoot({ DOOR_FIT_BOOT: '0' }), false);
  assert.equal(doorFitBoot({ DOOR_FIT_BOOT: '1' }), true);
});

/** Eden's template as main had it before any door fit: both fitted revisions mapped back to the original, the fitted doors left out. */
function edenBefore() {
  const orig = new Map([...DOOR_FIT_FROM].flatMap(([from, to]) => [[to.ref, from], [ALL_DOORS_FROM.get(from)!.ref, from]] as [string, string][]));
  const tpl = current('eden-2026') as { batches: { ops: PlaceOp[] }[] };
  for (const b of tpl.batches) b.ops = b.ops.filter((o) => !(o.def === DOOR_FIT_DOOR && /-door-[\d-]+$/.test(o.name ?? ''))).map((o) => orig.has(o.def) ? { ...o, def: orig.get(o.def)! } : o);
  return tpl;
}

test('door-fit off: booting Eden from before the fit adopts nothing and adds no door', { timeout: 600000 }, async (t) => {
  const was = process.env.DOOR_FIT_BOOT; delete process.env.DOOR_FIT_BOOT; t.after(() => { if (was !== undefined) process.env.DOOR_FIT_BOOT = was; });
  const tpl = edenBefore(), file = join(mkdtempSync(join(tmpdir(), 'door-fit-')), 'before.json'); writeFileSync(file, JSON.stringify(tpl));
  const w = await bootEden(() => {}, pathToFileURL(file)); t.after(w.close);
  const old = [...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length;
  assert.ok(old > 200, `Eden's buildings on their old revisions (${old})`);
  const seq0 = w.god.model.editSeq, doors = () => [...w.god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).length, doors0 = doors();
  await accept<unknown>(w.host, adoptBootRuntimePoliciesV1(w.host, { edge: false, worldKey: 'eden', god: () => w.god }));
  assert.equal(doorFitV1(w.host), false, 'door-fit/1 not adopted');
  assert.equal(doorFitV2(w.host), false, 'door-fit/2 not adopted');
  assert.equal(w.god.model.editSeq, seq0, 'no edit');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, old, 'every building keeps its drawn doorways');
  assert.equal(doors(), doors0, 'no door added');
});

test('door-fit on (DOOR_FIT_BOOT=1): the boot rules run the sliced fits', { timeout: 300000 }, async (t) => {
  const was = process.env.DOOR_FIT_BOOT; process.env.DOOR_FIT_BOOT = '1'; t.after(() => { if (was === undefined) delete process.env.DOOR_FIT_BOOT; else process.env.DOOR_FIT_BOOT = was; });
  const { w } = await before(t, fitted);
  const seq0 = w.god.model.editSeq;
  await ticking(w.host, adoptBootRuntimePoliciesV1(w.host, { edge: false, worldKey: 'eden', god: () => w.god }));
  assert.equal(doorFitV1(w.host), true, 'door-fit/1 adopted');
  assert.equal(doorFitV2(w.host), true, 'door-fit/2 adopted');
  assert.ok(w.god.model.editSeq >= seq0 + 6, 'recorded edits, one per building per fit');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def) || ALL_DOORS_FROM.has(e.def.replace('core-', 'core/'))).length, 0, 'every building on its every-doorway revision');
});
