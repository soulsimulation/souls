// A thing's own offers from its kind entry, and the thin command's inspect and object words (#3686). Pure: no daemon.
//   node --test v2/client/src/check/offers.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nearestIds, nearestOffers, offerNamed, offersOf } from './offers.mjs';
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
