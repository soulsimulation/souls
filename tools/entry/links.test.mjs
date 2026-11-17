// Tests for links and bounded lists (Soul Actions SA-F6a, #2846). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const kind = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../../content/kinds/${name}.json`, import.meta.url)), 'utf8'));
const base = () => ({format: F.FORMAT, kind: 'test:thing', owner: 'thing', state: {}, links: {}, text: {}});
const rejects = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};
const everyone = {rule: 'everyone'};
const list = (over = {}) => ({n: 1, type: 'list', most: 4, key: 'id', default: [], audience: everyone,
  of: {id: {type: 'int', unit: 'count'}, seen: {type: 'bool'}}, ...over});

test('A1: a sign-up sheet\'s slots are child nodes, and who signed is a link on each slot, from the Soul end and the sheet', () => {
  const sheet = kind('signup/sheet'), slot = kind('signup/slot');
  assert.deepEqual(F.validateEntry(sheet), []);
  assert.deepEqual(F.validateEntry(slot), []);
  // The slots are children of the sheet, a bounded number of a named kind; the sheet's hash covers the slot kind.
  assert.deepEqual(sheet.children.slot, {kind: 'eden:signup_slot', most: 20});
  // Admits are a commit-time check by kind name: the sheet's hash does not follow the slot kind, but does cover its own list.
  assert.ok(!F.kindRefs(sheet).includes('eden:signup_slot'));
  assert.equal(F.SECTIONS.children, 11);
  const other = structuredClone(slot); other.state.starts_in.default = 1;
  const before = F.hashKinds([sheet, slot]).get('eden:signup_sheet').hash;
  assert.equal(F.hashKinds([sheet, other]).get('eden:signup_sheet').hash, before);
  assert.equal(F.hashKinds([sheet]).get('eden:signup_sheet').hash, before);
  const more = structuredClone(sheet); more.children.slot.most = 21;
  assert.notEqual(F.hashKinds([more]).get('eden:signup_sheet').hash, before);
  // Who signed is a link declared with its two ends: a Soul at one, the slot at the other; found from either.
  assert.equal(slot.links.signed.from, 'soul');
  assert.equal(slot.links.signed.most, 1);      // a slot has one signer
  assert.equal(slot.links.signed.most_per, 3);  // a Soul signs up to three slots
  // No Soul is named in a slot or in the sheet: the link is the only record of who signed.
  assert.ok(!JSON.stringify([sheet, slot]).match(/"(?:s|sim|soul)_/));
  // A link end may be a kind; a bad end or count is refused.
  const e = base(); e.links.piece = {n: 1, from: 'test:piece', most: 1, audience: everyone};
  assert.deepEqual(F.validateEntry(e), []);
  e.links.piece.from = 'a soul'; rejects(e, 'links.piece.from');
  e.links.piece.from = 'soul'; e.links.piece.most_per = 0; rejects(e, 'links.piece.most_per');
  // A chess board on paper: who plays each side and whose turn it is are links; squares are children.
  const board = {...base(), kind: 'test:chess', links: {
    white: {n: 1, from: 'soul', most: 1, audience: everyone}, black: {n: 2, from: 'soul', most: 1, audience: everyone},
    turn: {n: 3, from: 'soul', most: 1, audience: everyone}}, children: {square: {kind: 'test:square', most: 64}}};
  assert.deepEqual(F.validateEntry(board), []);
  board.children.square.most = 0; rejects(board, 'children.square.most');
});

test('A2: a record that holds a Soul\'s id, or any id, is refused', () => {
  const e = base(); e.state.signed = list();
  assert.deepEqual(F.validateEntry(e), []);
  for (const type of ['soul', 'body', 'id', 'node', 'ref', 'thing']) {
    const bad = base(); bad.state.signed = list({of: {id: {type: 'int', unit: 'count'}, who: {type}}});
    rejects(bad, 'state.signed.of.who.type', 'link');
  }
  // Text is not a record type either, so a Soul's id has no place to hide.
  const t = base(); t.state.signed = list({of: {id: {type: 'int', unit: 'count'}, who: {type: 'text'}}});
  rejects(t, 'state.signed.of.who.type');
  // A value that is a Soul's id is refused wherever it sits.
  const v = base(); v.state.signed = list({of: {id: {type: 'int', unit: 'count'}, who: {type: 'enum', values: ['s_ana', 'other']}}});
  rejects(v, 'state.signed.of.who.values.0', 'Soul');
  const d = base(); d.state.signed = list({default: [{id: 1, who: 'sim_9f'}]});
  rejects(d, 'state.signed.default', 'empty');
  rejects(d, 'state.signed.default.0.who', 'Soul');
});

test('A3: a list declares its maximum, and the check gate counts state at that maximum', () => {
  const bare = list(); delete bare.most;
  const e = base(); e.state.signed = bare; rejects(e, 'state.signed.most');
  for (const most of [0, -1, 101, 2.5]) { const b = base(); b.state.signed = list({most}); assert.ok(F.validateEntry(b).some(x => x.path === 'state.signed.most' || x.reason.includes('floating')), String(most)); }
  const many = base(); many.state.signed = list({of: Object.fromEntries('abcdefghi'.split('').map(k => [k, {type: 'bool'}]))});
  rejects(many, 'state.signed.of');
  const nokey = base(); nokey.state.signed = list({key: 'nope'}); rejects(nokey, 'state.signed.key');
  const filled = base(); filled.state.signed = list({default: [{id: 1}]}); rejects(filled, 'state.signed.default');
  // Counted at the maximum: a scalar is one value, a list is its bound times its record's fields; children by their bound.
  const ok = base(); ok.state.open = {n: 2, type: 'bool', default: true, audience: everyone}; ok.state.signed = list({most: 10});
  assert.deepEqual(F.validateEntry(ok), []);
  assert.deepEqual(F.stateAtMax(ok), {values: 21, listValues: 20, children: 0});
  assert.deepEqual(F.stateAtMax(kind('signup/sheet')), {values: 26, listValues: 24, children: 20});
});
