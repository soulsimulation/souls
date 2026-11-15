// #2378 (SIM_FAULT_INJECT=1, tests and measurement only): faults that outlive a request, beside main.ts's /__sim/fault kinds.
//  hang-at&tick=N&ticks=K  a step (one listener's afterTick, named `fault-inject hang-at`) that never returns at ticks N to
//                  N+K-1 (K default 1), on every boot: kept in <DATA_DIR>/fault-at.json, and the listener claims N as a
//                  deadline so a catch-up lands on it (a restart loop; a durable-clock world dies one tick later each boot)
//  corrupt         a Soul's body broken in memory (its pose no number), as invariant corruption is: under quarantine/1
//                  (adopted first, as edge worlds do) the world holds that body and runs on
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {WorldHost} from '../world.ts';

export function installFaultInject(host: WorldHost, dataDir: string) {
  const file = join(dataDir, 'fault-at.json');
  let at: number | null = null, ticks = 1;
  try { const j = JSON.parse(readFileSync(file, 'utf8')); at = Number(j.tick); ticks = Number(j.ticks) || 1; if (!Number.isFinite(at)) at = null; } catch { at = null; }
  host.listeners.push({
    name: 'fault-inject hang-at',
    afterTick: (t) => { if (at !== null && t >= at && t < at + ticks) for (;;) { /* stuck, every boot that runs this tick */ } },
    stillness: (t) => (at !== null && t < at + ticks - 1 ? [{name: 'fault-inject', tick: Math.max(at, t + 1)}] : []),
  });
  return (kind: string, q: URLSearchParams): boolean => {
    if (kind === 'hang-at') {
      const tick = Number(q.get('tick')), k = Math.max(1, Math.floor(Number(q.get('ticks')) || 1)); if (!(tick > host.engine.world.tick)) return false;
      at = tick; ticks = k; writeFileSync(file, JSON.stringify({tick, ticks: k})); return true;
    }
    if (kind === 'corrupt') {
      const m = [...host.minds.values()][0]; if (!m) return false;
      void host.enableQuarantineV1('operator:fault-inject').then(() => {
        const e = (host.engine.world.entities as Record<string, {pose?: {p?: number[]}}>)[m.entityId];
        if (e?.pose?.p) e.pose.p[0] = Number.NaN;
        // break it just before a sweep tick (WorldHost.sweepBrokenBodies, every BROKEN_SWEEP_TICKS): sweep now, as that tick would
        if (q.get('sweep') !== '0') (host as unknown as {sweepBrokenBodies?: () => void}).sweepBrokenBodies?.();
      }).catch((error) => console.error('[fault-inject] corrupt failed:', String(error).slice(0, 200)));
      return true;
    }
    return false;
  };
}
