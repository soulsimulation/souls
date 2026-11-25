// A thing's own offers from its kind entry, and the thin command's inspect and object words (#3686). Pure: no daemon.
//   node --test v2/client/src/check/offers.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { actWords, isGesture, nearestIds, nearestOffers, offerNamed, offersOf, repeatsOf } from './offers.mjs';
import { argsOf, requestOf } from '../cli/souls.mjs';

const ID = `${'ab'.repeat(16)}-7`;
const garden = {
  format: 'souls-entry/1', kind: 'eden:sand_garden',
  slots: { bench: { admits: 'body', posture: 'sit', most: 2 }, shelf: { admits: 'thing' } },
  forms: {
    brush: { who: 'anyone', takes: { cell: { type: 'field', of: ['back_left', 'front_left'] }, pattern: { type: 'value', of: ['along', 'across'] } } },
    fill: { who: 'holder', takes: { pail: { type: 'thing', select: { of: 'things', kind: 'eden:soil_pail' } }, grams: { type: 'count' } } },
    rake: { who: { link: 'minder' } },
  },
};

test('A1: a thing\'s offers come from its kind entry, each with its parameters and the act that sends it', () => {
  const offers = offersOf(ID, garden);
  assert.deepEqual(offers.map((o) => o.name), ['walk', 'sit', 'brush', 'fill', 'rake']);
  assert.deepEqual(offers[0], { name: 'walk', act: `walk:${ID}`, usage: `act ${ID}` });
  assert.deepEqual(offers[1].slots, ['bench'], 'a sit names the slots of that posture, not a thing slot');
  const brush = offers[2];
  assert.equal(brush.act, `brush:${ID}`);
  assert.deepEqual(brush.params.pattern, { type: 'value', of: ['along', 'across'] });
  assert.equal(brush.usage, `act brush:${ID} cell=<back_left|front_left> pattern=<along|across>`);
  const fill = offers[3];
  assert.equal(fill.who, 'holder');
  assert.equal(fill.params.pail.optional, true, 'a parameter the world selects may be left out');
  assert.equal(fill.usage, `act fill:${ID} [pail=<id>] grams=<count>`);
  assert.deepEqual(offers[4].who, { link: 'minder' });
  assert.equal(offers[4].params, undefined);
});

test('A1: a kind with a form named sit offers that form, not the bare move; no entry offers the walk alone', () => {
  const steps = { kind: 'eden:steps', slots: { lower_1: { posture: 'sit' } }, forms: { sit: { who: 'anyone', takes: { seat: { type: 'slot' } } } } };
  assert.deepEqual(offersOf(ID, steps).map((o) => [o.name, o.form ?? null]), [['walk', null], ['sit', 'sit']]);
  assert.deepEqual(offersOf(ID, undefined).map((o) => o.name), ['walk']);
});

test('A2: a form named as a move names its slot, so object sends the form (which walks there), not the bare move', () => {
  const table = { kind: 'eden:picnic_table', slots: { seat_1: { admits: 'body', posture: 'sit' }, seat_2: { admits: 'body', posture: 'sit' } },
    forms: { sit: { who: 'anyone', takes: { seat: { type: 'slot', select: { of: 'free_slots' } } } }, wipe: { who: 'anyone' } } };
  const [, sit, wipe] = offersOf(ID, table);
  assert.deepEqual(sit.params.seat.of, ['seat_1', 'seat_2']);
  assert.equal(sit.params.seat.default, 'seat_1');
  assert.equal(sit.usage, `act sit:${ID} [seat=<seat_1|seat_2>]`);
  assert.deepEqual(actWords(sit), [`sit:${ID}`, 'seat=seat_1']);
  assert.deepEqual(actWords(sit, ['seat=seat_2']), [`sit:${ID}`, 'seat=seat_2']);
  assert.deepEqual(actWords(wipe), [`wipe:${ID}`]);
});

test('A2, A3: an offer is named by its name, its act word or a namespaced verb; an unknown one gets the nearest', () => {
  const offers = offersOf(ID, garden);
  for (const a of ['brush', `brush:${ID}`, 'eden:brush']) assert.equal(offerNamed(offers, a)?.name, 'brush', a);
  assert.equal(offerNamed(offers, 'dance'), null);
  assert.deepEqual(nearestOffers(offers, 'brsh'), ['brush']);
  assert.equal(nearestOffers(offers, 'eden:fil')[0], 'fill');
  assert.equal(nearestOffers(offers, 'zzzzzzzz').length, 3, 'nothing near: three of its offers all the same');
});

test('A3: an unknown id gets the ids the search finds for it, else the nearest by spelling', () => {
  const rows = [{ id: `${'ab'.repeat(16)}-7`, name: 'sand garden', kind: 'eden:sand_garden' }, { id: `${'cd'.repeat(16)}-2`, name: 'west bench', kind: 'eden:bench' }];
  assert.deepEqual(nearestIds(rows, 'bench').map((r) => r.name), ['west bench']);
  assert.equal(nearestIds(rows, `${'ab'.repeat(16)}-8`)[0].name, 'sand garden');
});

test('A2: the thin command\'s inspect and object words', () => {
  assert.deepEqual(requestOf(['inspect', ID]).req, { op: 'inspect', this: ID });
  assert.deepEqual(requestOf(['object', ID]).req, { op: 'object', this: ID });
  assert.deepEqual(requestOf(['object', ID, 'brush', 'cell=back_left', 'pattern=along', '--for', 'm1']).req,
    { op: 'object', for: 'm1', this: ID, action: 'brush', args: ['cell=back_left', 'pattern=along'] });
  assert.deepEqual(argsOf(['{"grams":50,"pattern":"along"}']), ['grams=50', 'pattern=along'], 'today\'s params JSON');
  assert.equal(requestOf(['object', ID, 'fill', '{nope']).refused, 'object-params');
});

test('#3603: a thing moving on a course with seats offers its rider steer, stop and land, the engine\'s own verbs', () => {
  const punt = JSON.parse(readFileSync(new URL('../../../../content/kinds/vehicles/rowing_punt.json', import.meta.url), 'utf8'));
  const moored = offersOf(ID, punt, { moving: true });
  assert.deepEqual(moored.map((o) => o.name), ['walk', 'sit', 'row', 'steer', 'stop', 'land']);
  const [steer, stop, land] = moored.slice(3);
  assert.equal(steer.act, `carrier:steer:${ID}`);
  assert.equal(steer.usage, `act carrier:steer:${ID} x=<m> z=<m>`);
  assert.equal(stop.usage, `act carrier:stop:${ID}`);
  assert.equal(land.usage, `act carrier:land:${ID} [x=<m> z=<m>]`);
  assert.ok([steer, stop, land].every((o) => o.who === 'rider' && !o.form), 'for a seated rider; no form of the kind');
  assert.deepEqual(actWords(steer, ['x=-59.8', 'z=0']), [`carrier:steer:${ID}`, 'x=-59.8', 'z=0']);
  assert.equal(offerNamed(moored, 'carrier:land')?.name, 'land', 'named by its namespaced verb');
  assert.equal(offerNamed(moored, `carrier:stop:${ID}`)?.name, 'stop', 'or by its act word');
  assert.deepEqual(offersOf(ID, punt).map((o) => o.name), ['walk', 'sit', 'row'], 'not moving: no steering');
  assert.deepEqual(offersOf(ID, { ...garden, slots: { shelf: { admits: 'thing' } } }, { moving: true }).map((o) => o.name),
    ['walk', 'brush', 'fill', 'rake'], 'a moving thing with no seat has no rider');
});

test('continuous activities: a held activity says it goes on until the next act, a gesture that it is done once, each with `for=<seconds>`', () => {
  const humanoid = JSON.parse(readFileSync(new URL('../../../../content/kinds/body/humanoid.json', import.meta.url), 'utf8'));
  const offers = offersOf(ID, humanoid), of = (n) => offers.find((o) => o.name === n);
  for (const held of ['dance', 'yoga', 'jumping_jacks', 'push_ups', 'sit_ups', 'stargaze']) {
    assert.match(of(held).lasts, /^unbroken until your next act or `stop` \(an hour at most\); for=<seconds> for a set time$/, held);
    assert.match(of(held).usage, /\[for=<seconds>\]$/, held);
    assert.equal(of(held).params.for.default, undefined, `${held}: the world's own default, not sent`);
  }
  for (const once of ['wave', 'clap', 'jump', 'stretch', 'sing', 'listen']) assert.match(of(once).lasts, /^once; for=<seconds> keeps it up/, once);
  assert.equal(of('exercise').lasts, '10 s for each of its 3 moves, back to back, unless each=<seconds>');
  assert.equal(of('bow').lasts, undefined, 'a bow is a bow');
  // `say --gesture` still plays each, though it now takes how long it lasts; never a walk or a form taking a thing.
  for (const g of ['clap', 'jump', 'stretch', 'sing', 'listen', 'wave', 'wave_at', 'bow']) assert.ok(isGesture(humanoid.forms[g]), g);
  for (const g of ['dance', 'yoga', 'go_to', 'touch', 'pick_up', 'stand']) assert.ok(!isGesture(humanoid.forms[g]), g);
  // How long each keeps up, s, as `act --wait` reads it: held, a set time, once, a workout's three, nothing repeated.
  const f = humanoid.forms;
  assert.deepEqual([repeatsOf(f.dance), repeatsOf(f.dance, { for: 60 }), repeatsOf(f.wave), repeatsOf(f.wave, { for: 20 }), repeatsOf(f.exercise), repeatsOf(f.exercise, { each: 5 }), repeatsOf(f.bow), repeatsOf(f.go_to)],
    [3600, 60, 0, 20, 30, 15, undefined, undefined]);
});
