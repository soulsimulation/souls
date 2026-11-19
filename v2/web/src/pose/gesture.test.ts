// E11's drawing checks (#2782): a gesture with no clip of its own is drawn as the stand-in the agent named with a
// caption of its words; the same record, with a real clip added, draws the clip; a mood is held through a walk; and
// the six from E17's list draw the same from their record replayed, in any order. The records are the ones
// `v2/crates/sim/tests/gesture.rs` runs live (same stand-ins, same times).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, model, points } from './fixture.ts';
import type { GestureRecord, MoodRecord, Words } from './gesture.ts';
import { jointAt, poseAt, poseBones, type BodyRecord, type MoveRecord, type PoseModel, type Vec } from './pose.ts';

const S = 1_000_000;
const STAND_INS = [
  held('Idle_Tired_Loop', 2, 'Chest', 25),
  held('Idle_FoldArms_Loop', 2, 'UpperArm.L', -60, [0, 0, 1]),
  held('Idle_No_Loop', 1, 'Torso', 20, [0, 1, 0]),
  held('Celebration', 2, 'UpperArm.R', 150, [0, 0, 1]),
];
const today = model(STAND_INS);
const later = model([...STAND_INS, held('Cartwheel', 2, 'Hips', 90, [0, 0, 1])]);

const SAID: Record<string, string> = {
  w1: 'look bored', w2: 'be shy', w3: 'cry', w4: 'do a cartwheel', w5: 'shrug', w6: 'faint',
};
const everyone: Words = (ref) => SAID[ref] ?? null;
const nobody: Words = () => null;

const move = (name: string, start: number, ends: number[]): MoveRecord => ({
  name, revision: 1, limbs: [], target: 'body-e11', contact: 'souls:root', start, ends, ended: { at: ends[ends.length - 1], how: 'done' },
});
const moods: MoodRecord[] = [
  { since: 0, words: 'w1', like: 'Idle_Tired_Loop' },
  { since: 1 * S, words: 'w2', like: 'Idle_FoldArms_Loop' },
];
const gestures: GestureRecord[] = [
  { move: move('Idle', 2 * S, [2.3 * S, 4 * S]), words: 'w3' },
  { move: move('Celebration', 4.5 * S, [4.8 * S, 7 * S]), words: 'w4', like: 'Celebration' },
  { move: move('Idle_No_Loop', 7.5 * S, [7.8 * S, 9.3 * S]), words: 'w5', like: 'Idle_No_Loop', gaze: 'body-other' },
  { move: move('Idle_Tired_Loop', 9.8 * S, [10.2 * S, 12.8 * S]), words: 'w6', like: 'Idle_Tired_Loop' },
];
const still = [{ at: 0, pos: [0, 0, 0] as Vec }, { at: 60 * S, pos: [0, 0, 0] as Vec }];
const six: BodyRecord = { id: 'body-e11', samples: still, moves: [], gestures, moods };

const name = (m: PoseModel, k: number) => (k >= 0 ? m.clips[k].name : null);
/** Every bone's origin in the model's space at `t`. */
function bones(m: PoseModel, rec: BodyRecord, t: number, words: Words = everyone): Vec[] {
  const out = new Float32Array(m.bones * 12);
  poseBones(rec, m, t, points, out, words);
  return [...Array(m.bones).keys()].map((b) => jointAt(m, out, b));
}
const apart = (a: Vec[], b: Vec[]) => Math.max(...a.map((v, i) => Math.hypot(v[0] - b[i][0], v[1] - b[i][1], v[2] - b[i][2])));
/** The pose a clip holds, as a mood drawn alone. */
const holding = (m: PoseModel, clip: string, t: number) =>
  bones(m, { id: 'ref', samples: still, moves: [], moods: [{ since: 0, words: 'ref', like: clip }] }, t);
const mid = (g: GestureRecord) => (g.move.ends[0] + g.move.ends[1]) / 2;

test('A1: a gesture with no clip of its own is drawn as the stand-in the agent named, with a caption of its words', () => {
  for (const g of gestures) {
    const t = mid(g), p = poseAt(six, today, t, points, everyone);
    assert.equal(name(today, p.gesture), g.like ?? 'Idle', `${SAID[g.words]}: its stand-in, or the neutral one`);
    assert.equal(p.gestureWeight, 1);
    assert.equal(p.caption, SAID[g.words]);
    if (g.like) assert.ok(apart(bones(today, six, t), holding(today, g.like, t)) < 0.001, `${SAID[g.words]}: the stand-in's bones`);
    // A viewer that may not see the words draws the same stand-in, uncaptioned.
    const q = poseAt(six, today, t, points, nobody);
    assert.equal(q.gesture, p.gesture);
    assert.equal(q.caption, null);
  }
});

test('A2: the same record, replayed with a real clip added, draws the clip', () => {
  const g = gestures[1], t = mid(g);
  const replayed: BodyRecord = JSON.parse(JSON.stringify(six));
  assert.equal(name(today, poseAt(replayed, today, t, points, everyone).gesture), 'Celebration');
  const p = poseAt(replayed, later, t, points, everyone);
  assert.equal(name(later, p.gesture), 'Cartwheel');
  assert.equal(p.caption, 'do a cartwheel');
  const drawn = bones(later, replayed, t);
  assert.ok(apart(drawn, holding(later, 'Cartwheel', t)) < 0.001, 'the real clip\'s bones');
  assert.ok(apart(drawn, holding(later, 'Celebration', t)) > 0.1, 'not the stand-in');
  // The clip is chosen by the words: a viewer that may not see them still draws the stand-in.
  assert.equal(name(later, poseAt(replayed, later, t, points, nobody).gesture), 'Celebration');
});

test('A3: a mood is held until changed and survives a walk', () => {
  // Stands 0–3 s, walks 6 m along +z 3–8 s, stands; bored from 1 s, shy from 12 s, cleared at 14 s.
  const samples = [...Array(161).keys()].map((k) => ({ at: k * S / 10, pos: [0, 0, Math.min(6, Math.max(0, (k / 10 - 3) * 1.2))] as Vec }));
  const rec: BodyRecord = {
    id: 'body-walks', samples, moves: [],
    moods: [{ since: 1 * S, words: 'w1', like: 'Idle_Tired_Loop' }, { since: 12 * S, words: 'w2', like: 'Idle_FoldArms_Loop' }, { since: 14 * S, words: null }],
  };
  const at = (t: number) => poseAt(rec, today, t, points, everyone);
  assert.equal(name(today, at(0.5 * S).idle), 'Idle', 'no mood before it is set');
  for (const t of [2 * S, 10 * S, 11.9 * S]) {
    const p = at(t);
    assert.equal(name(today, p.idle), 'Idle_Tired_Loop', `bored at ${t / S} s`);
    assert.equal(p.caption, 'look bored');
    assert.equal(p.walkWeight, 0);
  }
  assert.equal(at(5.5 * S).walkWeight, 1, 'walking at 5.5 s');
  assert.equal(name(today, at(5.5 * S).idle), 'Idle_Tired_Loop', 'held while walking');
  assert.ok(apart(bones(today, rec, 10 * S), holding(today, 'Idle_Tired_Loop', 10 * S)) < 0.001, 'drawn bored after the walk');
  assert.equal(name(today, at(13 * S).idle), 'Idle_FoldArms_Loop', 'changed');
  assert.equal(name(today, at(15 * S).idle), 'Idle', 'cleared');
  assert.equal(at(15 * S).caption, null);
});

test('A4: the six draw the same from their record replayed, in any order', () => {
  const times = [...Array(14 * 30 + 1).keys()].map((k) => Math.round((k * S) / 30));
  const live = new Map(times.map((t) => [t, bones(today, six, t)]));
  const replayed: BodyRecord = JSON.parse(JSON.stringify(six));
  const shuffled = [...times].sort((a, b) => ((a * 7919) % 1009) - ((b * 7919) % 1009));
  let worst = 0;
  for (const t of shuffled) worst = Math.max(worst, apart(live.get(t)!, bones(today, replayed, t)));
  assert.ok(worst < 0.001, `worst ${worst} m`);
  // Each of the six is captioned in its turn: the moods before the gestures, the shy mood after them.
  const seen: string[] = [];
  for (const t of times) {
    const c = poseAt(replayed, today, t, points, everyone).caption;
    if (c !== null && c !== seen[seen.length - 1]) seen.push(c);
  }
  assert.deepEqual(seen, ['look bored', 'be shy', 'cry', 'be shy', 'do a cartwheel', 'be shy', 'shrug', 'be shy', 'faint', 'be shy']);
  console.log(`A4: ${times.length} frames replayed shuffled, worst ${(worst * 1000).toFixed(4)} mm; captions ${seen.join(' / ')}`);
});
