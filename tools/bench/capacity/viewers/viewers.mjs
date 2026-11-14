#!/usr/bin/env node
// #2308: what 1, 50 and 200 viewers cost one world with Souls walking. One local Eden 2026 world (genesis from the
// template) behind the checkout's own launcher, fake minds, Eyes off, an isolated data dir under --out. 12 Souls join
// with the world's own CLI, then walk by catalog id (raw HTTP, the client's headers, one act every 6–10 s). Viewers are
// what the web page's entry opens (apps/web/src/snapshot-prefetch.ts), no browser: GET /v1/world/snapshot?defs=ref&cols=1,
// GET /v1/config, a GET of each part the snapshot names (x-defs-ref, x-ground-ref), and the world's WebSocket with the
// anonymous hello in its URL, held open (reopened 2 s after a close). Each viewer sends its own X-Forwarded-For.
// Per repeat one world: Souls join, warm up, then the arms in rising order (viewers are added to reach each count, settle,
// then a measuring window). Per window: tick time and service, the act's queue and handler time (its Server-Timing),
// the load levels and the seconds at amber per signal (live.json), the world's CPU share and memory, the bytes the
// viewers received, and the world calls the viewers caused (answers not from the launcher's micro-cache).
// Tools-only; never gated. Through `.github/workflows/timed-run.yml` (command `viewers`) on a souls-timed runner.
//
//   node tools/bench/capacity/viewers/viewers.mjs [--viewers 1,50,200] [--souls 12] [--repeats 2] [--window-sec 120]
//        [--out <dir>] [--port 4800] [--root <checkout>] [--short]
// Writes <out>/{results.json, REPORT.md, viewers.log} and <out>/r<k>/{launcher.log, souls/} (souls/ holds tokens; stays local).
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowFigures, serverTiming } from './stats.mjs';
import { actBody, catalogIds, clientHeaders, startPicture } from '../meetup/client-soul.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; }, flag = (k) => argv.includes(`--${k}`);
const ROOT = resolve(opt('root', new URL('../../../..', import.meta.url).pathname)), SHORT = flag('short');
const PORT = Number(opt('port', 4800)), BASE = `http://127.0.0.1:${PORT}`, SLUG = 'viewers-eden', TEMPLATE = 'eden-2026';
const ARMS = opt('viewers', '1,50,200').split(',').map(Number), SOULS = Number(opt('souls', 12)), REPEATS = Number(opt('repeats', 2));
const WINDOW_MS = Number(opt('window-sec', SHORT ? 30 : 120)) * 1000, WARM_MS = SHORT ? 15_000 : 60_000, SETTLE_MS = SHORT ? 10_000 : 20_000, SAMPLE_MS = 2000;
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
// a documentation address per viewer (RFC 5737), so the launcher's per-address ceilings see distinct visitors
const addressOf = (i) => `${['198.51.100', '203.0.113', '192.0.2'][Math.floor(i / 250)]}.${(i % 250) + 1}`;

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
  for (const v of run.viewers) try { v.ws?.close(); } catch { /* closed */ }
  for (const a of run.aborts) try { a.abort(); } catch { /* done */ }
  const L = run.launcher; if (!L) return;
  const pid = L.worldPid?.();
  try { L.child.kill('SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 60 && L.child.exitCode == null; i++) await sleep(500);
  for (const p of [pid, L.child.exitCode == null ? L.child.pid : null]) if (p) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
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
  return { i, token: token(), address: `192.0.2.${200 + i}` };
}
function walk(run, s, walks) {
  (async () => {
    let k = s.i;
    while (!run.stopped) {
      const id = walks[k++ % walks.length], key = `v${run.k}-s${s.i}-${k}`, ac = new AbortController(); run.aborts.add(ac);
      const t = performance.now(), rec = { at: Date.now(), capability: id };
      try {
        const r = await fetch(`${BASE}/w/${SLUG}/v1/edge/act`, { method: 'POST', headers: clientHeaders(s, { key }), body: JSON.stringify(actBody(id, key)), signal: AbortSignal.any([ac.signal, AbortSignal.timeout(40_000)]) });
        const d = await r.json().catch(() => null), st = serverTiming(r.headers.get('server-timing'));
        Object.assign(rec, { status: r.status, accepted: d?.accepted, code: d?.error?.code ?? d?.code ?? null, queueMs: st.queue, worldMs: st.world, clientMs: performance.now() - t, load: r.headers.get('x-sim-load') });
      } catch { rec.status = 0; rec.clientMs = performance.now() - t; }
      finally { run.aborts.delete(ac); }
      if (run.stopped) break;
      run.acts.push(rec);
      await sleep(6000 + Math.random() * 4000);
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
  const snap = viewerGet(run, v, '/v1/world/snapshot?defs=ref&cols=1'), cfg = viewerGet(run, v, '/v1/config');
  socket(run, v);
  const r = await snap; await cfg;
  const parts = r ? ['x-defs-ref', 'x-ground-ref'].map((h) => r.headers.get(h)).filter((f) => /^[0-9a-f]{32}$/.test(f ?? '')) : [];
  await Promise.all(parts.map((f) => viewerGet(run, v, `/v1/world/part/${f}`)));
}
function socket(run, v) {
  if (run.stopped) return;
  const ws = v.ws = new WebSocket(`ws://127.0.0.1:${PORT}/w/${SLUG}/ws?hello=${encodeURIComponent(HELLO)}`, { headers: { 'x-forwarded-for': v.address } });
  let opened = false;
  ws.onopen = () => { opened = true; run.counters.opens++; };
  ws.onmessage = (m) => { run.counters.messages++; run.counters.bytes += typeof m.data === 'string' ? Buffer.byteLength(m.data) : m.data.byteLength ?? m.data.size ?? 0; };
  ws.onclose = () => { if (opened) run.counters.closes++; else run.counters.refused++; if (!run.stopped) setTimeout(() => socket(run, v), 2000); };
  ws.onerror = () => {};
}

// ------------------------------------------------------------------ one repeat
async function repeat(k) {
  const dir = join(OUT, `r${k}`); mkdirSync(dir, { recursive: true });
  const run = { k, dir, stopped: false, aborts: new Set(), viewers: [], acts: [], calls: [], samples: [], counters: { bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0 } };
  const out = { repeat: k, windows: [] };
  let sampler;
  try {
    await bootLauncher(dir, run); out.bootS = run.launcher.bootS; log(`r${k}: world up in ${out.bootS} s`);
    sampler = setInterval(() => { const pid = run.launcher.worldPid(); run.samples.push({ at: Date.now(), live: run.launcher.live(), ...(pid ? proc(pid) : {}) }); }, SAMPLE_MS);
    const souls = [];
    for (let i = 0; i < SOULS; i += 4) souls.push(...await Promise.all(Array.from({ length: Math.min(4, SOULS - i) }, (_, j) => joinSoul(run, i + j))));
    // the catalog may answer 503 while the world settles after the joins: ask again for up to 5 min
    let pic; for (const t0 = Date.now(); !(pic = await startPicture(`${BASE}/w/${SLUG}`, souls[0])).catalog && Date.now() - t0 < 300_000;) { log(`r${k}: catalog ${pic.catalogStatus}; asking again`); await sleep(10_000); }
    const walks = catalogIds(pic.catalog).walk;
    if (!walks.length) throw new Error(`no walk ids in the catalog (catalog ${pic.catalogStatus})`);
    out.walkPlaces = walks.length; log(`r${k}: ${souls.length} Souls joined; ${walks.length} places to walk to`);
    for (const s of souls) walk(run, s, walks);
    await sleep(WARM_MS);
    for (const n of ARMS) {
      const opening = Date.now(), calls0 = run.calls.length;
      while (run.viewers.length < n) { const v = { address: addressOf(run.viewers.length) }; run.viewers.push(v); void openViewer(run, v); await sleep(50); }
      await sleep(SETTLE_MS);
      const from = Date.now(), v0 = { ...run.counters };
      await sleep(WINDOW_MS);
      const to = Date.now(), v1 = { ...run.counters };
      const w = windowFigures({ samples: run.samples, acts: run.acts, v0, v1, viewers: run.viewers.length, calls: run.calls.slice(calls0), from, to });
      w.openingS = Math.round((from - opening) / 1000); w.callsByPath = {};
      for (const c of run.calls.slice(calls0)) { const p = (w.callsByPath[c.path] ??= { n: 0, world: 0 }); p.n++; if (c.status && c.cache !== 'hit' && c.cache !== 'shared') p.world++; }
      out.windows.push(w);
      log(`r${k} n${n}: tick p50/p99 ${w.tickMs.p50}/${w.tickMs.p99} ms, service ${w.tickService.mean}, act queue p50/p95 ${w.acts.queueMs.p50}/${w.acts.queueMs.p95} ms, amber ${w.levels.amber}, cpu ${w.world.cpuShare}, rss ${w.world.rssMb} MB, ${w.viewersOut.bytesPerViewerPerS} B/s per viewer`);
    }
  } catch (e) { out.error = clean(e.message ?? e); log(`r${k}: ${out.error}`); }
  finally { clearInterval(sampler); await stopAll(run); }
  return out;
}

const receipt = { issue: 2308, commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), node: process.version, platform: process.platform, cpus: cpus().length, memGb: +(totalmem() / 2 ** 30).toFixed(1),
  loadBefore: loadavg().map((x) => +x.toFixed(2)), arms: ARMS, souls: SOULS, windowS: WINDOW_MS / 1000, warmS: WARM_MS / 1000, settleS: SETTLE_MS / 1000, short: SHORT, template: TEMPLATE };
log(`viewers: arms ${ARMS.join(',')}, ${SOULS} Souls, ${REPEATS} repeats, commit ${receipt.commit?.slice(0, 9)}`);
const repeats = [];
for (let k = 1; k <= REPEATS; k++) repeats.push(await repeat(k));
receipt.loadAfter = loadavg().map((x) => +x.toFixed(2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ receipt, repeats }, null, 1) + '\n');
const f = (x) => (x == null ? '—' : String(x)), obj = (o) => Object.entries(o ?? {}).map(([a, b]) => `${a} ${b}`).join(', ') || '0';
const rows = repeats.flatMap((r) => (r.error && !r.windows.length ? [`| r${r.repeat} | error: ${r.error.slice(0, 120)} |`] : r.windows.map((w) => `| r${r.repeat} | ${w.viewers} | ${f(w.tickMs.p50)} / ${f(w.tickMs.p99)} | ${f(w.tickService.mean)} (min ${f(w.tickService.min)}) | ${f(w.acts.queueMs.p50)} / ${f(w.acts.queueMs.p95)} | ${f(w.acts.handlerMs.p50)} / ${f(w.acts.handlerMs.p99)} | ${f(w.levels.amber)} | ${obj(w.amberS)} | ${f(w.world.cpuShare)} | ${f(w.world.rssMb)} | ${f(w.viewersOut.bytesPerViewerPerS)} | ${w.viewerCalls.worldCalls} of ${w.viewerCalls.http} | acts ${obj(w.acts.refused)}; viewers ${obj(w.viewerCalls.refusals)}; ws refused ${w.viewersOut.wsRefused}, closed ${w.viewersOut.wsCloses} |`)));
writeFileSync(join(OUT, 'REPORT.md'), [`# Viewers on one world (#2308)`, '', `commit ${f(receipt.commit?.slice(0, 9))} · node ${process.version} · ${receipt.cpus} CPUs · load ${receipt.loadBefore.join(' ')} → ${receipt.loadAfter.join(' ')} · ${SOULS} Souls walking · ${receipt.windowS} s windows${SHORT ? ' · SHORT (indicative)' : ''}`, '',
  '| repeat | viewers | tick p50 / p99 ms | tick service | act queue p50 / p95 ms | act handler p50 / p99 ms | amber share | amber s per signal | world CPU (cores) | RSS MB | bytes/s per viewer | world calls by viewers | refusals |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n');
log('done: REPORT.md');
if (repeats.some((r) => r.error)) process.exitCode = 1;
