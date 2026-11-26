// The ported scoring (Engine v2 R7, #2701): catalog.mjs's cases, on the copy's rows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { INDEX_SLICE, find, kindWordsOf, nameIn, placeName, score, tokensOf } from './find.mjs';

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
  assert.equal(r.found[0].in, 'Reading Room, Eden Library, Eden Village');
  assert.equal(find(rows, 'bench').found[0].id, 'e_b1');
});

test('one search over whatever the copy holds: a set of ids narrows it, nothing else does', () => {
  assert.deepEqual(find(rows, 'library').found.map((r) => r.id).slice(0, 2), ['g-annex', 'g-library']);
  assert.deepEqual(find(rows, 'library', { within: new Set(['g-library']) }).found.map((r) => r.id), ['g-library']);
  assert.deepEqual(find(rows, 'the').found, [], 'stop words alone find nothing');
});

test('a joined body keeps its Soul and parent through the search projection', () => {
  const body = { ...row('body-1', 'body 1', 'souls:body'), soul: 'soul-1', parent: 'ground-1' };
  assert.deepEqual(find([body], 'body').found[0], { id: body.id, name: body.name, kind: body.kind, soul: body.soul, parent: body.parent, in: 'World' });
});

test('first-day E5: equal matches nearest first, each with its metres from the asker, anywhere in the world', () => {
  const far = { ...row('b-far', 'library-book', 'eden:book'), m: 400 }, near = { ...row('b-near', 'cottage-book', 'eden:book'), m: 12.4 };
  const shelf = { ...row('s', 'cottage-bookcase', 'eden:bookcase'), m: 3 };
  const r = find([far, near, shelf], 'book', { metres: (x) => x.m });
  assert.deepEqual(r.found.map((x) => [x.id, x.metres]), [['s', 3], ['b-near', 12], ['b-far', 400]]);
  assert.equal(find([far], 'book').found[0].metres, undefined, 'no asker: no metres');
});

test('a place by its names, never the copy\'s nameless kind-and-number ones', () => {
  assert.equal(placeName(['place 0', 'ground 1', 'eden-house-1', 'floor 844', 'Living']), 'Living, eden-house-1');
  assert.equal(placeName(['place 0', 'ground 1']), 'ground 1, place 0');
});

test('a kind entry\'s category, synonyms and forms find its things, below every name', () => {
  const piano = { card: { category: 'instrument', synonyms: ['keys'] }, text: { keys: 'keyboard' }, forms: { play: {} } };
  assert.deepEqual(kindWordsOf(piano), ['instrument', 'keyboard', 'play']);
  const rows2 = [row('p', 'hall-piano', 'eden:piano'), row('i', 'instrument-shop', 'eden:shop')];
  const kinds = { 'eden:piano': piano };
  assert.deepEqual(find(rows2, 'instrument', { kinds }).found.map((x) => x.id), ['i', 'p']);
  assert.deepEqual(find(rows2, 'instrument').found.map((x) => x.id), ['i'], 'without the entries, names alone');
});

/** The turns of the loop an index of `n` rows takes to build. */
const built = async (n) => { for (let i = 0; i <= Math.ceil(n / INDEX_SLICE); i++) await new Promise(setImmediate); };

test('#5010 follow-up: a find on the copy\'s rows by id reads only the rows its words can hit, not every row', async () => {
  // Eden's 9,588 rows were all scored at every find. Each row here counts the reads of its fields.
  let reads = 0;
  const counted = (r) => new Proxy(r, { get: (o, k) => { reads++; return o[k]; } });
  const many = new Map([...rows, ...Array.from({ length: 2000 }, (_, i) => row(`t${i}`, `tree ${i}`, 'eden:tree'))].map((r) => [r.id, counted(r)]));
  const kinds = { 'core-chair': { card: { category: 'furniture' } } };
  const first = find(many, 'chair', { kinds }); // answered row by row while the index is built, a slice a turn
  await built(many.size);
  reads = 0;
  const r = find(many, 'chair', { kinds });
  assert.deepEqual(r, first, 'the same answer before the index and from it');
  assert.equal(r.found.length, 8);
  assert.ok(reads < 200, `${reads} reads of the rows' fields for 12 chairs among ${many.size} rows`);
  reads = 0;
  assert.equal(find(many, 'furniture', { kinds }).found.length, 8, 'a kind\'s words are searched too');
  assert.ok(reads < 200, `${reads} reads`);
});

test('a find on a Map of rows finds what a find on the same rows as a list does, as the rows change', async () => {
  const piano = { card: { category: 'instrument', synonyms: ['keys'] }, text: { keys: 'keyboard' }, forms: { play: {} } };
  const kinds = { 'eden:piano': piano };
  let list = [...rows, row('p', 'hall-piano', 'eden:piano'), row('i', 'instrument-shop', 'eden:shop'), { ...row('a', 'Old Mill', 'place'), aliases: ['grain house'] }];
  const asks = ['library', 'eden library', 'libraries', 'librar', 'chair', 'chairs 3', 'eden house 3 kitchen', 'north door eden house 3 kitchen',
    'instrument', 'keyboard', 'play', 'grain house', 'mill', 'g', 'core', 'bench seat', 'house', 'room', 'reading', 'nothing here'];
  const same = (why) => {
    const map = new Map(list.map((r) => [r.id, r]));
    for (const words of asks) for (const opts of [{ kinds }, {}, { kinds, within: new Set(['g-library', 'p', 'e_c3']) }, { kinds, limit: 50, metres: (x) => x.id.length }]) {
      assert.deepEqual(find(map, words, opts), find(list, words, opts), `${why}: "${words}" ${JSON.stringify(Object.keys(opts))}`);
    }
  };
  same('first');
  // A sync changes some rows (a new row object for a changed node), adds some and lets some go; the rest are the same.
  list = list.map((r) => (r.id === 'g-annex' ? { ...r, name: 'Campus Piano Annex' } : r)).filter((r) => r.id !== 'g-reading');
  list.push(row('n', 'new library', 'building'), row('e_c3', 'library/chair-3', 'core-chair'));
  list = list.filter((r, k) => list.findIndex((x) => x.id === r.id) === k);
  same('after a change');
  same('again, unchanged');
});
