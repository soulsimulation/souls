// Starts the watchdog thread (watchdog-worker.ts) first thing in main.ts. Unref'd: it never keeps the process alive.
import {renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {liveOf, sharedLoad} from './shared.ts';
import {apiOf, sharedApi} from './api-times.ts';

/** live.json from this thread, now (the stop path: the process may exit before the watchdog's next write). */
export function writeLiveNow(dataDir: string, a: Float64Array = sharedLoad, api: Float64Array = sharedApi) {
  const file = join(dataDir, 'live.json');
  try { const now = Date.now(); writeFileSync(file + '.main.tmp', JSON.stringify({...liveOf(a, process.pid, now), api: apiOf(api, now)}) + '\n'); renameSync(file + '.main.tmp', file); } catch { /* best effort */ }
}

/** #457: name the stalled frame (stall-stack.ts) unless SIM_STALL_STACK=0; after SIM_STALL_STACK_MS (default 2000) stuck. */
export function stallConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.SIM_STALL_STACK === '0') return undefined;
  return {dataDir, root: fileURLToPath(new URL('../../../../', import.meta.url)), stallMs: Number(env.SIM_STALL_STACK_MS) > 0 ? Number(env.SIM_STALL_STACK_MS) : 2000};
}
/** #2366 A2/A3: when the watchdog thread ends a stuck world. `hangMs`: the main thread has not turned for this long while
 *  serving (SIM_HANG_KILL_MS, default 10 s; 0 = never). `heapPct`/`heapMs`: the heap has been at least this share of its
 *  old-space cap for this long (SIM_HEAP_KILL_PCT, default 95; SIM_HEAP_KILL_MS, default 5 s; pct 0 = never). The world is
 *  killed (SIGKILL) and the launcher restarts it; acts are logged before they are answered, so the restart replays them
 *  and catches the clock up (#2235). Undefined: the rule is off. */
export type KillRule = {hangMs: number; heapPct: number; heapMs: number};
export function killRule(env: NodeJS.ProcessEnv = process.env): KillRule | undefined {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const r = {hangMs: n(env.SIM_HANG_KILL_MS, 10_000), heapPct: n(env.SIM_HEAP_KILL_PCT, 95), heapMs: n(env.SIM_HEAP_KILL_MS, 5_000)};
  return r.hangMs > 0 || r.heapPct > 0 ? r : undefined;
}
const YOUNG_MB = 96;
export type KillVerdict = {reason: 'hang'; stuckMs: number} | {reason: 'heap'; usedMb: number; limitMb: number; forMs: number};
/** The watchdog's judge (pure; one per world). Fed every look; a verdict once the rule holds on two looks in a row. A gap
 *  between looks over `gapMs` (the whole process was stopped: SIGSTOP, a host freeze) starts again, so a world thawed
 *  after a freeze is never killed for the time it was frozen. Only a serving world is judged. */
export function killJudge(rule: KillRule, gapMs = 2_000) {
  let lastLook = -Infinity, hangSince: number | null = null, heapSince: number | null = null;
  return (live: {phase: string; loop: {lastTurnAgeMs: number}; heap: {usedMb: number; limitMb: number}}, now: number): KillVerdict | null => {
    const gap = now - lastLook; lastLook = now;
    if (gap > gapMs || live.phase !== 'serving') { hangSince = heapSince = null; return null; }
    const age = live.loop.lastTurnAgeMs;
    if (rule.hangMs > 0 && age > rule.hangMs) { if (hangSince === null) hangSince = now; else return {reason: 'hang', stuckMs: age}; }
    else hangSince = null;
    const {usedMb, limitMb} = live.heap;
    // V8's heap limit is the old-space cap (--max-old-space-size) plus its young generation, 96 MB at these sizes (384 MB
    // -> 480, 1536 -> 1632): the share is of the old-space cap, or a small cap could never reach it
    if (rule.heapPct > 0 && limitMb > YOUNG_MB && usedMb >= (limitMb - YOUNG_MB) * rule.heapPct / 100) {
      if (heapSince === null) heapSince = now;
      else if (now - heapSince >= rule.heapMs) return {reason: 'heap', usedMb, limitMb, forMs: now - heapSince};
    } else heapSince = null;
    return null;
  };
}
export function startWatchdog(opts: {dataDir: string; port?: number; everyMs?: number; shared?: Float64Array; api?: Float64Array; onListening?: (port: number) => void; stall?: ReturnType<typeof stallConfig>; kill?: KillRule}) {
  const worker = new Worker(new URL('./watchdog-worker.ts', import.meta.url), {
    workerData: {buffer: (opts.shared ?? sharedLoad).buffer, api: (opts.api ?? sharedApi).buffer, file: join(opts.dataDir, 'live.json'), pid: process.pid, port: opts.port, everyMs: opts.everyMs, stall: opts.stall, kill: opts.kill},
    execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 32},
  });
  worker.on('message', (m: {error?: string; listening?: number; info?: string}) => { if (m.error) console.error(`[load] watchdog: ${m.error}`); else if (m.info) console.log(`[load] watchdog: ${m.info}`); else if (m.listening) { console.log(`[load] watchdog /healthz on 127.0.0.1:${m.listening}`); opts.onListening?.(m.listening); } });
  worker.on('error', e => console.error('[load] watchdog thread failed', e));
  worker.unref();
  return worker;
}

/** #2366 A1: an error a world's code throws outside a request's own handling (a timer, a rejected promise, a request
 *  handler, a tick past the engine's fault handling) is caught here, logged under a named diagnostic and the world goes
 *  on. The first of each name in a minute is logged with its stack, the rest by their first line. `stormN` faults within
 *  `stormMs` is no longer one bad call but a broken world: `onStorm` runs once (main.ts: a planned restart, exit 75). */
export function faultGuard(o: {log?: (line: string) => void; stormN?: number; stormMs?: number; onStorm?: (n: number) => void; now?: () => number} = {}) {
  const log = o.log ?? ((l: string) => console.error(l)), stormN = o.stormN ?? 50, stormMs = o.stormMs ?? 60_000, now = o.now ?? Date.now;
  const times: number[] = [], stackAt = new Map<string, number>(), counts: Record<string, number> = {};
  let stormed = false;
  const note = (name: string, error: unknown) => {
    const t = now(); times.push(t); while (times.length && t - times[0] > stormMs) times.shift();
    counts[name] = (counts[name] ?? 0) + 1;
    const full = t - (stackAt.get(name) ?? -Infinity) > 60_000; if (full) stackAt.set(name, t);
    const text = error instanceof Error ? (full ? error.stack ?? String(error) : `${error.name}: ${error.message}`) : String(error);
    try { log(`[world] fault ${name} (${times.length} in ${Math.round(stormMs / 1000)} s): ${full ? text : text.split('\n')[0]}`); } catch { /* a log never throws twice */ }
    if (!stormed && times.length >= stormN) { stormed = true; o.onStorm?.(times.length); }
  };
  return {note, counts};
}
/** Route the process's uncaught errors to the guard (installed once the world serves: a boot that throws still exits). */
export function installFaultGuard(g: {note: (name: string, error: unknown) => void}, proc: NodeJS.Process = process) {
  proc.on('uncaughtException', e => g.note('world.fault.uncaught', e));
  proc.on('unhandledRejection', e => g.note('world.fault.rejection', e));
}
