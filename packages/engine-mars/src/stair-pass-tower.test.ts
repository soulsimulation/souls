// #1723 the Village Tower House, exactly as Eden 2026 builds it (fixtures/eden-tower-house.v1.json: its surfaces, solids, three
// stacked flights and the shared Eden level heights). Its floors stand at the shared level heights (3, 5.62 and 8.438 m) while
// its flights end at its own surface heights (2.9, 5.7 and 8.5 m), so a body standing at a flight's end stands up to 10 cm off
// that floor's grid height. A descender from the top meets an ascender at the room-2 end of the middle flight. Under stair-pass/1
// one passes back to its flight's end and holds there; the other then climbs to that end. The landing courtesy must move the
// holder aside, but it read the holder (at the flight's end height, 5.7 m) as not standing on room-2 (5.62 m) and never asked,
// so the climber waited on the holder until the blocked-walk bound failed both walks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marsFactory, GREEN_FIELD_WORLD } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import { emptyGround } from '../../ground/src/index.ts';

const tower = JSON.parse(readFileSync(new URL('./fixtures/eden-tower-house.v1.json', import.meta.url), 'utf8')) as { levels: { id: number; y: number; label: string }[]; part: NonNullable<WorldEditV1['set'][string]> };
const factory = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
const TOP: [number, number, number] = [69.6, 19.6, 28], OUT: [number, number, number] = [68.5, 23.4, 0];

function world(seed: string, pass: boolean) {
  const g = emptyGround(2000); g.extent = [-200, -1000, 1800, 1000];
  const e = factory.create(factory.genesis(seed)) as any;
  e.installGroundV1(groundFact(g, 1, { paged: true }));
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: tower.levels, set: { e_8b4c5e36: tower.part }, assets: {} } as never;
  ev.hash = nextEntityPhysics(undefined, ev).hash; e.applyWorldEditV1(ev);
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, quietStallReleaseV1: true, yieldTimeoutV1: true, spreadV2: true, routeReachV1: true, occupiedLinkRoutingV1: true, concurrentLinkEgressV1: true, stairLandingClearanceV1: true, bodyStepGuardV1: true, quarantineV1: true, refusalSettleV1: true, stairWayV1: true, quarantineMarkV1: true, standHeightV1: true, nonFiniteHoldV1: true, standHeightV2: true, ...(pass ? { stairPassV1: true } : {}) } as never);
  return e;
}
const walk = (e: any, id: string, [x, z, level]: number[]) => { const r = e.perform({ actor: id, label: 'walk', steps: [{ verb: 'mars:walk_to', params: { x, z, level } }] }); assert.ok(r.ok, JSON.stringify(r)); return r.id as string; };

/** The descender walks up to the top first; then it walks down and out, and `delay` ticks later the ascender walks up. */
function cross(seed: string, pass: boolean, delay: number) {
  const e = world(seed, pass);
  e.spawnHuman({ id: 'h_dn', label: 'd', soul: 's_d' }); assert.ok(e.relocateHumanV1('h_dn', [69, 23.4]));
  e.spawnHuman({ id: 'h_up', label: 'u', soul: 's_u' }); assert.ok(e.relocateHumanV1('h_up', [69.8, 23.4]));
  walk(e, 'h_dn', TOP); for (let k = 0; k < 2000 && e.programOf('h_dn'); k++) e.step();
  assert.equal(e.world.entities.h_dn.human.level, 28, 'the descender starts at the top');
  const down = walk(e, 'h_dn', OUT); for (let k = 0; k < delay; k++) e.step();
  const up = walk(e, 'h_up', TOP);
  const copy = factory.restore(e.snapshot()) as any, mids: any[] = [];
  const ends: Record<string, any> = {}, refused: string[] = [], run = { h_up: 0, h_dn: 0 } as Record<string, number>, longest = { h_up: 0, h_dn: 0 } as Record<string, number>;
  let jump = 0, held = 0;
  for (let t = 0; t < 3000 && !(ends.up && ends.down); t++) {
    const before = { h_up: [...e.world.entities.h_up.pose.p], h_dn: [...e.world.entities.h_dn.pose.p] } as Record<string, number[]>;
    const st = e.step(); for (const r of st.refusals ?? []) refused.push(`${t} ${r.code}`);
    for (const p of st.programs) { if (p.id === up && p.kind !== 'step') ends.up ??= { t, ...p }; if (p.id === down && p.kind !== 'step') ends.down ??= { t, ...p }; }
    copy.step(); for (const m of mids) m.step();
    if (t % 100 === 50 && t < 600) mids.push(factory.restore(e.snapshot()));
    for (const id of ['h_up', 'h_dn']) { const q = e.world.entities[id].pose.p, d = Math.hypot(q[0] - before[id][0], q[1] - before[id][1], q[2] - before[id][2]);
      jump = Math.max(jump, d); run[id] = d < 1e-6 && !(id === 'h_up' ? ends.up : ends.down) ? run[id] + 1 : 0; longest[id] = Math.max(longest[id], run[id]); }
    if (e.world.entities.h_dn.human.activity === 'wait' && e.world.entities.h_up.human.activity === 'climb-wait') held++;
  }
  return { e, copy, mids, ends, refused, longest, jump, held };
}

// Delays 60 and 90 meet at room-2 with the descender passing back (on ceb2ba301 both fail at the bound); 0 and 120 meet elsewhere.
for (const delay of [0, 60, 90, 120]) test(`#1723 Tower House (delay ${delay} ticks): under stair-pass/1 a descender and an ascender both get through; a pass-back holder is moved aside for the climber it yielded to; no long wait, no jump, no overlap, no refusal, and restored snapshots continue alike`, () => {
  const r = cross(`tower-${delay}`, true, delay);
  assert.equal(r.ends.down?.kind, 'completed', JSON.stringify(r.ends.down)); assert.equal(r.ends.up?.kind, 'completed', JSON.stringify(r.ends.up));
  assert.ok(r.held < 200, `the climber waited ${r.held} ticks on a holder that waits for it`);
  assert.ok(Math.max(r.longest.h_up, r.longest.h_dn) < 600, `longest still ${JSON.stringify(r.longest)} ticks: under 30 s`);
  assert.ok(r.jump <= 0.2, `largest one-tick move ${r.jump.toFixed(3)} m`);
  assert.deepEqual(r.e.runtime.violations.filter((d: any) => d.code === 'collision.human-human'), []);
  assert.deepEqual(r.refused, []);
  assert.equal(r.copy.stateHash(), r.e.stateHash(), 'a restored snapshot continues alike');
  for (const m of r.mids) assert.equal(m.stateHash(), r.e.stateHash(), 'a snapshot taken mid-pass restores and continues alike');
});

// A3 on the same tower: six bodies loop between the door and the top, three setting out at once and three 15 s later (the A9
// kit's shape, scripted in the engine). On ceb2ba301 a climb the blocked-walk bound cancels mid-flight backs off towards the
// landing between two flights, where a third body waits to enter one of them: each waits for the other with no bound. The
// cancelling action keeps its Soul's reservation, so every later act of that Soul is refused `reservation.conflict` (cand-6:
// 240 such refusals). Under stair-pass/1 a blocked cancel turns to its flight's other end when that way is clear, and is
// otherwise ended `route.cancel-blocked`, freeing its Soul, within its bound.
test('#1723 A3 Tower House loop: no cancelled climb holds its Soul past its bound, and no Soul is refused reservation.conflict for long', () => {
  const r = loop('tower-loop', true);
  assert.ok(r.longestCancel < 1000, `a cancelled climb held its Soul ${r.longestCancel} ticks`);
  assert.ok(r.longestRefused < 1000, `a Soul's acts were refused reservation.conflict for ${r.longestRefused} ticks in a row`);
  assert.ok(r.completed >= 10, `${r.completed} walks completed`);
  assert.deepEqual(r.e.runtime.violations.filter((d: any) => d.code === 'collision.human-human'), []);
  assert.equal(r.copy.stateHash(), r.e.stateHash(), 'a snapshot taken mid-loop restores and continues alike');
});
function loop(seed: string, pass: boolean, T = 9000) {
  const e = world(seed, pass);
  const tops = [[69.6, 19.6], [69.9, 20.4], [69.2, 19.2], [69.7, 20.9], [69.0, 19.8]], outs = [[68.5, 23.4], [69.5, 23.6], [70.4, 23.3], [67.8, 23.8], [69, 24.3], [70.8, 24.1]];
  const ids = Array.from({ length: 6 }, (_, i) => `h_${i}`), goal: Record<string, number> = {}, prog: Record<string, string> = {}, wake: Record<string, number> = {};
  ids.forEach((id, i) => { e.spawnHuman({ id, label: id, soul: `s${i}` }); assert.ok(e.relocateHumanV1(id, outs[i])); wake[id] = i < 3 ? 0 : 300; });
  const go = (id: string, i: number) => { const up = goal[id] !== 28, [x, z] = up ? tops[i % tops.length] : outs[i]; goal[id] = up ? 28 : 0;
    const act = { actor: id, label: 'walk', steps: [{ verb: 'mars:walk_to', params: { x, z, level: goal[id] } }] }, r = e.perform(act); copy?.perform(act); prog[id] = r.ok ? r.id : ''; };
  const since: Record<string, number> = {}, refused: Record<string, number> = {};
  let longestCancel = 0, longestRefused = 0, completed = 0, copy: any;   // copy: restored mid-loop, given the same acts
  for (let t = 0; t < T; t++) {
    ids.forEach((id, i) => { if (!prog[id] && t >= wake[id]) go(id, i); });
    if (t === 6000) copy = factory.restore(e.snapshot());
    const st = e.step(); copy?.step();
    for (const p of st.programs) { if (p.kind === 'step') continue; const id = ids.find(x => prog[x] === p.id); if (!id) continue;
      prog[id] = ''; wake[id] = t + 40; if (p.kind === 'completed') completed++;
      if (p.code === 'reservation.conflict') { refused[id] ??= t; longestRefused = Math.max(longestRefused, t - refused[id]); } else delete refused[id]; }
    const execs = [...(e.rt.services.walkExecs?.values() ?? [])] as any[];
    for (const id of ids) if (execs.some(x => x.actor === id && x.cancelTo)) { since[id] ??= t; longestCancel = Math.max(longestCancel, t - since[id]); } else delete since[id];
  }
  return { e, copy, longestCancel, longestRefused, completed };
}

// #1723 cause 3 (the cand-6 `climbers` wait): W stands at the top, A climbs from the door to the top and B from the door to
// room-2 120 ticks later, and W walks down at tick 150. W reaches room-2 and waits to enter the flight A climbs, so A passes back
// (passBackForWaiter) down towards room 1, where B is arriving up the lower flight. On 40336d6df A's back-down waits for B and
// B waits for A until the blocked-walk bound fails all three walks. Under stair-pass/1 the climber blocked by a partner backing
// down yields in turn (it backs down its own flight while its way is clear), and the back-down itself is bounded like the hold.
function converge(seed: string) {
  const e = world(seed, true);
  e.spawnHuman({ id: 'h_w', label: 'w', soul: 's_w' }); assert.ok(e.relocateHumanV1('h_w', [69, 23.4]));
  walk(e, 'h_w', [68.75, 19.8, 28]); for (let k = 0; k < 3000 && e.programOf('h_w'); k++) e.step();
  assert.equal(e.world.entities.h_w.human.level, 28, 'W starts at the top');
  e.spawnHuman({ id: 'h_a', label: 'a', soul: 's_a' }); assert.ok(e.relocateHumanV1('h_a', [69, 23.4]));
  e.spawnHuman({ id: 'h_b', label: 'b', soul: 's_b' }); assert.ok(e.relocateHumanV1('h_b', [69.8, 23.6]));
  const ids = ['h_a', 'h_b', 'h_w'], progs: Record<string, string> = { h_a: walk(e, 'h_a', [69.6, 19.4, 28]) }, ends: Record<string, any> = {};
  const refused: string[] = [], run: Record<string, number> = {}, longest: Record<string, number> = {}, mids: any[] = [];
  let jump = 0, backed = 0;
  for (let t = 0; t < 3000 && !(ends.h_a && ends.h_b && ends.h_w); t++) {
    if (t === 120) progs.h_b = walk(e, 'h_b', [69.9, 20.4, 9]);
    if (t === 150) progs.h_w = walk(e, 'h_w', [68.6, 24.4, 0]);
    const before = Object.fromEntries(ids.map(id => [id, [...e.world.entities[id].pose.p]]));
    const st = e.step(); for (const r of st.refusals ?? []) refused.push(`${t} ${r.code}`); for (const m of mids) m.step();
    for (const p of st.programs) for (const id of ids) if (p.id === progs[id] && p.kind !== 'step') ends[id] ??= { t, ...p };
    const execs = [...(e.rt.services.walkExecs?.values() ?? [])] as any[];
    if (execs.some(x => x.passBack?.stage === 'back')) { backed++; if (backed === 20) mids.push(factory.restore(e.snapshot())); }
    for (const id of ids) { const q = e.world.entities[id].pose.p, d = Math.hypot(q[0] - before[id][0], q[1] - before[id][1], q[2] - before[id][2]);
      if (progs[id] && !ends[id]) jump = Math.max(jump, d); run[id] = d < 1e-6 && progs[id] && !ends[id] ? (run[id] ?? 0) + 1 : 0; longest[id] = Math.max(longest[id] ?? 0, run[id]); }
  }
  return { e, ends, refused, longest, jump, backed, mids };
}
test('#1723 cause 3 Tower House: a back-down that meets a climber converging on its entry resolves; all three walks complete, no long wait, and a snapshot taken mid-back-down continues alike', () => {
  const r = converge('tower-converge');
  assert.ok(r.backed > 0, 'the scene reaches a pass-back');
  for (const id of ['h_a', 'h_b', 'h_w']) assert.equal(r.ends[id]?.kind, 'completed', `${id}: ${JSON.stringify(r.ends[id])}`);
  assert.ok(Math.max(...Object.values(r.longest)) < 600, `longest still ${JSON.stringify(r.longest)} ticks: under 30 s`);
  assert.ok(r.jump <= 0.2, `largest one-tick move ${r.jump.toFixed(3)} m`);
  assert.deepEqual(r.e.runtime.violations.filter((d: any) => d.code === 'collision.human-human'), []);
  assert.deepEqual(r.refused, []);
  assert.equal(r.mids.length, 1, 'a snapshot was taken mid-back-down');
  for (const m of r.mids) assert.equal(m.stateHash(), r.e.stateHash(), 'a snapshot taken mid-back-down restores and continues alike');
});

// #1723 cause 3, the back-down's bound: the same scene, with B marked as having already yielded to A once (so it does not yield
// again, as a walk never trades pass-backs). A's back-down then waits on B, and ends after PASS_BACK_TICKS (400), so A climbs on.
test('#1723 cause 3 Tower House: a back-down blocked by a body that will not yield again ends after its bound, and the walk climbs on', () => {
  const e = world('tower-back-bound', true);
  e.spawnHuman({ id: 'h_w', label: 'w', soul: 's_w' }); assert.ok(e.relocateHumanV1('h_w', [69, 23.4]));
  walk(e, 'h_w', [68.75, 19.8, 28]); for (let k = 0; k < 3000 && e.programOf('h_w'); k++) e.step();
  e.spawnHuman({ id: 'h_a', label: 'a', soul: 's_a' }); assert.ok(e.relocateHumanV1('h_a', [69, 23.4]));
  e.spawnHuman({ id: 'h_b', label: 'b', soul: 's_b' }); assert.ok(e.relocateHumanV1('h_b', [69.8, 23.6]));
  walk(e, 'h_a', [69.6, 19.4, 28]);
  const exOf = (id: string) => ([...(e.rt.services.walkExecs?.values() ?? [])] as any[]).find(x => x.actor === id);
  let began = -1, ended = -1, marked = false;
  for (let t = 0; t < 1600 && ended < 0; t++) {
    if (t === 120) walk(e, 'h_b', [69.9, 20.4, 9]);
    if (t === 150) walk(e, 'h_w', [68.6, 24.4, 0]);
    const xb = exOf('h_b'); if (xb && !marked) { xb.passBack = { by: 'h_a', other: '', mine: '', stage: 'done', since: 0 }; marked = true; }
    e.step();
    const pb = exOf('h_a')?.passBack;
    if (pb?.stage === 'back' && began < 0) began = pb.since;
    if (began >= 0 && pb?.stage === 'done') ended = e.rt.tick;
  }
  assert.ok(began >= 0, 'A passes back');
  assert.ok(ended >= 0, 'A\'s back-down ends');
  assert.ok(ended - began >= 400 && ended - began <= 410, `the back-down ended ${ended - began} ticks after it began`);
  assert.equal(exOf('h_b')?.passBack?.stage, 'done', 'B did not pass back');
});
