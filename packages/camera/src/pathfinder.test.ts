import assert from 'node:assert/strict';
import { test } from 'node:test';
import { obbCorners } from '../../../mars/viewer/engine/core/math.ts';
import type { Obstacle } from '../../../mars/viewer/engine/spatial/types.ts';
import { cameraScene, findPath, historyOf, obstaclesOf, sampleTrack, trackOf, type Sampler } from './index.ts';

const walker = (speed = 1.3): Sampler => (t) => ({ a: { p: [t * speed, 0, 0], yaw: 0, height: 1.75, kind: 'human' } });
const wall = (z: number): Obstacle => ({ id: 'wall', label: 'long wall', kind: 'wall', obb: { c: [8, z], half: [30, 0.2], yaw: 0 }, y0: 0, y1: 6 });

test('a walker beside a wall is shot from the open side, and no kept move touches the wall', () => {
  for (const z of [2.5, -2.5]) {
    const r = findPath({ sampler: walker(), scene: cameraScene(null, [wall(z)]), duration: 10, subjects: ['a'], aspect: 0.8 });
    assert.ok(r.best, 'a move is found');
    assert.ok(r.anchor.moving);
    for (const c of r.ranked) {
      assert.equal(c.plan.report.invalidSamples, 0, c.id); assert.equal(c.plan.report.sweptCrossings, 0, c.id); assert.equal(c.plan.report.cuts.length, 0, c.id);
      for (const s of c.plan.samples) assert.ok(Math.sign(s.position[2]) !== Math.sign(z) || Math.abs(s.position[2]) < Math.abs(z) - 0.3, `${c.id} stays on the walker's side of the wall`);
    }
    assert.ok(r.best.plan.samples.every((s) => Math.sign(s.position[2]) === -Math.sign(z)), `best (${r.best.id}) is on the open side`);
    assert.ok(r.rejected.some((c) => /camera\.path-(blocked|crosses|unseen)/.test(c.rejected ?? '')), 'moves the wall forbids are rejected with a reason');
  }
});

test('the pick is deterministic, smooth and keeps the subject in sight', () => {
  const req = { sampler: walker(), scene: cameraScene(null, []), duration: 8, subjects: ['a'], aspect: 0.8 } as const;
  const a = findPath(req), b = findPath(req);
  assert.equal(JSON.stringify(a.best!.plan.samples), JSON.stringify(b.best!.plan.samples));
  assert.deepEqual(a.ranked.map((c) => c.id), b.ranked.map((c) => c.id));
  const T = a.best!.plan.report.temporal;
  assert.ok(T.maxAngVel < 30, `turns at most ${T.maxAngVel} deg/s`);
  assert.ok(a.best!.parts.sight > 0.9 && a.best!.parts.faces > 0.6, JSON.stringify(a.best!.parts));
  const data = trackOf(a.best!), p = sampleTrack(data, 4);
  assert.equal(data.schema, 'mars-camera-track/1'); assert.ok(p.position.every(Number.isFinite));
});

test('two people facing each other are shot from the side, both in frame', () => {
  const pair: Sampler = () => ({ a: { p: [0, 0, 0], yaw: 0, height: 1.75, kind: 'human' }, b: { p: [1.4, 0, 0], yaw: Math.PI, height: 1.75, kind: 'human' } });
  const r = findPath({ sampler: pair, scene: cameraScene(null, []), duration: 6, subjects: ['a', 'b'], aspect: 0.8 });
  assert.ok(r.best && !r.anchor.moving);
  const mid = r.best.plan.samples[Math.floor(r.best.plan.samples.length / 2)];
  assert.ok(Math.abs(mid.position[2]) > Math.abs(mid.position[0] - 0.7), `side-on: ${mid.position}`);
  assert.ok(r.best.parts.sight > 0.9);
});

test('a model footprint becomes the same box as an engine obstacle', () => {
  const fp = { c: [3, -2] as const, half: [4, 1] as const, yaw: 0.6, y0: 0, y1: 3 };
  const [o] = obstaclesOf({ entities: new Map([['e1', { id: 'e1', name: 'barn' }]]), footprint: () => [fp, { ...fp, y1: 0.1 }] });
  assert.equal(o.label, 'barn'); assert.equal(obstaclesOf({ entities: new Map([['e1', { id: 'e1' }]]), footprint: () => [fp, { ...fp, y1: 0.1 }] }).length, 1, 'a kerb is not a camera solid');
  const c = Math.cos(fp.yaw), s = Math.sin(fp.yaw); // the world compiler's turn: x' = x·c + z·s, z' = −x·s + z·c
  const want = [[4, 1], [-4, 1], [-4, -1], [4, -1]].map(([x, z]) => [3 + x * c + z * s, -2 - x * s + z * c]);
  obbCorners(o.obb).forEach((p, i) => { assert.ok(Math.abs(p[0] - want[i][0]) < 1e-9 && Math.abs(p[1] - want[i][1]) < 1e-9, `corner ${i}`); });
});

test('history joins take chunks on absolute ticks', () => {
  const chunk = (from: number, x0: number, x1: number) => ({ fromTick: from, toTick: from + 20, take: { dt: 0.05, startTick: from, tracks: { h1: [[0, x0 * 1000, 0, 0, 0], [20, x1 * 1000, 0, 0, 0]], boat: [[0, 0, 0, 0, 0]] }, changes: [[0, 'h1', 'present', true], [0, 'h1', 'activity', 'walk']] as [number, string, string, unknown][], entities0: { h1: { kind: 'human' }, boat: { kind: 'fixture' } } } });
  const h = historyOf([chunk(120, 1, 2), chunk(100, 0, 1)]);
  assert.deepEqual(h.ids, ['h1']); assert.equal(h.fromTick, 100); assert.equal(h.toTick, 140);
  const s = h.sampler(100);
  assert.ok(Math.abs(s(0.5).h1.p[0] - 0.5) < 1e-9); assert.ok(Math.abs(s(1.5).h1.p[0] - 1.5) < 1e-9);
  assert.equal(h.activity('h1', 130), 'walk'); assert.deepEqual(Object.keys(h.sampler(0)(0)), [], 'nobody before the recording starts');
});

test('a bystander walking alongside is kept out of the foreground', () => {
  const two: Sampler = (t) => ({ a: { p: [t * 1.3, 0, 0], yaw: 0, height: 1.75, kind: 'human' }, by: { p: [t * 1.3 + 0.5, 0, 1.6], yaw: 0, height: 1.75, kind: 'human' } });
  const r = findPath({ sampler: two, scene: cameraScene(null, []), duration: 8, subjects: ['a'], aspect: 0.8 });
  const of = (id: string) => [...r.ranked, ...r.rejected].find((c) => c.id === id)!;
  assert.ok(of('track:L:medium').parts.clean < 0.3, `the bystander's side, across the foreground: ${of('track:L:medium').parts.clean}`);
  assert.ok(of('track:R:medium').parts.clean > of('track:L:medium').parts.clean + 0.1, `the far side, behind the subject: ${of('track:R:medium').parts.clean}`);
  assert.ok(r.best!.parts.clean >= of('track:R:medium').parts.clean, `best ${r.best!.id} ${r.best!.parts.clean}`);
});

test('what the subject rides is framed with it', () => {
  const rider: Sampler = (t) => ({ a: { p: [0, 2 + t, 0], yaw: 0, height: 1.75, kind: 'human' } });
  const envelope = (t: number): [number, number, number][] => [[-4, 2 + t, -4], [4, 2 + t + 16, 4]];
  const req = { sampler: rider, scene: cameraScene(null, []), duration: 8, subjects: ['a'], aspect: 0.8, framings: ['medium'] as const };
  const alone = findPath(req).best!, held = findPath({ ...req, context: envelope }).best!;
  const far = (c: typeof alone) => { const s = c.plan.samples[40]; return Math.hypot(s.position[0], s.position[2]); };
  assert.ok(far(held) > far(alone) * 3, `the camera stands back to hold the envelope: ${far(alone).toFixed(1)} → ${far(held).toFixed(1)} m`);
  assert.ok(held.plan.samples[40].target[1] > alone.plan.samples[40].target[1] + 3, 'and looks at the whole thing, not the rider');
  assert.ok(held.parts.sight > 0.9);
});

test('someone standing beside the subject costs the shot', () => {
  const pair: Sampler = () => ({ a: { p: [0, 0, 0], yaw: 0, height: 1.75, kind: 'human' }, idle: { p: [0, 0, 1.2], yaw: 0, height: 1.75, kind: 'human' } });
  const solo: Sampler = () => ({ a: { p: [0, 0, 0], yaw: 0, height: 1.75, kind: 'human' } });
  const req = { scene: cameraScene(null, []), duration: 6, subjects: ['a'], aspect: 0.8, moves: ['push-in'] as const, framings: ['wide'] as const };
  const of = (sampler: Sampler) => { const r = findPath({ ...req, sampler }); return [...r.ranked, ...r.rejected].find((c) => c.id === 'push-in:L:wide')!.parts.clean; };
  assert.ok(of(solo) > 0.99); assert.ok(of(pair) < 0.7, `beside: ${of(pair)}`);
});

test('history knows what a rider is aboard', () => {
  const chunk = { fromTick: 0, toTick: 20, take: { dt: 0.05, startTick: 0, tracks: { h1: [[0, 1000, 5000, 0, 0], [20, 3000, 6000, 0, 0]], balloon: [[0, 1500, 5000, 0, 0], [20, 3500, 6000, 0, 0]], boat: [[0, 40000, 0, 0, 0]] },
    changes: [[0, 'h1', 'present', true], [0, 'h1', 'activity', 'walk'], [10, 'h1', 'activity', 'ride']] as [number, string, string, unknown][], entities0: { h1: { kind: 'human' }, balloon: { kind: 'fixture' }, boat: { kind: 'fixture' } } } };
  const h = historyOf([chunk]);
  assert.deepEqual(h.things.map((t) => t.id).sort(), ['balloon', 'boat']);
  assert.equal(h.riding('h1', 5), null, 'walking beside it is not riding'); assert.equal(h.riding('h1', 15)?.id, 'balloon');
});

test('a floating body is framed as its ball, at the height it floats', () => {
  const floater = { family: 'floater', radius: 0.35, hoverHeight: 1.45 };
  const chunk = { fromTick: 0, toTick: 20, take: { dt: 0.05, startTick: 0, tracks: { m: [[0, 0, 0, 0, 0], [20, 1000, 0, 0, 0]], h: [[0, 0, 0, 5000, 0]] },
    changes: [[4, 'h', 'body', floater]] as [number, string, string, unknown][], entities0: { m: { kind: 'human', body: floater }, h: { kind: 'human', body: { family: 'humanoid', params: { height: 1.6 } } } } } };
  const at = (tick: number) => historyOf([chunk]).sampler()(tick * 0.05);
  assert.ok(Math.abs(at(0).m.p[1] - 1.1) < 1e-9); assert.ok(Math.abs(at(0).m.height! - 0.7) < 1e-9);
  assert.equal(at(2).h.height, 1.6); assert.ok(Math.abs(at(10).h.height! - 0.7) < 1e-9, 'a body changed during the recording is the body from then on');
  // the camera comes as near to the ball as to a head and shoulders: nearer than to a standing person
  const still = (height: number, y: number): Sampler => () => ({ a: { p: [0, y, 0], yaw: 0, height, kind: 'human' } });
  const far = (s: Sampler) => { const b = findPath({ sampler: s, scene: cameraScene(null, []), duration: 6, subjects: ['a'], aspect: 0.8, moves: ['orbit'], framings: ['medium'] }).best!; return Math.hypot(b.plan.samples[0].position[0], b.plan.samples[0].position[2]); };
  assert.ok(far(still(0.7, 1.1)) < far(still(1.75, 0)) * 0.7);
});

test('for a subject that stands still the camera moves', () => {
  const solo: Sampler = () => ({ a: { p: [0, 0, 0], yaw: 0, height: 1.75, kind: 'human' } });
  const r = findPath({ sampler: solo, scene: cameraScene(null, []), duration: 8, subjects: ['a'], aspect: 0.8 });
  assert.ok(!r.anchor.moving); assert.ok(r.best!.parts.parallax > 0.5, `${r.best!.id} travels`);
  assert.ok(!['pan', 'track', 'lead', 'chase'].includes(r.best!.move), `${r.best!.id} is a move of the camera's own`);
});
