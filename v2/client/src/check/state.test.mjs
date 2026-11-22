// A text field as the rules read it from the copy: its words' reference once written, null once cleared, so a need on
// `is: null` / `not: null` tells written from cleared (found by #3911: both read `{}` before).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encode } from '../history/day.mjs';
import { rowsOf } from '../brief/copy.mjs';
import { definedIn, stateOf } from './state.mjs';

const scope = Uint8Array.from(Buffer.from('ab'.repeat(16), 'hex'));
const kinds = { 'test:board': { state: { words: { n: 3, type: 'text', default: null }, count: { n: 4, type: 'int', default: 0 } } } };
/** A copy of one board node whose field 3 (`words`) is `words` and field 4 is 2. */
function copyOf(words) {
  const record = encode(new Map([[1, [scope, 7]], [2, 'test:board@1220aa'], [6, new Map([[3, words], [4, 2]])]]));
  return { roots: () => JSON.stringify({ x: 'h' }), record: (h) => (h === 'h' ? record : null) };
}

test('a written text field reads its reference; a cleared one reads null; other fields as before', () => {
  const written = stateOf(copyOf(new Map([[21, [scope, 9]]])), kinds, 'me').nodes[`${'ab'.repeat(16)}-7`];
  const cleared = stateOf(copyOf(new Map()), kinds, 'me').nodes[`${'ab'.repeat(16)}-7`];
  assert.equal(written.fields.words, `${'ab'.repeat(16)}-9`);
  assert.equal(cleared.fields.words, null);
  assert.notDeepEqual(written.fields, cleared.fields, 'written and cleared differ');
  assert.equal(written.fields.count, 2);
});

test('#3697: two revisions of a creator kind keep their own records, by full name', () => {
  const rec = (n) => Buffer.from(JSON.stringify({ format: 'souls-entry/1', kind: 'gene:pod', owner: 'thing', state: { ripe: { n, type: 'int', default: 0 } } }));
  const node = (k, kind, fields, children) => encode(new Map([[1, [scope, k]], [2, kind], [6, new Map(fields)], ...(children ? [[10, children]] : [])]));
  const records = {
    a1: node(2, 'souls:kind@1220kk', [[1, 'gene:pod@1220aa'], [2, rec(3)]]),
    b2: node(3, 'souls:kind@1220kk', [[1, 'gene:pod@1220bb'], [2, rec(4)]]),
    c3: node(4, 'gene:pod@1220aa', [[3, 7], [4, 9]]),
  };
  records.root = node(1, 'souls:place@1220pp', [], ['a1', 'b2', 'c3'].map((h) => Buffer.from(h, 'hex')));
  const copy = { roots: () => JSON.stringify({ x: 'root' }), record: (h) => records[h] ?? null };
  const held = definedIn(copy);
  assert.equal(held['gene:pod@1220aa'].state.ripe.n, 3);
  assert.equal(held['gene:pod@1220bb'].state.ripe.n, 4);
  assert.equal(held['gene:pod'], undefined, 'the plain name finds neither while two revisions are defined');
  const thing = stateOf(copy, held, 'me').nodes[`${'ab'.repeat(16)}-4`];
  assert.equal(thing.fields.ripe, 7, "read by its own revision's numbering (field 3), not the other's (field 4)");
  assert.equal(rowsOf(copy).get(`${'ab'.repeat(16)}-4`).entry, 'gene:pod@1220aa');
});
