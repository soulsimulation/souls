// #1521 review: when the world refuses a stall release (stand-height/2: nowhere clear on the floor near a body standing above it,
// so the engine leaves it held), the owner's receipt says so (failed stall.no-floor-spot), never "set down nearby", and the guard
// does not log another release every limit while that hold is unchanged. A release that works is reported as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {StallGuard, LIMIT_S} from './stall-guard.ts';

function guard(freed: boolean) {
  let tick = 0, held = true;
  const releases: string[] = [], records: {reason: string; held?: boolean}[] = [];
  const soul = {soulId: 's_a', entityId: 'h_a', name: 'Ana', owner: 'dev:ana'} as never;
  const g = new StallGuard({
    tick: () => tick, souls: () => [soul],
    probe: () => held ? {held: true, candidate: true, exempt: null, signature: 'sig-1', verbs: ['walk_to'], pending: false, holders: [{verb: 'walk_to', phase: 'cancelling', state: 'stopping'}], markers: []} : null,
    release: async () => { releases.push('edge-stop'); if (freed) held = false; },
    record: (_s, reason, _d, h) => { records.push({reason, held: h}); },
  });
  const run = async (seconds: number) => { for (let i = 0; i < seconds * 20; i++) { tick++; g.afterTick(tick); await Promise.resolve(); } };
  return {g, run, releases, records, soul};
}

test('#1521 a release the world refuses is reported held (stall.no-floor-spot), once, and not re-logged while the hold is unchanged', async () => {
  const {run, releases, records} = guard(false);
  await run(LIMIT_S * 4);
  assert.equal(releases.length, 1, `one logged release attempt in ${LIMIT_S * 4} s, not one every ${LIMIT_S} s`);
  assert.equal(records.length, 1); assert.equal(records[0].held, true); assert.match(records[0].reason, /stall\.no-floor-spot/);
  assert.doesNotMatch(records[0].reason, /set .* down nearby/);
});

test('#1521 a release that works is reported as before (stall.released, set down nearby)', async () => {
  const {run, releases, records} = guard(true);
  await run(LIMIT_S + 2);
  assert.equal(releases.length, 1); assert.equal(records.length, 1);
  assert.notEqual(records[0].held, true); assert.match(records[0].reason, /set Ana down nearby/);
});

test('#1521 stand:here on a hold the world cannot release answers held, not success', async () => {
  const {g, soul} = guard(false);
  assert.equal(await g.ownerStand(soul), 'held');
});
