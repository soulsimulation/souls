// #2378: a disk filling up. Every minute the world looks at the free space where its data lives; under the headroom it says so
// in the log (`[load] disk.low`) and prunes by the existing retention rules (main.ts: the hourly backups' rule, brain calls,
// talk, local takes), and the hourly backup, the largest write a world makes, waits while it is low. Nothing beyond those
// rules is deleted. A world whose disk fills anyway fails a write: a named halt the launcher restarts (#2133).
import {statfsSync} from 'node:fs';

/** The headroom: SIM_DISK_MIN_FREE_MB (default 1024; 0 = never). */
export function diskMinFreeMb(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.SIM_DISK_MIN_FREE_MB;
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 1024;
}
export function freeMb(path: string): number { const s = statfsSync(path); return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576); }

export function diskHeadroom(o: {path: string; minFreeMb: number; prune: () => void; log?: (line: string) => void; free?: (path: string) => number}) {
  const log = o.log ?? ((l: string) => console.error(l));
  let low = false, override: number | null = null;
  const look = () => {
    if (!(o.minFreeMb > 0)) return false;
    let mb: number;
    try { mb = override ?? (o.free ?? freeMb)(o.path); } catch { return low; }
    if (mb < o.minFreeMb) {
      log(`[load] disk.low: ${mb} MB free, under the ${o.minFreeMb} MB headroom: pruning by the retention rules; the hourly backup waits`);
      try { o.prune(); } catch (e) { log(`[load] disk.low: prune failed: ${String(e).slice(0, 200)}`); }
      low = true;
    } else if (low) { log(`[load] disk.ok: ${mb} MB free`); low = false; }
    return low;
  };
  return {
    look,
    /** True while the last look found the disk under the headroom. */
    get low() { return low; },
    /** Tests only (SIM_FAULT_INJECT): read this many MB free instead of the disk's own figure (null: the disk again). */
    pretend(mb: number | null) { override = mb; return look(); },
    start(everyMs = 60_000) { const t = setInterval(look, everyMs); t.unref(); look(); return t; },
  };
}
