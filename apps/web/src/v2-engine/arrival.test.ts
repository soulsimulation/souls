// B3-5: a Soul's body born on the open ground, as the reader hands it on (its node, with its Soul from the public
// body-of link, in the part that made it), is in the page's Souls from that part, under its Soul's page id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge } from './bridge.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const node = (id: string, parent: string | null, kind: string, extra: object = {}) => ({ id, kind, parent, slot: null, pos: [0, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], at: null, ...extra });
const part = (n: number, nodes: object[] = [], samples: [string, string, number | null, number, number, number, number][] = []) =>
  ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes, removed: [], samples } });

test('B3-5: a body born on the ground is in the page\'s Souls from the part that made it, by its Soul\'s id', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  // the public copy as a new page gets it: the place and its open ground (the snapshot), then a still world's parts
  b.receive({ t: 'snapshot', s: { nodes: [node('w.0', null, 'souls:place@1'), node('w.1', 'w.0', 'eden:ground@1')], removed: [] } });
  for (let n = 0; n < 4; n++) b.receive(part(n));
  assert.equal(b.view.souls.size, 0);
  // the birth: the body's node on the ground with its Soul, posed, and its first step in the next part
  b.receive(part(4, [node('b.9', 'w.1', 'souls:body@1', { pos: [2_000_000, 0, 3_000_000], at: T0 + 2_000_000, soul: 'soul-abcd-0' })]));
  assert.deepEqual([...b.view.souls.keys()], ['s_abcd-0'], 'listed from the birth\'s own part');
  b.receive(part(5, [], [['b.9', 'w.1', null, T0 + 2_700_000, 2_300_000, 0, 3_000_000]]));
  for (let n = 6; n < 12; n++) b.receive(part(n)); // the world goes on: the chunks the page plays catch up to the birth
  assert.equal(b.view.unplaced, 0, 'placed on the ground, never hidden');
  assert.ok(b.view.takes.chunks.some((c) => Object.values((c.take as { finalState: { entities: Record<string, { human?: { soul?: string } }> } }).finalState.entities).some((e) => e.human?.soul === 's_abcd-0')), 'in a chunk the page plays');
});
