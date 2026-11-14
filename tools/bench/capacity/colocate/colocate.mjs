#!/usr/bin/env node
// #2300: several worlds in one running program, both forms measured side by side with today's one program per world.
// Measurement code only (the launcher never uses it; nothing is on by default). Per form, six worlds (four small from
// `hello-hamlet`, two Eden 2026), fake minds, Eyes off, each with the launcher's own command and production decoration:
//   baseline    one program per world, as today (`node --import preload.mjs apps/server/src/main.ts`)
//   threads     form 1: one program, each world on its own worker thread (host.mjs --form threads)
//   one-thread  form 2: one program, every world on one thread sharing code, definitions and caches (host.mjs --form one-thread)
// Measured per form (A2, A3):
//   memory      Pss (/proc/<pid>/smaps_rollup, Linux) after each load, after --settle-s quiet, and after --walk-s with one
//               Soul walking in a small world and one in an Eden world (the program's total; per process for the baseline)
//   ticks       tick time (SOULS_TICK_SPANS, every world's own file) of a small and the second Eden world, quiet and
//               while the first Eden world is busy (--busy walkers walking every 8 s)
//   one more    time from the load request to the first /healthz answer for a seventh (small) and an eighth (Eden)
//               world, and the longest gap in the other worlds' /healthz answers meanwhile
//   faults      an exception, a runaway allocation and a 15 s tick in one world each (faults.mjs); what every other
//               world's /healthz saw over the next 30 s, and whether the program survived
// Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `colocate`) on a souls-timed runner;
// locally only as a smoke (`--short`, figures indicative, no Pss off Linux).
//
//   node tools/bench/capacity/colocate/colocate.mjs [--forms baseline,threads,one-thread] [--settle-s 90] [--walk-s 60]
//        [--busy 10] [--out <dir>] [--port 4800] [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, colocate.log} and <out>/<form>/<world>/{world.log, tick-spans.jsonl}.
// No host name, user, home path or token in results.json or REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actBody, catalogIds, clientCall, clientHeaders, startPicture } from '../meetup/client-soul.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4800)), SETTLE_S = Number(opt('settle-s', SHORT ? 20 : 90)), WALK_S = Number(opt('walk-s', SHORT ? 20 : 60)), BUSY = Number(opt('busy', SHORT ? 2 : 10));
const FORMS = opt('forms', 'baseline,threads,one-thread').split(',');
for (const f of FORMS) if (!['baseline', 'threads', 'one-thread'].includes(f)) throw new Error(`--forms ${f}: baseline | threads | one-thread`);
const SIX = SHORT && flag('tiny') ? [['s1', 'small'], ['s2', 'small'], ['e1', 'eden']] : [['s1', 'small'], ['s2', 'small'], ['s3', 'small'], ['s4', 'small'], ['e1', 'eden'], ['e2', 'eden']];
const MORE = [['s5', 'small'], ['e3', 'eden']], TEMPLATE = { small: 'hello-hamlet', eden: 'eden-2026' };
const OUT = resolve(opt('out', join(ROOT, '.local/bench/colocate', new Date().toISOString().replace(/[:.]/g, '-'))));
const { defaultCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/children.mjs')).href);
const { decorateCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/production.mjs')).href);
const { worldHeapMb } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/registry.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const scrub = (s) => String(s).split(ROOT).join('.');
const mb = (b) => (b == null ? null : +(b / 2 ** 20).toFixed(1)), r1 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(1));
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'colocate.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);

// ------------------------------------------------------------------ memory
function tree(pid) { const out = [pid], q = [pid]; while (q.length) for (const c of (sh('pgrep', ['-P', String(q.shift())]) ?? '').split('\n').map(Number).filter(Boolean)) { out.push(c); q.push(c); } return out; }
/** Summed smaps_rollup of the processes and their descendants, bytes; null off Linux. */
function smaps(pids) {
  const sum = { rss: 0, pss: 0, private: 0, processes: 0 };
  for (const p of pids.flatMap(tree)) {
    let t; try { t = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'); } catch { continue; }
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t)?.[1] ?? 0) * 1024;
    sum.rss += kb('Rss'); sum.pss += kb('Pss'); sum.private += kb('Private_Clean') + kb('Private_Dirty'); sum.processes++;
  }
  return sum.processes ? { rssMb: mb(sum.rss), pssMb: mb(sum.pss), privateMb: mb(sum.private), processes: sum.processes } : null;
}

// ------------------------------------------------------------------ one world's command (the launcher's, decorated)
const portFree = (p) => new Promise((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
const TAKEN = new Set();
/** A port of the run's span that is free now: an outgoing connection can hold a port of the span (the ephemeral range
 *  overlaps it), so each world's port is checked just before it loads. */
async function freePort(i) { for (let p = PORT + i; p < PORT + 40; p++) if (!TAKEN.has(p) && await portFree(p)) { TAKEN.add(p); return p; } throw new Error('no free port in the span'); }
async function worldSpec(form, id, kind, i) {
  const dir = join(OUT, form, id), data = join(dir, 'data'), library = join(dir, 'library'); mkdirSync(data, { recursive: true }); mkdirSync(library, { recursive: true });
  const port = await freePort(i), origin = `http://127.0.0.1:${port}`, slug = `co-${id}`, heapMb = worldHeapMb({ template: TEMPLATE[kind] }, 0), soul = (f) => join(ROOT, 'tools/world-launcher/soul', f);
  const base = defaultCommand({ slug, dataDir: data, name: `Colocate ${id}`, templateFile: join(ROOT, 'worlds/templates', `${TEMPLATE[kind]}.json`) }, port,
    { publicOrigin: origin, marsWebDir: MARS_WEB, root: ROOT, libraryDir: library, soulControllerCliFile: soul('eden.mjs'), soulCliFile: soul('eden-agent.mjs'), soulSkillFile: soul('skill.md'), soulInstructionsFile: soul('instructions.md') });
  const { cmd, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: heapMb, build: 'dev' });
  Object.assign(env, { MIND_DRIVER: 'edge', BRAIN_MODE: 'fake', SOULS_TICK_SPANS: join(dir, 'tick-spans.jsonl') });
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES')) delete env[k];
  return { id, kind, dir, data, port, origin, slug, heapMb, cmd, args, env, form };
}

// ------------------------------------------------------------------ a program holding worlds
async function getJ(url, ms = 3000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null) }; } catch { return { status: 0, j: null }; } }
/** baseline: a program per world; threads / one-thread: one host program. load(w) → resolves at the first /healthz. */
function program(form) {
  const P = { form, worlds: new Map(), host: null, exits: [], hostExit: null };
  const pids = () => (form === 'baseline' ? [...P.worlds.values()].filter((w) => w.child?.exitCode == null).map((w) => w.child.pid) : P.host && P.hostExit == null ? [P.host.pid] : []);
  P.mem = () => smaps(pids());
  P.memOf = (w) => (form === 'baseline' && w.child?.exitCode == null ? smaps([w.child.pid]) : null);
  P.alive = (w) => (form === 'baseline' ? w.child?.exitCode == null : P.hostExit == null && !w.ended);
  function startHost() {
    const sumHeap = SIX.concat(MORE).reduce((s, [, k]) => s + worldHeapMb({ template: TEMPLATE[k] }, 0), 0), any = { env: { MALLOC_ARENA_MAX: '2', MALLOC_MMAP_THRESHOLD_: '262144', MALLOC_TRIM_THRESHOLD_: '1048576' } };   // production.mjs WORLD_MALLOC_ENV
    const env = { ...process.env, MALLOC_ARENA_MAX: any.env.MALLOC_ARENA_MAX, MALLOC_MMAP_THRESHOLD_: any.env.MALLOC_MMAP_THRESHOLD_, MALLOC_TRIM_THRESHOLD_: any.env.MALLOC_TRIM_THRESHOLD_ };
    delete env.NODE_OPTIONS;
    const execArgv = form === 'one-thread' ? [`--max-old-space-size=${sumHeap}`] : [];
    P.host = spawn(process.execPath, [...execArgv, join(ROOT, 'tools/bench/capacity/colocate/host.mjs'), '--form', form, '--root', ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const hostLog = (b) => appendFileSync(join(OUT, form, 'host.log'), b);
    P.host.stdout.on('data', hostLog); P.host.stderr.on('data', hostLog);
    P.host.on('exit', (code, sig) => { P.hostExit = { code, sig, at: Date.now() }; log(`${form}: host program ended (${code ?? sig})`); });
    P.host.on('message', (m) => {
      const w = P.worlds.get(m.id); if (!w) return;
      if (m.op === 'failed') w.failed = m.error;
      if (m.op === 'exit') { w.ended = { code: m.code, error: m.error, at: Date.now() }; P.exits.push({ id: m.id, ...w.ended }); log(`${form}: ${m.id} thread ended (${m.code ?? ''} ${m.error ?? ''})`); }
    });
  }
  P.load = async (w) => {
    P.worlds.set(w.id, w); const t0 = Date.now();
    if (form === 'baseline') {
      w.child = spawn(w.cmd, ['--import', pathToFileURL(join(ROOT, 'tools/bench/capacity/colocate/preload.mjs')).href, ...w.args], { cwd: ROOT, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const wl = (b) => appendFileSync(join(w.dir, 'world.log'), b); w.child.stdout.on('data', wl); w.child.stderr.on('data', wl);
      w.child.on('exit', (code, sig) => { w.ended = { code, sig, at: Date.now() }; P.exits.push({ id: w.id, code, sig }); });
    } else {
      if (!P.host || P.hostExit) { P.hostExit = null; startHost(); }
      const { NODE_OPTIONS, ...env } = w.env; void NODE_OPTIONS;
      P.host.send({ op: 'load', id: w.id, dir: w.dir, env, heapMb: w.heapMb });
    }
    while (!(await getJ(`${w.origin}/healthz`)).j?.ok) {
      if (!P.alive(w) || w.failed) throw new Error(`${w.id} ended at boot: ${scrub(w.failed ?? JSON.stringify(w.ended ?? P.hostExit))}`);
      if (Date.now() - t0 > 600_000) throw new Error(`${w.id} did not answer /healthz in 10 min`);
      await sleep(250);
    }
    w.loadS = +((Date.now() - t0) / 1000).toFixed(2);
    return w;
  };
  P.stop = async () => {
    for (const w of P.worlds.values()) TAKEN.delete(w.port);
    if (form === 'baseline') { for (const w of P.worlds.values()) if (w.child?.exitCode == null) w.child.kill('SIGKILL'); }
    else if (P.host && P.hostExit == null) P.host.kill('SIGKILL');
    await sleep(1000);
  };
  return P;
}
const PROGRAMS = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig})`); await Promise.all([...PROGRAMS].map((p) => p.stop())); process.exit(130); });

// ------------------------------------------------------------------ ticks (SOULS_TICK_SPANS: [tick, total, …] every 100 ticks)
const spanRows = (w) => { try { return readFileSync(w.env.SOULS_TICK_SPANS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function tickStats(rows) {
  const t = rows.map((r) => r[1]).sort((a, b) => a - b); if (!t.length) return null;
  const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
  return { ticks: t.length, p50Ms: r1(q(0.5)), p99Ms: r1(q(0.99)), maxMs: r1(t.at(-1)), meanMs: r1(t.reduce((s, x) => s + x, 0) / t.length) };
}
/** Tick stats of each world over a window of `ms` (rows that land in it; a row batch lands every 100 ticks). */
async function tickWindow(worlds, ms) {
  const from = new Map(worlds.map((w) => [w.id, spanRows(w).length])); await sleep(ms);
  return Object.fromEntries(worlds.map((w) => [w.id, tickStats(spanRows(w).slice(from.get(w.id)))]));
}

// ------------------------------------------------------------------ /healthz watch: what the other worlds saw
function watch(worlds) {
  const s = Object.fromEntries(worlds.map((w) => [w.id, { ok: 0, fail: 0, lastOk: Date.now(), maxGapMs: 0 }])); let on = true;
  const loops = worlds.map(async (w) => { while (on) { const t = Date.now(), r = await getJ(`${w.origin}/healthz`, 1000), x = s[w.id];
    if (r.j?.ok) { x.maxGapMs = Math.max(x.maxGapMs, Date.now() - x.lastOk); x.lastOk = Date.now(); x.ok++; } else x.fail++;
    await sleep(t + 200 - Date.now()); } });
  return async () => { on = false; await Promise.all(loops); for (const [id, x] of Object.entries(s)) { x.maxGapMs = Math.max(x.maxGapMs, Date.now() - x.lastOk); x.answeringAtEnd = x.fail === 0 || Date.now() - x.lastOk < 1500; s[id] = x; } return s; };
}

// ------------------------------------------------------------------ Souls: join (the world's own CLI, dev identity) and walk
function runCli(dir, args, ms) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-500); }); p.stdout.resume();
    const k = setTimeout(() => p.kill('SIGKILL'), ms); p.on('exit', (code) => { clearTimeout(k); done({ code, err: err.trim().split('\n').at(-1) ?? '' }); });
  });
}
/** The CLI wants a world URL …/w/<slug>; a directly booted world has no such prefix, so a loopback proxy strips it. */
async function joinProxy(w, port) {
  const prefix = `/w/${w.slug}`, target = new URL(w.origin);
  const srv = createServer((req, res) => {
    const path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
    const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  return { url: `http://localhost:${srv.address().port}${prefix}`, close: () => new Promise((ok) => srv.close(ok)) };
}
async function joinSouls(w, n, from) {
  const jp = await joinProxy(w, 0), out = [];
  try {
    for (let i = from; i < from + n; i += 3) out.push(...await Promise.all(Array.from({ length: Math.min(3, from + n - i) }, async (_, k) => {
      const j = i + k, dir = join(w.dir, 'souls', `s${j}`); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${w.origin}/eden.mjs`)).arrayBuffer()));
      writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-colocate-${w.form}-${w.id}-${j}` }) + '\n', { mode: 0o600 });
      const reg = await runCli(dir, ['register', jp.url], 60_000); if (reg.code) log(`${w.id} soul ${j} register: ${reg.code} ${scrub(reg.err)}`);
      const token = () => { try { return JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')).token ?? null; } catch { return null; } };
      for (let t = 0; !token() && t < 3; t++) { const r = await runCli(dir, ['create', `Walker${j}`], 150_000); if (!token()) { log(`${w.id} soul ${j} create: ${r.code} ${scrub(r.err)}`); await sleep(2000); } }
      if (!token()) throw new Error(`${w.id} soul ${j} did not join`);
      const s = { token: token(), address: `198.51.100.${j + 1}` }, p = await startPicture(w.origin, s);
      return Object.assign(s, { places: catalogIds(p.catalog).walk });
    })));
  } finally { await jp.close(); }
  return out;
}
/** Each Soul walks to another place every 8 s (strict, keyed acts). → stop() → {sent, ok}. */
function walk(w, souls) {
  let on = true, seq = 0; const n = { sent: 0, ok: 0 };
  const loops = souls.map(async (s, i) => { await sleep(i * 700); while (on && s.places.length) { const t = Date.now(), key = `${w.id}-${seq++}`;
    const r = await clientCall(`${w.origin}/v1/edge/act`, { method: 'POST', headers: clientHeaders(s, { key }), body: actBody(s.places[seq % s.places.length], key), deadlineMs: 30_000 });
    n.sent++; if (r.status >= 200 && r.status < 300 && r.data?.accepted !== false) n.ok++; await sleep(t + 8000 - Date.now()); } });
  return async () => { on = false; await Promise.all(loops); return n; };
}

// ------------------------------------------------------------------ one form, start to end
async function runForm(form) {
  mkdirSync(join(OUT, form), { recursive: true });
  const P = program(form); PROGRAMS.add(P);
  const R = { form, loads: [], memory: {}, ticks: {}, oneMore: [], faults: [] };
  try {
    const W = {};
    for (const [i, [id, kind]] of SIX.entries()) {
      const w = await P.load(await worldSpec(form, id, kind, i)); W[id] = w;
      await sleep(SHORT ? 3000 : 15_000);
      const m = P.mem(); R.loads.push({ id, kind, loadS: w.loadS, pssAfterMb: m?.pssMb ?? null, rssAfterMb: m?.rssMb ?? null, own: P.memOf(w) });
      log(`${form}: ${id} (${kind}) up in ${w.loadS} s; program Pss ${m?.pssMb ?? '—'} MB`);
    }
    const six = Object.values(W), small = six.filter((w) => w.kind === 'small'), eden = six.filter((w) => w.kind === 'eden');
    // quiet: settle, then a tick window of every world, then memory
    await sleep(Math.max(0, SETTLE_S - 60) * 1000);
    R.ticks.quiet = await tickWindow(six, SHORT ? 15_000 : 60_000);
    R.memory.quiet = { total: P.mem(), perWorld: Object.fromEntries(six.map((w) => [w.id, P.memOf(w)])) };
    log(`${form}: quiet Pss ${R.memory.quiet.total?.pssMb ?? '—'} MB; ticks ${JSON.stringify(Object.fromEntries(Object.entries(R.ticks.quiet).map(([k, v]) => [k, v?.p50Ms])))}`);
    const ended = () => (form !== 'baseline' && P.hostExit ? `the program ended (${P.hostExit.code ?? P.hostExit.sig})` : null);
    try {
    // one Soul walking in a small world and in an Eden world
    const [ws, we] = [small[0], eden[0]], sS = await joinSouls(ws, 1, 0), sE = await joinSouls(we, 1, 0);
    const stopA = walk(ws, sS), stopB = walk(we, sE); await sleep(WALK_S * 1000);
    R.memory.walking = { total: P.mem(), perWorld: Object.fromEntries(six.map((w) => [w.id, P.memOf(w)])), walks: { [ws.id]: null, [we.id]: null } };
    // busy: the first Eden world with BUSY walkers; tick time of the others meanwhile
    const more = await joinSouls(we, BUSY - 1, 1), stopC = walk(we, more); await sleep(10_000);
    R.ticks.busy = await tickWindow(six, SHORT ? 15_000 : 60_000);
    R.memory.walking.walks = { [ws.id]: await stopA(), [we.id]: await stopB(), [`${we.id}-busy`]: await stopC() };
    log(`${form}: walking Pss ${R.memory.walking.total?.pssMb ?? '—'} MB; busy ticks ${JSON.stringify(Object.fromEntries(Object.entries(R.ticks.busy).map(([k, v]) => [k, v?.p50Ms])))}`);
    } catch (e) { R.walkError = scrub(ended() ?? e.message ?? e); log(`${form}: walking/busy: ${R.walkError}`); }
    // one more world: time to load, and what the others saw meanwhile
    try {
    for (const [j, [id, kind]] of MORE.entries()) {
      if (ended()) throw new Error(ended());
      const others = [...P.worlds.values()].filter((w) => P.alive(w)), stopWatch = watch(others), m0 = P.mem();
      const w = await P.load(await worldSpec(form, id, kind, SIX.length + j)); const seen = await stopWatch(); await sleep(SHORT ? 3000 : 15_000);
      const m1 = P.mem();
      R.oneMore.push({ id, kind, loadS: w.loadS, othersMaxGapMs: Math.max(...Object.values(seen).map((x) => x.maxGapMs)), othersFailedPolls: Object.values(seen).reduce((s, x) => s + x.fail, 0), pssAddedMb: m0 && m1 ? r1(m1.pssMb - m0.pssMb) : null, pssAfterMb: m1?.pssMb ?? null });
      log(`${form}: one more ${id} (${kind}) up in ${w.loadS} s; others' longest /healthz gap ${R.oneMore.at(-1).othersMaxGapMs} ms`);
    }
    } catch (e) { R.oneMoreError = scrub(e.message ?? e); log(`${form}: one more: ${R.oneMoreError}`); }
    // faults, one world each; a program that ended is started again with two small worlds before the next fault
    let k = 0;
    for (const [fault, target] of [['long', 's2'], ['throw', 's3'], ['alloc', small.length > 3 ? 's4' : 's1']]) {
      let tw = P.worlds.get(target);
      if (!tw || !P.alive(tw) || [...P.worlds.values()].filter((w) => P.alive(w)).length < 3) {
        log(`${form}: restarting for the ${fault} fault`); await P.stop(); P.worlds.clear();
        for (const [j, id] of [`r${k}a`, `r${k}b`, `r${k}c`].entries()) await P.load(await worldSpec(form, id, 'small', j));
        tw = P.worlds.get(`r${k}a`); k++;
      }
      const others = [...P.worlds.values()].filter((w) => w !== tw && P.alive(w)), stopWatch = watch(others), t0 = Date.now();
      writeFileSync(join(tw.data, 'colocate-fault'), fault);
      await sleep(30_000);
      const seen = await stopWatch();
      R.faults.push({ fault, target: tw.id, targetKind: tw.kind, targetEnded: tw.ended ? { afterS: +((tw.ended.at - t0) / 1000).toFixed(1), code: tw.ended.code ?? null, sig: tw.ended.sig ?? null, error: tw.ended.error ? scrub(tw.ended.error) : null } : null,
        programEnded: form !== 'baseline' && P.hostExit ? { afterS: +((P.hostExit.at - t0) / 1000).toFixed(1), code: P.hostExit.code, sig: P.hostExit.sig } : null,
        others: Object.fromEntries(Object.entries(seen).map(([id, x]) => [id, { maxGapMs: x.maxGapMs, failedPolls: x.fail, answeringAtEnd: x.answeringAtEnd }])) });
      log(`${form}: fault ${fault} in ${tw.id}: ${JSON.stringify(R.faults.at(-1))}`);
    }
  } catch (e) { R.error = scrub(e.message ?? e); log(`${form}: ${R.error}`); }
  finally { await P.stop(); PROGRAMS.delete(P); }
  return R;
}

// ------------------------------------------------------------------ run and report
const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const receipt = { issue: 2300, commit, node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1), loadBefore: loadavg().map((x) => +x.toFixed(2)), settleS: SETTLE_S, walkS: WALK_S, busy: BUSY, short: SHORT };
log(`colocate: forms ${FORMS.join(',')}, worlds ${SIX.map(([id, k]) => `${id}:${k}`).join(' ')}, commit ${commit?.slice(0, 9)}`);
const results = [];
for (const form of FORMS) { results.push(await runForm(form)); writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, results }, null, 1) + '\n'); }
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, results }, null, 1) + '\n');
writeFileSync(join(OUT, 'REPORT.md'), report({ receipt, results }));
log('done: REPORT.md');

export function report({ receipt: rc, results: rs }) {
  const f = (x) => (x == null ? '—' : String(x)), mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  const L = [`# Several worlds in one program (#2300)`, '', `commit ${f(rc.commit?.slice(0, 9))} · node ${rc.node} · ${rc.cpus} CPUs · ${rc.memGb} GB · load ${rc.loadBefore.join(' ')} → ${f(rc.loadAfter?.join(' '))} · settle ${rc.settleS} s · walk ${rc.walkS} s · busy ${rc.busy} walkers${rc.short ? ' · SHORT (indicative)' : ''}`, ''];
  L.push('## Memory (Pss, MB)', '', 'Program totals; per world for the baseline is each world program\'s own Pss, for the forms the rise in the program\'s Pss as each world loaded (15 s after its first /healthz).', '',
    '| form | six quiet | six, 1 walker small + 1 Eden | per small (first · next three) | per Eden (first · second) | walking adds |', '|---|---|---|---|---|---|');
  for (const r of rs) {
    if (r.error && !r.memory.quiet) { L.push(`| ${r.form} | error: ${r.error.slice(0, 160)} |||||`); continue; }
    const pss = (id) => r.loads.find((x) => x.id === id), base = r.form === 'baseline';
    const small = base ? [pss('s1')?.own?.pssMb, mean(['s2', 's3', 's4'].map((id) => r.memory.quiet?.perWorld?.[id]?.pssMb))] : [pss('s1')?.pssAfterMb, r1((pss('s4')?.pssAfterMb - pss('s1')?.pssAfterMb) / 3)];
    const eden = base ? [r.memory.quiet?.perWorld?.e1?.pssMb, r.memory.quiet?.perWorld?.e2?.pssMb] : [r1(pss('e1')?.pssAfterMb - pss('s4')?.pssAfterMb), r1(pss('e2')?.pssAfterMb - pss('e1')?.pssAfterMb)];
    L.push(`| ${r.form} | ${f(r.memory.quiet?.total?.pssMb)} | ${f(r.memory.walking?.total?.pssMb)} | ${f(small[0])} · ${f(small[1])} | ${f(eden[0])} · ${f(eden[1])} | ${f(r1(r.memory.walking?.total?.pssMb - r.memory.quiet?.total?.pssMb))} |`);
  }
  L.push('', '## Tick time (ms, p50 / p99 of SOULS_TICK_SPANS total)', '', `| form | small s2 quiet | s2 while e1 busy | Eden e2 quiet | e2 while e1 busy | e1 busy (${rc.busy} walkers) |`, '|---|---|---|---|---|---|');
  const t = (x) => (x ? `${x.p50Ms} / ${x.p99Ms}` : '—');
  for (const r of rs) L.push(`| ${r.form} | ${t(r.ticks.quiet?.s2)} | ${t(r.ticks.busy?.s2)} | ${t(r.ticks.quiet?.e2)} | ${t(r.ticks.busy?.e2)} | ${t(r.ticks.busy?.e1)} |`);
  L.push('', '## One more world', '', '| form | world | load to first /healthz s | others\' longest /healthz gap ms | others\' failed polls | Pss added MB |', '|---|---|---|---|---|---|');
  for (const r of rs) for (const x of r.oneMore) L.push(`| ${r.form} | ${x.id} (${x.kind}) | ${x.loadS} | ${x.othersMaxGapMs} | ${x.othersFailedPolls} | ${f(x.pssAddedMb)} |`);
  L.push('', '## One world fails (30 s watched)', '', '| form | fault | target | target ended | program ended | other worlds: longest /healthz gap ms · failed polls · answering at end |', '|---|---|---|---|---|---|');
  for (const r of rs) for (const x of r.faults) {
    const o = Object.entries(x.others).map(([id, v]) => `${id} ${v.maxGapMs}·${v.failedPolls}·${v.answeringAtEnd ? 'yes' : 'no'}`).join(', ');
    L.push(`| ${r.form} | ${x.fault} | ${x.target} | ${x.targetEnded ? `after ${x.targetEnded.afterS} s (${f(x.targetEnded.code ?? x.targetEnded.sig)}${x.targetEnded.error ? `: ${x.targetEnded.error.slice(0, 60)}` : ''})` : 'no'} | ${x.programEnded ? `after ${x.programEnded.afterS} s (${f(x.programEnded.code ?? x.programEnded.sig)})` : 'no'} | ${o} |`);
  }
  for (const r of rs) for (const k of ['error', 'walkError', 'oneMoreError']) if (r[k]) L.push('', `${r.form} ${k === 'error' ? 'stopped early' : k === 'walkError' ? 'walking and busy phase' : 'one more world'}: ${r[k]}`);
  return L.join('\n') + '\n';
}
