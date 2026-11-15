// #2451 shard form: `node --import <this> tools/world-launcher/shard.mjs` arms the fault poller once per shard program,
// on <COLOCATE_PROGRAMS>/<pid>/colocate-fault (a shard has no data dir of its own); the bench uses only its `gc`.
// COLOCATE_CALLBACK_SLOT=1 (#2451 A4, the deferred #2445 review item 5, measured, not built): before every callback of
// the program an async hook writes the number of the world it runs for (its renderWorld context) into a shared slot, as
// a watchdog thread would read it to blame the right world for a hang outside a tick. Only its cost is measured.
import { mkdirSync } from 'node:fs';
import { createHook } from 'node:async_hooks';
import { join } from 'node:path';
import { armFaults } from './faults.mjs';
const dir = join(process.env.COLOCATE_PROGRAMS, String(process.pid));
mkdirSync(dir, { recursive: true });
armFaults(dir);
if (process.env.COLOCATE_CALLBACK_SLOT === '1') {
  const { renderWorld } = await import(new URL('../../../../apps/server/src/god/host-render-slot.ts', import.meta.url).href);
  const slot = new Int32Array(new SharedArrayBuffer(4)), ids = new Map();
  const no = (id) => { let n = ids.get(id); if (n === undefined) { n = ids.size + 1; ids.set(id, n); } return n; };
  createHook({ before() { const id = renderWorld.getStore(); Atomics.store(slot, 0, id === undefined ? 0 : no(id)); } }).enable();
  globalThis.__colocateCallbackSlot = slot;
}
