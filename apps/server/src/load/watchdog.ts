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
 *  serving (SIM_HANG_KILL_MS, default 10 s; 0 = never). `heapPct`/`heapMs`/`gcPct`: the heap has been at least this share of
 *  its old-space cap for this long while garbage collection took at least `gcPct` of the main thread's last 10 s, i.e. it
 *  thrashes (SIM_HEAP_KILL_PCT, default 95; SIM_HEAP_KILL_MS, default 5 s; SIM_HEAP_KILL_GC_PCT, default 30; pct 0 = never).
 *  A steady live set near the cap that collects calmly is left alone: a restart would rebuild the same set and loop. The
 *  world is killed (SIGKILL) and the launcher restarts it; acts are logged before they are answered, so the restart replays
 *  them and catches the clock up (#2235). Undefined: the rule is off. */
export type KillRule = {hangMs: number; heapPct: number; heapMs: number; gcPct?: number};
export function killRule(env: NodeJS.ProcessEnv = process.env): KillRule | undefined {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const r = {hangMs: n(env.SIM_HANG_KILL_MS, 10_000), heapPct: n(env.SIM_HEAP_KILL_PCT, 95), heapMs: n(env.SIM_HEAP_KILL_MS, 5_000), gcPct: n(env.SIM_HEAP_KILL_GC_PCT, 30)};
  return r.hangMs > 0 || r.heapPct > 0 ? r : undefined;
}
const YOUNG_MB = 96;
export type KillVerdict = {reason: 'hang'; stuckMs: number} | {reason: 'heap'; usedMb: number; limitMb: number; gcPct10s: number; forMs: number};
/** The watchdog's judge (pure; one per world). Fed every look; a verdict once the rule holds on two looks in a row. A gap
 *  between looks over `gapMs` (the whole process was stopped: SIGSTOP, a host freeze) starts again, so a world thawed
 *  after a freeze is never killed for the time it was frozen. Only a serving world is judged. */
export function killJudge(rule: KillRule, gapMs = 2_000) {
  let lastLook = -Infinity, hangSince: number | null = null, heapSince: number | null = null;
  return (live: {phase: string; loop: {lastTurnAgeMs: number}; heap: {usedMb: number; limitMb: number; gcPct10s?: number}}, now: number): KillVerdict | null => {
    const gap = now - lastLook; lastLook = now;
    if (gap > gapMs || live.phase !== 'serving') { hangSince = heapSince = null; return null; }
    const age = live.loop.lastTurnAgeMs;
    if (rule.hangMs > 0 && age > rule.hangMs) { if (hangSince === null) hangSince = now; else return {reason: 'hang', stuckMs: age}; }
    else hangSince = null;
    const {usedMb, limitMb, gcPct10s = 0} = live.heap;
    // V8's heap limit is the old-space cap (--max-old-space-size) plus its young generation, 96 MB at these sizes (384 MB
    // -> 480, 1536 -> 1632): the share is of the old-space cap, or a small cap could never reach it
    if (rule.heapPct > 0 && limitMb > YOUNG_MB && usedMb >= (limitMb - YOUNG_MB) * rule.heapPct / 100 && gcPct10s >= (rule.gcPct ?? 0)) {
      if (heapSince === null) heapSince = now;
      else if (now - heapSince >= rule.heapMs) return {reason: 'heap', usedMb, limitMb, gcPct10s, forMs: now - heapSince};
    } else heapSince = null;
    return null;
  };
}
function watchdogThread(workerData: object, onListening?: (port: number) => void) {
  const worker = new Worker(new URL('./watchdog-worker.ts', import.meta.url), {workerData, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 32}});
  worker.on('message', (m: {error?: string; listening?: number; info?: string}) => { if (m.error) console.error(`[load] watchdog: ${m.error}`); else if (m.info) console.log(`[load] watchdog: ${m.info}`); else if (m.listening) { console.log(`[load] watchdog /healthz on 127.0.0.1:${m.listening}`); onListening?.(m.listening); } });
  worker.on('error', e => console.error('[load] watchdog thread failed', e));
  worker.unref();
  return worker;
}
/** #2444: the shard program's one watchdog thread (shareWatchdog), or null in a program of one world. */
let programWatchdog: Worker | null = null;
/** #2444 shards: from now on every world this program starts is watched by one thread (watchdog-worker.ts `shared`), not
 *  one each. Called once by the shard program (tools/world-launcher/shard.mjs) before its first world. `remove(dataDir)`
 *  ends the watch of a world that stopped, so a later world of the same data in the same program is watched afresh. */
export function shareWatchdog() {
  const w = programWatchdog ??= watchdogThread({shared: true});
  return {worker: w, remove: (dataDir: string) => w.postMessage({remove: join(dataDir, 'live.json')})};
}
export function startWatchdog(opts: {dataDir: string; port?: number; everyMs?: number; shared?: Float64Array; api?: Float64Array; onListening?: (port: number) => void; stall?: ReturnType<typeof stallConfig>; kill?: KillRule}) {
  const data = {buffer: (opts.shared ?? sharedLoad).buffer, api: (opts.api ?? sharedApi).buffer, file: join(opts.dataDir, 'live.json'), pid: process.pid, port: opts.port, everyMs: opts.everyMs, stall: opts.stall, kill: opts.kill};
  if (programWatchdog) { programWatchdog.postMessage({add: data}); return programWatchdog; }
  return watchdogThread(data, opts.onListening);
}

/** A step (a listener's afterTick, world.ts stepIdOf) that faulted: its stable id and name, and the ticks it faulted at. */
export type FaultStep = {id: number; name: string; fromTick: number; tick: number; faults: number};
/** #2366 A1: an error a world's code throws outside a request's own handling (a timer, a rejected promise, a request
 *  handler, a tick past the engine's fault handling, one listener's step) is caught here, logged under a named diagnostic
 *  and the world goes on. The first of each name in a minute is logged with its stack, the rest by their first line.
 *  `stormN` faults within `stormMs` is no longer one bad call but a broken world: `onStorm` runs once with the step that
 *  threw most of them, if one did (main.ts: a crash exit the launcher's breaker counts, the step recorded for quarantine). */
export function faultGuard(o: {log?: (line: string) => void; stormN?: number; stormMs?: number; onStorm?: (n: number, step: FaultStep | null) => void; now?: () => number} = {}) {
  const log = o.log ?? ((l: string) => console.error(l)), stormN = o.stormN ?? 50, stormMs = o.stormMs ?? 60_000, now = o.now ?? Date.now;
  const times: {t: number; step?: {id: number; name: string; tick: number}}[] = [], stackAt = new Map<string, number>(), counts: Record<string, number> = {};
  let stormed = false;
  const note = (name: string, error: unknown, step?: {id: number; name: string; tick: number}) => {
    const t = now(); times.push(step ? {t, step} : {t}); while (times.length && t - times[0].t > stormMs) times.shift();
    counts[name] = (counts[name] ?? 0) + 1;
    const full = t - (stackAt.get(name) ?? -Infinity) > 60_000; if (full) stackAt.set(name, t);
    const text = error instanceof Error ? (full ? error.stack ?? String(error) : `${error.name}: ${error.message}`) : String(error);
    try { log(`[world] fault ${name}${step ? ` in ${step.name} at tick ${step.tick}` : ''} (${times.length} in ${Math.round(stormMs / 1000)} s): ${full ? text : text.split('\n')[0]}`); } catch { /* a log never throws twice */ }
    if (!stormed && times.length >= stormN) { stormed = true; o.onStorm?.(times.length, stormStep(times)); }
  };
  return {note, counts};
}
/** The step that threw most of a storm's faults (at least half of them), with the first and last tick it threw at. */
function stormStep(times: {step?: {id: number; name: string; tick: number}}[]): FaultStep | null {
  const by = new Map<number, FaultStep>();
  for (const {step} of times) { if (!step) continue; const s = by.get(step.id);
    if (s) { s.faults++; s.fromTick = Math.min(s.fromTick, step.tick); s.tick = Math.max(s.tick, step.tick); }
    else by.set(step.id, {id: step.id, name: step.name, fromTick: step.tick, tick: step.tick, faults: 1}); }
  let best: FaultStep | null = null; for (const s of by.values()) if (!best || s.faults > best.faults) best = s;
  return best && best.faults * 2 >= times.length ? best : null;
}
/** #2366: after a tick fault, a world whose clock has stopped for good: its timer is gone without a stop that was asked for
 *  (`closing`), or its clock is unavailable with no halt recorded by name (a named halt is the launcher's to restart,
 *  #2133). Nothing else would notice (an unrunning clock owes no ticks, so no stall shows): main.ts exits as a crash. */
export function stoppedByFault(h: {running: boolean; clockAvailable: boolean; haltNamed: boolean}, closing: boolean): string | null {
  if (closing) return null;
  if (!h.clockAvailable) return h.haltNamed ? null : 'world.fault.clock-unavailable';
  return h.running ? null : 'world.fault.clock-stopped';
}
/** #2366: the exit code of a world that ends itself as a crash (a fault storm, a clock stopped by a fault): not 75 (a planned
 *  restart), so the launcher's breaker counts it and its backoff applies. */
export const FAULT_EXIT = 70;
/** Record why this process ends itself (<DATA_DIR>/fault-exit.json, for the next boot), log it and exit FAULT_EXIT. No
 *  snapshot: the restart replays the durable log, exactly. */
export function faultExit(dataDir: string, reason: string, step: FaultStep | null, o: {log?: (line: string) => void; exit?: (code: number) => void; now?: number} = {}) {
  const log = o.log ?? ((l: string) => console.error(l));
  try { const f = join(dataDir, 'fault-exit.json'); writeFileSync(f + '.tmp', JSON.stringify({at: o.now ?? Date.now(), reason, ...(step ? {step} : {})}) + '\n'); renameSync(f + '.tmp', f); } catch { /* a full disk: no record */ }
  try { log(`[world] ${reason}${step ? ` (step ${step.name}, ${step.faults} faults, ticks ${step.fromTick}..${step.tick})` : ''}: exiting ${FAULT_EXIT}, a crash the launcher restarts and counts`); } catch { /* exit regardless */ }
  (o.exit ?? process.exit)(FAULT_EXIT);
}
/** Route the process's uncaught errors to the guard (installed once the world serves: a boot that throws still exits). */
export function installFaultGuard(g: {note: (name: string, error: unknown) => void}, proc: NodeJS.Process = process) {
  const uncaught = (e: unknown) => g.note('world.fault.uncaught', e), rejection = (e: unknown) => g.note('world.fault.rejection', e);
  proc.on('uncaughtException', uncaught); proc.on('unhandledRejection', rejection);
  /** #2444: a world that stops in a shard takes its handlers with it. */
  return () => { proc.off('uncaughtException', uncaught); proc.off('unhandledRejection', rejection); };
}
