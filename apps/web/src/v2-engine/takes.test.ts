// #4153: the v2 bodies' samples become the take chunks the old page already draws (takes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedTakeChunkSchema } from '@souls/protocol';
import { TakePeople } from '../../../../mars/viewer/app/engine-view/take-replay.ts';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { chunkEnd, chunkOf, motionAt, positionAt, TICKS, TICK_US, type Body } from './takes.ts';

const FROM = 1000; // a chunk's first tick (aligned to TICKS)
const t0 = FROM * TICK_US;
/** Walks +x at 1 m/s for 2 s from (10 m, 0, 5 m), sampled every 0.2 s as v2's parts carry them; then stands. */
const walker: Body = { entity: 'v2_a_1', soul: 'soul-a-1', name: 'Ada', heading: 1, samples: Array.from({ length: 11 }, (_, i) => ({ at: t0 + i * 200_000, p: [10_000 + i * 200, 0, 5_000] as [number, number, number] })) };
const stander: Body = { entity: 'v2_a_2', soul: 'soul-a-2', name: 'Bo', heading: 0.5, samples: [{ at: t0 - 5_000_000, p: [0, 0, 0] }] };
const frame = { rulesVersion: 'test/1', datetime: '2026-06-01T12:00:00.000Z' };

test('a chunk is a recorded take chunk the page accepts', () => {
  const c = chunkOf([walker, stander], FROM, frame);
  assert.equal(c.toTick - c.fromTick, TICKS);
  assert.ok(recordedTakeChunkSchema.safeParse(c).success);
});

test('the replay draws each body where its samples have it, facing the way it walks, walking', () => {
  const take = chunkOf([walker, stander], FROM, frame).take as unknown as Take;
  for (const k of [0, 5, 13, 20]) {
    const at = sampleTake(take, k * take.dt).entities.v2_a_1, want = positionAt(walker.samples, (FROM + k) * TICK_US)!;
    assert.ok(Math.abs(at.p[0] - want[0] / 1000) < 0.002 && Math.abs(at.p[2] - want[2] / 1000) < 0.002, `tick ${k}: ${at.p} vs ${want}`);
    assert.ok(Math.abs(at.yaw) < 0.002, 'walking +x is heading 0 (atan2(dz, dx))');
    assert.equal(at.activity, 'walk');
    assert.ok(Math.abs((at.speed ?? 0) - 1) < 0.03, `speed ${at.speed}`);
  }
  const bo = sampleTake(take, 0.5).entities.v2_a_2;
  assert.deepEqual(bo.p, [0, 0, 0]);
  assert.equal(bo.activity, 'idle');
  assert.ok(Math.abs(bo.yaw - 0.5) < 0.002, 'a body that has not moved keeps its placed heading');
  assert.equal((take.tracks.v2_a_2 as unknown[]).length, 2, 'a still body is two samples');
});

test('never past the newest sample: a body stops where its samples stop, and stands', () => {
  const take = chunkOf([walker], FROM + TICKS * 2, frame).take as unknown as Take; // 2 s on: after the last sample
  const at = sampleTake(take, 0.5).entities.v2_a_1;
  assert.ok(Math.abs(at.p[0] - 12) < 0.001);
  assert.equal(at.activity, 'idle');
  assert.ok(Math.abs(at.yaw) < 0.002, 'it keeps facing the way it last walked');
});

test('a body with no sample by the chunk end is not in it; chunks end on whole chunks', () => {
  const late: Body = { ...walker, entity: 'v2_late', samples: [{ at: (FROM + TICKS + 1) * TICK_US, p: [0, 0, 0] }] };
  assert.equal(Object.keys((chunkOf([late], FROM, frame).take as { tracks: object }).tracks).length, 0);
  assert.equal(chunkEnd((FROM + TICKS + 7) * TICK_US), FROM + TICKS);
});


test('posture base changes preserve one-shot age and seated wave release in actual take history',()=>{
  const take=chunkOf([stander],FROM,frame).take as unknown as Take,id=stander.entity;
  const history=(changes:Take['changes'],tick:number,activity:string)=>{const people=new TakePeople({...take,changes});return (people as unknown as {activityHistory(id:string,tick:number,act:string,walk:number):{activityAge?:number;postureChange?:unknown;waveSamples?:unknown[]}}).activityHistory(id,tick,activity,0);};
  const base:Take['changes']=[[0,id,'activity','idle'],[2,id,'activity','nod'],[2,id,'baseActivity','sit'],[8,id,'baseActivity',null]];
  const nod=history(base,10,'nod');assert.equal(nod.activityAge,.4);assert.ok(nod.postureChange,'base-only seat exit is retained without restarting nod');
  assert.ok(history([[0,id,'activity','nod'],[0,id,'baseActivity','sit'],[8,id,'baseActivity',null]],10,'nod').postureChange,'first retained activity still carries a base-only posture change');
  const wave=history([[0,id,'activity','sit'],[0,id,'baseActivity','sit'],[2,id,'activity','wave'],[8,id,'activity','sit']],9,'sit');
  assert.equal(wave.waveSamples?.length,1,'seated return keeps the original wave release sample');
});


test('standing retargets begin at the previous drawn heading, including immediate turns and fresh seeks', () => {
  const samples = [{ at: t0, p: [0, 0, 0] as [number, number, number] }];
  const turns = [{ at: t0 + 1e6, from: 0, to: Math.PI / 2 }, { at: t0 + 1.1e6, from: Math.PI / 2, to: -Math.PI / 2 },
    { at: t0 + 1.1e6, from: -Math.PI / 2, to: Math.PI }];
  const at = (t: number) => motionAt(samples, t0 + t * 1e6, 0, turns).heading;
  assert.ok(Math.abs(at(1.1) - at(1.1 - .00001)) < .001, 'unfinished and same-time targets cannot replace the drawn origin');
  assert.ok(at(1.1) > .4 && at(1.1) < .42, 'the first quarter turn was only partly drawn');
  assert.ok(Math.abs(at(2) - Math.PI) < 1e-9, 'the final target is reached');
  const chronological = [1, 1.1, 1.2, 1.4, 2].map(at);
  for (const i of [4, 1, 3, 0, 2]) assert.equal(at([1, 1.1, 1.2, 1.4, 2][i]), chronological[i], 'seeks do not depend on previous draws');
  assert.equal(motionAt([{ at: t0, p: [0, 0, 0] }, { at: t0 + 3e6, p: [3000, 0, 0] }], t0 + 2e6, 0, turns).heading, 0, 'ordinary walking owns its heading');
  assert.equal(motionAt([{ at: t0, p: [0, 0, 0], seat: { height: 1, lie: false, heading: .7 } }], t0 + 2e6, 0, turns).heading, .7, 'a seat owns its heading');
});
