// #1649 part 4: the existing-data mapping when a world's clock comes onto real time (the cut-over).
//
// The accelerated clock counted one world day per real hour, so a world that ran on it for weeks is hundreds of world days
// in; on real time the day and date are the local ones, a few dozen days after the clock's epoch. The day number goes back
// once, at the cut-over. What reads it:
//
// - History keeps the clock reading it was recorded with: timeline rows, receipts and journal entries are never rewritten.
// - Pending world-clock reminders keep their time of day and their distance in world days (due tomorrow at 18:00 stays due
//   tomorrow at 18:00, local time). Real-clock reminders are untouched.
// - Day stamps that count an age (posters on a poster wall, chalk drawings that fade) keep their age in world days: the
//   stamp moves back by the same number of days as the day number (never below day 0, which is already old enough to
//   read as stale or washed away).
// - Calendar items are scheduled by tick: an upcoming one starts at the same real moment it would have.
// - Nothing is deleted.
//
// The mapping runs when the clock comes onto real time from another clock (installRealClock's onCutOver), after the clock's
// rules event has applied. That event names the cut-over (`dayConfig.cutOver`: its tick and both clocks), and later clock
// events carry it on, so a mapping that failed or was cut short by a restart is finished at the next boot or check. Each
// part is idempotent and records that it ran: the reminder rows change in one transaction with a marker row
// (`edge_clock_cutover_v1`); the stamps move in one recorded engine edit whose note names the cut-over tick.
import { clockAt } from '@souls/brain';
import { posterList, type WorldModel, type Op } from '@souls/world-compiler';
import type { DatabaseSync } from 'node:sqlite';
import { canvasFace } from '../art/art.ts';

export type DayClock = { origin: number; dayTicks: number };
export type CutOver = { tick: number; from: DayClock; to: DayClock };
/** The god edit note that records a cut-over's stamp move (found again by its tick: the stamps move once). */
export const stampNote = (c: CutOver) => `world clock: day stamps moved to the real-time count (#1649 cut-over at tick ${c.tick})`;

/** Midnight of the clock's epoch date (elapsed 0 reads 2026-10-03T06:00): world minutes count from here (edge boot clock). */
const EPOCH_MS = Date.parse(`${clockAt(0, 0, 1).datetime.slice(0, 10)}T00:00:00Z`);
/** The world minute a clock reads at `tick`, counted from the epoch date's midnight (freshBootClock absoluteWorldMinutes). */
export const worldMinuteAt = (tick: number, c: DayClock) => Math.floor((Date.parse(clockAt(tick, c.origin, c.dayTicks).datetime) - EPOCH_MS) / 60_000);
/** The engine's day index at `tick` (whole days since the clock's origin): the poster and chalk day source. */
export const engineDayAt = (tick: number, c: DayClock) => Math.floor(Math.max(0, tick - c.origin) / c.dayTicks);

/** How many days the engine's day index goes back at the cut-over (positive: the new clock is fewer days in). */
export const stampShift = (c: CutOver) => engineDayAt(c.tick, c.from) - engineDayAt(c.tick, c.to);
/** A day stamp in the old count, moved to the new one with the same age (never below 0). */
export const mapStamp = (day: number, c: CutOver) => Math.max(0, day - stampShift(c));

/** A world-clock due minute in the old count, moved to the new one: the same distance in world days, the same time of day. */
export function mapWorldMinute(due: number, c: CutOver): number {
  const oldDay = Math.floor(worldMinuteAt(c.tick, c.from) / 1440), newDay = Math.floor(worldMinuteAt(c.tick, c.to) / 1440);
  const dueDay = Math.floor(due / 1440), minute = due - dueDay * 1440;
  return Math.max(0, newDay + (dueDay - oldDay)) * 1440 + minute;
}

const markerTable = (sql: DatabaseSync) => sql.exec('CREATE TABLE IF NOT EXISTS edge_clock_cutover_v1(world_id TEXT NOT NULL,cut_tick INTEGER NOT NULL,part TEXT NOT NULL,moved INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(world_id,cut_tick,part)) WITHOUT ROWID');
const marked = (sql: DatabaseSync, worldId: string, c: CutOver, part: string) => !!sql.prepare('SELECT 1 FROM edge_clock_cutover_v1 WHERE world_id=? AND cut_tick=? AND part=?').get(worldId, c.tick, part);
const mark = (sql: DatabaseSync, worldId: string, c: CutOver, part: string, moved: number) => sql.prepare('INSERT OR IGNORE INTO edge_clock_cutover_v1(world_id,cut_tick,part,moved,at) VALUES(?,?,?,?,?)').run(worldId, c.tick, part, moved, Date.now());

/** Pending world-clock reminders of `worldId` made before the cut-over (later ones are already in the new count), moved
 *  to the new count once per cut-over: the rows and a marker row change in
 *  one transaction, so a second call (a retry, a restart) moves nothing. Returns how many moved (0 when already done). */
export function cutOverReminders(sql: DatabaseSync, worldId: string, c: CutOver): number {
  const table = sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edge_personal_reminders_v1'").get();
  markerTable(sql);
  sql.exec('BEGIN IMMEDIATE');   // a failure here leaves no transaction of ours to roll back
  try {
    if (marked(sql, worldId, c, 'reminders')) { sql.exec('COMMIT'); return 0; }
    const rows = !table ? [] : sql.prepare("SELECT soul_id,id,request,due_world_minute FROM edge_personal_reminders_v1 WHERE world_id=? AND state='active' AND kind='world' AND due_world_minute IS NOT NULL AND created_tick<=?").all(worldId, c.tick) as { soul_id: string; id: string; request: string; due_world_minute: number }[];
    const update = table ? sql.prepare('UPDATE edge_personal_reminders_v1 SET due_world_minute=?,request=? WHERE world_id=? AND soul_id=? AND id=?') : null;
    for (const r of rows) {
      const due = mapWorldMinute(r.due_world_minute, c);
      let request = r.request;
      // the request reads as asked, in the new count (its fingerprint stays, so a replayed clientRef still matches)
      try { const q = JSON.parse(r.request) as { at?: { clock?: string; worldDayIndex?: number } }; if (q.at?.clock === 'world') { q.at.worldDayIndex = Math.floor(due / 1440); request = JSON.stringify(q); } } catch { /* an unreadable request keeps its text; its due minute still moves */ }
      update!.run(due, request, worldId, r.soul_id, r.id);
    }
    mark(sql, worldId, c, 'reminders', rows.length);
    sql.exec('COMMIT');
    return rows.length;
  } catch (e) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw e; }
}

/** The god edits that move every age-counting day stamp in the world to the new count: posters on a poster wall (each
 *  record's `day`; records are kept as stored, only their day changes) and fading canvases (`state.day`). Empty when
 *  nothing is stamped or the count does not change. */
export function cutOverStampOps(model: WorldModel, c: CutOver): Op[] {
  if (stampShift(c) === 0) return [];
  const ops: Op[] = [];
  for (const e of model.entities.values()) {
    const state = (e.state ?? {}) as Record<string, unknown>, patch: Record<string, unknown> = {}, def = model.resolvedDef(e.def);
    if (def?.tags?.includes('posters') && posterList(state).some((p) => typeof p.day === 'number')) {
      const raw = JSON.parse(state.textBy as string) as unknown[];
      patch.textBy = JSON.stringify(raw.map((p) => p && typeof p === 'object' && typeof (p as { day?: unknown }).day === 'number' ? { ...p, day: mapStamp((p as { day: number }).day, c) } : p));
    }
    if (typeof state.day === 'number' && typeof canvasFace(def)?.fadeDays === 'number') patch.day = mapStamp(state.day, c);
    if (Object.keys(patch).length) ops.push({ op: 'set', id: e.id, state: patch } as Op);
  }
  return ops;
}

type StampGod = { model: WorldModel; opts: { worldId: string }; db: { db: DatabaseSync }; engineAct(ops: Op[], note: string): { accepted: boolean; failures?: { op?: number }[] } };
/** Move the stamps once per cut-over, as one recorded engine edit (its note names the cut-over). An entity the edit refuses
 *  is left out and the rest move. Returns how many entities moved, or null when an earlier call already did it. */
export function cutOverStamps(god: StampGod, c: CutOver, log: (m: string) => void = () => {}): number | null {
  const sql = god.db.db, note = stampNote(c), world = god.opts.worldId;
  markerTable(sql);
  // done: marked, or the edit is in the journal (a restart between the edit and its mark)
  if (marked(sql, world, c, 'stamps') || sql.prepare('SELECT 1 FROM world_edits_v1 WHERE world_id=? AND note=?').get(world, note)) { mark(sql, world, c, 'stamps', -1); return null; }
  let ops = cutOverStampOps(god.model, c), moved = 0;
  for (let attempt = 0; ops.length && attempt < 3; attempt++) {
    const r = god.engineAct(ops, note);
    if (r.accepted) { moved = ops.length; break; }
    const bad = new Set((r.failures ?? []).map((f) => f.op).filter((i): i is number => Number.isInteger(i) && i! >= 0));
    log(`world clock: cut-over stamps: ${bad.size || 'all'} refused: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
    if (!bad.size) break;
    ops = ops.filter((_, i) => !bad.has(i));
  }
  // marked even when nothing moved or the edit was refused: a later call would read stamps made since in the new count
  mark(sql, world, c, 'stamps', moved);
  return moved;
}
