// #5039: Soul portraits frame the face, on a pale background of the Soul's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FACE_FILL, PORTRAIT_TINTS, portraitTint, soulPortraitView} from './SoulAvatars.ts';

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

test('a look\'s face fills the frame: a mohawk or a tall hat does not shrink it', () => {
  const frame = (spike: boolean) => {
    const root = new THREE.Group(), model = new THREE.Group(); model.userData.humanoid = {look: {headSize: 1}}; root.add(model);
    const hips = new THREE.Bone(), neck = new THREE.Bone(), head = new THREE.Bone(); neck.name = 'Neck'; head.name = 'Head';
    neck.position.y = 1.51; head.position.y = .0767; hips.add(neck); neck.add(head); model.add(hips); model.updateMatrixWorld(true);
    // the face (0.24 m chin to crown, 0.21 m ear to ear) on Head; the body on the hips; a 0.4 m mohawk on Head
    const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => [0, 1, 2, 3, 4, 5, 6, 7].map(i => [cx + (i & 1 ? sx : -sx) / 2, cy + (i & 2 ? sy : -sy) / 2, cz + (i & 4 ? sz : -sz) / 2]);
    const parts: [number[][], number][] = [[box(.05, 1.68, 0, .2, .24, .21), 2], [box(0, .9, 0, .3, 1.2, .5), 0], ...(spike ? [[box(0, 1.95, 0, .2, .4, .03), 2] as [number[][], number]] : [])];
    const points = parts.flatMap(([p]) => p), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(parts.flatMap(([p, b]) => p.flatMap(() => [b, 0, 0, 0])), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(parts.flatMap(([p]) => p.flatMap(() => [1, 0, 0, 0])), 4));
    const skin = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); model.add(skin); skin.bind(new THREE.Skeleton([hips, neck, head]));
    return soulPortraitView(root, false)!;
  };
  const plain = frame(false), mohawk = frame(true);
  assert.ok(Math.abs(plain.height - mohawk.height) < 1e-6 && plain.target.distanceTo(mohawk.target) < 1e-6, `mohawk ${mohawk.height.toFixed(3)} m, plain ${plain.height.toFixed(3)} m`);
  // the face is about 0.25 m across in the three-quarter view: the frame is that over FACE_FILL, centred on the face
  assert.ok(plain.height * FACE_FILL > .21 && plain.height * FACE_FILL < .29, `frame ${plain.height.toFixed(3)} m`);
  assert.ok(Math.abs(plain.target.y - 1.677) < .03, `centred on the face (${plain.target.y.toFixed(3)})`);
});
