// The things' effects (0.131 parity C8, #3679): which kinds draw what, today's detail levels and clocks, and what a
// baked model gives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FxLayer, fireLevel, fireStrength, fxKind, IGNITE } from '../fx/layer.ts';
import { cupSteam, kettleSteam, KETTLE_CLOCK } from '../fx/steam.ts';
import { fountainPlan, overflows } from '../fx/water-jets.ts';
import { discsOf, modelFx } from '../fx/model.ts';
import type { NodeRec } from '../source/source.ts';

test('kinds: fires, fountains, kettles and cups, by name or by a lit state', () => {
  assert.equal(fxKind('eden:campfire'), 'fire');
  assert.equal(fxKind('eden:hearth@1'), 'fire');
  assert.equal(fxKind('eden:fireplace'), 'fire');
  assert.equal(fxKind('eden:wall_torch'), 'fire');
  assert.equal(fxKind('eden:altar', { lit: ['flame'] }), 'fire');
  assert.equal(fxKind('eden:fountain'), 'fountain');
  assert.equal(fxKind('eden:tiered-fountain'), 'fountain');
  assert.equal(fxKind('eden:drinking-fountain'), null); // its water shows only while playing
  assert.equal(fxKind('eden:kettle'), 'kettle');
  assert.equal(fxKind('eden:cup'), 'cup');
  assert.equal(fxKind('eden:cupboard'), null);
  assert.equal(fxKind('eden:bench'), null);
  assert.equal(fxKind('eden:lamp', { on: ['light'] }), null); // a lamp's light is the night pool, not a flame
});

test("fires: today's reaches and catch-up; the phone tier keeps flames but drops embers and smoke", () => {
  assert.equal(fireLevel('full', 30, false), 2);
  assert.equal(fireLevel('full', 30, true), 1);
  assert.equal(fireLevel('full', 80, false), 1);
  assert.equal(fireLevel('full', 120, false), 0);
  assert.equal(fireLevel('candle', 13, false), 2);
  assert.equal(fireLevel('candle', 15, false), 0);
  assert.equal(fireStrength({}, 100), 1); // the kind's default: lit
  assert.equal(fireStrength({ lit: false }, 100), 0);
  assert.equal(fireStrength({ lit: true, litAt: 100 }, 100), 0.12);
  assert.equal(fireStrength({ lit: true, litAt: 100 }, 100 + IGNITE), 1);
});

test("steam: today's kettle heating clock and cup cooling clock", () => {
  assert.equal(kettleSteam(NaN), 0);
  assert.equal(kettleSteam(1), 0); // just switched on: no steam yet
  assert.ok(kettleSteam(KETTLE_CLOCK.heat - 1) > 0.3);
  assert.equal(kettleSteam(KETTLE_CLOCK.heat + 2), 1); // boiling
  assert.ok(kettleSteam(KETTLE_CLOCK.heat + KETTLE_CLOCK.boil + 60) < 0.1);
  assert.equal(kettleSteam(KETTLE_CLOCK.heat + KETTLE_CLOCK.boil + KETTLE_CLOCK.hot + 1), 0);
  assert.equal(cupSteam(0), 0.6);
  assert.equal(cupSteam(241), 0);
});

test("fountain: the jet falls into the top bowl and the bowl spills to the pool below (today's core fountain)", () => {
  const discs = [{ x: 0, y: 0.52, z: 0, r: 1.8 }, { x: 0, y: 1.675, z: 0, r: 0.7 }];
  const plan = fountainPlan(discs, 2.36)!;
  assert.deepEqual(plan.nozzle, [0, 2.36, 0]);
  assert.ok(Math.abs(plan.bowl[0] - 0.685) < 1e-9 && Math.abs(plan.bowl[1] - 0.75) < 1e-9 && Math.abs(plan.bowl[2] - 1.84) < 1e-9);
  assert.equal(overflows(discs).length, 1);
  assert.equal(fountainPlan([], 2), null);
});

/** A binary glTF: a flame pivot (translated 1 m up) and a water mesh of two discs. */
function glb(): ArrayBuffer {
  const pts: number[] = [];
  for (const [y, r] of [[0.5, 1.8], [0.48, 1.8], [1.66, 0.7], [1.69, 0.7]]) for (let k = 0; k < 8; k++) pts.push(Math.cos(k * Math.PI / 4) * r, y, Math.sin(k * Math.PI / 4) * r);
  const bin = new Uint8Array(new Float32Array(pts).buffer);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'kit:solid', children: [1, 2] }, { name: 'role:flame', translation: [0, 1, 0], extras: { role: 'flame', flames: [{ p: [0, 0.1, 0], r: 0.32, h: 0.8 }] } }, { name: 'kit:water', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ name: 'kit water (rippling)' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: pts.length / 3, type: 'VEC3', min: [-1.8, 0.48, -1.8], max: [1.8, 1.69, 1.8] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const j = new TextEncoder().encode(text), out = new Uint8Array(12 + 8 + j.length + 8 + bin.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true); dv.setUint32(24 + j.length, 0x004e4942, true); out.set(bin, 28 + j.length);
  return out.buffer;
}

test('model: flame clusters on their pivot, water discs and the top, from the bake', () => {
  const m = modelFx(glb());
  assert.equal(m.flames.length, 1);
  assert.deepEqual(m.flames[0].clusters, [{ p: [0, 0.1, 0], r: 0.32, h: 0.8 }]);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(m.flames[0].matrix).y, 1);
  assert.equal(m.discs.length, 2);
  assert.ok(Math.abs(m.discs[1].y - 1.69) < 1e-6 && Math.abs(m.discs[1].r - 0.7) < 1e-6);
  assert.ok(Math.abs(m.top - 1.69) < 1e-6);
  assert.equal(discsOf([]).length, 0);
});

const node = (id: string, kind: string, origin: string): NodeRec => ({ id, kind, origin, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('layer: a lit fire burns near and stops when put out; a fountain runs; a kettle steams once switched on', async () => {
  const bytes = glb(), shown: [string, boolean][] = [];
  const layer = new FxLayer({
    standIns: (id, on) => void shown.push([id, on]),
    frame: () => new THREE.Matrix4(),
    index: () => ({ things: { a: 'h1', b: 'h1', c: 'h1', d: 'h2' }, states: new Map([['h1', { lit: ['flame'] }]]) }),
    fetch: async () => bytes, phone: false,
  });
  layer.apply([node('1', 'eden:campfire', 'a'), node('2', 'eden:fountain', 'b'), node('3', 'eden:kettle', 'c'), node('4', 'eden:bench', 'd')], []);
  assert.deepEqual([...layer.things.keys()], ['1', '2', '3']);
  const eye = new THREE.Vector3(0, 2, 10);
  layer.update(50, eye);
  await tick();
  layer.update(50, eye);
  assert.deepEqual(layer.stats, { fires: 1, near: 1, steaming: 0, fountains: 1 });
  assert.deepEqual(shown, [['1', false]]); // the burning fire hides its static flame
  layer.state('1', { lit: false });
  layer.state('2', { on: false });
  layer.state('3', { heatedAt: 50 - KETTLE_CLOCK.heat - 1 });
  layer.update(50, eye);
  assert.deepEqual(layer.stats, { fires: 1, near: 0, steaming: 1, fountains: 0 });
  assert.deepEqual(shown, [['1', false]]); // put out: no flame at all, the static one stays hidden
  layer.state('1', { lit: true });
  layer.update(50, new THREE.Vector3(0, 2, 300)); // lit but too far to animate: the static flame stands in
  assert.deepEqual(shown.at(-1), ['1', true]);
  layer.update(50, new THREE.Vector3(0, 2, 500)); // far: nothing drawn
  assert.equal(layer.stats.steaming, 0);
  layer.apply([], ['1', '2', '3']);
  assert.equal(layer.group.children.length, 0);
});
