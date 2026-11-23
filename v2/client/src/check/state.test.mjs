// The client's copy as the rules read it (state.mjs).
// A text field as the rules read it from the copy: its words' reference once written, null once cleared, so a need on
// `is: null` / `not: null` tells written from cleared (found by #3911: both read `{}` before).
// E21 (#2791): the client's kinds give a Soul's own body kind its family's forms, by the same rule as replica's
// `kinds::entry::family_forms` (v2/crates/replica/tests/family_forms.rs, on the same entries).
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode } from '../history/day.mjs';
import { kindsIn, stateOf } from './state.mjs';

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

const HUMANOID = new URL('../../../../content/kinds/body/humanoid.json', import.meta.url);
const LAMP = { format: 'souls-entry/1', kind: 'eden:lamp', owner: 'thing', forms: {} };

function folder(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kinds-'));
  copyFileSync(HUMANOID, join(dir, 'humanoid.json'));
  writeFileSync(join(dir, 'lamp.json'), JSON.stringify(LAMP));
  for (const [f, e] of Object.entries(extra)) writeFileSync(join(dir, f), JSON.stringify(e));
  return dir;
}

test('a body with no entry gets the family forms', () => {
  const dir = folder();
  try {
    const k = kindsIn(dir, 'souls:body');
    assert.equal(k['souls:body'].kind, 'souls:body');
    for (const f of ['wave', 'bow', 'go_to', 'look_at', 'point', 'touch', 'lean_on', 'wait_by']) assert.ok(k['souls:body'].forms[f], f);
    assert.equal(k['eden:humanoid'].kind, 'eden:humanoid');
    assert.equal(kindsIn(dir)['souls:body'], undefined, 'no body named: nothing added');
  } finally { rmSync(dir, { recursive: true }); }
});

test('a body with its own entry, or two families, is left alone', () => {
  let dir = folder({ 'body.json': { format: 'souls-entry/1', kind: 'souls:body', forms: {} } });
  try { assert.deepEqual(kindsIn(dir, 'souls:body')['souls:body'].forms, {}); } finally { rmSync(dir, { recursive: true }); }
  dir = folder({ 'q.json': { format: 'souls-entry/1', kind: 'eden:quadruped', owner: 'family', forms: {} } });
  try { assert.equal(kindsIn(dir, 'souls:body')['souls:body'], undefined); } finally { rmSync(dir, { recursive: true }); }
});
