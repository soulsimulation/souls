import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFrame } from './activity-poses.ts';
import { ACT_BLEND, ACT_HISTORY, FLATTEN, GET_UP, LIE_DOWN, TILT, blendFrames, lastPostureChange, postureKind, postureNow, type PostureChange } from './posture-transition.ts';

const change = (from: string, to: string, age: number, before?: PostureChange): PostureChange => ({ from, to, age, ...(before ? { before } : {}) });

test('posture kinds of the exercise and rest activities', () => {
  assert.equal(postureKind('situps'), 'back');
  assert.equal(postureKind('lie'), 'back');
  assert.equal(postureKind('pushups'), 'front');
  assert.equal(postureKind('jumping-jacks'), 'stand');
  assert.equal(postureKind('read', 'sit'), 'seat');
  assert.equal(postureKind('sit-ground'), 'ground');
});

test('sit-ups to jumping jacks: the sit-up flattens, the body gets up from its back (LayToIdle 0 → 1), then the jacks ease in', () => {
  const at = (age: number) => postureNow(change('situps', 'jumping-jacks', age), 'jumping-jacks');
  assert.deepEqual(at(0)!.flat, { act: 'situps', k: 1, ago: 0 });
  assert.ok(at(FLATTEN - 0.01)!.flat!.k < 0.01);
  let last = 0;
  for (let age = FLATTEN; age < FLATTEN + GET_UP; age += 0.05) { const r = at(age)!.rise!; assert.ok(r >= last && r - last < 0.12, `rise ${r} after ${last}`); last = r; }
  assert.ok(last > 0.99);
  const s = at(FLATTEN + GET_UP + ACT_BLEND / 2)!;
  assert.equal(s.rise, undefined);
  assert.ok(s.settle > 0 && s.settle < 1);
  assert.equal(at(FLATTEN + GET_UP + ACT_BLEND + 0.01), null);
  assert.ok(FLATTEN + GET_UP + ACT_BLEND < ACT_HISTORY, 'the whole change stays within the history the replay keeps');
});

test('standing to sit-ups lies down, then the sit-up eases in; standing to push-ups tilts the plank down from the feet', () => {
  assert.equal(postureNow(change('idle', 'situps', 0), 'situps')!.rise, 1);
  assert.ok(postureNow(change('idle', 'situps', LIE_DOWN - 0.05), 'situps')!.rise! < 0.02);
  assert.ok(postureNow(change('idle', 'situps', LIE_DOWN + 0.1), 'situps')!.settle < 1);
  const tilt = postureNow(change('jumping-jacks', 'pushups', TILT / 2), 'pushups')!.tilt!;
  assert.equal(tilt.act, 'pushups');
  assert.ok(tilt.k > 0 && tilt.k < 1);
  assert.deepEqual(postureNow(change('pushups', 'idle', 0), 'idle')!.tilt, { act: 'pushups', k: 1 });
});

test('an interruption retargets from the attained phase and is independent of sample order', () => {
  const at = (age: number) => postureNow(change('idle', 'pushups', age, change('situps', 'idle', .6 + age)), 'pushups');
  const original = postureNow(change('situps', 'idle', .6), 'idle')!;
  assert.equal(at(0)!.rise, original.rise);
  assert.ok(at(.2)!.rise! > at(0)!.rise!, 'retarget proceeds from the attained get-up');
  assert.deepEqual([.1, .5, .3].map(at), [.3, .5, .1].map(at).reverse());
});

test('dense interruptions retain their source origin across the old history boundary', () => {
  const t = [0, 100, 102, 104, 105], v = ['situps', 'idle', 'pushups', 'idle', 'situps'];
  for (const tick of [135.98, 136.02]) {
    const c = lastPostureChange(t, v, 4, tick, .05, () => undefined)!;
    assert.ok(c.before?.before?.before);
    assert.equal(postureNow(c, 'situps'), null, 'the attained transition has completed on both sides of the old cutoff');
  }
  const sample = (tick: number) => postureNow(lastPostureChange(t, v, 4, tick, .05, () => undefined)!, 'situps');
  assert.deepEqual(sample(110), sample(110));
  assert.deepEqual([110, 112, 115].map(sample), [115, 112, 110].map(sample).reverse());
});

test('a seat: straight from standing to sit draws sit-down, from sit to standing stand-up; the old engine phases are left alone', () => {
  assert.deepEqual(postureNow(change('idle', 'sit', 0.3), 'sit'), { settle: 0, activity: 'sit-down', since: 0.3 });
  assert.deepEqual(postureNow(change('sit', 'idle', 0.2), 'idle'), { settle: 0, activity: 'stand-up', since: 0.2 });
  assert.equal(postureNow(change('idle', 'sit-down', 0.3), 'sit'), null);
  assert.equal(postureNow(change('stand-up', 'idle', 0.1), 'idle'), null);
});

test('a floor exit continues cosmetically while the native body walks, without inventing standing transitions', () => {
  assert.ok(postureNow(change('situps', 'walk', 0.2), 'walk')?.flat);
  assert.equal(postureNow(change('idle', 'jumping-jacks', 0.1), 'jumping-jacks'), null);
  assert.equal(postureNow(undefined, 'idle'), null);
});

test('the latest posture change in a history survives an idle tick between two exercises, with the one before it', () => {
  // sit-ups from tick 0, idle for one tick at 40, jumping jacks from 41
  const t = [0, 40, 41], v = ['situps', 'idle', 'jumping-jacks'];
  const c = lastPostureChange(t, v, 2, 45, 0.05, () => undefined)!;
  assert.deepEqual({ from: c.from, to: c.to }, { from: 'situps', to: 'idle' });
  assert.ok(Math.abs(c.age - 0.25) < 1e-9);
  assert.ok(postureNow(c, 'jumping-jacks'));
  assert.equal(postureNow(lastPostureChange(t, v, 2, 40 + 40, 0.05, () => undefined)!, 'jumping-jacks'), null); // 2 s later: over
  const two = lastPostureChange([0, 40, 52], ['situps', 'idle', 'pushups'], 2, 55, 0.05, () => undefined)!;
  assert.deepEqual([two.from, two.to, two.before?.from, two.before?.to], ['idle', 'pushups', 'situps', 'idle']);
});

test('a frame crossfade moves each hand from one goal to the other, never in one step', () => {
  const a = activityFrame('jumping-jacks', 'idle', 1.3, 's1'), b = activityFrame('stretch', 'idle', 1.3, 's1');
  assert.ok(a && b);
  let prev = blendFrames(a, b, 0)!;
  for (let k = 0.1; k <= 1.0001; k += 0.1) {
    const f = blendFrames(a, b, Math.min(1, k))!;
    for (const i of [0, 1] as const) {
      const p = prev.hands?.[i], q = f.hands?.[i];
      if (p && q) assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5);
    }
    assert.ok(Math.abs(f.feetOut - prev.feetOut) < 0.1);
    prev = f;
  }
  const off = blendFrames(a, null, 0.75)!;
  for (const i of [0, 1] as const) if (a.hands?.[i]) assert.ok(Math.abs(off.handW![i] - 0.25) < 1e-9);
  assert.equal(blendFrames(null, null, 0.5), null);
  const sit = activityFrame('situps', 'idle', 2.1, 's1')!, flat = blendFrames(null, sit, 0)!;
  assert.equal(flat.lying?.face, 'back');
  assert.equal(flat.lying?.raise, 0);
});

test('recorded walk cancellation carries its actual eased boundary weight and stride distance',async()=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  const scene=openGround(),world=emptyWorld('posture-gait',scene),body=human('gait-origin',0,0);world.entities[body.id]=body;
  const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'posture-gait'});let chunk=new TakeRecorder(runtime,{rulesVersion:'posture-gait'});const chunks:import('../../engine/take/types.ts').Take[]=[];
  for(let k=0;k<40;k++){body.human!.activity=k<5?'idle':k<20?'walk':'stargaze';body.pose.p[0]=Math.max(0,Math.min(15,k-5))*.02;runtime.step();if(k===24){chunks.push(chunk.finish());chunk=new TakeRecorder(runtime,{rulesVersion:'posture-gait'});}}chunks.push(chunk.finish());
  const people=new TakePeople(recorder.finish()),reader=people as unknown as {activityHistory(id:string,tick:number,act:string,walk:number):{postureChange?:{fromWalk?:{weight:number;distance:number}}}};
  const origin=reader.activityHistory(body.id,30,'stargaze',0).postureChange?.fromWalk;
  assert.ok(origin,'original gait boundary metadata reaches the renderer');assert.ok(origin.weight>.1&&origin.weight<.9,'the eased stop boundary is a partial stride, not a fabricated full-weight gait');assert.ok(origin.distance>.2&&origin.distance<.4,'stride phase comes from the recorded path');
  const rolled=new TakePeople(chunks[0]);rolled.setTake(chunks[1],{[body.id]:.3});rolled.setWaterHistory(chunks);
  const later=(rolled as unknown as typeof reader).activityHistory(body.id,5,'stargaze',0).postureChange?.fromWalk;
  assert.ok(later,'compatible previous-window origin is retained');assert.ok(Math.abs(later.weight-origin.weight)<1e-6,'rollover preserves eased boundary weight');assert.ok(Math.abs(later.distance-origin.distance)<1e-6,'rollover preserves cumulative stride phase');
  rolled.setTake(chunks[1]);rolled.setWaterHistory(chunks);assert.equal((rolled as unknown as typeof reader).activityHistory(body.id,5,'stargaze',0).postureChange?.fromWalk,undefined,'unknown previous cumulative offset never fabricates a stride origin');

});
