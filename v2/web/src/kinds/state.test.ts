// A node's kind state, from its field map (record key 6) and its kind's entry (#3871).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fieldsOf, kindState, type StateDef } from './state.ts';

const entry = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../../content/kinds', path), 'utf8')) as { state: Record<string, StateDef> };

test('the worker keeps the plain fields: numbers, texts and timed values; bytes, references and rows are left out', () => {
  const f = new Map<number, unknown>([
    [1, new Uint8Array([1, 2])], [12, [[0, 0, 1, 1, 0, 0, 10]]], [30, new Map([[21, [new Uint8Array(16), 1]]])],
    [28, true], [29, 'sprout'], [31, 3n], [33, [400000, -5, 7000000n]], [34, 2n ** 60n],
  ]);
  assert.deepEqual(fieldsOf(f), { 28: 1, 29: 'sprout', 31: 3, 33: { value: 400000, per_s: -5, set_us: 7000000 }, 34: 2n ** 60n });
  assert.equal(fieldsOf(new Map([[1, new Uint8Array(0)]])), undefined);
});

test('a lamp reads on and off from field 28; with nothing held, its default', () => {
  const lamp = entry('lights/desk_lamp.json').state;
  assert.deepEqual(kindState({ 28: 1 }, lamp), { on: true });
  assert.deepEqual(kindState({ 28: 0 }, lamp), { on: false });
  assert.deepEqual(kindState(undefined, lamp), { on: false });
});

test('a planter: an enum by its value, counts as numbers, its water read at the world time drawn', () => {
  const planter = entry('garden/planter.json').state;
  const fields = { 28: { value: 400000, per_s: -5, set_us: 10_000_000 }, 29: 'leafy', 31: 2 };
  const at = (now: number) => kindState(fields, planter, now);
  assert.equal(at(10_000_000).water, 400000);
  assert.equal(at(20_000_000).water, 399950, 'five milligrams a second for ten seconds');
  assert.equal(at(10_000_000 + 80_000 * 1_000_000).water, 0, 'held at its min');
  assert.equal(at(5_000_000).water, 400000, 'a viewer behind the time it was set draws it as set');
  assert.equal(at(10_000_000).stage, 'leafy');
  assert.equal(at(10_000_000).fruit, 2);
  assert.equal(at(10_000_000).weeds, true, 'unset: the default');
  assert.deepEqual(kindState(fields, planter).water, fields[28], 'no time yet: the stored numbers');
});
