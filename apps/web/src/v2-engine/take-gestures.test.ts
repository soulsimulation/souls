// #3756 on the old page: a v2 gesture move plays the old renderer's gesture pose as the take's activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { readFileSync } from 'node:fs';
import { ACTIVITY_OVERLAYS, CYCLES, FACE_DOWN, LYING } from '../../../../mars/viewer/app/engine-view/activity-poses.ts';
import { cut, endGesture, gestureAt, gestureFrom, gestureOf, LOOP_HOLD } from './take-gestures.ts';
import { chunkOf, TICK_US, type Body } from './takes.ts';

const FROM = 2000, t0 = FROM * TICK_US, frame = { rulesVersion: 'test/1', datetime: null };

test('every move a body form runs plays a pose of its own, never another move\'s; object moves draw nothing', () => {
  // The moves the humanoid's forms run (content/kinds/body/humanoid.json), as a body offers them.
  const humanoid = JSON.parse(readFileSync(new URL('../../../../content/kinds/body/humanoid.json', import.meta.url), 'utf8'));
  const moves = [...new Set(Object.values(humanoid.forms as Record<string, { steps: { step: string; move?: string }[] }>)
    .flatMap((f) => f.steps.filter((s) => s.step === 'move').map((s) => s.move!)))];
  assert.ok(moves.length >= 24, `the humanoid runs ${moves.length} moves`);
  const known = new Set([...ACTIVITY_OVERLAYS, ...CYCLES, ...LYING, ...FACE_DOWN]);
  const poses = new Map<string, string>();
  for (const move of moves) {
    const pose = gestureOf(`eden:${move}`);
    assert.ok(pose && known.has(pose), `${move} plays an old pose (${pose})`);
    assert.ok(!poses.has(pose!), `${move} and ${poses.get(pose!)} would share ${pose}`);
    poses.set(pose!, move);
  }
  for (const [move, want] of [['souls:nod@1', 'nod'], ['shake_head', 'shake-head'], ['shrug', 'shrug'], ['look_around', 'look-around'], ['slump', 'slump']])
    assert.equal(gestureOf(move), want, move);
  for (const move of ['consume', 'pour', 'souls:walk', 'hold_hand']) assert.equal(gestureOf(move), null, move);
});

test('a standing body plays the gesture from the move start to its end, then stands idle; a cancel ends it early', () => {
  const g = gestureFrom({ name: 'eden:clap', start: t0 + 200_000, ends: [t0 + 400_000, t0 + 600_000] })!;
  const body: Body = { entity: 'v2_a_1', soul: 'soul-a-1', name: 'Ada', heading: 0, samples: [{ at: t0 - 1_000_000, p: [0, 0, 0] }], gestures: [g] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take, at = (s: number) => sampleTake(take, s).entities.v2_a_1.activity;
  assert.equal(at(0.1), 'idle');
  assert.equal(at(0.3), 'clap');
  assert.equal(at(0.55), 'clap');
  assert.equal(at(0.7), 'idle');
  cut(body.gestures!, t0 + 300_000);
  assert.equal(gestureAt(body.gestures, t0 + 350_000), null, 'the run ended at 0.3 s');
  assert.equal(gestureAt(body.gestures, t0 + 250_000), 'clap');
});

test('a seated body keeps sitting through a gesture', () => {
  const g = gestureFrom({ name: 'eden:nod', start: t0, ends: [t0 + 900_000] })!;
  const body: Body = { entity: 'v2_a_2', soul: 'soul-a-2', name: 'Bo', heading: 0, gestures: [g],
    samples: [{ at: t0 - 1_000_000, p: [0, 0, 0], seat: { height: 450, lie: false } }] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take;
  assert.equal(sampleTake(take, 0.5).entities.v2_a_2.activity, 'sit');
});

test('0.134 B4: a handshake aimed at another body faces it and names it the partner; a held hand is a hand hold', () => {
  const a = (target: string, name: string, end: number) => gestureFrom({ name, start: t0, ends: [t0 + 600_000, end], target })!;
  // A stands at (0, 0) facing +x (heading 0); B stands 0.6 m away along +z.
  const A: Body = { entity: 'v2_a', node: 'n-a', soul: 's-a', name: 'Ada', heading: 0, samples: [{ at: t0 - 1_000_000, p: [0, 0, 0] }], gestures: [a('n-b', 'eden:handshake', t0 + 800_000)] };
  const B: Body = { entity: 'v2_b', node: 'n-b', soul: 's-b', name: 'Bo', heading: Math.PI, samples: [{ at: t0 - 1_000_000, p: [0, 0, 600] }],
    gestures: [a('n-a', 'eden:hold_hand', Number.MAX_SAFE_INTEGER)] };
  const take = chunkOf([A, B], FROM, frame).take as unknown as Take;
  const at = (s: number) => sampleTake(take, s).entities;
  assert.equal(at(0.5).v2_a.activity, 'handshake');
  assert.ok(Math.abs(at(0.5).v2_a.yaw - Math.PI / 2) < 0.01, `A faces B: ${at(0.5).v2_a.yaw}`);
  assert.equal(at(0.5).v2_a.state.partner, 'v2_b', 'B is the partner the paired pose meets');
  assert.equal(at(0.95).v2_a.state.partner, null, 'no partner once the handshake ends');
  assert.equal(at(0.5).v2_b.activity, 'idle', 'a hold is not a pose');
  assert.deepEqual(at(0.5).v2_b.state.handHold, { with: 'v2_a', hand: 'right' }, 'B holds A\'s hand');
  assert.ok(Math.abs(Math.abs(at(0.5).v2_b.yaw) - Math.PI / 2) < 0.01, 'B faces A');
});

test('0.134 B4: a gesture at the body itself (a wave where it stands) names no partner', () => {
  const g = gestureFrom({ name: 'eden:wave', start: t0, ends: [t0 + 800_000], target: 'n-c' })!;
  const C: Body = { entity: 'v2_c', node: 'n-c', soul: 's-c', name: 'Cy', heading: 0, samples: [{ at: t0 - 1_000_000, p: [0, 0, 0] }], gestures: [g] };
  const e = sampleTake(chunkOf([C], FROM, frame).take as unknown as Take, 0.5).entities.v2_c;
  assert.equal(e.activity, 'wave');
  assert.equal(e.state.partner ?? null, null, 'not its own partner');
  assert.ok(Math.abs(e.yaw) < 0.01, 'it does not turn');
});

test('an aimed gesture (0.134 B1) turns the standing body toward its target while it plays, then back', () => {
  // a lamp 6 m off along +z; the body last walked along +x, so it faces +x (yaw 0)
  const g = gestureFrom({ name: 'eden:point', start: t0 + 200_000, ends: [t0 + 700_000] }, [0, 6000])!;
  const body: Body = { entity: 'v2_a_3', soul: 'soul-a-3', name: 'Cy', heading: 0, gestures: [g],
    samples: [{ at: t0 - 2_000_000, p: [-1000, 0, 0] }, { at: t0 - 1_000_000, p: [0, 0, 0] }] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take, at = (s: number) => sampleTake(take, s).entities.v2_a_3;
  assert.ok(Math.abs(at(0.1).yaw) < 0.01, 'before: as it walked');
  assert.equal(at(0.4).activity, 'point');
  assert.ok(Math.abs(at(0.4).yaw - Math.PI / 2) < 0.01, `pointing, it faces the lamp: ${at(0.4).yaw}`);
  assert.ok(Math.abs(at(0.9).yaw) < 0.01, 'after: back as it stood');
  const seated: Body = { ...body, entity: 'v2_a_4', samples: [{ at: t0 - 1_000_000, p: [0, 0, 0], seat: { height: 450, lie: false } }] };
  assert.ok(Math.abs(sampleTake(chunkOf([seated], FROM, frame).take as unknown as Take, 0.4).entities.v2_a_4.yaw) < 0.01, 'seated, it keeps its seat\'s way');
  assert.equal(gestureFrom({ name: 'eden:clap', start: t0, ends: [t0 + 1] })!.toward, undefined, 'no target: unaimed');
});

test('0.134 T3: dancers on one beat dance on between cycles, in step (one partner phase), and stop after the last', () => {
  // Each cycle 0.8 s, the next on the next whole beat 0.3 s after it ends; aimed at the dancer's own body.
  const cycle = (node: string, start: number) => gestureFrom({ name: 'eden:dance', start, ends: [start + 400_000, start + 800_000], target: node, run: 'act-1' })!;
  const cycles = (node: string) => [cycle(node, t0), cycle(node, t0 + 1_100_000)];
  const A: Body = { entity: 'v2_a', node: 'n-a', soul: 's-a', name: 'Ada', heading: 0, samples: [{ at: t0 - 1_000_000, p: [0, 0, 0] }], gestures: cycles('n-a') };
  const B: Body = { entity: 'v2_b', node: 'n-b', soul: 's-b', name: 'Bo', heading: 0, samples: [{ at: t0 - 1_000_000, p: [1500, 0, 0] }], gestures: cycles('n-b') };
  const C: Body = { entity: 'v2_c', node: 'n-c', soul: 's-c', name: 'Cy', heading: 0, samples: [{ at: t0 - 1_000_000, p: [3000, 0, 0] }],
    gestures: [{ ...cycle('n-c', t0), run: 'act-2' }] };
  const take = chunkOf([A, B, C], FROM, frame, 60).take as unknown as Take, at = (s: number) => sampleTake(take, s).entities;
  for (const s of [0.4, 0.95, 1.5]) {
    assert.equal(at(s).v2_a.activity, 'dance', `A dances at ${s} s`);
    assert.equal(at(s).v2_b.activity, 'dance', `B dances at ${s} s`);
    assert.equal(at(s).v2_b.state.partner, 'v2_a', 'B dances in step with A');
    assert.equal(at(s).v2_a.state.partner ?? null, null, 'the first names none');
    assert.ok(Math.abs(at(s).v2_a.yaw) < 0.01, 'a dance at oneself turns nothing');
  }
  assert.equal(at(0.4).v2_c.state.partner ?? null, null, 'another dance is not in step with this one');
  assert.equal(at((1_100_000 + 800_000 + LOOP_HOLD + 100_000) / 1e6).v2_a.activity, 'idle', 'stopped after the last cycle');
});

test('0.134 T2: a held hand let go (its record again, ended) ends that hold then', () => {
  const g = gestureFrom({ name: 'eden:hold_hand', start: t0, ends: [t0 + 500_000, Number.MAX_SAFE_INTEGER], target: 'n-b' })!;
  const other = gestureFrom({ name: 'eden:wave', start: t0 + 100_000, ends: [t0 + 900_000] })!;
  const gestures = [g, other];
  endGesture(gestures, t0, t0 + 2_000_000);
  assert.equal(g.end, t0 + 2_000_000);
  assert.equal(other.end, t0 + 900_000, 'another move is left as it was');
});
