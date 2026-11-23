// X1 (0.134): copied from v2/web/src/source/changed.test.ts, so the old page's stream reader needs nothing from v2/web.
// A part that changes a whole world's nodes is read from one snapshot, not one whole-state query per node (#3687:
// full Eden's first part changes about ten thousand nodes and the page never drew).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BULK, readChanged } from './changed.ts';

const world = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`n${i}`, { id: `n${i}` }]));

function counted(live: Map<string, { id: string }>) {
  const calls = { one: 0, snapshot: 0 };
  const one = (id: string) => { calls.one++; const v = live.get(id); if (!v) throw new Error('gone'); return v; };
  const snapshot = () => { calls.snapshot++; return live; };
  return { calls, one, snapshot };
}

test('a part changing ten thousand nodes reads one snapshot and no node queries', () => {
  const live = world(10_000);
  const ids = [...live.keys(), 'gone1'];
  const { calls, one, snapshot } = counted(live);
  const r = readChanged(ids, (id) => id, one, snapshot, (v) => v.id);
  assert.deepEqual(calls, { one: 0, snapshot: 1 });
  assert.equal(r.nodes.length, 10_000);
  assert.deepEqual(r.removed, ['gone1']);
});

test('a small part queries each changed node and lists the ones no longer live as removed', () => {
  const live = world(5);
  const { calls, one, snapshot } = counted(live);
  const r = readChanged(['n1', 'n3', 'x'], (id) => id, one, snapshot, (v) => v.id);
  assert.deepEqual(calls, { one: 3, snapshot: 0 });
  assert.deepEqual(r, { nodes: ['n1', 'n3'], removed: ['x'] });
});

test('both paths give the same nodes and removals', () => {
  const live = world(BULK * 2);
  const ids = [...live.keys()].filter((_, i) => i % 2 === 0).concat(['a', 'b']);
  const big = readChanged(ids, (id) => id, counted(live).one, counted(live).snapshot, (v) => v.id);
  const small = { nodes: [] as string[], removed: [] as string[] };
  for (let i = 0; i < ids.length; i += BULK) {
    const r = readChanged(ids.slice(i, i + BULK), (id) => id, counted(live).one, counted(live).snapshot, (v) => v.id);
    small.nodes.push(...r.nodes); small.removed.push(...r.removed);
  }
  assert.ok(ids.length > BULK);
  assert.deepEqual(big, small);
});
