import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F_DEFAULT_FAMILY, defaultFamilyOf, resourcesOf } from './family-record.ts';

const KIND = 'souls:body@1220aa';
const res = (name: string, cls: number, slot?: number) => new Map<number, unknown>([[1, name], [2, cls], ...(slot === undefined ? [] : [[3, slot] as [number, unknown]])]);
const held = (kind: unknown, list: unknown) => new Map<number, unknown>([[F_DEFAULT_FAMILY, new Map<number, unknown>([[1, kind], [2, list]])]]);
const HUMAN = [res('souls:leg-left', 1), res('souls:leg-right', 1), res('souls:hand-left', 2, 1), res('souls:hand-right', 2, 2n as unknown as number), res('souls:eyes', 3), res('souls:voice', 4)];

test('the world node\'s default family is read whole: its kind and each resource with its class and slot', () => {
  const f = defaultFamilyOf(held(KIND, HUMAN));
  assert.equal(f?.kind, KIND);
  assert.deepEqual(f?.resources.filter((r) => r.class === 2), [{ name: 'souls:hand-left', class: 2, slot: 1 }, { name: 'souls:hand-right', class: 2, slot: 2 }]);
  assert.deepEqual(f?.resources.filter((r) => r.class !== 2).map((r) => r.slot), [undefined, undefined, undefined, undefined]);
});

test('a node without the field, or with a malformed one, gives none', () => {
  assert.equal(defaultFamilyOf(new Map()), undefined);
  assert.equal(defaultFamilyOf(held(7, HUMAN)), undefined);
  assert.equal(defaultFamilyOf(held(KIND, [res('a', 5)])), undefined, 'an unknown class');
  assert.equal(defaultFamilyOf(held(KIND, [res('a', 1, 1)])), undefined, 'a slot on a leg');
  assert.equal(defaultFamilyOf(held(KIND, [res('a', 2, 1), res('a', 2, 2)])), undefined, 'two of one name');
  assert.equal(defaultFamilyOf(new Map([[F_DEFAULT_FAMILY, new Map<number, unknown>([[1, KIND], [2, []], [3, 0]])]])), undefined, 'an unknown key');
});

test('explicit body selection comes first; the default family speaks only for its own exact kind', () => {
  const f = defaultFamilyOf(held(KIND, HUMAN));
  assert.equal(resourcesOf({ kind: KIND }, f)?.length, 6);
  assert.equal(resourcesOf({ kind: KIND, body: 'ab'.repeat(32) }, f), null, 'a worn catalogue body is its own kind file\'s');
  assert.equal(resourcesOf({ kind: 'souls:body@1220bb' }, f), null, 'another revision');
  assert.equal(resourcesOf({ kind: KIND }, undefined), null);
});
