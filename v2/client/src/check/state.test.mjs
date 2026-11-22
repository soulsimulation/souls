// A text field as the rules read it from the copy: its words' reference once written, null once cleared, so a need on
// `is: null` / `not: null` tells written from cleared (found by #3911: both read `{}` before).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encode } from '../history/day.mjs';
import { stateOf } from './state.mjs';

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
