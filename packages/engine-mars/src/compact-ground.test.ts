// #1325: a compaction (the living day's `compact: true`, logged by a fresh world at tick 2 and by every world at first
// light) builds a fresh Runtime. On a ground/1 world it must keep the terrain as the constructor does: the first Soul
// placed after it used to throw in spawnHuman (`reading 'field'` of an unattached ground), and live and a restore from
// the post-compaction snapshot walked on different ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { groundFact, groundField } from './ground-bridge.ts';
import { emptyGround } from '../../ground/src/index.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
const hill = () => { const g = emptyGround(256); g.landforms.push({ id: 'knoll', kind: 'bump', c: [0, 0], r: 12, h: 2, peak: 1 }); return groundFact(g, 1, { paged: true }); };

test('a Soul placed after a compaction stands on the ground/1 terrain, with no engine fault', () => {
  const fact = hill(), field = groundField(fact.recipeHash);
  const e = factory.create(factory.genesis('compact-ground-birth')) as MarsEngine;
  e.installGroundV1(fact);
  e.step(); e.step();
  e.compact();
  e.spawnHuman({ id: 'h_ada', label: 'Ada', soul: 's_ada' });
  const p = e.world.entities.h_ada.pose.p;
  assert.equal(p[1], field.height(p[0], p[2]), `Ada stands on the terrain: ${p}`);
  assert.ok(p[1] > 0.5, `on the knoll, not on flat ground: ${p}`);
  for (let i = 0; i < 20; i++) e.step();
  assert.deepEqual(e.runtime.violations, []);
});

test('after a compaction, the live engine walks on the same ground as a restore from its snapshot', () => {
  const e = factory.create(factory.genesis('compact-ground-walk')) as MarsEngine;
  e.installGroundV1(hill());
  e.spawnHuman({ id: 'h_ada', label: 'Ada', soul: 's_ada' });
  e.step();
  e.compact();
  const restored = factory.restore(e.snapshot()) as MarsEngine;
  for (const w of [e, restored]) assert.equal(w.perform({ actor: 'h_ada', label: 'over the knoll', steps: [{ verb: 'walk_to', params: { to: [20, 3] } }] }).ok, true);
  for (let i = 0; i < 200; i++) { e.step(); restored.step(); }
  assert.equal(e.stateHash(), restored.stateHash());
  assert.deepEqual(e.runtime.violations, []);
});
