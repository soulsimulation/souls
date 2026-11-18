// A role the def's looks table names is posed once, by the table; a role it does not name keeps the legacy state pose.
import test from 'node:test'; import assert from 'node:assert/strict'; import * as THREE from 'three';
import { applyLook } from './vocab-look.ts';
import type { MeshCtx } from './registry.ts';

const part = (role: string) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.userData.role = role; return m; };
function draw(looks_table: unknown[] | undefined) {
  const root = new THREE.Group(), door = part('door'), lid = part('lid'); root.add(door, lid);
  const ctx = { def: { params: {}, state: { open: { type: 'bool', default: false } }, components: {} }, params: {},
    entity: { id: 'chest-1', state: { open: true } }, args: looks_table ? { looks_table } : {}, baked: { box: [1, 1, 1] } } as unknown as MeshCtx;
  applyLook(root, ctx);
  return { door, lid };
}
const deg = (r: number) => Math.round((r * 180) / Math.PI);

test('a role the looks table names is posed once, at the table\'s value; an unnamed role keeps the state pose', () => {
  // the table lifts the lid 50 degrees about x when open; it names no door
  const { door, lid } = draw([{ part: 'lid', field: 'open', do: 'rotate', axis: 'x', at: { true: -50000, false: 0 } }]);
  assert.equal(deg(lid.rotation.x), -50, 'the lid is at the table\'s 50 degrees only, not 108 + 50');
  assert.equal(deg(door.rotation.y), deg(-Math.PI * 0.48), 'the door, not in the table, swings as stateRoles has always drawn it');
});

test('with no looks table every legacy role keeps the state pose', () => {
  const { door, lid } = draw(undefined);
  assert.equal(deg(lid.rotation.x), deg(-Math.PI * 0.6));
  assert.equal(deg(door.rotation.y), deg(-Math.PI * 0.48));
});

test('a pick row\'s parts are the table\'s too', () => {
  const { door, lid } = draw([{ field: 'open', do: 'pick', at: { true: 'door', false: 'lid' } }]);
  assert.equal(door.rotation.y, 0, 'the door is shown by the pick, not swung by stateRoles');
  assert.equal(door.visible, true); assert.equal(lid.visible, false);
});
