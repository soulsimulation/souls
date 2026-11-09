import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import { WorldModel, coreLibrary, coreRef, applyBatch, type Entity } from '@souls/world-compiler';
import { StreamRing } from '../../StreamRing.ts';
import { instanceable } from '../../EntityInstancer.ts';
import { findAnchors } from '../../atmosphere/finder.ts';
import { hasFlames, flameStats } from '../../fx/flames.ts';
import '../kit.mesh.ts';

type Drawn = { obj: THREE.Object3D; inst?: string };
type Inner = { model: WorldModel; ring: StreamRing; now: number; drawn: Map<string, Drawn>; draw(e: Entity, ease: boolean, force?: boolean): void };

test('two real incense redraws retain distinct rotated smoke anchors through on/off/on changes', async t => {
  const globals = globalThis as unknown as { location?: URL }, previousLocation = globals.location;
  globals.location = new URL('https://example.invalid/w/fixture'); t.after(() => { globals.location = previousLocation; });
  // Keep the real generic builder and entity-layer draw/instancer path, without loading unrelated browser builders.
  const index = new URL('../index.ts', import.meta.url).href;
  const hook = registerHooks({ load(url, context, next) { return url === index ? { format: 'module', shortCircuit: true, source: "export { meshFor } from './registry.ts';" } : next(url, context); } });
  const { WorldEntityLayer } = await import('../../WorldEntityLayer.ts').finally(() => hook.deregister());
  const layer = new WorldEntityLayer(p => p), inner = layer as unknown as Inner;
  t.after(() => layer.dispose());
  const model = inner.model = new WorldModel({ constants: { ground: 'land', extent: 1000 }, seed: 'incense-smoke' }); model.library = coreLibrary();
  const act = (ops: unknown[]) => { const r = applyBatch(model, { ops }, 'god', 1); assert.equal(r.result.accepted, true, JSON.stringify(r.result)); };
  act([{ op: 'place', def: coreRef('incense-censer', 1), name: 'east', p: [3, 2], r: 0.6 }, { op: 'place', def: coreRef('incense-censer', 1), name: 'west', p: [-4, -1], r: -0.9 }]);
  inner.ring = new StreamRing({ inner: 100, outer: 150 }); inner.ring.update(0, 0); inner.now = 1000;
  layer.active = true; layer.motionInstancing = false;
  const scene = new THREE.Scene(); scene.add(layer.group);
  const east = model.get('east')!.id, west = model.get('west')!.id, mountedBefore = flameStats.mounted;
  assert.equal(hasFlames(model.resolvedDef(model.get('east')!.def)!), false, 'incense is not classified as a flame');
  const redraw = (id: string, on: boolean) => { act([{ op: 'set', id, state: { on } }]); inner.draw(model.entities.get(id)!, false, true); };
  const check = (on: string[]) => {
    const sources = findAnchors(scene, () => false, false).smoke;
    assert.equal(sources.length, on.length, 'no stale or duplicated plume anchors');
    const expected = on.map(id => {
      const pose = model.worldPose(model.entities.get(id)!);
      return new THREE.Vector3(pose.x + 0.025 * Math.cos(pose.yaw) + 0.02 * Math.sin(pose.yaw), pose.y + 1.132, pose.z - 0.025 * Math.sin(pose.yaw) + 0.02 * Math.cos(pose.yaw));
    });
    for (const p of expected) assert.equal(sources.filter(s => s.p.distanceTo(p) < 1e-6).length, 1, 'one smoke anchor at each actual rotated tip');
    for (const id of [east, west]) {
      const drawn = inner.drawn.get(id)!;
      assert.equal(instanceable(drawn.obj), !on.includes(id), 'the predicate accepts ordinary geometry and preserves burning smoke anchors');
      // Existing look policy gives an off censer no instance key; the smoke guard keeps a lit censer individual.
      assert.equal(drawn.inst, undefined, 'both states draw individually for their respective existing look or smoke requirement');
    }
    assert.equal(flameStats.mounted, mountedBefore, 'no flame effect is substituted for smoke');
  };
  redraw(east, false); redraw(west, false); check([]);
  redraw(east, true); check([east]);
  redraw(west, true); check([east, west]);
  redraw(east, false); check([west]);
  redraw(east, true); check([east, west]);
  redraw(west, false); check([east]);
  redraw(east, false); check([]);
});
