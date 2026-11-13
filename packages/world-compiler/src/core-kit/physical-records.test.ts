import test from 'node:test';
import assert from 'node:assert/strict';
import { kitWhen } from '@souls/generators';
import { PHYSICAL_RECORD_PLAYER, PHYSICAL_RECORD_PLAYER_V1 } from './physical-records.ts';
test('loaded physical record uses supported state equality; old revision remains unchanged', () => {
  const shapes = (PHYSICAL_RECORD_PLAYER.make as any).args.shapes;
  const material = shapes.filter((shape: any) => shape.tint === 'vinyl' || shape.tint === 'label' && shape.when === '@loaded=1');
  assert.equal(material.length, 2);
  for (const shape of material) {
    assert.equal(kitWhen(shape.when, {}, {loaded: 0}), false);
    assert.equal(kitWhen(shape.when, {}, {loaded: 1}), true);
  }
  assert.equal(PHYSICAL_RECORD_PLAYER.version, 2);
  assert.equal(PHYSICAL_RECORD_PLAYER_V1.version, 1);
  assert.equal((PHYSICAL_RECORD_PLAYER_V1.make as any).args.shapes.filter((shape: any) => shape.when === '@loaded==1').length, 2);
});
