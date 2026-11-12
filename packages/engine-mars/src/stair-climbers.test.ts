// #1722 two-way stair deadlocks on a tight switchback (the two flight ends 0.2 m apart on a landing with no spot clear of both
// flights, like the Village Tower House's upper landing). (A1) Two climbers meet head-on from the adjacent flights, each one's
// next step closing on the other; (A2, no room) a walker reaches the landing first and waits at the upper flight's entry for
// the descender who holds that flight, with nowhere on the landing to step aside. Without stair-pass/1 both wait until the
// blocked-walk bound fails both walks. Under it one climber backs down its own flight to its roomy entry floor, holds there
// while the other passes, and climbs again; the courtesy the other way then has room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import { emptyGround } from '../../ground/src/index.ts';
const factory = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
const cx = 20, cz = 20, H1 = 2.85, H2 = 5.7, RUN = 2.6, GAP = 0.2, LW = 0.45;
const flight = (x: number, z0: number, y0: number, z1: number, y1: number) => Array.from({ length: 17 }, (_, i) => [x, y0 + ((y1 - y0) * i) / 16, z0 + ((z1 - z0) * i) / 16]);
function switchback(seed: string, pass: boolean, tightTop = false, tall = false) {
  // tall: a longer, higher lower flight (1.5x), so an ascender is further along its flight than a descender that just set out
  const h1 = tall ? 1.5 * H1 : H1, h2 = h1 + (H2 - H1), runL = tall ? 1.5 * RUN : RUN;
  const set = { e_house: { surfaces: [
    { id: 'h:ground', level: 0, y: 0, obb: { c: [cx, cz], half: [6, 6], yaw: 0 } },
    { id: 'h:landing', level: 1, y: h1, obb: { c: [cx + GAP / 2, cz - 0.45], half: [GAP / 2 + LW, 0.55], yaw: 0 } },
    tightTop ? { id: 'h:top', level: 2, y: h2, obb: { c: [cx + GAP, cz + RUN + 0.55], half: [LW, 0.6], yaw: 0 } } : { id: 'h:top', level: 2, y: h2, obb: { c: [cx + GAP / 2, cz + RUN + 1.5], half: [GAP / 2 + 1.5, 1.5], yaw: 0 } }], solids: [],
    links: [
      { id: 'h:lower', kind: 'stairs', from: { level: 0, p: [cx, cz + runL], y: 0 }, to: { level: 1, p: [cx, cz - 0.3], y: h1 }, width: 0.9, heading: -Math.PI / 2, path: flight(cx, cz + runL, 0, cz - 0.1, h1), usable: true },
      { id: 'h:upper', kind: 'stairs', from: { level: 1, p: [cx + GAP, cz - 0.3], y: h1 }, to: { level: 2, p: [cx + GAP, cz + RUN + 0.4], y: h2 }, width: 0.9, heading: Math.PI / 2, path: flight(cx + GAP, cz - 0.1, h1, cz + RUN, h2), usable: true }] } } as unknown as WorldEditV1['set'];
  const g = emptyGround(2000); g.extent = [-200, -1000, 1800, 1000];
  const e = factory.create(factory.genesis(seed)) as any;
  e.installGroundV1(groundFact(g, 1, { paged: true }));
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [{ id: 1, y: h1, label: 'landing' }, { id: 2, y: h2, label: 'top' }], set, assets: {} } as never; ev.hash = nextEntityPhysics(undefined, ev).hash; e.applyWorldEditV1(ev);
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true, refusalSettleV1: true, stairWayV1: true, stairLandingClearanceV1: true, concurrentLinkEgressV1: true, occupiedLinkRoutingV1: true, ...(pass ? { stairPassV1: true } : {}) } as never);
  return e;
}
const walk = (e: any, id: string, x: number, z: number, level: number) => { const r = e.perform({ actor: id, label: 'walk', steps: [{ verb: 'mars:walk_to', params: { x, z, level } }] }); assert.ok(r.ok, JSON.stringify(r)); return r.id as string; };
const hh = (e: any) => e.runtime.violations.filter((d: any) => d.code === 'collision.human-human');
/** The descender goes down from the top; `delay` ticks later the ascender starts up from the foot of the lower flight. */
function meet(seed: string, pass: boolean, delay: number, tightTop = false, tall = false) {
  const e = switchback(seed, pass, tightTop, tall), topAt = tightTop ? [cx + GAP, cz + RUN + 0.8] : [cx + GAP, cz + RUN + 2], upTo = tightTop ? [cx + GAP, cz + RUN + 0.8] : [cx + GAP + 1, cz + RUN + 2.2];
  e.spawnHuman({ id: 'h_up', label: 'u', soul: 's_u' }); assert.ok(e.relocateHumanV1('h_up', [cx, cz + (tall ? 1.5 * RUN : RUN) + 0.6]));
  e.spawnHuman({ id: 'h_down', label: 'd', soul: 's_d' }); assert.ok(e.relocateHumanV1('h_down', [cx + 2, cz + (tall ? 1.5 * RUN : RUN) + 1]));
  walk(e, 'h_down', topAt[0], topAt[1], 2); for (let k = 0; k < 2000 && e.programOf('h_down'); k++) e.step();
  assert.equal(e.world.entities.h_down.human.level, 2, 'the descender starts upstairs');
  // delay >= 0: the descender starts first; delay < 0: the ascender starts first and the descender -delay ticks later
  let down = '', up = '';
  if (delay >= 0) { down = walk(e, 'h_down', cx - 1.5, cz + RUN + 1.5, 0); for (let k = 0; k < delay; k++) e.step(); up = walk(e, 'h_up', upTo[0], upTo[1], 2); }
  else { up = walk(e, 'h_up', upTo[0], upTo[1], 2); for (let k = 0; k < -delay; k++) e.step(); down = walk(e, 'h_down', cx - 1.5, cz + RUN + 1.5, 0); }
  const copy = factory.restore(e.snapshot()) as any, mids: any[] = [];
  const ends: Record<string, any> = {}, run: Record<string, number> = { h_up: 0, h_down: 0 }, longest: Record<string, number> = { h_up: 0, h_down: 0 };
  let climbersWaiting = 0, jump = 0; const refused: string[] = [], backs: Record<string, number> = { h_up: 0, h_down: 0 }, was: Record<string, string> = {};
  for (let t = 0; t < 2500 && !(ends.up && ends.down); t++) {
    const before: Record<string, number[]> = { h_up: [...e.world.entities.h_up.pose.p], h_down: [...e.world.entities.h_down.pose.p] };
    const st = e.step(); for (const r of st.refusals ?? []) refused.push(`${t} ${r.code} ${JSON.stringify(r.subjects ?? [])}`);
    for (const p of st.programs) { if (p.id === up && p.kind !== 'step') ends.up ??= p; if (p.id === down && p.kind !== 'step') ends.down ??= p; }
    copy.step(); for (const m of mids) m.step();
    if (t % 100 === 50 && t < 700) mids.push(factory.restore(e.snapshot()));   // snapshots taken while one climber backs off or holds
    for (const id of ['h_up', 'h_down']) { const q = e.world.entities[id].pose.p, d = Math.hypot(q[0] - before[id][0], q[1] - before[id][1], q[2] - before[id][2]);
      jump = Math.max(jump, d); run[id] = d < 1e-6 && !(id === 'h_up' ? ends.up : ends.down) ? run[id] + 1 : 0; longest[id] = Math.max(longest[id], run[id]); }
    for (const id of ['h_up', 'h_down']) { const now = e.world.entities[id].human.activity; if (now === (id === 'h_up' ? 'climb-down' : 'climb-up') && was[id] !== now) backs[id]++; was[id] = now; }
    if (e.world.entities.h_up.human.activity === 'climb-wait' && e.world.entities.h_down.human.activity === 'climb-wait') climbersWaiting++;
  }
  return { e, copy, mids, ends, longest, jump, climbersWaiting, refused, backs };
}
for (const [name, delay] of [['A1 two climbers head-on from the adjacent flights', 40], ['A2 a walker waiting at the upper entry with no room on the landing', 0]] as const) {
  test(`#1722 ${name}: without stair-pass/1 both wait for the blocked-walk bound (the fault)`, () => {
    const r = meet(`off-${delay}`, false, delay);
    assert.equal(r.ends.up?.code, 'route.blocked'); assert.equal(r.ends.down?.code, 'route.blocked');
    assert.ok(Math.max(r.longest.h_up, r.longest.h_down) > 1200, JSON.stringify(r.longest));
    if (delay === 40) assert.ok(r.climbersWaiting > 1200, 'both wait on their flights');
  });
  test(`#1722 ${name}: under stair-pass/1 one backs down its own flight and holds while the other passes; both walks complete with no long wait, no jump and no overlap, and a restored snapshot continues alike`, () => {
    const r = meet(`on-${delay}`, true, delay);
    assert.equal(r.ends.up?.kind, 'completed', JSON.stringify(r.ends.up)); assert.equal(r.ends.down?.kind, 'completed', JSON.stringify(r.ends.down));
    assert.ok(Math.max(r.longest.h_up, r.longest.h_down) < 400, `longest still ${JSON.stringify(r.longest)} ticks: under 20 s, about one traversal of the flight`);
    assert.ok(r.climbersWaiting < 200, `both climbers waited on their flights ${r.climbersWaiting} ticks`);
    assert.ok(r.jump <= 0.2, `largest one-tick move ${r.jump.toFixed(3)} m`);
    assert.deepEqual(hh(r.e), []);
    assert.deepEqual(r.refused, [], 'the engine refuses no move: the back-down\'s last step reaches the entry as a climb');
    assert.equal(r.copy.stateHash(), r.e.stateHash(), 'a restored snapshot continues alike');
    for (const m of r.mids) assert.equal(m.stateHash(), r.e.stateHash(), 'a snapshot taken mid-pass restores and continues alike');
  });
}

// #1723 cand-4 (Eden 2026, Village Tower House): the top end of the upper flight is a tight landing. The ascender, well up a
// long lower flight, met the descender that had just set out down the upper one; the descender, nearer its own entry, passed
// back to the top and held there while the ascender came on up that same flight: the holder stood on the climber's exit with
// no room to step aside, and both waited for the hold's bound (then the walk bound failed the ascender). A body now yields
// only where the other can then pass it: when the other's route goes on along its flight, that flight's end needs a spot to
// stand aside on. Here the ascender, whose end (the ground) has room, yields instead.
test('#1723 cand-4: a tight top landing, head-on: under stair-pass/1 the one with room at its end yields, and both walks complete with no long wait, no jump and no overlap', () => {
  const r = meet('on-tight-top', true, -65, true, true);
  assert.equal(r.ends.up?.kind, 'completed', JSON.stringify(r.ends.up)); assert.equal(r.ends.down?.kind, 'completed', JSON.stringify(r.ends.down));
  assert.equal(r.backs.h_down, 0, 'the descender, whose end has no room, does not pass back');
  assert.equal(r.backs.h_up, 1, 'the ascender passes back once');
  assert.ok(Math.max(r.longest.h_up, r.longest.h_down) < 600, `longest still ${JSON.stringify(r.longest)} ticks: under 30 s`);
  assert.ok(r.jump <= 0.2, `largest one-tick move ${r.jump.toFixed(3)} m`);
  assert.deepEqual(hh(r.e), []);
  assert.deepEqual(r.refused, []);
  assert.equal(r.copy.stateHash(), r.e.stateHash(), 'a restored snapshot continues alike');
  for (const m of r.mids) assert.equal(m.stateHash(), r.e.stateHash(), 'a snapshot taken mid-pass restores and continues alike');
});
// Known limit: the same tight top, but the ascender already waits on the middle landing (too tight to step aside on) to enter
// the upper flight. Passing back up would only hold on the ascender's exit, so the descender keeps the flight; nobody passes
// back, and the walk bound ends both walks. Getting both through needs the waiter to retreat down its previous flight.
test('#1723 known limit: a tight top and a waiter on a tight middle landing: no pass-back onto the other one\'s exit; the bound ends both walks, with no refusal and no overlap', () => {
  const r = meet('on-tight-top-waiter', true, -130, true, false);
  assert.equal(r.backs.h_up + r.backs.h_down, 0, `no pass-back (${JSON.stringify(r.backs)})`);
  assert.equal(r.ends.up?.code, 'route.blocked', JSON.stringify(r.ends.up));
  assert.deepEqual(hh(r.e), []); assert.deepEqual(r.refused, []);
});

// Review of #1723: a three-flight switchback with tight landings at both ends of the middle flight. Up goes ground to top and
// Down top to ground. Neither landing has room to pass, so a pass-back cannot let the other through. The bound must still end
// both walks: no pass-back the other way for a body that already backed down for this one, and no second pass-back by the same
// walk for the same body. Before that rule the two traded pass-backs every hold (1200 ticks) and neither walk ever ended.
// Getting both through needs a retreat over more than one flight (Known limits).
const H3 = 8.55;
function tower(seed: string, pass: boolean) {
  const set = { e_house: { surfaces: [
    { id: 'h:ground', level: 0, y: 0, obb: { c: [cx, cz], half: [6, 6], yaw: 0 } },
    { id: 'h:l1', level: 1, y: H1, obb: { c: [cx + GAP / 2, cz - 0.45], half: [GAP / 2 + LW, 0.55], yaw: 0 } },
    { id: 'h:l2', level: 2, y: H2, obb: { c: [cx + 1.5 * GAP, cz + RUN + 0.45], half: [GAP / 2 + LW, 0.55], yaw: 0 } },
    { id: 'h:top', level: 3, y: H3, obb: { c: [cx + GAP, cz - 1.8], half: [1.5, 1.3], yaw: 0 } }], solids: [],
    links: [
      { id: 'h:lower', kind: 'stairs', from: { level: 0, p: [cx, cz + RUN], y: 0 }, to: { level: 1, p: [cx, cz - 0.3], y: H1 }, width: 0.9, heading: -Math.PI / 2, path: flight(cx, cz + RUN, 0, cz - 0.1, H1), usable: true },
      { id: 'h:mid', kind: 'stairs', from: { level: 1, p: [cx + GAP, cz - 0.3], y: H1 }, to: { level: 2, p: [cx + GAP, cz + RUN + 0.3], y: H2 }, width: 0.9, heading: Math.PI / 2, path: flight(cx + GAP, cz - 0.1, H1, cz + RUN + 0.1, H2), usable: true },
      { id: 'h:upper', kind: 'stairs', from: { level: 2, p: [cx + 2 * GAP, cz + RUN + 0.3], y: H2 }, to: { level: 3, p: [cx + 2 * GAP, cz - 0.8], y: H3 }, width: 0.9, heading: -Math.PI / 2, path: flight(cx + 2 * GAP, cz + RUN + 0.1, H2, cz - 0.6, H3), usable: true }] } } as unknown as WorldEditV1['set'];
  const g = emptyGround(2000); g.extent = [-200, -1000, 1800, 1000];
  const e = factory.create(factory.genesis(seed)) as any;
  e.installGroundV1(groundFact(g, 1, { paged: true }));
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [{ id: 1, y: H1, label: 'l1' }, { id: 2, y: H2, label: 'l2' }, { id: 3, y: H3, label: 'top' }], set, assets: {} } as never; ev.hash = nextEntityPhysics(undefined, ev).hash; e.applyWorldEditV1(ev);
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true, refusalSettleV1: true, stairWayV1: true, stairLandingClearanceV1: true, concurrentLinkEgressV1: true, occupiedLinkRoutingV1: true, ...(pass ? { stairPassV1: true } : {}) } as never);
  return e;
}
function crossTower(seed: string, pass: boolean, delay: number) {
  const e = tower(seed, pass);
  e.spawnHuman({ id: 'h_up', label: 'u', soul: 's_u' }); assert.ok(e.relocateHumanV1('h_up', [cx, cz + RUN + 0.6]));
  e.spawnHuman({ id: 'h_down', label: 'd', soul: 's_d' }); assert.ok(e.relocateHumanV1('h_down', [cx + 2, cz + RUN + 1]));
  walk(e, 'h_down', cx + GAP, cz - 2.4, 3); for (let k = 0; k < 4000 && e.programOf('h_down'); k++) e.step();
  assert.equal(e.world.entities.h_down.human.level, 3, 'the descender starts at the top');
  const down = walk(e, 'h_down', cx - 1.5, cz + RUN + 1.5, 0); for (let k = 0; k < delay; k++) e.step();
  const up = walk(e, 'h_up', cx + GAP, cz - 2.4, 3), ends: Record<string, any> = {}, refused: string[] = [], backs = { h_up: 0, h_down: 0 } as Record<string, number>;
  for (let t = 0; t < 6000 && !(ends.up && ends.down); t++) {
    const was = { h_up: e.world.entities.h_up.human.activity, h_down: e.world.entities.h_down.human.activity } as Record<string, string>;
    const st = e.step(); for (const r of st.refusals ?? []) refused.push(`${t} ${r.code}`);
    for (const p of st.programs) { if (p.id === up && p.kind !== 'step') ends.up ??= { t, ...p }; if (p.id === down && p.kind !== 'step') ends.down ??= { t, ...p }; }
    // a back-down starts when an ascender turns to climb-down (or a descender to climb-up) on the middle flight
    for (const id of ['h_up', 'h_down']) { const now = e.world.entities[id].human.activity; if (now === (id === 'h_up' ? 'climb-down' : 'climb-up') && was[id] !== now) backs[id]++; }
  }
  return { e, ends, refused, backs };
}
for (const delay of [0, 120, 240]) test(`#1722 review: tight landings at both ends of a middle flight (delay ${delay} ticks): under stair-pass/1 the two never trade pass-backs; the bound ends both walks, with no refusal and no overlap`, () => {
  const off = crossTower(`tower-off-${delay}`, false, delay), on = crossTower(`tower-on-${delay}`, true, delay);
  for (const r of [off, on]) { assert.equal(r.ends.up?.code, 'route.blocked', JSON.stringify(r.ends.up)); assert.equal(r.ends.down?.code, 'route.blocked'); assert.deepEqual(r.refused, []); assert.deepEqual(hh(r.e), []); }
  assert.ok(on.ends.up.t < off.ends.up.t + 600, `the bound ends both walks (on ${on.ends.up.t} ticks, off ${off.ends.up.t})`);
  assert.ok(on.backs.h_up + on.backs.h_down <= 1, `at most one back-down in all (${JSON.stringify(on.backs)})`);
});
