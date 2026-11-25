// #4784: the captured-state seeding sets only fields the world never set, to what the capture says, and nothing twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturedValue, entryStates, seedOps } from './seed-captured-state.mjs';

const hex = (t) => ({ hex: Buffer.from(t).toString('hex') });
const states = entryStates();

test('the content kinds give the fields a capture seeds: the entries block only', () => {
  assert.deepEqual(states['eden:campfire'], { lit: { n: 28, type: 'bool', max: undefined, dflt: 0 } });
  assert.equal(states['eden:floor_lamp'].level.max, 3);
  assert.equal(states['eden:door'], undefined, 'a door\'s open is field 6: the import\'s own');
  assert.equal(capturedValue({ on: true }, 'lit', { type: 'bool' }), 1);
  assert.equal(capturedValue({ on: true }, 'level', { type: 'int', max: 3 }), 3);
  assert.equal(capturedValue({ broken: false }, 'level', { type: 'int', max: 3 }), undefined);
});

test('lamps on and fires lit where never set; a field a Soul set is left; a second run sends nothing', () => {
  const world = { nodes: [
    { id: 'a-1', kind: 'eden:floor_lamp@12', fields: { 1: hex('e_lamp1') } },
    { id: 'a-2', kind: 'eden:floor_lamp@12', fields: { 1: hex('e_lamp2'), 28: 0 } },   // switched off by a Soul
    { id: 'a-3', kind: 'eden:campfire@12', fields: { 1: hex('e_fire') } },
    { id: 'a-4', kind: 'eden:lamp_post@12', fields: { 1: hex('e_post') } },             // on by its default already
    { id: 'a-5', kind: 'mars:chair@12', fields: { 1: hex('e_lamp3'), 27: 'eden:floor_lamp' } },
  ] };
  const captured = new Map([['e_lamp1', { on: true }], ['e_lamp2', { on: true }], ['e_fire', { lit: true }], ['e_post', { on: true }], ['e_lamp3', { on: true }]]);
  const { ops, byKind } = seedOps(world, captured, states);
  assert.deepEqual(ops, [
    { op: 'set', node: 'a-1', field: 28, value: 3 },
    { op: 'set', node: 'a-3', field: 28, value: 1 },
    { op: 'set', node: 'a-5', field: 28, value: 3 },
  ]);
  assert.deepEqual(byKind, { 'eden:floor_lamp.level=3': 2, 'eden:campfire.lit=1': 1 });
  for (const o of ops) world.nodes.find((n) => n.id === o.node).fields[o.field] = o.value;
  assert.deepEqual(seedOps(world, captured, states).ops, [], 'idempotent');
});
