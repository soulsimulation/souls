#!/usr/bin/env node
// #2301: a hundred worlds in use at once on one machine, skipped and unloaded while still, exact on return. One script
// builds the fixture (A1) and re-runs A2 to A7 on it through the checkout's own launcher, fake minds, isolated data under
// --out; A8 is worked out by hand from its report. Tools-only, never gated. Through .github/workflows/timed-run.yml
// (command `hundred`) on a souls-timed runner; `--short` is the under-20-minute re-run of A9.
//
//   node tools/bench/capacity/hundred/hundred.mjs [--small 100] [--eden 4] [--out <dir>] [--port 4800] [--root <checkout>]
//        [--fixture <dir>] [--fixture-only] [--short] [--active-min 60] [--gap-min 60] [--act-min 2-10]
//        [--worlds-mem-mb <MB>] [--settle-min 80] [--build-parallel 3] [--seed 2301]
//
// A1 fixture: <out>/fixture (or a copy of --fixture): a launcher data dir with --small hello-hamlet worlds and --eden
//    eden-2026 worlds, each booted once from genesis through the launcher, with one or two Souls joined by the checkout's
//    own CLI (folders under fixture/souls, never published), then stopped. fixture.json lists them and the act ids.
// A6 every world's first Soul acts at seeded gaps of --act-min minutes (a walk, then a held sit), for --active-min, with
//    the launcher's world memory set so that about 25 small worlds fit (--worlds-mem-mb; #2240's figures).
// A7 all agents stop in the same minute; every listening world gets a reminder due at one shared instant; then a
//    crawler fetch of every world page.
// A3 after the wind-down every world should unload: the launcher's processes, memory and each world's clock (its kept
//    live picture) are recorded.
// A5 one world keeps a listener and a reminder due inside the gap; A4 after --gap-min, one act each to a sleeping Soul in
//    a small and an Eden world: time to answer, clock and needs moved, the world's counters.
// A2 for the sampled worlds (the A4 pair and one more small one) a twin: the world's start state from the fixture,
//    ticked straight through (SIM_SKIP=0) over the world's own log to the tick it stopped at; the boot checks the state
//    hash there against the one the jumped world wrote.
// A piece of the still-worlds tranche that the checkout lacks is named (`missing`) and its phase reported as not shown,
// never as passed. Writes <out>/{results.json, REPORT.md, hundred.log}; no host name, user, home path or token in them.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gapsFor, holdSecondsFor, mulberry, pct, probeSource, summarizeActs, inMemoryFractions, memFigure, SMALL_MB, EDEN_MB } from './plan.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const N_SMALL = Number(opt('small', SHORT ? 6 : 100)), N_EDEN = Number(opt('eden', SHORT ? 1 : 4)), SEED = Number(opt('seed', 2301));
const PORT = Number(opt('port', 4800)), CONTROL = PORT + 1, RANGE = [PORT + 2, PORT + 2 + 2 * (N_SMALL + N_EDEN) + 3];
const ACTIVE_MS = Number(opt('active-min', SHORT ? 6 : 60)) * 60_000, GAP_MS = Number(opt('gap-min', SHORT ? 3 : 60)) * 60_000;
const [ACT_LO, ACT_HI] = opt('act-min', SHORT ? '0.5-1.5' : '2-10').split('-').map(Number);
const QUIET_MS = SHORT ? 60_000 : 600_000, BUILD_PAR = Number(opt('build-parallel', 3));
// short knobs (dev worlds only, #2295): silent 1 min, the walk out bounded at 2 min; real worlds keep the hour
const BODY_KNOBS = SHORT ? { wanderTicks: 1200, zombieTicks: 600, legMinTicks: 100, legMaxTicks: 200, boundTicks: 2400 } : null;
const SETTLE_MS = Number(opt('settle-min', SHORT ? 6 : 80)) * 60_000;   // agents silent → every world unloaded: wind-down + quiet + margin
const OUT = resolve(opt('out', join(ROOT, '.local/bench/hundred', new Date().toISOString().replace(/[:.]/g, '-'))));
const FIX = join(OUT, 'fixture'), LDATA = join(FIX, 'launcher'), HOME = join(OUT, 'home');
const ORIGIN = `http://localhost:${PORT}`, MARS_WEB = join(ROOT, 'mars/viewer/dist');
const MEM_MB = Number(opt('worlds-mem-mb', memFigure(25)));
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const clean = (s) => String(s ?? '').split(ROOT).join('.').split(OUT).join('<out>');
mkdirSync(HOME, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${clean(a.join(' '))}`; console.log(s); appendFileSync(join(OUT, 'hundred.log'), s + '\n'); };
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [join(ROOT, 'apps/web/dist/kit-contract.json'), 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);
const R = { issue: 2301, commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1),
  loadBefore: loadavg().map((x) => +x.toFixed(2)), short: SHORT, knobs: { small: N_SMALL, eden: N_EDEN, activeMin: ACTIVE_MS / 60_000, gapMin: GAP_MS / 60_000, actMin: [ACT_LO, ACT_HI], quietSec: QUIET_MS / 1000, worldsMemMb: MEM_MB, bodyKnobs: BODY_KNOBS, seed: SEED } };
const save = () => writeFileSync(join(OUT, 'results.json'), JSON.stringify(R, null, 1) + '\n');

// ------------------------------------------------------------------ what the checkout has (named, never assumed)
R.missing = probeSource((pattern, path) => !!sh('grep', ['-rlE', '--include=*.ts', '--include=*.mjs', '--exclude=*.test.*', pattern, join(ROOT, path)]));
for (const m of R.missing) log(`missing: ${m.what} (${m.issue})`);

// ------------------------------------------------------------------ the launcher
let L = null;
async function getJ(url, { ms = 10_000, headers = {} } = {}) { try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null), h: r.headers }; } catch (e) { return { status: 0, j: null, error: e.name }; } }
async function startLauncher({ unload }) {
  const cfgFile = join(OUT, `launcher-${unload ? 'run' : 'build'}.json`), memSupported = !R.missing.some((m) => m.key === 'mem');
  const cfg = { eager: 0, worldHeapMb: 0, unloadStill: unload, ...(unload ? { stillQuietMs: QUIET_MS } : {}),
    // #2233's one memory figure when the checkout has it; otherwise the port-era cap at the same number of small worlds
    ...(unload && memSupported ? { worldsMemMb: MEM_MB } : { maxRunning: Math.min(RANGE[1] - RANGE[0] + 1, unload ? Math.max(1, Math.floor(MEM_MB / SMALL_MB)) : BUILD_PAR + 1) }), maxWorlds: N_SMALL + N_EDEN + 10 };
  const worldEnv = { SIM_BOOT_HASH: '1', ...(BODY_KNOBS ? { SIM_BODY_KNOBS: JSON.stringify(BODY_KNOBS) } : {}) };
  writeFileSync(cfgFile, JSON.stringify({ root: ROOT, port: PORT, control: CONTROL, range: RANGE, dataDir: LDATA, marsWebDir: MARS_WEB, publicOrigin: ORIGIN, worldEnv, cfg }, null, 1));
  const env = { ...process.env, SIM_PREWARM: '0', HOME }; for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES') || /KEY|TOKEN|SECRET/.test(k)) delete env[k];
  const child = spawn(process.execPath, [join(ROOT, 'tools/bench/capacity/hundred/launch.mjs'), cfgFile], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  const onData = (b) => { buf += b; let i; while ((i = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, i); buf = buf.slice(i + 1); lines.push({ at: Date.now(), s }); appendFileSync(join(OUT, 'launcher.log'), `${new Date().toISOString().slice(11, 23)} ${s}\n`); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  for (const t0 = Date.now(); !(await getJ(`http://127.0.0.1:${CONTROL}/ps`, { ms: 2000 })).j; await sleep(500)) {
    if (child.exitCode != null) throw new Error(`launcher exited at start (${child.exitCode}): ${lines.slice(-5).map((l) => l.s).join(' | ')}`);
    if (Date.now() - t0 > 120_000) throw new Error('launcher did not start in 2 min');
  }
  L = { child, lines, pid: child.pid, memSupported, cfg };
  return L;
}
async function stopLauncher() {
  if (!L) return; const c = L.child; L = null;
  if (c.exitCode == null) { c.kill('SIGTERM'); for (let k = 0; k < 240 && c.exitCode == null; k++) await sleep(500); if (c.exitCode == null) c.kill('SIGKILL'); }
}
const ps = async () => (await getJ(`http://127.0.0.1:${CONTROL}/ps`, { ms: 5000 })).j;
const stopWorld = (slug) => fetch(`http://127.0.0.1:${CONTROL}/stop/${slug}`, { method: 'POST', signal: AbortSignal.timeout(120_000) }).catch(() => null);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig})`); stopListeners(); await stopLauncher(); process.exit(130); });

// ------------------------------------------------------------------ Souls (the checkout's own CLI, dev identity, HOME in the run)
function cli(dir, args, ms = 180_000) {
  return new Promise((done) => {
    const t = Date.now(), p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (d) => { out = (out + d).slice(-8000); }); p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const k = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', (code) => { clearTimeout(k); let j = null; try { j = JSON.parse(out); } catch { /* not json */ } done({ code, ms: Date.now() - t, j, out, err, waits: (err.match(/waiting/g) ?? []).length }); });
  });
}
const agentOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')); } catch { return {}; } };
const soulApi = (dir, path, { method = 'GET', body, ms = 60_000 } = {}) => {
  const a = agentOf(dir);
  return fetch(`${a.world}${path}`, { method, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', 'x-soul-client': 'bench/1' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ms) })
    .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }), (e) => ({ status: 0, j: null, error: e.name }));
};

// ------------------------------------------------------------------ A1: the fixture
async function buildFixture() {
  const t0 = Date.now(), worlds = [];
  for (let i = 1; i <= N_SMALL; i++) worlds.push({ slug: `s${String(i).padStart(3, '0')}`, template: 'hello-hamlet', souls: (i % 2) + 1 });
  for (let i = 1; i <= N_EDEN; i++) worlds.push({ slug: `e${i}`, template: 'eden-2026', souls: (i % 2) + 1 });
  mkdirSync(join(LDATA, 'worlds'), { recursive: true });
  writeFileSync(join(LDATA, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', worlds: worlds.map((w) => ({ slug: w.slug, name: `Hundred ${w.slug}`, template: w.template, port: null, createdAt: Date.now(), unlisted: false })) }, null, 2) + '\n');
  await startLauncher({ unload: false });
  const ids = {}, failed = [];
  let next = 0;
  const one = async (w) => {
    const tw = Date.now(), url = `${ORIGIN}/w/${w.slug}`;
    for (let up = false; !up; ) { up = (await getJ(`${url}/healthz`, { ms: 30_000 })).j?.ok; if (!up) { if (Date.now() - tw > 900_000) throw new Error(`${w.slug} did not boot in 15 min`); await sleep(1000); } }
    w.bootS = +((Date.now() - tw) / 1000).toFixed(1);
    if (!ids[w.template]) { const { catalogIds } = await import(pathToFileURL(join(ROOT, 'tools/bench/capacity/meetup/client-soul.mjs')).href); let cat = null; for (let k = 0; k < 30 && !cat?.places; k++) { cat = (await getJ(`${url}/v1/edge/catalog`, { ms: 60_000, headers: { 'x-soul-client': 'bench/1' } })).j; if (!cat?.places) await sleep(2000); } ids[w.template] = catalogIds(cat); }
    w.dirs = [];
    for (let k = 1; k <= w.souls; k++) {
      const dir = join(FIX, 'souls', w.slug, String(k)); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${url}/eden.mjs`)).arrayBuffer()));
      writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-hundred-${w.slug}-${k}` }) + '\n', { mode: 0o600 });
      const reg = await cli(dir, ['register', url]); if (reg.code) throw new Error(`${w.slug} soul ${k} register: ${reg.err.trim().split('\n').at(-1)}`);
      for (let a = 0; !agentOf(dir).token && a < 3; a++) { const c = await cli(dir, ['create', `${w.slug.toUpperCase()} ${k}`]); if (!agentOf(dir).token) { log(`${w.slug} soul ${k} create: ${c.code} ${c.err.trim().split('\n').at(-1)}`); await sleep(2000); } }
      if (!agentOf(dir).token) throw new Error(`${w.slug} soul ${k} did not join`);
      w.dirs.push(relative(FIX, dir));
      // the first Soul of each template keeps only the walks its world accepts (a catalog place may be scenery or shut)
      if (k === 1 && ids[w.template] && !ids[w.template].checked) {
        const tried = (ids[w.template].walk ?? []).filter((id) => id !== 'walk:world').slice(0, 16), ok = [];
        for (const id of tried) { const r = await cli(dir, ['act', id, '--json'], 120_000); if (r.code === 0 && r.j?.accepted !== false) ok.push(id); }
        await cli(dir, ['stop', '--json'], 60_000);
        ids[w.template] = { ...ids[w.template], walk: ok, refusedWalks: tried.length - ok.length, checked: true };
        log(`fixture ${w.template}: ${ok.length} of ${tried.length} walks accepted`);
      }
    }
    await stopWorld(w.slug);
    w.builtS = +((Date.now() - tw) / 1000).toFixed(1);
    log(`fixture ${w.slug} (${w.template}): booted ${w.bootS} s, ${w.souls} Soul(s), done in ${w.builtS} s`);
  };
  await Promise.all(Array.from({ length: BUILD_PAR }, async () => { while (next < worlds.length) { const w = worlds[next++]; try { await one(w); } catch (e) { failed.push({ slug: w.slug, error: clean(e.message) }); log(`fixture ${w.slug}: ${e.message}`); await stopWorld(w.slug); } } }));
  await stopLauncher();
  const fx = { schema: 'hundred-fixture/1', commit: R.commit, port: PORT, small: N_SMALL, eden: N_EDEN, builtS: Math.round((Date.now() - t0) / 1000), worlds, ids, failed };
  writeFileSync(join(FIX, 'fixture.json'), JSON.stringify(fx, null, 1) + '\n');
  return fx;
}
function loadFixture(src) {
  cpSync(resolve(src), FIX, { recursive: true });   // the run changes its copy only
  const fx = JSON.parse(readFileSync(join(FIX, 'fixture.json'), 'utf8'));
  for (const w of fx.worlds) for (const d of w.dirs ?? []) { const f = join(FIX, d, '.eden-agent.json'), a = agentOf(join(FIX, d)); if (a.world) writeFileSync(f, JSON.stringify({ ...a, world: `${ORIGIN}/w/${w.slug}` }) + '\n', { mode: 0o600 }); }
  return fx;
}

// ------------------------------------------------------------------ samples: worlds in memory, loads, processor, memory
const tree = (root) => { const t = (sh('ps', ['-A', '-o', 'pid=,ppid=,rss=']) ?? '').split('\n').map((l) => l.trim().split(/\s+/).map(Number)); const out = new Map([[root, 0]]); for (let grew = true; grew; ) { grew = false; for (const [p, pp, rss] of t) if (out.has(pp) && !out.has(p)) { out.set(p, rss); grew = true; } } for (const [p, , rss] of t) if (p === root) out.set(p, rss); return out; };
const cpuTicks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' '); return Number(f[11]) + Number(f[12]); } catch { return null; } };
const memAvailMb = () => { try { return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024); } catch { return null; } };
const samples = [], prevCpu = new Map();
let sampling = null;
async function sampleOnce() {
  if (!L) return;
  const at = Date.now(), p = await ps(), hz = (await getJ(`${ORIGIN}/__sim/healthz`, { ms: 5000 })).j, t = tree(L.pid);
  let ticks = 0, known = true; for (const pid of t.keys()) { const c = cpuTicks(pid); if (c == null) { known = false; continue; } ticks += c - (prevCpu.get(pid) ?? c); prevCpu.set(pid, c); }
  const last = samples.at(-1), dt = last ? (at - last.at) / 1000 : null;
  const st = Object.values(p?.worlds ?? {}).map((w) => w.status);
  samples.push({ at, inMem: st.filter((s) => s === 'running').length, starting: st.filter((s) => s === 'starting').length, failed: st.filter((s) => s === 'failed' || s === 'crashloop').length,
    status: Object.fromEntries(Object.entries(p?.worlds ?? {}).map(([k, v]) => [k, v.status])), loads: hz?.loads ?? null, memAvailableMb: hz?.memAvailableMb ?? memAvailMb(),
    processes: t.size, rssMb: Math.round([...t.values()].reduce((a, b) => a + b, 0) / 1024), cpuCores: known && dt ? +((ticks / 100) / dt).toFixed(2) : null });
}
const startSampling = (ms) => { clearInterval(sampling); sampling = setInterval(() => { sampleOnce().catch(() => {}); }, ms); };

// ------------------------------------------------------------------ listeners (a resident agent's long-poll, held open)
const listeners = new Set();
function listen(dir) {
  const h = { on: true, polls: 0, wakes: [] }; listeners.add(h);
  (async () => { while (h.on) { const r = await soulApi(dir, '/v1/edge/inbox/listen?timeoutMs=50000', { ms: 60_000 }); h.polls++; if (r.j?.inbox) h.wakes.push(Date.now()); if (!r.status) await sleep(1000); } })();
  return h;
}
function stopListeners() { for (const h of listeners) h.on = false; }

// ------------------------------------------------------------------ helpers on a world's own files (read-only)
const worldDir = (slug) => join(LDATA, 'worlds', slug);
function dbRead(slug, fn) { let db; try { db = new DatabaseSync(join(worldDir(slug), 'sim.db'), { readOnly: true }); return fn(db); } catch (e) { return { error: clean(e.message) }; } finally { db?.close(); } }
/** The tick a world last stopped at, from its own log line (SIM_BOOT_HASH). */
const stopTick = (slug) => { try { const m = [...readFileSync(join(LDATA, 'logs', `${slug}.log`), 'utf8').matchAll(/\[world\] \w+: state at tick (\d+):/g)].at(-1); return m ? Number(m[1]) : null; } catch { return null; } };
const reminderRows = (slug) => dbRead(slug, (db) => db.prepare('SELECT client_ref, due_real_ms, state, delivered_at FROM edge_personal_reminders_v1').all());
const childStill = async (slug) => { const port = (await ps())?.worlds?.[slug]?.port; return port ? (await getJ(`http://127.0.0.1:${port}/__sim/still`, { ms: 3000 })) : { status: 0, j: null }; };
const needsOf = (j) => { const find = (o, d = 0) => { if (!o || typeof o !== 'object' || d > 4) return null; if (o.needs && typeof o.needs === 'object') return o.needs; for (const v of Object.values(o)) { const x = find(v, d + 1); if (x) return x; } return null; }; return find(j); };

// ------------------------------------------------------------------ the run
async function run(fx) {
  const worlds = fx.worlds.filter((w) => w.dirs?.length), soulDir = (w, k = 0) => join(FIX, w.dirs[k]);
  const smalls = worlds.filter((w) => w.template === 'hello-hamlet'), edens = worlds.filter((w) => w.template === 'eden-2026');
  const a4 = [smalls[0], edens[0]].filter(Boolean), sampled = [...a4, smalls[1]].filter(Boolean), a5 = smalls.at(-1) && !a4.includes(smalls.at(-1)) ? smalls.at(-1) : null;
  R.worlds = { registered: fx.worlds.length, withSouls: worlds.length, small: smalls.length, eden: edens.length, a4: a4.map((w) => w.slug), sampled: sampled.map((w) => w.slug), a5: a5?.slug ?? null };
  await startLauncher({ unload: true });
  R.launcher = { memoryFigure: L.memSupported ? `--worlds-mem-mb ${MEM_MB}` : `missing #2233: --max-running ${L.cfg.maxRunning} (${MEM_MB} MB / ${SMALL_MB} MB a small world)` };
  startSampling(5000);

  // A6: every world's first Soul acts at seeded gaps: a walk, then a held sit, for ACTIVE_MS
  const acts = [], t0 = Date.now(), end = t0 + ACTIVE_MS;
  log(`A6: ${worlds.length} agents act every ${ACT_LO}-${ACT_HI} min for ${ACTIVE_MS / 60_000} min`);
  await Promise.all(worlds.map(async (w, i) => {
    const rnd = mulberry(SEED * 1000 + i), dir = soulDir(w), ids = fx.ids[w.template] ?? {}, walks = ids.walk?.length ? ids.walk : ['sit-ground:here'];   // a world with no walk to offer sits instead
    for (const [k, at] of gapsFor(rnd, t0, end, ACT_LO * 60_000, ACT_HI * 60_000).entries()) {
      await sleep(at - Date.now());
      const before = samples.at(-1)?.status?.[w.slug] ?? null, walk = k % 2 === 0;
      const args = walk ? ['act', walks[Math.floor(rnd() * walks.length)], '--json'] : ['act', 'sit-ground:here', JSON.stringify({ seconds: holdSecondsFor(rnd, SHORT) }), '--json'];
      const r = await cli(dir, args, 120_000);
      const code = r.j?.code ?? (r.j?.accepted === false ? 'refused' : r.code == null ? 'timeout' : r.code ? `exit-${r.code}` : null);
      acts.push({ slug: w.slug, eden: w.template === 'eden-2026', kind: walk ? 'walk' : 'held', at, ms: r.ms, before, ok: r.code === 0 && r.j?.accepted !== false, code, waits: r.waits, ...(r.code === 0 && r.j?.accepted !== false ? {} : { said: clean(r.err.trim().split('\n').at(-1) || r.out.slice(0, 200)).slice(0, 200) }) });
    }
  }));
  // the needs and the kept live picture of every world, as the agents fall silent (one read each; the world is loaded now)
  const silentAt = Date.now(), before = {};
  for (const w of worlds) before[w.slug] = { live: (await getJ(`${ORIGIN}/w/${w.slug}/v1/edge/live`, { headers: { 'x-soul-client': 'bench/1' } })).j?.clock ?? null, needs: a4.includes(w) ? needsOf((await soulApi(soulDir(w), '/v1/edge/here')).j) : undefined };
  const win = samples.filter((s) => s.at >= t0 && s.at <= end);
  R.a6 = { ...summarizeActs(acts, win), fractionInMemory: inMemoryFractions(win), timeline: win.map(({ status, ...s }) => ({ ...s, at: Math.round((s.at - t0) / 1000) })) };
  log(`A6: ${acts.length} acts, ${R.a6.failed} failed, ${R.a6.refused} refused, added wait p50 ${R.a6.addedWaitMs.p50} p95 ${R.a6.addedWaitMs.p95} max ${R.a6.addedWaitMs.max} ms; in memory at most ${R.a6.inMemMax}`);
  save();

  // A7 + A5: listeners and reminders. Every world but the A4 pair listens; all but the A5 world share one instant.
  const sharedAt = silentAt + SETTLE_MS + 60_000, a5At = silentAt + SETTLE_MS + GAP_MS / 2, rem = {};
  for (const w of worlds.filter((x) => !a4.includes(x))) {
    const at = w === a5 ? a5At : sharedAt;
    const r = await soulApi(soulDir(w), '/v1/edge/reminders', { method: 'POST', body: { clientRef: `hundred-${w.slug}`, text: 'The hundred-world bench: a reminder.', at: { clock: 'real', time: new Date(at).toISOString() } } });
    rem[w.slug] = { at, status: r.status, code: r.j?.error?.code ?? r.error ?? null };
    listen(soulDir(w));
  }
  log(`A7: ${Object.values(rem).filter((x) => x.status === 200).length} reminders set (shared at +${Math.round((sharedAt - silentAt) / 1000)} s), ${listeners.size} listeners`);

  // A3: every world unloads after the wind-down
  const unloadedAt = {}; let allOut = null;
  for (let t = Date.now(); Date.now() < silentAt + SETTLE_MS + 30_000; await sleep(5000)) {
    const p = await ps(); for (const [s, v] of Object.entries(p?.worlds ?? {})) if (v.status !== 'running' && v.status !== 'starting' && !unloadedAt[s]) unloadedAt[s] = Date.now(); else if (v.status === 'running') delete unloadedAt[s];
    if (Object.keys(p?.worlds ?? {}).every((s) => unloadedAt[s])) { allOut = Date.now(); break; }
  }
  const p3 = await ps(), t3 = tree(L.pid), clocks = {};
  for (const w of worlds) { const r = await getJ(`${ORIGIN}/w/${w.slug}/v1/edge/live`, { headers: { 'x-soul-client': 'bench/1' } }); clocks[w.slug] = { status: r.status, cache: r.h?.get?.('x-sim-cache') ?? null, clock: r.j?.clock ?? null, readAt: Date.now() }; }
  R.a3 = { shown: !!allOut, allUnloadedAfterS: allOut ? Math.round((allOut - silentAt) / 1000) : null, stillRunning: Object.entries(p3?.worlds ?? {}).filter(([, v]) => v.status === 'running').map(([s]) => s),
    processes: [...t3.keys()].map((pid) => ({ pid: pid === L.pid ? 'launcher' : 'child', command: clean(sh('ps', ['-o', 'args=', '-p', String(pid)])).slice(0, 120) })), rssMb: Math.round([...t3.values()].reduce((a, b) => a + b, 0) / 1024), memAvailableMb: memAvailMb(),
    clocks: Object.fromEntries(Object.entries(clocks).map(([s, c]) => [s, { status: c.status, cache: c.cache, clock: c.clock }])), horizons: p3?.horizons ?? {} };
  log(`A3: ${allOut ? `every world unloaded ${R.a3.allUnloadedAfterS} s after the agents fell silent` : `not shown: ${R.a3.stillRunning.length} world(s) still in memory`}; ${R.a3.processes.length} process(es), ${R.a3.rssMb} MB`);
  save();

  // A7: the shared instant (loads never past the limit, every world served and unloaded again), then a crawler fetch
  startSampling(1000);
  await sleep(sharedAt - Date.now() + 5000);
  const w7 = Date.now(); let again = null;
  for (; Date.now() - w7 < QUIET_MS + 5 * 60_000; await sleep(5000)) { const p = await ps(); if (Object.values(p?.worlds ?? {}).every((v) => v.status !== 'running' && v.status !== 'starting')) { again = Date.now(); break; } }
  startSampling(5000);
  const around = samples.filter((s) => s.at >= sharedAt - 5000 && s.at <= (again ?? Date.now()));
  const delivered = Object.fromEntries(worlds.filter((w) => rem[w.slug] && w !== a5).map((w) => [w.slug, reminderRows(w.slug)]));
  const late = Object.values(delivered).flatMap((rows) => (Array.isArray(rows) ? rows : [])).map((r) => (r.delivered_at ? r.delivered_at - r.due_real_ms : null));
  const crawl = { before: (await ps())?.worlds, refused: 0 };
  for (const w of worlds) { const r = await fetch(`${ORIGIN}/w/${w.slug}/`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, signal: AbortSignal.timeout(30_000) }).catch(() => null); if (!r || r.status >= 400) crawl.refused++; await r?.arrayBuffer().catch(() => null); }
  await sleep(10_000);
  const after = (await ps())?.worlds ?? {};
  R.a7 = { reminderAnswers: Object.values(rem).reduce((o, x) => { const k = x.code ?? `http-${x.status}`; o[k] = (o[k] ?? 0) + 1; return o; }, {}), sharedAtS: Math.round((sharedAt - silentAt) / 1000), maxStartingAtOnce: Math.max(0, ...around.map((s) => s.starting)), maxLoadsReported: around.some((s) => s.loads) ? around.map((s) => s.loads) .filter(Boolean).at(-1) : null,
    allUnloadedAgainAfterS: again ? Math.round((again - sharedAt) / 1000) : null, failed: Math.max(0, ...around.map((s) => s.failed)), remindersDelivered: late.filter((x) => x != null).length, remindersSet: Object.keys(delivered).length,
    deliveryLateMs: pct(late.filter((x) => x != null)), crawl: { pages: worlds.length, refused: crawl.refused, loaded: Object.entries(after).filter(([s, v]) => v.status !== crawl.before?.[s]?.status && (v.status === 'running' || v.status === 'starting')).map(([s]) => s) } };
  log(`A7: at most ${R.a7.maxStartingAtOnce} loading at once; ${R.a7.remindersDelivered}/${R.a7.remindersSet} reminders delivered; crawler loaded ${R.a7.crawl.loaded.length} world(s)`);
  save();

  // A4 after the gap (from the moment the pair's worlds unloaded); A5's reminder is due inside it
  const gapFrom = Math.max(...a4.map((w) => unloadedAt[w.slug] ?? Date.now()));
  await sleep(gapFrom + GAP_MS - Date.now());
  R.a4 = {};
  for (const w of a4) {
    const f0 = stopTick(w.slug), wasIn = (await ps())?.worlds?.[w.slug]?.status;
    const walks = fx.ids[w.template]?.walk?.length ? fx.ids[w.template].walk : ['sit-ground:here'], t = Date.now();
    const r = await cli(soulDir(w), ['act', walks[0], '--json'], 120_000);
    const still = await childStill(w.slug), here = await soulApi(soulDir(w), '/v1/edge/here');
    R.a4[w.slug] = { template: w.template, statusBefore: wasIn, gapS: Math.round((t - (unloadedAt[w.slug] ?? t)) / 1000), actMs: r.ms, accepted: r.j?.accepted ?? null, code: r.j?.code ?? null,
      tickAtUnload: f0, still: still.status === 200 ? still.j : `missing (${still.status || 'no answer'}) #2297`,
      ticksMoved: f0 != null && Number.isFinite(still.j?.tick) ? still.j.tick - f0 : null, ticksForGap: Math.round((t - (unloadedAt[w.slug] ?? t)) / 50), needsBefore: before[w.slug]?.needs ?? null, needsAfter: needsOf(here.j) };
    log(`A4 ${w.slug}: act ${r.ms} ms (${r.j?.accepted === false ? `refused ${r.j?.code}` : 'accepted'}), world was ${wasIn}, ticks moved ${R.a4[w.slug].ticksMoved ?? '?'} for ${R.a4[w.slug].ticksForGap} in the gap`);
  }
  if (a5) {
    const rows = reminderRows(a5.slug), loads = L.lines.filter((l) => l.s.includes(`${a5.slug} loaded by its alarm`)).map((l) => l.at), unloads = L.lines.filter((l) => l.s.includes(`${a5.slug} unloaded`)).map((l) => l.at);
    const row = Array.isArray(rows) ? rows.find((x) => x.client_ref === `hundred-${a5.slug}`) : null;
    R.a5 = { slug: a5.slug, dueInGapS: Math.round((a5At - silentAt) / 1000), state: row?.state ?? null, deliveredLateMs: row?.delivered_at ? row.delivered_at - row.due_real_ms : null, alarmLoads: loads.filter((x) => x >= a5At - 60_000).length, unloadedAfter: unloads.some((x) => x > a5At) };
    log(`A5 ${a5.slug}: reminder ${R.a5.state ?? 'not found'}${R.a5.deliveredLateMs != null ? `, ${R.a5.deliveredLateMs} ms after due` : ''}; alarm loads ${R.a5.alarmLoads}; unloaded again ${R.a5.unloadedAfter}`);
  }
  stopListeners(); clearInterval(sampling);
  R.loadAfter = loadavg().map((x) => +x.toFixed(2));
  save();
  await stopLauncher();

  // A2: twins, ticked straight through from the fixture's start over each sampled world's own log
  R.a2 = {};
  for (const w of sampled) R.a2[w.slug] = await twin(w);
}
async function twin(w) {
  // the jumped world's own last stop: its state hash at the tick it stopped (SIM_BOOT_HASH, printed by the world)
  let text = ''; try { text = readFileSync(join(LDATA, 'logs', `${w.slug}.log`), 'utf8'); } catch { /* none */ }
  const stop = [...text.matchAll(/\[world\] \w+: state at tick (\d+): ([0-9a-f]{16,})/g)].at(-1);
  if (!stop) return { shown: false, why: 'the world printed no state hash at its stop' };
  const T = Number(stop[1]), H = stop[2], dir = join(OUT, 'twins', w.slug), data = join(dir, 'data'); mkdirSync(dir, { recursive: true });
  cpSync(worldDir(w.slug), data, { recursive: true });
  const { defaultCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/children.mjs')).href);
  const { decorateCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/production.mjs')).href);
  const base = defaultCommand({ slug: w.slug, dataDir: data, name: `Twin ${w.slug}`, templateFile: join(ROOT, 'worlds/templates', `${w.template}.json`) }, RANGE[0], { publicOrigin: `http://127.0.0.1:${RANGE[0]}`, marsWebDir: MARS_WEB, root: ROOT, libraryDir: join(dir, 'library') });
  const { cmd, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: `http://127.0.0.1:${RANGE[0]}`, base: '', worldHeapMb: 0, build: 'dev' });
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES')) delete env[k];
  // the world's own command, with the twin in place of the server's entry (node flags kept)
  const at = args.findIndex((a) => /apps\/server\/src\/main\.ts$/.test(String(a)));
  if (at < 0) return { shown: false, why: 'the world command has no apps/server/src/main.ts entry' };
  const twinArgs = [...args.slice(0, at), join(ROOT, 'tools/bench/capacity/hundred/twin.ts'), String(T)];
  const r = await new Promise((done) => { const p = spawn(cmd, twinArgs, { cwd: ROOT, env: { ...env, SIM_SKIP: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err = (err + d).slice(-4000); }); const k = setTimeout(() => p.kill('SIGKILL'), 30 * 60_000); p.on('exit', (code) => { clearTimeout(k); done({ code, out, err }); }); });
  writeFileSync(join(dir, 'twin.log'), r.out + r.err);
  let j = null; try { j = JSON.parse(r.out.trim().split('\n').at(-1)); } catch { /* no answer */ }
  const out = j ? { shown: true, stopTick: T, twinTick: j.tick, events: j.events, replayS: +(j.ms / 1000).toFixed(1), hashAtStop: H.slice(0, 16), twinHash: j.stateHash.slice(0, 16), equal: j.tick === T && j.stateHash === H }
    : { shown: false, stopTick: T, why: clean(r.err.trim().split('\n').slice(-2).join(' | ')).slice(0, 300) };
  log(`A2 ${w.slug}: twin ticked ${T} ticks from genesis over ${out.events ?? '?'} events: ${out.shown ? (out.equal ? 'state hash equal' : 'state hash DIFFERS') : `not shown (${out.why})`}`);
  return out;
}

// ------------------------------------------------------------------ report
function report() {
  const f = (x) => (x == null ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x)), L2 = [];
  L2.push(`# A hundred worlds at once (#2301)`, '', `commit ${f(R.commit?.slice(0, 9))} · node ${R.node} · ${R.cpus} CPUs · ${R.memGb} GB · load ${R.loadBefore.join(' ')} → ${f(R.loadAfter?.join(' '))}${SHORT ? ' · SHORT knobs (stated below)' : ''}`, '');
  L2.push(`Knobs: ${f(R.knobs)}`, '', '## Missing from this checkout', '', ...(R.missing.length ? R.missing.map((m) => `- ${m.what} (${m.issue}): ${m.effect}`) : ['- nothing: every piece the script looks for is present']), '');
  if (R.fixture) L2.push('## A1 fixture', '', `${R.fixture.small} small + ${R.fixture.eden} Eden-class worlds, built in ${R.fixture.builtS} s; Souls: ${R.fixture.souls}; failed: ${R.fixture.failed.length ? R.fixture.failed.map((x) => `${x.slug} (${x.error})`).join(', ') : 'none'}. Boot s: small p50 ${f(R.fixture.bootSmall?.p50)}, Eden p50 ${f(R.fixture.bootEden?.p50)}.`, '');
  if (R.a6) L2.push('## A6 a hundred in use', '', `Memory: ${R.launcher.memoryFigure}.`, '', '| acts | failed | refused | waits retried | added wait p50 / p95 / max ms | in memory (max) | loading at once (max) | processor cores p50 / max | fraction of the time in memory, per world p50 / max |', '|---|---|---|---|---|---|---|---|---|',
    `| ${R.a6.acts} | ${R.a6.failed} | ${R.a6.refused} | ${R.a6.retried} | ${f(R.a6.addedWaitMs.p50)} / ${f(R.a6.addedWaitMs.p95)} / ${f(R.a6.addedWaitMs.max)} | ${R.a6.inMemMax} | ${f(R.a6.startingMax)} | ${f(R.a6.cpu?.p50)} / ${f(R.a6.cpu?.max)} | ${f(R.a6.fractionInMemory.p50)} / ${f(R.a6.fractionInMemory.max)} |`, '', `Codes: ${f(R.a6.codes)}`, '');
  if (R.a3) L2.push('## A3 really out of memory', '', R.a3.shown ? `Every world unloaded ${R.a3.allUnloadedAfterS} s after the agents fell silent.` : `Not shown: ${R.a3.stillRunning.length} world(s) still in memory at the end of the wait (${R.a3.stillRunning.slice(0, 12).join(', ')}).`, `Processes: ${R.a3.processes.map((p) => p.pid).join(', ')} (${R.a3.processes.length}); their memory ${R.a3.rssMb} MB; host available ${f(R.a3.memAvailableMb)} MB. Clocks read from the kept live picture: ${Object.values(R.a3.clocks).filter((c) => c.cache === 'unloaded').length} of ${Object.keys(R.a3.clocks).length} served unloaded.`, '');
  if (R.a7) L2.push('## A7 everything at once', '', `Shared instant at +${R.a7.sharedAtS} s: at most ${R.a7.maxStartingAtOnce} worlds loading at once (launcher loads data: ${f(R.a7.maxLoadsReported)}); reminders delivered ${R.a7.remindersDelivered} of ${R.a7.remindersSet}, late p50 ${f(R.a7.deliveryLateMs.p50)} max ${f(R.a7.deliveryLateMs.max)} ms; failed ${R.a7.failed}; all unloaded again after ${f(R.a7.allUnloadedAgainAfterS)} s. Crawler fetch of ${R.a7.crawl.pages} pages: ${R.a7.crawl.refused} refused, loaded ${R.a7.crawl.loaded.length} world(s).`, '');
  if (R.a4) L2.push('## A4 exact on return', '', '| world | status before | gap s | act ms | accepted | ticks moved / for the gap | counters |', '|---|---|---|---|---|---|---|', ...Object.entries(R.a4).map(([s, a]) => `| ${s} (${a.template}) | ${f(a.statusBefore)} | ${a.gapS} | ${a.actMs} | ${f(a.accepted)}${a.code ? ` ${a.code}` : ''} | ${f(a.ticksMoved)} / ${a.ticksForGap} | ${typeof a.still === 'string' ? a.still : f(Object.fromEntries(Object.entries(a.still ?? {}).filter(([k]) => /tick|jump/i.test(k))))} |`), '', `Needs before → after: ${Object.entries(R.a4).map(([s, a]) => `${s} ${f(a.needsBefore)} → ${f(a.needsAfter)}`).join('; ')}`, '');
  if (R.a5) L2.push('## A5 listening', '', `${R.a5.slug}: reminder due +${R.a5.dueInGapS} s, ${f(R.a5.state)}${R.a5.deliveredLateMs != null ? ` ${R.a5.deliveredLateMs} ms after due` : ''}; loads by its alarm ${R.a5.alarmLoads}; unloaded again ${R.a5.unloadedAfter}.`, '');
  if (R.a2) L2.push('## A2 same state', '', '| world | stop tick (jumped world) | twin: ticks from genesis | log events folded | twin s | state hash equal |', '|---|---|---|---|---|---|', ...Object.entries(R.a2).map(([s, a]) => `| ${s} | ${f(a.stopTick)} | ${f(a.twinTick)} | ${f(a.events)} | ${f(a.replayS)} | ${!a.shown ? `not shown: ${a.why}` : a.equal ? `yes (${a.hashAtStop}…)` : `NO: ${a.hashAtStop}… vs ${a.twinHash}…`} |`), '');
  writeFileSync(join(OUT, 'REPORT.md'), L2.join('\n') + '\n');
}

// ------------------------------------------------------------------ main
try {
  log(`hundred: ${N_SMALL} small + ${N_EDEN} Eden-class worlds, commit ${R.commit?.slice(0, 9)}${SHORT ? ', short knobs' : ''}`);
  const fx = opt('fixture') ? loadFixture(opt('fixture')) : await buildFixture();
  const boots = (t) => pct(fx.worlds.filter((w) => w.template === t && w.bootS != null).map((w) => w.bootS));
  R.fixture = { small: fx.small, eden: fx.eden, builtS: fx.builtS, souls: fx.worlds.reduce((n, w) => n + (w.dirs?.length ?? 0), 0), failed: fx.failed, bootSmall: boots('hello-hamlet'), bootEden: boots('eden-2026'), reused: !!opt('fixture') };
  log(`A1: fixture ${R.fixture.reused ? 'copied' : `built in ${fx.builtS} s`}: ${fx.worlds.length} worlds, ${R.fixture.souls} Souls, ${fx.failed.length} failed`);
  save();
  if (!flag('fixture-only')) await run(fx);
} catch (e) { R.error = clean(e.stack ?? e.message); log(`error: ${e.message}`); process.exitCode = 1; }
finally { stopListeners(); clearInterval(sampling); await stopLauncher(); save(); report(); log('done: REPORT.md'); }
