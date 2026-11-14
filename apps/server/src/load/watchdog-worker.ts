// LOAD-CONTRACT §4: the watchdog thread. Reads the shared numbers (shared.ts) and every 2 s writes <DATA_DIR>/live.json by
// atomic rename; optionally answers GET /healthz on its own loopback port (SIM_HEALTH_PORT). It never touches world
// state, so it keeps reporting while the main thread is stuck in a long request, a GC storm or a replay: the stuck
// thread shows as a growing `loop.lastTurnAgeMs`.
import {renameSync, writeFileSync, writeSync} from 'node:fs';
import {createServer} from 'node:http';
import {parentPort, workerData} from 'node:worker_threads';
import {liveOf, S} from './shared.ts';
import {apiOf} from './api-times.ts';
import {frameText, startStallStack, type StallReport} from './stall-stack.ts';
import {killJudge, type KillRule, type KillVerdict} from './watchdog.ts';

const {buffer, api, file, pid, port, everyMs, stall, kill} = workerData as {buffer: SharedArrayBuffer; api?: SharedArrayBuffer; file: string; pid: number; port?: number; everyMs?: number;
  stall?: {dataDir: string; root: string; stallMs: number; gapMs?: number}; kill?: KillRule};
const a = new Float64Array(buffer), apiA = api ? new Float64Array(api) : null;
let failed = false, writtenAt = 0;
// #457: the frame the main thread was stuck in, captured from here while it was stuck (stall-stack.ts); in live.json for
// 10 min, so the launcher's wedge line names it
let lastStall: StallReport | null = null;
// #2366: why this thread ended the world (live.json `killed`, read by the launcher's onExit)
let killed: (KillVerdict & {at: number}) | null = null;
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
setInterval(() => { const now = Date.now(); if (a[S.still] === 1 && a[S.stallMs] > 0 && !a[S.halted] && now - writtenAt < SILENT_EVERY_MS && now - a[S.lastTurnAt] < 5_000) return; write(); }, everyMs ?? 2000);
if (port !== undefined) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || !/^\/(?:[^?]*\/)?healthz(?:\?|$)/.test(req.url ?? '')) { res.writeHead(404).end(); return; }
    const live = liveOf(a, pid, Date.now()), up = live.phase === 'serving' && live.loop.lastTurnAgeMs < 30_000;
    res.writeHead(up ? 200 : 503, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify({ok: up, ...live}));
  });
  server.listen(port, '127.0.0.1', () => parentPort?.postMessage({listening: (server.address() as {port: number}).port}))
    .on('error', e => parentPort?.postMessage({error: `health port ${port}: ${e.message}`}));
}
// #2366 A2/A3: a world stuck past the hard limit (its main thread unturned for kill.hangMs, or its heap at kill.heapPct of the
// limit for kill.heapMs) is ended from here, where it is still seen: live.json says why, a line goes to stderr directly
// (a worker's console goes through the stuck main thread), then SIGKILL. The launcher restarts it (children.mjs onExit).
if (kill) {
  const judge = killJudge(kill);
  const look = setInterval(() => {
    const now = Date.now(), v = judge(liveOf(a, pid, now), now);
    if (!v) return;
    clearInterval(look); killed = {...v, at: now}; write();
    const what = v.reason === 'hang' ? `main thread stuck ${Math.round(v.stuckMs / 1000)} s${lastStall && lastStall.at >= now - v.stuckMs ? ` in ${lastStall.error ?? frameText(lastStall.frames[0])}` : ''}` : `heap ${v.usedMb} of ${v.limitMb} MB for ${Math.round(v.forMs / 1000)} s`;
    try { writeSync(2, `[load] watchdog: world.killed.${v.reason}: ${what}; ending the process for the launcher to restart it\n`); } catch { /* stderr gone */ }
    process.kill(pid, 'SIGKILL');
  }, 500);
}
