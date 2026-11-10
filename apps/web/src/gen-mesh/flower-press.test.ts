import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { coreLibrary, WorldModel, type Entity } from '@souls/world-compiler';
import { meshFor, type MeshCtx } from './registry.ts';
import { MaterialLib } from './materials.ts';
import './kit.mesh.ts';

test('the real registered press builder preserves botanical material while flattening its relief', () => {
  const model = new WorldModel({ constants: { extent: 100, ground: 'land' }, seed: 'botanical-art' });
  model.library = coreLibrary();
  const def = model.library.get('core-flower-press@1')!;
  const materials = new MaterialLib();
  const draw = (pressed: boolean) => {
    const entity: Entity = { id: 'press-render', name: 'press', def: def.ref, in: { parent: 'world' }, by: 'test', born: 0, v: 1, state: { open: true, pressed } };
    const ctx: MeshCtx = { def, entity, params: {}, args: def.make.kind === 'gen' ? def.make.args as Record<string, unknown> : {}, baked: model.bake(def, {}, 0), model, materials, tint: (key, fallback) => key ? def.palette?.[key] ?? fallback : fallback };
    const root = meshFor(def)!.build(ctx)!;
    root.updateMatrixWorld(true);
    const petal = new THREE.Box3(); let vertices = 0;
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const p = mesh.geometry.attributes.position, c = mesh.geometry.attributes.color;
      if (!c) return;
      for (let i = 0; i < p.count; i++) {
        // The actual purple glaze distinguishes the botanical material from wood, paper and brass.
        if (c.getX(i) > c.getY(i) && c.getZ(i) > c.getY(i)) {
          petal.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld)); vertices++;
        }
      }
    });
    assert.ok(vertices > 0, 'flower material remains visible');
    return { min: petal.min.z, max: petal.max.z, vertices };
  };
  const raw = draw(false), pressed = draw(true), rawAgain = draw(false);
  assert.equal(pressed.vertices, raw.vertices, 'material is preserved rather than disappearing');
  assert.ok(pressed.max - pressed.min < raw.max - raw.min, 'pressed material has thinner actual geometry');
  assert.ok(pressed.max < raw.max, 'pressed relief lies against the backing paper');
  assert.deepEqual(rawAgain, raw, 'the renderer cache retains distinct raw and preserved forms');
});
