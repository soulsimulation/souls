// A creator's roads and areas (#3728): the place a shape makes, with no daemon.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ribbon, shapeOf, shapeOps } from './shapes.mjs';

test('a road along a line: its line, width and the ribbon outline the page drapes', () => {
  const out = shapeOps('eden:footpath', { path: '[[0,0],[10,0]]', width: '3' }, 'g-1');
  assert.equal(out.ops.length, 1);
  const o = out.ops[0];
  assert.deepEqual([o.op, o.kind, o.in, o.atUm, o.support], ['place', 'eden:footpath', 'g-1', [0, 0, 0], { which: 1, node: 'g-1', height: 0 }]);
  assert.deepEqual(o.fields[16], [[0, 0], [10000, 0]]);
  assert.equal(o.fields[17], 3000);
  assert.deepEqual(o.fields[11], [[0, 1500], [10000, 1500], [10000, -1500], [0, -1500]]);
  assert.deepEqual(ribbon([[0, 0], [0, 4]], 2), [[-1, 0], [-1, 4], [1, 4], [1, 0]]);
});

test('areas by --area, --rect and --circle; a named area is derived from one; refusals by name', () => {
  assert.deepEqual(shapeOps('eden:lawn', { rect: '10,20,4,2' }, 'g').ops[0].fields, { 11: [[8000, 19000], [12000, 19000], [12000, 21000], [8000, 21000]] });
  assert.equal(shapeOf({ circle: '0,0,5' }).area.length, 24);
  const place = shapeOps('eden:place@1', { area: '[[0,0],[5,0],[5,5]]', in: 'p-2', fields: { 15: 'eden:plaza' } }, 'g');
  assert.equal(place.ops[0].in, 'p-2');
  assert.deepEqual([place.ops[0].fields[15], place.ops[0].fields[20]], ['eden:plaza', 'eden:area']);
  assert.equal(shapeOps('eden:lawn', { area: '[[0,0],[1,1]]' }, 'g').code, 'shape.flag');
  assert.equal(shapeOps('eden:lawn', { rect: '1,2,3' }, 'g').code, 'shape.flag');
  assert.equal(shapeOps('eden:lawn', { rect: '1,2,3,4', width: '2' }, 'g').code, 'shape.flag');
  assert.equal(shapeOps('eden:lawn', { rect: '1,2,3,4', area: '[]' }, 'g').code, 'shape.flag');
  assert.equal(shapeOps('eden:lawn', { rect: '1,2,3,4' }, null).code, 'shape.no-ground');
});
