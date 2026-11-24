// Carrying together and building with parts (0.135 C, A): what each `carry` and `part` command sends, read from the
// copy's poses and the kind entries, and what the asked Soul's `wait` shows.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { offerNote } from '../converse/converse.mjs';
import { requestOf } from '../cli/souls.mjs';
import { activityPin, carryIntents, crewsIn, gripSpot, loadOf, placer, slotPoint } from './carry.mjs';

const ROOT = join(import.meta.dirname, '../../../../content/kinds');
const entry = (dir, f) => JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8'));
const id = (n) => `${'ab'.repeat(16)}-${n}`;
const kinds = Object.fromEntries(['carry', 'rack_beam', 'rack_upright', 'rack_bay', 'frame_stand'].map((f) => { const e = entry('construction', `${f}.json`); return [e.kind, e]; }));
const ONE = 2 ** 30, YAW90 = [Math.round(ONE * Math.SQRT1_2), 0, Math.round(ONE * Math.SQRT1_2), 0];
const near = (a, b, what) => a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 2, `${what}: ${a} vs ${b}`));

test('a crew is offered by the name the world serves it by; worked out from its entry only when it serves none', () => {
  assert.match(activityPin('mars:carry', kinds['mars:carry']), /^mars:carry_activity@1220[0-9a-f]{64}$/);
  assert.equal(activityPin('mars:rack_beam', kinds['mars:rack_beam']), null, 'no roles: no activity');
  const ctx = { ns: 'mars', ground: id(1), kinds, me: id(2), placeOf: () => null, kindOf: () => null };
  const served = { format: 'souls-activities/1', activities: [{ kind: 'mars:carry', name: `mars:carry_activity@1220${'cd'.repeat(32)}` }] };
  assert.equal(carryIntents({ do: 'offer', to: [id(3)] }, { ...ctx, served })[0].params[1], served.activities[0].name);
  assert.equal(carryIntents({ do: 'offer', to: [id(3)] }, ctx)[0].params[1], activityPin('mars:carry', kinds['mars:carry']));
});

// A copy: the ground, a beam lying along z at (2, 6) m, a stand at (0, 6) holding a frame in its first slot, a bay at
// (12, 6), this Soul's body at (0, 3.65) and its partner's at (0, 8.05); a crew holding the frame.
const rows = new Map([
  [id(1), { id: id(1), kind: 'eden:ground', parent: null }],
  [id(2), { id: id(2), kind: 'mars:rack_beam', parent: id(1), pos: [2e6, 0, 6e6] }],
  [id(3), { id: id(3), kind: 'mars:frame_stand', parent: id(1), pos: [0, 0, 6e6] }],
  [id(4), { id: id(4), kind: 'mars:rack_upright', parent: id(3), pos: [0, 0, 0] }],
  [id(5), { id: id(5), kind: 'mars:rack_bay', parent: id(1), pos: [12e6, 0, 6e6] }],
  [id(6), { id: id(6), kind: 'souls:body', parent: id(1), pos: [0, 0, 3.65e6] }],
  [id(7), { id: id(7), kind: 'souls:body', parent: id(1), pos: [0, 0, 8.05e6] }],
  [id(8), { id: id(8), kind: 'mars:carry_activity', parent: id(1) }],
  [id(9), { id: id(9), kind: 'mars:rack_beam', parent: id(1), pos: [-12e6, 0, 20e6], rot: YAW90 }],
]);
const at = placer(rows, (n) => (n === id(4) ? 1 : null), (r) => kinds[r?.kind]);
const ctx = { ns: 'eden', ground: id(1), kinds, me: id(6), placeOf: at, kindOf: (n) => rows.get(n)?.kind, crewMiddle: () => [0, 6e6] };
const send = (req) => carryIntents(req, ctx);

test('a thing in a slot stands from the slot\'s point, as the world composes it', () => {
  near(at(id(4)).pos, [0, 100_000, 5.85e6], 'the frame in the stand\'s first slot');
  assert.deepEqual(slotPoint(at(id(5)), kinds['mars:rack_bay'], 'beam_low_l'), { n: 5, name: 'beam_low_l', point: [12e6 - 572_000, 6e6], yaw: 0 });
  assert.equal(slotPoint(at(id(5)), kinds['mars:rack_bay'], 'roof'), null);
});

test('the crew is offered, joined and left; the load lifted and set down', () => {
  const [offer] = send({ do: 'offer', to: [id(7)] });
  assert.deepEqual(offer, { verb: 'activity:offer', target: id(1), params: { 1: activityPin('mars:carry', kinds['mars:carry']), 2: 'mars:front', 3: [id(7)] } });
  assert.equal(send({ do: 'offer', to: [id(7)], on: id(4) })[0].target, id(4), 'a hold crew is offered on the part');
  assert.deepEqual(send({ do: 'accept', crew: id(8) }), [{ verb: 'activity:accept', target: id(8) }]);
  assert.deepEqual(send({ do: 'leave', crew: id(8) }), [{ verb: 'activity:leave', target: id(8) }]);
  assert.deepEqual(send({ do: 'lift', crew: id(8), load: id(2) }), [{ verb: 'carry:lift', target: id(8), params: { 1: id(2) } }]);
  assert.deepEqual(send({ do: 'set-down', crew: id(8) }), [{ verb: 'carry:set-down', target: id(8) }]);
  assert.equal(send({ do: 'offer', to: [] }).code, 'carry-usage');
  assert.equal(carryIntents({ do: 'offer', to: [id(7)] }, { ...ctx, kinds: {} }).code, 'carry-kind-unknown');
  assert.equal(carryIntents({ do: 'lift', crew: id(8), load: id(2) }, { ...ctx, ground: null }).code, 'carry-no-ground');
});

test('a grip is the load\'s place from its entry; a standing part\'s 2.2 m along its z; beside it 1.2 m along its x', () => {
  const beam = loadOf(kinds['mars:rack_beam']);
  assert.deepEqual(beam.places, [-1_447_000, 1_447_000]);
  const walk = (req) => send(req)[0].params[1];
  near(walk({ do: 'grip', thing: id(2), end: 'front' }), [2e6, 0, 6e6 + 1_447_000], 'the beam\'s front');
  near(walk({ do: 'grip', thing: id(2), end: 'back', from: '2.2' }), [2e6, 0, 3.8e6], 'its back, 2.2 m off');
  near(walk({ do: 'grip', thing: id(9), end: 'front' }), [-12e6 + 1_447_000, 0, 20e6], 'a beam turned east: its front is east');
  near(walk({ do: 'grip', thing: id(4), end: 'back' }), [0, 0, 3.65e6], 'the standing frame\'s back');
  near(walk({ do: 'grip', thing: id(4), end: 'right' }), [1.2e6, 0, 5.85e6], 'beside the frame');
  assert.equal(send({ do: 'grip', thing: id(4), end: 'up' }).code, 'carry-usage');
  near(gripSpot({ pos: [0, 0, 0] }, null, 'front'), [0, 2.2e6], 'no entry: as a standing part');
});

test('carry to walks this Soul so the load reaches the point or the slot, keeping its place at it', () => {
  near(send({ do: 'to', crew: id(8), where: '25,6' })[0].params[1], [25e6, 0, 3.65e6], 'to a point');
  near(send({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' })[0].params[1], [12e6, 0, 6e6 - 1_448_000 - 2.35e6], 'to the bay\'s slot');
  // carriers that stand askew go into a slot square, on its line, each as far from the middle as it is
  near(carryIntents({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' }, { ...ctx, crewMiddle: () => [0.7e6, 6e6] })[0].params[1],
    [12e6, 0, 6e6 - 1_448_000 - Math.hypot(0.7e6, 2.35e6)], 'askew, into the slot');
  assert.equal(send({ do: 'to', crew: id(8), where: id(5), slot: 'roof' }).code, 'part-slot-unknown');
  assert.equal(carryIntents({ do: 'to', crew: id(8), where: '1,2' }, { ...ctx, crewMiddle: () => null }).code, 'carry-crew-unseen');
});

test('a part is taken, seated in a slot by name or number, laid on the ground, or taken out', () => {
  const part = (r) => carryIntents({ kind: 'part', ...r }, ctx);
  assert.deepEqual(part({ do: 'take', crew: id(8), part: id(4) }), [{ verb: 'part:take', target: id(8), params: { 1: id(4) } }]);
  assert.deepEqual(part({ do: 'unseat', crew: id(8), part: id(4) }), [{ verb: 'part:unseat', target: id(8), params: { 1: id(4) } }]);
  assert.deepEqual(part({ do: 'put', crew: id(8), into: id(5), slot: 'beam_low_l' }), [{ verb: 'part:put', target: id(8), params: { 1: id(5), 2: 5 } }]);
  assert.deepEqual(part({ do: 'put', crew: id(8), into: id(5), slot: '2' }), [{ verb: 'part:put', target: id(8), params: { 1: id(5), 2: 2 } }]);
  assert.deepEqual(part({ do: 'put', crew: id(8), into: '2,6' }), [{ verb: 'part:put', target: id(8), params: { 1: id(1), 3: [2e6, 0, 6e6] } }]);
  assert.deepEqual(part({ do: 'put', crew: id(8), into: 'here' }), [{ verb: 'part:put', target: id(8), params: { 1: id(1), 3: [0, 0, 6e6] } }]);
  assert.equal(part({ do: 'put', crew: id(8), into: id(5), slot: 'roof' }).code, 'part-slot-unknown');
  assert.equal(part({ do: 'lift', crew: id(8) }).code, 'part-usage');
});

test('the command line: each step waits for its end; a list does not', () => {
  const r = (...w) => requestOf(w);
  assert.deepEqual(r('carry', 'offer', id(7), id(9), '--on', id(4)), { req: { op: 'carry', do: 'offer', to: [id(7), id(9)], on: id(4) }, soul: undefined, wait: true });
  assert.deepEqual(r('carry', 'grip', id(2), 'back', '--from', '2.2').req, { op: 'carry', do: 'grip', thing: id(2), end: 'back', from: '2.2' });
  assert.deepEqual(r('carry', 'to', id(8), id(5), 'upright_a').req, { op: 'carry', do: 'to', crew: id(8), where: id(5), slot: 'upright_a' });
  assert.deepEqual(r('carry', 'lift', id(8), id(2)).req, { op: 'carry', do: 'lift', crew: id(8), load: id(2) });
  assert.deepEqual(r('part', 'put', id(8), id(5), 'beam_low_l').req, { op: 'carry', do: 'put', kind: 'part', crew: id(8), into: id(5), slot: 'beam_low_l' });
  assert.deepEqual(r('part', 'take', id(8), id(4)).req, { op: 'carry', do: 'take', kind: 'part', crew: id(8), part: id(4) });
  assert.equal(r('carry', 'list').wait, undefined);
});

test('a carry\'s offer reaches the asked Soul as a carry; the crews are listed with what each holds', () => {
  const pin = activityPin('mars:carry', kinds['mars:carry']);
  const ev = { name: 'souls:offer', fields: { 1: id(8), 2: pin, 3: [id(7)], 4: 60_000_000, 5: id(6) } };
  assert.deepEqual(offerNote(ev, id(7)), { kind: 'carry', what: 'offered', offer: id(8), from: id(6) });
  const held = new Map([...rows, [id(10), { id: id(10), name: 'rack_beam 10', kind: 'mars:rack_beam', parent: id(8) }]]);
  assert.deepEqual(crewsIn(held), [{ id: id(8), on: id(1), holds: [{ id: id(10), name: 'rack_beam 10', kind: 'mars:rack_beam' }] }]);
});
