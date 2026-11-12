// #2124 MEASUREMENT BRANCH ONLY (never merged): loaded into a world with NODE_OPTIONS=--import, it CPU-profiles the
// world's main thread between two marker files in SIM_PROF_DIR (prof.start, prof.stop) and writes world.cpuprofile.
import { Session } from 'node:inspector';
import { isMainThread } from 'node:worker_threads';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.SIM_PROF_DIR;
if (dir && isMainThread && (process.argv[1] ?? '').endsWith('apps/server/src/main.ts')) {
  const s = new Session(); s.connect();
  const post = (m, p = {}) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  let on = false, busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try {
      if (!on && existsSync(join(dir, 'prof.start'))) { rmSync(join(dir, 'prof.start')); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start'); on = true; }
      else if (on && existsSync(join(dir, 'prof.stop'))) { rmSync(join(dir, 'prof.stop')); const { profile } = await post('Profiler.stop'); on = false; writeFileSync(join(dir, 'world.cpuprofile'), JSON.stringify(profile)); }
    } catch (e) { process.stderr.write(`[prof-hook] ${e?.message ?? e}\n`); }
    busy = false;
  }, 250).unref();
}
