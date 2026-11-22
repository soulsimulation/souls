// #3699 (A1): a creator's `about` sets a place's title and aliases as words the world keeps for everyone; a Soul's
// copy names the place by them once the words come beside its record (key 27), and `find` matches the aliases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encode } from '../history/day.mjs';
import { rememberPublicNames, rememberPublicWords, rowsOf } from '../brief/copy.mjs';
import { find } from '../find/find.mjs';
import { aboutOps, requestOf } from './souls-god.mjs';

test('about makes set operations: title and aliases as words, --set as today, --clear', () => {
  assert.deepEqual(aboutOps(['aa-3', '--title', 'The Old Mill', '--alias', 'mill', '--alias', 'grain house']), [
    { op: 'set', node: 'aa-3', field: 4, value: { words: 'The Old Mill' } },
    { op: 'set', node: 'aa-3', field: 101, value: { words: 'mill\ngrain house' } },
  ]);
  assert.deepEqual(aboutOps(['aa-3', '--set', '{"title":"Mill","aliases":[]}']), [
    { op: 'set', node: 'aa-3', field: 4, value: { words: 'Mill' } },
    { op: 'set', node: 'aa-3', field: 101, value: false },
  ]);
  assert.deepEqual(aboutOps(['aa-3', '--clear']).map((o) => o.value), [false, false]);
  assert.deepEqual(requestOf(['about', 'aa-3', '--alias', 'mill']).req, { op: 'edit', ops: [{ op: 'set', node: 'aa-3', field: 101, value: { words: 'mill' } }] });
  assert.equal(requestOf(['check', 'about', 'aa-3', '--title', 'Mill']).req.op, 'check');
  for (const bad of [['aa-3'], ['aa-3', '--title', 'a\nb'], ['aa-3', '--clear', '--title', 'x'], ['aa-3', '--set', '{"what":"x"}'], ['--title', 'x']]) {
    assert.throws(() => aboutOps(bad), (e) => e.code === 'usage');
  }
});

const scope = Buffer.from('scope');
const digest = (s) => createHash('sha256').update(s).digest();
function place(counter, fields) {
  const raw = encode(new Map([[1, [scope, counter]], [2, 'eden:place'], [5, new Map([[1, 1]])], [6, new Map(fields)], [10, []]]));
  return { raw, hash: `1220${digest(raw).toString('hex')}` };
}
const held = (all) => ({ roots: () => JSON.stringify(Object.fromEntries([...all.keys()].map((h, i) => [i, h]))), record: (h) => all.get(h) });
const ref = (n) => new Map([[21, [scope, n]]]);

test('a title minted after pairing names the row; its aliases reach find', () => {
  // Named at import: a public name's hash, with its bytes beside the record (key 26).
  const before = place(1, [[4, digest('West Lake')]]), all = new Map([[before.hash, before.raw]]), copy = held(all);
  rememberPublicNames(copy, encode(new Map([[22, [before.raw]], [26, [[digest('West Lake'), Buffer.from('West Lake')]]]])));
  assert.equal(rowsOf(copy).get('73636f7065-1').name, 'West Lake');
  // The creator's about: the record now holds references, and the sync answer that brings it carries their words.
  const after = place(1, [[4, ref(7)], [101, ref(8)]]);
  all.clear(); all.set(after.hash, after.raw);
  assert.equal(rowsOf(copy).get('73636f7065-1').name, 'place 1', 'no words yet: the plain name');
  rememberPublicWords(copy, encode(new Map([[22, [after.raw]], [27, [[[scope, 7], Buffer.from('The Old Mill')], [[scope, 8], Buffer.from('mill\ngrain house')]]]])));
  const row = rowsOf(copy).get('73636f7065-1');
  assert.equal(row.name, 'The Old Mill');
  assert.deepEqual(row.aliases, ['mill', 'grain house']);
  assert.equal(find(rowsOf(copy).values(), 'old mill').found[0]?.id, row.id);
  assert.equal(find(rowsOf(copy).values(), 'grain house').found[0]?.id, row.id);
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
});
