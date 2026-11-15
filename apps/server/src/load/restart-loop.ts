// #2378 A2: no restart loop. A world that dies in the same step on every boot (a catch-up turn that trips the watchdog's kill
// again, #2366, or a step that throws until the fault storm ends the process) would be restarted for ever, then held by the
// launcher's breaker. At each boot, before the watchdog rewrites live.json, the last process's live.json (or the
// fault-exit.json its fault guard wrote) says how it ended; the deaths are kept in <DATA_DIR>/deaths.json. Two deaths in a
// row in the same step, by its stable identity (a listener's afterTick, world.ts stepIdOf: the same on every boot, whatever
// its place in the listener list), at ticks near each other, quarantine that step for a window of ticks: WorldHost skips
// it there, names it in the log and the glitch counts, and the rest of the world runs. A world with a durable clock
// frontier (Eden) writes the frontier before its listeners, so each boot dies one tick later than the last: "near" is
// within the window, not the same tick.
import {readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export type Death = {at: number; reason: string; tick: number | null; fromTick?: number; id: number | null; name: string | null};
export type StepQuarantine = {id: number; name: string; fromTick: number; untilTick: number; deaths: number};
/** The quarantine window: 1200 ticks (a minute of world time) past the last death, doubling for each death in a row past
 *  the second, at most 72 000 (an hour). */
export const QUARANTINE_TICKS = 1200, QUARANTINE_MAX_TICKS = 72_000;
type Step = {tick: number; id: number};
type LastLive = {phase?: string; at?: number; tick?: {world?: number}; loop?: {lastTurnAgeMs?: number}; step?: Step; stall?: {top?: string};
  killed?: {reason: string; at?: number; step?: Step; top?: string}};
type FaultExit = {at?: number; reason?: string; step?: {id: number; name: string; fromTick: number; tick: number}};
const hex = (id: number) => id.toString(16).padStart(8, '0');

/** Read how the last process ended and update deaths.json. A clean stop clears the record. Never throws. */
export function noteLastExit(dataDir: string, now = Date.now()): {deaths: Death[]; quarantine: StepQuarantine | null} {
  const file = join(dataDir, 'deaths.json');
  let deaths: Death[] = [];
  try { deaths = JSON.parse(readFileSync(file, 'utf8')); if (!Array.isArray(deaths)) deaths = []; } catch { deaths = []; }
  let last: LastLive | null = null, fx: FaultExit | null = null;
  try { last = JSON.parse(readFileSync(join(dataDir, 'live.json'), 'utf8')); } catch { last = null; }
  // #2366: the fault guard's own exit (a storm, a clock stopped by a fault) names its step; read once, then gone
  try { fx = JSON.parse(readFileSync(join(dataDir, 'fault-exit.json'), 'utf8')); } catch { fx = null; }
  try { unlinkSync(join(dataDir, 'fault-exit.json')); } catch { /* none */ }
  let death: Death | null = null;
  if (fx) {
    const s = fx.step;
    death = {at: fx.at ?? now, reason: String(fx.reason ?? 'fault-exit').split(':')[0], tick: s?.tick ?? last?.tick?.world ?? null, ...(s ? {fromTick: s.fromTick} : {}), id: s ? s.id : null, name: s?.name ?? null};
  } else if (last) {
    if (last.phase === 'stopping') deaths = [];
    else {
      // the watchdog's kill names the step; a process ended otherwise (the launcher's boot-stall kill: a catch-up step runs
      // before the world serves) is named by its last live.json, when that shows it stuck in a step for a second or more
      const k = last.killed, step = k?.step ?? ((last.loop?.lastTurnAgeMs ?? 0) >= 1000 ? last.step : undefined), top = k?.top ?? last.stall?.top;
      death = {at: k?.at ?? last.at ?? now, reason: k?.reason ?? 'exit', tick: step?.tick ?? last.tick?.world ?? null, id: step ? step.id : null,
        name: step ? `step ${hex(step.id)}${top ? ` (${top})` : ''}` : null};
    }
  }
  if (death) deaths = [...deaths, death].slice(-5);
  if (fx || last) { try { writeFileSync(file + '.tmp', JSON.stringify(deaths) + '\n'); renameSync(file + '.tmp', file); } catch { /* a full disk: no record, no quarantine */ } }
  return {deaths, quarantine: stepQuarantine(deaths)};
}

/** The step to skip: the last `n` deaths or more named the same step, each within `window` ticks of the next. It is skipped
 *  from the first of their ticks to `window` ticks past the last (doubled for each death past `n`). */
export function stepQuarantine(deaths: Death[], n = 2, window = QUARANTINE_TICKS): StepQuarantine | null {
  const d = deaths.at(-1);
  if (!d || d.id === null || d.tick === null) return null;
  let same = 0, from = d.fromTick ?? d.tick, until = d.tick, near = d.tick;
  for (let i = deaths.length - 1; i >= 0; i--) {
    const e = deaths[i];
    if (e.id !== d.id || e.tick === null || Math.abs(near - e.tick) > window) break;
    same++; from = Math.min(from, e.fromTick ?? e.tick); until = Math.max(until, e.tick); near = e.tick;
  }
  if (same < n) return null;
  return {id: d.id, name: d.name ?? `step ${hex(d.id)}`, fromTick: from, untilTick: until + Math.min(QUARANTINE_MAX_TICKS, window * 2 ** (same - n)), deaths: same};
}
