// Tests for audience rules (Soul Actions SA-F8, #2849). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from './format.mjs';

const base = () => ({format: F.FORMAT, owner: 'thing', state: {}, links: {}, text: {}});
const rejects = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};

// A card table's seat: each hand is visible to the Soul linked as this seat's player.
const seat = () => ({...base(), kind: 'test:card_seat',
  links: {player: {n: 1, from: 'soul', most: 1, audience: {rule: 'everyone'}}},
  state: {
    hand: {n: 1, type: 'int', unit: 'count', default: 0, min: 0, max: 52, audience: {rule: 'linked', link: 'player'}},
    chips: {n: 2, type: 'int', unit: 'count', default: 0, audience: {rule: 'everyone'}},
  }});

test('A1: a card table seat\'s hand field takes the rule "the Soul linked as this seat\'s player"', () => {
  const e = seat();
  assert.deepEqual(F.validateEntry(e), []);
  assert.deepEqual(F.audienceOf(e, 'hand'), {rule: 'linked', link: 'player'});
  // The link must be one this kind has, and the rule never names a Soul.
  const bad = seat(); bad.state.hand.audience = {rule: 'linked', link: 'dealer'};
  rejects(bad, 'state.hand.audience.link', 'link type');
  const named = seat(); named.state.hand.audience = {rule: 'linked', link: 'player', soul: 's_ana'};
  rejects(named, 'state.hand.audience.soul');
});

test('A2: a field with no audience is refused, as is a rule outside the list', () => {
  const none = seat(); delete none.state.chips.audience;
  rejects(none, 'state.chips.audience', 'who may see it');
  const old = seat(); old.state.chips.audience = 'public';
  rejects(old, 'state.chips.audience');
  const other = seat(); other.state.chips.audience = {rule: 'friends'};
  rejects(other, 'state.chips.audience.rule', 'must be one of');
  const noLink = seat(); delete noLink.links.player.audience;
  rejects(noLink, 'links.player.audience', 'who may see it');
});

test('A3: the list of rules is one closed list in one file', () => {
  assert.deepEqual([...F.AUDIENCE_RULES], ['everyone', 'owner', 'linked', 'creator']);
  assert.equal(F.AUDIENCES, undefined);
  for (const rule of F.AUDIENCE_RULES) {
    const e = seat(); e.state.chips.audience = rule === 'linked' ? {rule, link: 'player'} : {rule};
    assert.deepEqual(F.validateEntry(e), [], rule);
  }
});

// A fridge marked closed: its stock field takes the container's audience.
const fridge = () => ({...base(), kind: 'test:fridge',
  links: {keeper: {n: 1, from: 'soul', most: 1, audience: {rule: 'everyone'}}},
  state: {
    stock: {n: 1, type: 'int', unit: 'count', default: 0, min: 0},
    door: {n: 2, type: 'bool', default: false, audience: {rule: 'everyone'}},
  },
  closed: {audience: {rule: 'linked', link: 'keeper'}, fields: ['stock']}});

test('A4: a closed fridge gives its stock field the container\'s audience', () => {
  const e = fridge();
  assert.deepEqual(F.validateEntry(e), []);
  assert.deepEqual(F.audienceOf(e, 'stock'), {rule: 'linked', link: 'keeper'});
  assert.deepEqual(F.audienceOf(e, 'door'), {rule: 'everyone'});
  // A closed field declares none of its own, a named field must exist, and the container's audience is written out.
  const own = fridge(); own.state.stock.audience = {rule: 'everyone'};
  rejects(own, 'state.stock.audience', 'container');
  const ghost = fridge(); ghost.closed.fields = ['shelf'];
  rejects(ghost, 'closed.fields.0', 'not a state field');
  const bare = fridge(); delete bare.closed.audience;
  rejects(bare, 'closed.audience');
  // The same kind without `closed` needs the audience on the stock field.
  const open = fridge(); delete open.closed;
  rejects(open, 'state.stock.audience', 'who may see it');
});
