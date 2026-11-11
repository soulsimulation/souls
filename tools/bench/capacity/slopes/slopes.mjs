#!/usr/bin/env node
// CW7 (#741): inventory versus activity. Three orthogonal axes (report.mjs AXES) on one designated eden-2026 world:
// distant placed inventory 5,000 vs 10,000, active Souls 0/5/10 of 10 registered, and the designated world alone vs
// with 9 quiet ticking worlds beside it. Each world is booted directly with the checkout's own launcher command and
// production decoration (fake minds, Eyes off), in an isolated data dir under the run. Tools-only; never gated, never
// on Modal; indicative unless run on the qualifying executor (--qualifying-executor --quiet-host).
// Limit (#2039): a world this bench sends JavaScript over the inspector (Runtime.evaluate or callFunctionOn: the memory
// axis) boots with stall stacks off (SIM_STALL_STACK=0). The stall-stack watchdog's Debugger.pause followed by such a call
// aborts the world on a V8 check. Profiler calls (--cpu-prof) run no JavaScript and keep stall stacks on.
//
//   node tools/bench/capacity/slopes/slopes.mjs [--axis inventory,activity,quiet,walkers] [--repeats 1] [--out <dir>]
//        [--root <checkout>] [--port 4600] [--heap-mb 2048] [--quiet-worlds 9] [--warm-s 30] [--quiet-s 60]
//        [--active-s 180] [--probe-n 20] [--cpu-prof] [--slice "<command prefix>"] [--host-class laptop]
//        [--quiet-host] [--qualifying-executor] [--short]
//
// The walkers axis (#1961) is not in the default list: Eden 2026 quiet and with 25/50/100 scripted walkers, WALK_TICKS
// ticks each with the world's tick span timers on (SOULS_TICK_SPANS, world.ts) and, with --cpu-prof, a CPU profile of
// those ticks (tick-spans.jsonl, profile-walk.cpuprofile). The memory axis (#1973) is that quiet arm, then the world's
// memory: memory.json (process.memoryUsage() of the main thread and each worker thread, V8 heap spaces, a content hash of
// every ArrayBuffer by heap snapshot id) and main.heapsnapshot. `--axis memory --repeats 2`: two worlds, one template.
// #1972: every Soul is the raw-HTTP client Soul of #1945 (../meetup/client-soul.mjs): the catalog and live picture once
// after it joins, acts by catalog id (strict, keyed), each act's receipt read once after it (outside the probe), the
// client's headers and retry rules; no resolve.
// Per arm and repeat: <out>/<arm>-r<k>/{result.json, calls.jsonl, live.jsonl, world.log, profile-*.cpuprofile}.
// <out>/{receipt.json, results.json, REPORT.md}. No host name, user, home path or token in receipt/results/REPORT.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, freemem, platform, arch, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { FIXTURES, outcomeOf, rng } from '../meetup/workload.mjs';
import { withDistantInventory } from './inventory.mjs';
import { actBody, catalogIds, clientCall, clientHeaders, startPicture } from '../meetup/client-soul.mjs';
import { AXES, ACTS, PROBE_ROUTES, SLOPES, WALK_TICKS, WALK_EVERY_MS, tickSpanTable, subtreeTop, activePlan, cores, planSeed, probeRoute, qualifies, activeWindow, liveWindow, scheduleFacts, summarizeProfile, reportText } from './report.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4600)), INSPECT = PORT + 50, HEAP_MB = Number(opt('heap-mb', 2048)), REPEATS = Number(opt('repeats', 1));
const QUIET_N = Number(opt('quiet-worlds', 9)), PROBE_N = Number(opt('probe-n', SHORT ? 5 : 20)), PROF = flag('cpu-prof'), SLICE = opt('slice', '');
const WARM_S = Number(opt('warm-s', SHORT ? 10 : 30)), QUIET_S = Number(opt('quiet-s', SHORT ? 20 : 60)), ACTIVE_S = Number(opt('active-s', SHORT ? 40 : 180));
const HOST_CLASS = opt('host-class', 'laptop'), QUIET = flag('quiet-host'), QUALIFYING = qualifies({ executor: flag('qualifying-executor'), quiet: QUIET, short: SHORT, repeats: REPEATS });
const AXIS_LIST = opt('axis', 'inventory,activity,quiet').split(',');
for (const a of AXIS_LIST) if (!AXES[a]) throw new Error(`--axis ${a}: ${Object.keys(AXES).join(' | ')}`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/slopes', new Date().toISOString().replace(/[:.]/g, '-'))));
const { defaultCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/children.mjs')).href);
const { decorateCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/production.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const mono = () => performance.now();
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const rel = (p) => relative(ROOT, p) || '.';
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'slopes.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${rel(p)}: run \`${fix}\` in the checkout`);

// ------------------------------------------------------------------ process facts (Linux /proc, else ps)
const CLK_TCK = Number(sh('getconf', ['CLK_TCK']) ?? 100) || 100;
function proc(pid) {   // {t, cpuS, rssMb} | null
  const t = mono();
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '), rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return { t, cpuS: (Number(st[11]) + Number(st[12])) / CLK_TCK, rssMb: rss ? Number(rss[1]) / 1024 : null };
  } catch { /* not Linux */ }
  const line = sh('ps', ['-o', 'time=,rss=', '-p', String(pid)]); if (!line) return null;
  const [tm, rss] = line.trim().split(/\s+/), parts = tm.replace(/^(\d+)-/, (_, d) => `${d * 24}:`).split(':').map(Number);
  return { t, cpuS: parts.reduce((s, x) => s * 60 + x, 0), rssMb: Number(rss) / 1024 };
}
const sumProc = (ps) => (ps.every(Boolean) ? { t: ps[0].t, cpuS: ps.reduce((s, p) => s + p.cpuS, 0), rssMb: ps.reduce((s, p) => s + p.rssMb, 0) } : null);
// Soul server processes on the host that are not this run's (the qualify workflow's quiet check reads result.json `load`)
const otherSouls = (own = []) => (sh('pgrep', ['-f', 'apps/server/src/main.ts']) ?? '').split('\n').map(Number).filter((p) => p && !own.includes(p)).length;
const nodePid = (pid) => { for (let p = pid, k = 0; p && k < 4; k++) { if (/node/.test(sh('ps', ['-o', 'comm=', '-p', String(p)]) ?? '')) return p; p = Number((sh('pgrep', ['-P', String(p)]) ?? '').split('\n')[0]) || null; } return pid; };

// ------------------------------------------------------------------ worlds
async function getJ(url, ms = 5000, headers = {}) { const t = mono(); try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null), ms: mono() - t }; } catch { return { status: 0, j: null, ms: mono() - t }; } }
async function bootWorld(dir, { slug, templateFile, port, inspect, extraEnv = {} }) {
  const data = join(dir, 'data'), library = join(dir, 'library'); mkdirSync(data, { recursive: true }); mkdirSync(library, { recursive: true });
  const soul = (f) => join(ROOT, 'tools/world-launcher/soul', f), origin = `http://127.0.0.1:${port}`;
  const base = defaultCommand({ slug, dataDir: data, name: `Slopes ${slug}`, templateFile }, port,
    { publicOrigin: origin, marsWebDir: MARS_WEB, root: ROOT, libraryDir: library, soulControllerCliFile: soul('eden.mjs'), soulCliFile: soul('eden-agent.mjs'), soulSkillFile: soul('skill.md'), soulInstructionsFile: soul('instructions.md') });
  const { cmd: node, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: HEAP_MB, build: 'dev' });
  Object.assign(env, { MIND_DRIVER: 'edge', BRAIN_MODE: 'fake' }, extraEnv);
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES')) delete env[k];   // no renders (Eyes off)
  const cmd = [...(SLICE ? SLICE.split(/\s+/) : []), node, ...(inspect ? [`--inspect=127.0.0.1:${inspect}`] : []), ...args];
  writeFileSync(join(dir, 'world-command.json'), JSON.stringify({ cmd: cmd.map((x) => String(x).split(ROOT).join('.')), env: Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN|SECRET/.test(k)).map(([k, v]) => [k, String(v).split(ROOT).join('.')])) }, null, 1));
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let wlog = ''; const wl = (b) => { wlog = (wlog + b).slice(-20000); appendFileSync(join(dir, 'world.log'), b); };
  child.stdout.on('data', wl); child.stderr.on('data', wl);
  const booting = { slug, child }; LIVE.add(booting);   // stopped on SIGINT/SIGTERM, or below if it never comes up
  const t0 = mono(); let up = false;
  try {
    while (!up && mono() - t0 < 900_000) { if (child.exitCode != null) throw new Error(`${slug} exited at boot (${child.exitCode}): ${wlog.trim().split('\n').slice(-6).join(' | ').split(ROOT).join('.')}`); up = (await getJ(`${origin}/healthz`, 3000)).j?.ok; if (!up) await sleep(1000); }
    if (!up) throw new Error(`${slug} did not answer /healthz in 15 min`);
  } catch (e) { await stopWorld(booting); LIVE.delete(booting); throw e; }
  const bootS = (mono() - t0) / 1000;
  // settled: the boot's perceive catch-up logged, or 30 s up with three calm ticks; cap 300 s
  for (let calm = 0, tc = mono(); !/perceive catch-up/.test(wlog) && mono() - tc < 300_000 && !(mono() - tc > 30_000 && calm >= 3);) { await sleep(1000); const h = (await getJ(`${origin}/healthz`)).j; calm = h?.ok && h.tickMs?.avg < 25 ? calm + 1 : 0; }
  LIVE.delete(booting);   // the caller adds the world it returns
  return { slug, child, pid: nodePid(child.pid), data, origin, bootS: +bootS.toFixed(1), settledS: +((mono() - t0) / 1000).toFixed(1), tail: () => { const ls = wlog.trim().split('\n'), ld = ls.filter((l) => l.includes('[load]')).at(-1); return [...(ld ? [ld] : []), ...ls.slice(-3)].map((l) => l.slice(0, 200)).join(' | '); } };
}
async function stopWorld(w) {
  if (!w?.child || w.child.exitCode != null) return;
  w.child.kill('SIGTERM'); for (let k = 0; k < 60 && w.child.exitCode == null; k++) await sleep(500);
  if (w.child.exitCode == null) { w.child.kill('SIGKILL'); await sleep(500); }
}
/** #2064: a world that has stopped, named by its exit and its log's last lines (black for 60 s is a planned restart, exit 75). */
const worldExit = (w) => (w?.child && (w.child.exitCode != null || w.child.signalCode) ? `world exited (${w.child.exitCode ?? w.child.signalCode}): ${w.tail?.().split(ROOT).join('.') ?? ''}` : null);
const LIVE = new Set();   // worlds this process started and has not stopped yet (stopped on SIGINT/SIGTERM too)
const liveOf = (w) => { try { return JSON.parse(readFileSync(join(w.data, 'live.json'), 'utf8')); } catch { return null; } };

// ------------------------------------------------------------------ the inspector: CPU profiles of the main thread
async function inspector(port) {
  const list = (await getJ(`http://127.0.0.1:${port}/json/list`)).j, ws = new WebSocket(list[0].webSocketDebuggerUrl), wait = new Map(), events = new Map(); let id = 0;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m?.method) events.get(m.method)?.(m.params); const done = typeof m?.id === 'number' ? wait.get(m.id) : undefined; if (typeof done === 'function') { wait.delete(m.id); done(m); } };
  ws.onclose = () => { for (const done of wait.values()) done({ error: 'inspector closed' }); wait.clear(); };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 });
  return { send, on: (method, f) => events.set(method, f), start: () => send('Profiler.start'), stop: async () => (await send('Profiler.stop')).result?.profile ?? null, close: () => ws.close() };
}

// ------------------------------------------------------------------ #1973: what a world holds
const HASH_BUFFERS = `function () { return this.map((b) => { const u = new Uint8Array(b); let h = 0x811c9dc5, g = 0;
  for (let i = 0; i < u.length; i++) { h = Math.imul(h ^ u[i], 16777619); g = (g + Math.imul(u[i], i + 1)) | 0; } return [u.length, (h >>> 0).toString(16) + (g >>> 0).toString(16)]; }); }`;
async function memoryOf(insp, dir) {
  const value = async (expression) => JSON.parse((await insp.send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value ?? 'null');
  const usage = 'JSON.stringify(process.memoryUsage())', spaces = "JSON.stringify(process.getBuiltinModule('v8').getHeapSpaceStatistics())";
  const out = { before: await value(usage), workers: [] };
  // each worker thread's own heap (its isolate), through the main session's NodeWorker domain
  const sessions = []; let wid = 0; const wwait = new Map();
  insp.on('NodeWorker.attachedToWorker', (p) => sessions.push({ id: p.sessionId, title: p.workerInfo?.title ?? '' }));
  insp.on('NodeWorker.receivedMessageFromWorker', (p) => { let m; try { m = JSON.parse(p.message); } catch { return; } wwait.get(m.id)?.(m); wwait.delete(m.id); });
  await insp.send('NodeWorker.enable', { waitForDebuggerOnStart: false }); await sleep(1000);
  for (const w of sessions) {
    const r = await Promise.race([sleep(10_000), new Promise((ok) => { const i = ++wid; wwait.set(i, ok); insp.send('NodeWorker.sendMessageToWorker', { sessionId: w.id, message: JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: usage, returnByValue: true } }) }); })]);
    out.workers.push({ title: w.title.split(ROOT).join('.'), usage: r ? JSON.parse(r.result?.result?.value ?? 'null') : null });
  }
  await insp.send('NodeWorker.disable');
  out.heapSpaces = await value(spaces);
  // the main thread's heap snapshot (it collects garbage first), then what is left after that collection
  await insp.send('HeapProfiler.enable'); const file = join(dir, 'main.heapsnapshot'); writeFileSync(file, '');
  insp.on('HeapProfiler.addHeapSnapshotChunk', (p) => appendFileSync(file, p.chunk));
  await insp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  out.after = await value(usage); out.heapSpacesAfter = await value(spaces);
  // every ArrayBuffer and SharedArrayBuffer of the main thread: bytes, a content hash, and its node id in the snapshot
  out.buffers = [];
  for (const proto of ['ArrayBuffer.prototype', 'SharedArrayBuffer.prototype']) {
    const p = (await insp.send('Runtime.evaluate', { expression: proto, objectGroup: 'mem' })).result.result.objectId;
    const arr = (await insp.send('Runtime.queryObjects', { prototypeObjectId: p, objectGroup: 'mem' })).result.objects.objectId;
    const hashes = (await insp.send('Runtime.callFunctionOn', { objectId: arr, functionDeclaration: HASH_BUFFERS, returnByValue: true })).result.result.value;
    const props = (await insp.send('Runtime.getProperties', { objectId: arr, ownProperties: true })).result.result.filter((x) => /^\d+$/.test(x.name));
    for (const x of props) out.buffers.push({ kind: proto.split('.')[0], node: Number((await insp.send('HeapProfiler.getHeapObjectId', { objectId: x.value.objectId })).result.heapSnapshotObjectId), bytes: hashes[x.name][0], hash: hashes[x.name][1] });
  }
  await insp.send('Runtime.releaseObjectGroup', { objectGroup: 'mem' });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(out, null, 1) + '\n');
  return { rssMb: +(out.before.rss / 2 ** 20).toFixed(1), heapUsedMb: +(out.before.heapUsed / 2 ** 20).toFixed(1), externalMb: +(out.before.external / 2 ** 20).toFixed(1), arrayBuffersMb: +(out.before.arrayBuffers / 2 ** 20).toFixed(1),
    workers: out.workers.length, buffers: out.buffers.length, snapshotMb: +(statSync(file).size / 2 ** 20).toFixed(1) };
}

// ------------------------------------------------------------------ Souls (the checkout's own CLI, dev identity)
function runCli(dir, args, ms) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-500); }); p.stdout.resume();
    const k = setTimeout(() => p.kill('SIGKILL'), ms); p.on('exit', (code) => { clearTimeout(k); done({ code, err: err.trim().split('\n').at(-1) ?? '' }); });
  });
}
/** The CLI wants a world URL of the form …/w/<slug>; a directly booted world has no such prefix. A loopback proxy in
 *  this process strips it, for joining only (the measured calls go straight to the world). */
async function joinProxy(w, port) {
  const prefix = `/w/${w.slug}`, target = new URL(w.origin);
  const srv = createServer((req, res) => {
    const path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
    const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  return { url: `http://localhost:${port}${prefix}`, close: () => new Promise((ok) => srv.close(ok)) };
}
async function joinSoul(run, w, i) {
  const dir = join(run.dir, 'souls', `s${i}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${w.origin}/eden.mjs`)).arrayBuffer()));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-slopes-${run.id}-${i}` }) + '\n', { mode: 0o600 });
  const reg = await runCli(dir, ['register', run.joinUrl], 60_000); if (reg.code) log(`soul ${i} register: ${reg.code} ${reg.err.split(ROOT).join('.')}`);
  const token = () => { try { return JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')).token ?? null; } catch { return null; } };
  for (const t0 = mono(); !token() && mono() - t0 < 120_000;) { const r = await runCli(dir, ['create', `Slope${i}`], 150_000); if (!token()) { log(`soul ${i} create: ${r.code} ${r.err.split(ROOT).join('.')}`); await sleep(2000); } }
  if (!token()) throw new Error(`soul ${i} did not join`);
  const s = { i, token: token(), address: `198.51.100.${i + 1}` }, p = await startPicture(w.origin, s);   // the client's start (#1945)
  if (!p.catalog) throw new Error(`soul ${i}: catalog ${p.catalogStatus}`);
  return Object.assign(s, { catalog: p.catalog, liveStatus: p.liveStatus });
}
function requestOf(route, n, run) {
  const act = (capability) => ['POST', '/v1/edge/act', actBody(capability, `${run.id}-${run.seq++}`)];
  if (route === 'here') return ['GET', '/v1/edge/here?include=doHere'];
  if (route === 'observe') return ['GET', '/v1/edge/observe'];
  if (route === 'capabilities') return ['GET', '/v1/edge/capabilities'];
  if (route.startsWith('walk:')) return act(route);
  const a = ACTS[n % ACTS.length];
  return a === 'say' ? ['POST', '/v1/edge/say', { text: 'hello from the slopes bench' }] : act(a);
}
// The client's etiquette (client-soul.mjs clientCall): a designed busy or stalled answer is waited out for its
// Retry-After, up to 3 times; no answer is tried again with full jitter, up to 6 tries; the waits are inside the call's
// time and counted (busyWaits, waitMs, refusals by code). An act or say is keyed; an accepted act's receipt is read once
// after it (receiptMs, receiptStatus; not inside the call's time), except in the probe (one route at a time).
async function call(run, w, s, route, n, { receipt = true } = {}) {
  const [method, path, body] = requestOf(route, n, run), t = mono(), key = body?.clientRef ?? (method === 'POST' ? `${run.id}-${run.seq++}` : null);
  const x = await clientCall(`${w.origin}${path}`, { method, headers: clientHeaders(s, { key }), body, deadlineMs: method === 'GET' ? 60_000 : 90_000 });
  const { status, code, data: d, bytes, busy, waitMs, refusals } = x;
  const out = { route, ms: Math.round(mono() - t), bytes, status, outcome: outcomeOf({ status, code, accepted: d?.accepted }), ...(code ? { code } : {}), ...(busy ? { busyWaits: busy, waitMs, refusals } : {}) };
  const rid = d?.receipt?.id;
  if (receipt && rid && status >= 200 && status < 300) { const t1 = mono(), r = await clientCall(`${w.origin}/v1/edge/receipts/${encodeURIComponent(rid)}`, { headers: clientHeaders(s), deadlineMs: 60_000 }); Object.assign(out, { receiptMs: Math.round(mono() - t1), receiptStatus: r.status }); }
  return out;
}

// ------------------------------------------------------------------ #1961: a walkers arm
const spanRows = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
async function walkRun(arm, rep) {
  const dir = join(OUT, `${arm.id}-r${rep}`); mkdirSync(dir, { recursive: true });
  const run = { id: `${arm.id}r${rep}`, dir, seq: 0 }, spans = join(dir, 'tick-spans.jsonl'), calls = [], loadStart = loadavg().map((x) => +x.toFixed(2));
  let W = null, jp = null, prof = null, walking = false, walkers = null;
  try {
    log(`${run.id}: boot Eden 2026 (span timers on)`);
    W = await bootWorld(join(dir, 'w0'), { slug: 'sw0', templateFile: join(ROOT, 'worlds/templates/eden-2026.json'), port: PORT, inspect: PROF || arm.memory ? INSPECT : 0,
      // a heap snapshot holds the main thread for seconds: the stall stack (#457) would pause it in the debugger, which aborts V8
      extraEnv: { SOULS_TICK_SPANS: spans, ...(arm.memory ? { SIM_STALL_STACK: '0' } : {}) } }); LIVE.add(W);
    const souls = []; jp = await joinProxy(W, PORT + 40); run.joinUrl = jp.url;
    // joins come from one address, and the world pairs at most 20 a minute per address (http.ts `pair`): 16 a minute here
    for (let i = 0, started = []; i < arm.walkers; i += 4) {
      while (started.filter((t) => mono() - t < 60_000).length + 4 > 16) await sleep(1000);
      // #2064: on two cores a run of joins can hold the world at red or black; the next four wait for it, up to 5 min
      for (const t0 = mono(), at = () => getJ(`${W.origin}/healthz`).then((h) => h.j?.load?.level); ['red', 'black'].includes(await at()) && mono() - t0 < 300_000;) { if (worldExit(W)) break; log(`${run.id}: world not ready for joins at ${i}; waiting`); await sleep(10_000); }
      if (worldExit(W)) throw new Error(`${worldExit(W)}; ${i} of ${arm.walkers} joined`);
      const k4 = Math.min(4, arm.walkers - i); started.push(...Array(k4).fill(mono()));
      // a join that runs out of time while the world is busy (the join proxy answers 502 when the world drops a request) is tried twice more
      souls.push(...await Promise.all(Array.from({ length: k4 }, async (_, k) => { for (let t = 1; ; t++) { try { return await joinSoul(run, W, i + k); } catch (e) { if (t >= 3 || worldExit(W)) throw e; log(`soul ${i + k}: join try ${t} failed, again in 30 s`); await sleep(30_000); } } })));
    }
    await jp.close(); jp = null;
    const places = souls.length ? [...catalogIds(souls[0].catalog).walk].sort() : [];
    if (souls.length && !places.length) throw new Error('no walk places in the first Soul\'s catalog');
    log(`${run.id}: ${souls.length} walkers joined, ${places.length} places; walking`);
    // each walker walks to another place every WALK_EVERY_MS from a seeded offset, so all are moving through the window
    const R = rng(`${SLOPES}|${run.id}|walk`); walking = true;
    walkers = Promise.all(souls.map(async (s) => { await sleep(R() * WALK_EVERY_MS); for (let n = 0; walking; n++) { const t = mono(), c = await call(run, W, s, places[Math.floor(R() * places.length)], n); calls.push(c); await sleep(t + WALK_EVERY_MS - mono()); } }));
    await sleep(WALK_EVERY_MS + 2000);
    const from = spanRows(spans).at(-1)?.[0] ?? 0;
    prof = PROF ? await inspector(INSPECT) : null; if (prof) await prof.start();
    const w0 = mono();
    for (const t0 = w0; (spanRows(spans).at(-1)?.[0] ?? 0) < from + WALK_TICKS && mono() - t0 < 900_000 && !worldExit(W);) await sleep(2000);
    const windowS = (mono() - w0) / 1000;
    const profile = prof ? await prof.stop() : null; prof?.close(); prof = null;
    walking = false; await walkers; walkers = null;
    if (profile) writeFileSync(join(dir, 'profile-walk.cpuprofile'), JSON.stringify(profile));
    for (const c of calls) appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ phase: 'walk', ...c }) + '\n');
    const rows = spanRows(spans).filter((x) => x[0] > from && x[0] <= from + WALK_TICKS);
    const result = { arm, rep, facts: { walkers: souls.length, places: places.length, ticksPerS: +(WALK_TICKS / windowS).toFixed(1) }, ticks: tickSpanTable(rows), stepProfile: subtreeTop(profile, ROOT),
      walks: calls.reduce((m, c) => ({ ...m, [c.outcome]: (m[c.outcome] ?? 0) + 1 }), {}), host: { loadavgStart: loadStart, loadavgEnd: loadavg().map((x) => +x.toFixed(2)) } };
    if (result.ticks?.ticks !== WALK_TICKS) throw new Error(`${result.ticks?.ticks ?? 0} of ${WALK_TICKS} ticks recorded`);
    if (arm.memory) { const insp = await inspector(INSPECT); try { result.memory = await memoryOf(insp, dir); } finally { insp.close(); } }
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1) + '\n');
    log(`${run.id}: tick p50 ${result.ticks.p50Ms} ms, p99 ${result.ticks.p99Ms} ms, shares ${JSON.stringify(result.ticks.shares)}, walks ${JSON.stringify(result.walks)}`);
    return result;
  } catch (e) { const x = worldExit(W); throw x && !String(e.message).includes(x) ? new Error(`${e.message}; ${x}`) : e;
  } finally {
    walking = false; await walkers; await jp?.close(); prof?.close();
    if (W) { await stopWorld(W); LIVE.delete(W); }
  }
}

// ------------------------------------------------------------------ one arm
async function oneRun(arm, rep) {
  const dir = join(OUT, `${arm.id}-r${rep}`); mkdirSync(dir, { recursive: true });
  const run = { id: `${arm.id}r${rep}`, dir, seq: 0 }, worlds = [], samples = [], calls = [], otherBefore = otherSouls();
  const src = JSON.parse(readFileSync(join(ROOT, 'worlds/templates/eden-2026.json'), 'utf8')), inv = arm.placed ? withDistantInventory(src, arm.placed) : { template: src, added: 0, own: null, region: null };
  const templateFile = join(dir, 'template.json'); writeFileSync(templateFile, JSON.stringify(inv.template));
  const placed = inv.template.batches.reduce((s, b) => s + b.ops.filter((o) => o.op === 'place').length, 0);
  let sampling = false, sampler = null, jp = null, prof = null;   // stopped in the finally, also when the arm throws
  try {
    log(`${run.id}: boot designated world (${placed} placed${inv.added ? `, ${inv.added} distant` : ''})`);
    const W = await bootWorld(join(dir, 'w0'), { slug: 'sw0', templateFile, port: PORT, inspect: PROF ? INSPECT : 0 }); worlds.push(W); LIVE.add(W);
    const quietN = arm.quiet ? Math.min(arm.quiet, QUIET_N) : 0;
    for (let q = 1; q <= quietN; q++) { const f = FIXTURES[q]; log(`${run.id}: boot quiet world ${q} (${f.template})`); const qw = await bootWorld(join(dir, `w${q}`), { slug: `sq${q}`, templateFile: join(ROOT, 'worlds/templates', `${f.template}.json`), port: PORT + q, inspect: 0 }); worlds.push(qw); LIVE.add(qw); }
    const souls = []; jp = await joinProxy(W, PORT + 40); run.joinUrl = jp.url;
    for (let i = 0; i < arm.registered; i += 4) souls.push(...await Promise.all(Array.from({ length: Math.min(4, arm.registered - i) }, (_, k) => joinSoul(run, W, i + k))));
    await jp.close(); jp = null;
    log(`${run.id}: ${souls.length} Souls joined; warm-up ${WARM_S} s`);
    sampling = true;
    sampler = (async () => { while (sampling) { const l = liveOf(W); samples.push({ t: mono(), live: l, w: proc(W.pid), q: worlds.length > 1 ? sumProc(worlds.slice(1).map((x) => proc(x.pid))) : null }); await sleep(2000); } })();
    await sleep(WARM_S * 1000);
    const mark = (k) => ({ k, t: mono(), w: proc(W.pid), q: worlds.length > 1 ? sumProc(worlds.slice(1).map((x) => proc(x.pid))) : null });
    const m = { quiet0: mark('quiet0') }; await sleep(QUIET_S * 1000); m.quiet1 = mark('quiet1');
    const quietCores = cores(m.quiet0.w, m.quiet1.w);
    // the probe: PROBE_N serial calls per route, one at a time, rotating over the registered Souls (each has its own
    // CPU budget: one Soul alone runs out of it at 10,000 objects and is told soul.slow-down), nothing else active
    prof = PROF ? await inspector(INSPECT) : null; const profiles = {};
    if (prof) await prof.start();
    const probe = {};
    for (const route of PROBE_ROUTES) {
      const a = proc(W.pid), cs = []; for (let n = 0; n < PROBE_N; n++) cs.push(await call(run, W, souls[n % souls.length], route, n, { receipt: false })); const b = proc(W.pid);
      probe[route] = probeRoute(cs, { cpuS: a && b ? b.cpuS - a.cpuS : null, spanMs: a && b ? b.t - a.t : null, quietCores });
      for (const c of cs) appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ phase: 'probe', ...c }) + '\n');
    }
    if (prof) { const p = await prof.stop(); writeFileSync(join(dir, 'profile-probe.cpuprofile'), JSON.stringify(p)); profiles.probe = summarizeProfile(p, ROOT); }
    // the active window: `active` Souls at CW1's per-Soul rates, one call at a time, from seeded offsets
    // seeded by the repeat, not the arm (report.mjs activePlan, #951): every arm of a repeat replays the same phases
    const seed = planSeed(rep), opsBySoul = activePlan(seed, arm.active, ACTIVE_S * 1000), schedule = scheduleFacts(opsBySoul, seed);
    const plan = opsBySoul.map((ops, i) => ({ s: souls[i], ops })), offered = opsBySoul.reduce((t, ops) => t + ops.length, 0);
    if (prof) await prof.start();
    m.active0 = mark('active0'); const t0 = m.active0.t, end = t0 + ACTIVE_S * 1000;
    await Promise.all(plan.map(async ({ s, ops }) => { for (const [k, op] of ops.entries()) { await sleep(t0 + op.at - mono()); if (mono() >= end) break;
      const late = Math.max(0, Math.round(mono() - (t0 + op.at))), c = await call(run, W, s, op.route, op.n ?? k); c.lateMs = late; calls.push(c); appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ phase: 'active', ...c }) + '\n'); } }));
    await sleep(end - mono()); m.active1 = mark('active1');
    if (prof) { const p = await prof.stop(); writeFileSync(join(dir, 'profile-active.cpuprofile'), JSON.stringify(p)); profiles.active = summarizeProfile(p, ROOT); prof.close(); prof = null; }
    sampling = false; await sampler;
    for (const x of samples) appendFileSync(join(dir, 'live.jsonl'), JSON.stringify({ t: Math.round(x.t), live: x.live, w: x.w, q: x.q }) + '\n');
    const inWin = (a, b) => samples.filter((x) => x.t >= a.t && x.t <= b.t);
    const win = (a, b, k) => ({ cores: cores(a[k], b[k]) == null ? null : +cores(a[k], b[k]).toFixed(3), rssMbMax: Math.round(Math.max(0, ...inWin(a, b).map((x) => x[k]?.rssMb ?? 0))) });
    const dbBytes = (() => { try { return statSync(join(W.data, 'sim.db')).size; } catch { return null; } })();
    const result = {
      arm, rep, facts: { placed, distantAdded: inv.added, region: inv.region, residentSouls: liveOf(W)?.souls ?? null },
      boot: { seconds: W.bootS, settledS: W.settledS, dbMb: dbBytes == null ? null : +(dbBytes / 2 ** 20).toFixed(1), quietWorlds: worlds.slice(1).map((x) => ({ slug: x.slug, bootS: x.bootS })) },
      windows: { quiet: win(m.quiet0, m.quiet1, 'w'), active: win(m.active0, m.active1, 'w') },
      quietWorlds: worlds.length > 1 ? { n: worlds.length - 1, ...win(m.active0, m.active1, 'q') } : null,
      probe, schedule, active: activeWindow(calls, { cpuS: m.active0.w && m.active1.w ? m.active1.w.cpuS - m.active0.w.cpuS : null, spanMs: m.active1.t - m.active0.t, quietCores, offered }),
      live: { quiet: liveWindow(inWin(m.quiet0, m.quiet1).map((x) => x.live).filter(Boolean)), active: liveWindow(inWin(m.active0, m.active1).map((x) => x.live).filter(Boolean)) },
      profiles, load: { otherSoulsProcessesBefore: otherBefore, otherSoulsProcessesAfter: otherSouls(worlds.map((x) => x.pid)) }, host: { loadavg: loadavg().map((x) => +x.toFixed(2)), freeMemMb: Math.round(freemem() / 2 ** 20) },
    };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1) + '\n');
    log(`${run.id}: quiet ${result.windows.quiet.cores} cores, active ${result.windows.active.cores} cores, ${result.active.served}/${offered} served, probe CPU-ms ${PROBE_ROUTES.map((k) => `${k} ${probe[k].cpuMsPerCall}`).join(', ')}`);
    return result;
  } finally {
    sampling = false; await sampler; await jp?.close(); prof?.close();
    for (const w of worlds.reverse()) { await stopWorld(w); LIVE.delete(w); }
  }
}

// ------------------------------------------------------------------ main
const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), dirty = !!sh('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']);
const receipt = { slopes: SLOPES, at: new Date().toISOString(), indicative: !QUALIFYING, source: { commit, dirty, bench: sh('git', ['rev-parse', 'HEAD']) },
  host: { class: HOST_CLASS, platform: platform(), arch: arch(), cores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), quietDeclared: QUIET, loadavgStart: loadavg().map((x) => +x.toFixed(2)) },
  axes: AXIS_LIST, repeats: REPEATS, windows: { warmS: WARM_S, quietS: QUIET_S, activeS: ACTIVE_S, probeN: PROBE_N }, quietWorldsCap: QUIET_N, cpuProfile: PROF, slice: SLICE ? 'given' : null,
  coverage: ['fake minds; server delivery only, no model latency', 'acts never move a Soul (attention, gesture, say): walk planning (#454) is not exercised', 'Eyes (rendering) off; no browser viewers; no launcher proxy',
    'the active window replays one schedule per repeat (seeded by the repeat, not the arm; #951): every arm of a repeat has the same phases for its first k Souls, and `crowded reads` gives how bursty they were',
    'CPU is the whole world process (worker threads included); per-call CPU is an upper bound (tick variation inside it)', 'no counters for rows examined, plan builds or invalidations: the CPU profile attributes cost to functions instead',
    ...(PROF ? ['with --cpu-prof the probe and active windows run under a 1 ms sampling profiler and the quiet window does not: its overhead is inside every per-call CPU figure, alike across arms'] : []),
    ...(QUIET_N < 9 ? [`quiet axis capped at ${QUIET_N} quiet worlds (--quiet-worlds), not 9`] : [])] };
writeFileSync(join(OUT, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
const results = [];
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig}): stopping ${LIVE.size} world(s)`); await Promise.all([...LIVE].map(stopWorld)); process.exit(130); });
for (let rep = 1; rep <= REPEATS; rep++) for (const axis of AXIS_LIST) for (const arm of AXES[axis]) {
  try { results.push(await (arm.walkers != null ? walkRun : oneRun)(arm, rep)); } catch (e) { log(`${arm.id}-r${rep} failed: ${String(e.message).split(ROOT).join('.')}`); results.push({ arm, rep, error: String(e.message).split(ROOT).join('.') }); }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1) + '\n');
}
receipt.host.loadavgEnd = loadavg().map((x) => +x.toFixed(2)); writeFileSync(join(OUT, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
writeFileSync(join(OUT, 'REPORT.md'), reportText(receipt, results));
const failed = results.filter((x) => x.error);
log(`done: ${rel(join(OUT, 'REPORT.md'))}${failed.length ? `; ${failed.length} of ${results.length} runs FAILED` : ''}`);
if (failed.length) process.exitCode = 1;   // a run with a failed arm is never a clean result
