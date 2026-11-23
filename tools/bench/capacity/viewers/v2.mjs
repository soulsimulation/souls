#!/usr/bin/env node
// #4018 (X9): a growing viewer swarm on a served v2 Eden. The viewers bench (viewers.mjs) re-pointed at Engine v2: one
// Eden world seeded from its facts (`worldd seed`), served (`worldd serve`) behind a real gateway (`gatewayd`), its
// public stream served by the viewers' origin (`v2/tools/origin/origin.mjs`, as the production unit runs it), all on
// this machine with an isolated folder under --out. No model is called: --souls Souls (default 20) sign in through the
// gateway with their own tokens and walk to places on the open ground (`world:walk`, one every 6 to 10 s each). Viewers
// are v2-readers.mjs's, the page's stream worker without the drawing, spread over --drivers processes.
// The ladder, per repeat: a window with no viewers (the world's tick alone), then each step of --steps in rising
// order: the step's newcomers arrive as one join wave within --wave-sec, settle, then a measuring window; at its
// midpoint --slow-share of the step (at least 5) slow readers ask for the baseline and never read, and are let go at
// its end. Per window: bytes per viewer-second by file type, time to first picture (the joiners'), stream latency,
// failed requests, viewers sent back to a baseline or left behind, the origin's, gateway's and world's processor share
// and resident memory, the world's tick (health.json), the drivers' own processor and event-loop delay. Each step is
// judged by v2-stats.mjs's bars; the first step that misses one is the next requirement.
//
//   node tools/bench/capacity/viewers/v2.mjs --facts <eden facts.json> [--bin <dir with worldd, gatewayd>]
//        [--pkg <replica wasm-bindgen pkg>] [--steps 100,250,500,1000,2000,5000] [--souls 20] [--window-sec 60]
//        [--wave-sec 5] [--settle-sec 10] [--slow-share 0.02] [--drivers 8] [--repeats 1] [--origin-memory-mb 256]
//        [--out <dir>]
// The origin runs as its unit does: killed past --origin-memory-mb resident (its MemoryMax; 0 for no cap) and
// restarted a second after it ends. A window with no viewers follows the ladder too: the tick bar
// (B6) is judged against the mean of the two.
// --agents <n> (#4152) adds n scripted agents (v2/tools/driver, `ladder-<n>-<shape>`, n of 10, 50, 100, 200, 350 or 500)
// over the whole ladder, signed in through the agent path production gives them: --agent-path relay (default: the
// agents' relay, v2/tools/origin/agents.mjs) or origin (the viewers' origin's own relay, as before #4152), both reading
// the world's gateway from a placement file as the units do. Its report (sockets closed, act latency, errors) is
// results.json's `agents` and REPORT.md's last lines. [--agent-shape uneven|even] [--driver <driver binary>]
// Writes <out>/{results.json, REPORT.md, bench.log}; <out>/r<k>/ holds the world, its logs and souls.tokens (stays local).
import { spawn, fork, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quantile } from './stats.mjs';
import { bars, hq, hcount, merge, procCpuSeconds, psSeconds, walkTargets } from './v2-stats.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const ROOT = resolve(new URL('../../../..', import.meta.url).pathname), V2 = join(ROOT, 'v2');
const FACTS = opt('facts'), BIN = resolve(opt('bin', join(V2, 'target/release'))), PKG = resolve(opt('pkg', join(V2, 'target/wasm-load/pkg')));
const STEPS = opt('steps', '100,250,500,1000,2000,5000').split(',').map(Number), SOULS = Number(opt('souls', 20)), REPEATS = Number(opt('repeats', 1));
const WINDOW_MS = Number(opt('window-sec', 60)) * 1000, WAVE_MS = Number(opt('wave-sec', 5)) * 1000, SETTLE_MS = Number(opt('settle-sec', 10)) * 1000;
const SLOW_SHARE = Number(opt('slow-share', 0.02)), DRIVERS = Number(opt('drivers', 8)), SAMPLE_MS = 1000, WARM_MS = 20_000;
if (!FACTS || !existsSync(FACTS)) throw new Error('--facts <eden facts.json>: node v2/tools/import-eden/export/export.ts writes it');
for (const f of [join(BIN, 'worldd'), join(BIN, 'gatewayd'), join(PKG, 'replica.js')]) if (!existsSync(f)) throw new Error(`missing ${f}: build worldd and gatewayd (--release) and replica's wasm-bindgen package`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/viewers-v2', new Date().toISOString().replace(/[:.]/g, '-'))));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'bench.log'), s + '\n'); };
const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
const ORIGIN_MB = Number(opt('origin-memory-mb', 256));
const AGENTS = Number(opt('agents', 0)), AGENT_PATH = opt('agent-path', 'relay'), AGENT_SHAPE = opt('agent-shape', 'uneven'), DRIVER = resolve(opt('driver', join(BIN, 'driver')));
if (AGENTS && !['relay', 'origin'].includes(AGENT_PATH)) throw new Error('--agent-path relay|origin');
if (AGENTS && !existsSync(DRIVER)) throw new Error(`missing ${DRIVER}: build the driver (--release)`);
const FD_LIMIT = Number(execFileSync('sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim());
const PEAK = Math.max(...STEPS) * (1 + SLOW_SHARE) + 5;
if (Number.isFinite(FD_LIMIT) && FD_LIMIT < 2 * PEAK + 1024) throw new Error(`open-file limit ${FD_LIMIT} is below ${Math.ceil(2 * PEAK + 1024)}: the origin holds up to two sockets a viewer; raise it (ulimit -n)`);

// ------------------------------------------------------------------ the served world
const procs = [];
function started(cmd, args, re, file, env = process.env) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  procs.push(p);
  let out = '';
  return new Promise((ok, fail) => {
    const on = (d) => { appendFileSync(file, d); out += d; const m = re.exec(out); if (m) ok({ p, m }); };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('exit', (c) => fail(new Error(`${cmd} ended (${c}); see ${relative(ROOT, file)}`)));
  });
}

async function serve(dir) {
  const w = join(dir, 'world'), sock = join(dir, 'w.sock');
  execFileSync(join(BIN, 'worldd'), ['seed', '--facts', FACTS, '--dir', w, '--souls', String(SOULS + AGENTS)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const world = await started(join(BIN, 'worldd'), ['serve', '--dir', w, '--socket', sock], /listening /, join(dir, 'worldd.log'));
  const gw = await started(join(BIN, 'gatewayd'), ['--listen', '127.0.0.1:0', '--world', sock, '--tokens', join(w, 'tokens'), '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/, join(dir, 'gatewayd.log'));
  const stream = JSON.parse(readFileSync(join(w, 'views/world.json'), 'utf8')).stream.replace(/^views\//, '');
  const s = { w, world: world.p, gateway: gw.p, gatewayAt: `ws://${gw.m[1]}/v2/ws`, stream, originRestarts: 0, originKills: 0 };
  // The placement file the origin and the agents' relay read (world-routes.mjs), naming this gateway for `eden`.
  const routes = join(dir, 'worlds.json'), env = { ...process.env, SOULS_WORLD_ROUTES: routes };
  writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: `http://${gw.m[1]}`, stream: '/s/eden/', canonical: true } } }));
  // The origin as its production unit runs it (v2/tools/ops/units/souls-origin.service): MemoryMax with no swap, and
  // started again a second after it ends (Restart=always, RestartSec=1s), on the same port. The cap is a watchdog here:
  // the origin is killed once its resident memory passes --origin-memory-mb (read every 100 ms), as the kernel's
  // out-of-memory kill would end it in its unit (cgroup v1 machines give a user's scope no memory limit).
  const port = async (p) => {
    const o = await started(process.execPath, [join(V2, 'tools/origin/origin.mjs'), join(w, 'views'), String(p), '127.0.0.1'], /origin (\d+)\n/, join(dir, 'origin.log'), env);
    s.origin = o.p;
    const cap = ORIGIN_MB > 0 && setInterval(() => { if ((proc(o.p.pid)?.rssMb ?? 0) > ORIGIN_MB) { s.originKills++; o.p.kill('SIGKILL'); } }, 100);
    o.p.on('exit', () => { clearInterval(cap); if (!stopping) { s.originRestarts++; log(`origin ended (restart ${s.originRestarts})`); setTimeout(() => port(o.m[1]).catch((e) => log(String(e))), 1000); } });
    return o.m[1];
  };
  s.base = `http://127.0.0.1:${await port(0)}/`;
  if (AGENTS && AGENT_PATH === 'relay') {
    const a = await started(process.execPath, [join(V2, 'tools/origin/agents.mjs'), '0', '127.0.0.1'], /agents (\d+)\n/, join(dir, 'agents.log'), env);
    s.agentsAt = `ws://127.0.0.1:${a.m[1]}/w/eden/v2/ws`;
  } else if (AGENTS) s.agentsAt = `ws://${new URL(s.base).host}/w/eden/v2/ws`;
  return s;
}
let stopping = false;

// ------------------------------------------------------------------ Souls walking through the gateway
function walkers(s, targets) {
  const meta = JSON.parse(readFileSync(join(s.w, 'world.json'), 'utf8')), scope = Buffer.from(meta.souls_scope, 'hex');
  const tokens = readFileSync(join(s.w, 'souls.tokens'), 'utf8').trim().split('\n').slice(0, SOULS); // the rest are --agents'
  const counts = { signedIn: 0, sent: 0, answers: {}, closed: 0 };
  const stops = tokens.map((token) => {
    const counter = BigInt(/^soul-[0-9a-f]+-(\d+)\./.exec(token)[1]);
    let seq = 0n, timer = null, step = 'hello', on = true;
    const ws = new WebSocket(s.gatewayAt);
    ws.binaryType = 'arraybuffer';
    const walk = () => {
      if (!on) return;
      const target = targets[Math.floor(Math.random() * targets.length)];
      ws.send(wire.wireIntent(scope, counter, 'world:walk', ++seq, new Uint8Array(), BigInt(Number.MAX_SAFE_INTEGER), target));
      counts.sent++;
      timer = setTimeout(walk, 6000 + Math.random() * 4000);
    };
    ws.onopen = () => ws.send(wire.wireHello());
    ws.onmessage = (m) => {
      const bytes = new Uint8Array(m.data);
      if (step === 'hello') { ws.send(wire.wireSignIn(token, new Uint8Array(), undefined)); step = 'outcome'; return; }
      const f = wire.wireFrame(bytes).split(' ');
      if (f[0] === 'outcome' && step === 'outcome') { step = 'on'; counts.signedIn++; timer = setTimeout(walk, Math.random() * 3000); return; }
      if (f[0] === 'answer') { const k = f[3] === '2' ? `refused ${f[4]}` : { 1: 'receipt', 3: 'accepted', 4: `resolved ${f[4]}`, 5: 'unread' }[f[3]] ?? f[3]; counts.answers[k] = (counts.answers[k] ?? 0) + 1; }
    };
    ws.onclose = () => { counts.closed++; clearTimeout(timer); };
    return () => { on = false; clearTimeout(timer); ws.close(); };
  });
  return { counts, stop: () => stops.forEach((f) => f()) };
}

// ------------------------------------------------------------------ the viewers' drivers
async function drivers(s) {
  const kids = await Promise.all(Array.from({ length: DRIVERS }, () => new Promise((ok) => {
    const k = fork(new URL('./v2-readers.mjs', import.meta.url).pathname, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    k.once('message', () => ok(k));
    k.send({ init: { base: s.base, stream: s.stream, pkg: PKG } });
  })));
  // A driver that ended answers nothing: its take is left out (and logged), so the ladder never waits on it.
  kids.forEach((k, i) => k.on('exit', (c) => { k.dead = true; log(`driver ${i} ended (${c})`); }));
  const take = async () => (await Promise.all(kids.map((k) => (k.dead ? null : new Promise((ok) => {
    const t = setTimeout(() => ok(null), 30_000);
    k.once('message', (m) => { clearTimeout(t); ok(m.took); });
    k.send({ take: true });
  }))))).filter(Boolean);
  const share = (n, i) => Math.floor(n / DRIVERS) + (i < n % DRIVERS ? 1 : 0);
  return {
    take,
    add: (n, overMs) => kids.forEach((k, i) => !k.dead && share(n, i) && k.send({ add: share(n, i), overMs })),
    slow: (n) => kids.forEach((k, i) => !k.dead && share(n, i) && k.send({ slow: share(n, i) })),
    unslow: () => kids.forEach((k) => !k.dead && k.send({ unslow: true })),
    stop: () => kids.forEach((k) => !k.dead && k.send({ stop: true })),
  };
}

/** Merged driver counters. */
function sum(takes) {
  const o = { bytes: {}, requests: {}, headerBytes: 0, installed: {}, firstPicture: {}, latency: {}, errors: {}, reinstalls: 0, crossed: 0, behind: 0, recovered: 0, joined: 0, left: 0, viewers: 0, waiting: 0, slow: 0, cpuSeconds: 0, loopP99Ms: 0, loopMaxMs: 0 };
  for (const t of takes) {
    for (const k of ['bytes', 'requests', 'installed', 'firstPicture', 'latency', 'errors']) merge(o[k], t[k]);
    for (const k of ['headerBytes', 'reinstalls', 'crossed', 'behind', 'recovered', 'joined', 'left', 'viewers', 'waiting', 'slow', 'cpuSeconds']) o[k] += t[k];
    o.loopP99Ms = Math.max(o.loopP99Ms, t.loopP99Ms);
    o.loopMaxMs = Math.max(o.loopMaxMs, t.loopMaxMs);
  }
  return o;
}

// ------------------------------------------------------------------ processes and the world's tick
const LINUX = existsSync('/proc/self/stat');
function proc(pid) {
  try {
    if (LINUX) return { cpu: procCpuSeconds(readFileSync(`/proc/${pid}/stat`, 'utf8')), rssMb: Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024 };
    const [rss, time] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    return { cpu: psSeconds(time), rssMb: Number(rss) / 1024 };
  } catch { return null; }
}
const health = (w) => { try { return JSON.parse(readFileSync(join(w, 'health.json'), 'utf8')); } catch { return null; } };

/** Samples the three processes and the world's health each second for `ms`; `mid` runs at half-time. */
async function measure(s, ms, mid) {
  const t0 = Date.now(), first = { origin: proc(s.origin.pid), world: proc(s.world.pid), gateway: proc(s.gateway.pid), health: health(s.w) };
  const rss = { origin: [], world: [], gateway: [] }, lastTick = [];
  let midDone = false;
  while (Date.now() - t0 < ms) {
    await sleep(SAMPLE_MS);
    for (const k of ['origin', 'world', 'gateway']) { const p = proc(s[k].pid); if (p) rss[k].push(p.rssMb); }
    const h = health(s.w);
    if (h?.last_tick_us) lastTick.push(Object.values(h.last_tick_us).reduce((a, b) => a + b, 0));
    if (mid && !midDone && Date.now() - t0 >= ms / 2) { midDone = true; await mid(); }
  }
  const secs = (Date.now() - t0) / 1000, last = { origin: proc(s.origin.pid), world: proc(s.world.pid), gateway: proc(s.gateway.pid), health: health(s.w) };
  const cores = (k) => (first[k] && last[k] ? +((last[k].cpu - first[k].cpu) / secs).toFixed(3) : null);
  const t1 = first.health?.ticks, t2 = last.health?.ticks, n = t1 && t2 ? t2.count - t1.count : 0;
  return {
    secs, originCores: cores('origin'), worldCores: cores('world'), gatewayCores: cores('gateway'),
    originRssMaxMb: Math.round(Math.max(...rss.origin, 0)), worldRssMaxMb: Math.round(Math.max(...rss.world, 0)), gatewayRssMaxMb: Math.round(Math.max(...rss.gateway, 0)),
    ticks: n, tickMeanUs: n > 0 ? Math.round((t2.mean_us * t2.count - t1.mean_us * t1.count) / n) : null,
    tickSampledP99Us: quantile(lastTick, 0.99), overBudget: last.health && first.health ? last.health.over_budget - first.health.over_budget : null,
  };
}

// ------------------------------------------------------------------ one repeat
const TYPES = ['pointer', 'header', 'baseline', 'baseline.text', 'part', 'part.text'];
function row(step, viewers, wave, win) {
  const vs = Math.max(1, viewers * win.secs), errors = Object.values(win.d.errors).reduce((a, b) => a + b, 0) + Object.values(wave.errors).reduce((a, b) => a + b, 0);
  const bytesPerViewerS = Object.fromEntries(TYPES.map((t) => [t, Math.round((win.d.bytes[t] ?? 0) / vs)]));
  const joinBytes = Object.fromEntries(TYPES.map((t) => [t, wave.joined ? Math.round((wave.bytes[t] ?? 0) / wave.joined) : 0]));
  return {
    step, viewers, slowReaders: win.slowHeld, joined: wave.joined,
    ...(() => { const fp = merge({ ...wave.firstPicture }, win.d.firstPicture); return { firstPictureP50: hq(fp, 0.5), firstPictureP95: hq(fp, 0.95), firstPictures: hcount(fp) }; })(),
    installedP95: hq(merge({ ...wave.installed }, win.d.installed), 0.95),
    latencyP50: hq(win.d.latency, 0.5), latencyP99: hq(win.d.latency, 0.99), latencySamples: hcount(win.d.latency),
    errors, errorKinds: merge({ ...wave.errors }, win.d.errors), reinstalls: wave.reinstalls + win.d.reinstalls, behind: wave.behind + win.d.behind, recovered: wave.recovered + win.d.recovered, crossed: win.d.crossed, waitingAtEnd: win.d.waiting,
    bytesPerViewerS, totalBytesPerViewerS: Object.values(bytesPerViewerS).reduce((a, b) => a + b, 0), headerBytesPerViewerS: Math.round(win.d.headerBytes / vs),
    requestsPerViewerS: +(Object.values(win.d.requests).reduce((a, b) => a + b, 0) / vs).toFixed(2), joinBytes,
    originRssWaveMb: wave.originRssMaxMb, ...win.p, originRssMaxMb: Math.max(win.p.originRssMaxMb, wave.originRssMaxMb ?? 0),
    driverCores: +(win.d.cpuSeconds / win.secs).toFixed(2), driverLoopP99Ms: +win.d.loopP99Ms.toFixed(1), driverLoopMaxMs: +win.d.loopMaxMs.toFixed(1),
  };
}

async function repeat(r) {
  stopping = false; // each repeat's origin is restarted again (the last repeat's end set it)
  const dir = join(OUT, `r${r}`);
  mkdirSync(dir, { recursive: true });
  log(`repeat ${r}: seeding Eden with ${SOULS} Souls`);
  const s = await serve(dir);
  log(`served: gateway ${s.gatewayAt}, origin ${s.base}, stream ${s.stream}`);
  let p0 = null;
  for (let i = 0; i < 120 && !p0?.generation; i++) { try { p0 = JSON.parse(wire.readPointer(new Uint8Array(await (await fetch(new URL('pointer', new URL(s.stream, s.base)))).arrayBuffer()))); } catch { /* not yet */ } if (!p0?.generation) await sleep(500); }
  if (!p0?.generation) throw new Error('the stream has no generation: no baseline to start from');
  // The world as a viewer sees it (the first generation's parts hold the import): its places to walk to.
  const file = async (f) => new Uint8Array(await (await fetch(new URL(f, new URL(s.stream, s.base)))).arrayBuffer());
  const baseline = await file(`g/${p0.generation}/baseline`);
  const player = wire.StreamPlayer.fromBaseline(await file(`../../../headers/${p0.header}`), baseline);
  for (let n = 0; n <= (p0.newest ?? -1); n++) player.playDeferred(await file(`g/${p0.generation}/${n}`));
  const targets = walkTargets(player.snapshot());
  player.free();
  log(`baseline ${baseline.length} bytes, ${(p0.newest ?? -1) + 1} parts; ${targets.length} places to walk to`);
  const walk = walkers(s, targets);
  const agents = AGENTS ? agentRun(s, dir) : null;
  await sleep(WARM_MS);
  log(`warm: ${JSON.stringify(walk.counts)}`);
  const d = await drivers(s);
  const rows = [];
  const zero = await measure(s, WINDOW_MS);
  await d.take();
  rows.push({ step: 0, viewers: 0, ...zero });
  log(`0 viewers: tick mean ${zero.tickMeanUs} µs, world ${zero.worldCores} cores, origin ${zero.originCores} cores`);
  let held = 0;
  for (const step of STEPS) {
    await d.take();
    const restarts0 = s.originRestarts;
    d.add(step - held, WAVE_MS);
    held = step;
    const waveP = await measure(s, WAVE_MS + SETTLE_MS);
    const wave = { ...sum(await d.take()), originRssMaxMb: waveP.originRssMaxMb };
    const slowN = Math.max(5, Math.round(step * SLOW_SHARE));
    const p = await measure(s, WINDOW_MS, () => d.slow(slowN));
    const dsum = sum(await d.take());
    d.unslow();
    const x = row(step, dsum.viewers, wave, { secs: p.secs, d: dsum, p, slowHeld: slowN });
    x.walks = { ...walk.counts, answers: { ...walk.counts.answers } };
    x.originRestarts = s.originRestarts - restarts0;
    x.driverBound = x.driverLoopP99Ms > 100; // the drivers, not the origin, were the limit: the step is not judged
    x.bars = bars(x, zero.tickMeanUs);
    rows.push(x);
    log(`${step} viewers: first picture p95 ${x.firstPictureP95} ms, latency p99 ${x.latencyP99} ms, errors ${x.errors}, reinstalls ${x.reinstalls}, behind ${x.behind}, without a picture at the end ${x.waitingAtEnd}, origin restarts ${x.originRestarts}, ` +
      `origin ${x.originCores} cores ${x.originRssMaxMb} MB, world ${x.worldCores} cores tick ${x.tickMeanUs} µs, ${x.totalBytesPerViewerS} B/viewer-s, drivers loop p99 ${x.driverLoopP99Ms} ms; ` +
      `missed: ${x.bars.filter((b) => b.met === false).map((b) => b.bar).join(', ') || 'none'}`);
  }
  d.stop();
  await sleep(2000);
  const after = await measure(s, WINDOW_MS);
  rows.push({ step: 0, viewers: 0, after: true, ...after });
  const zeroMean = (zero.tickMeanUs + after.tickMeanUs) / 2;
  for (const x of rows) if (x.bars) x.bars = bars(x, zeroMean);
  log(`0 viewers again: tick mean ${after.tickMeanUs} µs, world ${after.worldCores} cores; origin restarts ${s.originRestarts}`);
  const agentReport = agents && await agents;
  stopping = true;
  walk.stop();
  await sleep(1000);
  for (const p of procs.splice(0)) p.kill('SIGTERM');
  await sleep(1000);
  return { baselineBytes: baseline.length, walkTargets: targets.length, originCapMb: ORIGIN_MB, rows, ...(agentReport ? { agents: agentReport } : {}) };
}

/**
 * --agents: the driver's schedule over the ladder's length (the windows, waves and settles, and the window after),
 * signed in with the seeded Souls past the walkers' through `s.agentsAt`; resolves with its report's agent figures.
 */
async function agentRun(s, dir) {
  const out = join(dir, 'agents'), seconds = Math.ceil((WARM_MS + WINDOW_MS * (STEPS.length + 2) + (WAVE_MS + SETTLE_MS) * STEPS.length) / 1000);
  mkdirSync(join(out, 'run'), { recursive: true });
  writeFileSync(join(out, 'agents.tokens'), readFileSync(join(s.w, 'souls.tokens'), 'utf8').trim().split('\n').slice(SOULS).join('\n') + '\n', { mode: 0o600 });
  execFileSync(process.execPath, [join(V2, 'tools/driver/loads.mjs'), `ladder-${AGENTS}-${AGENT_SHAPE}`, '--seconds', String(seconds), '--seed', '1', '--out', join(out, 'schedule.txt')], { stdio: 'ignore' });
  log(`agents: ${AGENTS} (${AGENT_SHAPE}) for ${seconds} s through the ${AGENT_PATH === 'relay' ? "agents' relay" : "viewers' origin"} at ${s.agentsAt}`);
  const d = await started(DRIVER, ['--schedule', join(out, 'schedule.txt'), '--dir', join(out, 'run'), '--remote', s.agentsAt, '--tokens', join(out, 'agents.tokens')], /^/, join(out, 'driver.log'));
  procs.splice(procs.indexOf(d.p), 1); // its own end, not the ladder's: never killed early
  await new Promise((ok) => (d.p.exitCode === null ? d.p.on('exit', ok) : ok()));
  let r;
  try { r = JSON.parse(readFileSync(join(out, 'run/report.json'), 'utf8')); } catch { return { path: AGENT_PATH, failed: 'no report: see agents/driver.log' }; }
  const errors = {};
  for (const m of r.perMinute) merge(errors, m.errors);
  const a = { path: AGENT_PATH, agents: r.agents, intended: r.intendedActs, achievedShare: r.achievedShare, receipts: r.receipts, socketsClosed: r.socketsClosed,
    actP95MsMax: Math.max(0, ...r.perMinute.map((m) => m.latencyP95Ms)), actP95MsByMinute: r.perMinute.map((m) => m.latencyP95Ms),
    failed: Object.values(errors).reduce((x, y) => x + y, 0), errors };
  log(`agents: sockets closed ${a.socketsClosed}, act p95 by minute ${a.actP95MsByMinute.join(', ')} ms, failed ${a.failed} ${JSON.stringify(errors)}, achieved ${(100 * a.achievedShare).toFixed(1)} %`);
  return a;
}

const results = { started: new Date().toISOString(), machine: { cpus: (await import('node:os')).cpus().length, platform: process.platform }, config: { steps: STEPS, souls: SOULS, windowSec: WINDOW_MS / 1000, waveSec: WAVE_MS / 1000, settleSec: SETTLE_MS / 1000, slowShare: SLOW_SHARE, drivers: DRIVERS, repeats: REPEATS }, repeats: [] };
try {
  for (let r = 1; r <= REPEATS; r++) results.repeats.push(await repeat(r));
} finally {
  for (const p of procs) p.kill('SIGKILL');
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
const md = ['| repeat | viewers | first picture p50 / p95 ms (baseline drawn p95; none yet at end) | latency p50 / p99 ms | drops (err / rebase / behind) | B/viewer-s (pointer, part, part.text) | joiner kB (baseline, parts) | origin cores, RSS MB, restarts | world cores, RSS MB, tick mean µs | gateway cores, RSS MB | drivers loop p99 ms | first missed bar |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
results.repeats.forEach((rep, i) => rep.rows.forEach((x) => md.push(x.step === 0
  ? `| ${i + 1} | 0${x.after ? ' (after)' : ''} | - | - | - | - | - | ${x.originCores}, ${x.originRssMaxMb}, - | ${x.worldCores}, ${x.worldRssMaxMb}, ${x.tickMeanUs} | ${x.gatewayCores}, ${x.gatewayRssMaxMb} | - | - |`
  : `| ${i + 1} | ${x.step} | ${x.firstPictureP50} / ${x.firstPictureP95} (${x.installedP95}; ${x.waitingAtEnd}) | ${x.latencyP50} / ${x.latencyP99} | ${x.errors} / ${x.reinstalls} / ${x.behind} | ${x.totalBytesPerViewerS} (${x.bytesPerViewerS.pointer}, ${x.bytesPerViewerS.part}, ${x.bytesPerViewerS['part.text']}) | ${Math.round(x.joinBytes.baseline / 1024)}, ${Math.round((x.joinBytes.part + x.joinBytes['part.text']) / 1024)} | ${x.originCores}, ${x.originRssMaxMb}, ${x.originRestarts} | ${x.worldCores}, ${x.worldRssMaxMb}, ${x.tickMeanUs} | ${x.gatewayCores}, ${x.gatewayRssMaxMb} | ${x.driverLoopP99Ms} | ${x.driverBound ? 'driver-bound' : x.bars.find((b) => b.met === false)?.bar ?? 'none'} |`)));
results.repeats.forEach((rep, i) => rep.agents && md.push('', `Repeat ${i + 1}, ${rep.agents.agents ?? AGENTS} agents through the ${rep.agents.path}: sockets closed ${rep.agents.socketsClosed}, act p95 (worst minute) ${rep.agents.actP95MsMax} ms, failed requests ${rep.agents.failed} ${JSON.stringify(rep.agents.errors)}, achieved ${rep.agents.achievedShare}`));
writeFileSync(join(OUT, 'REPORT.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
process.exit(0);
