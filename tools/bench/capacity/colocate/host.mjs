#!/usr/bin/env node
// #2300: one program that holds several worlds, for the trial (measurement code; the launcher never uses it).
//   --form threads     form 1: each world on its own worker thread (its own V8 isolate, env and heap limit)
//   --form one-thread  form 2: every world on this one thread. Each world is main.ts imported again under its own query
//                      string, so main.ts runs once per world while every module it imports is loaded once and shared
//                      (code, definitions, module-level caches and registries). process.env is set to the world's env
//                      before its import; loads run one at a time.
// Driven over IPC by colocate.mjs: {op:'load', id, dir, env, heapMb} → {op:'loaded'|'failed', id, ms}; a thread that
// ends sends {op:'exit', id, code, error}.
import { Worker } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { armFaults } from './faults.mjs';

const argv = process.argv.slice(2), opt = (k) => argv[argv.indexOf(`--${k}`) + 1];
const FORM = opt('form'), MAIN = pathToFileURL(join(opt('root'), 'apps/server/src/main.ts')).href, CONFIG = pathToFileURL(join(opt('root'), 'apps/server/src/config.ts')).href;
const send = (m) => { try { process.send?.(m); } catch { /* parent gone */ } };
const baseEnv = { ...process.env };
let chain = Promise.resolve();

function loadThread(m) {
  const t0 = performance.now(), out = createWriteStream(join(m.dir, 'world.log'), { flags: 'a' });
  const w = new Worker(new URL('./world-entry.mjs', import.meta.url), { env: { ...m.env }, workerData: { main: MAIN }, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: m.heapMb } });
  w.stdout.pipe(out); w.stderr.pipe(out);
  w.on('error', (e) => send({ op: 'exit', id: m.id, code: null, error: `${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 200)}`.trim() }));
  w.on('exit', (code) => send({ op: 'exit', id: m.id, code }));
  send({ op: 'loaded', id: m.id, ms: Math.round(performance.now() - t0) });
}
async function loadOneThread(m) {
  const t0 = performance.now();
  for (const k of Object.keys(process.env)) if (!(k in baseEnv)) delete process.env[k];
  Object.assign(process.env, m.env);
  armFaults(m.env.DATA_DIR);
  // config.ts is one object per program, read from process.env once (A4). For the trial it is refilled in place with
  // this world's values before its main.ts runs, so the world boots with its own port and data directory; whatever reads
  // `config` later, after the next world has loaded, sees that next world's values.
  const shared = (await import(CONFIG)).config, own = (await import(`${CONFIG}?world=${encodeURIComponent(m.id)}`)).config;
  Object.assign(shared, own);
  try { await import(`${MAIN}?world=${encodeURIComponent(m.id)}`); send({ op: 'loaded', id: m.id, ms: Math.round(performance.now() - t0) }); }
  catch (e) { send({ op: 'failed', id: m.id, error: String(e?.message ?? e).slice(0, 300) }); }
}
process.on('message', (m) => {
  if (m?.op !== 'load') return;
  if (FORM === 'threads') loadThread(m);
  else chain = chain.then(() => loadOneThread(m));
});
process.on('disconnect', () => process.exit(0));
