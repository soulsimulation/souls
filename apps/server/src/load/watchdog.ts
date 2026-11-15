// Starts the watchdog thread (watchdog-worker.ts) first thing in main.ts. Unref'd: it never keeps the process alive.
import {renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {liveOf, sharedLoad} from './shared.ts';
import {apiOf, sharedApi} from './api-times.ts';

/** live.json from this thread, now (the stop path: the process may exit before the watchdog's next write). */
export function writeLiveNow(dataDir: string, a: Float64Array = sharedLoad) {
  const file = join(dataDir, 'live.json');
  try { const now = Date.now(); writeFileSync(file + '.main.tmp', JSON.stringify({...liveOf(a, process.pid, now), api: apiOf(sharedApi, now)}) + '\n'); renameSync(file + '.main.tmp', file); } catch { /* best effort */ }
}

/** #457: name the stalled frame (stall-stack.ts) unless SIM_STALL_STACK=0; after SIM_STALL_STACK_MS (default 2000) stuck. */
export function stallConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.SIM_STALL_STACK === '0') return undefined;
  return {dataDir, root: fileURLToPath(new URL('../../../../', import.meta.url)), stallMs: Number(env.SIM_STALL_STACK_MS) > 0 ? Number(env.SIM_STALL_STACK_MS) : 2000};
}
export function startWatchdog(opts: {dataDir: string; port?: number; everyMs?: number; shared?: Float64Array; api?: Float64Array; onListening?: (port: number) => void; stall?: ReturnType<typeof stallConfig>}) {
  const worker = new Worker(new URL('./watchdog-worker.ts', import.meta.url), {
    workerData: {buffer: (opts.shared ?? sharedLoad).buffer, api: (opts.api ?? sharedApi).buffer, file: join(opts.dataDir, 'live.json'), pid: process.pid, port: opts.port, everyMs: opts.everyMs, stall: opts.stall},
    execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 32},
  });
  worker.on('message', (m: {error?: string; listening?: number; info?: string}) => { if (m.error) console.error(`[load] watchdog: ${m.error}`); else if (m.info) console.log(`[load] watchdog: ${m.info}`); else if (m.listening) { console.log(`[load] watchdog /healthz on 127.0.0.1:${m.listening}`); opts.onListening?.(m.listening); } });
  worker.on('error', e => console.error('[load] watchdog thread failed', e));
  worker.unref();
  return worker;
}
