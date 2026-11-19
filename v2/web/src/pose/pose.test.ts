// The agreement test (V7, #2716): over a recorded minute with walking, sitting and a pour, a body's bones are the same
// within 1 mm at 30 and 144 frames a second, in random order and in a fresh process asked for one frame; the pouring
// hand is within 2 cm of the cup's mouth; and the pose code holds no randomness and no state between frames.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { minute, model, MOUTH, points, POUR } from './fixture.ts';
import { jointAt, palmAt, poseBones, toWorld, type Vec } from './pose.ts';

const S = 1_000_000;
const body = model(), rec = minute();
const hips = body.names.indexOf('Hips');

/** Every bone's origin and both palms in the world at `t` µs. */
function frame(t: number): Vec[] {
  const bones = new Float32Array(body.bones * 12);
  const p = poseBones(rec, body, t, points, bones);
  const at = [...Array(body.bones).keys()].map((b) => jointAt(body, bones, b));
  at.push(palmAt(body, bones, 'left')!, palmAt(body, bones, 'right')!);
  return at.map((v) => toWorld(p, v));
}

const apart = (a: Vec[], b: Vec[]) => Math.max(...a.map((v, i) => Math.hypot(v[0] - b[i][0], v[1] - b[i][1], v[2] - b[i][2])));
const grid = (fps: number) => [...Array(60 * fps + 1).keys()].map((k) => Math.round((k * S) / fps));

test('A1: the minute walks and sits, and its bones agree within 1 mm at 30 and 144 frames a second', () => {
  const at30 = new Map(grid(30).map((t) => [t, frame(t)]));
  const at144 = new Map(grid(144).map((t) => [t, frame(t)]));
  let shared = 0, worst = 0;
  for (const [t, f] of at30) {
    const g = at144.get(t);
    if (!g) continue;
    shared++;
    worst = Math.max(worst, apart(f, g));
  }
  assert.equal(shared, 361, 'every sixth of a second is in both');
  assert.ok(worst < 0.001, `worst ${worst} m`);
  // The minute is what it says: a hip that drops 40 cm on the seat, and a foot that swings while walking.
  assert.ok(at30.get(2 * S)![hips][1] - at30.get(25 * S)![hips][1] > 0.4, 'seated at 25 s');
  const foot = body.names.indexOf('Foot.L'), a = at144.get(10 * S)![foot], b = at144.get(10.5 * S)![foot];
  assert.ok(Math.abs(b[2] - a[2] - 0.6) > 0.05, 'the foot swings against the body’s 0.6 m');
  console.log(`A1: ${shared} shared frames, worst ${(worst * 1000).toFixed(4)} mm`);
});

test('A2: the same bones in random order, and in a fresh process asked for one frame', () => {
  const times = grid(144);
  const inOrder = times.map(frame);
  // A seeded shuffle (xorshift), so a failure repeats.
  let seed = 2716;
  const order = times.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const j = (seed >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  let worst = 0;
  for (const i of order) worst = Math.max(worst, apart(frame(times[i]), inOrder[i]));
  assert.ok(worst < 0.001, `random order: worst ${worst} m`);
  for (const t of [Math.round(13.37 * S), Math.round(47.1 * S)]) {
    const here = path('./fixture.ts'), pose = path('./pose.ts');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { minute, model, points } from ${JSON.stringify(here)};
      import { jointAt, poseBones, toWorld } from ${JSON.stringify(pose)};
      const m = model(), bones = new Float32Array(m.bones * 12), p = poseBones(minute(), m, ${t}, points, bones);
      console.log(JSON.stringify([...Array(m.bones).keys()].map((b) => toWorld(p, jointAt(m, bones, b)))));`], { encoding: 'utf8' });
    const fresh = JSON.parse(out) as Vec[];
    const gap = apart(fresh, frame(t).slice(0, body.bones));
    assert.ok(gap < 0.001, `fresh process at ${t}: ${gap} m`);
  }
  console.log(`A2: ${order.length} frames shuffled, worst ${(worst * 1000).toFixed(4)} mm; two fresh-process frames agree`);
});

const path = (rel: string) => new URL(rel, import.meta.url).href;

test('A3: the pouring hand is within 2 cm of the recorded contact point from contact to the end of the pour', () => {
  let worst = 0, n = 0;
  for (let t = POUR.ends[0]; t <= POUR.ends[1]; t += Math.round(S / 144)) {
    const f = frame(t), palm = f[f.length - 1];
    worst = Math.max(worst, Math.hypot(palm[0] - MOUTH[0], palm[1] - MOUTH[1], palm[2] - MOUTH[2]));
    n++;
  }
  assert.ok(worst < 0.02, `worst ${worst} m`);
  const before = frame(POUR.start - S), palm = before[before.length - 1];
  assert.ok(Math.hypot(palm[0] - MOUTH[0], palm[1] - MOUTH[1], palm[2] - MOUTH[2]) > 0.1, 'the hand hangs before the pour');
  console.log(`A3: ${n} frames in contact, worst ${(worst * 1000).toFixed(1)} mm from the mouth`);
});

test('A5: the pose code holds no randomness and no per-body state between frames', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const random = new RegExp('Math' + '\\.random');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(dir + f, 'utf8');
    assert.ok(!random.test(src), `${f} uses randomness`);
    if (f.endsWith('.test.ts')) continue;
    // State kept between frames would be a class, `this`, a module-level let or var, or a module-level collection.
    for (const [k, line] of src.split('\n').entries()) {
      const code = line.replace(/\/\/.*$/, '');
      assert.ok(!/\bclass\s|\bthis\./.test(code), `${f}:${k + 1}: ${line}`);
      assert.ok(!/^(export\s+)?(let|var)\s/.test(code), `${f}:${k + 1}: ${line}`);
      assert.ok(!/^(export\s+)?const\s+\w+\s*=\s*new\s+(Map|Set|WeakMap|Float32Array|Array)\b/.test(code), `${f}:${k + 1}: ${line}`);
    }
  }
});
