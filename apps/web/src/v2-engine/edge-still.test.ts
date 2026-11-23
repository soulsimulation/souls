// B2-4: world diffs and speech share the page's edge log; a world already still when the page opens is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { BEHIND_US, CHUNK, V2Bridge } from './bridge.ts';
import { TICK_US, TICKS } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';
import { EdgeLog, WorldState, type LayerLike } from './world-state.ts';

test('a door update survives a speech update in the same step and after, until the layer applies it', () => {
  const ws = new WorldState(), log = new EdgeLog();
  // the layer holds the diff (its tick is ahead of the picture: applyEdge waits), so its seq does not move
  const layer: LayerLike = { seq: 4, model: { entities: new Map([['e_door', { id: 'e_door', state: { open: false } }]]) } };
  ws.receive({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes: [{ id: 'd.1', kind: 'eden:door', parent: 'w.1', origin: 'e_door', fields: { 6: 1 } }], removed: [] } } as never);
  const said1 = [{ type: 'edge', kind: 'speech', id: 'v2:1', text: 'Hello.' }], said2 = [...said1, { type: 'edge', kind: 'speech', id: 'v2:2', text: 'Time for a nap.' }];
  const door = ws.next(layer, 0)!;
  // one step: the door's diff and a new line of speech together
  let edge = log.step(said1, door);
  assert.ok(edge.includes(door) && edge.includes(said1[0]));
  // the next steps: the speech grows, no new diff (the same seq is sent once): the door's is still there
  assert.equal(ws.next(layer, 0), null);
  edge = log.step(said2, null);
  assert.ok(edge.includes(door), 'the door\'s diff is not dropped when the speech changes');
  assert.deepEqual(edge.filter((m) => (m as { kind: string }).kind === 'speech'), said2);
  assert.equal(log.step(said2, null), edge, 'nothing new: the same log (the page re-reads nothing)');
});

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const E = entityWithLook('v2_b_7', defaultLookOf('b.7'));
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = { id: 'b.7', kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [3_000_000, 0, 4_000_000], rot: [Q, 0, 0, 0], at: T0 - 60_000_000, soul: 'soul-abc-7', name: 'Ada' };
const pointer = (quietUntil: number | null) => ({ t: 'pointer' as const, p: { newest: null, newestTo: null, period: 500_000, anchorWorld: T0, anchorWallMs: 0, quietUntil } });

test('a world already still when the page opens is drawn from its first quiet time: its Souls where they are', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  // no part is played (the world has written none since), only the quiet time, every half second
  const q = T0 + 10_250_000;
  b.receive(pointer(q));
  const end = Math.floor((q - BEHIND_US) / TICK_US / CHUNK) * CHUNK; // B3-4's lag and half-second chunks
  assert.equal(b.view.takes.serverTick, end, 'the current chunk is made at once');
  assert.deepEqual(b.view.takes.chunks.map((c) => [c.fromTick, c.toTick]), [[end - CHUNK, end]], 'one chunk, once');
  const take = b.view.takes.chunks[0].take as unknown as Take;
  assert.deepEqual(sampleTake(take, 0).entities[E].p.map((x) => +x.toFixed(3)), [3, 0, 4], 'standing where its record has it');
  assert.deepEqual([...b.view.souls.keys()], ['s_abc-7']);
  // the quiet time moving on makes the chunks after it, as a moving world's parts do
  b.receive(pointer(q + 1_000_000));
  assert.equal(b.view.takes.serverTick, end + TICKS);
});
