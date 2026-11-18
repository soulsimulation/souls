// #2378: a disk filling up. Every minute the world looks at the free space where its data lives; under the headroom it says so
// in the log (`[load] disk.low`) and prunes by the existing retention rules (main.ts: the hourly backups' rule, brain calls,
// talk, local takes), and the hourly backup, the largest write a world makes, waits while it is low. Nothing beyond those
// rules is deleted. While it is low, uploads are refused (#2538, refuseWhenDiskLow). A world whose disk fills anyway fails a write: a named halt the launcher restarts (#2133).
import {statfsSync} from 'node:fs';

/** The headroom: SIM_DISK_MIN_FREE_MB (default 1024; 0 = never). */
export function diskMinFreeMb(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.SIM_DISK_MIN_FREE_MB;
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 1024;
}
export function freeMb(path: string): number { const s = statfsSync(path); return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576); }

/** #2538: the process's disk.low, as its own headroom last found it (one world per process). */
let lowNow = false;
/** How long a refused upload is asked to wait: the world looks every minute, and room is made by pruning or an operator. */
export const DISK_LOW_RETRY_S = 300;
/** #2538: an overload guard against filling the disk, not a limit on anyone. While disk.low, the upload routes (god assets
 *  and thumbnails, art media, bodies) answer 507 host.disk-low with Retry-After; acts, ticks, snapshots, the journal and
 *  viewing never read this. `make` builds the route's own error type (ApiError, EdgeError). */
export function refuseWhenDiskLow<E extends Error>(c: {header: (k: string, v: string) => void}, make: (status: number, code: string, message: string, extra: Record<string, unknown>) => E): void {
  if (!lowNow) return;
  c.header('Retry-After', String(DISK_LOW_RETRY_S));
  throw make(507, 'host.disk-low', `The host's disk is nearly full, so uploads are paused to keep this world running. Nothing was stored. Try again in ${DISK_LOW_RETRY_S / 60} minutes.`,
    {retry_after: DISK_LOW_RETRY_S, retryAfterMs: DISK_LOW_RETRY_S * 1000, limit: {scope: 'disk'}});
}

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
      low = lowNow = true;
    } else if (low) { log(`[load] disk.ok: ${mb} MB free`); low = lowNow = false; }
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
