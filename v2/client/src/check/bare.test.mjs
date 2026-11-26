// A bare word given to `act` resolves to the one act the copy offers by it (`bare.mjs`). Pure: no daemon.
//   node --test v2/client/src/check/bare.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bareAct } from './bare.mjs';

const kind = (path) => JSON.parse(readFileSync(new URL(`../../../../content/kinds/${path}.json`, import.meta.url), 'utf8'));
const kinds = { 'eden:humanoid': kind('body/humanoid'), 'eden:practice_mat': kind('camp/practice_mat'), 'eden:guitar_stool': kind('music/guitar_stool') };
const id = (n) => `${'ab'.repeat(16)}-${n}`;
const me = { id: id(1), name: 'Oriel', kind: 'eden:humanoid', soul: id(100) };
const rowsOf = (...rs) => new Map([me, ...rs].map((r) => [r.id, r]));
const mat = { id: id(2), name: 'practice mat 2', kind: 'eden:practice_mat' };
const stool = (n) => ({ id: id(n), name: `guitar stool ${n}`, kind: 'eden:guitar_stool' });
const ask = (w, rows = rowsOf(mat, stool(3)), opts = {}) => bareAct(w, { rows, kinds, me, ns: 'eden', ...opts });
const refused = (f) => { try { f(); } catch (e) { return e; } assert.fail('not refused'); };

test('rise is the world\'s own move: eden:rise, with no thing', () => {
  assert.deepEqual(ask('rise'), { verb: 'eden:rise' });
  assert.deepEqual(ask('rise', rowsOf(), { me: null }), { verb: 'eden:rise' }, 'even before the copy holds the body');
});

test('a word one thing here offers is that thing\'s act, hyphens read as the form\'s underscores', () => {
  assert.deepEqual(ask('unroll'), { words: [`unroll:${mat.id}`] });
  assert.deepEqual(ask('roll-up'), { words: [`roll_up:${mat.id}`] });
  assert.deepEqual(ask('sit'), { words: [`sit:${stool(3).id}`] }, 'a seat\'s sit, the world picking the slot');
  assert.deepEqual(ask('play'), { words: [`play:${stool(3).id}`] });
});

test('a word several things offer is refused with each named, and nothing is sent', () => {
  const e = refused(() => ask('play', rowsOf(mat, stool(4), stool(3))));
  assert.equal(e.code, 'act-word-ambiguous');
  assert.deepEqual(e.choices, [{ act: `play:${id(3)}`, name: 'guitar stool 3' }, { act: `play:${id(4)}`, name: 'guitar stool 4' }]);
  assert.match(e.message, /^play: 2 things here offer it; name one: act play:ab.*-3 \(guitar stool 3\), play:ab.*-4 \(guitar stool 4\)$/);
});

test('a word nothing here offers is refused naming the nearest offers', () => {
  const e = refused(() => ask('unrol'));
  assert.equal(e.code, 'act-word-unknown');
  assert.equal(e.did_you_mean[0], 'unroll');
  assert.match(e.message, /^nothing here offers unrol; nearest: unroll/);
  assert.ok(refused(() => ask('jog')).did_you_mean.length > 0);
});

test('another Soul\'s body is never the thing a bare word acts on', () => {
  const them = { id: id(9), name: 'Ash', kind: 'eden:humanoid', soul: id(101) };
  assert.equal(refused(() => ask('wave', rowsOf(them))).code, 'act-word-unknown');
});

test('before the body or its kind is on this machine, the word goes to the body as the world\'s, for the world to judge', () => {
  assert.deepEqual(bareAct('exercise', { rows: rowsOf(), kinds: {}, me, ns: 'eden' }), { verb: 'eden:exercise', this: me.id });
  assert.deepEqual(ask('wave', rowsOf(mat), { me: null }), { verb: 'eden:wave' }, 'nor the body itself: the world knows its actor');
  assert.deepEqual(ask('unroll', rowsOf(mat), { me: null }), { words: [`unroll:${mat.id}`] }, 'a thing here still offers its own');
});
