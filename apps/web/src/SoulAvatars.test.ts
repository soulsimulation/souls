// #5039: Soul portraits frame the face, on a pale background of the Soul's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PORTRAIT_TINTS, portraitTint, soulPortraitView} from './SoulAvatars.ts';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('each Soul gets a stable pale tint from its id, never white, spread across the palette', () => {
  for (const tint of PORTRAIT_TINTS) {
    const y = luminance(tint);
    assert.ok(y > 0.55 && y < 0.85, `${tint}: light, but not white (luminance ${y.toFixed(2)})`);
  }
  const ids = Array.from({length: 90}, (_, i) => `s_${(i * 2654435761 >>> 0).toString(16)}`);
  for (const id of ids) assert.equal(portraitTint(id), portraitTint(id), 'the same id always draws the same tint');
  assert.ok(ids.every(id => (PORTRAIT_TINTS as readonly string[]).includes(portraitTint(id))));
  const used = new Set(ids.map(portraitTint));
  assert.equal(used.size, PORTRAIT_TINTS.length, 'ninety Souls use every tint');
});

test('a humanoid portrait frames the head and the top of the shoulders, not the body', () => {
  const root = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(.5, 1.75, .3), new THREE.MeshBasicMaterial());
  body.position.y = .875; root.add(body);
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1.53; root.add(head);
  const view = soulPortraitView(root, false)!;
  // the head (joint 1.53 to crown 1.75, 0.22 m) is more than half the frame's height, the frame's foot is above the chest
  assert.ok(.22 / view.height > .5 && view.height < .45, `frame ${view.height.toFixed(3)} m`);
  const bottom = view.target.y - view.height / 2, top = view.target.y + view.height / 2;
  assert.ok(top > 1.75 && top < 1.8, `the crown stays inside the frame (top ${top.toFixed(3)})`);
  assert.ok(bottom > 1.3 && bottom < 1.45, `the frame ends at the top of the shoulders (${bottom.toFixed(3)})`);
  // a tall hat (0.6 m) keeps the frame on the head: bounded by the body's size, never the whole figure
  const hat = new THREE.Mesh(new THREE.BoxGeometry(.2, .6, .2), new THREE.MeshBasicMaterial()); hat.position.y = 2.05; root.add(hat);
  const hatted = soulPortraitView(root, false)!;
  assert.ok(hatted.height < .8 && hatted.target.y - hatted.height / 2 > 1.1, `hatted frame ${hatted.height.toFixed(3)} m`);
});

test('a mesh carried by a hidden rig frames the mesh, not the rig\'s head bone', () => {
  const root = new THREE.Group(), wisp = new THREE.Mesh(new THREE.BoxGeometry(.8, 1.2, .8), new THREE.MeshBasicMaterial()); wisp.position.y = 1.2; root.add(wisp);
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1.55; root.add(head);
  const rig = new THREE.SkinnedMesh(new THREE.BoxGeometry(.5, 1.75, .3), new THREE.MeshBasicMaterial()); rig.bind(new THREE.Skeleton([head])); rig.visible = false; root.add(rig);
  const view = soulPortraitView(root, false)!;
  assert.ok(view.height >= 1.2 * .42 && view.target.y + view.height * view.slack / 2 > 1.8, `the whole top of the wisp is in frame (${view.height.toFixed(3)} m)`);
});
