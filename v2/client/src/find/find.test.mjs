// The ported scoring (Engine v2 R7, #2701): catalog.mjs's cases, on the copy's rows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { find, nameIn, score, tokensOf } from './find.mjs';

const row = (id, name, kind, path = ['World']) => ({ id, name, kind, path });
const rows = [
  row('g-village', 'Eden Village', 'district'),
  row('g-library', 'Eden Library', 'building', ['World', 'Eden Village']),
  row('g-reading', 'Reading Room', 'room', ['World', 'Eden Village', 'Eden Library']),
  row('g-annex', 'Campus Library Annex', 'building'),
  row('g-house-3', 'Eden House 3', 'building'),
  row('g-house-3-kitchen', 'Eden House 3 Kitchen', 'room', ['World', 'Eden House 3']),
  row('g-house-3-study', 'Eden House 3 Study', 'room', ['World', 'Eden House 3']),
  row('e_b1', 'promenade-bench-1', 'core-bench-seat'),
  ...Array.from({ length: 12 }, (_, i) => row(`e_c${i}`, `library/chair-${i}`, 'core-chair', ['World', 'Eden Village', 'Eden Library', 'Reading Room'])),
];

test('the words: lower case, split on what is not a letter or digit, stop words dropped', () => {
  assert.deepEqual(tokensOf('Go to the Eden Library!'), ['eden', 'library']);
});

test('a word scores in the name, then the id, then the kind; a row missing a word scores nothing', () => {
  const f = { name: ['eden', 'library'], id: ['g', 'library'], kind: ['building'] };
  assert.equal(score(['library'], f), 5);
  assert.equal(score(['building'], f), 2);
  assert.equal(score(['eden', 'library'], f), 16, 'the whole name adds 6');
  assert.equal(score(['eden', 'kitchen'], f), 0);
  assert.equal(score(['librar'], f), 5, 'a start of four letters or more');
  assert.equal(score(['li'], f), 0, 'not shorter');
  assert.equal(score(['libraries'], f), 5, 'a plural by its stem');
});

test('#2274: the full name first, then the longest name the words hold whole, then the rest', () => {
  assert.equal(nameIn(['north', 'door', 'eden', 'house', '3', 'kitchen'], ['eden', 'house', '3']), 3);
  const names = (words) => find(rows, words).found.map((r) => r.name);
  assert.deepEqual(names('eden house 3 kitchen').slice(0, 2), ['Eden House 3 Kitchen', 'Eden House 3']);
  assert.deepEqual(names('the north door of Eden House 3 Kitchen').slice(0, 2), ['Eden House 3 Kitchen', 'Eden House 3']);
  assert.equal(names('eden house 3')[0], 'Eden House 3');
});

test('a kind finds its things; the limit cuts, and says how many more', () => {
  const r = find(rows, 'chairs', { limit: 5 });
  assert.equal(r.found.length, 5);
  assert.equal(r.more, 7);
  assert.deepEqual(r.found.map((x) => x.name), ['library/chair-0', 'library/chair-1', 'library/chair-2', 'library/chair-3', 'library/chair-4']);
  assert.equal(r.found[0].in, 'Reading Room, Eden Library');
  assert.equal(find(rows, 'bench').found[0].id, 'e_b1');
});

test('one search over whatever the copy holds: a set of ids narrows it, nothing else does', () => {
  assert.deepEqual(find(rows, 'library').found.map((r) => r.id).slice(0, 2), ['g-annex', 'g-library']);
  assert.deepEqual(find(rows, 'library', { within: new Set(['g-library']) }).found.map((r) => r.id), ['g-library']);
  assert.deepEqual(find(rows, 'the').found, [], 'stop words alone find nothing');
});
