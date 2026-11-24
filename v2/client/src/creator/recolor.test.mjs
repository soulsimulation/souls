// R4 (0.134): `souls-god recolor` reads the thing's tint from the copy, sets the one row and sends the whole field.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { F_TINT, WHOLE, recolorOf, runRecolor, tintRows } from './recolor.mjs';
import { requestOf } from './souls-god.mjs';

test('R4: recolor words make a node, a colour and a part', () => {
  assert.deepEqual(recolorOf(['aa-1', '#FF8800']), { node: 'aa-1', rgb: 0xff8800, part: WHOLE });
  assert.deepEqual(recolorOf(['aa-1', '0000ff', '--part', 'Seat']), { node: 'aa-1', rgb: 0xff, part: 'part:seat' });
  assert.deepEqual(requestOf(['recolor', 'aa-1', '#123456']).recolor, { node: 'aa-1', rgb: 0x123456, part: WHOLE });
  for (const bad of [['aa-1'], ['aa-1', 'red'], ['aa-1', '#12345'], ['aa-1', '#123456', '--part', 'a b']]) assert.throws(() => recolorOf(bad), /recolor <id>/);
});

test('R4: a part\'s row replaces its own and the rows keep one order', () => {
  const held = [['part:seat', 1], [WHOLE, 2]];
  assert.deepEqual(tintRows(held, 'part:seat', 3), [[WHOLE, 2], ['part:seat', 3]]);
  assert.deepEqual(tintRows(undefined, WHOLE, 4), [[WHOLE, 4]]);
  assert.deepEqual(tintRows(held, 'part:arm', 5), [[WHOLE, 2], ['part:arm', 5], ['part:seat', 1]]);
});

test('R4: the recolour is one set of the whole field, read from the copy first', async () => {
  const asked = [];
  const ask = async (r) => { asked.push(r); return r.op === 'fields' ? { ok: true, id: 'aa-1', fields: { [F_TINT]: [[WHOLE, 0xff0000]] } } : { ok: true, sequence: 7 }; };
  const got = await runRecolor({ node: 'aa-1', rgb: 0xff, part: 'part:seat' }, ask);
  assert.deepEqual(asked, [{ op: 'fields', node: 'aa-1' }, { op: 'edit', ops: [{ op: 'set', node: 'aa-1', field: F_TINT, value: [[WHOLE, 0xff0000], ['part:seat', 0xff]] }] }]);
  assert.deepEqual(got, { ok: true, sequence: 7, tint: { '*': '#ff0000', seat: '#0000ff' } });
  const refused = await runRecolor({ node: 'aa-1', rgb: 1, part: WHOLE }, async (r) => (r.op === 'fields' ? { ok: true, fields: {} } : { ok: false, code: 'edit.not-the-creator' }));
  assert.equal(refused.code, 'edit.not-the-creator');
});
