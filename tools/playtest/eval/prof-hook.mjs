// #2124 MEASUREMENT BRANCH ONLY (never merged): loaded into a world with NODE_OPTIONS=--import, it CPU-profiles the
// world's main thread between two marker files in SIM_PROF_DIR (prof.start, prof.stop) and writes world.cpuprofile.
// #2437 A1: turn markers. Every timer and immediate callback (global and `node:timers`) is wrapped so its start and end
// (process.hrtime, µs, the profile's own clock) are recorded while profiling: the profile's busy runs are split there, so
// ticks chained by setImmediate and the audit's slices count as separate holds. An event-loop delay histogram runs over
// the same window, an independent measure of the longest hold (holds.json).
import { Session } from 'node:inspector';
import { isMainThread } from 'node:worker_threads';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const dir = process.env.SIM_PROF_DIR;
if (dir && isMainThread && (process.argv[1] ?? '').endsWith('apps/server/src/main.ts')) {
  const now = () => Number(process.hrtime.bigint() / 1000n);
  let on = false, depth = 0, marks = [], longestCb = 0;
  const wrap = (fn) => (typeof fn !== 'function' ? fn : function wrappedMacrotask(...a) {
    const top = depth++ === 0 && on, t0 = top ? now() : 0;
    try { return fn.apply(this, a); } finally { if (--depth === 0 && top) { const t1 = now(); marks.push(t0, t1); if (t1 - t0 > longestCb) longestCb = t1 - t0; } }
  });
  const patch = (obj, name) => {
    const orig = obj[name]; if (typeof orig !== 'function' || orig.__w2437) return;
    const w = function (fn, ...rest) { return orig.call(this, wrap(fn), ...rest); };
    for (const k of Reflect.ownKeys(orig)) if (!(k in w) || typeof k === 'symbol') try { w[k] = orig[k]; } catch { /* read-only */ }
    w.__w2437 = true; obj[name] = w;
  };
  const timers = createRequire(import.meta.url)('node:timers');
  for (const n of ['setImmediate', 'setTimeout', 'setInterval']) { patch(timers, n); patch(globalThis, n); }
  syncBuiltinESMExports();
  const eld = monitorEventLoopDelay({ resolution: 5 });
  const s = new Session(); s.connect();
  const post = (m, p = {}) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  let busy = false, hrAtStart = 0;
  setInterval(async () => {
    if (busy) return; busy = true;
    try {
      if (!on && existsSync(join(dir, 'prof.start'))) { rmSync(join(dir, 'prof.start')); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start'); hrAtStart = now(); marks = []; longestCb = 0; eld.reset(); eld.enable(); on = true; }
      else if (on && existsSync(join(dir, 'prof.stop'))) {
        rmSync(join(dir, 'prof.stop')); on = false; eld.disable(); const { profile } = await post('Profiler.stop');
        writeFileSync(join(dir, 'world.cpuprofile'), JSON.stringify(profile));
        const ms = (ns) => Math.round(ns / 1e4) / 100;
        writeFileSync(join(dir, 'holds.json'), JSON.stringify({ hrAtStartUs: hrAtStart, profileStartUs: profile.startTime, profileEndUs: profile.endTime, marks, longestMarkedCallbackMs: Math.round(longestCb / 10) / 100,
          eld: { resolutionMs: 5, n: eld.count, minMs: ms(eld.min), meanMs: ms(eld.mean), p50Ms: ms(eld.percentile(50)), p90Ms: ms(eld.percentile(90)), p99Ms: ms(eld.percentile(99)), p999Ms: ms(eld.percentile(99.9)), maxMs: ms(eld.max) } }));
        const g = globalThis; writeFileSync(join(dir, 'grid-stats.json'), JSON.stringify({ window: g.__w2404 ? { ...g.__w2404, seen: g.__w2404.seen.size, recent: undefined } : null, tiles: Object.fromEntries(Object.entries(g.__m2404 ?? {}).map(([k, v]) => [k, { ...v, keys: v.keys.size }])) }));
      }
    } catch (e) { process.stderr.write(`[prof-hook] ${e?.message ?? e}\n`); }
    busy = false;
  }, 250).unref();
}
