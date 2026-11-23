// D8 (0.132): a stand on my own seated or lying body goes as the holding thing's rise (stand.mjs).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { risesFromSeat } from './stand.mjs';

const kinds = {
  'eden:armchair': { slots: { seat: { admits: 'body', posture: 'sit', most: 1 } } },
  'eden:bed': { slots: { left: { admits: 'body', posture: 'lie' } } },
  'eden:room': {},
};
const rowsWith = (parent) => new Map([
  ['r', { id: 'r', name: 'Reading', kind: 'eden:room', parent: null }],
  ['c', { id: 'c', name: 'armchair', kind: 'eden:armchair', parent: 'r' }],
  ['b', { id: 'b', name: 'bed', kind: 'eden:bed', parent: 'r' }],
  ['body-2', { id: 'body-2', name: 'body 2', kind: 'souls:body', soul: 'soul-7', parent }],
]);
const at = (parent, candidates) => risesFromSeat(candidates, { rows: rowsWith(parent), kinds, me: 'soul-7', ns: 'dev' });

test('D8: a stand on my seated or lying body is the seat\'s or the bed\'s rise; standing, or another\'s, is left alone', () => {
  assert.deepEqual(at('c', [{ verb: 'dev:stand', this: 'body-2', form: 'stand' }]), [{ verb: 'dev:rise', this: 'c' }]);
  assert.deepEqual(at('b', [{ verb: 'stand' }]), [{ verb: 'dev:rise', this: 'b' }], 'a bare stand, lying in a bed');
  const standing = [{ verb: 'dev:stand', this: 'body-2', form: 'stand' }];
  assert.equal(at('r', standing), standing, 'standing in the room: unchanged');
  const other = [{ verb: 'dev:stand', this: 'body-9', form: 'stand' }];
  assert.deepEqual(at('c', other), other, 'another body\'s stand: unchanged');
  const sit = [{ verb: 'dev:sit', this: 'c', form: 'sit' }];
  assert.equal(at('c', sit), sit, 'no stand: unchanged');
});
