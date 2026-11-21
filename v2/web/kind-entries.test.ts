import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindEntryFiles } from './kind-entries.ts';

test('every kind in content/kinds has its drawing file: kind, state fields and looks, nothing else', () => {
  const all = kindEntryFiles();
  assert.ok(all.size > 300, `${all.size} kinds`);
  const lamp = JSON.parse(all.get('eden/desk_lamp.json')!);
  assert.deepEqual(Object.keys(lamp), ['kind', 'state', 'looks']);
  assert.deepEqual(lamp.state, { on: { n: 28, type: 'bool', default: false } });
  assert.equal(lamp.looks.model, 'look:desk_lamp');
  assert.ok(lamp.looks.shape.shapes.length > 0 && lamp.looks.table.length === 2);
  assert.ok(JSON.parse(all.get('eden/planter.json')!).state.water.type === 'timed');
});
