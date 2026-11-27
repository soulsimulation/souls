// #5063: a done look or point made from afar says so on its receipt (afar.mjs), read from its act-end entry.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { afarFor, afarOf, satInOf } from './afar.mjs';

/** Bytes as the world writes them (T0's byte string: its length in the head), as hex. */
const hexOf = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from(b.length < 24 ? [0x40 + b.length] : [0x58, b.length]), b]).toString('hex'); };
/** The act-end entry event as the daemon's entry JSON gives it (`wireEntry`: bytes as the hex of their encoding). */
const ended = (body, words) => ({ name: 'souls:act-ended', fields: { 1: body, 2: hexOf('done'), ...(words ? { 8: hexOf(words) } : {}) } });
const FAR = 'souls:look: from afar, 30000 mm to cd:5701, reach 20000 mm';

test('an act end of my own body made from afar is read with its words; others are not', () => {
  assert.equal(afarOf(ended('b-1', FAR), ['s-1', 'b-1']), FAR);
  assert.equal(afarOf(ended('b-1', 'souls:point: from afar, 41200 mm to cd:12, reach 20000 mm'), ['b-1']),
    'souls:point: from afar, 41200 mm to cd:12, reach 20000 mm');
  assert.equal(afarOf(ended('b-2', FAR), ['s-1', 'b-1']), null, 'another body\'s');
  assert.equal(afarOf(ended('b-1', null), ['b-1']), null, 'a look within reach: no words');
  assert.equal(afarOf({ name: 'souls:move-ended', fields: { 1: 'b-1', 8: hexOf(FAR) } }, ['b-1']), null, 'another event');
});

test('a receipt takes the act end between its send and its version, the newest there', () => {
  const seen = [{ sequence: 10, words: 'an older look' }, { sequence: 42, words: FAR }, { sequence: 90, words: 'a later one' }];
  assert.equal(afarFor(seen, 20, 43), FAR, 'sent after entry 20, answered at version 43: entry 42');
  assert.equal(afarFor(seen, 42, 80), null, 'none after its send and before its version');
  assert.equal(afarFor([], -1, Infinity), null);
});

test('a sit by kind from the open ground names the place of its seat; a look from afar is not that', () => {
  const SAT = 'eden:chair cd:120 in the bandstand, 3.2 m away';
  assert.equal(satInOf(ended('b-1', SAT), ['s-1', 'b-1']), SAT);
  assert.equal(satInOf(ended('b-2', SAT), ['s-1', 'b-1']), null, 'another body\'s');
  assert.equal(satInOf(ended('b-1', FAR), ['b-1']), null, 'a look from afar');
  assert.equal(satInOf(ended('b-1', null), ['b-1']), null, 'a sit indoors: no words');
});
