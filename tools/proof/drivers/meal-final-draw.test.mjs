import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mealDrawTools, mealDrawInstall, mealDrawGoal, mealDrawCheckpoint, mealDrawStop } from './meal-final-draw.mjs';
import { kindDef } from '../../../apps/web/src/v2-engine/creator-kinds.ts';
import { buildKit } from '../../../apps/web/src/gen-mesh/kit.mesh.ts';

const THREE = createRequire(new URL('../../../mars/viewer/package.json', import.meta.url))('three');
const entryBytes = readFileSync(new URL('../../../content/kinds/food/soup_bowl.json', import.meta.url)), entry = JSON.parse(entryBytes);
const definition = kindDef('eden:soup_bowl@aa', entryBytes).def;
const worldOf = () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, .01, 100);
  camera.position.set(0, 1, 5); camera.lookAt(0, .7, 0); camera.updateMatrixWorld(true);
  const renderer = { info: { render: { frame: 10 } }, getRenderTarget: () => null, domElement: { isConnected: true } };
  return { scene, camera, renderer, layer: { groundAt: () => 0, drawn: new Map() } };
};
const toolsOf = () => mealDrawTools({ vector: () => new THREE.Vector3(), bodyGeometry: root => {
  let n = 0; root.traverse(m => { if (m.isSkinnedMesh && m.userData.bodyDraw) n++; }); assert(n, 'classic bodyDraw required');
} });
function picture(soup) {
  const object = buildKit(definition.make.args, { state: { soup },
    materials: { colorOf: () => '#ffffff', get: (_name, _tint, options) => new THREE.MeshBasicMaterial(options) },
    tint: (name, fallback) => definition.palette[name] ?? fallback });
  object.userData.entity = 'same-bowl'; return object;
}
function submit(root, world) {
  world.scene.updateMatrixWorld(true);
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.length > 1) for (const group of mesh.geometry.groups) mesh.onAfterRender(world.renderer, world.scene, world.camera, mesh.geometry, materials[group.materialIndex], group);
    else mesh.onAfterRender(world.renderer, world.scene, world.camera, mesh.geometry, materials[0], null);
  });
  return { frame: world.renderer.info.render.frame, canvas: world.renderer.domElement };
}
const held = { id: 'same-bowl', origin: 'original-world-bowl', parent: 'native-body', kind: 'eden:soup_bowl@test', slot: 7,
  pos: [0, 0, 0], rot: [2 ** 30, 0, 0, 0], state: { soup: 2 } };
const metadata = { nativeBody: 'native-body', nativeKindHash: 'a'.repeat(64), nativeResources: [['souls:hand-left', 2, 7], ['souls:hand-right', 2, 8]] };

test('actual canonical bowl geometry distinguishes high, low and empty contents in the merged draw', () => {
  for (const soup of [2, 1, 0]) {
    const tools = toolsOf(), world = worldOf(), root = picture(soup); world.scene.add(root); tools.track(root, world);
    try {
      const stamp = submit(root, world), before = root.matrixWorld.toArray(), values = [];
      root.traverse(m => { if (m.isMesh) values.push([...m.geometry.attributes.position.array]); });
      const result = tools.bowl(root, world, stamp, entry, soup);
      assert.equal(result.soup, soup); assert.equal(result.identity, 'same-bowl'); assert(result.meshes.length > 0);
      if (soup) assert(Math.abs((result.fill.min[1] + result.fill.max[1]) / 2 - (soup === 2 ? .075 : .05)) < 1e-6);
      else assert.equal(result.fill, null);
      assert.deepEqual(root.matrixWorld.toArray(), before);
      const after = []; root.traverse(m => { if (m.isMesh) after.push([...m.geometry.attributes.position.array]); }); assert.deepEqual(after, values);
      if (soup) assert.throws(() => tools.bowl(root, world, stamp, entry, soup === 2 ? 1 : 0), /quantity geometry differs|still draws soup/);
    } finally { tools.stop(); }
  }
});

test('draw witnesses refuse missing, stale, hidden and incomplete actual submissions', () => {
  const world = worldOf(), tools = toolsOf(), root = picture(2); world.scene.add(root); tools.track(root, world);
  const mesh = root.children.find(m => m.isMesh), stamp = { frame: 10 };
  try {
    assert.throws(() => tools.bowl(root, world, stamp, entry, 2), /no actual current submission/);
    submit(root, world); assert(tools.bowl(root, world, stamp, entry, 2));
    assert.throws(() => tools.bowl(root, world, { frame: 11 }, entry, 2), /no actual current submission/);
    root.visible = false; assert.throws(() => tools.bowl(root, world, stamp, entry, 2), /draw missing/); root.visible = true;
    mesh.material.visible = false; assert.throws(() => tools.bowl(root, world, stamp, entry, 2), /hidden submitted material/); mesh.material.visible = true;
    mesh.geometry.setDrawRange(0, 3); assert.throws(() => tools.bowl(root, world, stamp, entry, 2), /changed after submission/); mesh.geometry.setDrawRange(0, Infinity);
    mesh.geometry.attributes.position.setX(0, NaN); assert.throws(() => tools.bowl(root, world, stamp, entry, 2), /nonfinite bowl vertex/);
  } finally { tools.stop(); }
});

test('foreign camera submissions, stale materials, material groups and limits are not actual current bowl evidence', () => {
  const world = worldOf(), tools = toolsOf(), root = picture(0); world.scene.add(root); tools.track(root, world);
  const mesh = root.children.find(m => m.isMesh), foreign = worldOf(), args = [world.renderer, world.scene, foreign.camera, mesh.geometry, mesh.material, null];
  try {
    world.scene.updateMatrixWorld(true); mesh.onAfterRender(...args);
    assert.throws(() => tools.submitted(mesh, world, { frame: 10 }), /no actual current submission/);
    submit(root, world); const original = mesh.material; mesh.material = original.clone();
    assert.throws(() => tools.submitted(mesh, world, { frame: 10 }), /stale submitted material/); mesh.material = original;
    mesh.material = [original, original.clone()]; mesh.geometry.clearGroups(); mesh.geometry.addGroup(0, 3, 0);
    world.renderer.info.render.frame++; submit(root, world); assert.equal(tools.submitted(mesh, world, { frame: 11 }).refs.length, 3);
    mesh.geometry.groups[0].count = 6; assert.throws(() => tools.submitted(mesh, world, { frame: 11 }), /stale material group/);
    assert.throws(() => mealDrawTools({ vector: () => new THREE.Vector3(), maxHooks: 129 }), /invalid measurement budget/);
  } finally { tools.stop(); }
});

test('exact held identity and declared slot cannot be replaced by a hidden source, duplicate or guessed hand', () => {
  const world = worldOf(), tools = toolsOf(), first = new THREE.Group(); first.userData.entity = 'same-bowl'; world.scene.add(first);
  assert.equal(tools.rootOf(world.scene, 'same-bowl'), first);
  first.visible = false; assert.throws(() => tools.rootOf(world.scene, 'same-bowl'), /missing or ambiguous/); first.visible = true;
  const second = first.clone(); world.scene.add(second); assert.throws(() => tools.rootOf(world.scene, 'same-bowl'), /missing or ambiguous/); second.removeFromParent();
  assert.equal(tools.hand(held, metadata), 'left'); assert.throws(() => tools.hand(held, {}), /metadata missing/);
  assert.throws(() => tools.hand(held, { ...metadata, nativeResources: [...metadata.nativeResources, ['souls:hand-right', 2, 7]] }), /ambiguous/);
  assert.throws(() => tools.hand({ ...held, slot: 9 }, metadata), /not a declared hand/);
});

function body(world) {
  const holder = new THREE.Group(); holder.name = 'visible-diner'; holder.userData.entity = holder.name;
  const g = new THREE.BufferGeometry();
  const positions = [-.2, 0, 0, -.19, .02, .02, -.21, .02, -.02, .2, 0, 0, .19, .02, .02, .21, .02, -.02, 0, .5, 0, .01, .52, .02, -.01, .52, -.02];
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const indices = [], weights = []; for (let i = 0; i < 9; i++) { indices.push(Math.floor(i / 3), 0, 0, 0); weights.push(1, 0, 0, 0); }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); const bones = ['LeftFoot', 'RightFoot', 'LeftLeg'].map(name => { const b = new THREE.Bone(); b.name = name; mesh.add(b); return b; });
  holder.add(mesh); world.scene.add(holder); world.scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones)); mesh.skeleton.update();
  return { holder, mesh, anchors: [[-.2, 0, 0], [.2, 0, 0]] };
}

test('single imported submitted skin and both feet are measured, hidden prototypes and absent ground are refused', () => {
  const world = worldOf(), tools = toolsOf(), { holder, mesh, anchors } = body(world); tools.track(holder, world);
  try {
    const stamp = submit(holder, world), result = tools.skin(holder, world, stamp, anchors);
    assert.equal(result.source, 'submitted single imported skin'); assert.equal(result.feet.length, 2); assert.equal(result.feet[0].minGroundGapM, 0);
    assert(result.feet.every(f => f.inferred && f.vertices > 0));
    holder.removeFromParent(); assert.throws(() => tools.skin(holder, world, stamp, anchors), /live body/); world.scene.add(holder);
    world.layer.groundAt = () => null; assert.throws(() => tools.skin(holder, world, stamp, anchors), /ground unavailable/); world.layer.groundAt = () => 0;
    mesh.visible = false; assert.throws(() => tools.skin(holder, world, stamp, anchors), /single-skin/); mesh.visible = true;
    assert.throws(() => tools.skin(holder, world, stamp, [anchors[0]]), /both foot/);
  } finally { tools.stop(); }
});

for (const yaw of [0, Math.PI / 3]) test(`snapshot measures selected palm and native pose once at holder yaw ${yaw}`, () => {
  const world = worldOf(), tools = toolsOf(), { holder, anchors } = body(world), root = picture(2), group = new THREE.Group(); world.scene.add(group);
  const e = { ...held, pos: [12000, 3000, -2000], rot: [Math.SQRT1_2 * 2 ** 30, 0, Math.SQRT1_2 * 2 ** 30, 0] };
  holder.rotation.y = yaw;
  // Independent analytic world construction; do not call the measured projection or repeat its quaternion chain.
  const rotateY = ([x, y, z], angle) => [Math.cos(angle) * x + Math.sin(angle) * z, y, -Math.sin(angle) * x + Math.cos(angle) * z];
  const palm = new THREE.Vector3(.4, .8, 0), offset = rotateY(e.pos.map(n => n * 1e-6), yaw);
  const grip = rotateY(entry.points.grip.at_mm.map(n => n * .001), yaw + Math.PI / 2);
  root.rotation.y = yaw + Math.PI / 2;
  root.position.fromArray(palm.toArray().map((n, i) => n + offset[i] - grip[i])); world.scene.add(root);
  const frame = { tick: 110, dt: .05, souls: [{ id: 'diner', entityId: holder.name }], entities: { [holder.name]: { activity: 'sit', state: { body: metadata, heldEntries: { entries: [e] } } } } };
  world.gameFrame = () => frame; world.contactFrame = () => ({ tick: frame.tick, dt: frame.dt, bones: { [holder.name]: { feet: anchors.map(p => rotateY(p, yaw)) } } });
  const people = { group, frame: { tick: 10 }, take: { startTick: 100 }, bodyObject: () => holder, palmOf: (_id, side, out) => { assert.equal(side, 'left'); out.copy(palm); return true; } };
  tools.track(holder, world); tools.track(root, world);
  try {
    const stamp = submit(root, world); submit(holder, world); const before = root.matrixWorld.toArray(), bodyBefore = holder.matrixWorld.toArray();
    const expected = { native: { bowl: e }, soup: 2, phase: 'seated' };
    const result = tools.snapshot({ world, people, stamp, soul: 'diner', expected, entry, bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } });
    assert(result.gripErrorM < 1e-8); assert(result.rotationErrorRad < 1e-7);
    for (let i = 0; i < 3; i++) assert(Math.abs(result.nativeOffsetPalm[i] - (palm.toArray()[i] + offset[i])) < 1e-9);
    assert.deepEqual(root.matrixWorld.toArray(), before); assert.deepEqual(holder.matrixWorld.toArray(), bodyBefore);
    root.position.x += .01; world.scene.updateMatrixWorld(true); assert.throws(() => tools.snapshot({ world, people, stamp, soul: 'diner', expected, entry, bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } }), /grip misses/);
    root.position.x -= .01; root.quaternion.identity(); world.scene.updateMatrixWorld(true); assert.throws(() => tools.snapshot({ world, people, stamp, soul: 'diner', expected, entry, bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } }), /grip misses|orientation differs/);
    world.layer.drawn.set(e.origin, {}); assert.throws(() => tools.snapshot({ world, people, stamp, soul: 'diner', expected, entry, bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } }), /world draw still present/); world.layer.drawn.clear();
    people.frame.tick = 9; assert.throws(() => tools.snapshot({ world, people, stamp, soul: 'diner', expected, entry, bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } }), /stale/);
  } finally { tools.stop(); }
});

test('a fresh render cannot reuse old public ownership or soup after the native observation changes', () => {
  const tools = toolsOf(), native = { ...held, fields: { 28: 2 } }, worker = { number: 0, latest: new Map([[held.id, native]]) };
  const observer = { failures: [], workers: [worker] }, expected = { soup: 2, native: { worker: 0, bowl: native } };
  tools.currentNative(observer, expected);
  worker.latest.set(held.id, { ...native, fields: { 28: 1 } }); assert.throws(() => tools.currentNative(observer, expected), /soup differs/);
  worker.latest.set(held.id, { ...native, parent: 'another-native-body' }); assert.throws(() => tools.currentNative(observer, expected), /bowl changed/);
  worker.latest.set(held.id, native); observer.workers.push({ number: 1, latest: new Map([[held.id, native]]) });
  assert.throws(() => tools.currentNative(observer, expected), /Worker identity ambiguous/);
});

test('hook restoration preserves calls and refuses another owner; checkpoint/stop retain failures', () => {
  const world = worldOf(), tools = toolsOf(), root = picture(0), mesh = root.children.find(m => m.isMesh); world.scene.add(root);
  const calls = []; function original(...args) { calls.push([this, args]); return 'original-return'; } mesh.onAfterRender = original;
  tools.track(root, world); const args = [world.renderer, world.scene, world.camera, mesh.geometry, mesh.material, null];
  assert.equal(mesh.onAfterRender(...args), 'original-return'); assert.equal(calls.length, 1); assert.equal(calls[0][0], mesh); assert.deepEqual(calls[0][1], args);
  tools.stop(); tools.stop(); assert.equal(mesh.onAfterRender, original);
  const other = toolsOf(); other.track(root, world); const replacement = () => {}; mesh.onAfterRender = replacement;
  assert.throws(other.stop, /ownership changed/); assert.equal(mesh.onAfterRender, replacement);
  const old = globalThis.window;
  try {
    globalThis.window = { __mealDrawObserver: { failures: [], lastRender: 4 } };
    mealDrawGoal({ soup: 2 }); assert.equal(window.__mealDrawObserver.pending.afterFrame, 4); assert.equal(mealDrawCheckpoint(), null);
    mealDrawGoal(null); assert.equal(window.__mealDrawObserver.pending, null);
    window.__mealDrawObserver.failures.push('bad actual draw'); assert.throws(mealDrawCheckpoint, /bad actual draw/);
    window.__mealDrawObserver.result = { samples: ['retained'] }; window.__mealDrawObserver.stop = () => { throw Error('restore failed'); };
    assert.deepEqual(mealDrawStop().samples, ['retained']); assert.match(mealDrawStop().cleanupError, /restore failed/);
  } finally { if (old === undefined) delete globalThis.window; else globalThis.window = old; }
});

for (const changedOwner of [false, true]) test(`serialized adapter keeps actual draw boundaries and ${changedOwner ? 'retains ownership rejection' : 'restores hooks idempotently'}`, async () => {
  const oldWindow = globalThis.window, oldPerformance = globalThis.performance; let clock = 0;
  const kitURL = `data:text/javascript,${encodeURIComponent('export class TakePeople { show(...args) { this.calls.push(args); return "production-return"; } }')}`;
  const { TakePeople } = await import(kitURL), originalShow = TakePeople.prototype.show;
  const world = worldOf(), { holder, anchors } = body(world), root = picture(2), people = new TakePeople();
  world.scene.add(root); root.position.set(-.12, .74, 0); people.group = new THREE.Group(); world.scene.add(people.group);
  people.calls = []; people.frame = { tick: 10 }; people.take = { startTick: 100 }; people.bodyObject = () => holder;
  people.palmOf = (_id, side, out) => { assert.equal(side, 'left'); out.set(0, .8, 0); return true; };
  const native = { ...held, fields: { 28: 2 } }, expected = { phase: 'seated', soup: 2, native: { worker: 0, bowl: native }, depicted: { tick: 110 } };
  const frame = { tick: 110, dt: .05, souls: [{ id: 'diner', entityId: holder.name }], entities: { [holder.name]: { activity: 'sit', state: { body: metadata, heldEntries: { entries: [held] } } } } };
  world.gameFrame = () => frame; world.contactFrame = () => ({ tick: frame.tick, dt: frame.dt, bones: { [holder.name]: { feet: anchors } } });
  const originalRender = world.renderer.render = function (scene, camera) {
    assert.equal(this, world.renderer); assert.equal(scene, world.scene); assert.equal(camera, world.camera);
    this.info.render.frame++; submit(world.scene, world); return 'render-return';
  };
  const oldCallback = root.children.find(m => m.isMesh).onAfterRender;
  try {
    globalThis.performance = { now: () => clock };
    globalThis.window = { __soulsEntity: world, __mealPayloadObserver: { failures: [], workers: [{ number: 0, latest: new Map([[held.id, native]]) }] } };
    await mealDrawInstall({ helperURL: new URL('./meal-final-draw.mjs', import.meta.url).href, oracleURL: new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url).href,
      kitURL, soul: 'diner', entry, entrySHA: 'a'.repeat(64), bodyBinding: { hash: metadata.nativeKindHash, resources: metadata.nativeResources } });
    assert.equal(people.show('actual-instance'), 'production-return'); assert.deepEqual(people.calls, [['actual-instance']]);
    mealDrawGoal(expected); assert.equal(mealDrawCheckpoint(), null);
    assert.equal(world.renderer.render(world.scene, world.camera), 'render-return'); assert.equal(mealDrawCheckpoint().soup, 2);
    clock = 100; frame.tick++; people.frame.tick++; world.renderer.render(world.scene, world.camera);
    assert.equal(window.__mealDrawObserver.samples.length, 1, 'cadence is bounded rather than every-render storage');
    clock = 250; frame.tick++; people.frame.tick++; world.renderer.render(world.scene, world.camera);
    assert.equal(window.__mealDrawObserver.samples.length, 2); assert.equal(window.__mealDrawObserver.checkpoints.length, 1);
    const replacement = () => 'other owner'; if (changedOwner) TakePeople.prototype.show = replacement;
    const first = mealDrawStop(), second = mealDrawStop(); assert.deepEqual(second, first); assert.equal(first.samples.length, 2);
    assert.equal(world.renderer.render, originalRender); assert.equal(root.children.find(m => m.isMesh).onAfterRender, oldCallback);
    if (changedOwner) { assert.match(first.cleanupError, /ownership changed/); assert.equal(TakePeople.prototype.show, replacement); }
    else { assert.equal(first.cleanupError, undefined); assert.equal(TakePeople.prototype.show, originalShow); }
  } finally {
    TakePeople.prototype.show = originalShow; globalThis.performance = oldPerformance;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});
