// K1 (0.135): a load riding a carry's node is placed where the node's samples have it at the time drawn, turned with its
// way; a part with an entry and no def in the layer is handed to CreatorKinds as a definition, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placedOf, WorldState } from './world-state.ts';
import { CarriedParts, bundledEntries, headingAt, sampleAt, type PartNode } from './take-parts.ts';
import { kindDef } from './creator-kinds.ts';

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

test('a seated part is drawn in its bay\'s slot; a part with an origin the layer has no entity for is handed on without it', () => {
  const { kinds, applied } = fake();
  // the map answers `get` only for kinds the library does not draw (stream-scene.ts UnlessLibrary): the part's entry is
  // still its look
  const entries = new (class extends Map<string, Uint8Array> { get() { return undefined; } })(bundledEntries({
    u: { format: 'souls-entry/1', kind: 'mars:rack_upright', points: { foot: [0, 0, 0] }, geometry: { bounds_mm: [1219, 2438, 76] } },
    b: { format: 'souls-entry/1', kind: 'mars:rack_bay', slots: { upright_a: { at_mm: [0, 0, -1448] } }, geometry: { bounds_mm: [1219, 2438, 2972] } },
  }));
  const parts = new CarriedParts(kinds, entries);
  // the bay at x 65 m, z -24 m, its slot 1 at (0, 0, -1448) mm; frame A seated in it, imported as `yard-frame-1`
  const bay = node('bay', 'mars:rack_bay@1220bf', 'g.1', [65_000_000, 0, -24_000_000], { origin: 'site-bay', slots: [[1, 0, 0, -1448, 0, 1]] });
  const frame = node('fa', 'mars:rack_upright@1220eb', 'bay', [0, 0, 0], { slot: 1, origin: 'yard-frame-1' });
  const old = node('fo', 'mars:rack_upright@1220eb', 'g.1', [1, 0, 0], { origin: 'e_frame1' });
  parts.receive({ t: 'snapshot', s: { nodes: [place, ground, bay, frame, old], removed: [] } });
  assert.deepEqual(applied.map((a) => a.map((n) => [n.id, n.defines])), [[['part:mars:rack_upright@1220eb', 'mars:rack_upright@1220eb']]], 'the part\'s own entry, before the library\'s');
  const handed = parts.frames(0);
  assert.deepEqual(handed.map((n) => [n.id, n.origin]), [['fa', undefined]], 'the bay (a holder) and a part the layer draws are left');
  const m = new Map([place, ground, bay, frame].map((n) => [n.id, n]));
  for (const n of handed) m.set(n.id, n);
  assert.deepEqual(placedOf(m as never, 'fa')!.p.map((v) => +v.toFixed(3)), [65, 0, -25.448], 'in the slot');
  parts.receive({ t: 'part', p: { nodes: [], removed: ['fa'], samples: [] } });
  assert.deepEqual(parts.frames(0), []);
});

test('samples between two times are interpolated; the heading is the way of the last 5 cm or more', () => {
  const s = [{ at: 0, frame: 'g', slot: null, p: [0, 0, 0] as [number, number, number] }, { at: 10, frame: 'g', slot: null, p: [1000, 0, 0] as [number, number, number] }];
  assert.deepEqual(sampleAt(s, 5)?.p, [500, 0, 0]);
  assert.equal(headingAt(s, 10), null, '1 mm is not a direction');
  s.push({ at: 20, frame: 'g', slot: null, p: [0, 0, 100_000] });
  assert.ok(Math.abs(headingAt(s, 20)! + Math.PI / 2) < 0.02, 'south (+z) is a quarter turn the other way');
});

test('W4: a bay placed live (no origin) is defined as its frame, the edges of its bounds, not one box; a stand stays a box', () => {
  const { kinds, applied } = fake();
  const parts = new CarriedParts(kinds, bundledEntries({
    u: { format: 'souls-entry/1', kind: 'mars:rack_upright', points: { foot: [0, 0, 0] }, geometry: { bounds_mm: [1219, 2438, 76] } },
    b: { format: 'souls-entry/1', kind: 'mars:rack_bay', slots: { upright_a: { kinds: ['mars:rack_upright'], at_mm: [0, 0, -1448] } }, geometry: { bounds_mm: [1219, 2438, 2972] } },
    s: { format: 'souls-entry/1', kind: 'mars:frame_stand', slots: { frame_1: { kinds: ['mars:rack_upright'], at_mm: [0, 100, -150] } }, geometry: { bounds_mm: [1419, 300, 600] } },
  }));
  const bay = node('bay', 'mars:rack_bay@1220bf', 'g.1', [65_000_000, 0, -24_000_000], { slots: [[1, 0, 0, -1448, 0, 1]] });
  const stand = node('st', 'mars:frame_stand@1220aa', 'g.1', [60_000_000, 0, -24_000_000]);
  parts.receive({ t: 'snapshot', s: { nodes: [place, ground, bay, stand], removed: [] } });
  const defined = new Map(applied.flat().map((n) => [n.defines, JSON.parse(new TextDecoder().decode(n.entry))]));
  const frame = defined.get('mars:rack_bay@1220bf').geometry.parts as { at: number[]; size: number[] }[];
  assert.equal(frame.length, 12, 'twelve edges');
  assert.ok(frame.every((p) => p.size.filter((v) => v === 30).length >= 2), 'each edge a 30 mm bar');
  assert.deepEqual(frame.slice(0, 4).map((p) => p.at), [[-594.5, 1219, -1471], [594.5, 1219, -1471], [-594.5, 1219, 1471], [594.5, 1219, 1471]], 'its four posts at its corners');
  assert.equal(defined.get('mars:frame_stand@1220aa').geometry.parts, undefined, 'a stand its uprights stand above draws as its box');
  // and the old page's def from it: twelve shapes, not the one bounds box
  const def = kindDef('mars:rack_bay@1220bf', new TextEncoder().encode(JSON.stringify(defined.get('mars:rack_bay@1220bf'))))!.def;
  assert.equal((def.make as unknown as { args: { shapes: unknown[] } }).args.shapes.length, 12);
});

test('W4: a bay placed live (its record has no slot points) is handed on with its kind\'s, so its parts stand in their slots', () => {
  const { kinds } = fake();
  const parts = new CarriedParts(kinds, bundledEntries({
    u: { format: 'souls-entry/1', kind: 'mars:rack_upright', points: { foot: [0, 0, 0] }, geometry: { bounds_mm: [1219, 2438, 76] } },
    m: { format: 'souls-entry/1', kind: 'mars:rack_beam', points: { end_l: {} }, geometry: { bounds_mm: [51, 102, 2743] } },
    b: { format: 'souls-entry/1', kind: 'mars:rack_bay', geometry: { bounds_mm: [1219, 2438, 2972] },
      slots: { upright_a: { kinds: ['mars:rack_upright'], at_mm: [0, 0, -1448] }, upright_b: { kinds: ['mars:rack_upright'], at_mm: [0, 0, 1448] }, beam_high_l: { kinds: ['mars:rack_beam'], at_mm: [-572, 863, 0] } } },
  }));
  // as souls-god places them: the bay at (6, 0, 6) m, each part at its slot's origin
  const bay = node('bay', 'mars:rack_bay@1220bf', 'g.1', [6_000_000, 0, 6_000_000]);
  const ua = node('ua', 'mars:rack_upright@1220eb', 'bay', [0, 0, 0], { slot: 1 }), ub = node('ub', 'mars:rack_upright@1220eb', 'bay', [0, 0, 0], { slot: 2 });
  const hl = node('hl', 'mars:rack_beam@1220cc', 'bay', [0, 0, 0], { slot: 3 });
  parts.receive({ t: 'snapshot', s: { nodes: [place, ground, bay, ua, ub, hl], removed: [] } });
  const handed = parts.frames(0);
  assert.deepEqual(handed.map((n) => [n.id, n.slots]), [['bay', [[1, 0, 0, -1448], [2, 0, 0, 1448], [3, -572, 863, 0]]]]);
  const m = new Map([place, ground, bay, ua, ub, hl].map((n) => [n.id, n]));
  for (const n of handed) m.set(n.id, n);
  const at = (id: string) => placedOf(m as never, id)!.p.map((v) => +v.toFixed(3));
  assert.deepEqual([at('ua'), at('ub'), at('hl')], [[6, 0, 4.552], [6, 0, 7.448], [5.428, 0.863, 6]], 'each in its slot, not all at the bay\'s origin');
  // a bay whose record has its slot points (an import) is left as it is
  parts.receive({ t: 'part', p: { nodes: [{ ...bay, slots: [[1, 0, 0, -1448, 0, 1]] }], removed: [], samples: [] } });
  assert.deepEqual(parts.frames(0), []);
});

// K5 (0.135): a thing of the captured world (an old entity the layer draws) carried laid flat moves with its carry's
// samples, turned off its feet; it is lifted and set down when the time drawn reaches the part that does it.
test('K5: a carried thing of the captured world moves with its carriers laid flat, lifted and set down on time', () => {
  const ws = new WorldState(), parts = new CarriedParts({ apply: () => {} });
  const entities = new Map<string, Record<string, unknown>>([['e_frame', { id: 'e_frame', in: { parent: 'world' }, p: [8, 0, 0], r: 0 }]]);
  const l = { seq: 1, model: { entities } };
  const step = (s: number) => {
    ws.frames(parts.frames(T0 + s * 1e6));
    const d = ws.next(l as never, 0);
    if (!d) return null;
    l.seq = d.seq;
    for (const e of d.diff.upserts as { id: string }[]) entities.set(e.id, e as never);
    return d.diff.upserts[0] as { p: number[]; r: number | number[] };
  };
  const frame = node('u.1', 'mars:rack_upright_6m@1', 'g.1', [8_000_000, 0, 0], { origin: 'e_frame' });
  const both = (m: object) => { parts.receive(m as never); ws.receive(m as never); };
  both({ t: 'snapshot', s: { nodes: [place, ground, carry, frame], removed: [] } });
  assert.equal(step(0), null, 'at rest where the layer has it');
  // lifted at 0.5 s, laid flat (a quarter turn about z), and carried east 1 m a second from x = 10 m
  const flat: [number, number, number, number] = [Math.round(Math.cos(-Math.PI / 4) * Q), 0, 0, Math.round(Math.sin(-Math.PI / 4) * Q)];
  const samples = [0, 1, 2, 3, 4].map((k) => ['c.7', 'g.1', null, T0 + k * 1_000_000, 10_000_000 + k * 1_000_000, 0, 0]);
  both({ t: 'part', p: { from: T0, to: T0 + 500_000, nodes: [{ ...frame, parent: 'c.7', pos: [0, 900_000, 0], rot: flat }], removed: [], samples } });
  assert.equal(step(0.2), null, 'not lifted before the time drawn reaches its lift');
  const up = step(2)!;
  assert.ok(up.p.every((v, k) => Math.abs(v - [12, 0.9, 0][k]) < 1e-6), `with its carriers, 2 m on: ${up.p}`);
  assert.ok(Array.isArray(up.r) && Math.abs(up.r[0]) < 1e-6 && Math.abs(up.r[1]) < 1e-6 && Math.abs(up.r[2] + Math.PI / 2) < 1e-6, `laid flat: ${up.r}`);
  // set down standing at 14 m in the part ending at 4.5 s: until then it is where the carry's last sample has it
  both({ t: 'part', p: { from: T0 + 4e6, to: T0 + 4_500_000, nodes: [{ ...frame, pos: [14_000_000, 0, 0] }], removed: [], samples: [] } });
  const late = step(4.2)!;
  assert.ok(late.p.every((v, k) => Math.abs(v - [14, 0.9, 0][k]) < 1e-6), `still carried: ${late.p}`);
  const down = step(5)!;
  assert.deepEqual(down.p, [14, 0, 0], 'set down');
  assert.deepEqual(down.r, [0, 0, 0], 'stood up again');
  assert.equal(step(6), null, 'and left there');
});
