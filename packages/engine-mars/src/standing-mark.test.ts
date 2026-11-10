// #1440 quarantine-mark/1, engine side: a standing mark holds a marked body whenever it is found broken, at the start of a step
// and at its end, follows the body while it is whole (so a later break holds it where it last stood whole), is carried by a
// snapshot, and ends once the body has stayed whole for the cooldown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, MarsEngine } from './engine.ts';

const f = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
function world() {
  const e = f.create(f.genesis('standing-mark')) as MarsEngine;
  e.spawnHuman({ id: 'a', label: 'Ada', soul: 's_a', at: [0, 0] } as any); e.spawnHuman({ id: 'b', label: 'Bo', soul: 's_b', at: [6, 6] } as any);
  e.step();
  const rt = (e as any).rt, ent = () => e.world.entities.a as any, marks = () => (e.world as any).standingHoldsV1;
  const pose = () => ({ p: [...ent().pose.p] as [number, number, number], yaw: ent().pose.yaw ?? 0, level: ent().human.level ?? 0 });
  const breakNow = () => { ent().pose.p = [NaN, ent().pose.p[1], ent().pose.p[2]]; };
  return { e, rt, ent, marks, pose, breakNow };
}
const finite = (p: number[]) => p.every(Number.isFinite);

test('#1440 a marked body broken before the step or by it is held again, at the pose where it last stood whole', () => {
  const w = world(), at0 = w.pose(); w.e.markStandingV1('a', at0);
  w.breakNow(); w.e.step();
  assert.ok(finite(w.ent().pose.p), 'held at the start of the step'); assert.deepEqual(w.ent().pose.p.map(Math.round), at0.p.map(Math.round));
  // the body moves while whole (a Soul's new act): the mark follows it
  w.ent().pose.p = [3, at0.p[1], 0]; w.e.step();
  assert.deepEqual(w.marks().a.pose.p.map(Math.round), [3, Math.round(at0.p[1]), 0], 'the mark follows the whole body');
  // broken again inside the step's own pass: held at the end of the step, where it last stood whole, not where it was marked
  let once = false; w.rt.invariants = [(r: any) => { if (!once) { once = true; w.breakNow(); } return []; }, ...w.rt.invariants];
  w.e.step();
  assert.ok(once, 'the break ran inside the step'); assert.ok(finite(w.ent().pose.p), 'held at the end of the step');
  assert.ok(Math.abs(w.ent().pose.p[0] - 3) < 0.5, `held where it last stood whole: ${w.ent().pose.p}`);
});

test('#1440 a snapshot carries the mark, and the mark ends after the cooldown of whole ticks', () => {
  const w = world(); w.e.markStandingV1('a', w.pose()); w.breakNow(); w.e.step();
  const snap = w.e.snapshot(), hash = w.e.stateHash(), g = f.restore(snap) as MarsEngine;
  assert.ok((g.world as any).standingHoldsV1?.a, 'the restored world has the mark'); assert.equal(g.stateHash(), hash, 'and the same hash');
  for (let i = 0; i < 1100; i++) w.e.step();
  assert.ok(w.marks()?.a, 'still marked inside the cooldown');
  for (let i = 0; i < 200; i++) w.e.step();
  assert.equal(w.marks(), undefined, 'the mark ends once the body stayed whole for the cooldown');
});
