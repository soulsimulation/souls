// 0.135 E14b: a slot of another thing as an act's argument, read from the act's words, checked by "Can I?" (R2's
// rules in replica's WASM build, when it is built) and turned into its wire form.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SEEN_ALL, judge } from './check.mjs';
import { otherSlot, slotsOf } from './other-slot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const entry = (p) => JSON.parse(readFileSync(join(root, 'content/kinds', p), 'utf8'));
const LECTURE = entry('hall/lecture.json'), BENCH = entry('seating/bench.json');
const kinds = { [LECTURE.kind]: LECTURE, [BENCH.kind]: BENCH };
const lecture = `${'0a'.repeat(16)}-1`, bench = `${'0a'.repeat(16)}-2`, other = `${'0a'.repeat(16)}-3`;
const rows = new Map([[lecture, { kind: LECTURE.kind }], [bench, { kind: BENCH.kind }]]);

test('E14b: <thing id>/<slot> names a slot of another thing, by name or number, and goes as its number', () => {
  assert.deepEqual(otherSlot(`${bench}/right`, kinds, rows), { node: bench, slot: 'right' });
  assert.deepEqual(otherSlot(`${bench}/1`, kinds, rows), { node: bench, slot: 'left' });
  assert.deepEqual(otherSlot(`${other}/2`, kinds, rows), { node: other, slot: 2 }, 'a kind the copy lacks: by number');
  assert.equal(otherSlot(bench, kinds, rows), null);
  assert.equal(otherSlot('top', kinds, rows), null);
  assert.throws(() => otherSlot(`${bench}/middle`, kinds, rows), (e) => e.code === 'act-slot-unknown' && /left, right/.test(e.message));
  assert.throws(() => otherSlot(`${other}/left`, kinds, rows), (e) => e.code === 'act-slot-unknown');
  assert.throws(() => otherSlot(`${bench}/0`, kinds, rows), (e) => e.code === 'act-slot-unknown');
  const pairs = [['seat', { node: bench, slot: 'right' }], ['words', { 23: 'hello' }], ['item', other], ['n', 2]];
  assert.deepEqual(slotsOf(pairs, kinds, rows), [['seat', { node: bench, slot: 2 }], ['words', { 23: 'hello' }], ['item', other], ['n', 2]]);
});

const pkg = join(root, 'v2/target/wasm-load/pkg');
test('E14b: "Can I?" checks a seat on another thing as the world does', { skip: !existsSync(join(pkg, 'replica_bg.wasm')) && 'replica WASM not built' }, async () => {
  const r = await import(pathToFileURL(join(pkg, 'replica.js')).href);
  r.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
  const state = (held) => ({ actor: 'me', nodes: { me: { hands: {} }, [lecture]: { kind: LECTURE.kind }, [bench]: { kind: BENCH.kind, slots: { left: held, right: [] } } } });
  const c = { verb: 'eden:attend', this: lecture, form: 'attend', args: { seat: otherSlot(`${bench}/left`, kinds, rows) } };
  assert.equal(judge(r.rules_decide, c, { kinds, state: state([]), asker: { sees: [] }, seen: SEEN_ALL }).verdict, 'yes');
  const taken = judge(r.rules_decide, c, { kinds, state: state(['them']), asker: { sees: [] }, seen: SEEN_ALL });
  assert.equal(taken.verdict, 'no');
  assert.equal(taken.reason, 'slot_taken');
  assert.deepEqual(taken.detail, { node: bench, slot: 'left' });
});
