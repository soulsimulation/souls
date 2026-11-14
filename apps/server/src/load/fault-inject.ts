// #2378 (SIM_FAULT_INJECT=1, tests and measurement only): faults that outlive a request, beside main.ts's /__sim/fault kinds.
//  hang-at&tick=N  a step (one listener's afterTick) that never returns at tick N, on every boot: the tick is kept in
//                  <DATA_DIR>/fault-at.json and the listener claims N as a deadline, so a catch-up lands on it (restart loop)
//  corrupt         a Soul's body broken in memory (its pose no number), as invariant corruption is: under quarantine/1
//                  (adopted first, as edge worlds do) the world holds that body and runs on
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {WorldHost} from '../world.ts';

export function installFaultInject(host: WorldHost, dataDir: string) {
  const file = join(dataDir, 'fault-at.json');
  let at: number | null = null;
  try { at = Number(JSON.parse(readFileSync(file, 'utf8')).tick); if (!Number.isFinite(at)) at = null; } catch { at = null; }
  host.listeners.push({
    afterTick: (t) => { if (t === at) for (;;) { /* stuck, every boot that runs this tick */ } },
    stillness: (t) => (at !== null && t < at ? [{name: 'fault-inject', tick: at}] : []),
  });
  return (kind: string, q: URLSearchParams): boolean => {
    if (kind === 'hang-at') { const tick = Number(q.get('tick')); if (!(tick > host.engine.world.tick)) return false; at = tick; writeFileSync(file, JSON.stringify({tick})); return true; }
    if (kind === 'corrupt') {
      const m = [...host.minds.values()][0]; if (!m) return false;
      void host.enableQuarantineV1('operator:fault-inject').then(() => {
        const e = (host.engine.world.entities as Record<string, {pose?: {p?: number[]}}>)[m.entityId];
        if (e?.pose?.p) e.pose.p[0] = Number.NaN;
      });
      return true;
    }
    return false;
  };
}
