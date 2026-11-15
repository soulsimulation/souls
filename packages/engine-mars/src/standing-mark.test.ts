// #1440 quarantine-mark/1, engine side: a standing mark holds a marked body whenever it is found broken, at the start of a step
// and at its end, follows the body while it is whole (so a later break holds it where it last stood whole), is carried by a
// snapshot, and ends once the body has stayed whole for the cooldown. #1513: an object's mark, below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, MEAL_WORLD, MarsEngine } from './engine.ts';

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

// #1513 nonfinite-mark/1: an object's mark, by the fields its non-finite holds put back, uses the same map and the same holds
const meal = await marsFactory({ ...MEAL_WORLD, soulsRepairV1: true });
function objectWorld() {
  const e = meal.create(meal.genesis('object-mark')) as MarsEngine; e.step();
  const rt = (e as any).rt, bowl = () => e.world.entities.bowl1 as any, marks = () => (e.world as any).standingHoldsV1;
  let breakAt = -1; const inStep = () => { breakAt = rt.tick + 1; };   // broken inside the next step, as a rule would
  rt.invariants = [(r: any) => { if (r.tick === breakAt) bowl().pose.p[0] = NaN; return []; }, ...rt.invariants];
  return { e, rt, bowl, marks, inStep };
}

test('#1513 a marked object broken inside the step or before it gets its marked fields back where it last stood whole; the mark follows it', () => {
  const w = objectWorld(), at0 = [...w.bowl().pose.p];
  const made = w.e.markNonFiniteV1([{ root: 'world', path: ['entities', 'bowl1', 'pose'], from: 'baseline', pose: structuredClone(w.bowl().pose) }]);
  assert.deepEqual(made, [{ id: 'bowl1', fields: [['pose']] }], 'the mark made, for the log');
  assert.deepEqual(w.e.markNonFiniteV1([{ root: 'world', path: ['entities', 'bowl1', 'pose'], from: 'baseline', pose: structuredClone(w.bowl().pose) }]), [], 'marked once');
  assert.deepEqual(w.e.markNonFiniteV1([{ root: 'world', path: ['entities', 'nobody', 'pose'], from: 'baseline', pose: {} }]), [], 'never a missing id');
  w.inStep(); w.e.step();
  assert.ok(finite(w.bowl().pose.p), 'held at the end of the step'); assert.deepEqual(w.bowl().pose.p, at0);
  assert.doesNotThrow(() => w.e.stateHash(), 'the host reads it whole');
  // it moves while whole: the mark follows, and a break before the step holds it there
  w.bowl().pose.p = [at0[0] + 1, at0[1], at0[2]]; w.e.step();
  assert.equal(w.marks().bowl1.fields[0].pose.p[0], at0[0] + 1, 'the mark follows the whole object');
  w.bowl().pose.p[0] = NaN; w.e.step();
  assert.equal(w.bowl().pose.p[0], at0[0] + 1, 'held at the start of the step, where it last stood whole');
});

test('#1513 a marked number of an object goes back too; a snapshot carries the mark; it ends after the cooldown whole, or with the object', () => {
  const w = objectWorld();
  w.bowl().body ??= {}; w.bowl().body.radius = 0.2;
  w.e.markStandingV1('bowl1', undefined, [['pose'], ['body', 'radius']]);
  w.bowl().body.radius = NaN; w.inStep(); w.e.step();   // the number before the step (a number inside an entity's body would throw in the take's own sample), the pose inside it
  assert.equal(w.bowl().body.radius, 0.2, 'the number goes back'); assert.ok(finite(w.bowl().pose.p));
  const g = meal.restore(w.e.snapshot()) as MarsEngine;
  assert.deepEqual((g.world as any).standingHoldsV1, w.marks(), 'the restored world has the mark'); assert.equal(g.stateHash(), w.e.stateHash(), 'and the same hash');
  for (let i = 0; i < 1150; i++) w.e.step();
  assert.ok(w.marks()?.bowl1, 'still marked inside the cooldown');
  for (let i = 0; i < 100; i++) w.e.step();
  assert.equal(w.marks(), undefined, 'the mark ends once the object stayed whole for the cooldown');
  g.removeEntity('bowl1'); g.step();
  assert.equal((g.world as any).standingHoldsV1, undefined, 'and when the object is gone');
});
