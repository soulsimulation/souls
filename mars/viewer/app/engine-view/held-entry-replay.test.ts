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
import { recordedHeldSet } from './held-entry.ts';
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
    for (const [seconds, soup] of [[.25, 2], [.75, 1], [1.25, 0], [1.55, undefined], [1.7, 2], [.25, 2], [1.25, 0]]) {
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

const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
async function productionTemplate() {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'held-test-material', loadMaterial: async () => new THREE.MeshStandardMaterial() }));
  const load = async (file: string) => { const b = await readFile(rigDir + '/' + file); return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
  const wire = CHARACTER_WIRE.woman, mesh = await load(wire.mesh), clips = await load(wire.clips);
  mesh.animations = clips.animations; return templateFromGltf('woman', mesh);
}

test('held metadata adds no pose, attachment or movement authority over standing, seated, native-hand and paired-contact rigs', async () => {
  const source = await productionTemplate(), old = new HumanViews(), current = new HumanViews();
  old.setTemplates([source]); current.setTemplates([source]); setHumanGround(() => 0);
  const controls: Partial<SampledHuman>[] = [{ activity: 'nod' }, { activity: 'nod', baseActivity: 'sit', seatHeight: .45 },
    { activity: 'nod', hands: { left: [1.15, 1.1, -.8] } },
    { activity: 'handshake', partner: 'partner' }, { activity: 'idle', handHold: { with: 'partner', hand: 'left', since: 0 } as SampledHuman['handHold'], handGameTick: 1400, handGameDt: .05 }];
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
