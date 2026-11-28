import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTER_WIRE, CHARACTER_CLIPS } from './character-wire.ts';
import { createHash } from 'node:crypto';
import { createRig, templateFromGltf, type Template } from './people.ts';
import type { HumanViews as Views, SampledHuman } from './humans.ts';
import { seatedSupportY } from './seated-ground.ts';

// An exact historical module can run the same geometry witness counterfactually, without editing either source.
const { HumanViews, setHumanGround } = await import(process.env.SEATED_HUMANS_SOURCE ?? './humans.ts') as typeof import('./humans.ts');
const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
const templates = new Map<string, Promise<Template>>();
function template(name: keyof typeof CHARACTER_WIRE) {
  let result = templates.get(name);
  if (!result) {
    result = (async () => {
      const loader = new GLTFLoader(), wire = CHARACTER_WIRE[name];
      const load = async (file: string, sha: string) => {
        const bytes = await readFile(rigDir + '/' + file); assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
        return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      };
      const mesh = await load(wire.mesh, wire.meshSHA256); mesh.animations = (await load(wire.clips, CHARACTER_CLIPS[wire.clips].sha256)).animations;
      return templateFromGltf(name, mesh);
    })();
    templates.set(name, result);
  }
  return result;
}
function skin(views: Views, id: string) {
  const rows: { bone: string; p: THREE.Vector3 }[] = [];
  let meshes = 0;
  views.bodyObject(id)!.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.userData.bodyDraw) return;
    assert(mesh.visible); meshes++;
    const g = mesh.geometry, index = g.index; assert(index, 'production draw is indexed');
    const vertices = new Set<number>();
    for (let k = g.drawRange.start; k < Math.min(index.count, g.drawRange.start + g.drawRange.count); k++) vertices.add(index.getX(k));
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    for (const i of vertices) {
      let k = 0; for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, k)) k = j;
      rows.push({ bone: mesh.skeleton.bones[si.getComponent(i, k)].name, p: mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld) });
    }
  });
  assert.equal(meshes, 1, 'measure the complete actual merged body draw');
  for (const side of ['L', 'R']) for (const part of ['Foot', 'LowerLeg']) assert(rows.filter(p => p.bone === part + side).length > 100, part + side + ' skin is nonempty');
  return rows;
}
function lengths(holder: THREE.Object3D) {
  return ['L', 'R'].flatMap(side => {
    const p = ['UpperLeg', 'LowerLeg', 'Foot'].map(part => holder.getObjectByName(part + side)!.getWorldPosition(new THREE.Vector3()));
    return [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])];
  });
}
const separation = (a: ReturnType<typeof skin>, b: ReturnType<typeof skin>) => Math.max(...a.map((p, i) => p.p.distanceTo(b[i].p)));
const base: SampledHuman = { id: 'seated-support', p: [1, 0, -1], yaw: .25, walk: 0, walkDist: 0, activity: 'sit', baseActivity: 'sit', seatHeight: .465, activityAge: 2 };

test('reachable 465mm seats ground both actual production shoes without changing root, pelvis or leg lengths', async t => {
  setHumanGround(() => 0);
  try { for (const name of ['casual', 'punk', 'woman'] as const) {
    const source = await template(name), views = new HumanViews(); views.setTemplates([source]);
    const reference = createRig(source); reference.holder.updateMatrixWorld(true); const originalLengths = lengths(reference.holder); reference.mixer.stopAllAction();
    try { for (const activity of ['sit', 'nod', 'tell-story']) {
      views.setFrame([{ ...base, activity }], 70); views.render(1);
      const holder = views.bodyObject(base.id)!; assert.deepEqual(holder.position.toArray(), base.p);
      assert(Math.abs(views.bones()[base.id].hipY - .555) < .001, 'existing seat plus pelvis thickness stays fixed');
      lengths(holder).forEach((length, i) => assert(Math.abs(length - originalLengths[i]) < 1e-5, 'no anatomical segment stretches'));
      const points = skin(views, base.id);
      for (const side of ['L', 'R']) {
        const foot = points.filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side));
        const leg = points.filter(p => /^(UpperLeg|LowerLeg)/.test(p.bone) && p.bone.endsWith(side));
        const low = Math.min(...foot.map(p => p.p.y));
        t.diagnostic(name + ' ' + activity + ' ' + side + ' minimum drawn shoe ' + low);
        assert(low >= -.001 && low <= .007, name + ' ' + side + ' shoe must reach support, observed ' + low);
        assert(Math.min(...leg.map(p => p.p.y)) >= -.001, 'the lowered shin does not penetrate support: ' + Math.min(...leg.map(p=>p.p.y)));
      }
    } } finally { views.clear(); }
  } } finally { setHumanGround(null); }
});

test('recorded platforms and nearby sloping ground support reachable feet; high seats remain unreachable', async () => {
  const source = await template('woman'), views = new HumanViews(); views.setTemplates([source]);
  try {
    for (const [root, ground, seat] of [[.1, () => 0, .465], [0, (x: number) => Math.max(0, .05 * (x - 1)), .465], [0, () => 0, 1.1]] as const) {
      setHumanGround(ground); views.setFrame([{ ...base, p: [1, root, -1], seatHeight: seat }], 70); views.render(1);
      assert.deepEqual(views.bodyObject(base.id)!.position.toArray(), [1, root, -1]);
      for (const side of ['L', 'R']) {
        const foot = skin(views, base.id).filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side));
        const low = Math.min(...foot.map(p => p.p.y - seatedSupportY(root, ground(p.p.x))));
        if (seat === 1.1) assert(low > .1, 'a genuinely high seat keeps dangling feet instead of changing the seat or stretching');
        else assert(low >= -.001 && low <= .007, 'shoe fits actual support without descending through the platform');
      }
    }
  } finally { views.clear(); setHumanGround(null); }
});

test('seated fitting stays continuous at its own entry/exit fade endpoints and repeats on seek', async () => {
  const views = new HumanViews(); views.setTemplates([await template('woman')]); setHumanGround(() => 0);
  // This isolates the authored transition's fit. The older sit-down→sit activity
  // handoff has its own full-pose snap, recorded separately for the coordinator.
  const draw = (activity: 'sit-down' | 'stand-up', age: number) => {
    views.setFrame([{ ...base, activity, baseActivity: activity, activityAge: age }], 70 + age);
    views.render(1); assert.deepEqual(views.bodyObject(base.id)!.position.toArray(), base.p); return skin(views, base.id);
  };
  try {
    for (const [activity, end] of [['sit-down', .9], ['stand-up', .8]] as const) {
      for (const boundary of [0, end]) {
        const a = draw(activity, boundary - 1e-5), b = draw(activity, boundary + 1e-5);
        assert(separation(a, b) < .001, activity + ' fitting fade has no new contact snap');
      }
      for (const age of [.1, .4, end - .05]) for (const p of draw(activity, age)) if (/^(Foot|Toe|LowerLeg)/.test(p.bone)) assert(p.p.y >= -.001, 'entry/exit lower skin clears support');
    }
    const a = draw('sit-down', .4); draw('stand-up', .3); const b = draw('sit-down', .4);
    assert(separation(a, b) < 1e-5, 'intervening actions never seed a different seated foot origin on seek');
  } finally { views.clear(); setHumanGround(null); }
});

test('seated foot support does not retarget native hands, held objects or paired contacts', async () => {
  const views = new HumanViews(); views.setTemplates([await template('casual')]);
  const hands = { left: [1.3, 1.15, -1.2] as [number, number, number], right: [1.3, 1.15, -.8] as [number, number, number] };
  try { for (const owner of [{ hands }, { prop: 'cup' }, { handHold: { with: 'partner', hand: 'left', since: 0 } as SampledHuman['handHold'], handGameTick: 1400, handGameDt: .05 }]) {
    const draw = (ground: number) => {
      setHumanGround(() => ground);
      views.setFrame([{ ...base, ...owner }, { ...base, id: 'partner', p: [1.8, 0, -1] }], 70); views.render(1);
      if ('hands' in owner) for (const side of ['left', 'right'] as const) { const palm = new THREE.Vector3(); assert(views.palmOf(base.id, side, palm)); assert(palm.distanceTo(new THREE.Vector3(...hands[side])) < .001); }
      return skin(views, base.id).filter(p => /^(UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)/.test(p.bone));
    };
    const a = draw(0), b = draw(.05); assert(a.length > 1000); assert(separation(a, b) < 1e-5, 'lower support changes cannot acquire an existing hand/contact owner');
  } } finally { views.clear(); setHumanGround(null); }
});

test('the procedural fallback preserves an intentional crossed leg and grounds its support leg', async () => {
  const source = await template('casual');
  const fallback = { ...source, gltf: { ...source.gltf, animations: source.gltf.animations.filter(a => !a.name.startsWith('Sitting_')) } };
  const views = new HumanViews(); views.setTemplates([fallback]); setHumanGround(() => 0);
  try {
    let crossed = false;
    for (const id of ['cross-0', 'cross-1', 'cross-2', 'cross-3']) {
      views.setFrame([{ ...base, id }], 70); views.render(1);
      const points = skin(views, id), minimum = (side: string) => Math.min(...points.filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side)).map(p => p.p.y));
      assert(minimum('L') >= -.001 && minimum('L') <= .007, 'the support foot reaches the floor');
      if (minimum('R') > .1) { crossed = true; break; }
    }
    assert(crossed, 'a deterministic crossed-leg variant remains intentionally raised');
  } finally { views.clear(); setHumanGround(null); }
});
