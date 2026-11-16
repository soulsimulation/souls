// #2501 follow-up: a boot catch-up on a host slower than the wall stops after 32 rounds with a tick or two still owed
// (merge-group CI: "1 ticks still owed when the catch-up stopped (still behind after 32 rounds): not run"). Those ticks
// were dropped: the clock started from there and the world stayed behind the wall for good. They are now handed to the
// running clock (WorldHost.oweToClock), whose first frame runs them: world time never stops. No wall-time race: the
// first frame is called at once (its own elapsed time is ~0), and the batch it starts is read and then run to its end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../test/native-owner-fixture.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Clocked = { skip: boolean; paused: boolean; frame(): void; frameBatch: { remaining: number } | null };
async function firstFrame(owe: number, { pausedWhenOwed = false } = {}) {
  const f = fixture(':memory:'), h = f.host as unknown as Clocked;
  try {
    h.skip = false;   // every tick runs (a still world may otherwise be set forward in one jump later)
    if (pausedWhenOwed) h.paused = true;
    f.host.oweToClock(owe);
    h.paused = false;
    const t0 = f.host.engine.world.tick;
    f.host.start(); h.frame();   // the first frame, now
    const batch = (h.frameBatch?.remaining ?? 0) + (f.host.engine.world.tick - t0);
    for (let i = 0; i < 400 && h.frameBatch; i++) await wait(25);   // let that batch run to its end, however slow the host
    const ran = f.host.engine.world.tick - t0;
    f.host.stop();
    return { batch, ran };
  } finally { f.brain.quiesce(); f.db.close(); }
}

test('ticks a catch-up still owed are the clock\'s first frame, and all of them run', async () => {
  const plain = await firstFrame(0), owed = await firstFrame(12);
  assert.ok(plain.batch <= 1, `the clock alone owes no tick at its start (${plain.batch})`);
  assert.equal(owed.batch, 12, 'the first frame is the 12 owed ticks');
  assert.ok(owed.ran >= 12, `all 12 ran (${owed.ran})`);
});

test('a world paused when the catch-up ends is owed nothing', async () => {
  const r = await firstFrame(12, { pausedWhenOwed: true });
  assert.ok(r.batch <= 1, `nothing owed (${r.batch})`);
});
