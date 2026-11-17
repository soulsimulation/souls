// Tests for the Eden asks runner (asks.mjs): one implementation of the fixes the content lanes each made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {judge} from './asks.mjs';
import {loadKinds} from '../../packages/form-rules/src/load.ts';

const kinds = loadKinds([join(fileURLToPath(new URL('../../', import.meta.url)), 'content/kinds')]);
const ask = chain => judge({n: 1, group: 'object', things: {b: 'eden:bench'}, chain}, kinds, {});

test('a slot argument the chain leaves out is filled from the form\'s free-slot selector', () => {
  const r = ask([{this: 'b', form: 'sit'}]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ask([{this: 'b', form: 'sit', args: {seat: 'right'}}]).ok, true, 'a named slot is used as named');
});

test('an argument the form does not take is refused, never dropped', () => {
  const r = ask([{this: 'b', form: 'sit', args: {mood: 'sad'}}]);
  assert.equal(r.ok, false);
  assert.match(r.refused?.why ?? '', /^not_taken: eden:bench sit takes no argument "mood"/);
});
