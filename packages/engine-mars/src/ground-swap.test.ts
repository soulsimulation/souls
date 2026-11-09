// #1443 ground-swap/1: under souls-repair the engine's step guards every invariant once, so a ground installed into a running
// world (a ground fact folding mid-life) swapped nothing by identity: the world kept the flat-ground speed and static-clearance
// invariants on ground terrain. Under the policy the swap goes through the guards, at the install and at the policy's adoption
// on a world that already has its ground. Without it, as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, unguardedV1, type MarsEngine } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { emptyGround } from '../../ground/src/index.ts';
import { speedWithinCap, humanStaticClearance } from '../../../mars/viewer/engine/runtime/invariants.ts';

const f = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
function world(policy: boolean) {
  const e = f.create(f.genesis('ground-swap')) as MarsEngine;
  if (policy) e.configureRuntimePolicy({ sleepBlockTicks: 1200, groundSwapV1: true } as never);
  e.spawnHuman({ id: 'a', label: 'Ada', soul: 's_a', at: [0, 0] } as any);
  e.step(); e.step();   // the repair step has guarded the invariants
  return e;
}
const rt = (e: MarsEngine) => (e as any).rt;
const flat = (e: MarsEngine) => rt(e).invariants.map(unguardedV1).filter((i: unknown) => i === speedWithinCap || i === humanStaticClearance).length;

for (const policy of [false, true])
  test(`#1443 a ground installed into a running souls-repair world ${policy ? 'swaps in the ground invariants through their guards' : 'keeps the flat-ground ones (as recorded)'}`, () => {
    const e = world(policy), n = rt(e).invariants.length;
    assert.equal(flat(e), 2, 'flat ground: both flat invariants run');
    e.installGroundV1(groundFact(emptyGround(256), 1, { paged: true })); e.step(); e.step();
    assert.equal(rt(e).invariants.length, n, 'the same number of invariants');
    assert.equal(flat(e), policy ? 0 : 2, policy ? 'the ground variants run' : 'the flat ones still run');
    if (policy) { const once = rt(e).invariants; e.step(); assert.deepEqual(rt(e).invariants, once, 'guarded once: the next step wraps nothing again'); }
  });

test('#1443 ground-swap/1 adopted on a world that already installed its ground mid-life repairs it from that event on', () => {
  const e = world(false);
  e.installGroundV1(groundFact(emptyGround(256), 1, { paged: true })); e.step();
  assert.equal(flat(e), 2, 'as recorded before the event');
  const before = e.stateHash();
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, groundSwapV1: true } as never); e.step();
  assert.equal(flat(e), 0, 'swapped at the adoption'); assert.notEqual(e.stateHash(), before);
});

// The divergence the policy closes: a restore attaches the ground to a fresh, unguarded list, so a world rebooted from a snapshot
// taken after a mid-life install already runs the ground invariants, flag or not; the live process (and a replay through the
// install) ran the flat ones. Under the policy the live path matches the restored one.
for (const policy of [false, true])
  test(`#1443 a world restored after a mid-life ground install runs the ground invariants (live ${policy ? 'matches it under the policy' : 'diverges from it without the policy, as recorded'})`, () => {
    const e = world(policy);
    e.installGroundV1(groundFact(emptyGround(256), 1, { paged: true })); e.step();
    const g = f.restore(e.snapshot()) as MarsEngine; g.step();
    assert.equal(flat(g), 0, 'restored: the ground variants run');
    assert.equal(flat(e), policy ? 0 : 2, policy ? 'live: the same' : 'live: still the flat ones');
  });

