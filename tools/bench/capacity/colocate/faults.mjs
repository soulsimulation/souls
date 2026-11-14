// #2300: a fault injected into one world from outside, for the trial's isolation arm. The world's thread polls
// <DATA_DIR>/colocate-fault every 250 ms; the file's text names the fault, run on that thread:
//   throw  an uncaught exception (the next turn of the event loop)
//   alloc  a runaway allocation: about 30 MB of live heap objects every 50 ms, kept, until the heap limit
//   long   one long tick: the thread is held 15 s in a busy loop
// Measurement only: armed by the trial's own entry points (preload.mjs, world-entry.mjs, host.mjs), never by the server.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function armFaults(dataDir) {
  const file = join(dataDir, 'colocate-fault'), kept = [];
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    const kind = readFileSync(file, 'utf8').trim(); rmSync(file, { force: true });
    console.log(`[colocate] fault ${kind}`);
    if (kind === 'throw') setTimeout(() => { throw new Error('colocate: injected exception'); });
    else if (kind === 'alloc') setInterval(() => { kept.push(Array.from({ length: 1 << 19 }, (_, i) => ({ i, s: `x${i}` }))); }, 50);
    else if (kind === 'long') { const t = Date.now(); while (Date.now() - t < 15_000) { /* held */ } }
  }, 250);
  timer.unref();
}
