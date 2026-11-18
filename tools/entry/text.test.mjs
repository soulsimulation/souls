// Tests for words by reference (Soul Actions SA-F6b, #2847). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from './format.mjs';

const board = () => ({format: F.FORMAT, kind: 'test:whiteboard', owner: 'thing',
  state: {words: {n: 1, type: 'text', default: null, audience: {rule: 'everyone'}}, count: {n: 2, type: 'int', unit: 'count', default: 0, audience: {rule: 'everyone'}}},
  links: {}, forms: {write: {who: 'anyone', starts: 'act', takes: {words: {type: 'text'}}, needs: [], steps: [], effects: [{change: 'set', field: 'words', to: {arg: 'words'}, event: 'words_written'}]}},
  text: {card: 'A board anyone writes on.', sign: 'Closed for cleaning.'}, card: {text: 'card'}});
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && e.reason.includes(word)), `expected a refusal at ${path} (${word}), got ${JSON.stringify(errors)}`);
};

test('A1: a whiteboard\'s words are a reference; inline text in state is refused', () => {
  assert.deepEqual(F.validateEntry(board()), []);
  const a = board(); a.state.words.default = 'hello everyone';
  refused(a, 'state.words.default', 'inline words');
  const b = board(); b.forms.write.effects[0].to = 'hello everyone';
  refused(b, 'forms.write.effects.0.to', 'inline words');
  const c = board(); c.forms.write.takes.words.type = 'count';
  refused(c, 'forms.write.effects.0.to', 'text argument');
  const d = board(); d.forms.write.takes.n = {type: 'text'}; d.forms.write.effects[0] = {change: 'set', field: 'count', to: {arg: 'n'}, event: 'x'};
  refused(d, 'forms.write.effects.0.to', 'only to a text field');
});

test('A2: a sign\'s fixed wording, written by the entry\'s author, is part of the kind', () => {
  const e = board();
  assert.deepEqual(F.validateEntry(e), []);
  assert.ok(F.hashKinds([e]).get(e.kind).ref);
  const e2 = board(); e2.text.sign = 'Open all day.';
  assert.deepEqual(F.validateEntry(e2), []);
  assert.equal(F.hashKinds([e2]).get(e2.kind).ref, F.hashKinds([board()]).get(e.kind).ref, 'the wording does not rename the kind');
});

test('card: a purpose line, one category word and synonyms, all by reference to the text table', () => {
  const good = () => { const e = board(); e.text.household = 'household'; e.text.chalk = 'chalk'; e.text.marker = 'marker';
    e.card = {text: 'card', category: 'household', synonyms: ['chalk', 'marker']}; return e; };
  assert.deepEqual(F.validateEntry(good()), []);
  const a = good(); a.card.synonyms = ['chalk', 'a pen that wipes'];
  refused(a, 'card.synonyms.1', 'text table');
  const b = good(); b.card.category = ['household'];
  refused(b, 'card.category', 'text table');
  const c = good(); c.text.long = 'two words'; c.card.category = 'long';
  refused(c, 'card.category', 'one word');
  const d = good(); d.text.card = 'x'.repeat(81); // the length is the check's rule (check.mjs), not the format's
  assert.deepEqual(F.validateEntry(d), []);
  const e = good(); e.text.card = 'x'.repeat(80);
  assert.deepEqual(F.validateEntry(e), []);
  const g = good(); g.card.synonyms = [];
  refused(g, 'card.synonyms', 'list');
});
