import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedHeldSet } from './held-entry.ts';

test('held observations preserve zero and native nulls without supplying missing facts', () => {
  const raw = { observedAt: 50_000, entries: [{ id: 'bowl', kind: 'eden:soup_bowl@abc', parent: 'body', slot: null,
    pos: [0, 0, 0], rot: [2 ** 30, 0, 0, 0], fields: { 28: 0 }, state: { soup: 0 } }] };
  const held = recordedHeldSet(JSON.parse(JSON.stringify(raw)))!;
  assert(held); assert.deepEqual(held, raw); assert(Object.isFrozen(held.entries[0].fields));
  raw.entries[0].fields[28] = 2; raw.entries[0].pos[0] = 1000;
  assert.equal(held.entries[0].fields?.['28'], 0); assert.equal(held.entries[0].pos[0], 0);
  assert.equal(recordedHeldSet(undefined), undefined, 'a legacy take does not claim known empty hands');
  assert.deepEqual(recordedHeldSet({ observedAt: 50_000, entries: [] })?.entries, []);
  for (const field of ['id', 'kind', 'parent', 'slot', 'pos', 'rot']) {
    const missing = structuredClone(raw) as { observedAt: number; entries: Record<string, unknown>[] };
    delete missing.entries[0][field]; assert.equal(recordedHeldSet(missing), undefined, field + ' is never guessed');
  }
  const duplicate = { ...raw, entries: [raw.entries[0], raw.entries[0]] };
  assert.equal(recordedHeldSet(duplicate), undefined, 'duplicate identity is not another prop');
});
