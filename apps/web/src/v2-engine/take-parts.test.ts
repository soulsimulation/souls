// K1 (0.135): a load riding a carry's node is placed where the node's samples have it at the time drawn, turned with its
// way; a part with an entry and no def in the layer is handed to CreatorKinds as a definition, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placedOf } from './world-state.ts';
import { CarriedParts, bundledEntries, headingAt, sampleAt, type PartNode } from './take-parts.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const node = (id: string, kind: string, parent: string | null, pos: [number, number, number], extra: object = {}): PartNode =>
  ({ id, kind, parent, slot: null, pos, rot: [Q, 0, 0, 0], ...extra });
const place = node('w.0', 'souls:place@1', null, [0, 0, 0]);
const ground = node('g.1', 'eden:ground@2', 'w.0', [0, 0, 0]);
// the carry's node, lifted at x = 10 m; the beam its rider at the node's origin
const carry = node('c.7', 'test:carry@8', 'g.1', [10_000_000, 0, 0]);
const beam = node('b.3', 'mars:rack_beam@12204', 'c.7', [0, 1_000_000, 0]);

function fake() {
  const applied: PartNode[][] = [];
  return { applied, kinds: { apply: (nodes: PartNode[]) => { applied.push(nodes); } } };
}

test('a carried load is where its carry\'s samples have the carry at the time drawn, not where it was lifted', () => {
  const { kinds } = fake(), parts = new CarriedParts(kinds);
  parts.receive({ t: 'snapshot', s: { nodes: [place, ground, carry, beam], removed: [] } });
  // the carry walks east 1 m a second, 0 to 4 s
  const samples = [0, 1, 2, 3, 4].map((k): [string, string, number | null, number, number, number, number] => ['c.7', 'g.1', null, T0 + k * 1_000_000, 10_000_000 + k * 1_000_000, 0, 0]);
  parts.receive({ t: 'part', p: { nodes: [], removed: [], samples } });
  const at = (s: number) => { const f = parts.frames(T0 + s * 1e6); const m = new Map([place, ground, carry, beam].map((n) => [n.id, n])); for (const n of f) m.set(n.id, n); return placedOf(m as never, 'b.3')!; };
  assert.deepEqual(at(0).p.map((v) => +v.toFixed(3)), [10, 1, 0]);
  assert.deepEqual(at(2.5).p.map((v) => +v.toFixed(3)), [12.5, 1, 0], 'between the samples around the time drawn');
  assert.deepEqual(at(9).p.map((v) => +v.toFixed(3)), [14, 1, 0], 'past the newest: the newest');
  // turning north (-z) from 4 s, the carry and its load turn by as much as its way has turned
  parts.receive({ t: 'part', p: { nodes: [], removed: [], samples: [5, 6].map((k): [string, string, number | null, number, number, number, number] => ['c.7', 'g.1', null, T0 + k * 1_000_000, 14_000_000, 0, -(k - 4) * 1_000_000]) } });
  assert.ok(Math.abs(at(6).yaw - Math.PI / 2) < 0.01, `a quarter turn, not ${at(6).yaw}`);
  // nothing carried: no frame handed on
  parts.receive({ t: 'part', p: { nodes: [{ ...beam, parent: 'g.1', pos: [14_000_000, 0, -2_000_000] }], removed: [], samples: [] } });
  assert.deepEqual(parts.frames(T0 + 6e6), []);
});

test('a part of a kind with an entry is handed to CreatorKinds as its definition once; one with an origin is the layer\'s', () => {
  const { kinds, applied } = fake();
  const parts = new CarriedParts(kinds, bundledEntries({ a: { default: { format: 'souls-entry/1', kind: 'mars:rack_beam', geometry: { bounds_mm: [51, 102, 2743] } } } }));
  parts.receive({ t: 'snapshot', s: { nodes: [place, ground, beam, { ...beam, id: 'b.4' }, { ...beam, id: 'b.5', kind: 'eden:bench@1', origin: 'e_bench1' }], removed: [] } });
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0].kind, 'souls:kind');
  assert.equal(applied[0][0].defines, 'mars:rack_beam@12204');
  assert.equal(JSON.parse(new TextDecoder().decode(applied[0][0].entry)).geometry.bounds_mm[2], 2743);
});

test('samples between two times are interpolated; the heading is the way of the last 5 cm or more', () => {
  const s = [{ at: 0, frame: 'g', slot: null, p: [0, 0, 0] as [number, number, number] }, { at: 10, frame: 'g', slot: null, p: [1000, 0, 0] as [number, number, number] }];
  assert.deepEqual(sampleAt(s, 5)?.p, [500, 0, 0]);
  assert.equal(headingAt(s, 10), null, '1 mm is not a direction');
  s.push({ at: 20, frame: 'g', slot: null, p: [0, 0, 100_000] });
  assert.ok(Math.abs(headingAt(s, 20)! + Math.PI / 2) < 0.02, 'south (+z) is a quarter turn the other way');
});
