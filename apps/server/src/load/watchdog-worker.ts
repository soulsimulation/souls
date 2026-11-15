// LOAD-CONTRACT §4: the watchdog thread. Reads the shared numbers (shared.ts) and every 2 s writes <DATA_DIR>/live.json by
// atomic rename; optionally answers GET /healthz on its own loopback port (SIM_HEALTH_PORT). It never touches world
// state, so it keeps reporting while the main thread is stuck in a long request, a GC storm or a replay: the stuck
// thread shows as a growing `loop.lastTurnAgeMs`.
// #2444 shards: with `shared`, one thread watches every world of the program (each added by message {add}, ended by
// {remove: file}); without it, the one world in workerData, as before. The thread is the program's, so a stall stack is
// taken only for a program of one world: in a shard, a stopped world's numbers stop turning and would read as a stall.
import {renameSync, writeFileSync, writeSync} from 'node:fs';
import {createServer} from 'node:http';
import {parentPort, workerData} from 'node:worker_threads';
import {liveOf, S} from './shared.ts';
import {apiOf} from './api-times.ts';
import {frameText, startStallStack, type StallReport} from './stall-stack.ts';
import {killJudge, type KillRule, type KillVerdict} from './watchdog.ts';

type Watch = {buffer: SharedArrayBuffer; api?: SharedArrayBuffer; file: string; pid: number; port?: number; everyMs?: number;
  stall?: {dataDir: string; root: string; stallMs: number; gapMs?: number}; kill?: KillRule};
type Watched = {a: Float64Array; pid: number; judge: ReturnType<typeof killJudge> | null; kill(v: KillVerdict, now: number): void; stop(): void};
const watched = new Map<string, Watched>();
// #457: the frame the main thread was stuck in, captured from here while it was stuck (stall-stack.ts); in live.json for
// 10 min, so the launcher's wedge line names it
let lastStall: StallReport | null = null;

function watch({buffer, api, file, pid, port, everyMs, stall, kill}: Watch): Watched {
  const a = new Float64Array(buffer), apiA = api ? new Float64Array(api) : null;
  let failed = false, writtenAt = 0;
  // #2366: why this thread ended the world (live.json `killed`, read by the launcher's onExit)
  let killed: (KillVerdict & {at: number; step?: {tick: number; id: number}; top?: string}) | null = null;
  if (stall) { try { startStallStack({a, dataDir: stall.dataDir, root: stall.root, stallMs: stall.stallMs, gapMs: stall.gapMs, onReport: r => { lastStall = r; write(); }, onEnabled: (ms, n) => parentPort?.postMessage({info: `stall stacks on (#457): debugger enabled in ${Math.round(ms)} ms, ${n} scripts announced`})}); } catch (e) { parentPort?.postMessage({error: `stall stacks off: ${(e as Error).message}`}); } }
  function write() {
    const now = Date.now(), live = apiA ? {...liveOf(a, pid, now), api: apiOf(apiA, now)} : liveOf(a, pid, now);
    const withStall = lastStall && now - lastStall.at < 600_000 ? {...live, stall: {at: lastStall.at, stuckMs: lastStall.stuckMs, top: lastStall.error ?? frameText(lastStall.frames[0]), frames: lastStall.frames.slice(0, 5).map(frameText)}} : live;
    const body = JSON.stringify(killed ? {...withStall, killed} : withStall);
    try { writeFileSync(file + '.tmp', body + '\n'); renameSync(file + '.tmp', file); failed = false; writtenAt = now; }
    catch (e) { if (!failed) parentPort?.postMessage({error: `live.json not written: ${(e as Error).message}`}); failed = true; }
  }
  write();
  // #2303: while the world is silent (still, nobody watching) live.json is written every 10 s, a third of the launcher's
  // 30 s staleness limit (guard.mjs liveStaleMs). A main thread whose last turn is over 5 s old, and a paused or halted
  // clock (stallMs 0, halted), are reported at the full pace.
  const SILENT_EVERY_MS = 10_000;
  const writer = setInterval(() => { const now = Date.now(); if (a[S.still] === 1 && a[S.stallMs] > 0 && !a[S.halted] && now - writtenAt < SILENT_EVERY_MS && now - a[S.lastTurnAt] < 5_000) return; write(); }, everyMs ?? 2000);
  let server: ReturnType<typeof createServer> | null = null;
  if (port !== undefined) {
    const s = server = createServer((req, res) => {
      if (req.method !== 'GET' || !/^\/(?:[^?]*\/)?healthz(?:\?|$)/.test(req.url ?? '')) { res.writeHead(404).end(); return; }
      const live = liveOf(a, pid, Date.now()), up = live.phase === 'serving' && live.loop.lastTurnAgeMs < 30_000;
      res.writeHead(up ? 200 : 503, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify({ok: up, ...live}));
    });
    s.listen(port, '127.0.0.1', () => parentPort?.postMessage({listening: (s.address() as {port: number}).port}))
      .on('error', e => parentPort?.postMessage({error: `health port ${port}: ${e.message}`}));
  }
  return {a, pid, judge: kill ? killJudge(kill) : null,
    kill(v, now) {
      // #2378 A2: the step the tick was in (a listener's afterTick, by its stable id) and the frame, so a restart loop is seen and quarantined
      const step = a[S.step] > 0 ? {tick: a[S.stepTick], id: a[S.step] - 1} : undefined, top = lastStall && lastStall.at >= now - (v.reason === 'hang' ? v.stuckMs : 0) ? lastStall.error ?? frameText(lastStall.frames[0]) : undefined;
      killed = {...v, at: now, ...(step ? {step} : {}), ...(top ? {top} : {})}; write();
      const what = v.reason === 'hang' ? `main thread stuck ${Math.round(v.stuckMs / 1000)} s${lastStall && lastStall.at >= now - v.stuckMs ? ` in ${lastStall.error ?? frameText(lastStall.frames[0])}` : ''}` : `heap ${v.usedMb} of ${v.limitMb} MB for ${Math.round(v.forMs / 1000)} s, gc ${Math.round(v.gcPct10s)}% of the last 10 s`;
      try { writeSync(2, `[load] watchdog: world.killed.${v.reason}: ${what}; ending the process for the launcher to restart it\n`); } catch { /* stderr gone */ }
    },
    stop() { clearInterval(writer); server?.close(); },
  };
}
// #2366 A2/A3: a world stuck past the hard limit (its main thread unturned for kill.hangMs, or its heap at kill.heapPct of the
// limit for kill.heapMs) is ended from here, where it is still seen: live.json says why, a line goes to stderr directly
// (a worker's console goes through the stuck main thread), then SIGKILL. The launcher restarts it (children.mjs onExit).
// #2444: in a shard the worlds share the thread, so a hang shows in all of them: the one named is the world whose tick was
// running (its step slot is set), else none: the one SIGKILL ends the program, and with no world named the launcher
// reloads every world as the crash it was, each in a program of its own (shard.mjs).
const look = setInterval(() => {
  const now = Date.now(), verdicts: [Watched, KillVerdict][] = [];
  for (const w of watched.values()) { const v = w.judge?.(liveOf(w.a, w.pid, now), now); if (v) verdicts.push([w, v]); }
  if (!verdicts.length) return;
  clearInterval(look);
  // a program of one world: that world. In a shard: the world whose tick was running, else none (a sibling's boot or a long
  // request may hold the thread; naming a serving neighbour would count an innocent world and let the culprit go uncounted)
  const named = watched.size === 1 ? verdicts[0] : verdicts.find(([x]) => x.a[S.step] > 0);
  if (named) named[0].kill(named[1], now);
  else { const [, v] = verdicts[0]; try { writeSync(2, `[load] watchdog: world.killed.${v.reason} in a shard of ${watched.size} with no world's tick running: ending the program, no world named\n`); } catch { /* stderr gone */ } }
  process.kill(verdicts[0][0].pid, 'SIGKILL');
}, 500);
if ((workerData as {shared?: boolean}).shared) parentPort?.on('message', (m: {add?: Watch; remove?: string}) => {
  if (m.add) { watched.get(m.add.file)?.stop(); watched.set(m.add.file, watch({...m.add, stall: undefined})); }
  else if (m.remove) { watched.get(m.remove)?.stop(); watched.delete(m.remove); }
});
else { const w = workerData as Watch; watched.set(w.file, watch(w)); }
