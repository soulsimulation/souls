// #2422: the take recorder's cut computes a take's state hash, id and table text when they are first read, not inside the
// tick. The takes a run produces must stay byte-identical: these ids, final state hashes and baselines were recorded on
// main (44455d070) before the change, over walking bodies, still-world jumps (skipToV1) and a clock move (setClockV1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { hashOf, stableStringify } from '../../../mars/viewer/engine/core/hash.ts';
import { takeIdOf } from '../../../mars/viewer/engine/take/recorder.ts';
import type { Take } from '../../../mars/viewer/engine/take/types.ts';

type Row = [from: number, to: number, id: string, baseline: string, final: string];
const factory = await marsFactory({ ...GREEN_FIELD_WORLD, heldActivitiesV1: true, soulsRepairV1: true });

/** A run: three bodies walk, a still stretch is skipped twice, the clock is moved once. Takes are read only at the end
 *  (`readEvery` 0) or after every step (as a watched world's hub reads them). */
function run(readEvery: number) {
  const e = factory.create(factory.genesis('take-recut-2422')) as MarsEngine;
  for (const [id, label] of [['a', 'Ada'], ['b', 'Bo'], ['c', 'Cy']]) e.spawnHuman({ id, label, soul: `s_${id}` });
  const seen = new Map<number, Take>();
  const read = () => { for (const c of e.takeChunks(-1)) { const t = c.take as Take; seen.set(c.toTick, t); void t.id; } };
  const step = (n: number) => { for (let i = 0; i < n; i++) { e.step(); if (readEvery && i % readEvery === 0) read(); } };
  const walk = (id: string, to: [number, number]) => assert.equal(e.perform({ actor: id, label: 'walk', steps: [{ verb: 'walk_to', params: { to } }] } as never).ok, true);
  walk('a', [6, 2]); walk('b', [-5, 3]); step(70);
  walk('c', [3, -6]); step(45);
  step(160);   // until every walk has ended and the world is still
  const skip = (e as unknown as { skipToV1(t: number): { ok: boolean; reason?: string } }).skipToV1(e.world.tick + 9721);
  assert.equal(skip.ok, true, `still-world jump: ${skip.reason}`);
  step(30);
  walk('a', [0, 0]); step(50);
  (e as unknown as { setClockV1(t: number): void }).setClockV1(e.world.tick + 7);
  step(25);
  read();
  const rows: Row[] = [...seen.values()].sort((x, y) => x.startTick - y.startTick).map((t) => [t.startTick, t.startTick + t.ticks, t.id, t.baselineStateHash.slice(0, 16), t.finalStateHash.slice(0, 16)]);
  return { e, rows, takes: [...seen.values()] };
}

const MAIN: Row[] = [
  [0,  20,  "40628912f43510f422499aa4",  "358a705cc2c1e749",  "f5c93d5d420a74c7"],
  [20,  40,  "1992556bb7be8dd498c9dfb7",  "f5c93d5d420a74c7",  "06603a9aee622fd6"],
  [40,  60,  "20c6b5a7640b2453deee4d75",  "06603a9aee622fd6",  "8d8bceda0954f477"],
  [60,  80,  "569579de6a3c6c3f2c082878",  "8d8bceda0954f477",  "de5992065093c95d"],
  [80,  100,  "eb837b78b6e3c93c50e7eedd",  "de5992065093c95d",  "75c6487a4d02822c"],
  [100,  120,  "d159a55f5f684ff3e344b817",  "75c6487a4d02822c",  "16e9be4cd223a803"],
  [120,  140,  "c5ebe403da4bd5072e0df377",  "16e9be4cd223a803",  "664649091e3f2c82"],
  [140,  160,  "244b295e84d1c34626b78bc2",  "664649091e3f2c82",  "8b1c258cb8a90f72"],
  [160,  180,  "8abba0dbfe0fbf6fd1c8c1d9",  "8b1c258cb8a90f72",  "46f3a0d3bffddfe7"],
  [180,  200,  "a2508ff977525573833d1d3e",  "46f3a0d3bffddfe7",  "b42d897d723cf461"],
  [200,  220,  "0ccbbe35a610a2f3fec56d2d",  "b42d897d723cf461",  "cdc6e1fa99e139b1"],
  [220,  240,  "c47970b24c262570fe574ed2",  "cdc6e1fa99e139b1",  "f9a6b986171e5181"],
  [240,  260,  "6b2ac045757c81724f3dc457",  "f9a6b986171e5181",  "40c630db2c502adf"],
  [260,  9980,  "694e37389ceb85f52a83ac05",  "40c630db2c502adf",  "2e9694d4bbd58937"],
  [9980,  10000,  "ef96105d424ec8dd1742c6bc",  "2e9694d4bbd58937",  "9fdc70072dbb860d"],
  [10000,  10020,  "d3d483f37d473b188abcb21e",  "9fdc70072dbb860d",  "8201b8ed875ed711"],
  [10020,  10040,  "5e8bab590e4cd131113e759c",  "8201b8ed875ed711",  "a92070ab1d55feb3"],
  [10040,  10060,  "52c577f91ebf84f4345caaec",  "a92070ab1d55feb3",  "a4bd09a72362373b"],
  [10060,  10076,  "5ee42915d6be4591e7e35024",  "a4bd09a72362373b",  "c927e4b4403a1a78"],
  [10083,  10103,  "20228e0fcc4842e1135de5f5",  "3747a02a6ff0da79",  "e1f9058080974aef"],
];

test('#2422: the takes of a run are byte-identical to main, read late or every tick', () => {
  const late = run(0), live = run(1);
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(live.rows));
  assert.deepEqual(late.rows, MAIN.slice(-late.rows.length), "the 12 chunks the engine keeps");
  assert.equal(late.rows.length, 12);
  assert.deepEqual(live.rows, MAIN);
  for (const t of live.takes) {
    assert.equal(hashOf(t.finalState), t.finalStateHash, `final state hash at ${t.startTick}`);
    assert.equal(takeIdOf(t), t.id, `content address at ${t.startTick}`);
    // the wire forms see the same values as the fields
    const json = JSON.parse(JSON.stringify(t)) as Take, clone = structuredClone(t);
    assert.equal(json.id, t.id); assert.equal(clone.finalStateHash, t.finalStateHash); assert.equal(stableStringify(clone), stableStringify(json));
  }
  assert.equal(stableStringify(late.e.world), stableStringify(live.e.world), 'reading takes changes nothing in the world');
});
