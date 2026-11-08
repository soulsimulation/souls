// #1334 hold-settle/1. The same harness as refuse.test.ts: a test invariant runs first in the end-of-tick pass, so what it does
// to a body lands where a bad action step would. Under the rule a refused move holds its programme, a body undo can't answer
// is settled at the nearest legal pose, and only what neither answers is left for the host's repair, alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, MarsEngine } from './engine.ts';

const on = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
type Fn = (rt: any) => { code: string; message: string; subjects: string[] }[] | void;
function world(settle = true, seed = 'hold-settle') {
  const e = on.create(on.genesis(seed)) as MarsEngine;
  if (settle) e.configureRuntimePolicy({ sleepBlockTicks: 1200, refusalSettleV1: true } as never);
  e.spawnHuman({ id: 'a', label: 'Ada', soul: 's_a', at: [0, 0] } as any); e.spawnHuman({ id: 'b', label: 'Bo', soul: 's_b', at: [6, 6] } as any);
  e.spawnHuman({ id: 'c', label: 'Cy', soul: 's_c', at: [-8, -8] } as any);
  const rt = (e as any).rt, ends: any[] = [], rows: any[] = [];
  const step = () => { const o = e.step(); ends.push(...o.programs.filter(p => p.kind !== 'step')); rows.push(...(o.refusals ?? [])); return o; };
  const inject = (fn: Fn) => { rt.invariants = [(r: any) => fn(r) ?? [], ...rt.invariants]; };
  const times = (n: number, fn: Fn) => { const at = new Set<number>(); inject(r => { if (at.has(r.tick) || at.size >= n) return; at.add(r.tick); return fn(r); }); };   // once a tick: a refusal runs the pass twice
  const walk = (id: string, to: [number, number]) => { const r = e.perform({ actor: id, label: 'walk', steps: [{ verb: 'walk_to', params: { to } }] }); assert.equal(r.ok, true, JSON.stringify(r)); };
  const go = (n: number) => { for (let i = 0; i < n; i++) step(); };
  return { e, rt, ends, rows, step, times, inject, walk, go, pose: (id: string) => [...e.world.entities[id].pose.p], prog: (id: string) => e.programOf(id) };
}
const shove = (id: string, dx: number) => (rt: any) => { rt.world.entities[id].pose.p[0] += dx; };

test('A1 hold: a refused move is undone and the programme goes on; the third refusal in the window fails it', () => {
  const w = world(); w.walk('a', [12, 0]); w.walk('c', [-8, 12]); w.go(10);
  const prog = w.prog('a'), cy = w.prog('c');
  const before = w.pose('a'); w.times(1, shove('a', 1)); w.step();
  assert.deepEqual(w.e.runtime.violations, []); assert.deepEqual(w.pose('a'), before, 'the move is undone');
  assert.equal(w.prog('a'), prog, 'held: the programme goes on'); assert.equal(w.rows.at(-1).rule, 'motion.teleport');
  w.go(5); assert.ok(w.pose('a')[0] > before[0], 'and walks on'); assert.deepEqual(w.e.runtime.violations, []);
  w.go(100);   // the first refusal leaves the window
  w.times(3, shove('a', 1)); w.step(); w.step(); assert.equal(w.prog('a'), prog, 'two holds in the window');
  w.step(); assert.equal(w.prog('a'), null, 'the third fails it');
  const end = w.ends.find(x => x.actor === 'a'); assert.equal(end.code, 'world.refused:motion.teleport');
  assert.deepEqual(w.e.runtime.violations, []); assert.equal(w.prog('c'), cy, 'the bystander walks on'); assert.ok(!w.rows.some(r => r.bodies.includes('c')));
});

test('A1 a hug squeeze: both bodies hold for two refusals, then only their programmes fail; the bystander is untouched', () => {
  const w = world(); w.walk('a', [3, 3]); w.walk('b', [3, 3]); w.walk('c', [-8, 8]); w.go(5);
  const [pa, pb, pc] = [w.prog('a'), w.prog('b'), w.prog('c')], cyAt = () => w.pose('c');
  w.times(3, rt => { shove('a', 0.02)(rt); shove('b', -0.02)(rt); return [{ code: 'collision.human-human', message: 'forced squeeze', subjects: ['a', 'b'] }]; });
  w.step(); w.step(); assert.equal(w.prog('a'), pa); assert.equal(w.prog('b'), pb);
  const c0 = cyAt(); w.step();
  assert.equal(w.prog('a'), null); assert.equal(w.prog('b'), null);
  assert.deepEqual(w.ends.filter(x => x.actor !== 'c').map(x => [x.actor, x.code]).sort(), [['a', 'world.refused:collision.human-human'], ['b', 'world.refused:collision.human-human']]);
  assert.equal(w.prog('c'), pc); assert.notDeepEqual(cyAt(), c0, 'c moved this tick'); assert.deepEqual(w.e.runtime.violations, []);
});

for (const rule of ['collision.human-static', 'collision.human-human', 'collision.human-load', 'motion.overspeed', 'motion.teleport', 'carry.load-static', 'lift.hands-out-of-reach'])
  test(`A5 ${rule} on a moved body ends in a hold, nothing left for rung 2 or 3`, () => {
    const w = world(); w.walk('a', [10, 0]); w.go(10); const prog = w.prog('a'), before = w.pose('a');
    w.times(1, rt => { shove('a', 0.05)(rt); return [{ code: rule, message: 'forced', subjects: ['a'] }]; });
    w.step(); assert.deepEqual(w.e.runtime.violations, []); assert.deepEqual(w.pose('a'), before); assert.equal(w.prog('a'), prog);
  });

test('A2 settle: two bodies the world put together (neither moved): the second by id is stood clear, its programme ends', () => {
  const w = world(); w.walk('c', [-8, 8]); w.go(3);
  assert.equal(w.e.perform({ actor: 'b', label: 'rest', steps: [{ verb: 'rest', params: { seconds: 60 } }] }).ok, true); w.go(3);
  const pc = w.prog('c'), a0 = w.pose('a');
  w.times(1, () => [{ code: 'collision.human-human', message: 'forced: placed together', subjects: ['b', 'a'] }]);
  w.step();
  assert.deepEqual(w.e.runtime.violations, []); assert.deepEqual(w.pose('a'), a0, 'the first stays');
  const row = w.rows.at(-1); assert.equal(row.relocated, true); assert.deepEqual(row.bodies, ['b']); assert.ok(row.poses.b);
  assert.equal(w.prog('b'), null); assert.equal(w.ends.find(x => x.actor === 'b').code, 'world.settled:collision.human-human');
  assert.equal(w.prog('c'), pc);
});

test('A2 settle: an unmoved busy body inside something is stood at the nearest clear spot', () => {
  const w = world(); assert.equal(w.e.perform({ actor: 'a', label: 'rest', steps: [{ verb: 'rest', params: { seconds: 60 } }] }).ok, true); w.go(5);
  (w.e as any).standsClearV1 = (id: string) => id !== 'a';   // the world landed a solid on a walking body
  w.times(1, () => [{ code: 'collision.human-static', message: 'forced: built over', subjects: ['a'] }]);
  w.step(); assert.deepEqual(w.e.runtime.violations, []);
  assert.equal(w.rows.at(-1).relocated, true); assert.equal(w.prog('a'), null); assert.equal(w.ends.at(-1).code, 'world.settled:collision.human-static');
});

test('A2 settle: a carrier rule frees the rider and stands it on the ground; a restart reaches the same hash', () => {
  const run = () => {
    const w = world(); w.walk('c', [-8, 8]); w.go(3);
    const h = w.e.world.entities.a.human as any; h.carrier = { id: 'gone-balloon', slot: 's1', phase: 'seated' };   // a ride mark for a ride that holds no such rider
    w.go(1); return w;
  };
  const w = run();
  assert.deepEqual(w.e.runtime.violations, []); assert.equal((w.e.world.entities.a.human as any).carrier, undefined);
  const row = w.rows.find(r => r.rule === 'carrier.rider-mismatch'); assert.ok(row?.relocated, JSON.stringify(w.rows));
  assert.notEqual(w.prog('c'), null, 'the bystander walks on');
  const two = run(); assert.equal(two.e.stateHash(), w.e.stateHash());
  const copy = on.restore(w.e.snapshot()) as MarsEngine; for (let i = 0; i < 20; i++) { w.e.step(); copy.step(); } assert.equal(copy.stateHash(), w.e.stateHash());
});

test('A3/A4 a carve-out goes to the host alone; the other violation of that tick is still held', () => {
  const w = world(); w.walk('a', [10, 0]); w.walk('b', [6, 16]); w.go(10);
  const pb = w.prog('b'), b0 = w.pose('b');
  (w.e.world.entities.a.human as any).on = 'beam';
  w.times(1, rt => { shove('a', 1)(rt); shove('b', 1)(rt); });
  w.step();
  const left = w.e.runtime.violations.map((v: any) => v.subjects.join()); assert.ok(left.length && left.every((s: string) => s === 'a'), 'only the body on the structure is left for the host: ' + left);
  assert.deepEqual(w.pose('b'), b0); assert.equal(w.prog('b'), pb, 'b held, not failed');
});

test('off: without the rule a refusal fails the programme and one unanswerable violation sends the whole tick to the host', () => {
  const w = world(false); w.walk('a', [10, 0]); w.walk('b', [6, 16]); w.go(10);
  w.times(1, shove('a', 1)); w.step(); assert.equal(w.prog('a'), null);
  (w.e.world.entities.b.human as any).on = 'beam'; w.walk('a', [10, 0]); w.go(3);
  const n0 = w.e.runtime.violations.length; w.times(1, rt => { shove('a', 1)(rt); shove('b', 1)(rt); }); w.step();
  const left = w.e.runtime.violations.slice(n0).map((v: any) => v.subjects.join()); assert.ok(left.includes('a') && left.includes('b'), 'all of a tick or none of it: ' + left);
});

test('a hold and a settle need no input: two runs and a restored copy reach the same state', () => {
  const run = (copyAt?: number) => {
    const w = world(); w.walk('a', [10, 0]); w.walk('b', [6, 16]); w.go(10);
    let copy: MarsEngine | undefined; if (copyAt === 0) copy = on.restore(w.e.snapshot()) as MarsEngine;
    const forced = (r: any) => { shove('a', 1)(r); return [{ code: 'collision.human-human', message: 'forced', subjects: ['c', 'b'] }]; };
    w.times(1, forced);
    if (copy) { const rt = (copy as any).rt; let k = 0; rt.invariants = [(r: any) => (k++ ? [] : forced(r)), ...rt.invariants]; }
    for (let i = 0; i < 30; i++) { w.e.step(); copy?.step(); }
    return { w, copy };
  };
  const one = run(), two = run(); assert.equal(one.w.e.stateHash(), two.w.e.stateHash());
  const { w, copy } = run(0); assert.equal(copy!.stateHash(), w.e.stateHash());
});
