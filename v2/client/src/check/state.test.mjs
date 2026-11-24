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
import { rowsOf } from '../brief/copy.mjs';
import { definedIn, kindsIn, stateOf } from './state.mjs';

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

test('D8, D10: a body a seat or a bed holds has that slot\'s posture, over a written stand; one standing, or with another written posture, keeps its own', () => {
  const body = { format: 'souls-entry/1', kind: 'test:body', owner: 'thing', state: { posture: { n: 28, type: 'enum', values: ['stand', 'sit', 'lie', 'kneel'], default: 'stand' } } };
  const kinds = {
    'test:body': body,
    'test:chair': { slots: { seat: { admits: 'body', posture: 'sit', most: 1 } } },
    'test:bed': { slots: { left: { admits: 'body', posture: 'lie' }, right: { admits: 'body', posture: 'lie' } } },
    'test:room': {},
  };
  const node = (k, kind, parent, fields, children) => encode(new Map([[1, [scope, k]], [2, kind], ...(parent ? [[3, [scope, parent]]] : []), [6, new Map(fields ?? [])], ...(children ? [[10, children]] : [])]));
  const records = {
    a1: node(2, 'test:chair@1220aa', 1, [], [Buffer.from('b2', 'hex')]),
    b2: node(3, 'test:body@1220bb', 2),
    c3: node(4, 'test:bed@1220cc', 1, [], [Buffer.from('d4', 'hex')]),
    d4: node(5, 'test:body@1220bb', 4),
    e5: node(6, 'test:body@1220bb', 1),
    f6: node(7, 'test:body@1220bb', 2, [[28, 'souls:stand']]),
    aa: node(8, 'test:body@1220bb', 4, [[28, 'souls:kneel']]),
  };
  records.root = node(1, 'test:room@1220dd', null, [], ['a1', 'c3', 'e5', 'f6', 'aa'].map((h) => Buffer.from(h, 'hex')));
  const copy = { roots: () => JSON.stringify({ x: 'root' }), record: (h) => records[h] ?? null };
  const nodes = stateOf(copy, kinds, 'me').nodes, at = (k) => nodes[`${'ab'.repeat(16)}-${k}`];
  assert.equal(at(3).fields?.posture, 'sit', 'seated in the chair');
  assert.equal(at(5).fields?.posture, 'lie', 'lying in the bed');
  assert.equal(at(6).fields?.posture, undefined, 'standing in the room: the entry\'s default');
  // D10: a rise wrote `stand`; the seat's own sit after it wrote no posture: seated in the chair, it is the seat's.
  assert.equal(at(7).fields?.posture, 'sit', 'a written stand under a seat is the seat\'s posture');
  assert.equal(at(8).fields?.posture, 'kneel', 'any other posture the world wrote is kept');
  // G-late: with a memo the second walk reads no record and the seat's posture is still the slot's, not carried over.
  const memo = {};
  assert.deepEqual(stateOf(copy, kinds, 'me', memo), stateOf(copy, kinds, 'me'));
  assert.deepEqual(stateOf(copy, kinds, 'me', memo).nodes, nodes);
});

test('G-late: with a memo, a walk reads again only the records a sync changed, and its state is the one a walk without it gives', () => {
  const node = (k, n, children) => encode(new Map([[1, [scope, k]], [2, 'test:board@1220aa'], [6, new Map([[4, n]])], ...(children ? [[10, children]] : [])]));
  const records = { a1: node(2, 1), b2: node(3, 2) };
  records.r0 = node(1, 0, ['a1', 'b2'].map((h) => Buffer.from(h, 'hex')));
  let root = 'r0';
  const reads = [];
  const copy = { roots: () => JSON.stringify({ x: root }), record: (h) => { reads.push(h); return records[h] ?? null; } };
  const memo = {};
  const first = stateOf(copy, kinds, 'me', memo);
  assert.deepEqual(reads.sort(), ['a1', 'b2', 'r0']);
  reads.length = 0;
  assert.deepEqual(stateOf(copy, kinds, 'me', memo), first, 'unchanged: the same state');
  assert.deepEqual(reads, [], 'and no record read again');
  // A sync changes one child: a new record under a new hash, and so a new root.
  records.c3 = node(3, 5);
  records.r1 = node(1, 0, ['a1', 'c3'].map((h) => Buffer.from(h, 'hex')));
  root = 'r1';
  const after = stateOf(copy, kinds, 'me', memo);
  assert.deepEqual(reads.sort(), ['c3', 'r1'], 'only the changed records are read');
  assert.deepEqual(after, stateOf({ roots: copy.roots, record: (h) => records[h] ?? null }, kinds, 'me'), 'the same state as a walk with no memo');
  assert.equal(after.nodes[`${'ab'.repeat(16)}-3`].fields.count, 5);
  // Other kinds: every record is read again.
  reads.length = 0;
  stateOf(copy, { ...kinds }, 'me', memo);
  assert.deepEqual(reads.sort(), ['a1', 'c3', 'r1']);
});
