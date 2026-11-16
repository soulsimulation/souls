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
// Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `viewers`) on a souls-timed runner.
//
//   node tools/bench/capacity/viewers/viewers.mjs [--viewers 0,50,200] [--souls 12] [--act-sec 10] [--arrive-per-sec 20]
//        [--arrive-burst 300@40] [--dwell-sec 60] [--repeats 2] [--window-sec 120] [--out <dir>] [--port 4800]
//        [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, viewers.log} and <out>/r<k>/{launcher.log, world.log, stall-*.json, souls/}
// (souls/ holds tokens; stays local).
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowFigures, serverTiming, reconnectDelayMs, seeded, stayMs, parseBurst, takesChunks } from './stats.mjs';
import { actBody, catalogIds, clientHeaders, startPicture } from '../meetup/client-soul.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4800)), BASE = `http://127.0.0.1:${PORT}`, SLUG = 'viewers-eden', TEMPLATE = 'eden-2026';
const ARMS = opt('viewers', '1,50,200').split(',').map(Number).sort((a, b) => a - b), SOULS = Number(opt('souls', 12)), REPEATS = Number(opt('repeats', 2));
const WINDOW_MS = Number(opt('window-sec', SHORT ? 30 : 120)) * 1000, WARM_MS = SHORT ? 15_000 : 60_000, SETTLE_MS = SHORT ? 10_000 : 20_000, SAMPLE_MS = 2000;
const ACT_SEC = opt('act-sec') == null ? null : Number(opt('act-sec')), ARRIVE_PER_S = Number(opt('arrive-per-sec', 20)), BURST = parseBurst(opt('arrive-burst'));
const DWELL_S = opt('dwell-sec') == null ? null : Number(opt('dwell-sec')), MOTION_SAMPLED = 50;
for (const [k, v, ok] of [['viewers', ARMS.join(','), ARMS.every((n) => Number.isInteger(n) && n >= 0)], ['souls', SOULS, Number.isInteger(SOULS) && SOULS >= 1 && SOULS <= 100], ['act-sec', ACT_SEC, ACT_SEC == null || ACT_SEC > 0],
  ['arrive-per-sec', ARRIVE_PER_S, ARRIVE_PER_S > 0], ['dwell-sec', DWELL_S, DWELL_S == null || DWELL_S > 0]]) if (!ok) throw new Error(`--${k} ${v}: not a valid value`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/viewers', new Date().toISOString().replace(/[:.]/g, '-'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const clean = (t) => String(t).split(ROOT).join('.');
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'viewers.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);
const { anonymousHello } = await import(pathToFileURL(join(ROOT, 'packages/client/src/hello.ts')).href);
const HELLO = anonymousHello(true);
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
async function stopAll(run) {
  run.stopped = true;
  for (const v of run.viewers) { clearTimeout(v.timer); clearTimeout(v.leaveTimer); try { v.ws?.close(); } catch { /* closed */ } }
  for (const a of run.aborts) try { a.abort(); } catch { /* done */ }
  const L = run.launcher; if (!L) return;
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

// ------------------------------------------------------------------ viewers: the page's entry requests and its socket
async function viewerGet(run, v, path) {
  const ac = new AbortController(); run.aborts.add(ac);
  try {
    const r = await fetch(`${BASE}/w/${SLUG}${path}`, { headers: { 'x-forwarded-for': v.address }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]) });
    const b = Buffer.from(await r.arrayBuffer());
    run.counters.bytes += b.length; run.calls.push({ at: Date.now(), path: path.split('?')[0].replace(/[0-9a-f]{32}$/, '<part>'), status: r.status, cache: r.headers.get('x-sim-cache'), bytes: b.length });
    return r;
  } catch { run.calls.push({ at: Date.now(), path, status: 0, cache: null, bytes: 0 }); return null; }
  finally { run.aborts.delete(ac); }
}
async function openViewer(run, v) {
  run.counters.joins++;
  const page = viewerGet(run, v, '/'), snap = viewerGet(run, v, '/v1/world/snapshot?defs=ref&cols=1'), cfg = viewerGet(run, v, '/v1/config');
  socket(run, v);
  if (DWELL_S) v.leaveTimer = setTimeout(() => leave(run, v), stayMs(DWELL_S, run.rand));
  const r = await snap; await cfg; await page;
  const parts = r ? ['x-defs-ref', 'x-ground-ref'].map((h) => r.headers.get(h)).filter((f) => /^[0-9a-f]{32}$/.test(f ?? '')) : [];
  await Promise.all(parts.map((f) => viewerGet(run, v, `/v1/world/part/${f}`)));
}
function addViewer(run, burst) {
  const v = { address: addressOf(run.viewers.length), burst, retry: 0, sockets: 0 };
  run.viewers.push(v); (burst ? run.burst : run.base).add(v); void openViewer(run, v);
}
/** A viewer goes away for good: its socket closes and is never reopened. One who leaves before its first motion is
 *  left out of first motion (it did not wait), not counted as a miss. */
function leave(run, v) {
  if (v.left) return;
  v.left = true; run.counters.leaves++; (v.burst ? run.burst : run.base).delete(v);
  clearTimeout(v.timer); clearTimeout(v.leaveTimer);
  if (v.waiting) { v.waiting = false; run.sampling.delete(v); }
  try { v.ws?.close(); } catch { /* closed */ }
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
function socket(run, v) {
  if (run.stopped || v.left) return;
  const t0 = performance.now();
  // first motion: a newcomer's first socket, at most MOTION_SAMPLED waiting at once; only those read message heads
  if (!v.sockets++ && run.sampling.size < MOTION_SAMPLED) { v.waiting = true; v.motionAt = Date.now(); run.sampling.add(v); }
  const ws = v.ws = new WebSocket(`ws://127.0.0.1:${PORT}/w/${SLUG}/ws?hello=${encodeURIComponent(HELLO)}`, { headers: { 'x-forwarded-for': v.address } });
  let opened = false;
  const stopWaiting = (ms) => { v.waiting = false; run.sampling.delete(v); run.motion.push({ at: v.motionAt, ms }); };
  ws.onopen = () => { opened = true; run.counters.opens++; };
  ws.onmessage = (m) => {
    run.counters.messages++; run.counters.bytes += typeof m.data === 'string' ? Buffer.byteLength(m.data) : m.data.byteLength ?? m.data.size ?? 0;
    if (typeof m.data !== 'string') return;
    if (v.retry && m.data.startsWith('{"t":"welcome"')) v.retry = 0;   // as the client: tries count from the last welcome
    if (v.waiting && takesChunks(m.data) > 0) stopWaiting(performance.now() - t0);
  };
  ws.onclose = (ev) => {
    if (opened) run.counters.closes++; else run.counters.refused++;
    if (v.waiting && !v.left && !run.stopped) stopWaiting(null);
    if (run.stopped || v.left) return;
    run.counters.reconnects++;
    v.timer = setTimeout(() => socket(run, v), reconnectDelayMs(v.retry, ev?.code));
    v.retry++;
  };
  ws.onerror = () => {};
}

// ------------------------------------------------------------------ one repeat
async function repeat(k) {
  const dir = join(OUT, `r${k}`); mkdirSync(dir, { recursive: true });
  const run = { k, dir, stopped: false, aborts: new Set(), viewers: [], acts: [], calls: [], samples: [], counters: { bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0, joins: 0, leaves: 0, reconnects: 0 },
    target: 0, base: new Set(), burst: new Set(), sampling: new Set(), motion: [], rand: seeded(2511 + k) };
  const out = { repeat: k, windows: [] };
  let sampler;
  try {
    await bootLauncher(dir, run); out.bootS = run.launcher.bootS; log(`r${k}: world up in ${out.bootS} s`);
    // the launcher (every viewer's socket passes through it) and this driver are sampled too, so a saturated proxy or
    // driver is told apart from a saturated world
    sampler = setInterval(() => {
      const pid = run.launcher.worldPid(), l = proc(run.launcher.child.pid), d = process.cpuUsage();
      run.samples.push({ at: Date.now(), live: run.launcher.live(), ...(pid ? { pid, ...proc(pid) } : {}), launcherCpuS: l.cpuS, launcherRssMb: l.rssMb, driverCpuS: (d.user + d.system) / 1e6, viewersLive: run.base.size + run.burst.size });
    }, SAMPLE_MS);
    const souls = [];
    for (let i = 0; i < SOULS; i += 4) souls.push(...await Promise.all(Array.from({ length: Math.min(4, SOULS - i) }, (_, j) => joinSoul(run, i + j))));
    // the catalog may answer 503 while the world settles after the joins: ask again for up to 5 min
    let pic; for (const t0 = Date.now(); !(pic = await startPicture(`${BASE}/w/${SLUG}`, souls[0])).catalog && Date.now() - t0 < 300_000;) { log(`r${k}: catalog ${pic.catalogStatus}; asking again`); await sleep(10_000); }
    const walks = catalogIds(pic.catalog).walk;
    if (!walks.length) throw new Error(`no walk ids in the catalog (catalog ${pic.catalogStatus})`);
    out.walkPlaces = walks.length; log(`r${k}: ${souls.length} Souls joined; ${walks.length} places to walk to`);
    for (const s of souls) walk(run, s, walks);
    await sleep(WARM_MS);
    arrivals(run);
    for (const n of ARMS) {
      const opening = Date.now(), calls0 = run.calls.length;
      // the arm's count is reached at the arrival rate (with stays, it is then held by arrivals that continue)
      run.target = n;
      for (const t0 = Date.now(); run.base.size < n && Date.now() - t0 < 60_000 + (3000 * n) / ARRIVE_PER_S;) await sleep(100);
      const reachedS = Math.round((Date.now() - opening) / 1000);
      await sleep(SETTLE_MS);
      const from = Date.now(), v0 = { ...run.counters };
      // --arrive-burst n@s: a link was just posted; n more within 5 s, s seconds into the window
      let wave = null;
      if (BURST && n > 0) wave = setTimeout(() => { for (let j = 0; j < BURST.n; j++) setTimeout(() => { if (!run.stopped && wave) addViewer(run, true); }, (5000 * j) / BURST.n); }, BURST.atS * 1000);
      await sleep(WINDOW_MS);
      const to = Date.now(), v1 = { ...run.counters };
      clearTimeout(wave); wave = null;
      for (const v of [...run.burst]) leave(run, v);
      const w = windowFigures({ samples: run.samples, acts: run.acts, v0, v1, viewers: n, calls: run.calls.slice(calls0), from, to,
        motion: run.motion, waiting: [...run.sampling].map((v) => ({ at: v.motionAt })), motionFrom: opening, souls: SOULS, actSec: ACT_SEC });
      w.openingS = Math.round((from - opening) / 1000); w.reachedS = reachedS; w.callsByPath = {};
      for (const c of run.calls.slice(calls0)) { const p = (w.callsByPath[c.path] ??= { n: 0, world: 0 }); p.n++; if (c.status && c.cache !== 'hit' && c.cache !== 'shared') p.world++; }
      out.windows.push(w);
      log(`r${k} n${n}: tick p50/p99 ${w.tickMs.p50}/${w.tickMs.p99} ms, service ${w.tickService.mean}, act queue p50/p95 ${w.acts.queueMs.p50}/${w.acts.queueMs.p95} ms, amber ${w.levels.amber}, cpu ${w.world.cpuShare}, rss ${w.world.rssMb} MB, heap ${w.world.heapUsedMb} MB, launcher cpu ${w.launcher.cpuShare}, driver cpu ${w.driver.cpuShare}, ${w.viewersOut.bytesPerViewerPerS} B/s per viewer, held ${w.held.min}-${w.held.max}, joins/leaves ${w.churn.joinsPerS}/${w.churn.leavesPerS} per s, reconnects ${w.churn.reconnects}, first motion p50/p95 ${w.firstMotion.p50S}/${w.firstMotion.p95S} s (${w.firstMotion.n} seen, ${w.firstMotion.missed} missed), acts ${w.actsAchieved.ok} of ${w.actsAchieved.intended}`);
    }
  } catch (e) { out.error = clean(e.message ?? e); log(`r${k}: ${out.error}`); }
  finally { clearInterval(sampler); await stopAll(run); }
  return out;
}

const receipt = { issue: [2308, 2511], commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1),
  loadBefore: loadavg().map((x) => +x.toFixed(2)), arms: ARMS, souls: SOULS, actSec: ACT_SEC, arrivePerSec: ARRIVE_PER_S, burst: BURST, dwellSec: DWELL_S, motionSampled: MOTION_SAMPLED,
  windowS: WINDOW_MS / 1000, warmS: WARM_MS / 1000, settleS: SETTLE_MS / 1000, short: SHORT, template: TEMPLATE };
const setting = `${SOULS} Souls ${ACT_SEC ? `acting every ${ACT_SEC} s` : 'walking (6–10 s apart)'} · arrivals ${ARRIVE_PER_S}/s${BURST ? ` · burst ${BURST.n} at ${BURST.atS} s` : ''}${DWELL_S ? ` · stays median ${DWELL_S} s` : ' · viewers stay'}`;
log(`viewers: arms ${ARMS.join(',')}, ${setting}, ${REPEATS} repeats, commit ${receipt.commit?.slice(0, 9)}`);
const repeats = [];
for (let k = 1; k <= REPEATS; k++) repeats.push(await repeat(k));
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, repeats }, null, 1) + '\n');
const f = (x) => (x == null ? '—' : String(x)), obj = (o) => Object.entries(o ?? {}).map(([a, b]) => `${a} ${b}`).join(', ') || '0';
const rows = repeats.flatMap((r) => (r.error && !r.windows.length ? [`| r${r.repeat} | error: ${r.error.slice(0, 120)} |`] : r.windows.map((w) => `| r${r.repeat} | ${w.viewers} | ${f(w.tickMs.p50)} / ${f(w.tickMs.p99)} | ${f(w.tickService.mean)} (min ${f(w.tickService.min)}) | ${f(w.acts.queueMs.p50)} / ${f(w.acts.queueMs.p95)} | ${f(w.acts.handlerMs.p50)} / ${f(w.acts.handlerMs.p99)} | ${f(w.levels.amber)} | ${obj(w.amberS)} | ${w.world.restarted ? 'restarted' : f(w.world.cpuShare)} | ${f(w.world.rssMb)} | ${f(w.launcher.cpuShare)} / ${f(w.launcher.rssMb)} | ${f(w.driver.cpuShare)} | ${f(w.viewersOut.bytesPerViewerPerS)} | ${w.viewerCalls.worldCalls} of ${w.viewerCalls.http} | acts ${obj(w.acts.refused)}; viewers ${obj(w.viewerCalls.refusals)}; ws refused ${w.viewersOut.wsRefused}, closed ${w.viewersOut.wsCloses} | ${w.held.min}–${w.held.max} | ${f(w.churn.joinsPerS)} / ${f(w.churn.leavesPerS)} | ${w.churn.reconnects} | ${f(w.firstMotion.p50S)} / ${f(w.firstMotion.p95S)} (${w.firstMotion.n}, missed ${w.firstMotion.missed}) | ${f(w.world.heapUsedMb)} (max ${f(w.heapMaxMb)}) | ${w.actsAchieved.ok} of ${f(w.actsAchieved.intended)}${w.actsAchieved.share == null ? '' : ` (${w.actsAchieved.share})`} |`)));
writeFileSync(join(OUT, 'REPORT.md'), [`# Viewers on one world (#2308, #2511)`, '', `commit ${f(receipt.commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${setting} · ${receipt.windowS} s windows${SHORT ? ' · SHORT (indicative)' : ''}`, '',
  `First motion: seconds from a newcomer's first socket to its first take with a chunk, on at most ${MOTION_SAMPLED} newcomers waiting at once; a socket closed first, or waiting 5 s at the window's end, is a miss.`, '',
  '| repeat | viewers | tick p50 / p99 ms | tick service | act queue p50 / p95 ms | act handler p50 / p99 ms | amber share | amber s per signal | world CPU (cores) | RSS MB | launcher CPU (cores) / RSS MB | driver CPU (cores) | bytes/s per viewer | world calls by viewers | refusals | viewers held | joins / leaves per s | reconnects | first motion p50 / p95 s (seen, missed) | main heap MB | acts achieved of intended |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n');
log('done: REPORT.md');
if (repeats.some((r) => r.error)) process.exitCode = 1;
