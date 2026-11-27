// The local check (Engine v2 R8, #2703) as pure functions, with R2's rules in replica's WASM build when it is built
// (v2/target/wasm-load/pkg), else a stand-in `decide`. The daemon's handlers are tested in ../daemon/daemon.test.mjs
// and the measured run is v2/tools/bench/local-check/run.mjs.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_MS, SEEN_ALL, SEEN_FIELDS, candidateOf, canOf, isCurrent, judge, sift } from './check.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = join(v2, 'target/wasm-load/pkg');
let decide = null;
if (existsSync(join(pkg, 'replica_bg.wasm'))) {
  const r = await import(pathToFileURL(join(pkg, 'replica.js')).href);
  r.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
  decide = r.rules_decide;
}
const LAMP = JSON.parse(readFileSync(join(v2, 'crates/replica/cases/kinds/lamp.json'), 'utf8'));
const kinds = { [LAMP.kind]: LAMP };
const lamp = (fields, links = { plugged: [] }) => ({ actor: 'me', nodes: { me: {}, l1: { kind: LAMP.kind, fields, links } } });

test('A3: a copy refuses only while current: under the bound and with no gap', () => {
  assert.equal(isCurrent({ age: 0 }), true);
  assert.equal(isCurrent({ age: CURRENT_MS }), true);
  assert.equal(isCurrent({ age: CURRENT_MS + 1 }), false);
  assert.equal(isCurrent({ age: 10, stale: true, gap: { ms: 0, why: 'not-connected' } }), false);
  assert.equal(isCurrent({ age: 10, unchangedMs: 30_000 }), true);
});

test('A3: at send time a current no drops its candidate; unknown, yes and a copy not current never do', () => {
  const c = ['a', 'b', 'c', 'd'].map((verb) => ({ verb, this: 'l1', form: 'f' }));
  const v = [{ verdict: 'no', reason: 'field_differs' }, { verdict: 'unknown' }, { verdict: 'yes' }, { verdict: 'no', reason: 'slot_taken' }];
  const { keep, dropped } = sift(c, v, true);
  assert.deepEqual(keep.map((x) => x.verb), ['b', 'c']); // the agent's own order, nothing added
  assert.deepEqual(dropped.map((x) => [x.verb, x.reason]), [['a', 'field_differs'], ['d', 'slot_taken']]);
  assert.deepEqual(sift(c, v, false).keep.map((x) => x.verb), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sift(c, [], true).keep.length, 4);
});

test('candidates: a bare verb is never checked; an object names its form and thing', () => {
  assert.deepEqual(candidateOf('eden:wave'), { verb: 'eden:wave' });
  assert.deepEqual(candidateOf({ verb: 'v', this: 'l1', form: 'dim', args: { x: 1 } }), { verb: 'v', this: 'l1', form: 'dim', args: { x: 1 } });
  assert.throws(() => candidateOf({ this: 'l1' }), { code: 'act-candidate' });
  assert.equal(judge(() => { throw new Error('not called'); }, { verb: 'v' }, { kinds, state: lamp({}), asker: { sees: [] } }).verdict, 'unknown');
  assert.equal(judge(() => { throw new Error('not called'); }, { verb: 'v', this: 'x9', form: 'dim' }, { kinds, state: lamp({}), asker: { sees: [] } }).why, 'not-in-copy');
  assert.equal(judge(() => { throw new Error('not called'); }, { verb: 'v', this: 'l1', form: 'dim' }, { kinds: {}, state: lamp({}), asker: { sees: [] } }).why, 'kind-not-held');
});

test('with R2\'s rules: a field the copy holds refuses; a reason it does not hold, bad input and the audience are unknown', { skip: decide ? false : 'replica WASM not built' }, () => {
  const ask = (form, state, seen = SEEN_FIELDS) => judge(decide, { verb: 'v', this: 'l1', form }, { kinds, state, asker: { sees: [] }, seen });
  const lit = ask('switch_on', lamp({ lit: true }));
  assert.equal(lit.verdict, 'no');
  assert.equal(lit.reason, 'field_differs');
  assert.deepEqual(lit.fix, { form: 'switch_off' });
  assert.equal(canOf(lit, true).can, 'no');
  // Links are not in the daemon's copy yet: a link's no is unknown there, a definite no where links are held.
  assert.equal(ask('unplug', lamp({})).verdict, 'unknown');
  assert.equal(ask('unplug', lamp({}), SEEN_ALL).reason, 'not_linked');
  // Unlit, its owner-only wiring is outside the client's audience: unknown, never no.
  assert.equal(ask('switch_on', lamp({ lit: false })).verdict, 'unknown');
  assert.equal(ask('dim', lamp({ level: 500 })).verdict, 'yes');
});
