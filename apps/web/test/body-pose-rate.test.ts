// V11 (#2618): the page poses and updates only the Souls that show. A body out of the view is held (no pose, no matrix
// walk, no bone upload between its every-8th poses); a body that comes into view is posed on its first visible frame,
// and what is drawn then matches a body posed every frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TakePeople } from '../../../mars/viewer/app/engine-view/take-replay.ts';
import { templateFromGltf } from '../../../mars/viewer/app/engine-view/people.ts';
import { CHARACTER_WIRE } from '../../../mars/viewer/app/engine-view/character-wire.ts';
import { Runtime } from '../../../mars/viewer/engine/runtime/runtime.ts';
import { Spatial } from '../../../mars/viewer/engine/spatial/service.ts';
import { emptyWorld, human } from '../../../mars/viewer/engine/world/factory.ts';
import { TakeRecorder } from '../../../mars/viewer/engine/take/recorder.ts';
import { openGround } from '../../../mars/viewer/engine/test/frame-fixtures.ts';
import { poseV1 } from '../../../mars/viewer/engine/social/pose.ts';
import type { HumanViewer } from '../../../mars/viewer/app/engine-view/humans.ts';

const DT = .05, ID = 'pan_into_view';
async function glb(file: string) { const s = readFileSync(new URL('../../../mars/viewer/public/modular/environment/' + file, import.meta.url)), n = s.readUInt32LE(12), j = JSON.parse(s.subarray(20, 20 + n).toString()), bin = s.subarray(20 + n); j.materials = j.materials?.map(() => ({ pbrMetallicRoughness: { baseColorFactor: [.5, .5, .5, 1] } })); delete j.textures; delete j.images; delete j.samplers; let b = Buffer.from(JSON.stringify(j)); b = Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, 32)]); const h = Buffer.from(s.subarray(0, 20)); h.writeUInt32LE(20 + b.length + bin.length, 8); h.writeUInt32LE(b.length, 12); const out = Buffer.concat([h, b, bin]); return new GLTFLoader().parseAsync(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), ''); }
const template = (async () => { const wire = CHARACTER_WIRE.casual, g = await glb(wire.mesh); g.animations = (await glb(wire.clips)).animations; return templateFromGltf('pose-rate-casual', g); })();
/** One Soul at the origin that waves (its arms move every frame) for most of 200 ticks. */
function recording() {
  const scene = openGround(), w = emptyWorld('pose-rate', scene); w.entities[ID] = human(ID, 0, 0);
  const rt = new Runtime(w, new Map([[poseV1.verb, poseV1]]), { spatial: new Spatial(scene) }, []), rec = new TakeRecorder(rt, { rulesVersion: 'pose-rate-v1' });
  for (let k = 0; k < 200; k++) { if (k === 5) assert.equal(rt.submit('pose_v1', { actor: ID, activity: 'wave', seconds: 9 }).status, 'executing'); rt.step(); }
  assert.deepEqual(rt.violations, []); return rec.finish();
}
/** The eye 10 m from the Soul, looking at it or straight away from it. Rates: every 4th frame anywhere in the view. */
function viewer(looking: boolean): HumanViewer {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, .1, 500); cam.position.set(0, 1.6, 10); cam.lookAt(0, 1, looking ? 0 : 20); cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  return { eye: cam.position.clone(), frustum, nearM: 1, farM: 2 };
}
const skeletonOf = (p: TakePeople) => { let s: THREE.Skeleton | null = null; p.bodyObject(ID)!.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) s ??= (o as THREE.SkinnedMesh).skeleton; }); return s!; };
/** What three does for a frame: the scene's matrix walk, then each drawn skeleton's bone upload. */
function draw(p: TakePeople) { p.group.updateMatrixWorld(); const seen = new Set<THREE.Skeleton>(); p.bodyObject(ID)!.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && !seen.has(m.skeleton)) { seen.add(m.skeleton); m.skeleton.update(); } }); }
const palms = (p: TakePeople) => p.bones(ID)[ID].arms.map((a) => a.palm);
const gap = (a: number[][], b: number[][]) => Math.max(...a.map((x, i) => Math.hypot(...x.map((v, k) => v - b[i][k]))));
const matGap = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test('a Soul out of the view is held: no pose, no matrix walk, no bone upload between its every-8th poses', async () => {
  const take = recording(), held = new TakePeople(take);
  held.setTemplates([await template]);
  const away = viewer(false);
  let skipped = 0, kept = 0;
  for (let f = 0; f < 40; f++) {
    held.setViewer(f === 0 ? null : away); // the first frame poses the new body (never left in its bind pose)
    held.show(f * DT, f * DT);
    const st = held.poseStats(), before = Float32Array.from(skeletonOf(held).boneMatrices!), world = held.bodyObject(ID)!.matrixWorld.clone();
    draw(held);
    if (f > 0 && st.posed === 0) {
      skipped++; assert.equal(st.held, 1); assert.equal(st.shown, 0);
      assert.equal(matGap(before, skeletonOf(held).boneMatrices!), 0, 'a held body uploads no new bone matrices');
      assert.ok(held.bodyObject(ID)!.matrixWorld.equals(world)); kept++;
    }
  }
  assert.ok(skipped >= 30, `held on ${skipped} of 39 frames out of the view`); assert.equal(kept, skipped);
});

test('a Soul that pans into view is posed on its first visible frame and matches one posed every frame', async () => {
  const take = recording(), away = viewer(false), toward = viewer(true), first: { enterAt: number; bones: number; palms: number; entered?: number; posed: number; heldInView: number }[] = [];
  for (let enterAt = 21; enterAt <= 28; enterAt++) { // every phase of the 4-frame in-view rate and of the 8-frame held rate
    const every = new TakePeople(take), thin = new TakePeople(take);
    every.setTemplates([await template]); thin.setTemplates([await template]);
    let heldInView = 0;
    for (let f = 0; f <= enterAt + 6; f++) {
      thin.setViewer(f === 0 ? null : f < enterAt ? away : toward);
      every.show(f * DT, f * DT); thin.show(f * DT, f * DT); draw(every); draw(thin);
      if (f === enterAt) first.push({ enterAt, bones: matGap(skeletonOf(every).boneMatrices!, skeletonOf(thin).boneMatrices!), palms: gap(palms(every), palms(thin)), entered: thin.poseStats().entered, posed: thin.poseStats().posed, heldInView: 0 });
      if (f > enterAt) heldInView += thin.poseStats().held ?? 0;
    }
    first.at(-1)!.heldInView = heldInView;
  }
  for (const x of first) {
    assert.equal(x.bones, 0, `the bone matrices drawn on the first visible frame (entering on frame ${x.enterAt})`);
    assert.ok(x.palms < 1e-9, `the palms drawn on the first visible frame (entering on frame ${x.enterAt}): ${x.palms} m apart`);
  }
  for (const x of first) { assert.equal(x.entered, 1); assert.equal(x.posed, 1); assert.equal(x.heldInView, 0, 'a body in the view is never held'); }
});
