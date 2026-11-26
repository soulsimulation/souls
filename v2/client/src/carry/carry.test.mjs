// Carrying together and building with parts (0.135 C, A): what each `carry` and `part` command sends, read from the
// copy's poses and the kind entries, and what the asked Soul's `wait` shows.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { offerNote } from '../converse/converse.mjs';
import { requestOf } from '../cli/souls.mjs';
import { MOUTH_CLEAR, activityPin, goTime, byName, carryIntents, crewNeeds, crewOffered, crewsIn, gripSpot, loadOf, nextStep, offerNear, openCrewOffers, placer, slotPoint, workLines } from './carry.mjs';
import { newCrew, nextOf } from '../cli/souls.mjs';
import { slotsCard } from '../together/members.mjs';

const ROOT = join(import.meta.dirname, '../../../../content/kinds');
const entry = (dir, f) => JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8'));
const id = (n) => `${'ab'.repeat(16)}-${n}`;
const kinds = Object.fromEntries(['carry', 'rack_beam', 'rack_upright', 'rack_upright_6m', 'rack_bay', 'frame_stand'].map((f) => { const e = entry('construction', `${f}.json`); return [e.kind, e]; }));
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

test('front or back --out stands that far off the part\'s line, outside what it is seated in: it comes down there', () => {
  // The beam along z at (2, 6) as if seated in the bay at (12, 6): its ends 0.9 m off its line, on the side away from the
  // bay (west), both ends the same side; unseated, it comes down at their middle, clear of the bay's posts.
  const seated = { ...ctx, parentOf: (n) => (n === id(2) ? id(5) : rows.get(n)?.parent ?? null) };
  const walk = (req) => carryIntents(req, seated)[0].params[1];
  near(walk({ do: 'grip', thing: id(2), end: 'back', from: '2.2', out: '0.9' }), [1.1e6, 0, 3.8e6], 'its back, outside');
  near(walk({ do: 'grip', thing: id(2), end: 'front', from: '2.2', out: '0.9' }), [1.1e6, 0, 8.2e6], 'its front, the same side');
  near(gripSpot({ pos: [2e6, 0, 6e6] }, loadOf(kinds['mars:rack_beam']), 'back', 2_200_000, { by: 900_000, from: [-5e6, 6e6] }), [2.9e6, 3.8e6], 'away from a bay to its west: east');
  const loose = carryIntents({ do: 'grip', thing: id(2), end: 'back', out: '0.9' }, { ...ctx, parentOf: (n) => rows.get(n)?.parent ?? null });
  assert.equal(loose.code, 'carry-out-unseated', 'a part on the open ground is seated in nothing');
  assert.equal(carryIntents({ do: 'grip', thing: id(2), end: 'right', out: '0.9' }, seated).code, 'carry-usage', 'front or back only');
  assert.equal(carryIntents({ do: 'grip', thing: id(2), end: 'back', out: '9' }, seated).code, 'carry-usage', 'under 5 m');
  assert.deepEqual(requestOf(['carry', 'grip', id(2), 'back', '--from', '2.2', '--out', '0.9']).req, { op: 'carry', do: 'grip', thing: id(2), end: 'back', from: '2.2', out: '0.9' });
});

test('a crew of six takes the 6.1 m frame at its six grips: front, back, and four sides beside the grips between', () => {
  const tall = loadOf(kinds['mars:rack_upright_6m']);
  assert.deepEqual(tall.inner, [-1_649_000, -550_000, 550_000, 1_649_000], 'four grips between its ends');
  assert.equal(tall.halfWidth, 609_500);
  // It stands at (5, 10) m: its front and back on its own z, as far out as a lift checks its ends (3.1 m, --from); the
  // sides beside its grips along that line, half its width and REACH off it, alternating.
  const up = { pos: [5e6, 0, 10e6] }, off = 609_500 + 350_000;
  near(gripSpot(up, tall, 'back', 3_100_000), [5e6, 10e6 - 3_100_000], 'its back');
  near(gripSpot(up, tall, 'front', 3_100_000), [5e6, 10e6 + 3_100_000], 'its front');
  near(gripSpot(up, tall, 'side1'), [5e6 - off, 10e6 - 1_649_000], 'the first side, on its + side');
  near(gripSpot(up, tall, 'side2'), [5e6 + off, 10e6 - 550_000], 'the second, across');
  near(gripSpot(up, tall, 'side4'), [5e6 + off, 10e6 + 1_649_000], 'the fourth');
  // A beam lying along z has one grip between its ends: one side beside its middle, and no second.
  const walk = (req) => send(req)[0].params[1];
  near(walk({ do: 'grip', thing: id(2), end: 'side1' }), [2e6 - 51_000 - 350_000, 0, 6e6], 'the beam\'s side, half its height across (as it is carried, on its edge)');
  const none = send({ do: 'grip', thing: id(2), end: 'side2' });
  assert.equal(none.code, 'carry-grip-unknown');
  assert.match(none.detail, /1 grip between its ends.*a crew of 3 at most/);
  assert.equal(requestOf(['carry', 'grip', id(2), 'side', '2']).req.end, 'side2', 'the command line: side <n>');
});

test('into a slot the crew lines up on the slot\'s axis nearest its line; a side keeps its place beside the load', () => {
  // The crew holds a frame along its x, its back (this Soul) at (-1.13, 6) and its front at (1.13, 6), its middle at
  // (0, 6); its side, another Soul, stands 0.5 m behind the middle and 1 m across.
  const ends = { ids: [id(7), id(6)], at: [[1_130_000, 6e6], [-1_130_000, 6e6]] };
  const posts = { ...ctx, placeOf: (n) => (n === id(6) ? { pos: [-1_130_000, 0, 6e6] } : at(n)), crewEnds: () => ends };
  near(carryIntents({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' }, posts)[0].params[1],
    [12e6 - 1_130_000, 0, 6e6 - 1_448_000], 'its back at its end of the slot\'s x: square in the slot');
  const side = { ...posts, me: id(12), placeOf: (n) => (n === id(12) ? { pos: [-500_000, 0, 7e6] } : posts.placeOf(n)) };
  near(carryIntents({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' }, side)[0].params[1],
    [12e6 - 500_000, 0, 6e6 - 1_448_000 + 1e6], 'a side keeps its place along and across the line');
  // A beam's crew along z lines up on the slot's z, outside the bay on the slot's side (the bay is 1.219 m across).
  const beamEnds = { ...ctx, crewEnds: () => ({ ids: [id(7), id(6)], at: [[0, 8.05e6], [0, 3.65e6]] }) };
  near(carryIntents({ do: 'to', crew: id(8), where: id(5), slot: 'beam_low_l' }, { ...beamEnds, crewMiddle: () => [0, 5.85e6] })[0].params[1],
    [12e6 - 609_500 - MOUTH_CLEAR, 0, 6e6 - 2.2e6], 'the beam\'s back on the slot\'s z, outside the bay');
});

test('a beam slot is reached from its own side: the load stops lined up outside the bay, within put\'s reach of it', () => {
  // The crew holds a beam (along z, as taken) whose middle is at (4, 6.3) m, west of the bay at (12, 6); this Soul is
  // its back, 2.2 m behind; its side stands 0.4 m west of the middle.
  const crew = id(8), held = id(10), r = new Map(rows);
  r.set(held, { id: held, kind: 'mars:rack_beam', parent: crew, pos: [4e6, 0, 6.3e6] });
  const place = placer(r, () => null, (x) => kinds[x?.kind]);
  const c = { ...ctx, placeOf: (n) => (n === id(6) ? { pos: [4e6, 0, 4.1e6] } : place(n)), kindOf: (n) => r.get(n)?.kind, heldBy: () => held, seated: () => [],
    crewMiddle: () => [4e6, 6.3e6], crewEnds: () => ({ ids: [id(7), id(6)], at: [[4e6, 8.5e6], [4e6, 4.1e6]] }) };
  const out = 609_500 + 25_500 + MOUTH_CLEAR;   // the bay's half width, the beam's half width lying, the clearance
  const go = (slot, me = c) => carryIntents({ do: 'to', crew, where: id(5), slot }, me)[0].params[1];
  near(go('beam_low_l'), [12e6 - out, 0, 6e6 - 2.2e6], 'the back, on the slot\'s z, west of the bay');
  assert.ok(out - 572_000 + 300_000 < 1_000_000, 'a walk 0.3 m short of it still puts within reach (worldd PUT_REACH)');
  const side = { ...c, me: id(12), placeOf: (n) => (n === id(12) ? { pos: [3.6e6, 0, 6.3e6] } : c.placeOf(n)) };
  near(go('beam_high_l', side), [12e6 - out - 400_000, 0, 6e6], 'the side keeps its place beside the middle');
  // From the bay's other side the slot across it is carried straight in, as before; a frame's slot (the bay's open end)
  // is carried into directly.
  const east = { ...c, crewMiddle: () => [20e6, 6.3e6], crewEnds: () => ({ ids: [id(7), id(6)], at: [[20e6, 8.5e6], [20e6, 4.1e6]] }), placeOf: (n) => (n === id(6) ? { pos: [20e6, 0, 4.1e6] } : place(n)) };
  near(go('beam_low_l', east), [12e6 - 572_000, 0, 6e6 - 2.2e6], 'from the east, into the slot');
  near(go('beam_low_r', east), [12e6 + out, 0, 6e6 - 2.2e6], 'the east slot from the east: outside it');
  near(go('upright_a'), [12e6, 0, 6e6 - 1_448_000 - 2.2e6], 'a frame\'s slot: into it');
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

test('into a slot, the walk names the load\'s heading there, from its back toward this carrier\'s end: the front\'s turns the crew', () => {
  // This Soul stands on the slot's -z side of the load's middle, so its end of the load goes in at -z.
  assert.deepEqual(send({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' })[0].params[3], [0, -1e6]);
  assert.deepEqual(carryIntents({ do: 'to', crew: id(8), where: id(5), slot: 'upright_a' }, { ...ctx, crewMiddle: () => [0.7e6, 0] })[0].params[3],
    [0, 1e6], 'on the +z side');
  assert.equal(send({ do: 'to', crew: id(8), where: '25,6' })[0].params[3], undefined, 'to a point: no turn');
});

test('a beam carried into a slot past a beam seated at the height it is carried is refused before anyone moves', () => {
  // The bay at (12, 6) m: a beam seated in beam_high_l (slot 3) or beam_low_l (slot 5); the crew holds a beam, its
  // length along the bay's z, west of the bay or east of it.
  const crew = id(8), held = id(10), seated = id(11);
  const copy = (slot) => {
    const r = new Map(rows);
    r.set(held, { id: held, kind: 'mars:rack_beam', parent: crew, pos: [0, 0, 0], rot: YAW90 });
    r.set(seated, { id: seated, kind: 'mars:rack_beam', parent: id(5), pos: [0, 0, 0] });
    const place = placer(r, (n) => (n === seated ? slot : null), (x) => kinds[x?.kind]);
    return { ...ctx, placeOf: place, kindOf: (n) => r.get(n)?.kind, seated: (n) => (n === id(5) ? [{ id: seated, slot }] : []), heldBy: (c) => (c === crew ? held : null) };
  };
  const to = (slot, from, high = 3) => carryIntents({ do: 'to', crew, where: id(5), slot }, { ...copy(high), crewMiddle: () => from });
  const r = to('beam_high_r', [4e6, 6e6]);
  assert.equal(r.code, 'carry-way-crossed', 'from the west, past the first high beam');
  assert.match(r.detail, /beam_high_l/);
  assert.equal(to('beam_high_r', [20e6, 6e6])[0].verb, 'eden:walk', 'from the east it does not pass it');
  assert.equal(to('beam_high_r', [4e6, 6e6], 5)[0].verb, 'eden:walk', 'a beam seated low is carried over');
  assert.equal(to('beam_low_l', [20e6, 6e6]).code, 'carry-way-crossed', 'across the bay, under a high beam already seated, at the height it is carried');
  assert.equal(to('beam_low_l', [4e6, 6e6])[0].verb, 'eden:walk', 'from its own side it stops outside, under nothing');
  assert.equal(to('beam_low_r', [4e6, 6e6], 5)[0].verb, 'eden:walk', 'past a low beam to the far low slot');
  // Without the copy's slots (an older daemon), nothing is read and the walk is sent.
  assert.equal(carryIntents({ do: 'to', crew, where: id(5), slot: 'beam_high_r' }, { ...ctx, crewMiddle: () => [4e6, 6e6] })[0].verb, 'eden:walk');
});

test('carry to --go names the moment every carrier sets off: hh:mm:ss in UTC, an ISO time or Unix ms', () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  assert.equal(goTime('12:00:07', now), now + 7000);
  assert.equal(goTime('12:00:07.5Z', now), now + 7500);
  assert.equal(goTime('2026-11-26T12:00:09Z', now), now + 9000);
  assert.equal(goTime(String(now + 3000), now), now + 3000);
  assert.ok(Number.isNaN(goTime('soon', now)));
  assert.equal(requestOf(['carry', 'to', id(8), '2,6', '--go', String(now)]).req.go, now);
  assert.equal(requestOf(['carry', 'to', id(8), '2,6', '--go', 'soon']).refused, 'carry-go');
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
  // With its entry's world time, the offer says how long it has left; a crew offered to several, how accepts renew it.
  const crew = { ...ev, fields: { ...ev.fields, 3: [id(7), id(9)], 4: 70_000_000, 7: 60_000_000, 8: 310_000_000 } };
  assert.deepEqual(offerNote(crew, id(7), 10_000_000), {
    kind: 'carry', what: 'offered', offer: id(8), from: id(6), open_s: 60, each_accept_s: 60, open_most_s: 300,
    note: 'open 60 s; each accept keeps it open 60 s more for the rest, 300 s at most: answer before it lapses',
  });
  assert.deepEqual(offerNote(ev, id(7), 15_000_000), { kind: 'carry', what: 'offered', offer: id(8), from: id(6), open_s: 45, note: 'open 45 s: answer before it lapses' });
  const held = new Map([...rows, [id(10), { id: id(10), name: 'rack_beam 10', kind: 'mars:rack_beam', parent: id(8) }]]);
  assert.deepEqual(crewsIn(held), [{ id: id(8), on: id(1), holds: [{ id: id(10), name: 'rack_beam 10', kind: 'mars:rack_beam' }] }]);
});

test('a thing is named by its title as look shows it, in any case; crews stay ids; none or several is refused', () => {
  const named = new Map([...rows, [id(4), { ...rows.get(id(4)), name: 'rack frame 1' }], [id(5), { ...rows.get(id(5)), name: 'Rack Bay', aliases: ['the bay'] }],
    [id(2), { ...rows.get(id(2)), name: 'beam' }], [id(9), { ...rows.get(id(9)), name: 'beam' }]]);
  assert.deepEqual(byName({ kind: 'part', do: 'take', crew: id(8), part: 'rack frame 1' }, named), { kind: 'part', do: 'take', crew: id(8), part: id(4) });
  assert.equal(byName({ kind: 'part', do: 'put', crew: id(8), into: 'rack bay', slot: 'upright_a' }, named).into, id(5));
  assert.equal(byName({ do: 'to', crew: id(8), where: 'the bay', slot: 'upright_a' }, named).where, id(5), 'an alias');
  assert.deepEqual(byName({ do: 'to', crew: id(8), where: '1.5,2' }, named), { do: 'to', crew: id(8), where: '1.5,2' }, 'a point stays a point');
  assert.equal(byName({ kind: 'part', do: 'put', crew: id(8), into: 'here' }, named).into, 'here');
  assert.equal(byName({ do: 'grip', thing: 'beam', end: 'back' }, named).code, 'carry-name-ambiguous');
  assert.equal(byName({ do: 'grip', thing: 'frame 9', end: 'back' }, named).code, 'carry-name-unknown');
  assert.equal(byName({ do: 'accept', crew: 'my crew' }, named).crew, 'my crew', 'a crew is never looked up by name');
});

test('a place that shares a thing\'s name is passed over for the thing (Mars College\'s rack-bay place and rack bay)', () => {
  const named = new Map([...rows, [id(5), { ...rows.get(id(5)), name: 'rack-bay' }], [id(10), { id: id(10), kind: 'eden:place', parent: id(1), name: 'rack-bay' }],
    [id(11), { id: id(11), kind: 'eden:place', parent: id(1), name: 'yard' }], [id(12), { id: id(12), kind: 'eden:place', parent: id(1), name: 'yard' }]]);
  assert.equal(byName({ kind: 'part', do: 'put', crew: id(8), into: 'rack-bay', slot: 'upright_a' }, named).into, id(5));
  assert.equal(byName({ do: 'to', crew: id(8), where: 'yard' }, named).code, 'carry-name-ambiguous', 'two places alone stay ambiguous');
});

// Group work as an agent finds and joins it: who needs hands, an offer accepted by its offerer's name, what is next.
test('a load takes the crew its entry states: a 6 m upright four, a beam or frame two', () => {
  const six = entry('construction', 'rack_upright_6m.json');
  assert.equal(crewNeeds(six), 4);
  assert.equal(crewNeeds(kinds['mars:rack_beam']), 2);
  assert.equal(crewNeeds(kinds['mars:rack_upright']), 2, 'a crew is never fewer than its front and back');
  assert.equal(crewNeeds(null), 2);
});

test('an open crew offer is accepted by its offerer\'s name, or the newest with no word; none says how to get one', () => {
  const ada = id(20), cy = id(21), mine = [id(6)];
  const crews = new Map([[id(30), { id: id(30), kind: 'mars:carry_activity', members: [{ body: ada, role: 'mars:front' }] }],
    [id(31), { id: id(31), kind: 'mars:carry_activity', members: [{ body: cy, role: 'mars:front' }] }],
    [id(32), { id: id(32), kind: 'mars:carry_activity', members: [{ body: ada, role: 'mars:front' }, { body: id(6), role: 'mars:back' }] }]]);
  const logged = [{ kind: 'carry', what: 'offered', offer: id(30), from: ada }, { kind: 'carry', what: 'offered', offer: id(33), from: ada },
    { kind: 'carry', what: 'offered', offer: id(32), from: ada }, { kind: 'together', what: 'offered', offer: id(34), from: cy },
    { kind: 'carry', what: 'offered', offer: id(31), from: cy }];
  const offers = openCrewOffers(logged, crews, mine);
  assert.deepEqual(offers, [{ crew: id(30), from: ada }, { crew: id(31), from: cy }], 'gone (33) and joined (32) offers are not open');
  // A crew that formed stays in the copy after its offer lapsed: the lapse told to this Soul closes it.
  const lapsed = [...logged, { kind: 'conversation', what: 'lapsed', conversation: id(30), from: ada }];
  assert.deepEqual(openCrewOffers(lapsed, crews, mine), [{ crew: id(31), from: cy }], 'a lapsed offer is not open');
  const nameOf = (b) => ({ [ada]: 'Ada', [cy]: 'Cy' })[b];
  assert.deepEqual(crewOffered('ada', offers, nameOf), { crew: id(30) });
  assert.deepEqual(crewOffered(undefined, offers, nameOf), { crew: id(31) }, 'the newest');
  assert.deepEqual(crewOffered(id(40), offers, nameOf), { crew: id(40) }, 'an id goes as it is');
  const bo = crewOffered('Bo', offers, nameOf);
  assert.equal(bo.code, 'carry-no-offer');
  assert.match(bo.detail, /from Ada, Cy/);
  assert.match(crewOffered('Ada', [], nameOf).detail, /look.*say --to/);
});

test('carry offer anyone asks every Soul within 20 m, nearest first, five at most; nobody near says what to do', () => {
  const bodies = [{ id: 'c', m: 12 }, { id: 'a', m: 3 }, { id: 'far', m: 40 }, { id: 'b', m: 5 }, { id: 'd', m: 6 }, { id: 'e', m: 7 }, { id: 'f', m: 8 }];
  assert.deepEqual(offerNear(bodies), ['a', 'b', 'd', 'e', 'f']);
  const none = offerNear([{ id: 'far', m: 40 }]);
  assert.equal(none.code, 'carry-nobody-near');
  assert.match(none.detail, /shout/);
  assert.equal(requestOf(['carry', 'offer', 'anyone']).req.to[0], 'anyone');
  assert.deepEqual(requestOf(['carry', 'accept']).req, { op: 'carry', do: 'accept' }, 'an accept with no word: the newest offer');
  assert.deepEqual(requestOf(['carry', 'accept', 'Ada']).req, { op: 'carry', do: 'accept', crew: 'Ada' });
});

test('who needs help: an offer to me with the command that joins it, and a crew near short of hands with whom to ask', () => {
  const ada = id(20), bo = id(21), cy = id(22), six = entry('construction', 'rack_upright_6m.json');
  const r = new Map([
    [id(30), { id: id(30), kind: 'mars:carry_activity', members: [{ body: ada, role: 'mars:front' }] }],
    [id(31), { id: id(31), kind: 'mars:carry_activity', members: [{ body: bo, role: 'mars:front' }, { body: cy, role: 'mars:back' }] }],
    [id(35), { id: id(35), name: '6 m upright', kind: 'mars:rack_upright_6m', parent: id(31) }],
    [id(32), { id: id(32), kind: 'mars:carry_activity', members: [{ body: id(23), role: 'mars:front' }] }],
  ]);
  const names = { [ada]: 'Ada', [bo]: 'Bo', [cy]: 'Cy', [id(23)]: 'Far' }, at = { [ada]: 2, [bo]: 6, [cy]: 8, [id(23)]: 90 };
  const lines = workLines({ crews: crewsIn(r), rows: r, mine: [id(6)], offers: [{ crew: id(30), from: ada }], nameOf: (b) => names[b],
    metres: (b) => at[b], needs: (t) => crewNeeds(r.get(t)?.kind === 'mars:rack_upright_6m' ? six : null), nearest: (c) => (c === id(30) ? 'rack frame 1' : null) });
  assert.deepEqual(lines, [
    `Ada offers you a place in a carry crew near rack frame 1 (${id(30)}): carry accept Ada`,
    `a carry crew (${id(31)}, 6 m) holds 6 m upright: Bo, Cy, 2 of 4 hands: 2 more wanted; to help, ask Bo: say --to Bo "I can help"`,
  ], 'the crew 90 m away is not near');
});

test('each step says what comes next; a seated part says what is left of its bay, or that it is built', () => {
  const crew = id(8);
  assert.match(nextStep({ do: 'grip' }), /carry offer <name>.*carry accept/);
  assert.match(nextStep({ do: 'offer', crew }), new RegExp(`part take ${crew}`));
  assert.match(nextStep({ do: 'accept', crew }), /carry grip <load> back.*you walk with it, keeping your place/);
  assert.match(nextStep({ kind: 'part', do: 'take', crew }, { load: 'rack frame 1' }), new RegExp(`rack frame 1 is up: say where it goes; the front sends carry to ${crew}`));
  assert.match(nextStep({ do: 'to', crew }), /part put/);
  assert.match(nextStep({ kind: 'part', do: 'put', crew, into: id(5) }, { bay: bayWith(['upright_a']) }), /1 of 6 slots filled; still to fill: upright_b: a rack upright/);
  assert.match(nextStep({ kind: 'part', do: 'put', crew, into: id(5) }, { bay: bayWith(['upright_a', 'upright_b', 'beam_high_l', 'beam_high_r', 'beam_low_l', 'beam_low_r']) }), /6 of 6 slots filled, so it is built/);
  assert.equal(nextStep({ do: 'list' }), null);
});

/** The bay of the copy above with parts in those slots, as `inspect` shows it. */
function bayWith(filled) {
  const names = Object.keys(kinds['mars:rack_bay'].slots), r = new Map([...rows]);
  filled.forEach((s, k) => r.set(id(50 + k), { id: id(50 + k), name: `part ${k}`, kind: 'mars:rack_beam', parent: id(5), slot: names.indexOf(s) + 1 }));
  return slotsCard(r, r.get(id(5)), kinds['mars:rack_bay'], (n) => r.get(n)?.slot ?? null);
}

test('a refused step says no next; a part seated in a bay reads the bay as it stands', async () => {
  const refused = { ok: false, code: 'carry-crew-too-small', next: 'x' };
  await nextOf(async () => assert.fail('asks nothing'), { op: 'carry', do: 'lift' }, refused);
  assert.equal(refused.next, undefined);
  const done = { ok: true, phase: 'done', next: 'x' }, asked = [];
  await nextOf(async (r) => { asked.push(r); return { ok: true, built: '6 of 6 slots filled' }; }, { op: 'carry', kind: 'part', do: 'put', crew: id(8), into: id(5), slot: 'beam_low_r' }, done);
  assert.deepEqual(asked, [{ op: 'inspect', this: id(5) }]);
  assert.match(done.next, /it is built/);
});

test('an offer names the crew this Soul fronts, when another Soul offered one at the same moment', async () => {
  // Ada and Cy offer at once (the shade's two rail crews): Ada's copy holds both new crews, Cy's listed first.
  const crews = [
    { id: id(30), with: [{ name: 'Cy', role: 'front', body: id(31) }] },
    { id: id(32), with: [{ name: 'you', role: 'front', body: id(6) }] },
  ];
  const ask = async () => ({ crews: [{ id: id(8), with: [] }, ...crews] });
  assert.deepEqual(await newCrew(ask, [id(8)], { sleep: async () => {} }), { crew: id(32) }, 'the one this Soul fronts');
  const one = async () => ({ crews: [{ id: id(33), with: [] }] });
  assert.deepEqual(await newCrew(one, [], { sleep: async () => {} }), { crew: id(33) }, 'the only new crew');
  const unsure = async () => ({ crews: crews.map((c) => ({ ...c, with: [] })) });
  assert.equal((await newCrew(unsure, [], { tries: 2, sleep: async () => {} })).crew, null, 'two new crews, neither shown as this Soul\'s: no guess');
});
