// R8b: one thing as a creator reads it (thing.mjs), from the copy's describe and fields answers and the kinds' entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeThing } from './thing.mjs';

const d = {
  nodes: [
    { id: 'aa-0', kind: 'souls:place', parent: null },
    { id: 'aa-1', kind: 'eden:cottage', parent: 'aa-0', at: [44000, 2369, 10000], text: 'Rose cottage' },
    { id: 'aa-2', kind: 'eden:table', parent: 'aa-1', at: [0, 0, 5000], yaw: 90000, marks: { owner: 's_x-1', access: 2 } },
    { id: 'aa-3', kind: 'eden:cup', parent: 'aa-2', at: [0, 0, 0], slot: 1 },
    { id: 'aa-4', kind: 'eden:cup', parent: 'aa-2', at: [100, 0, 0] },
  ],
  kinds: { 'eden:table@1220ab': { admits: ['thing'], slots: { 1: { admits: 'thing' }, 2: { admits: 'thing' } } } },
};
const entries = { 'eden:table': { format: 'souls-entry/1', kind: 'eden:table', state: { clean: { n: 28, type: 'bool' } }, text: { card: 'A wooden table.' } } };

test('describe <id>: its kind and card, each frame it is in, its spot, its fields by name, its slots and holds, its marks', () => {
  const t = describeThing('aa-2', d, { 28: true, 7: 3 }, entries);
  assert.equal(t.ok, true);
  assert.equal(t.card, 'A wooden table.');
  assert.deepEqual(t.in, [{ id: 'aa-1', kind: 'eden:cottage', text: 'Rose cottage' }, { id: 'aa-0', kind: 'souls:place' }]);
  assert.deepEqual([t.at, t.yaw], [[0, 0, 5000], 90000]);
  assert.deepEqual(t.fields, { clean: true, 7: 3 }, 'a state field by its name; any other number stays a number');
  assert.deepEqual(t.slots, { 1: { admits: 'thing', holds: ['aa-3'] }, 2: { admits: 'thing', holds: [] } });
  assert.deepEqual(t.holds, [{ id: 'aa-3', kind: 'eden:cup', slot: 1 }, { id: 'aa-4', kind: 'eden:cup' }]);
  assert.deepEqual(t.marks, { owner: 's_x-1', access: 2 });
  assert.equal(describeThing('zz-9', d, {}).code, 'edit.node-missing');
  assert.equal(describeThing('aa-4', d, {}).card, undefined, 'no entry kept: no card, nothing invented');
});
