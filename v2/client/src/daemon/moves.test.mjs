// C14 (#3442): `can` on a move answers from replica's `move_check` in the WASM build (v2/target/wasm-load/pkg), the
// function the world runs; the world's side of the same verdicts is `worldd/tests/moves.rs`
// (`c14_a_walk_to_a_place_ranked_fallbacks_and_the_local_check`).

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moveForm, moveVerdict, seatedAfter } from './moves.mjs';

const pkg = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'target/wasm-load/pkg');
const wire = await import(pathToFileURL(join(pkg, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });

test('C14 A3: can on a walk, sit, lie or rise answers from the move check, not unknown', () => {
  const square = '07070707070707070707070707070707-12', chair = '07070707070707070707070707070707-9002';
  const nodes = { [square]: { kind: 'eden:area' } };
  const can = (intent, seated) => moveVerdict(wire.move_check, intent, { nodes, seated });
  assert.deepEqual(can({ verb: 'eden:walk', this: square }, false), { verdict: 'yes' });
  assert.deepEqual(can({ verb: 'eden:walk' }, false), { verdict: 'no', reason: 'move.no-target' });
  assert.deepEqual(can({ verb: 'eden:walk', this: square, point: [1, 2] }, false), { verdict: 'no', reason: 'move.bad-point' });
  assert.deepEqual(can({ verb: 'eden:walk', this: square }, true), { verdict: 'no', reason: 'resource-held' });
  assert.deepEqual(can({ verb: 'eden:sit', this: chair }, true), { verdict: 'no', reason: 'place-already-held' });
  assert.deepEqual(can({ verb: 'eden:lie', this: chair }, false), { verdict: 'unknown', why: 'not-in-copy' });
  assert.deepEqual(can({ verb: 'eden:rise' }, false), { verdict: 'no', reason: 'not-seated' });
  assert.deepEqual(can({ verb: 'eden:rise' }, true), { verdict: 'yes' });
  assert.deepEqual(can({ verb: 'eden:rise' }, null), { verdict: 'unknown', why: 'posture-not-known' });
  assert.equal(moveForm('souls:walk'), null, 'the engine\'s own verbs are not moves');
  assert.equal(moveForm('eden:toggle'), null);
  // The posture follows the body's own receipts: a sit's makes it seated, a rise's or a walk's standing.
  assert.equal(seatedAfter('sit', 1, null), true);
  assert.equal(seatedAfter('rise', 1, true), false);
  assert.equal(seatedAfter('walk', 2, true), true, 'a refusal leaves it as it was');
});
