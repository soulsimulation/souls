import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { WorldModel, coreLibrary, coreRef, applyBatch, type Entity } from '@souls/world-compiler';
import { StreamRing } from '../../StreamRing.ts';
import { instanceable } from '../../EntityInstancer.ts';
import { findAnchors } from '../../atmosphere/finder.ts';
import { MAX_SMOKE_SOURCES, SMOKE_PER_SOURCE } from '../../atmosphere/particles.ts';
import { hasFlames, flameStats } from '../../fx/flames.ts';
import '../kit.mesh.ts';

type Drawn = { obj: THREE.Object3D; inst?: string };
type Inner = { model: WorldModel; ring: StreamRing; now: number; drawn: Map<string, Drawn>; draw(e: Entity, ease: boolean, force?: boolean): void; unload(id: string): void };

async function runtime() {
  // Keep the real generic builder and entity-layer draw/instancer path, without loading unrelated browser builders.
  const index = new URL('../index.ts', import.meta.url).href;
  const transform = new Set(['../../world-env.ts', '../../WorldGeometry.ts'].map(path => new URL(path, import.meta.url).href));
  const hook = registerHooks({ load(url, context, next) {
    if (url === index) return { format: 'module', shortCircuit: true, source: "export { meshFor } from './registry.ts';" };
    if (transform.has(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  } });
  const { WorldEntityLayer } = await import('../../WorldEntityLayer.ts');
  const { createWorldAtmosphere } = await import('../../WorldAtmosphere.ts').finally(() => hook.deregister());
  return { WorldEntityLayer, createWorldAtmosphere };
}

test('the real entity registry resolves declared smokeScale defaults and keeps numeric overrides in distinct kit prototypes', async t => {
  const globals = globalThis as unknown as { location?: URL }, previousLocation = globals.location;
  globals.location = new URL('https://example.invalid/w/fixture'); t.after(() => { globals.location = previousLocation; });
  const { WorldEntityLayer } = await runtime();
  const layer = new WorldEntityLayer(p => p), inner = layer as unknown as Inner; t.after(() => layer.dispose());
  const model = inner.model = new WorldModel({ constants: { ground: 'land', extent: 1000 }, seed: 'incense-scale' }); model.library = coreLibrary();
  const placed = applyBatch(model, { ops: [{ op: 'place', def: coreRef('incense-censer', 1), name: 'default', p: [0, 0], state: { on: true } },
    { op: 'place', def: coreRef('incense-censer', 1), name: 'override', p: [3, 0], state: { on: true }, params: { smokeScale: .3 } }] }, 'god', 1);
  assert.equal(placed.result.accepted, true, JSON.stringify(placed.result));
  inner.ring = new StreamRing({ inner: 100, outer: 150 }); inner.ring.update(0, 0); inner.now = 1000; layer.active = true; layer.motionInstancing = false;
  const ordinary = model.get('default')!, changed = model.get('override')!;
  assert.equal(ordinary.params?.smokeScale, .15, 'admission resolves the declared default without a placement override');
  const read = (entity: Entity) => { inner.draw(entity, false, true); return inner.drawn.get(entity.id)!.obj.userData.edenSmokeSources as number[][]; };
  assert.deepEqual(read({ ...ordinary, params: {} }), [[.025, 1.132, .02, .6 * .15]], 'WorldEntityLayer also supplies def defaults when the entity has no stored override');
  assert.deepEqual(read(changed), [[.025, 1.132, .02, .6 * .3]], 'the existing numeric cache key separates the override');
  assert.deepEqual(read(ordinary), [[.025, 1.132, .02, .6 * .15]], 'overridden prototype does not contaminate the default');
});

test('actual atmosphere refreshes rotated incense smoke on redraw, removal and attachment between mature scans', async t => {
  const globals = globalThis as unknown as { location?: URL }, previousLocation = globals.location;
  globals.location = new URL('https://example.invalid/w/fixture'); t.after(() => { globals.location = previousLocation; });
  const { WorldEntityLayer, createWorldAtmosphere } = await runtime();
  const layer = new WorldEntityLayer(p => p), inner = layer as unknown as Inner;
  t.after(() => layer.dispose());
  const model = inner.model = new WorldModel({ constants: { ground: 'land', extent: 1000 }, seed: 'incense-smoke' }); model.library = coreLibrary();
  const act = (ops: unknown[]) => { const r = applyBatch(model, { ops }, 'god', 1); assert.equal(r.result.accepted, true, JSON.stringify(r.result)); };
  act([{ op: 'place', def: coreRef('incense-censer', 1), name: 'east', p: [3, 2], r: 0.6 }, { op: 'place', def: coreRef('incense-censer', 1), name: 'west', p: [-4, -1], r: -0.9 }]);
  inner.ring = new StreamRing({ inner: 100, outer: 150 }); inner.ring.update(0, 0); inner.now = 1000;
  layer.active = true; layer.motionInstancing = false;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#bbddff');
  const atmosphere = createWorldAtmosphere(scene), camera = new THREE.PerspectiveCamera();
  t.after(() => atmosphere.dispose());
  const frame = (seconds: number) => atmosphere.update({ seconds, dt: .01, clock: '2026-11-09T12:00:00', daylight: 1, camera, eden: true, profile: 'world', reducedMotion: false, weather: { kind: 'clear', clouds: 0, rain: 0, wind: 0, fog: 0, intensity: 0 } });
  for (const seconds of [0, 1.5, 5, 12, 25, 45]) frame(seconds);
  assert.equal(atmosphere.inspect().smokeSources, 0, 'mature scan starts with no known publishers');
  let scans = atmosphere.inspect().scans;
  const smoke = scene.getObjectByName('atmosphere: chimney smoke') as THREE.Points<THREE.BufferGeometry>;
  let seconds = 45;
  // Initial attachment after all startup scans must discover sources before the next scan at 75.
  scene.add(layer.group);
  const east = model.get('east')!.id, west = model.get('west')!.id, mountedBefore = flameStats.mounted;
  assert.equal(hasFlames(model.resolvedDef(model.get('east')!.def)!), false, 'incense is not classified as a flame');
  const redraw = (id: string, on: boolean) => { act([{ op: 'set', id, state: { on } }]); inner.draw(model.entities.get(id)!, false, true); };
  const check = (on: string[]) => {
    frame(seconds += .01);
    assert.equal(atmosphere.inspect().scans, scans, 'state changes do not trigger a scene scan');
    assert.equal(atmosphere.inspect().smokeSources, Math.min(on.length, MAX_SMOKE_SOURCES), 'actual atmosphere has no stale or duplicate sources');
    assert.equal(smoke.geometry.drawRange.count, Math.min(on.length, MAX_SMOKE_SOURCES) * SMOKE_PER_SOURCE, 'actual rendered particle count');
    assert.equal(smoke.visible, on.length > 0);
    const sources = findAnchors(scene, () => false, false).smoke;
    assert.equal(sources.length, on.length, 'no stale or duplicated plume anchors');
    const expected = on.map(id => {
      const pose = model.worldPose(model.entities.get(id)!);
      return new THREE.Vector3(pose.x + 0.025 * Math.cos(pose.yaw) + 0.02 * Math.sin(pose.yaw), pose.y + 1.132, pose.z - 0.025 * Math.sin(pose.yaw) + 0.02 * Math.cos(pose.yaw)).applyMatrix4(layer.group.matrixWorld);
    });
    for (const p of expected) assert.equal(sources.filter(s => s.p.distanceTo(p) < 1e-6).length, 1, 'one smoke anchor at each actual rotated tip');
    const actual: THREE.Vector3[] = [], positions = smoke.geometry.getAttribute('position');
    for (let i = 0; i < smoke.geometry.drawRange.count; i += SMOKE_PER_SOURCE) {
      const p = new THREE.Vector3().fromBufferAttribute(positions, i); actual.push(p);
      assert.equal(expected.filter(e => e.distanceTo(p) < 1e-6).length, 1, 'rendered plume starts at one actual rotated tip');
    }
    for (const p of actual) assert.equal(actual.filter(a => a.distanceTo(p) < 1e-6).length, 1, 'no duplicated rendered plume');
    for (const id of [east, west].filter(id => inner.drawn.has(id))) {
      const drawn = inner.drawn.get(id)!;
      assert.equal(instanceable(drawn.obj), !model.entities.get(id)!.state!.on, 'the predicate accepts ordinary geometry and preserves burning smoke anchors');
      // Existing look policy gives an off censer no instance key; the smoke guard keeps a lit censer individual.
      assert.equal(drawn.inst, undefined, 'both states draw individually for their respective existing look or smoke requirement');
    }
    assert.equal(flameStats.mounted, mountedBefore, 'no flame effect is substituted for smoke');
    const before = atmosphere.inspect();
    const traverse = scene.traverse; let traversals = 0;
    scene.traverse = callback => { traversals++; return traverse.call(scene, callback); };
    try { frame(seconds += .001); } finally { scene.traverse = traverse; }
    const after = atmosphere.inspect();
    assert.equal(traversals, 0, 'unchanged frame never traverses the scene');
    for (const key of ['scans', 'smokeRefreshes', 'lightCollects', 'lightRefreshes'] as const) assert.equal(after[key], before[key], `unchanged frame leaves ${key} alone`);
  };
  redraw(east, false); redraw(west, false); check([]);
  redraw(east, true); check([east]);
  redraw(west, true); check([east, west]);
  redraw(east, false); check([west]);
  redraw(east, true); check([east, west]);
  redraw(west, false); check([east]);
  redraw(east, false); check([]);
  redraw(east, true); redraw(west, true); check([east, west]);
  layer.group.position.set(.3, .2, -.4); layer.group.rotation.y = .7; check([east, west]);
  redraw(east, true); check([east, west]); // same-state redraw replaces the old publisher
  inner.unload(west); check([east]); // actual streaming removal
  inner.draw(model.entities.get(west)!, false, true); check([east, west]);
  scene.remove(layer.group); check([]);
  // Reparent under transformed ancestry; direct root attach still signals the new scene.
  const parent = new THREE.Group(); parent.position.set(-.2, .1, .3); parent.rotation.y = -.4; scene.add(parent); parent.add(layer.group); check([east, west]);
  parent.remove(layer.group); check([]); scene.add(layer.group); check([east, west]);
  const many: string[] = [];
  for (let i = 0; i < 60; i++) {
    const name = `cap-${i}`;
    act([{ op: 'place', def: coreRef('incense-censer', 1), name, p: [(i % 10) * .3 - 1.5, Math.floor(i / 10) * .3 + 4], r: i * .1 }]);
    const id = model.get(name)!.id; many.push(id); redraw(id, true);
  }
  check([east, west, ...many]);
  const cappedPositions = Array.from(smoke.geometry.getAttribute('position').array);
  frame(75); seconds = 75; scans++;
  assert.equal(atmosphere.inspect().scans, scans, 'periodic scan retains its original thirty-second cadence');
  check([east, west, ...many]);
  assert.deepEqual(Array.from(smoke.geometry.getAttribute('position').array), cappedPositions, 'periodic collection preserves the same capped source selection and order');
  layer.dispose(); check([]);
});

for (const newHidden of [true, false]) test(newHidden
  ? 'a new hidden cottage censer redrawn on a periodic scan publishes immediately when uncovered'
  : 'a known cottage censer hidden without redraw across a periodic scan publishes immediately when uncovered', async t => {
  const globals = globalThis as unknown as { location?: URL }, previousLocation = globals.location;
  globals.location = new URL('https://example.invalid/w/fixture'); t.after(() => { globals.location = previousLocation; });
  const { WorldEntityLayer, createWorldAtmosphere } = await runtime();
  const layer = new WorldEntityLayer(p => p), inner = layer as unknown as Inner & {
    hostPass(): void; refreshVisibility(id: string, drawn: Drawn, now: number): void;
  };
  t.after(() => layer.dispose());
  const model = inner.model = new WorldModel({ constants: { ground: 'land', extent: 1000 }, seed: 'incense-hidden' }); model.library = coreLibrary();
  const act = (ops: unknown[]) => { const r = applyBatch(model, { ops }, 'god', 1); assert.equal(r.result.accepted, true, JSON.stringify(r.result)); };
  act([{ op: 'place', def: coreRef('cottage', 1), name: 'home', p: [0, 0], params: { floors: 2 } }]);
  const home = model.get('home')!;
  act([{ op: 'place', def: coreRef('incense-censer', 1), name: 'inside', in: { parent: home.id, slot: 'floor-1' }, p: [0, 0, -1.1] }]);
  const censer = model.get('home/inside')!.id;
  inner.ring = new StreamRing({ inner: 100, outer: 150 }); inner.ring.update(0, 0); inner.now = 1000;
  layer.active = true; layer.motionInstancing = false;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#bbddff'); scene.add(layer.group);
  const atmosphere = createWorldAtmosphere(scene), camera = new THREE.PerspectiveCamera(); t.after(() => atmosphere.dispose());
  const frame = (seconds: number) => atmosphere.update({ seconds, dt: .01, clock: '2026-11-09T12:00:00', daylight: 1, camera, eden: true, profile: 'world', reducedMotion: false });
  if (!newHidden) act([{ op: 'set', id: censer, state: { on: true } }]);
  inner.draw(home, false, true); inner.draw(model.entities.get(censer)!, false, true);
  const interior = inner.drawn.get(home.id)!.obj.userData.interior as { floorOf: Record<string, number> };
  assert.equal(interior.floorOf['floor-1'], 1, 'real cottage builder provides the occupied upper storey');
  const visibility = () => { inner.hostPass(); inner.refreshVisibility(censer, inner.drawn.get(censer)!, inner.now); };
  layer.interiorFrom = null; visibility();
  assert.equal(inner.drawn.get(censer)!.obj.visible, true, 'the initial cottage censer is visible');
  for (const seconds of [0, 1.5, 5, 12, 25, 45]) frame(seconds);
  assert.equal(atmosphere.inspect().smokeSources, newHidden ? 1 : 2, 'startup scan sees the chimney plus an initially lit censer');
  layer.interiorFrom = new THREE.Vector3(100, 0, 0); visibility();
  assert.equal(inner.drawn.get(censer)!.obj.visible, false, 'supported far-interior policy hides the censer');
  if (newHidden) {
    act([{ op: 'set', id: censer, state: { on: true } }]);
    inner.draw(model.entities.get(censer)!, false, true); visibility();
    assert.equal(inner.drawn.get(censer)!.obj.visible, false, 'new lit redraw remains hidden');
  } else {
    // No additions or redraws occur after scan45: the cache must retain this known hidden publisher itself.
    frame(45.1); assert.equal(atmosphere.inspect().smokeSources, 1, 'hiding the known source leaves only the chimney');
  }
  const scans = atmosphere.inspect().scans;
  frame(75); assert.equal(atmosphere.inspect().scans, scans + 1);
  assert.equal(atmosphere.inspect().smokeSources, 1, 'periodic scan must not show the hidden new censer');
  layer.interiorFrom = null; visibility();
  assert.equal(inner.drawn.get(censer)!.obj.visible, true, 'supported host visibility uncovers the censer');
  const smoke = scene.getObjectByName('atmosphere: chimney smoke') as THREE.Points<THREE.BufferGeometry>;
  for (const seconds of [75.01, 104.99]) {
    frame(seconds);
    const found = findAnchors(scene, () => false, false).smoke;
    assert.equal(found.length, 2, 'cottage chimney and uncovered incense both have live anchors');
    assert.equal(atmosphere.inspect().smokeSources, 2, 'newly uncovered smoke reaches the actual atmosphere before the next scan');
    assert.equal(smoke.geometry.drawRange.count, 2 * SMOKE_PER_SOURCE);
    assert.equal(atmosphere.inspect().scans, scans + 1, 'uncovering does not add a periodic scan');
    const positions = smoke.geometry.getAttribute('position'), actual = [];
    for (let i = 0; i < smoke.geometry.drawRange.count; i += SMOKE_PER_SOURCE) actual.push(new THREE.Vector3().fromBufferAttribute(positions, i));
    for (const source of found) assert.equal(actual.filter(p => p.distanceTo(source.p) < 1e-6).length, 1, 'one actual plume at each world anchor');
  }
  const before = atmosphere.inspect(); frame(104.995); const after = atmosphere.inspect();
  for (const key of ['scans', 'smokeRefreshes', 'lightCollects', 'lightRefreshes'] as const) assert.equal(after[key], before[key], `unchanged visible frame leaves ${key} alone`);
});
