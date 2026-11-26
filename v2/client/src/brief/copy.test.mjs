// The daemon reads its copy as rows after every follow (`hearing`), and a walking body re-hashes itself and the room
// above it at each one. The rows' decoded records must stay those the copy still holds: before this, every version
// of the room stayed decoded and the daemon grew by megabytes a second while one Soul walked, until Node's heap ran
// out (Mars rehearsal, 22 Nov 2026).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { encode } from '../history/day.mjs';
import { allFields, posesOf, rememberPublicWords, rowsOf, wordsOf } from './copy.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const scope = Buffer.from('scope');
const hashOf = (raw) => `1220${createHash('sha256').update(raw).digest('hex')}`;

/** A copy as replica's `Copy` keeps it after a sync: only the records its roots reach. */
function walkingCopy(things) {
  const held = new Map(), put = (m) => { const raw = encode(m), h = hashOf(raw); held.set(h, raw); return h; };
  const children = [];
  for (let i = 0; i < things; i++) {
    children.push(Buffer.from(put(new Map([[1, [scope, 100 + i]], [2, 'eden:chair'], [7, new Map([[2, [i * 1000, 0, 0]]])], [10, []]])), 'hex'));
  }
  let roots = {}, was = [];
  const copy = { roots: () => JSON.stringify(roots), record: (h) => held.get(h) };
  /** One stream part: the body a step on, so it and its room have new hashes, and the old ones are let go. */
  copy.step = (x) => {
    const body = put(new Map([[1, [scope, 2]], [2, 'souls:body'], [3, [scope, 1]], [7, new Map([[2, [x, 0, 0]]])], [10, []]]));
    const room = put(new Map([[1, [scope, 1]], [2, 'eden:place'], [10, [...children, Buffer.from(body, 'hex')]]]));
    for (const h of was) held.delete(h);
    was = [body, room];
    roots = { 0: room };
  };
  return copy;
}

test('rows read after every step of a walk keep the heap flat', () => {
  const copy = walkingCopy(2000);
  copy.step(0);
  rowsOf(copy);
  const before = heap();
  for (let x = 1; x <= 300; x++) { copy.step(x); rowsOf(copy); posesOf(copy); }
  const grew = heap() - before;
  // Every room version kept decoded was about 0.5 MB here (150 MB over the walk); the room's current one is all.
  assert.ok(grew < 10e6, `heap grew ${(grew / 1e6).toFixed(1)} MB over 300 steps`);
  const rows = rowsOf(copy);
  assert.equal(rows.size, 2002);
  assert.deepEqual(rows.get('73636f7065-2').pos, [300, 0, 0], 'the body where its last step put it');
  assert.deepEqual(posesOf(copy).get('73636f7065-101').at, [1, 0, 0]);
});

// #4713: the open ground's terrain tiles are a record of their own, named by the ground's key 0.
test('a node\'s fields read its big field from its own record', () => {
  const held = new Map(), put = (m) => { const raw = encode(m), h = hashOf(raw); held.set(h, raw); return h; };
  const copy = { record: (h) => held.get(h) };
  const tiles = [[0, 0, Buffer.from('heights'), Buffer.from('classes')]];
  const big = put(new Map([[1, [scope, 1]], [5, new Map([[1, 1]])], [6, new Map([[25, tiles]])]]));
  const ground = new Map([[0, [[25, Buffer.from(big, 'hex')]]], [1, [scope, 1]], [6, new Map([[24, 64000]])], [10, []]]);
  const f = allFields(copy, ground);
  assert.equal(f.get(24), 64000);
  assert.deepEqual(f.get(25).map(([x, z]) => [x, z]), [[0, 0]]);
  assert.equal(allFields({ record: () => undefined }, ground).has(25), false, 'not held: left out');
});

// #4837: a book a shelf's take made holds its title and first page as references (fields 29 and 30 of eden:book), and
// the sync answer that brings its record carries their words (key 27). Its row keeps them by field, and its entry
// names them; field 30 is a body's name only on a body, never a book's first page.
test('a held book\'s title and first page are the words the world gave beside its record', () => {
  const held = new Map(), put = (m) => { const raw = encode(m), h = hashOf(raw); held.set(h, raw); return { raw, h }; };
  const ref = (n) => new Map([[21, [scope, n]]]);
  const book = put(new Map([[1, [scope, 9]], [2, 'eden:book@1220ab'], [3, [scope, 2]], [5, new Map([[1, 1]])], [6, new Map([[28, 0], [29, ref(41)], [30, ref(42)]])], [10, []]]));
  const body = put(new Map([[1, [scope, 2]], [2, 'souls:body'], [3, [scope, 1]], [5, new Map([[1, 1]])], [6, new Map([[30, ref(43)]])], [10, [Buffer.from(book.h, 'hex')]]]));
  const room = put(new Map([[1, [scope, 1]], [2, 'eden:place'], [10, [Buffer.from(body.h, 'hex')]]]));
  const copy = { roots: () => JSON.stringify({ 0: room.h }), record: (h) => held.get(h) };
  assert.equal(rowsOf(copy).get('73636f7065-9').words, undefined, 'no words given yet');
  rememberPublicWords(copy, encode(new Map([[22, [book.raw, body.raw]], [27, [
    [[scope, 41], Buffer.from("The Lamplighter's Last Summer")],
    [[scope, 42], Buffer.from('Every evening for forty-one years, Osric Vale had walked the canal path.')],
    [[scope, 43], Buffer.from('Wren')],
  ]]])));
  const rows = rowsOf(copy), row = rows.get('73636f7065-9');
  assert.equal(row.name, 'book 9', 'a book is not named by its first page');
  assert.equal(rows.get('73636f7065-2').name, 'Wren', 'a body is named by its owner\'s words');
  const entry = { state: { open: { n: 28, type: 'bool' }, title: { n: 29, type: 'text' }, first_page: { n: 30, type: 'text' } } };
  assert.deepEqual(wordsOf(row, entry), {
    title: "The Lamplighter's Last Summer",
    first_page: 'Every evening for forty-one years, Osric Vale had walked the canal path.',
  });
  assert.deepEqual(wordsOf(row, undefined), {}, 'no entry: no names for them');
  assert.ok(!Object.keys(row).includes('words'), 'kept off the printed row');
});
