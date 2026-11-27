import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge, entityOf } from './bridge.ts';
import { defaultLookOf, entityWithLook, heldEntriesAt } from './take-bodies.ts';
import { setKindFields } from './world-state.ts';
import { chunkOf, TICK_US } from './takes.ts';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { recordedHeldSet } from '../../../../mars/viewer/app/engine-view/held-entry.ts';

const Q = 2 ** 30, T0 = 10_000_000;
const node = (id: string, kind: string, parent: string | null, extra: object = {}) => ({ id, kind, parent, slot: null,
  pos: [0, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], at: null, ...extra });
const world = node('world', 'souls:place@1', null);
const a = node('body-a', 'souls:body@1', world.id, { soul: 'a', at: T0 });
const b = node('body-b', 'souls:body@1', world.id, { soul: 'b', at: T0 });
const entity = (id: string) => entityWithLook(entityOf(id), defaultLookOf(id));
const bowl = node('bowl', 'eden:soup_bowl@aabb', a.id, { slot: 7, pos: [240_001, 980_002, -40_003], rot: [0, 0, Q, 0],
  fields: { 28: 2, 29: 9007199254740993n, 30: { value: 9007199254740995n, per_s: -1, set_us: 10_000_000n }, 31: [[1, 9007199254740997n]], 32: '9007199254740993n' },
  tint: [['shell', 0xe7ddbd]], def: 'soup-bowl@1', params: { label: 'supper' } });
const part = (number: number, nodes: object[] = [], removed: string[] = []) => ({ t: 'part' as const, p: {
  number, from: T0 + number * 500_000, to: T0 + (number + 1) * 500_000, nodes, removed, samples: [] } as never });
const read = (bridge: V2Bridge, seconds: number, id = a.id) => {
  const tick = T0 / TICK_US + seconds / .05;
  const c = bridge.view.takes.chunks.find(c => c.fromTick <= tick && tick < c.toTick);
  assert(c, 'requested historical chunk is retained');
  // The take is serializable even with native large integers/timed/list fields.
  const take = JSON.parse(JSON.stringify(c.take)) as Take;
  return sampleTake(take, (tick - c.fromTick) * .05).entities[entity(id)];
};

test('one held bowl retains identity, exact raw metadata and 2→1→0 contents through transfer, release and seeks', () => {
  setKindFields({ 'eden:soup_bowl': { soup: [28, 'int', 0] } });
  try {
    const bridge = new V2Bridge({ rulesVersion: 'held-test' });
    // Child deliberately precedes both bodies in the first snapshot.
    bridge.receive({ t: 'snapshot', s: { nodes: [world, bowl, b, a], removed: [] } as never });
    const one = { ...bowl, fields: { ...bowl.fields, 28: 1 }, at: T0 - 2_000_000 };
    bridge.receive(part(0, [one]));
    bridge.receive(part(1, [{ ...one, fields: { ...one.fields, 28: 0 } }]));
    bridge.receive(part(2, [{ ...one, parent: b.id, slot: 9, fields: { ...one.fields, 28: 0 } }]));
    bridge.receive(part(3, [{ ...bowl, parent: world.id }]));
    bridge.receive(part(4, [{ ...bowl, parent: a.id, slot: 11 }]));
    bridge.receive(part(5, [], [bowl.id]));
    bridge.receive(part(6, [node('book', 'eden:paperback_book@ccdd', a.id, { slot: 12, fields: { 28: 'open' } })]));
    for (let n = 7; n < 18; n++) bridge.receive(part(n));
    const held = (seconds: number, id = a.id) => {
      const result = recordedHeldSet(read(bridge, seconds, id).state.heldEntries);
      assert(result); return result;
    };
    for (const [seconds, soup] of [[.25, 2], [.5, 1], [.75, 1], [1, 0], [.25, 2]]) {
      const set = held(seconds), entry = set.entries[0];
      assert.equal(entry.id, bowl.id); assert.equal(entry.kind, bowl.kind);
      assert.equal(entry.state?.soup, soup); assert.equal(entry.fields?.['28'], soup);
      assert.deepEqual(entry.pos, bowl.pos); assert.deepEqual(entry.rot, bowl.rot);
      assert.equal(entry.parent, a.id); assert.equal(entry.slot, 7);
      assert.deepEqual(entry.fields?.['29'], { big: '9007199254740993' });
      assert.deepEqual(entry.fields?.['30'], { value: { big: '9007199254740995' }, per_s: -1, set_us: { big: '10000000' } });
      assert.deepEqual(entry.fields?.['31'], [[1, { big: '9007199254740997' }]]);
      assert.equal(entry.fields?.['32'], '9007199254740993n', 'strings are never interpreted as integers');
      assert.deepEqual(entry.tint, bowl.tint); assert.equal(entry.def, bowl.def); assert.deepEqual(entry.params, bowl.params);
    }
    assert.equal(held(.5).observedAt, T0 + 500_000, 'contents are first observed at live part end, never stale motion time');
    assert.deepEqual(held(1.5).entries, []); assert.equal(held(1.5, b.id).entries[0].id, bowl.id);
    assert.equal(held(1.5, b.id).entries[0].slot, 9);
    assert.deepEqual(held(2, b.id).entries, []); assert.deepEqual(held(2).entries, []);
    assert.equal(held(2.5).entries[0].slot, 11, 'rapid re-lift retains its new slot');
    assert.deepEqual(held(3).entries, [], 'removal releases the held entry');
    assert.equal(held(3.5).entries[0].kind, 'eden:paperback_book@ccdd', 'ordinary non-food identity survives');
    assert.deepEqual(read(bridge, .75).p, [0, 0, 0], 'metadata never displaces the authoritative root');
    assert.equal(read(bridge, .75).state.prop, 'plate', 'legacy projection remains compatible');
  } finally { setKindFields({}); }
});

test('snapshots are immutable, and nested contents transfer atomically without flattening their local parent', () => {
  const bridge = new V2Bridge({ rulesVersion: 'held-test' });
  const tray = node('tray', 'eden:tray@abcd', a.id, { slot: 3 });
  const nested = { ...bowl, parent: tray.id, pos: [...bowl.pos], fields: structuredClone(bowl.fields) };
  bridge.receive({ t: 'snapshot', s: { nodes: [nested, tray, a, b, world], removed: [] } as never });
  bridge.receive(part(0));
  nested.fields[28] = 99;
  nested.pos[0] = 999;
  bridge.receive(part(1, [{ ...tray, parent: b.id }]));
  for (let n = 2; n < 12; n++) bridge.receive(part(n));
  const before = recordedHeldSet(read(bridge, .25).state.heldEntries)!;
  assert.equal(before.entries.find(e => e.id === bowl.id)?.fields?.['28'], 2);
  assert.equal(before.entries.find(e => e.id === bowl.id)?.pos[0], 240_001);
  const transferred = recordedHeldSet(read(bridge, 1, b.id).state.heldEntries)!;
  assert.deepEqual(transferred.entries.map(e => e.id), ['bowl', 'tray']);
  assert.equal(transferred.entries[0].parent, tray.id, 'native immediate parent is not replaced with a guessed hand');
  assert.deepEqual(recordedHeldSet(read(bridge, 1).state.heldEntries)?.entries, []);
});

test('history observations, known empty sets and legacy unknown metadata remain distinct across chunk boundaries', () => {
  const sample = recordedHeldSet({ observedAt: 2_000_000, entries: [] })!;
  assert.equal(heldEntriesAt(undefined, 4_000_000), undefined);
  assert.equal(heldEntriesAt([sample], 1_000_000), undefined);
  assert.equal(heldEntriesAt([sample], 2_000_000), sample);
  const body = { entity: 'person', soul: 'soul', name: 'Person', heading: 0, samples: [{ at: 0, p: [0, 0, 0] as [number, number, number] }] };
  const legacy = chunkOf([{ ...body, held: [{ at: 0, prop: 'book' }] }], 80, { rulesVersion: 'held-test', datetime: null });
  const current = chunkOf([{ ...body, heldEntries: [sample] }], 80, { rulesVersion: 'held-test', datetime: null });
  assert.equal(sampleTake(legacy.take as unknown as Take, 0).entities.person.state.heldEntries, undefined);
  assert.deepEqual(sampleTake(current.take as unknown as Take, 0).entities.person.state.heldEntries, sample, 'last observation before this chunk is retained');
  const bridge = new V2Bridge({ rulesVersion: 'held-test' });
  bridge.receive({ t: 'snapshot', s: { nodes: [world, a], removed: [] } as never });
  bridge.receive({ t: 'part', p: { number: 0, from: T0, to: T0, nodes: [bowl], removed: [], samples: [] } as never });
  for (let n = 0; n < 10; n++) bridge.receive(part(n));
  assert.equal(recordedHeldSet(read(bridge, .25).state.heldEntries)?.observedAt, T0, 'zero-span history state is observed at its start');
});
