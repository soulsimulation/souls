// #2585: a take the engine no longer keeps is collected. Since #2422 each take's baseline hash is read lazily from the take
// before it; that function must hold only the earlier take's final state, never its body, or every take ever cut stays
// reachable from the current recorder (a chain), and a watched world's heap grows until the watchdog restarts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import type { Take } from '../../../mars/viewer/engine/take/types.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const factory = await marsFactory({ ...GREEN_FIELD_WORLD, heldActivitiesV1: true, soulsRepairV1: true });

/** Three bodies walk for 40 takes (the engine keeps 12); `watched` reads each new take's id, as a watched world's hub does.
 *  Returns how many of the first 20 takes' final states are still reachable. */
async function stillHeld(watched: boolean) {
  const e = factory.create(factory.genesis('take-retain-2585')) as MarsEngine;
  for (const [id, label] of [['a', 'Ada'], ['b', 'Bo'], ['c', 'Cy']]) e.spawnHuman({ id, label, soul: `s_${id}` });
  const walk = (id: string, to: [number, number]) => assert.equal(e.perform({ actor: id, label: 'walk', steps: [{ verb: 'walk_to', params: { to } }] } as never).ok, true);
  walk('a', [8, 2]); walk('b', [-7, 3]); walk('c', [3, -8]);
  const refs = new Map<number, WeakRef<object>>();
  for (let i = 0; i < 800; i++) {
    e.step();
    for (const c of e.takeChunks(-1)) {
      const t = c.take as Take;
      if (refs.has(t.startTick)) continue;
      refs.set(t.startTick, new WeakRef(t.finalState as object));
      if (watched) void t.id;
    }
  }
  assert.ok(refs.size >= 39, `takes cut: ${refs.size}`);
  await new Promise((r) => setImmediate(r));
  gc();
  return [...refs].sort((x, y) => x[0] - y[0]).slice(0, 20).filter(([, r]) => r.deref() !== undefined).map(([t]) => t);
}

test('#2585: a take the engine has dropped is collected, watched or not', async () => {
  assert.deepEqual(await stillHeld(true), [], 'watched: early takes still reachable');
  assert.deepEqual(await stillHeld(false), [], 'unwatched: early takes still reachable');
});
