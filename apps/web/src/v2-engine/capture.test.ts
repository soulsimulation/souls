// #5022's finding: `shoot` and a creator's `look` aim the old page's camera through `v2.capture` (capture.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aimAt, installCapture, resolveSpot, spots, type CaptureNode, type CapturePage, type Drawn } from './capture.ts';

const Q = 2 ** 30, still: [number, number, number, number] = [Q, 0, 0, 0];
/** A quarter turn about +y, as the stream writes a turn (unit quaternion × 2^30). */
const quarter: [number, number, number, number] = [Math.round(Q * Math.SQRT1_2), 0, Math.round(Q * Math.SQRT1_2), 0];
const n = (id: string, kind: string, parent: string | null, at: [number, number, number], more: Partial<CaptureNode> = {}): CaptureNode =>
  ({ id, kind, parent, pos: [at[0] * 1e6, at[1] * 1e6, at[2] * 1e6], rot: still, ...more });
const NODES = new Map<string, CaptureNode>([
  ['w.1', n('w.1', 'souls:world', null, [0, 0, 0])],
  ['w.2', n('w.2', 'eden:ground@ab', 'w.1', [0, 0, 0])],
  ['w.3', n('w.3', 'eden:hall@cd', 'w.2', [14, 0, -8], { rot: quarter, placeName: 'lab-presentation-hall' })],
  ['w.4', n('w.4', 'eden:desk', 'w.3', [2, 0, 0], { name: 'presenter-desk' })],
  ['w.5', n('w.5', 'eden:bench', 'w.3', [-2, 0, 0])],
  ['w.6', n('w.6', 'eden:flag', 'w.2', [0, 0, 0], { name: 'plaza', origin: 'e_flag_plaza' })],
  ['w.7', n('w.7', 'souls:humanoid', 'w.2', [5, 0, 5], { soul: 'soul-ada' })],
  ['w.8', n('w.8', 'eden:park', 'w.2', [0, 0, 0], { outline: [[30_000, 30_000], [50_000, 30_000], [50_000, 40_000], [30_000, 40_000]] })],
]);
const ADA: Drawn = { name: 'Ada', p: [5, 0, 5], yaw: Math.PI / 2 };
const body = (x: CaptureNode) => (x.id === 'w.7' ? ADA : null);

test('names as the client\'s copy has them: a place\'s public name, a thing\'s own, else its kind and counter; a Soul by its name', () => {
  const all = spots(NODES, body), by = (id: string) => all.find((s) => s.id === id)!;
  assert.deepEqual({ ...by('w.3') }, { id: 'w.3', name: 'lab-presentation-hall', role: 'place', also: 'hall 3' });
  assert.equal(by('w.4').name, 'presenter-desk');
  assert.equal(by('w.4').role, 'thing');
  assert.equal(by('w.5').name, 'bench 5');
  assert.deepEqual({ name: by('w.7').name, role: by('w.7').role }, { name: 'Ada', role: 'soul' });
  for (const [asked, id] of [['presenter-desk', 'w.4'], ['bench 5', 'w.5'], ['Bench', 'w.5'], ['hall 3', 'w.3'], ['ada', 'w.7'], ['w-6', 'w.6'], ['w.6', 'w.6'],
    ['e_flag_plaza', 'w.6'], ['lab-presentation', 'w.3']] as const) assert.equal(resolveSpot(all, asked)?.id, id, asked);
  assert.equal(resolveSpot(all, 'no such thing'), null);
});

test('a thing\'s camera looks at it through its frames; a place\'s over what it holds; an area\'s over its outline; a Soul\'s eyes face its way', () => {
  const all = spots(NODES, body), spot = (id: string) => all.find((s) => s.id === id)!;
  // the desk is 2 m along the hall's +x, which the hall's quarter turn about +y points at -z: at (14, 0, -10)
  const desk = aimAt(NODES, body, spot('w.4'))!;
  assert.deepEqual(desk.target.map((v) => +v.toFixed(3)), [14, 0.8, -10]);
  assert.deepEqual(desk.eye.map((v) => +v.toFixed(3)), [17.5, 3.3, -6.5]);
  const hall = aimAt(NODES, body, spot('w.3'))!;
  assert.deepEqual(hall.target.map((v) => +v.toFixed(3)), [14, 0, -8], 'the middle of the desk and the bench');
  assert.ok(hall.eye[1] > 6 && hall.eye[0] > 14 && hall.eye[2] > -8, 'from above one corner');
  const park = aimAt(NODES, body, spot('w.8'))!;
  assert.deepEqual(park.target.map((v) => +v.toFixed(3)), [40, 0, 35]);
  const eyes = aimAt(NODES, body, spot('w.7'), true)!;
  assert.deepEqual(eyes.eye.map((v) => +v.toFixed(3)), [5, 1.6, 5.35], 'yaw π/2 faces +z (the old take\'s atan2(dz, dx))');
  assert.ok(eyes.target[2] > 14);
  assert.equal(aimAt(NODES, () => null, spot('w.7')), null, 'a Soul the page does not draw cannot be aimed at');
});

test('`v2.capture` waits for the page, aims through its pin and says what it shot; retire takes it off', () => {
  let ready = false, pinned: unknown = null;
  const page: CapturePage = { ready: () => ready, t: () => (ready ? 1_250_000 : null), nodes: () => NODES, body,
    pin: (eye, target) => { pinned = { eye, target }; return { eye: [eye[0], eye[1] + 1, eye[2]], target }; } };
  const host: { v2?: { capture: { ready(): boolean; where(): { name: string }[]; aim(n: string, e?: boolean): { spot: { id: string; role: string }; aim: { eye: number[] } } | null }; director: { t: number | null } } } = {};
  const { retire } = installCapture(host, page);
  assert.equal(host.v2!.capture.ready(), false);
  assert.equal(host.v2!.capture.aim('presenter-desk'), null, 'nothing is aimed before the page draws');
  ready = true;
  assert.equal(host.v2!.capture.ready(), true);
  assert.equal(host.v2!.director.t, 1_250_000);
  const shot = host.v2!.capture.aim('presenter-desk')!;
  assert.deepEqual(shot.spot, { id: 'w.4', name: 'presenter-desk', role: 'thing' });
  assert.ok(pinned, 'the camera went through the page\'s pin');
  assert.equal(+shot.aim.eye[1].toFixed(3), 4.3, 'the camera the pin set (lifted), not the one asked for');
  assert.equal(host.v2!.capture.aim('nothing here'), null);
  assert.ok(host.v2!.capture.where().some((s) => s.name === 'Ada'));
  retire();
  assert.equal(host.v2, undefined);
});
