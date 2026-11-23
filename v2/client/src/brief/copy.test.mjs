// The daemon reads its copy as rows after every follow (`hearing`), and a walking body re-hashes itself and the room
// above it at each one. The rows' decoded records must stay those the copy still holds: before this, every version
// of the room stayed decoded and the daemon grew by megabytes a second while one Soul walked, until Node's heap ran
// out (Mars rehearsal, 22 Nov 2026).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { encode } from '../history/day.mjs';
import { posesOf, rowsOf } from './copy.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const scope = Buffer.from('scope');
const hashOf = (raw) => `1220${createHash('sha256').update(raw).digest('hex')}`;

/** A copy as replica's `Copy` keeps it after a sync: only the records its roots reach. */
function walkingCopy(things) {
  const held = new Map(), put = (m) => { const raw = encode(m), h = hashOf(raw); held.set(h, raw); return h; };
  const children = [];
  for (let i = 0; i < things; i++) {
    children.push(Buffer.from(put(new Map([[1, [scope, 100 + i]], [2, 'eden:chair'], [7, new Map([[2, [i * 1000, 0, 0]]])], [10, []]])), 'hex'));
  }
  let roots = {}, was = [];
  const copy = { roots: () => JSON.stringify(roots), record: (h) => held.get(h) };
  /** One stream part: the body a step on, so it and its room have new hashes, and the old ones are let go. */
  copy.step = (x) => {
    const body = put(new Map([[1, [scope, 2]], [2, 'souls:body'], [3, [scope, 1]], [7, new Map([[2, [x, 0, 0]]])], [10, []]]));
    const room = put(new Map([[1, [scope, 1]], [2, 'eden:place'], [10, [...children, Buffer.from(body, 'hex')]]]));
    for (const h of was) held.delete(h);
    was = [body, room];
    roots = { 0: room };
  };
  return copy;
}

test('rows read after every step of a walk keep the heap flat', () => {
  const copy = walkingCopy(2000);
  copy.step(0);
  rowsOf(copy);
  const before = heap();
  for (let x = 1; x <= 300; x++) { copy.step(x); rowsOf(copy); posesOf(copy); }
  const grew = heap() - before;
  // Every room version kept decoded was about 0.5 MB here (150 MB over the walk); the room's current one is all.
  assert.ok(grew < 10e6, `heap grew ${(grew / 1e6).toFixed(1)} MB over 300 steps`);
  const rows = rowsOf(copy);
  assert.equal(rows.size, 2002);
  assert.deepEqual(rows.get('73636f7065-2').pos, [300, 0, 0], 'the body where its last step put it');
  assert.deepEqual(posesOf(copy).get('73636f7065-101').at, [1, 0, 0]);
});
