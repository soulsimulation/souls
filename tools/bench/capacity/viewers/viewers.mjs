#!/usr/bin/env node
// #2308: what 1, 50 and 200 (up to 2,000) viewers cost one world with Souls walking. One local Eden 2026 world (genesis from the
// template) behind the checkout's own launcher, fake minds, Eyes off, an isolated data dir under --out. 12 Souls join
// with the world's own CLI (up to 100), then walk by catalog id (raw HTTP, the client's headers; one act every --act-sec
// seconds from the start of the last, or without it 6–10 s after the last answer). Viewers are what the web page's entry
// opens (apps/web/src/snapshot-prefetch.ts), no browser: GET of the world page, GET /v1/world/snapshot?defs=ref&cols=1,
// GET /v1/config, a GET of each part the snapshot names (x-defs-ref, x-ground-ref), and the world's WebSocket with the
// anonymous hello in its URL, held open and reopened after a close with the product client's own backoff
// (reconnectDelayMs). Each viewer sends its own X-Forwarded-For.
// #2511: viewers arrive at --arrive-per-sec (default 20) for as long as the arm's count is not held; with --dwell-sec each
// leaves after a heavy-tailed stay (log-normal, that median), so arrivals continue through the window to hold the count;
// --arrive-burst n@s adds n more within 5 s, s seconds into each window with viewers (they leave by their own stay, or at
// the window's end). `--viewers 0` is the zero-viewer arm. On at most 50 newcomers at a time the driver reads the head of
// each message until the first take with a chunk (first motion), and never otherwise parses a message.
// Per repeat one world: Souls join, warm up, then the arms in rising order (viewers arrive to reach each count, settle,
// then a measuring window). Per window: tick time and service, the act's queue and handler time (its Server-Timing),
// the load levels and the seconds at amber per signal (live.json), the world's CPU share, resident memory and main-thread
// heap, the bytes the viewers received, the world calls the viewers caused (answers not from the launcher's micro-cache),
// the viewers held, joins, leaves and reconnects, first motion (p50 / p95), and acts achieved against intended.
// #2512: the viewers are held by --drivers child processes (driver.mjs, default 1), each a share, so the bench reaches
// 10,000 without one process being the limit. A viewer's socket is a raw one: the upgrade with compression offered, then
// frame headers only (frames, messages, payload bytes as sent, compressed; never inflated). One viewer in a hundred (the
// first, then every hundredth) is the product client's own Connection, which inflates and keeps a replica: first motion
// (on at most 50 waiting at once per driver), its bytes inflated, resyncs and failed view-hash checks come from those.
// --slow-readers n: n more raw sockets join at each window's midpoint, read for 5 s and then stop reading; the world's
// and the launcher's memory before and after, per slow reader. --restart-at s: s seconds into the first window with
// viewers the world process is sent SIGTERM (the launcher restarts it); the reconnect table: viewers back within 30 s,
// where they landed (the upgrade's x-sim-served-by, else the world), the world's healthz, tick and memory through it.
// --stub: no world and no launcher; the drivers against stub.mjs, which sends each socket --stub-kb kB/s (default 50), for
// the drivers' own CPU (A4). The open-file limit and the local port range are checked at the start and fail plainly.
// Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `viewers`) on a souls-timed runner.
//
//   node tools/bench/capacity/viewers/viewers.mjs [--viewers 0,50,200] [--souls 12] [--act-sec 10] [--arrive-per-sec 20]
//        [--arrive-burst 300@40] [--dwell-sec 60] [--repeats 2] [--window-sec 120] [--out <dir>] [--port 4800]
//        [--drivers 1] [--slow-readers 50] [--restart-at 40] [--stub] [--stub-kb 50] [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, viewers.log} and <out>/r<k>/{launcher.log, world.log, stall-*.json, souls/}
// (souls/ holds tokens; stays local).
import { spawn, fork, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowFigures, serverTiming, seeded, stayMs, parseBurst, slowFigures, restartTable, limitProblems } from './stats.mjs';
import { actBody, catalogIds, clientHeaders, startPicture } from '../meetup/client-soul.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4800)), BASE = `http://127.0.0.1:${PORT}`, SLUG = 'viewers-eden', TEMPLATE = 'eden-2026';
const ARMS = opt('viewers', '1,50,200').split(',').map(Number).sort((a, b) => a - b), SOULS = Number(opt('souls', 12)), REPEATS = Number(opt('repeats', 2));
const WINDOW_MS = Number(opt('window-sec', SHORT ? 30 : 120)) * 1000, WARM_MS = SHORT ? 15_000 : 60_000, SETTLE_MS = SHORT ? 10_000 : 20_000, SAMPLE_MS = 2000;
const ACT_SEC = opt('act-sec') == null ? null : Number(opt('act-sec')), ARRIVE_PER_S = Number(opt('arrive-per-sec', 20)), BURST = parseBurst(opt('arrive-burst'));
const DWELL_S = opt('dwell-sec') == null ? null : Number(opt('dwell-sec')), MOTION_SAMPLED = 50;
const DRIVERS = Number(opt('drivers', 1)), SLOW = Number(opt('slow-readers', 0)), RESTART_AT = opt('restart-at') == null ? null : Number(opt('restart-at')), STUB = flag('stub'), STUB_KB = Number(opt('stub-kb', 50));
for (const [k, v, ok] of [['viewers', ARMS.join(','), ARMS.every((n) => Number.isInteger(n) && n >= 0 && n <= 10_000)], ['souls', SOULS, Number.isInteger(SOULS) && SOULS >= 1 && SOULS <= 100], ['act-sec', ACT_SEC, ACT_SEC == null || ACT_SEC > 0],
  ['arrive-per-sec', ARRIVE_PER_S, ARRIVE_PER_S > 0], ['dwell-sec', DWELL_S, DWELL_S == null || DWELL_S > 0], ['drivers', DRIVERS, Number.isInteger(DRIVERS) && DRIVERS >= 1 && DRIVERS <= 16],
  ['slow-readers', SLOW, Number.isInteger(SLOW) && SLOW >= 0], ['restart-at', RESTART_AT, RESTART_AT == null || (RESTART_AT > 0 && RESTART_AT + 30 <= WINDOW_MS / 1000 && !STUB)],
  ['stub-kb', STUB_KB, STUB_KB > 0]]) if (!ok) throw new Error(`--${k} ${v}: not a valid value${k === 'restart-at' ? ' (it needs 30 s of the window after it, and a world)' : ''}`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/viewers', new Date().toISOString().replace(/[:.]/g, '-'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const clean = (t) => String(t).split(ROOT).join('.');
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'viewers.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
if (!STUB) for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);
const { anonymousHello } = await import(pathToFileURL(join(ROOT, 'packages/client/src/hello.ts')).href);
const HELLO = anonymousHello(true);
// #2512: every socket the arms need, against the descriptor limit and the local port range, before anything starts
const FD_LIMIT = Number(sh('sh', ['-c', 'ulimit -n'])), PORT_RANGE = (() => { try { return readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number); } catch { return null; } })();
const PEAK = Math.max(...ARMS) + (BURST?.n ?? 0) + SLOW, LIMITS = limitProblems({ viewers: PEAK, drivers: DRIVERS, fdLimit: FD_LIMIT, portRange: PORT_RANGE, launcher: !STUB });
if (LIMITS.length) throw new Error(LIMITS.join('; '));
// a documentation address per viewer (RFC 5737), so the launcher's per-address ceilings see distinct visitors; past 750
// viewers, the first half of the benchmarking range (RFC 2544, 198.18.0.0/16). Each arrival takes the next index, so a
// viewer who comes after another left is a new visitor. #2511: the Souls take the other half (198.19.0.0/16), one address
// each, so they never share one with a viewer or each other (they were 192.0.2.200 + i: past 55 Souls no address, and the
// viewers' 192.0.2.x from the 700th on)
const addressOf = (i) => (i < 750 ? `${['198.51.100', '203.0.113', '192.0.2'][Math.floor(i / 250)]}.${(i % 250) + 1}` : `198.18.${Math.floor((i - 750) / 250)}.${((i - 750) % 250) + 1}`);
const soulAddressOf = (i) => `198.19.${Math.floor(i / 250)}.${(i % 250) + 1}`;

// ------------------------------------------------------------------ the world's process
const CLK_TCK = Number(sh('getconf', ['CLK_TCK']) ?? 100) || 100;
function proc(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '), rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return { cpuS: (Number(st[11]) + Number(st[12])) / CLK_TCK, rssMb: rss ? Number(rss[1]) / 1024 : null };
  } catch { const r = sh('ps', ['-o', 'rss=', '-p', String(pid)]); return { cpuS: null, rssMb: r ? Number(r) / 1024 : null }; }
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
async function getJ(url, ms = 5000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null) }; } catch { return { status: 0, j: null }; } }

async function bootLauncher(dir, run) {
  if ((await getJ(`${BASE}/__sim/healthz`, 2000)).status !== 0) throw new Error(`port ${PORT} is already serving`);
  const ldata = join(dir, 'launcher'); mkdirSync(ldata, { recursive: true });
  writeFileSync(join(ldata, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', worlds: [{ slug: SLUG, name: 'Viewers bench', template: TEMPLATE, port: null, createdAt: 0, unlisted: true }] }, null, 2) + '\n');
  const env = { ...process.env, SIM_UNWATCHED_PACE: '1', SIM_WORLD_IDLE_EXIT_MIN: '0', SIM_PREWARM: '0' };
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES') || /KEY|TOKEN|SECRET/.test(k)) delete env[k];
  const args = [join(ROOT, 'tools/world-launcher/launcher.mjs'), '--port', String(PORT), '--data', ldata, '--range', `${PORT + 1}-${PORT + 2}`, '--public-origin', `http://localhost:${PORT}`,
    '--mars-web', MARS_WEB, '--eager', '1', '--max-running', '1', '--sleep-ms', '0'];
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.launcher = { child, ldata };
  for (const s of [child.stdout, child.stderr]) s.on('data', (b) => appendFileSync(join(dir, 'launcher.log'), b));
  const t0 = Date.now();
  while (!(await getJ(`${BASE}/w/${SLUG}/healthz`, 3000)).j?.ok) {
    if (child.exitCode != null) throw new Error(`launcher exited at boot (${child.exitCode}); see launcher.log`);
    if (Date.now() - t0 > 900_000) throw new Error('world not up after 15 min');
    await sleep(1000);
  }
  run.launcher.bootS = Math.round((Date.now() - t0) / 1000);
  run.launcher.worldPid = () => readJson(join(ldata, 'children.json'))?.[SLUG]?.pid ?? null;
  run.launcher.live = () => readJson(join(ldata, 'worlds', SLUG, 'live.json'));
}
/** #2512 --stub: the stub in place of the launcher and the world (stub.mjs); its process is sampled as the world's. */
async function bootStub(dir, run) {
  if ((await getJ(`${BASE}/w/${SLUG}/healthz`, 2000)).status !== 0) throw new Error(`port ${PORT} is already serving`);
  const child = spawn(process.execPath, [join(ROOT, 'tools/bench/capacity/viewers/stub.mjs'), '--port', String(PORT), '--kb', String(STUB_KB)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [child.stdout, child.stderr]) s.on('data', (b) => appendFileSync(join(dir, 'launcher.log'), b));
  const t0 = Date.now();
  while (!(await getJ(`${BASE}/w/${SLUG}/healthz`, 2000)).j?.ok) { if (child.exitCode != null || Date.now() - t0 > 30_000) throw new Error('the stub did not start'); await sleep(200); }
  run.launcher = { child, stub: true, bootS: Math.round((Date.now() - t0) / 1000), worldPid: () => child.pid, live: () => null };
}
/** #2512: the driver processes, each told the world's port and socket path; their reports keep `d.last` current. */
async function startDrivers(run) {
  run.drivers = await Promise.all(Array.from({ length: DRIVERS }, (_, j) => new Promise((ready, fail) => {
    const child = fork(join(ROOT, 'tools/bench/capacity/viewers/driver.mjs'), [], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const d = { j, child, last: null, restart: null };
    for (const s of [child.stdout, child.stderr]) s.on('data', (b) => appendFileSync(join(run.dir, 'drivers.log'), `[d${j}] ${b}`));
    child.on('message', (m) => {
      if (m.op === 'ready') ready(d);
      else if (m.op === 'stats') { d.last = m; run.calls.push(...m.calls); run.motion.push(...m.motion); }
      else if (m.op === 'restart') d.restart?.(m.rows);
    });
    child.on('exit', (code) => { if (!run.stopped) log(`r${run.k}: driver ${j} exited (${code})`); fail(new Error(`driver ${j} exited at start`)); });
    child.send({ op: 'init', root: ROOT, port: PORT, base: BASE, slug: SLUG, stub: STUB, wsPath: `/w/${SLUG}/ws?hello=${encodeURIComponent(HELLO)}` });
  })));
}
const send = (run, d, m) => { try { d.child.send(m); } catch { /* exited */ } };
/** The viewers' counters, summed over the drivers' last reports (running totals). */
function totals(run) {
  const t = { bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0, joins: 0, leaves: 0, reconnects: 0, fullBytes: 0, fullMessages: 0, resyncs: 0, heartbeats: 0, mismatches: 0, slowCut: 0 };
  for (const d of run.drivers ?? []) for (const k of Object.keys(t)) t[k] += d.last?.counters?.[k] ?? 0;
  return t;
}
async function stopAll(run) {
  run.stopped = true;
  for (const v of run.viewers) clearTimeout(v.leaveTimer);
  for (const a of run.aborts) try { a.abort(); } catch { /* done */ }
  for (const d of run.drivers ?? []) send(run, d, { op: 'stop' });
  await sleep(1000);
  for (const d of run.drivers ?? []) if (d.child.exitCode == null) try { d.child.kill('SIGKILL'); } catch { /* gone */ }
  const L = run.launcher; if (!L) return;
  if (L.stub) { try { L.child.kill('SIGTERM'); } catch { /* gone */ } return; }
  const pid = L.worldPid?.();
  try { L.child.kill('SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 60 && L.child.exitCode == null; i++) await sleep(500);
  for (const p of [pid, L.child.exitCode == null ? L.child.pid : null]) if (p) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  // #2511: the world's own log and any main-thread stall stacks (stall-<at>.json, stall-stack.ts) go with the run
  try { copyFileSync(join(L.ldata, 'logs', `${SLUG}.log`), join(run.dir, 'world.log')); } catch { /* no log */ }
  try { for (const x of readdirSync(join(L.ldata, 'worlds', SLUG))) if (/^stall-\d+\.json$/.test(x)) copyFileSync(join(L.ldata, 'worlds', SLUG, x), join(run.dir, x)); } catch { /* none */ }
}

// ------------------------------------------------------------------ Souls: join with the world's CLI, then walk over raw HTTP
function runCli(dir, args, ms) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-500); }); p.stdout.resume();
    const k = setTimeout(() => p.kill('SIGKILL'), ms); p.on('exit', (code) => { clearTimeout(k); done({ code, err: clean(err.trim().split('\n').at(-1) ?? '') }); });
  });
}
async function joinSoul(run, i) {
  const dir = join(run.dir, 'souls', `s${i}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${BASE}/w/${SLUG}/eden.mjs`)).arrayBuffer()));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-viewers-${run.k}-${i}` }) + '\n', { mode: 0o600 });
  const reg = await runCli(dir, ['register', `http://localhost:${PORT}/w/${SLUG}`], 60_000); if (reg.code) log(`soul ${i} register: ${reg.code} ${reg.err}`);
  const token = () => readJson(join(dir, '.eden-agent.json'))?.token ?? null;
  for (let t = 0; !token() && t < 4; t++) { const r = await runCli(dir, ['create', `Walker${i}`], 150_000); if (!token()) { log(`soul ${i} create: ${r.code} ${r.err}`); await sleep(2000); } }
  if (!token()) throw new Error(`soul ${i} did not join`);
  return { i, token: token(), address: soulAddressOf(i) };
}
function walk(run, s, walks) {
  (async () => {
    let k = s.i;
    // --act-sec: the Souls start spread over one period, then each acts every period from the start of its last act (an
    // act that takes longer than that is followed at once, so achieved against intended shows a world that falls behind)
    if (ACT_SEC) await sleep((ACT_SEC * 1000 * s.i) / SOULS);
    while (!run.stopped) {
      const id = walks[k++ % walks.length], key = `v${run.k}-s${s.i}-${k}`, ac = new AbortController(); run.aborts.add(ac);
      const t = performance.now(), rec = { at: Date.now(), capability: id };
      try {
        const r = await fetch(`${BASE}/w/${SLUG}/v1/edge/act`, { method: 'POST', headers: clientHeaders(s, { key }), body: JSON.stringify(actBody(id, key)), signal: AbortSignal.any([ac.signal, AbortSignal.timeout(40_000)]) });
        const d = await r.json().catch(() => null), st = serverTiming(r.headers.get('server-timing'));
        Object.assign(rec, { status: r.status, accepted: d?.accepted, code: d?.error?.code ?? d?.code ?? null, queueMs: st.queue, worldMs: st.world, handlerMs: st.handler, waitMs: st.wait, clientMs: performance.now() - t, load: r.headers.get('x-sim-load') });
      } catch { rec.status = 0; rec.clientMs = performance.now() - t; }
      finally { run.aborts.delete(ac); }
      if (run.stopped) break;
      run.acts.push(rec);
      await sleep(ACT_SEC ? ACT_SEC * 1000 - (performance.now() - t) : 6000 + Math.random() * 4000);
    }
  })();
}

// ------------------------------------------------------------------ viewers: held by the drivers (driver.mjs)
/** A viewer arrives: the next index (its own address), one in a hundred a full client, on driver index mod --drivers. */
function addViewer(run, burst, slow = false) {
  const id = run.viewers.length, v = { id, address: addressOf(id), burst, slow, full: !STUB && !slow && id % 100 === 0, d: run.drivers[id % run.drivers.length] };
  run.viewers.push(v);
  if (!slow) { (burst ? run.burst : run.base).add(v); if (v.full) run.full.add(v); }
  send(run, v.d, { op: 'add', id, address: v.address, full: v.full, slow });
  if (DWELL_S && !slow) v.leaveTimer = setTimeout(() => leave(run, v), stayMs(DWELL_S, run.rand));
  return v;
}
/** A viewer goes away for good: its socket closes and is never reopened (one who leaves before its first motion is left
 *  out of first motion, not counted as a miss). */
function leave(run, v) {
  if (v.left) return;
  v.left = true; (v.burst ? run.burst : run.base).delete(v); run.full.delete(v);
  clearTimeout(v.leaveTimer);
  send(run, v.d, { op: 'leave', ids: [v.id] });
}
/** Arrivals at --arrive-per-sec whenever fewer than the arm's count are present (so with stays they continue all window). */
function arrivals(run) {
  (async () => {
    const gap = 1000 / ARRIVE_PER_S; let next = performance.now();
    while (!run.stopped) {
      if (run.base.size < run.target) { addViewer(run, false); next += gap; await sleep(next - performance.now()); }
      else { await sleep(Math.min(gap, 50)); next = performance.now(); }
    }
  })();
}
/** #2512 --restart-at: SIGTERM to the world process (the launcher restarts it), the drivers marked just before; its
 *  healthz read every second until `until`. Returns the table's inputs once `until` has passed. */
async function restartWorld(run, until) {
  const pid = run.launcher.worldPid(), at = Date.now(), health = [];
  for (const d of run.drivers) send(run, d, { op: 'mark', at });
  if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  log(`r${run.k}: world restarted (SIGTERM) with ${run.base.size + run.burst.size} viewers`);
  while (Date.now() < until && !run.stopped) {
    const t = Date.now(), h = await getJ(`${BASE}/w/${SLUG}/healthz`, 900);
    health.push({ at: t, ok: h.j?.ok === true, tick: h.j?.tick ?? null, clients: h.j?.clients ?? null });
    await sleep(1000 - (Date.now() - t));
  }
  const rows = (await Promise.all(run.drivers.map((d) => new Promise((done) => { d.restart = done; send(run, d, { op: 'restart' }); setTimeout(() => done([]), 5000); })))).flat();
  return restartTable({ rows, at, health, samples: run.samples });
}

// ------------------------------------------------------------------ one repeat
async function repeat(k) {
  const dir = join(OUT, `r${k}`); mkdirSync(dir, { recursive: true });
  const run = { k, dir, stopped: false, aborts: new Set(), viewers: [], acts: [], calls: [], samples: [], drivers: [],
    target: 0, base: new Set(), burst: new Set(), full: new Set(), motion: [], rand: seeded(2511 + k), restarted: false };
  const out = { repeat: k, windows: [] };
  let sampler;
  try {
    if (STUB) await bootStub(dir, run); else await bootLauncher(dir, run);
    out.bootS = run.launcher.bootS; log(`r${k}: ${STUB ? 'stub' : 'world'} up in ${out.bootS} s`);
    await startDrivers(run);
    // the launcher (every viewer's socket passes through it), the drivers and this process are sampled too, so a saturated
    // proxy or driver is told apart from a saturated world
    sampler = setInterval(() => {
      const pid = run.launcher.worldPid(), l = STUB ? {} : proc(run.launcher.child.pid), b = process.cpuUsage(), live = run.base.size + run.burst.size;
      const dCpu = run.drivers.reduce((s, d) => s + (d.last?.cpuS ?? 0), 0), dRss = run.drivers.reduce((s, d) => s + (d.last?.rssMb ?? 0), 0);
      run.samples.push({ at: Date.now(), live: run.launcher.live(), ...(pid ? { pid, ...proc(pid) } : {}), launcherCpuS: l.cpuS, launcherRssMb: l.rssMb, driverCpuS: dCpu, driverRssMb: dRss, benchCpuS: (b.user + b.system) / 1e6,
        viewersLive: live, rawLive: live - run.full.size, fullLive: run.full.size });
    }, SAMPLE_MS);
    if (!STUB) {
      const souls = [];
      for (let i = 0; i < SOULS; i += 4) souls.push(...await Promise.all(Array.from({ length: Math.min(4, SOULS - i) }, (_, j) => joinSoul(run, i + j))));
      // the catalog may answer 503 while the world settles after the joins: ask again for up to 5 min
      let pic; for (const t0 = Date.now(); !(pic = await startPicture(`${BASE}/w/${SLUG}`, souls[0])).catalog && Date.now() - t0 < 300_000;) { log(`r${k}: catalog ${pic.catalogStatus}; asking again`); await sleep(10_000); }
      const walks = catalogIds(pic.catalog).walk;
      if (!walks.length) throw new Error(`no walk ids in the catalog (catalog ${pic.catalogStatus})`);
      out.walkPlaces = walks.length; log(`r${k}: ${souls.length} Souls joined; ${walks.length} places to walk to`);
      for (const s of souls) walk(run, s, walks);
      await sleep(WARM_MS);
    }
    arrivals(run);
    for (const n of ARMS) {
      const opening = Date.now(), calls0 = run.calls.length;
      // the arm's count is reached at the arrival rate (with stays, it is then held by arrivals that continue)
      run.target = n;
      for (const t0 = Date.now(); run.base.size < n && Date.now() - t0 < 60_000 + (3000 * n) / ARRIVE_PER_S;) await sleep(100);
      const reachedS = Math.round((Date.now() - opening) / 1000);
      await sleep(SETTLE_MS);
      const from = Date.now(), v0 = totals(run), mid = from + WINDOW_MS / 2;
      // --arrive-burst n@s: a link was just posted; n more within 5 s, s seconds into the window
      let wave = null, slowAt = null, restart = null;
      if (BURST && n > 0) wave = setTimeout(() => { for (let j = 0; j < BURST.n; j++) setTimeout(() => { if (!run.stopped && wave) addViewer(run, true); }, (5000 * j) / BURST.n); }, BURST.atS * 1000);
      // --slow-readers: they join at the window's midpoint and stay to its end
      const slow = [], slowTimer = SLOW && n > 0 ? setTimeout(() => { slowAt = totals(run).slowCut; for (let j = 0; j < SLOW; j++) slow.push(addViewer(run, false, true)); }, WINDOW_MS / 2) : null;
      // --restart-at: once, in the first window with viewers
      if (RESTART_AT && n > 0 && !run.restarted) { run.restarted = true; restart = sleep(RESTART_AT * 1000).then(() => restartWorld(run, from + WINDOW_MS)); }
      await sleep(WINDOW_MS);
      const to = Date.now(), v1 = totals(run);
      clearTimeout(wave); wave = null; clearTimeout(slowTimer);
      for (const v of [...run.burst, ...slow]) leave(run, v);
      const waiting = run.drivers.flatMap((d) => d.last?.waiting ?? []);
      const w = windowFigures({ samples: run.samples, acts: run.acts, v0, v1, viewers: n, calls: run.calls.slice(calls0), from, to,
        motion: run.motion, waiting, motionFrom: opening, souls: STUB ? null : SOULS, actSec: ACT_SEC });
      w.openingS = Math.round((from - opening) / 1000); w.reachedS = reachedS; w.callsByPath = {};
      for (const c of run.calls.slice(calls0)) { const p = (w.callsByPath[c.path] ??= { n: 0, world: 0 }); p.n++; if (c.status && c.cache !== 'hit' && c.cache !== 'shared') p.world++; }
      // the full clients (the product's Connection): what they received inflated, their resyncs and failed hash checks
      const fl = run.samples.filter((s) => s.at >= from && s.at <= to).map((s) => s.fullLive), fullHeld = fl.length ? fl.reduce((a, b) => a + b, 0) / fl.length : 0, secs = (to - from) / 1000;
      w.full = { held: Math.round(10 * fullHeld) / 10, inflatedBytesPerViewerPerS: fullHeld ? Math.round((v1.fullBytes - v0.fullBytes) / fullHeld / secs) : null, resyncs: v1.resyncs - v0.resyncs, hashMismatches: v1.mismatches - v0.mismatches, heartbeats: v1.heartbeats - v0.heartbeats };
      w.driver.processes = DRIVERS; w.driver.cpus = availableParallelism();
      w.driver.shareOfCpus = w.driver.cpuShare == null ? null : Math.round((1000 * w.driver.cpuShare) / w.driver.cpus) / 1000;
      if (slowAt != null) w.slow = slowFigures({ samples: run.samples, from, mid, to, n: slow.length, cut: v1.slowCut - slowAt });
      if (restart) w.restart = await restart;
      out.windows.push(w);
      log(`r${k} n${n}: tick p50/p99 ${w.tickMs.p50}/${w.tickMs.p99} ms, service ${w.tickService.mean}, act queue p50/p95 ${w.acts.queueMs.p50}/${w.acts.queueMs.p95} ms, amber ${w.levels.amber}, cpu ${w.world.cpuShare}, rss ${w.world.rssMb} MB, heap ${w.world.heapUsedMb} MB, launcher cpu ${w.launcher.cpuShare}, drivers cpu ${w.driver.cpuShare} (${w.driver.shareOfCpus} of ${w.driver.cpus} CPUs), bench cpu ${w.bench.cpuShare}, ${w.viewersOut.bytesPerViewerPerS} B/s per viewer, held ${w.held.min}-${w.held.max}, joins/leaves ${w.churn.joinsPerS}/${w.churn.leavesPerS} per s, reconnects ${w.churn.reconnects}, first motion p50/p95 ${w.firstMotion.p50S}/${w.firstMotion.p95S} s (${w.firstMotion.n} seen, ${w.firstMotion.missed} missed), full ${w.full.held} (${w.full.inflatedBytesPerViewerPerS} B/s inflated, resyncs ${w.full.resyncs}, mismatches ${w.full.hashMismatches}), acts ${w.actsAchieved.ok} of ${w.actsAchieved.intended}`);
      if (w.slow) log(`r${k} n${n}: ${w.slow.n} slow readers (cut ${w.slow.cut}): world rss ${w.slow.worldRss.beforeMb} → ${w.slow.worldRss.peakMb} MB (${w.slow.worldRss.perReaderKb} kB each), heap ${w.slow.worldHeap.beforeMb} → ${w.slow.worldHeap.peakMb} MB, launcher rss ${w.slow.launcherRss.beforeMb} → ${w.slow.launcherRss.peakMb} MB`);
      if (w.restart) log(`r${k} n${n}: restart: ${w.restart.backWithin} of ${w.restart.dropped} dropped back within 30 s (p50/p95 ${w.restart.backS.p50}/${w.restart.backS.p95} s), never back ${w.restart.neverBack}, held through ${w.restart.heldThrough}, landed ${JSON.stringify(w.restart.landed)}, world down ${w.restart.world.downS} s, tick ${w.restart.world.tickBefore} → ${w.restart.world.tickAfter}, rss ${w.restart.world.rssBeforeMb} → ${w.restart.world.rssEndMb} MB`);
    }
  } catch (e) { out.error = clean(e.message ?? e); log(`r${k}: ${out.error}`); }
  finally { clearInterval(sampler); await stopAll(run); }
  return out;
}

const receipt = { issue: [2308, 2511, 2512], commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), node: process.version, platform: process.platform, cpus: cpus().length, ownCpus: availableParallelism(), memGb: +(totalmem() / 2 ** 30).toFixed(1),
  loadBefore: loadavg().map((x) => +x.toFixed(2)), arms: ARMS, souls: STUB ? 0 : SOULS, actSec: ACT_SEC, arrivePerSec: ARRIVE_PER_S, burst: BURST, dwellSec: DWELL_S, motionSampled: MOTION_SAMPLED,
  drivers: DRIVERS, slowReaders: SLOW, restartAtS: RESTART_AT, stub: STUB ? { kbPerViewerPerS: STUB_KB } : null, fdLimit: Number.isFinite(FD_LIMIT) ? FD_LIMIT : null, portRange: PORT_RANGE,
  windowS: WINDOW_MS / 1000, warmS: WARM_MS / 1000, settleS: SETTLE_MS / 1000, short: SHORT, template: STUB ? null : TEMPLATE };
const setting = `${STUB ? `stub (${STUB_KB} kB/s per viewer), no world` : `${SOULS} Souls ${ACT_SEC ? `acting every ${ACT_SEC} s` : 'walking (6–10 s apart)'}`} · ${DRIVERS} driver${DRIVERS > 1 ? 's' : ''} · arrivals ${ARRIVE_PER_S}/s${BURST ? ` · burst ${BURST.n} at ${BURST.atS} s` : ''}${DWELL_S ? ` · stays median ${DWELL_S} s` : ' · viewers stay'}${SLOW ? ` · ${SLOW} slow readers at mid-window` : ''}${RESTART_AT ? ` · world restart at ${RESTART_AT} s` : ''}`;
log(`viewers: arms ${ARMS.join(',')}, ${setting}, ${REPEATS} repeats, commit ${receipt.commit?.slice(0, 9)}`);
const repeats = [];
for (let k = 1; k <= REPEATS; k++) repeats.push(await repeat(k));
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, repeats }, null, 1) + '\n');
const f = (x) => (x == null ? '—' : String(x)), obj = (o) => Object.entries(o ?? {}).map(([a, b]) => `${a} ${b}`).join(', ') || '0';
const rows = repeats.flatMap((r) => (r.error && !r.windows.length ? [`| r${r.repeat} | error: ${r.error.slice(0, 120)} |`] : r.windows.map((w) => `| r${r.repeat} | ${w.viewers} | ${f(w.tickMs.p50)} / ${f(w.tickMs.p99)} | ${f(w.tickService.mean)} (min ${f(w.tickService.min)}) | ${f(w.acts.queueMs.p50)} / ${f(w.acts.queueMs.p95)} | ${f(w.acts.handlerMs.p50)} / ${f(w.acts.handlerMs.p99)} | ${f(w.levels.amber)} | ${obj(w.amberS)} | ${w.world.restarted ? 'restarted' : f(w.world.cpuShare)} | ${f(w.world.rssMb)} | ${f(w.launcher.cpuShare)} / ${f(w.launcher.rssMb)} | ${f(w.driver.cpuShare)} (${f(w.driver.shareOfCpus)} of ${w.driver.cpus}) | ${f(w.viewersOut.bytesPerViewerPerS)} | ${f(w.full.inflatedBytesPerViewerPerS)} (${w.full.held}) | ${w.full.resyncs} / ${w.full.hashMismatches} of ${w.full.heartbeats} | ${w.viewerCalls.worldCalls} of ${w.viewerCalls.http} | acts ${obj(w.acts.refused)}; viewers ${obj(w.viewerCalls.refusals)}; ws refused ${w.viewersOut.wsRefused}, closed ${w.viewersOut.wsCloses} | ${w.held.min}–${w.held.max} | ${f(w.churn.joinsPerS)} / ${f(w.churn.leavesPerS)} | ${w.churn.reconnects} | ${f(w.firstMotion.p50S)} / ${f(w.firstMotion.p95S)} (${w.firstMotion.n}, missed ${w.firstMotion.missed}) | ${f(w.world.heapUsedMb)} (max ${f(w.heapMaxMb)}) | ${w.actsAchieved.ok} of ${f(w.actsAchieved.intended)}${w.actsAchieved.share == null ? '' : ` (${w.actsAchieved.share})`} |`)));
const all = repeats.flatMap((r) => r.windows.map((w) => ({ r: r.repeat, w })));
const slowRows = all.filter((x) => x.w.slow).map(({ r, w: { viewers, slow: s } }) => `| r${r} | ${viewers} | ${s.n} | ${s.cut} | ${f(s.worldRss.beforeMb)} → ${f(s.worldRss.peakMb)} (${f(s.worldRss.perReaderKb)}) | ${f(s.worldHeap.beforeMb)} → ${f(s.worldHeap.peakMb)} (${f(s.worldHeap.perReaderKb)}) | ${f(s.launcherRss.beforeMb)} → ${f(s.launcherRss.peakMb)} (${f(s.launcherRss.perReaderKb)}) |`);
const restartRows = all.filter((x) => x.w.restart).map(({ r, w: { viewers, restart: t } }) => `| r${r} | ${viewers} | ${t.viewers} | ${t.dropped} | ${t.backWithin} | ${t.backLater} | ${t.neverBack} | ${f(t.backS.p50)} / ${f(t.backS.p95)} | ${obj(t.landed)} | ${f(t.world.downS)} | ${f(t.world.tickBefore)} → ${f(t.world.tickAfter)} | ${f(t.world.rssBeforeMb)} → ${f(t.world.rssEndMb)} | ${f(t.world.heapBeforeMb)} → ${f(t.world.heapEndMb)} |`);
writeFileSync(join(OUT, 'REPORT.md'), [`# Viewers on one world (#2308, #2511, #2512)`, '', `commit ${f(receipt.commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs (${receipt.ownCpus} own) · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${setting} · ${receipt.windowS} s windows${SHORT ? ' · SHORT (indicative)' : ''}`, '',
  `Bytes/s per viewer: what the raw viewers' sockets carried (message payloads as sent, compressed) and their entry answers, per raw viewer. The full clients (one viewer in a hundred, the product's Connection) give first motion (seconds from a newcomer's first socket to its first take with a chunk, at most ${MOTION_SAMPLED} waiting at once per driver; waiting 5 s at the window's end is a miss), what they received inflated, and resyncs / failed view-hash checks of the heartbeats checked. Driver CPU: all driver processes together, and that over the CPUs they may use.`, '',
  '| repeat | viewers | tick p50 / p99 ms | tick service | act queue p50 / p95 ms | act handler p50 / p99 ms | amber share | amber s per signal | world CPU (cores) | RSS MB | launcher CPU (cores) / RSS MB | driver CPU (cores; share of CPUs) | bytes/s per viewer | full clients: inflated bytes/s each (held) | full: resyncs / hash mismatches of heartbeats | world calls by viewers | refusals | viewers held | joins / leaves per s | reconnects | first motion p50 / p95 s (seen, missed) | main heap MB | acts achieved of intended |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows,
  ...(slowRows.length ? ['', '## Slow readers', '', 'They join at the window\'s midpoint, read for 5 s and stop reading. Mean before they join → peak after, MB (kB per slow reader).', '',
    '| repeat | viewers | slow readers | cut by the server | world RSS | world main heap | launcher RSS |', '|---|---|---|---|---|---|---|', ...slowRows] : []),
  ...(restartRows.length ? ['', '## World restart', '', `SIGTERM to the world process ${RESTART_AT} s into the window; the launcher restarts it. Back: a new socket received its first message. Landed: where the upgrade was answered (the x-sim-served-by header, else the world).`, '',
    '| repeat | viewers | present | dropped | back within 30 s | back later | never back | back p50 / p95 s | landed | world down s | tick before → after | world RSS MB | main heap MB |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...restartRows] : [])].join('\n') + '\n');
log('done: REPORT.md');
if (repeats.some((r) => r.error)) process.exitCode = 1;
