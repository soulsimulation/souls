// #2235: world time never stops. A world's clock keeps wall pace whether anyone watches or not (the unwatched quarter
// pace and the launcher's idle freeze and idle exit are gone: no world can prove that nothing but pure time passes
// while it would be asleep; the audit is on the issue). What remains are gaps no world can avoid: a restart, a deploy,
// a memory-pressure eviction, a crash. Across those the world is caught up exactly, by ticking: on boot it runs every
// tick it missed through the ordinary tick (WorldHost.catchUp), listeners and all, before its clock starts and before it
// serves. Nothing jumps and nothing is approximated: the world state it reaches is the state a world ticked through the
// gap would have reached (clock-catchup.test.ts compares the hashes, needs, day turns and moments included). Not yet for
// listener state kept in memory or on the wall clock (#2236): the edge ambient-life idle clock starts over at the boot,
// and the body rule's wall timers (doze, asleep, drift) see the whole gap at the first catch-up ticks.
//
// How many ticks it missed comes from the wall anchor in <DATA_DIR>/clock-wall.json: a (wall time, tick) pair saved
// every few seconds while the world runs and once more as it stops. The ticks owed on boot are the wall time since the
// anchor, at the world's rate, less the ticks already logged after it (a crash replays its log tail first). An
// admin-paused world is owed nothing for the time it was paused. The wall clock is read here, at the server boundary;
// the engine only ever sees ordinary ticks.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const TICK_MS = 50;
/** An anchor names its contract: the pre-#2235 unwatched anchor (same file, no contract) is never read as one. */
export const WALL_ANCHOR = 'wall-anchor/1';
export type WallAnchor = { contract?: typeof WALL_ANCHOR; worldId: string; wall: number; tick: number; paused?: boolean };
type Host = { worldId: string; engine: { world: { tick: number } }; baseRate: number; paused: boolean };

/** Ticks owed to the wall at `now` since `a` for a world now at `tick` (0 when paused at the anchor, or none). */
export function owedTicks(a: WallAnchor | null, tick: number, now: number, rate = 1): number {
  if (!a || a.paused || !(now > a.wall)) return 0;
  return Math.max(0, Math.floor(((now - a.wall) * (rate > 0 ? rate : 1)) / TICK_MS) - (tick - a.tick));
}

export class WallClock {
  readonly file: string;
  private host: Host;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  constructor(host: Host, dataDir: string, o: { now?: () => number } = {}) {
    this.host = host; this.now = o.now ?? Date.now;
    this.file = join(dataDir, 'clock-wall.json');
  }
  /** The anchor the last run left, if it is this world's. */
  read(): WallAnchor | null {
    try {
      const a = JSON.parse(readFileSync(this.file, 'utf8')) as WallAnchor | null;
      return a && a.contract === WALL_ANCHOR && a.worldId === this.host.worldId && Number.isFinite(a.wall) && Number.isSafeInteger(a.tick) ? a : null;
    } catch { return null; }
  }
  /** Ticks this boot owes the wall. */
  owed(): number { return owedTicks(this.read(), this.host.engine.world.tick, this.now(), this.host.baseRate); }
  /** Record (now, tick). Best effort: a failed write keeps the previous anchor (a longer catch-up, never a jump); a
   *  missing or unreadable file means nothing is owed, so that boot loses its gap. */
  save() {
    const a: WallAnchor = { contract: WALL_ANCHOR, worldId: this.host.worldId, wall: this.now(), tick: this.host.engine.world.tick, ...(this.host.paused ? { paused: true } : {}) };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(a) + '\n'); renameSync(tmp, this.file); } catch { /* next time */ }
  }
  /** Save the anchor every `everyMs` while the world runs (and at once). */
  start(everyMs = 5_000) { this.save(); this.timer = setInterval(() => this.save(), everyMs); this.timer.unref?.(); return this; }
  /** Stop saving and record the final anchor, once (call as the clock stops: the wall time after it is owed). */
  stop() { if (!this.timer) return; clearInterval(this.timer); this.timer = null; this.save(); }
}
