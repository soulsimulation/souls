// A form's thing argument left out is chosen by its selector as worldd's `select_thing` chooses it (#3914).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectThing } from './rules.ts';

const state = {
  actor: 'me',
  nodes: {
    room: { children: ['me', 'kit', 'a', 'b', 'c', 'other'] },
    me: { hands: {}, at_mm: [0, 0, 0] },
    other: { hands: {}, at_mm: [1, 0, 0] },
    kit: { kind: 'test:kit', at_mm: [5000, 0, 0] },
    a: { kind: 'test:x', at_mm: [300, 0, 0] },
    b: { kind: 'test:y', at_mm: [100, 0, 0] },
    c: { kind: 'test:x', at_mm: [900, 0, 0] },
  },
};
const sel = (o: Record<string, unknown>) => ({ of: 'things', in: 'here', anchor: 'me', order: 'nearest', rank: 1, ...o });

test('a thing selector: nearest, furthest, rank, last and kind; never a body or the act\'s node', () => {
  assert.equal(selectThing(sel({}), 'kit', state), 'b');
  assert.equal(selectThing(sel({ rank: 2 }), 'kit', state), 'a');
  assert.equal(selectThing(sel({ order: 'furthest' }), 'kit', state), 'c');
  assert.equal(selectThing(sel({ rank: 'last' }), 'kit', state), 'c');
  assert.equal(selectThing(sel({ kind: 'test:x' }), 'kit', state), 'a');
  assert.equal(selectThing(sel({ anchor: 'this', order: 'furthest' }), 'kit', state), 'b');
  assert.equal(selectThing(sel({ in: 'parent' }), 'kit', state), 'b');
  assert.equal(selectThing(sel({ kind: 'test:none' }), 'kit', state), null);
  assert.equal(selectThing(sel({ rank: 9 }), 'kit', state), null);
  assert.equal(selectThing(sel({ in: 'this' }), 'kit', state), null);
  assert.equal(selectThing({ of: 'free_slots' }, 'kit', state), undefined);
});
