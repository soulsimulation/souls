#!/usr/bin/env node
// #2240: what a settled world holds in memory, how much of it is slack, and its disk. Per world (a small fresh world from
// `hello-hamlet`, a fresh Eden 2026) and per Soul count (0 or 10 joined Souls that never act), fake minds, Eyes off:
//   A1  after --settle-min minutes at the present heap limit (the launcher's own worldHeapMb for that template): RSS, Pss
//       and Private (Private_Clean + Private_Dirty) of the world process from /proc/<pid>/smaps_rollup (Linux only);
//   A2  the same world booted again with the heap limit set just above its need (the peak V8 heap the first run's
//       live.json showed from boot on, plus 25 %, rounded up to 64 MB), measured the same way;
//   A3  the data directory's size when new (healthz up) and at the end (the first hourly backup lands at 60 s), and
//       the database's growth over the run, from which the 24 h size with the hourly backups is worked out.
// Each world is booted directly with the checkout's launcher command and production decoration in an isolated data dir
// under --out. Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `settled`) on a souls-timed
// runner; locally only as a smoke (`--short`: one minute, figures indicative).
//
//   node tools/bench/capacity/settled/settled.mjs [--world small,eden] [--souls 0,10] [--settle-min 10] [--out <dir>]
//        [--port 4700] [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, settled.log} and <out>/<world>-n<souls>-<limit>/{world.log, world-command.json}.
// No host name, user, home path or token in results.json or REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4700)), SETTLE_MS = Number(opt('settle-min', SHORT ? 1 : 10)) * 60_000;
const WORLDS = { small: 'hello-hamlet', eden: 'eden-2026' };
const WORLD_LIST = opt('world', 'small,eden').split(','), SOUL_LIST = opt('souls', '0,10').split(',').map(Number);
for (const w of WORLD_LIST) if (!WORLDS[w]) throw new Error(`--world ${w}: ${Object.keys(WORLDS).join(' | ')}`);
const OUT = resolve(opt('out', join(ROOT, '.local/bench/settled', new Date().toISOString().replace(/[:.]/g, '-'))));
const { defaultCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/children.mjs')).href);
const { decorateCommand } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/production.mjs')).href);
const { worldHeapMb } = await import(pathToFileURL(join(ROOT, 'tools/world-launcher/registry.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const mb = (b) => (b == null ? null : +(b / 2 ** 20).toFixed(1));
mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); appendFileSync(join(OUT, 'settled.log'), s + '\n'); };
const MARS_WEB = join(ROOT, 'mars/viewer/dist'), KIT = join(ROOT, 'apps/web/dist/kit-contract.json');
for (const [p, fix] of [[MARS_WEB, 'pnpm build:viewer'], [KIT, 'pnpm --filter @souls/web build']]) if (!existsSync(p)) throw new Error(`missing ${relative(ROOT, p)}: run \`${fix}\` in the checkout`);

// ------------------------------------------------------------------ memory and disk facts
/** The world process and its descendants (a direct boot is one node process; any helper process is counted with it). */
function tree(pid) { const out = [pid], q = [pid]; while (q.length) for (const c of (sh('pgrep', ['-P', String(q.shift())]) ?? '').split('\n').map(Number).filter(Boolean)) { out.push(c); q.push(c); } return out; }
/** Summed smaps_rollup of the tree, in bytes: rss, pss, private (clean + dirty), swap. null where not Linux. */
function smaps(pid) {
  const sum = { rss: 0, pss: 0, private: 0, swap: 0, processes: 0 };
  for (const p of tree(pid)) {
    let t; try { t = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'); } catch { continue; }
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t)?.[1] ?? 0) * 1024;
    sum.rss += kb('Rss'); sum.pss += kb('Pss'); sum.private += kb('Private_Clean') + kb('Private_Dirty'); sum.swap += kb('Swap'); sum.processes++;
  }
  return sum.processes ? sum : null;
}
const psRss = (pid) => { const r = sh('ps', ['-o', 'rss=', '-p', String(pid)]); return r ? Number(r) * 1024 : null; };
function du(dir) { let n = 0; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); n += e.isDirectory() ? du(p) : statSync(p).size; } return n; }
const files = (dir) => readdirSync(dir).map((f) => ({ f, bytes: statSync(join(dir, f)).size })).filter((x) => /\.db(-wal|-shm)?$|\.sqlite/.test(x.f));
const dbBytes = (dir) => ['sim.db', 'sim.db-wal'].reduce((s, f) => s + (existsSync(join(dir, f)) ? statSync(join(dir, f)).size : 0), 0);
const liveOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')); } catch { return null; } };

// ------------------------------------------------------------------ one world
const LIVE = new Set();
async function getJ(url, ms = 5000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null) }; } catch { return { status: 0, j: null }; } }
async function bootWorld(dir, { slug, template, heapMb }) {
  const data = join(dir, 'data'), library = join(dir, 'library'); mkdirSync(data, { recursive: true }); mkdirSync(library, { recursive: true });
  const soul = (f) => join(ROOT, 'tools/world-launcher/soul', f), origin = `http://127.0.0.1:${PORT}`;
  const base = defaultCommand({ slug, dataDir: data, name: `Settled ${slug}`, templateFile: join(ROOT, 'worlds/templates', `${template}.json`) }, PORT,
    { publicOrigin: origin, marsWebDir: MARS_WEB, root: ROOT, libraryDir: library, soulControllerCliFile: soul('eden.mjs'), soulCliFile: soul('eden-agent.mjs'), soulSkillFile: soul('skill.md'), soulInstructionsFile: soul('instructions.md') });
  const { cmd: node, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: heapMb, build: 'dev' });
  Object.assign(env, { MIND_DRIVER: 'edge', BRAIN_MODE: 'fake' });
  for (const k of Object.keys(env)) if (k.startsWith('EDGE_EYES')) delete env[k];   // no renders (Eyes off)
  writeFileSync(join(dir, 'world-command.json'), JSON.stringify({ cmd: [node, ...args].map((x) => String(x).split(ROOT).join('.')), env: Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN|SECRET/.test(k)).map(([k, v]) => [k, String(v).split(ROOT).join('.')])) }, null, 1));
  const child = spawn(node, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = ''; const wl = (b) => { tail = (tail + b).slice(-4000); appendFileSync(join(dir, 'world.log'), b); };
  child.stdout.on('data', wl); child.stderr.on('data', wl);
  const w = { slug, child, data, origin, t0: Date.now(), peakHeapMb: 0 }; LIVE.add(w);
  // the V8 heap's high mark from boot on (live.json, every 2 s): the world's need includes its load and the joins
  w.sampler = setInterval(() => { const h = liveOf(data)?.heap; if (h) w.peakHeapMb = Math.max(w.peakHeapMb, h.usedMb ?? 0); }, 2000);
  const t0 = Date.now();
  while (!(await getJ(`${origin}/healthz`, 3000)).j?.ok) {
    if (child.exitCode != null) throw new Error(`${slug} exited at boot (${child.exitCode}): ${tail.trim().split('\n').slice(-4).join(' | ').split(ROOT).join('.')}`);
    if (Date.now() - t0 > 900_000) throw new Error(`${slug} did not answer /healthz in 15 min`);
    await sleep(1000);
  }
  return Object.assign(w, { bootS: +((Date.now() - t0) / 1000).toFixed(1), tail: () => tail.trim().split('\n').slice(-4).join(' | ').split(ROOT).join('.') });
}
async function stopWorld(w) {
  clearInterval(w?.sampler);
  if (!w?.child || w.child.exitCode != null) return;
  w.child.kill('SIGTERM'); for (let k = 0; k < 60 && w.child.exitCode == null; k++) await sleep(500);
  if (w.child.exitCode == null) { w.child.kill('SIGKILL'); await sleep(500); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig})`); await Promise.all([...LIVE].map(stopWorld)); process.exit(130); });

// ------------------------------------------------------------------ Souls that join and never act (the checkout's own CLI, dev identity)
function runCli(dir, args, ms) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-500); }); p.stdout.resume();
    const k = setTimeout(() => p.kill('SIGKILL'), ms); p.on('exit', (code) => { clearTimeout(k); done({ code, err: err.trim().split('\n').at(-1) ?? '' }); });
  });
}
/** The CLI wants a world URL …/w/<slug>; a directly booted world has no such prefix, so a loopback proxy strips it. */
async function joinProxy(w) {
  const prefix = `/w/${w.slug}`, target = new URL(w.origin);
  const srv = createServer((req, res) => {
    const path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || '/' : req.url;
    const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((ok) => srv.listen(PORT + 1, '127.0.0.1', ok));
  return { url: `http://localhost:${PORT + 1}${prefix}`, close: () => new Promise((ok) => srv.close(ok)) };
}
async function joinSoul(dir, w, url, i) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eden.mjs'), Buffer.from(await (await fetch(`${w.origin}/eden.mjs`)).arrayBuffer()));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `agent-settled-${w.slug}-${i}` }) + '\n', { mode: 0o600 });
  const reg = await runCli(dir, ['register', url], 60_000); if (reg.code) log(`soul ${i} register: ${reg.code} ${reg.err.split(ROOT).join('.')}`);
  const token = () => { try { return JSON.parse(readFileSync(join(dir, '.eden-agent.json'), 'utf8')).token ?? null; } catch { return null; } };
  for (let k = 0; !token() && k < 3; k++) { const r = await runCli(dir, ['create', `Still${i}`], 150_000); if (!token()) { log(`soul ${i} create: ${r.code} ${r.err.split(ROOT).join('.')}`); await sleep(2000); } }
  if (!token()) throw new Error(`soul ${i} did not join`);
}

// ------------------------------------------------------------------ one arm: boot, join, settle, measure
async function arm(world, souls, limit, heapMb) {
  const id = `${world}-n${souls}-${limit}`, dir = join(OUT, id), template = WORLDS[world];
  log(`${id}: boot ${template} at heap ${heapMb} MB`);
  const w = await bootWorld(dir, { slug: `st-${world}`, template, heapMb });
  const r = { id, world, template, souls, limit, heapMb, bootS: w.bootS, newDirBytes: du(w.data) };
  try {
    if (souls) { const jp = await joinProxy(w); try { for (let i = 0; i < souls; i++) await joinSoul(join(dir, 'souls', `s${i}`), w, jp.url, i); } finally { await jp.close(); } }
    r.joinedS = +((Date.now() - w.t0) / 1000).toFixed(1);
    const t0 = Date.now(); let heapLimitMb = null, db0 = null, t1 = null;
    while (Date.now() - t0 < SETTLE_MS) {
      if (w.child.exitCode != null) throw new Error(`world exited (${w.child.exitCode}) while settling: ${w.tail()}`);
      const h = liveOf(w.data)?.heap; if (h) heapLimitMb = h.limitMb ?? heapLimitMb;
      if (db0 == null && Date.now() - t0 > 90_000) { db0 = dbBytes(w.data); t1 = Date.now(); }   // after the first backup (60 s)
      await sleep(5000);
    }
    const m = smaps(w.child.pid), h = liveOf(w.data)?.heap;
    Object.assign(r, {
      settledMin: +((Date.now() - t0) / 60_000).toFixed(2), rssMb: mb(m?.rss ?? psRss(w.child.pid)), pssMb: mb(m?.pss), privateMb: mb(m?.private), swapMb: mb(m?.swap), processes: m?.processes ?? 1,
      heapUsedMb: h?.usedMb ?? null, heapLimitMb: h?.limitMb ?? heapLimitMb, peakHeapMb: Math.max(w.peakHeapMb, h?.usedMb ?? 0),
      endDirBytes: du(w.data), dbBytes: dbBytes(w.data), dbGrowthBytesPerHour: db0 == null ? null : Math.round(((dbBytes(w.data) - db0) * 3600_000) / Math.max(1, Date.now() - t1)), files: files(w.data),
    });
    log(`${id}: rss ${r.rssMb} MB, pss ${r.pssMb} MB, private ${r.privateMb} MB, heap ${r.heapUsedMb}/${r.heapLimitMb} MB (peak ${r.peakHeapMb}), dir ${mb(r.newDirBytes)} -> ${mb(r.endDirBytes)} MB`);
  } catch (e) { r.error = String(e.message ?? e).split(ROOT).join('.'); log(`${id}: ${r.error}`); }
  finally { await stopWorld(w); LIVE.delete(w); }
  return r;
}

// ------------------------------------------------------------------ disk after 24 h (apps/server/src/main.ts pruneBackups)
// Hourly backups: the newest 6 files, plus the 00:00 UTC file of each of the last 8 days. After 24 h that is 6 hourly
// copies plus one or two midnight copies (7 counted here); after 8 days, 6 + 8 = 14. Each copy is the database at its hour.
function disk24h(r, gb = 100) {
  if (r.dbGrowthBytesPerHour == null) return null;
  const elapsedH = r.settledMin / 60, db24 = r.dbBytes + Math.max(0, r.dbGrowthBytesPerHour) * Math.max(0, 24 - elapsedH);
  const other = r.endDirBytes - r.files.reduce((s, x) => s + x.bytes, 0);   // everything but the databases (logs, live.json, small files)
  const accounts = r.files.filter((x) => !/^sim\.db|^backup-/.test(x.f)).reduce((s, x) => s + x.bytes, 0);
  const at24 = other + accounts + db24 * (1 + 7), steady = other + accounts + db24 * (1 + 14);
  return { db24Mb: mb(db24), dir24hMb: mb(at24), dirSteadyMb: mb(steady), worldsPer100GbAt24h: Math.floor((gb * 1e9) / at24), worldsPer100GbSteady: Math.floor((gb * 1e9) / steady) };
}

const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const receipt = { issue: 2240, commit, node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1), loadBefore: loadavg().map((x) => +x.toFixed(2)), settleMin: SETTLE_MS / 60_000, short: SHORT };
log(`settled: worlds ${WORLD_LIST.join(',')}, souls ${SOUL_LIST.join(',')}, ${SETTLE_MS / 60_000} min each, commit ${commit?.slice(0, 9)}`);
const results = [];
for (const world of WORLD_LIST) for (const souls of SOUL_LIST) {
  const present = await arm(world, souls, 'present', worldHeapMb({ template: WORLDS[world] }, 0)); results.push(present);
  if (present.error || !present.peakHeapMb) continue;
  results.push(await arm(world, souls, 'tight', Math.ceil((present.peakHeapMb * 1.25) / 64) * 64));
}
for (const r of results) if (!r.error) r.disk = disk24h(r);
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, results }, null, 1) + '\n');
const f = (x) => (x == null ? '—' : String(x));
const lines = [`# Settled world memory and disk (#2240)`, '', `commit ${f(commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs · ${receipt.memGb} GB · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${receipt.settleMin} min settle${SHORT ? ' · SHORT (indicative)' : ''}`, '',
  '| world | Souls | heap limit | RSS MB | Pss MB | Private MB | V8 heap used / peak MB | data dir new → end MB | db growth MB/h | dir at 24 h MB | worlds in 100 GB (24 h · steady) |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) => r.error ? `| ${r.template} | ${r.souls} | ${r.limit} ${r.heapMb} | error: ${r.error.slice(0, 120)} |||||||| ` :
    `| ${r.template} | ${r.souls} | ${r.limit} ${r.heapMb} | ${f(r.rssMb)} | ${f(r.pssMb)} | ${f(r.privateMb)} | ${f(r.heapUsedMb)} / ${f(r.peakHeapMb)} | ${mb(r.newDirBytes)} → ${mb(r.endDirBytes)} | ${f(mb(r.dbGrowthBytesPerHour))} | ${f(r.disk?.dir24hMb)} | ${f(r.disk?.worldsPer100GbAt24h)} · ${f(r.disk?.worldsPer100GbSteady)} |`)];
writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
log('done: REPORT.md');
