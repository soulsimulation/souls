// LOAD-CONTRACT §4: the watchdog thread. Reads the shared numbers (shared.ts) and every 2 s writes <DATA_DIR>/live.json by
// atomic rename; optionally answers GET /healthz on its own loopback port (SIM_HEALTH_PORT). It never touches world
// state, so it keeps reporting while the main thread is stuck in a long request, a GC storm or a replay: the stuck
// thread shows as a growing `loop.lastTurnAgeMs`.
import {renameSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {parentPort, workerData} from 'node:worker_threads';
import {liveOf} from './shared.ts';
import {apiOf} from './api-times.ts';
import {frameText, startStallStack, type StallReport} from './stall-stack.ts';

const {buffer, api, file, pid, port, everyMs, stall} = workerData as {buffer: SharedArrayBuffer; api?: SharedArrayBuffer; file: string; pid: number; port?: number; everyMs?: number;
  stall?: {dataDir: string; root: string; stallMs: number; gapMs?: number}};
const a = new Float64Array(buffer), apiA = api ? new Float64Array(api) : null;
let failed = false;
// #457: the frame the main thread was stuck in, captured from here while it was stuck (stall-stack.ts); in live.json for
// 10 min, so the launcher's wedge line names it
let lastStall: StallReport | null = null;
if (stall) { try { startStallStack({a, dataDir: stall.dataDir, root: stall.root, stallMs: stall.stallMs, gapMs: stall.gapMs, onReport: r => { lastStall = r; write(); }, onEnabled: (ms, n) => parentPort?.postMessage({info: `stall stacks on (#457): debugger enabled in ${Math.round(ms)} ms, ${n} scripts announced`})}); } catch (e) { parentPort?.postMessage({error: `stall stacks off: ${(e as Error).message}`}); } }
function write() {
  const now = Date.now(), live = apiA ? {...liveOf(a, pid, now), api: apiOf(apiA, now)} : liveOf(a, pid, now);
  const body = JSON.stringify(lastStall && now - lastStall.at < 600_000 ? {...live, stall: {at: lastStall.at, stuckMs: lastStall.stuckMs, top: lastStall.error ?? frameText(lastStall.frames[0]), frames: lastStall.frames.slice(0, 5).map(frameText)}} : live);
  try { writeFileSync(file + '.tmp', body + '\n'); renameSync(file + '.tmp', file); failed = false; }
  catch (e) { if (!failed) parentPort?.postMessage({error: `live.json not written: ${(e as Error).message}`}); failed = true; }
}
write();
setInterval(write, everyMs ?? 2000);
if (port !== undefined) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || !/^\/(?:[^?]*\/)?healthz(?:\?|$)/.test(req.url ?? '')) { res.writeHead(404).end(); return; }
    const live = liveOf(a, pid, Date.now()), up = live.phase === 'serving' && live.loop.lastTurnAgeMs < 30_000;
    res.writeHead(up ? 200 : 503, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify({ok: up, ...live}));
  });
  server.listen(port, '127.0.0.1', () => parentPort?.postMessage({listening: (server.address() as {port: number}).port}))
    .on('error', e => parentPort?.postMessage({error: `health port ${port}: ${e.message}`}));
}
