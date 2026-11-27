// #3178: `act sit:<kind>` as a sit by kind, aimed at the free-slot selector `<kind>@<node>` (`by-kind.mjs`). No world.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { kindNamed, sitByKind } from './by-kind.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;
const ME = id(1);
const rowsOf = (list) => new Map(list.map((r) => [r.id, r]));
const hall = id(10), floor = id(11);
const rows = rowsOf([
  { id: hall, kind: 'eden:room', name: 'the hall' },
  { id: id(2), kind: 'eden:chair', entry: 'eden:chair', name: 'west chair', parent: hall },
  { id: id(3), kind: 'mars:camp_chair', entry: 'eden:chair', name: 'camp chair', parent: hall },
  { id: id(4), kind: 'eden:bench_seat', name: 'bench seat', parent: hall },
  { id: id(5), kind: 'souls:body', soul: ME, name: 'Ada', parent: hall },
]);

test('sit:<kind> is a sit aimed at any free one of that kind in the room the Soul is in', () => {
  assert.deepEqual(sitByKind('sit:chair', { rows, me: ME, ns: 'eden' }), { verb: 'eden:sit', this: `eden:chair@${hall}` });
  assert.deepEqual(sitByKind('sit:eden:bench', { rows, me: ME, ns: 'eden' }), { verb: 'eden:sit', this: `eden:bench@${hall}` });
  // A kind no thing in the copy has goes under the world's namespace; the world names what is free instead.
  assert.equal(sitByKind('sit:pew', { rows, me: ME, ns: 'eden' }).this, `eden:pew@${hall}`);
});

test('a seat named by id, and any other act word, is not a sit by kind', () => {
  for (const w of [`sit:${id(2)}`, 'walk:chair', 'sit', 'sit:', 'sit:two words', 'sit:chair@x', id(2)]) assert.equal(sitByKind(w, { rows, me: ME, ns: 'eden' }), null, w);
});

test('standing on a floor, the selector names the floor, so a seat anywhere on it is found', () => {
  const on = rowsOf([
    { id: floor, kind: 'eden:floor', name: 'ground floor' },
    { id: id(6), kind: 'eden:bench', name: 'bench', parent: floor },
    { id: id(5), kind: 'souls:body', soul: ME, name: 'Ada', parent: floor },
  ]);
  assert.deepEqual(sitByKind('sit:bench', { rows: on, me: ME, ns: 'eden' }), { verb: 'eden:sit', this: `eden:bench@${floor}` });
});

test('a copy that does not place the Soul is refused by name, nothing sent', () => {
  assert.throws(() => sitByKind('sit:chair', { rows: rowsOf([]), me: ME, ns: 'eden' }), { code: 'sit-kind-unplaced' });
});

test('a plain word finds the kind a thing in the copy goes by: its entry first (a Mars chair borrows eden:chair)', () => {
  assert.equal(kindNamed('chair', rows, 'mars'), 'eden:chair');
  assert.equal(kindNamed('bench-seat', rows, 'eden'), 'eden:bench_seat');
  assert.equal(kindNamed('Stool', rows, 'eden'), 'eden:stool');
  assert.equal(kindNamed('mars:camp_chair', rows, 'eden'), 'mars:camp_chair');
});
