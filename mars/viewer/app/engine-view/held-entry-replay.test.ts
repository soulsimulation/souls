import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTER_WIRE } from './character-wire.ts';
import { templateFromGltf } from './people.ts';
import { HumanViews, setHumanGround, type SampledHuman } from './humans.ts';
import { TakePeople } from './take-replay.ts';
import { recordedHeldSet, recordedConsumeMove } from './held-entry.ts';
import { addAll, emptyWorld, human } from '../../engine/world/factory.ts';
import { provingGround } from '../../engine/scenes/proving-ground.ts';
import { chunkOf } from '../../../../apps/web/src/v2-engine/takes.ts';
import type { Take } from '../../engine/take/types.ts';

const held = (observedAt: number, soup?: number) => recordedHeldSet({ observedAt, entries: soup === undefined ? [] : [{
  id: 'same-bowl', kind: 'eden:soup_bowl@abc', parent: 'native-body', slot: null, pos: [120000, 900000, 0],
  rot: [2 ** 30, 0, 0, 0], fields: { 28: soup }, state: { soup } }] })!;

test('take replay delivers sampled held records to the human view through forward, interrupted and retrospective frames', () => {
  const observations = [held(0, 2), held(500_000, 1), held(1_000_000, 0), held(1_500_000), held(1_600_000, 2)];
  const chunk = chunkOf([{ entity: 'person', soul: 'soul', name: 'Person', heading: .25,
    samples: [{ at: 0, p: [1000, 0, -1000] }], heldEntries: observations,
    held: [{ at: 0, prop: 'plate' }, { at: 1_500_000, prop: null }, { at: 1_600_000, prop: 'plate' }],
    gestures: [{ start: 0, end: 1_500_000, activity: 'nod' }, { start: 1_500_000, end: 2_000_000, activity: 'wave' }] }],
    0, { rulesVersion: 'held-test', datetime: null }, 40);
  const people = new TakePeople(JSON.parse(JSON.stringify(chunk.take)) as Take);
  const humans = (people as unknown as { humans: HumanViews }).humans;
  const frames: SampledHuman[][] = [];
  humans.setFrame = frame => { frames.push(frame); };
  try {
    for (const [seconds, soup] of [[.25, 2], [.75, 1], [1.25, 0], [1.55, undefined], [1.7, 2], [.25, 2], [1.25, 0]] as const) {
      people.show(seconds, 50 + seconds);
      const person = frames.at(-1)!.find(p => p.id === 'person')!;
      assert(person.heldEntries, 'actual replay must project metadata into its production HumanViews input');
      assert.equal(person.heldEntries.entries[0]?.state?.soup, soup);
      assert.deepEqual(person.p, [1, 0, -1]); assert(Math.abs(person.yaw - .25) < 1e-12);
      assert.equal(person.activity, seconds < 1.5 ? 'nod' : 'wave');
      if (seconds < 1.5 || seconds >= 1.6) assert.equal(person.prop, 'plate');
    }
    const legacy = structuredClone(chunk.take) as unknown as Take;
    legacy.changes = legacy.changes.filter(c => c[2] !== 'heldEntries');
    people.setTake(legacy);
    people.show(.25, 50.25);
    assert.equal(frames.at(-1)![0].heldEntries, undefined, 'historical string-only takes remain unknown');
  } finally { people.dispose(); }
});

test('actual replay preserves the previous native hand-record projection for absent, falsy and present owners at the sampled clock', () => {
  const source = chunkOf([{ entity: 'person', soul: 'soul', name: 'Person', heading: 0, samples: [{ at: 0, p: [0, 0, 0] }] }],
    120, { rulesVersion: 'held-test', datetime: null }, 40).take as unknown as Take;
  const present = { handActuator: { target: 'lamp', at: [0, 1, 0], startTick: 120 },
    handTransferV1: { mode: 'take', hand: 'right', startTick: 120, reach: .65 },
    wateringV1: { item: 'can', target: 'bed', stage: 'pour', face: 0, hold: [0, 1, 0], seconds: 1, levelAfter: .5, startTick: 120 },
    letGoV1: { startTick: 120, seconds: 1.1 },
    cupV1: { item: 'cup', stage: 'drink', face: 0, hand: 'right', startTick: 120, cupYaw: 0, spin: 0 } };
  const states = [{}, { handActuator: null, handTransferV1: false, wateringV1: 0, letGoV1: '', cupV1: undefined }, present];
  for (const state of states) {
    const take = structuredClone(source);
    for (const [key, value] of Object.entries(state)) take.changes.push([0, 'person', key, value]);
    const people = new TakePeople(take), views = (people as unknown as { humans: HumanViews }).humans;
    let actual: SampledHuman | undefined;
    views.setFrame = frame => { actual = frame[0]; };
    try {
      // Fractional sample time catches accidentally using the render clock, integer ticks or chunk-relative time.
      people.show(.675, 9000);
      const time = (120 + 13.5) * .05; // preserve the old expression's exact floating-point result
      const old: Partial<SampledHuman> = state === present ? {
        handActuator: present.handActuator as SampledHuman['handActuator'], handActuatorTime: time,
        transfer: present.handTransferV1 as SampledHuman['transfer'], transferTime: time,
        watering: present.wateringV1 as SampledHuman['watering'], wateringTime: time,
        letGo: present.letGoV1, letGoTime: time, cup: present.cupV1 as SampledHuman['cup'], cupTime: time,
      } : {};
      for (const field of ['handActuator', 'transfer', 'watering', 'letGo', 'cup'] as const) {
        assert.deepEqual(actual![field], old[field], field + ' keeps the previous exact truthiness and key');
        assert.equal(actual![`${field}Time`], old[`${field}Time`], field + ' keeps its recorded take clock');
      }
    } finally { people.dispose(); }
  }
});

const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
async function productionTemplate() {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'held-test-material', loadMaterial: async () => new THREE.MeshStandardMaterial() }));
  const load = async (file: string) => { const b = await readFile(rigDir + '/' + file); return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
  const wire = CHARACTER_WIRE.woman, mesh = await load(wire.mesh), clips = await load(wire.clips);
  mesh.animations = clips.animations; return templateFromGltf('woman', mesh);
}

test('consume observation is stored and cleared on a production human without gaining pose authority', async () => {
  const source = await productionTemplate(), plain = new HumanViews(), observed = new HumanViews();
  plain.setTemplates([source]); observed.setTemplates([source]); setHumanGround(() => 0);
  const record = recordedConsumeMove({ name: 'souls:consume', body: 'native-body', target: 'same-bowl', start: 0,
    ends: [800_000, 2_000_000, 2_600_000], limbs: ['souls:hand-left', 'souls:voice'], contact: 'bite' })!;
  const person: SampledHuman = { id: 'consume-person', p: [1, 0, -1], yaw: .25, walk: 0, walkDist: 0, activity: 'nod', activityAge: .7 };
  try {
    plain.setFrame([person], 70); plain.render(1);
    observed.setFrame([{ ...person, consumeMove: record }], 70); observed.render(1);
    assert.equal(observed.consumeMoveOf(person.id), record);
    const points = plain.meshPoints(person.id, 1);
    assert(points.length > 1000);
    assert.deepEqual(observed.meshPoints(person.id, 1), points, 'metadata adds no consume pose, hand or root displacement');
    observed.setFrame([person], 70);
    assert.equal(observed.consumeMoveOf(person.id), undefined, 'legacy sampled input clears a prior observation');
    observed.setFrame([{ ...person, consumeMove: record }], 70);
    const world = addAll(emptyWorld('consume-test', provingGround()), human(person.id, 1, -1));
    observed.onTick(world);
    assert.equal(observed.consumeMoveOf(person.id), undefined, 'old tick input makes no consume claim');
  } finally { plain.clear(); observed.clear(); setHumanGround(null); }
});

test('held metadata adds no pose, attachment or movement authority over standing, seated, native-hand and paired-contact rigs', async () => {
  const source = await productionTemplate(), old = new HumanViews(), current = new HumanViews();
  old.setTemplates([source]); current.setTemplates([source]); setHumanGround(() => 0);
  const controls: Partial<SampledHuman>[] = [{ activity: 'nod' }, { activity: 'nod', baseActivity: 'sit', seatHeight: .45 },
    { activity: 'nod', hands: { left: [1.15, 1.1, -.8] } },
    { activity: 'handshake', partner: 'partner' }, { activity: 'idle', handHold: { with: 'partner', hand: 'left', since: 0 } as SampledHuman['handHold'], handGameTick: 1400, handGameDt: .05 },
    { activity: 'idle', handActuator: { target: 'switch', at: [1.3, 1.1, -1], startTick: 1395 }, handActuatorTime: 70 },
    { activity: 'idle', transfer: { mode: 'take', hand: 'right', startTick: 1395, reach: .65 }, transferTime: 70 },
    { activity: 'idle', watering: { item: 'can', target: 'bed', stage: 'pour', face: .25, hold: [1.3, 1.1, -1], seconds: 1, levelAfter: .5, startTick: 1395 }, wateringTime: 70 },
    { activity: 'idle', letGo: { startTick: 1395, seconds: 1.1 }, letGoTime: 70 },
    { activity: 'idle', cup: { item: 'cup', stage: 'drink', face: .25, hand: 'right', startTick: 1395, sips: 1, from: 1, sip: .5, cupYaw: 0, spin: 0 }, cupTime: 70 }];
  try {
    for (const control of controls) for (const observation of [held(0, 2), held(500_000, 1), held(1_000_000, 0), held(1_500_000), held(0, 2)]) {
      const person: SampledHuman = { id: 'metadata-person', p: [1, 0, -1], yaw: .25, walk: 0, walkDist: 0, activityAge: .7, ...control };
      const partner: SampledHuman = { id: 'partner', p: [1.8, 0, -1], yaw: Math.PI, walk: 0, walkDist: 0, activity: 'handshake', activityAge: .7, partner: person.id };
      old.setFrame([person, partner], 70); old.render(1);
      current.setFrame([{ ...person, heldEntries: observation }, partner], 70); current.render(1);
      assert.deepEqual(current.heldEntriesOf(person.id), observation);
      assert.equal(old.heldEntriesOf(person.id), undefined);
      const before = old.meshPoints(person.id, 1), after = current.meshPoints(person.id, 1);
      assert(before.length > 1000, 'compare nonempty full production body/feet, not bone targets');
      assert.deepEqual(after, before, 'metadata must not move a hand, foot, body root or existing native/paired contact');
      assert.deepEqual(person.p, [1, 0, -1]);
    }
  } finally { old.clear(); current.clear(); setHumanGround(null); }
});

test('held, seat and clip origins retain their own native identity, old point target and absolute observation clocks', () => {
  const start = 100_000_000, at = (s: number) => start + s * 1e6;
  const nativeHands = { body: 'native-body', kindHash: 'ab'.repeat(32), resources: [['souls:hand-left', 2, 7], ['souls:hand-right', 2, 4]] as const };
  const observation = (s: number, soup?: number) => ({ ...held(at(s), soup), entries: held(at(s), soup).entries.map(e => ({ ...e, slot: 7 })) });
  const consume = recordedConsumeMove({ name: 'souls:consume', body: 'native-body', target: 'same-bowl', start: at(.1), ends: [at(.2), at(.4), at(.6)], limbs: ['souls:hand-left', 'souls:voice'] })!;
  const body = { entity: 'composed', soul: 'fixture-soul', name: 'Composed', heading: .25,
    samples: [{ at: at(0), p: [1000, 0, -1000] as [number, number, number] }, { at: at(.8), p: [1000, 0, -1000] as [number, number, number], seat: { height: 465, lie: false, heading: .25 } }, { at: at(2), p: [1000, 0, -1000] as [number, number, number] }],
    heldEntries: [observation(0), observation(1, 2), observation(1.1), observation(1.2, 1)], consumes: [consume], held: [{ at: at(1), prop: 'plate' }, { at: at(1.1), prop: null }, { at: at(1.2), prop: 'plate' }],
    look: { family: 'humanoid', model: 'casual', params: {}, nativeBody: nativeHands.body, nativeKindHash: nativeHands.kindHash, nativeResources: nativeHands.resources },
    gestures: [{ start: at(.3), end: at(.9), activity: 'point', target: 'old-question', toward: [3000, 3000] as [number, number], point: { hand: 'right' as const, ends: [at(.6), at(1.2)] } }] };
  const take = chunkOf([body], start / 50_000, { rulesVersion: 'composed-history', datetime: null }, 60).take as unknown as Take;
  const people = new TakePeople(take), views = (people as unknown as { humans: HumanViews }).humans;
  let current: SampledHuman | undefined; views.setFrame = frames => { current = frames[0]; };
  const show = (s: number) => { people.show(s, 9000); return current!; };
  try {
    const seated = show(.85), origin = seated.seatOrigin!.sample!;
    assert.deepEqual(origin.nativeHands, nativeHands); assert.deepEqual(origin.heldEntries, observation(0));
    assert.deepEqual(origin.consumeMove, consume); assert.equal(origin.bodyModel, 'casual');
    assert.equal(origin.pointAim?.target, 'old-question'); assert(origin.pointAimTime! < at(.8));
    const changed = show(1.05), old = changed.heldArmOrigin!.sample;
    assert.deepEqual(old.nativeHands, nativeHands); assert.deepEqual(old.heldEntries, observation(0));
    assert.equal(old.pointAim?.target, 'old-question'); assert(old.pointAimTime! < at(1));
    assert(old.seatOrigin?.sample, 'the attained held predecessor retains the ongoing seat entry');
    const saved = structuredClone(changed.heldArmOrigin);
    show(1.15); show(1.25); assert.deepEqual(changed.heldArmOrigin, saved, 'release/re-lift cannot mutate published predecessor snapshots');
    assert.deepEqual(show(1.05).heldArmOrigin, saved, 'cold/backward reconstruction uses the same world-time context');
    const cold = new TakePeople(take), coldViews = (cold as unknown as { humans: HumanViews }).humans;
    let fresh: SampledHuman | undefined; coldViews.setFrame = frames => { fresh = frames[0]; };
    try { cold.show(1.05, 9000); assert.deepEqual(fresh!.heldArmOrigin?.sample, old); } finally { cold.dispose(); }
  } finally { people.dispose(); }
});

test('historical reconstruction refuses an unadmitted body model and keeps the actual current rig', async () => {
  const template = await productionTemplate(), p: SampledHuman = { id: 'admitted-history', bodyModel: 'woman', p: [1, 0, -1], yaw: .25, walk: 0, walkDist: 0, activity: 'nod', activityAge: .1 };
  const source: SampledHuman = { ...p, activity: 'wave', activityAge: .7 };
  const draw = (origin?: SampledHuman) => {
    const views = new HumanViews(); views.setTemplates([template]); views.setBodyTemplates(new Map([['woman', template]]));
    try { views.setFrame([{ ...p, ...(origin ? { clipOrigin: { age: .1, sample: origin } } : {}) }], 70); views.render(1);
      assert.deepEqual(views.bodyObject(p.id)!.position.toArray(), p.p); return views.meshPoints(p.id, 1);
    } finally { views.clear(); }
  };
  setHumanGround(() => 0);
  try {
    const expected = draw(), refused = draw({ ...source, bodyModel: 'not-admitted' }), supported = draw(source);
    assert(expected.length > 1000, 'compare nonempty submitted production skin');
    assert.deepEqual(refused, expected, 'unknown historical admission cannot be rebound to the current skeleton');
    assert.notDeepEqual(supported, expected, 'the same admitted model still reconstructs its actual old wave');
  } finally { setHumanGround(null); }
});
