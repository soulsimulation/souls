// N-V10, N-V11 (#3725): the library's two hung pictures and the classroom screen's slide stand where today's page has
// them, in the frames of the things they belong to.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { DISPLAYS, Displays, LESSON, LOOP_FRAMES, drawLoop, slide } from './displays.ts';

const node = (id: string, origin: string, at: [number, number, number]): NodeRec & { at3: [number, number, number] } => ({
  id, kind: 'core-hall@4', parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, origin, at3: at,
});
const world = (p: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(p.matrixWorld);

test('each display stands where today has it when its thing is where Eden has it', () => {
  const d = new Displays();
  const library = node('lib', 'e_a0741c1e', [74, 0, -7]), screen = node('scr', 'e_ad42afe6', [42, 0.1, -17.1]);
  const frames: Record<string, THREE.Matrix4> = { lib: new THREE.Matrix4().makeTranslation(74, 0, -7), scr: new THREE.Matrix4().makeTranslation(42, 0.1, -17.1) };
  d.apply([library, screen, node('other', 'e_00000000', [0, 0, 0])], [], (id) => frames[id]);
  d.group.updateMatrixWorld(true);
  const today: Record<string, [number, number, number]> = {
    'eden-library-colour-study': [70.6, 2.42, -3.225], 'eden-library-colour-loop': [77.2, 2.45, -3.225], 'eden-classroom-local-projection': [42, 1.7, -17.034],
  };
  for (const [id, p] of Object.entries(today)) {
    const o = d.group.getObjectByName(`display:${id}`)!;
    assert.ok(world(o).distanceTo(new THREE.Vector3(...p)) < 1e-6, id);
  }
  // Today's frames face -z (turned half round), the lesson panel +z; the frames have four bars, the panel none.
  const study = d.group.getObjectByName('display:eden-library-colour-study')!, panel = d.group.getObjectByName('display:eden-classroom-local-projection')!;
  assert.ok(new THREE.Vector3(0, 0, 1).transformDirection(study.matrixWorld).z < -0.999);
  assert.ok(new THREE.Vector3(0, 0, 1).transformDirection(panel.matrixWorld).z > 0.999);
  assert.equal(study.children.length, 5);
  assert.equal(panel.children.length, 1);
  assert.equal(d.group.children.length, 2);
  // A thing that moves takes its displays; a removed one takes them away.
  frames.lib = new THREE.Matrix4().makeTranslation(75, 0, -7);
  d.apply([library], [], (id) => frames[id]);
  d.group.updateMatrixWorld(true);
  assert.ok(Math.abs(world(study).x - 71.6) < 1e-6);
  d.apply([], ['lib'], (id) => frames[id]);
  assert.equal(d.group.getObjectByName('display:eden-library-colour-study'), undefined);
  assert.ok(d.has('scr'));
});

test('the lesson panel shows today\'s first slide, on the screen\'s display (today\'s core-screen: 2.25 m by 1.25 m)', () => {
  const panel = DISPLAYS.find((r) => r.id === 'eden-classroom-local-projection')!;
  assert.deepEqual([panel.width, panel.height], [2.25, 1.25]);
  assert.deepEqual(panel.media, { kind: 'image', url: slide(0) });
  const svg = decodeURIComponent(slide(0).split(',')[1]);
  assert.match(svg, /A world with a memory/);
  assert.match(svg, /EDEN · LOCAL LESSON · 1 \/ 3/);
  assert.equal(LESSON.length, 3);
});

test('the colour loop draws today\'s 48 frames: ground, 3 px line and two squares, from the video\'s colours', () => {
  assert.equal(LOOP_FRAMES, 48);
  const calls: unknown[][] = [];
  const g = new Proxy({}, { set: (_t, k, v) => (calls.push([k, v]), true), get: (_t, k) => (...a: unknown[]) => calls.push([k, ...a]) }) as unknown as CanvasRenderingContext2D;
  drawLoop(g, 48); // wraps to frame 0
  assert.deepEqual(calls, [
    ['fillStyle', '#203744'], ['fillRect', 0, 0, 320, 200], ['strokeStyle', '#71977f'], ['lineWidth', 3], ['strokeRect', 26.5, 26.5, 267, 147],
    ['fillStyle', '#e4b873'], ['fillRect', 70, 70, 80, 70], ['fillStyle', '#c07770'], ['fillRect', 185, 90, 60, 50],
  ]);
  const loop = DISPLAYS.find((r) => r.id === 'eden-library-colour-loop')!;
  assert.equal(loop.media.kind, 'loop');
});
