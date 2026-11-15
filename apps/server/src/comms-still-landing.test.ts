// #2384 A2: a silent world that lands on the comms deadline runs the sweep there, not at the next 30 s wall timer (until the
// sweep runs, the deadline stays due at the next tick and the world cannot stay still).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from './db.ts';
import { commsFixture } from './edge/comms/testing.ts';

test('#2384 A2: a silent world landing on the comms deadline sweeps at once; a busy one waits for its timer', async (t) => {
  const db = new Db(':memory:');
  let silent = true;
  const listeners: { afterTick?(tick: number): void }[] = [];
  const f = commsFixture(['Alice'], { sweepMs: 0 }, { dir: '', db, clock: { now: 1_800_000_000_000 } }, (_app, deps) => {
    Object.assign(deps.host, { listeners, silent: () => silent });
  });
  t.after(() => { f.close(); db.close(); });
  let sweeps = 0; t.mock.method(f.runtime.conversations, 'sweep', () => { sweeps++; });   // the sweep's first step
  const world = f.host.engine.world as { tick: number };
  const due = f.runtime.nextDueTick();
  t.diagnostic(JSON.stringify({ tick: world.tick, due }));
  assert.ok(due !== null, 'the fixture has a comms deadline');
  const land = async (tick: number) => { world.tick = tick; for (const l of listeners) l.afterTick?.(tick); await new Promise((r) => setImmediate(r)); };
  await land(due - 1); assert.equal(sweeps, 0, 'before the deadline: no sweep');
  silent = false; await land(due); assert.equal(sweeps, 0, 'a world that is not silent keeps its 30 s timer');
  silent = true; await land(due); assert.equal(sweeps, 1, 'a silent world landing on the deadline sweeps at once');
});
