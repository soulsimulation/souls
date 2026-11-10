// #457: name the frame the main thread is stuck in, from the watchdog thread, while it is stuck. A SIGUSR2 report is
// written by a JavaScript handler that runs only once the main thread is free again, so it always showed the handler
// itself. The one inspector route that works during a stall: a session to the main thread whose debugger was enabled
// while the world was healthy (no breakpoints, breakpoints inactive), then `Debugger.pause` once the main thread's last
// turn is older than `stallMs`. The pause interrupts the running JavaScript; the frames are copied and it resumes at once.
// `Debugger.enable` or `Profiler.start` sent during a stall never completes (it needs the main thread).
// Reports hold frames only (function, file relative to the release root, line, column): no scope values, no arguments.
import {Session} from 'node:inspector';
import {readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {liveOf} from './shared.ts';

export type StallFrame = {fn: string; file: string; line: number; col: number};
export type StallReport = {v: 1; at: number; stuckMs: number; pauseMs?: number; frames: StallFrame[]; error?: string};
export type StallOpts = {a: Float64Array; dataDir: string; root: string; stallMs?: number; gapMs?: number; everyMs?: number; keep?: number;
  onReport?: (r: StallReport) => void; onEnabled?: (ms: number, scripts: number) => void; now?: () => number};

/** A frame's file as a report may show it: relative to the release root, a node: module as is, anything else by its name only. */
export function reportFile(url: string, root: string): string {
  const u = String(url ?? '').replace(/^file:\/\//, '');
  if (!u) return '';
  if (root && u.startsWith(root.endsWith('/') ? root : root + '/')) return u.slice(root.replace(/\/$/, '').length + 1);
  if (/^node:/.test(u)) return u;
  return u.split('/').at(-1) ?? '';
}
/** One line for a log: `fn file:line`. */
export const frameText = (f: StallFrame | undefined) => f ? `${f.fn || '(anonymous)'}${f.file ? ` ${f.file}:${f.line}` : ''}` : 'unknown';

/** Started inside the watchdog thread. Returns stop() and the last report. */
export function startStallStack(o: StallOpts) {
  const stallMs = o.stallMs ?? 2000, gapMs = o.gapMs ?? 60_000, now = o.now ?? Date.now, keep = o.keep ?? 10;
  const s = new Session(); s.connectToMainThread();
  let ready = false, armed = true, asked = 0, stuck = 0, lastAt = -Infinity, last: StallReport | null = null, timer: NodeJS.Timeout | null = null;
  const report = (r: StallReport) => {
    last = r; o.onReport?.(r);
    const f = join(o.dataDir, `stall-${r.at}.json`);
    try { writeFileSync(f + '.tmp', JSON.stringify(r, null, 1) + '\n'); renameSync(f + '.tmp', f); } catch { /* best effort */ }
    try { const old = readdirSync(o.dataDir).filter(x => /^stall-\d+\.json$/.test(x)).sort(); for (const x of old.slice(0, Math.max(0, old.length - keep))) unlinkSync(join(o.dataDir, x)); } catch { /* best effort */ }
  };
  // a paused frame names its script by id (CallFrame.url is empty): the urls as the scripts are announced, already shortened
  const scripts = new Map<string, string>();
  s.on('Debugger.scriptParsed', (m: {params: {scriptId: string; url: string}}) => { if (m.params.url) scripts.set(m.params.scriptId, reportFile(m.params.url, o.root)); });
  s.on('Debugger.paused', (m: {params: {callFrames: {functionName: string; url?: string; location: {scriptId: string; lineNumber: number; columnNumber?: number}}[]}}) => {
    // a pause this thread did not ask for (a `debugger;` statement, another client): resumed, never reported
    if (!asked) { s.post('Debugger.resume'); return; }
    const t = now(), frames = m.params.callFrames.slice(0, 30).map(c => ({fn: c.functionName || '(anonymous)', file: scripts.get(c.location.scriptId) ?? reportFile(c.url ?? '', o.root), line: c.location.lineNumber + 1, col: (c.location.columnNumber ?? 0) + 1}));
    s.post('Debugger.resume');
    const r: StallReport = {v: 1, at: t, stuckMs: stuck, pauseMs: t - asked, frames};
    asked = 0; report(r);
  });
  const t0 = now();
  s.post('Debugger.enable', (e) => {
    if (e) return;
    o.onEnabled?.(now() - t0, scripts.size);
    // inactive breakpoints: a `debugger;` statement in the code never stops the world; Debugger.pause still does
    s.post('Debugger.setBreakpointsActive', {active: false}); s.post('Debugger.setPauseOnExceptions', {state: 'none'});
    ready = true;
  });
  const look = () => {
    const t = now(), live = liveOf(o.a, 0, t), age = live.loop.lastTurnAgeMs;
    if (asked && t - asked > 5000) { const r: StallReport = {v: 1, at: t, stuckMs: stuck, frames: [], error: 'the main thread did not pause within 5 s'}; asked = 0; report(r); }
    if (live.phase !== 'serving' || age < stallMs) { armed = true; return; }
    if (!ready || !armed || asked || t - lastAt < gapMs) return;
    armed = false; lastAt = t; asked = t; stuck = age;
    s.post('Debugger.pause');
  };
  timer = setInterval(look, o.everyMs ?? 500); timer.unref?.();
  return {stop: () => { if (timer) clearInterval(timer); try { s.disconnect(); } catch { /* gone */ } }, last: () => last};
}
