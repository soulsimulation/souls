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
// #2553 (what a joined Soul costs): `--souls` takes up to 300; `--raw` joins them with eval-load's raw driver (M3: create,
// pair, token from an address of its own, 8 at a time, then the catalog and live picture once) instead of the CLI;
// `--present-only` skips the tight-limit arm. `--heap-at 10,100` boots those arms with an inspector and, after the
// measurements above, records the main thread's and each worker's process.memoryUsage(), then a heap snapshot (after a
// forced collection), read by heap.mjs into what holds the heap (the menu caches, the replica and take state, the per-Soul
// stores, the rest, and the largest holders); the snapshot file is deleted once read. The report adds memory per Soul
// between each pair of Soul counts. `--wave` runs wave.mjs instead (A2: `--acting 50 --wave-n 200 --wave-per-sec 2
// --shape uniform|event --seed <k>`) and writes <out>/{wave.json, WAVE.md}.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rawJoin } from '../../../playtest/eval/load.mjs';
import { clientCall, clientHeaders, startPicture } from '../meetup/client-soul.mjs';
import { summarize as heapSummary } from './heap.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4700)), SETTLE_MS = Number(opt('settle-min', SHORT ? 1 : 10)) * 60_000;
const WORLDS = { small: 'hello-hamlet', eden: 'eden-2026' };
const WORLD_LIST = opt('world', 'small,eden').split(','), SOUL_LIST = opt('souls', '0,10').split(',').map(Number);
for (const w of WORLD_LIST) if (!WORLDS[w]) throw new Error(`--world ${w}: ${Object.keys(WORLDS).join(' | ')}`);
const RAW = flag('raw'), LOOK = flag('look'), PRESENT_ONLY = flag('present-only'), HEAP_AT = new Set(String(opt('heap-at', '')).split(',').filter(Boolean).map(Number)), INSPECT = PORT + 1;
if (SOUL_LIST.some((n) => !(n >= 0 && n <= 300))) throw new Error('--souls: 0 to 300 each');
if (HEAP_AT.size && !RAW) throw new Error('--heap-at needs --raw (the CLI join proxy uses the inspector\'s port)');
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
/** The world database's content, read-only beside the running world: bytes in use (pages not on the free list) and the
 *  snapshots' share (count and total text). Snapshots are pruned to the newest 5 plus one a day (db.ts), so they plateau;
 *  everything else is the growth a still world adds per hour. */
function dbContent(dir) {
  let db; try {
    db = new DatabaseSync(join(dir, 'sim.db'), { readOnly: true });
    const one = (q) => Object.values(db.prepare(q).get())[0];
    const used = (one('PRAGMA page_count') - one('PRAGMA freelist_count')) * one('PRAGMA page_size');
    const snap = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM snapshots').get();
    return { usedBytes: used, snapshots: Number(snap.n), snapshotBytes: Number(snap.bytes), otherBytes: used - Number(snap.bytes) };
  } catch (e) { return { error: String(e.message ?? e) }; } finally { db?.close(); }
}
const liveOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')); } catch { return null; } };

// ------------------------------------------------------------------ one world
const LIVE = new Set();
async function getJ(url, ms = 5000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, j: await r.json().catch(() => null) }; } catch { return { status: 0, j: null }; } }
async function bootWorld(dir, { slug, template, heapMb, env: extra = {}, nodeOptions = '', inspect = 0 }) {
  const data = join(dir, 'data'), library = join(dir, 'library'); mkdirSync(data, { recursive: true }); mkdirSync(library, { recursive: true });
  const soul = (f) => join(ROOT, 'tools/world-launcher/soul', f), origin = `http://127.0.0.1:${PORT}`;
  const base = defaultCommand({ slug, dataDir: data, name: `Settled ${slug}`, templateFile: join(ROOT, 'worlds/templates', `${template}.json`) }, PORT,
    { publicOrigin: origin, marsWebDir: MARS_WEB, root: ROOT, libraryDir: library, soulControllerCliFile: soul('eden.mjs'), soulCliFile: soul('eden-agent.mjs'), soulSkillFile: soul('skill.md'), soulInstructionsFile: soul('instructions.md') });
  const { cmd: node, args, env } = decorateCommand(base, { devAuth: true, publicOrigin: origin, base: '', worldHeapMb: heapMb, build: 'dev' });
  Object.assign(env, { MIND_DRIVER: 'edge', BRAIN_MODE: 'fake' }, extra);
  if (nodeOptions) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}${nodeOptions}`;
  if (inspect) { args.unshift(`--inspect=127.0.0.1:${inspect}`); env.SIM_STALL_STACK = '0'; }   // #2039: no stall stacks beside inspector calls
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

// ------------------------------------------------------------------ #2553: the heap, from the world's inspector
async function inspector(port) {
  let list = null; for (const t0 = Date.now(); !list?.[0] && Date.now() - t0 < 60_000;) { list = (await getJ(`http://127.0.0.1:${port}/json/list`, 15_000)).j; if (!list?.[0]) await sleep(2000); }
  if (!list?.[0]) throw new Error('the world\'s inspector listed no target in 60 s');
  const ws = new WebSocket(list[0].webSocketDebuggerUrl), wait = new Map(), events = new Map(); let id = 0;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m?.method) events.get(m.method)?.(m.params); const done = typeof m?.id === 'number' ? wait.get(m.id) : undefined; if (done) { wait.delete(m.id); done(m); } };
  ws.onclose = () => { for (const done of wait.values()) done({ error: 'inspector closed' }); wait.clear(); };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, on: (m, f) => events.set(m, f), close: () => ws.close() };
}
const USAGE = 'JSON.stringify(process.memoryUsage())';
/** process.memoryUsage() of the main thread and of each worker thread (its own isolate), then the main heap's snapshot
 *  (the inspector collects garbage first), read by heap.mjs. Outside the heap, memoryUsage's external and arrayBuffers
 *  are known; the rest of RSS (code, native allocations, the workers' heaps beyond their own figures) is not broken down. */
async function heapOf(dir, w) {
  const insp = await inspector(INSPECT), out = { workers: [] };
  try {
    const value = async (expression) => JSON.parse((await insp.send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value ?? 'null');
    const sessions = [], wwait = new Map(); let wid = 0;
    insp.on('NodeWorker.attachedToWorker', (p) => sessions.push({ id: p.sessionId, title: p.workerInfo?.title ?? '' }));
    insp.on('NodeWorker.receivedMessageFromWorker', (p) => { let m; try { m = JSON.parse(p.message); } catch { return; } wwait.get(m.id)?.(m); wwait.delete(m.id); });
    await insp.send('NodeWorker.enable', { waitForDebuggerOnStart: false }); await sleep(1000);
    for (const s of sessions) {
      const r = await Promise.race([sleep(10_000), new Promise((ok) => { const i = ++wid; wwait.set(i, ok); insp.send('NodeWorker.sendMessageToWorker', { sessionId: s.id, message: JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: USAGE, returnByValue: true } }) }); })]);
      const u = r ? JSON.parse(r.result?.result?.value ?? 'null') : null;
      out.workers.push({ title: s.title.split(ROOT).join('.'), heapUsedMb: mb(u?.heapUsed), externalMb: mb(u?.external), arrayBuffersMb: mb(u?.arrayBuffers) });
    }
    await insp.send('NodeWorker.disable');
    const u = await value(USAGE); Object.assign(out, { rssMb: mb(u?.rss), heapUsedMb: mb(u?.heapUsed), heapTotalMb: mb(u?.heapTotal), externalMb: mb(u?.external), arrayBuffersMb: mb(u?.arrayBuffers) });
    await insp.send('HeapProfiler.enable'); await insp.send('HeapProfiler.collectGarbage');
    const file = join(dir, 'main.heapsnapshot'); writeFileSync(file, ''); const t0 = Date.now();
    insp.on('HeapProfiler.addHeapSnapshotChunk', (p) => appendFileSync(file, p.chunk));
    const snap = await insp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    if (snap.error) throw new Error(`heap snapshot: ${JSON.stringify(snap.error).slice(0, 200)}`);
    out.snapshotS = +((Date.now() - t0) / 1000).toFixed(1); out.snapshotMb = mb(statSync(file).size);
    insp.close();
    const t1 = Date.now(); Object.assign(out, heapSummary(file)); out.readS = +((Date.now() - t1) / 1000).toFixed(1);
    rmSync(file, { force: true });
    log(`heap: ${out.totalMb} MB in the snapshot (${out.snapshotMb} MB file, ${out.snapshotS} s, read in ${out.readS} s): ${out.groups.map((g) => `${g.id} ${g.mb}`).join(', ')}`);
  } catch (e) { out.error = String(e.message ?? e).split(ROOT).join('.'); log(`heap: ${out.error}`); try { insp.close(); } catch { /* closed */ } }
  return out;
}

// ------------------------------------------------------------------ one arm: boot, join, settle, measure
async function arm(world, souls, limit, heapMb) {
  const id = `${world}-n${souls}-${limit}`, dir = join(OUT, id), template = WORLDS[world], heapAt = limit === 'present' && HEAP_AT.has(souls);
  log(`${id}: boot ${template} at heap ${heapMb} MB${heapAt ? ' (inspector on, for the heap snapshot)' : ''}`);
  const w = await bootWorld(dir, { slug: `st-${world}`, template, heapMb, inspect: heapAt ? INSPECT : 0 });
  const r = { id, world, template, souls, limit, heapMb, bootS: w.bootS, newDirBytes: du(w.data) };
  try {
    const joined = [];
    if (souls && RAW) for (let i = 0; i < souls; i += 8) await Promise.all(Array.from({ length: Math.min(8, souls - i) }, async (_, j) => { const s = await rawJoin(w.origin, i + j); await startPicture(w.origin, s); joined.push(s); }));
    else if (souls) { const jp = await joinProxy(w); try { for (let i = 0; i < souls; i++) await joinSoul(join(dir, 'souls', `s${i}`), w, jp.url, i); } finally { await jp.close(); } }
    r.joinedS = +((Date.now() - w.t0) / 1000).toFixed(1);
    const t0 = Date.now(); let heapLimitMb = null, c0 = null, t1 = null;
    while (Date.now() - t0 < SETTLE_MS) {
      if (w.child.exitCode != null) throw new Error(`world exited (${w.child.exitCode}) while settling: ${w.tail()}`);
      const h = liveOf(w.data)?.heap; if (h) heapLimitMb = h.limitMb ?? heapLimitMb;
      if (c0 == null && Date.now() - t0 > 90_000) { c0 = dbContent(w.data); t1 = Date.now(); }   // after the first backup (60 s)
      await sleep(5000);
    }
    const m = smaps(w.child.pid), h = liveOf(w.data)?.heap;
    Object.assign(r, {
      settledMin: +((Date.now() - t0) / 60_000).toFixed(2), rssMb: mb(m?.rss ?? psRss(w.child.pid)), pssMb: mb(m?.pss), privateMb: mb(m?.private), swapMb: mb(m?.swap), processes: m?.processes ?? 1,
      heapUsedMb: h?.usedMb ?? null, heapLimitMb: h?.limitMb ?? heapLimitMb, peakHeapMb: Math.max(w.peakHeapMb, h?.usedMb ?? 0),
      endDirBytes: du(w.data), dbBytes: dbBytes(w.data), content0: c0, content: dbContent(w.data), contentSpanMin: t1 ? +((Date.now() - t1) / 60_000).toFixed(2) : null, files: files(w.data),
    });
    r.otherGrowthBytesPerHour = r.content0?.otherBytes != null && r.content?.otherBytes != null && r.contentSpanMin ? Math.round(((r.content.otherBytes - r.content0.otherBytes) * 60) / r.contentSpanMin) : null;
    if (heapAt) r.heap = await heapOf(dir, w);
    if (LOOK && joined.length) {
      // #2553: each Soul looks once (here, with what it can do there, and its capability list), as an agent's first read
      // does; a minute later the same measurements again
      const reads = { ok: 0, failed: 0 };
      for (let i = 0; i < joined.length; i += 8) await Promise.all(joined.slice(i, i + 8).map(async (s) => { for (const path of ['/v1/edge/here?include=doHere', '/v1/edge/capabilities']) { const g = await clientCall(`${w.origin}${path}`, { headers: clientHeaders(s) }); if (g.status === 200) reads.ok++; else reads.failed++; } }));
      await sleep(60_000);
      const m2 = smaps(w.child.pid), h2 = liveOf(w.data)?.heap;
      r.looked = { reads, rssMb: mb(m2?.rss ?? psRss(w.child.pid)), pssMb: mb(m2?.pss), privateMb: mb(m2?.private), heapUsedMb: h2?.usedMb ?? null, ...(heapAt ? { heap: await heapOf(dir, w) } : {}) };
      log(`${id} after one look each (${reads.ok} reads, ${reads.failed} failed): rss ${r.looked.rssMb} MB, heap ${r.looked.heapUsedMb} MB`);
    }
    log(`${id}: rss ${r.rssMb} MB, pss ${r.pssMb} MB, private ${r.privateMb} MB, heap ${r.heapUsedMb}/${r.heapLimitMb} MB (peak ${r.peakHeapMb}), dir ${mb(r.newDirBytes)} -> ${mb(r.endDirBytes)} MB`);
  } catch (e) { r.error = String(e.message ?? e).split(ROOT).join('.'); log(`${id}: ${r.error}`); }
  finally { await stopWorld(w); LIVE.delete(w); }
  return r;
}

// ------------------------------------------------------------------ disk after 24 h (worked out, not waited for)
// The database at hour h: everything but snapshots grows at the measured rate; snapshots plateau at the newest 5 plus the
// first of each day (db.ts saveSnapshot: 7 after 24 h, counting two day buckets; 12 after a week), each the mean measured
// size. Hourly backups (world-main.ts pruneBackups, #2542): the newest 2, so 2 after 24 h and after a week; each is a
// copy of the database at its hour, counted here at the horizon's size (an upper
// bound). WAL and the other files are taken as measured at the end.
function disk24h(r, gb = 100) {
  const c = r.content; if (r.otherGrowthBytesPerHour == null || !c?.snapshots) return null;
  const meanSnap = c.snapshotBytes / c.snapshots, rest = r.endDirBytes - r.files.filter((x) => /^sim\.db$|^backup-/.test(x.f)).reduce((s, x) => s + x.bytes, 0);
  const dbAt = (h, snaps) => c.otherBytes + Math.max(0, r.otherGrowthBytesPerHour) * Math.max(0, h - r.settledMin / 60) + snaps * meanSnap;
  const db24 = dbAt(24, 7), dbWeek = dbAt(24 * 7, 12), at24 = rest + db24 * (1 + 2), week = rest + dbWeek * (1 + 2);
  return { meanSnapshotMb: mb(meanSnap), db24Mb: mb(db24), dir24hMb: mb(at24), dirWeekMb: mb(week), worldsPer100GbAt24h: Math.floor((gb * 1e9) / at24), worldsPer100GbWeek: Math.floor((gb * 1e9) / week) };
}

const commit = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const receipt = { issue: 2240, raw: RAW, heapAt: [...HEAP_AT], commit, node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1), loadBefore: loadavg().map((x) => +x.toFixed(2)), settleMin: SETTLE_MS / 60_000, short: SHORT };
if (flag('wave')) {
  // #2553 A2: the join wave (wave.mjs), one repeat per invocation; nothing else runs
  const { runWave } = await import('./wave.mjs');
  if (WORLD_LIST.length !== 1) throw new Error('--wave: one --world (eden for the measurement; small only as a smoke)');
  const o = { acting: Number(opt('acting', 50)), n: Number(opt('wave-n', 200)), perSec: Number(opt('wave-per-sec', 2)), shape: opt('shape', 'uniform'), seed: Number(opt('seed', 1)) };
  log(`settled --wave: ${o.n} creates at ${o.perSec}/s on ${WORLDS[WORLD_LIST[0]]} with ${o.acting} acting (${o.shape}), commit ${commit?.slice(0, 9)}`);
  const wave = await runWave({ bootWorld, stopWorld, template: WORLDS[WORLD_LIST[0]], heapMb: worldHeapMb({ template: WORLDS[WORLD_LIST[0]] }, 0), dir: join(OUT, `wave-${o.shape}`), root: ROOT, log, ...o });
  receipt.loadAfter = loadavg().map((x) => +x.toFixed(2)); receipt.issue = 2553;
  writeFileSync(join(OUT, 'wave.json'), JSON.stringify({ receipt, wave }, null, 1) + '\n');
  const f = (x) => (x == null ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x)), c = wave.creates ?? {};
  writeFileSync(join(OUT, 'WAVE.md'), [`# A join wave on ${WORLDS[WORLD_LIST[0]]} (#2553)`, '', `commit ${f(commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${o.acting} acting (${o.shape}) · ${o.n} creates at ${o.perSec}/s · seed ${o.seed}`, '',
    wave.error ? `error: ${wave.error}` : '', wave.schedule ? `schedule: ${wave.schedule}` : '', '',
    '| created (errors) | join ms p50 / p95 / max | with picture ms p50 / p95 | clock ms per create | longest hold ms (source) | worst level | amber / red / black share | amber s by signal | tick p99 max ms | longest tick gap ms | heap at end MB | bodies: placed, spots, within 1 m, nearest m p50, radius m p50 / max |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    `| ${f(c.created)} (${f(c.errors)}) | ${f(c.joinMs?.p50)} / ${f(c.joinMs?.p95)} / ${f(c.joinMs?.max)} | ${f(c.withPictureMs?.p50)} / ${f(c.withPictureMs?.p95)} | ${f(c.clockMsPerCreate)} | ${f(wave.longestHold?.ms)} (${f(wave.longestHold?.cause)}) | ${f(wave.levels?.worst)} | ${f(wave.levels?.amber)} / ${f(wave.levels?.red)} / ${f(wave.levels?.black)} | ${f(wave.levels?.amberS)} | ${f(wave.levels?.tickP99Max)} | ${f(wave.levels?.longestGapMs)} | ${f(wave.heapEnd?.usedMb)} / ${f(wave.heapEnd?.limitMb)} | ${f(wave.bodies?.placed)}, ${f(wave.bodies?.spots)}, ${f(wave.bodies?.within1m)}, ${f(wave.bodies?.nearestM?.p50)}, ${f(wave.bodies?.radiusM?.p50)} / ${f(wave.bodies?.radiusM?.max)} |`,
    '', `clock busy ms: baseline ${f(wave.baseline?.busyMs)} of ${f(wave.baseline?.wallMs)} wall, wave ${f(wave.wave?.busyMs)} of ${f(wave.wave?.wallMs)} wall`,
    `wave groups (ms): ${f(wave.wave?.groups)}`, `baseline groups (ms): ${f(wave.baseline?.groups)}`, `long tasks in the wave: ${f(wave.longTasks)}`, `bodies by place: ${f(wave.bodies?.places)}`].join('\n') + '\n');
  log('done: WAVE.md'); process.exit(wave.error ? 1 : 0);
}
log(`settled: worlds ${WORLD_LIST.join(',')}, souls ${SOUL_LIST.join(',')}, ${SETTLE_MS / 60_000} min each, commit ${commit?.slice(0, 9)}`);
const results = [];
for (const world of WORLD_LIST) for (const souls of SOUL_LIST) {
  const present = await arm(world, souls, 'present', worldHeapMb({ template: WORLDS[world] }, 0)); results.push(present);
  if (present.looked) results.push({ ...present, ...present.looked, id: `${present.id}-looked`, state: 'looked', heap: present.looked.heap ?? null, looked: undefined });
  if (present.error || !present.peakHeapMb || PRESENT_ONLY) continue;
  results.push(await arm(world, souls, 'tight', Math.ceil((present.peakHeapMb * 1.25) / 64) * 64));
}
for (const r of results) if (!r.error) r.disk = disk24h(r);
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, results }, null, 1) + '\n');
const f = (x) => (x == null ? '—' : String(x));
const lines = [`# Settled world memory and disk (#2240)`, '', `commit ${f(commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs · ${receipt.memGb} GB · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${receipt.settleMin} min settle${SHORT ? ' · SHORT (indicative)' : ''}`, '',
  '| world | Souls | heap limit | RSS MB | Pss MB | Private MB | V8 heap used / peak MB | data dir new → end MB | snapshots (n · mean MB) | other content MB · growth MB/h | dir at 24 h · week MB | worlds in 100 GB (24 h · week) |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) => r.error ? `| ${r.template} | ${r.souls} | ${r.limit} ${r.heapMb} | error: ${r.error.slice(0, 120)} |||||||| ` :
    `| ${r.template} | ${r.souls} | ${r.limit} ${r.heapMb} | ${f(r.rssMb)} | ${f(r.pssMb)} | ${f(r.privateMb)} | ${f(r.heapUsedMb)} / ${f(r.peakHeapMb)} | ${mb(r.newDirBytes)} → ${mb(r.endDirBytes)} | ${f(r.content?.snapshots)} · ${f(r.disk?.meanSnapshotMb)} | ${f(mb(r.content?.otherBytes))} · ${f(mb(r.otherGrowthBytesPerHour))} | ${f(r.disk?.dir24hMb)} · ${f(r.disk?.dirWeekMb)} | ${f(r.disk?.worldsPer100GbAt24h)} · ${f(r.disk?.worldsPer100GbWeek)} |`)];
// #2553: memory per Soul between each pair of Soul counts (present limit), and what holds the heap where it was read
const STATES = ['idle', 'looked'];
const per = WORLD_LIST.flatMap((world) => STATES.flatMap((state) => { const xs = results.filter((r) => r.world === world && r.limit === 'present' && (r.state ?? 'idle') === state && !r.error).sort((a, b) => a.souls - b.souls);
  return xs.slice(1).map((b, k) => { const a = xs[k], d = b.souls - a.souls, p = (x, y) => (x == null || y == null ? null : +((y - x) / d).toFixed(2));
    return `| ${b.template} | ${state} | ${a.souls} → ${b.souls} | ${f(p(a.rssMb, b.rssMb))} | ${f(p(a.pssMb, b.pssMb))} | ${f(p(a.privateMb, b.privateMb))} | ${f(p(a.heapUsedMb, b.heapUsedMb))} | ${f(p(a.heap?.totalMb, b.heap?.totalMb))} |`; }); }));
if (per.length) lines.push('', '## Memory per Soul (#2553)', '', '| world | state | Souls | RSS MB per Soul | Pss MB per Soul | Private MB per Soul | V8 heap used MB per Soul | snapshot heap MB per Soul |', '|---|---|---|---|---|---|---|---|', ...per);
const heaps = results.filter((r) => r.heap && !r.heap.error);
if (heaps.length) {
  const ids = heaps[0].heap.groups.map((g) => g.id);
  lines.push('', '## What holds the main heap (#2553, snapshot after a forced collection; cumulative groups)', '', `| world | state | Souls | snapshot MB | ${ids.join(' MB | ')} MB | capCache alone | focusCache alone | wordsCache alone | lastMenu alone | rss / heap used / external / arrayBuffers MB | workers' heap used MB |`, `|---|---|---|---|${ids.map(() => '---|').join('')}---|---|---|---|---|---|`,
    ...heaps.map((r) => { const h = r.heap; return `| ${r.template} | ${r.state ?? 'idle'} | ${r.souls} | ${h.totalMb} | ${h.groups.map((g) => g.mb).join(' | ')} | ${f(h.menuAlone.capCache)} | ${f(h.menuAlone.focusCache)} | ${f(h.menuAlone.wordsCache)} | ${f(h.menuAlone.lastMenu)} | ${f(h.rssMb)} / ${f(h.heapUsedMb)} / ${f(h.externalMb)} / ${f(h.arrayBuffersMb)} | ${h.workers.map((x) => `${x.title || 'worker'} ${f(x.heapUsedMb)}`).join(', ') || '—'} |`; }));
  for (const state of STATES) {
  const hs = heaps.filter((r) => (r.state ?? 'idle') === state), [a, b] = [hs[0], hs.at(-1)];
  if (a && a !== b && a.world === b.world) {
    const d = b.souls - a.souls, by = new Map(a.heap.holders.map((h) => [h.label, h.mb])), seen = new Set();
    const rows = b.heap.holders.map((h) => { seen.add(h.label); return [h.label, by.get(h.label) ?? 0, h.mb]; }).concat(a.heap.holders.filter((h) => !seen.has(h.label)).map((h) => [h.label, h.mb, 0]))
      .map(([l, x, y]) => [l, x, y, +((y - x) / d).toFixed(3)]).sort((p, q) => q[3] - p[3]).slice(0, 25);
    lines.push('', `### Holders by growth, ${state}, ${a.souls} → ${b.souls} Souls (${a.template}; retained MB of what each holds alone, summed over instances)`, '', `| holder | MB at ${a.souls} | MB at ${b.souls} | MB per Soul |`, '|---|---|---|---|', ...rows.map((x) => `| ${x[0]} | ${x[1]} | ${x[2]} | ${x[3]} |`),
      '', `| group | MB per Soul |`, '|---|---|', ...b.heap.groups.map((g, k) => `| ${g.label} | ${+((g.mb - (a.heap.groups[k]?.mb ?? 0)) / d).toFixed(3)} |`));
  }
  }
}
writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
log('done: REPORT.md');
