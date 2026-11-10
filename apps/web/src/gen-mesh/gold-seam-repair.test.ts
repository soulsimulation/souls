import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { coreLibrary, WorldModel, type Entity } from '@souls/world-compiler';
import { meshFor, type MeshCtx } from './registry.ts';
import { MaterialLib } from './materials.ts';
import './kit.mesh.ts';

test('real registered ceramic builder retains material and replaces dark cracks with golden seams', () => {
  const model = new WorldModel({ constants: { extent: 100, ground: 'land' }, seed: 'restoration' });
  model.library = coreLibrary(); const def = model.library.get('core-gold-seam-station@1')!;
  const materials = new MaterialLib(), gold = new THREE.Color('#e0ad3f'), crack = new THREE.Color('#302a26');
  const draw = (broken: boolean) => {
    const entity: Entity = { id: 'ceramic-render', name: 'artwork', def: def.ref, in: { parent: 'world' }, by: 'test', born: 0, v: 1, state: { broken } };
    const ctx: MeshCtx = { def, entity, params: {}, args: def.make.kind === 'gen' ? def.make.args as Record<string, unknown> : {}, baked: model.bake(def, {}, 0), model, materials, tint: (key, fallback) => key ? def.palette?.[key] ?? fallback : fallback };
    const root = meshFor(def)!.build(ctx)!; let vertices=0, goldVertices=0, crackVertices=0;
    root.traverse(o => { const m=o as THREE.Mesh; if(!m.isMesh)return; const p=m.geometry.attributes.position,c=m.geometry.attributes.color;vertices+=p.count;if(!c)return;for(let i=0;i<c.count;i++){const same=(v:THREE.Color)=>Math.abs(c.getX(i)-v.r)<1e-6&&Math.abs(c.getY(i)-v.g)<1e-6&&Math.abs(c.getZ(i)-v.b)<1e-6;if(same(gold))goldVertices++;if(same(crack))crackVertices++;} });
    return {vertices,goldVertices,crackVertices};
  };
  const raw=draw(true), restored=draw(false);assert.ok(raw.crackVertices>0);assert.equal(raw.goldVertices,0);assert.ok(restored.goldVertices>0);assert.equal(restored.crackVertices,0);assert.equal(restored.vertices,raw.vertices,'same authored bowl and seam topology');assert.deepEqual(draw(true),raw,'state-specific cache remains correct');
});
