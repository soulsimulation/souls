// #5006: `souls-god arrival <place> | --clear` names where new Souls arrive, as a set on the world's root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL, arrivalOps, placesOf } from './world.mjs';
import { worldVerbOf } from './souls-god.mjs';

const scope = 'ab'.repeat(16);
const id = (n) => `${scope}-${n}`;
const ref = (n) => [Uint8Array.from(Buffer.from(scope, 'hex')), n];
/** A node record as the copy decodes it: its kind (key 2), parent (key 3) and fields (key 6). */
const node = (parent, fields, kind = 'eden:thing@1220ab') => new Map([[2, kind], ...(parent === null ? [] : [[3, ref(parent)]]), [6, new Map(Object.entries(fields).map(([k, v]) => [Number(k), v]))]]);

// The root (1), the open ground (2), the build site (3, an area with its facts id), a path (4, a line), a
// bench on the ground (5, no outline) and a room's outline under a building (6 under 5).
const found = {
  root: id(1),
  ground: { id: id(2) },
  nodes: new Map([
    [id(1), node(null, {})],
    [id(2), node(1, {}, 'eden:ground@1220cd')],
    [id(3), node(2, { 1: Buffer.from('site'), 11: [[62000, -27000], [68000, -27000], [68000, -21000], [62000, -21000]] })],
    [id(4), node(2, { 16: [[0, 0], [10000, -4000]] })],
    [id(5), node(2, {})],
    [id(6), node(5, { 11: [[0, 0], [4000, 4000]] })],
  ]),
};

test('the places are the open ground\'s areas and lines, each at the middle of its box', () => {
  assert.deepEqual(placesOf(found), [
    { id: id(3), origin: 'site', at: [65000, -24000] },
    { id: id(4), origin: null, at: [5000, -2000] },
  ]);
});

test('arrival names a place by its id or its facts id, as the place\'s id on the world\'s root', () => {
  const want = [{ op: 'set', node: id(1), field: ARRIVAL, value: [{ hex: scope }, 3] }];
  for (const place of [id(3), 'site']) {
    const a = arrivalOps(found, { place });
    assert.deepEqual(a.ops, want);
    assert.match(a.says, /new Souls arrive at site \(65, -24 m\)/);
  }
  assert.deepEqual(arrivalOps(found, { place: id(4) }).ops[0].value, [{ hex: scope }, 4]);
});

test('an unknown place, a thing or a room is refused by name, listing places; --clear sets none', () => {
  for (const place of ['nowhere', id(5), id(6)]) {
    const r = arrivalOps(found, { place });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'arrival.unknown-place');
    assert.match(r.detail, /site/);
  }
  assert.deepEqual(arrivalOps(found, { clear: true }).ops, [{ op: 'set', node: id(1), field: ARRIVAL, value: [] }]);
  assert.equal(arrivalOps({ ...found, root: null }, { clear: true }).code, 'arrival.no-world');
});

test('the verb reads one place or --clear', () => {
  assert.deepEqual(worldVerbOf('arrival', ['site']), { verb: 'arrival', place: 'site' });
  assert.deepEqual(worldVerbOf('arrival', ['--clear']), { verb: 'arrival', clear: true });
  assert.throws(() => worldVerbOf('arrival', []), /arrival <place id> \| --clear/);
  assert.throws(() => worldVerbOf('arrival', ['a', 'b']), /arrival <place id>/);
});
