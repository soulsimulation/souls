// #2462: the live door-fit rule's gaps from #2438's review, each on a two-floor cottage in a native fixture world (no
// template boot): the reach check waits for the engine and refuses to judge on a lagging one; a building with no outside
// door yet is checked from its planned doorway; the bodies are read again for each building and a doorway with a body in
// it gets no door; the edit goes through BUILDSAFE as a god edit would; the engine is sent the edit's own diff; a fitted
// door follows its building; a fit that still cuts a way off with every new door out is undone; the boot is not held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ALL_DOORS_FROM } from '@souls/world-compiler';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { adoptBootRuntimePoliciesV1, doorFitV2, engineDoorReach } from '../edge-runtime-rules.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { doorFit, fitWorldDoorsV1, fitWorldDoorsV2, DOOR_FIT_DOOR, type DoorReach, type HandObstacle } from './door-fit.ts';
import { projectProviders } from './query.ts';

const ref = (d: string) => d.replace(/^core-/, 'core/');

async function cottage(t: { after: (f: () => void) => void }) {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'dev:admin', tick: () => w.host.engine.world.tick, emit() {} });
  installEngineBridge({ host: w.host, god, edge: new EdgeLedger(w.host, w.db, undefined, { ambient: false }), log() {}, worldClock: false, worldLore: false });
  t.after(() => { w.brain.quiesce(); w.host.stop(); w.db.close(); });
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  assert.equal((god.engineAct([{ op: 'place', def: 'core/cottage@1', name: 'house', p: [10, 10], r: 0, params: { floors: 2 } }] as never, 'test: a house') as { accepted: boolean }).accepted, true);
  const house = [...god.model.entities.values()].find((e) => e.name === 'house')!;
  await tick(6);
  const solids = () => { const sp = (w.host.engine as unknown as { rt: { services: { spatial: { sync(x: unknown): void; scene: { obstacles: HandObstacle[] } } } } }).rt.services.spatial; sp.sync(w.host.engine.world); return sp.scene.obstacles; };
  const doors = () => [...god.model.entities.values()].filter((e) => ref(e.def) === DOOR_FIT_DOOR);
  const ways = () => doorFit('core/cottage@1', { floors: 2 }, [10, 0, 10], 0, 'house', [], () => false, undefined, { baseY: 0, existing: () => false, parent: house.id })!.ways;
  return { w, god, house, tick, solids, doors, ways, def0: house.def };
}
/** Runs a fit while the world ticks between its slices, as a serving world does. */
async function ticking<T>(host: { tickOnce(): void; drainInputs(): void }, p: Promise<T>): Promise<T> {
  let done = false; p.then(() => done = true, () => done = true);
  while (!done) { host.tickOnce(); await setImmediate(); host.drainInputs(); }
  return p;
}

test('#2462 settle: a fit is not judged on an engine that has not taken the last edit in', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, def0 } = await cottage(t);
  const real = engineDoorReach(w.host, god)!, seq0 = god.model.editSeq, logs: string[] = [];
  // the engine never settles before the fit: nothing is edited, the building is tried again at the next boot
  const lagging: DoorReach = { ...real, settle: async () => false };
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], (m) => logs.push(m), solids(), { walk: lagging }));
  assert.deepEqual(r.kept, [house.id]);
  assert.equal(god.model.editSeq, seq0, 'no edit');
  assert.ok(logs.some((m) => /had not taken the last edit in/.test(m)), logs.join('\n'));
  // it settles for the baseline, then not after the edit: the edit is undone, tried again at the next boot
  let calls = 0;
  const lateLag: DoorReach = { ...real, settle: async () => ++calls === 1 ? real.settle() : false };
  const r2 = await ticking(w.host, fitWorldDoorsV2(god, [], (m) => logs.push(m), solids(), { walk: lateLag }));
  assert.deepEqual(r2.kept, [house.id]);
  assert.equal(god.model.entities.get(house.id)!.def, def0, 'back on its revision');
  assert.equal(doors().length, 0, 'no door left behind');
  assert.ok(logs.some((m) => /fit undone: the engine had not taken it in/.test(m)), logs.join('\n'));
});

test('#2462 front: a building with no outside door yet is checked from its planned outside doorway', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, ways } = await cottage(t);
  const real = engineDoorReach(w.host, god)!;
  assert.equal(doors().length, 0, 'no door yet');
  assert.equal(real.front(house.id), null, 'no door to stand at (the gap the review found)');
  const from = real.front(house.id, ways());
  assert.ok(from, 'a stand outside its planned outside doorway');
  let reached = 0;
  const counted: DoorReach = { ...real, reach: (...a) => { reached++; return real.reach(...a); } };
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids(), { walk: counted }));
  assert.equal(r.buildings, 1);
  assert.ok(reached > 0, 'the reach check ran');
  assert.ok(r.doors >= 4, `its doors placed (${r.doors})`);
});

test('#2462 bodies: read again for each building; a doorway with a body in it gets no door this boot', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, ways } = await cottage(t);
  const way = ways().find((x) => x.exterior && x.floor === 0)!;
  let reads = 0;
  // nobody about while it plans; a body steps into the front doorway before the edit
  const bodies = () => (++reads > 1 ? [way.p] : []) as [number, number][];
  const logs: string[] = [], seq0 = god.model.editSeq;
  const r = await ticking(w.host, fitWorldDoorsV2(god, bodies, (m) => logs.push(m), solids()));
  assert.ok(reads >= 2, 'read again just before the edit');
  assert.deepEqual(r.left, [house.id], 'left for a later boot');
  assert.equal(god.model.editSeq, seq0, 'no edit');
  assert.equal(doors().length, 0);
  assert.ok(logs.some((m) => /a body stands in a doorway/.test(m)), logs.join('\n'));
});

test('#2462 BUILDSAFE: the fit is checked as a god edit is, on the would-be world, and waits for a pending preview', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors } = await cottage(t);
  const b = god.bodies!, seen: string[] = [];
  // legal-edits/1 names a Soul in the edit's way: refused, left for a later boot, no edit
  b.legal = (before, after) => { seen.push(before === god.model && after !== god.model ? 'would-be' : 'other'); return [{ op: -1, code: 'body.in-the-way', entity: 'h_test', field: 'legal-edits/1', detail: 'test: a Soul in its way' }]; };
  const seq0 = god.model.editSeq;
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids()));
  assert.deepEqual(r.left, [house.id]);
  assert.equal(god.model.editSeq, seq0);
  assert.deepEqual(seen, ['would-be'], 'checked on the would-be world before the commit');
  // without legal-edits/1: an edit the walk-out planner would walk somebody out for is refused too
  b.legal = () => null;
  const prepare = b.prepare!;
  b.prepare = (before, after, diff, ops, o) => o?.dry ? { moved: [{ soulId: 's', body: 'h_test', name: 'Ada', how: 'walked', from: [0, 0], to: [1, 1], reason: 'test', released: [] }], warnings: [], touched: [] } : prepare(before, after, diff, ops, o);
  const r2 = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids()));
  assert.deepEqual(r2.left, [house.id]);
  assert.equal(god.model.editSeq, seq0, 'nobody is walked out for a fit');
  b.prepare = prepare;
  // a pending preview is waited for (off the tick thread), then the edit is checked again and made
  let pending = true, runs = 0;
  b.legal = () => pending ? 'pending' : null;
  b.legalRun = async () => { runs++; pending = false; return null; };
  const r3 = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids()));
  assert.equal(runs, 1);
  assert.equal(r3.buildings, 1);
  assert.ok(doors().length >= 4);
});

test('#2462 projection: the engine is sent the edit\'s own diff (its tiles and defs), not one rebuilt without them', { timeout: 120000 }, async (t) => {
  const { w, god, solids } = await cottage(t);
  const gated: unknown[] = [], sent: unknown[] = [], act = god.engineAct.bind(god), project = projectProviders.get(god.model)!;
  god.engineAct = ((ops, note, c, d, gate) => act(ops, note, c, d, gate && ((b, a, diff, inv) => { gated.push(diff); return gate(b, a, diff, inv); }))) as typeof god.engineAct;
  projectProviders.set(god.model, (diff) => { sent.push(diff); project(diff); });
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids()));
  assert.equal(r.buildings, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], gated[0], 'the very diff the edit made');
  const diff = sent[0] as { tiles: string[]; defs: unknown[] };
  assert.ok(Array.isArray(diff.tiles) && Array.isArray(diff.defs));
});

test('#2462 follow: a fitted door, and a door-fit/1 door, is the building\'s, so it moves with the building', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, tick } = await cottage(t);
  // door-fit/1 first: its outside door is world-root
  const v1 = await ticking(w.host, fitWorldDoorsV1(god, [], () => {}, solids(), { pause: () => tick(1) }));
  assert.equal(v1.buildings, 1);
  const old = doors().filter((d) => d.in.parent === 'world');
  assert.ok(old.length >= 1, 'door-fit/1 placed a world-root door');
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids(), { follow: true }));
  assert.equal(r.adopted, old.length, 'door-fit/1\'s doors made the building\'s');
  assert.ok(doors().length >= 4 && doors().every((d) => d.in.parent === house.id), 'every door is the building\'s');
  assert.ok(old.every((d) => god.model.entities.get(d.id)?.in.parent === house.id), 'the same ids');
  const at0 = new Map(doors().map((d) => { const p = god.model.worldPose(d); return [d.id, [p.x, p.y, p.z]] as const; }));
  assert.equal((god.engineAct([{ op: 'move', id: house.id, p: [13, 10] }] as never, 'test: the house moves') as { accepted: boolean }).accepted, true);
  for (const d of doors()) { const p = god.model.worldPose(d), q = at0.get(d.id)!; assert.ok(Math.abs(p.x - q[0] - 3) < 1e-6 && Math.abs(p.z - q[2]) < 1e-6, `${d.name} followed: ${[p.x, p.z]} from ${q}`); }
});

test('#2462 cut off: a fit that cuts a way off with every new door out is undone and refused, named', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, def0 } = await cottage(t);
  const real = engineDoorReach(w.host, god)!, seq0 = god.model.editSeq;
  // everything reached before the edit; after it, a seat upstairs is not (a cut no door's side shows), whatever door is out
  let edited = false;
  const cut: DoorReach = { ...real, reach: () => true, seats: () => [{ id: 'house#seat-up', p: [10, 10], level: 1 }], reachAt: () => !edited };
  const act = god.engineAct.bind(god);
  god.engineAct = ((ops, note, ...rest) => { const x = act(ops, note, ...rest); if (x.accepted && note.startsWith('door-fit/2 (#2434): 1 building')) edited = true; return x; }) as typeof god.engineAct;
  const logs: string[] = [];
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], (m) => logs.push(m), solids(), { walk: cut }));
  assert.equal(r.buildings, 0);
  assert.equal(r.refused.length, 1, logs.join('\n'));
  assert.match(r.refused[0]!, /the approach of house#seat-up is cut off with every new door out/);
  assert.equal(god.model.entities.get(house.id)!.def, def0, 'back on its revision: it keeps its drawn doorways');
  assert.equal(doors().length, 0, 'every new door gone');
  assert.ok(god.model.editSeq > seq0 + 2, 'the doors taken out one by one, then the fit undone');
  assert.ok(logs.some((m) => /fit undone/.test(m)));
});

test('#2462 review: a cut-off fit that cannot be undone is never counted as fitted, and is named', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids } = await cottage(t);
  const real = engineDoorReach(w.host, god)!;
  let edited = false;
  const act = god.engineAct.bind(god);
  god.engineAct = ((ops, note, ...rest) => { const x = act(ops, note, ...rest); if (x.accepted && note.startsWith('door-fit/2 (#2434): 1 building')) edited = true; return x; }) as typeof god.engineAct;
  const cut: DoorReach = { ...real, reach: () => true, seats: () => [{ id: 'house#seat-up', p: [10, 10], level: 1 }], reachAt: () => !edited };
  // a Soul sits down in the house once it is fitted: the undo (it would change what she uses) is refused every time
  const refuse = god.bodies!.refuse;
  god.bodies!.refuse = (after, diff, ops, o) => edited && ops.length > 1 ? { op: -1, code: 'body.in-use', detail: 'test: seated in it' } : refuse?.(after, diff, ops, o) ?? null;
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids(), { walk: cut }));
  assert.equal(r.buildings, 0, 'not counted as fitted');
  assert.deepEqual(r.kept, [house.id], 'the rules event waits');
  assert.match(r.refused[0] ?? '', /its fit could not be undone/);
});

test('#2462 review: the whole fit is not undone once the building changed since the fit (nothing done since is lost)', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids } = await cottage(t);
  const real = engineDoorReach(w.host, god)!, logs: string[] = [];
  let calls = 0, moved = false;
  // the engine settles for the baseline, then not after the edit; meanwhile the god renames the house
  const lateLag: DoorReach = { ...real, settle: async () => { if (++calls === 1) return real.settle(); if (!moved) { moved = true; const m = god.engineAct([{ op: 'set', id: house.id, name: 'renamed' }] as never, 'test: the god renames it') as { accepted: boolean }; assert.equal(m.accepted, true, JSON.stringify(m)); } return false; } };
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], (m) => logs.push(m), solids(), { walk: lateLag }));
  assert.equal(r.buildings, 0);
  assert.ok(logs.some((m) => /the building changed since, so it is left as it is/.test(m)), logs.join('\n'));
  assert.equal(god.model.entities.get(house.id)!.name, 'renamed', 'the god\'s edit stands');
});

test('#2462 review: the god\'s own guard (a deck someone stands on) refuses a fit edit too', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors } = await cottage(t);
  const seq0 = god.model.editSeq;
  god.actGuard = () => ({ accepted: false, failures: [{ op: 0, code: 'connector.joined', detail: 'test: someone stands on its deck' }] });
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids()));
  assert.deepEqual(r.kept, [house.id]);
  assert.equal(god.model.editSeq, seq0);
  assert.equal(doors().length, 0);
});

test('#2462 review: a building whose reach cannot be checked (no outside doorway to walk from) is refused, named', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors } = await cottage(t);
  const real = engineDoorReach(w.host, god)!, seq0 = god.model.editSeq;
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids(), { walk: { ...real, front: () => null } }));
  assert.match(r.refused[0] ?? '', /no outside doorway to check its reach from/);
  assert.equal(god.model.editSeq, seq0);
  assert.equal(doors().length, 0);
  assert.equal(god.model.entities.get(house.id)!.def, house.def);
});

test('#2462 never strands a Soul: a body reached before and not after undoes the fit, tried again at the next boot', { timeout: 120000 }, async (t) => {
  const { w, god, house, solids, doors, def0 } = await cottage(t);
  const real = engineDoorReach(w.host, god)!;
  let edited = false;
  const act = god.engineAct.bind(god);
  god.engineAct = ((ops, note, ...rest) => { const x = act(ops, note, ...rest); if (x.accepted && note.startsWith('door-fit/2 (#2434): 1 building')) edited = true; return x; }) as typeof god.engineAct;
  // a Soul upstairs in the house, reached from the street before the fit and not after it
  const stranded: DoorReach = { ...real, reach: () => true, seats: () => [], bodies: () => [{ id: 'h_ada', p: [9, 9], level: 1, y: 3 }], reachAt: () => !edited };
  const seq0 = god.model.editSeq;
  const r = await ticking(w.host, fitWorldDoorsV2(god, [], () => {}, solids(), { walk: stranded }));
  assert.ok(edited && god.model.editSeq > seq0 + 1, 'the fit was made, then undone');
  assert.deepEqual(r.left, [house.id], 'left for a later boot');
  assert.equal(god.model.entities.get(house.id)!.def, def0);
  assert.equal(doors().length, 0);
});

test('#2462 boot: the boot rules do not wait for the door fits; they run on after, in slices', { timeout: 120000 }, async (t) => {
  const { w, god } = await cottage(t);
  let fits: Promise<void> | undefined;
  const boot = adoptBootRuntimePoliciesV1(w.host, { edge: false, worldKey: 'eden', doorFit: true, god: () => god, doorFits: (p) => fits = p });
  await ticking(w.host, boot);
  assert.ok(fits, 'the fits started');
  // the boot chain is done while the fits are still to finish
  let done = false; void fits!.then(() => done = true);
  assert.equal(done, false, 'not waited for');
  await ticking(w.host, fits!);
  assert.equal(doorFitV2(w.host), true, 'door-fit/2 adopted once they finish');
  assert.equal([...god.model.entities.values()].filter((e) => e.in.parent === 'world' && ALL_DOORS_FROM.has(ref(e.def))).length, 0);
});
