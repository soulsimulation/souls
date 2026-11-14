// #2378 A2: no restart loop. A world that dies at the same step of the same tick on every boot (a catch-up turn that trips the
// watchdog's kill again, #2366) would be restarted for ever, then held by the launcher's breaker. At each boot, before the
// watchdog rewrites live.json, the last process's live.json says how it ended; the deaths are kept in <DATA_DIR>/deaths.json.
// Two deaths in a row at the same tick in the same step (a listener's afterTick, named by the watchdog's kill) quarantine that
// step at that tick: WorldHost skips it there, names it in the log and the glitch counts, and the rest of the world runs.
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export type Death = {at: number; reason: string; tick: number | null; index: number | null; name: string | null};
export type StepQuarantine = {tick: number; index: number; name: string; deaths: number};
type Step = {tick: number; index: number};
type LastLive = {phase?: string; at?: number; tick?: {world?: number}; loop?: {lastTurnAgeMs?: number}; step?: Step; stall?: {top?: string};
  killed?: {reason: string; at?: number; step?: Step; top?: string}};

/** Read how the last process ended and update deaths.json. A clean stop clears the record. Never throws. */
export function noteLastExit(dataDir: string, now = Date.now()): {deaths: Death[]; quarantine: StepQuarantine | null} {
  const file = join(dataDir, 'deaths.json');
  let deaths: Death[] = [];
  try { deaths = JSON.parse(readFileSync(file, 'utf8')); if (!Array.isArray(deaths)) deaths = []; } catch { deaths = []; }
  let last: LastLive | null = null;
  try { last = JSON.parse(readFileSync(join(dataDir, 'live.json'), 'utf8')); } catch { last = null; }
  if (last) {
    if (last.phase === 'stopping') deaths = [];
    else {
      // the watchdog's kill names the step; a process ended otherwise (the launcher's boot-stall kill: a catch-up step runs
      // before the world serves) is named by its last live.json, when that shows it stuck in a step for a second or more
      const k = last.killed, step = k?.step ?? ((last.loop?.lastTurnAgeMs ?? 0) >= 1000 ? last.step : undefined), top = k?.top ?? last.stall?.top;
      deaths = [...deaths, {at: k?.at ?? last.at ?? now, reason: k?.reason ?? 'exit', tick: step?.tick ?? last.tick?.world ?? null, index: step ? step.index : null,
        name: step ? `afterTick[${step.index}]${top ? ` (${top})` : ''}` : null}].slice(-5);
    }
    try { writeFileSync(file + '.tmp', JSON.stringify(deaths) + '\n'); renameSync(file + '.tmp', file); } catch { /* a full disk: no record, no quarantine */ }
  }
  return {deaths, quarantine: stepQuarantine(deaths)};
}

/** The step to skip: the last `n` deaths named the same step at the same tick. */
export function stepQuarantine(deaths: Death[], n = 2): StepQuarantine | null {
  const d = deaths.at(-1);
  if (!d || d.index === null || d.tick === null) return null;
  let same = 0;
  for (let i = deaths.length - 1; i >= 0 && deaths[i].index === d.index && deaths[i].tick === d.tick; i--) same++;
  return same >= n ? {tick: d.tick, index: d.index, name: d.name ?? `afterTick[${d.index}]`, deaths: same} : null;
}
