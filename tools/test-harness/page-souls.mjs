#!/usr/bin/env node
// Scaling V9 (#2554): the page with many Souls. Frame time, draw calls, memory and the main thread's long tasks in a real
// browser while one fake-mind Eden 2026 world holds 12, 50, 200 and 500 Souls. No product change; a measurement.
//
// One world (tools/playtest/arena/provision.mjs, as the eval's load mode boots it) grows through the sizes: at each size
// the new Souls join as M3's raw Souls (tools/playtest/eval/load.mjs rawJoin, from documentation addresses) and every
// joined Soul acts on the load shape's schedule (tools/bench/capacity/profiles/shapes.mjs, #2556) for that size. The
// shape `event` gathers most walks at one named place (the bandstand); `uniform` spreads them around the map. Each new
// Soul first walks once (to the place with the shape's gathered share, else around the map), then the world settles.
// For each repeat, tier (the proof recorder's desktop and phone viewport presets, tools/proof/clip-presets.mjs: the phone
// preset's touch screen picks the page's phone quality tier) and camera (Broadcast, the page's default with Souls; Free,
// a manual camera from ?eye=&at= high above the crowd's median), a fresh browser context opens the page with ?dev=1, as
// the proof clips do, waits for arrival, warms up, then measures: requestAnimationFrame deltas (the page has no frame
// time probe of its own: RendererDiagnostics says "no presented FPS"), draw calls and triangles per frame (WebGL
// wrapped before the app loads), GPU time per frame (EXT_disjoint_timer_query_webgl2 where the driver has it), JS heap,
// the renderer's geometries and textures, and long tasks (PerformanceObserver). At the largest size the first repeat
// also takes a V8 CPU profile of each arm after its window, for the top costs. The browser is launched with the proof
// recorder's hardware GL flag sets (.claude/skills/proof/record.mjs GPU_CANDIDATES); the renderer string is recorded,
// and a software renderer is recorded as such. A runner's GPU is not a visitor's: compare arms with each other.
//
//   node tools/test-harness/page-souls.mjs [--souls 12,50,200,500] [--shape event|uniform] [--repeats 2]
//        [--warm-sec 20] [--measure-sec 60] [--settle-sec 60] [--profile-sec 10] [--out dir] [--port 18990] [--short]
// Writes <out>/results.json, <out>/REPORT.md and one screenshot per size, tier and camera (first repeat).
// Never point it at a live world: it boots its own, with fake minds, under <out>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '../..');
export const TIERS = ['desktop', 'phone'];
export const CAMERAS = ['broadcast', 'free'];
/** A2's line: a median frame time above this many ms is under 30 frames a second. */
export const SLOW_MS = 1000 / 30;

const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]; };
const r1 = (x) => (x == null ? null : +x.toFixed(1));
/** rAF timestamps (ms) → frame times: count, frames a second, p50, p95, max, and frames over 33 and 50 ms. */
export function frameStats(ts) {
  const iv = ts.slice(1).map((t, i) => t - ts[i]), span = ts.length > 1 ? ts.at(-1) - ts[0] : 0;
  return { frames: iv.length, fps: span > 0 ? r1(iv.length * 1000 / span) : null, p50: r1(q(iv, 0.5)), p95: r1(q(iv, 0.95)), max: iv.length ? r1(Math.max(...iv)) : null,
    over33: iv.filter((x) => x > SLOW_MS).length, over50: iv.filter((x) => x > 50).length };
}
/** A V8 CPU profile (CDP Profiler.stop) → ms by function, self and inclusive (a sample counts once per function in its
 *  stack), top `n` of each; the page's origin is cut from script URLs. */
export function topCosts(profile, n = 12) {
  const nodes = new Map(profile.nodes.map((x) => [x.id, x])), parent = new Map();
  for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const key = (x) => { const f = x.callFrame, file = (f.url || '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('/').pop().replace(/[?#].*$/, ''); return `${f.functionName || '(anonymous)'}${file ? ` ${file}:${f.lineNumber + 1}:${f.columnNumber + 1}` : ''}`; };
  const self = new Map(), incl = new Map(); let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000; total += dt;
    const leaf = nodes.get(id); if (!leaf) return;
    self.set(key(leaf), (self.get(key(leaf)) ?? 0) + dt);
    const seen = new Set(); for (let at = id; at != null; at = parent.get(at)) { const k = key(nodes.get(at)); if (k === '(root)' || seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); }
  });
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, ms]) => ({ fn, ms: Math.round(ms), share: total ? +(ms / total).toFixed(3) : null }));
  const idle = (self.get('(idle)') ?? 0);
  return { totalMs: Math.round(total), busyShare: total ? +(1 - idle / total).toFixed(3) : null, self: top(self), inclusive: top(incl) };
}
/** Per tier and camera, the smallest size whose median frame time (the median of its repeats' p50s) is above SLOW_MS,
 *  else 'not reached' with the largest size measured, or 'no data'. */
export function crossings(rows) {
  const out = {};
  for (const tier of TIERS) for (const camera of CAMERAS) {
    const sizes = [...new Set(rows.filter((r) => r.tier === tier && r.camera === camera).map((r) => r.souls))].sort((a, b) => a - b);
    const med = (n) => { const p = rows.filter((r) => r.tier === tier && r.camera === camera && r.souls === n && r.frame?.p50 != null).map((r) => r.frame.p50).sort((a, b) => a - b); return p.length ? (p[(p.length - 1) >> 1] + p[p.length >> 1]) / 2 : null; };
    const hit = sizes.find((n) => med(n) > SLOW_MS);
    out[`${tier}/${camera}`] = hit ?? (sizes.some((n) => med(n) != null) ? `not reached (largest measured: ${sizes.filter((n) => med(n) != null).at(-1)})` : 'no data');
  }
  return out;
}
export function renderReport(res) {
  const L = [`# Page with many Souls (#2554): shape ${res.shape}`, '', `Renderer: ${res.gl?.renderer ?? 'none'} (${res.gl?.software ? 'software' : 'hardware'}; flags ${res.gl?.flags ?? '-'}). ${res.cores} logical CPUs allowed to this process; a runner's GPU is not a visitor's, so compare arms with each other.`,
    `Each arm: ${res.warmSec} s warm-up after arrival, then ${res.measureSec} s measured. Frame times are requestAnimationFrame deltas (ms); draws and triangles per drawn frame (median); heap is the JS heap at the window's end; long tasks are the main thread's tasks over 50 ms in the window.`, '',
    '| Souls | tier | camera | rep | frame p50 | frame p95 | fps | >33 ms | draws p50 | tris p50 (k) | GPU ms p50 | heap MB | geometries / textures | long tasks (n / ms / max) | Souls in page | load 1m |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of res.rows) {
    if (r.error) { L.push(`| ${r.souls} | ${r.tier} | ${r.camera} | ${r.repeat} | error: ${String(r.error).replace(/\|/g, '/').slice(0, 120)} |||||||||||||`); continue; }
    L.push(`| ${r.souls} | ${r.tier} | ${r.camera} | ${r.repeat} | ${r.frame.p50} | ${r.frame.p95} | ${r.frame.fps} | ${r.frame.over33} | ${r.draws.p50 ?? ''} | ${r.draws.trisP50k ?? ''} | ${r.gpu.p50 ?? '-'} | ${r.mem.heapMB ?? ''} | ${r.mem.geometries ?? ''} / ${r.mem.textures ?? ''} | ${r.long.n} / ${r.long.totalMs} / ${r.long.max} | ${r.page.souls ?? ''} | ${r.host.load1} |`);
  }
  L.push('', 'Size at which the median frame time passes 33 ms (30 frames a second):', '');
  for (const [k, v] of Object.entries(res.crossings)) L.push(`- ${k}: ${v}`);
  if (res.profiles.length) {
    L.push('', `CPU profiles at ${res.profiles[0].souls} Souls (${res.profileSec} s each, after the measured window):`);
    for (const p of res.profiles) {
      if (p.error) { L.push('', `- ${p.tier}/${p.camera}: error ${p.error}`); continue; }
      L.push('', `- ${p.tier}/${p.camera}: main thread busy ${Math.round(100 * p.busyShare)} % of ${p.totalMs} ms. Self: ${p.self.slice(0, 6).map((x) => `${x.fn} ${x.ms} ms`).join('; ')}. Inclusive: ${p.inclusive.slice(0, 8).map((x) => `${x.fn} ${x.ms} ms`).join('; ')}`);
    }
  }
  L.push('', `Driver: ${JSON.stringify(res.driver)}`);
  return L.join('\n') + '\n';
}

// In-page, before the app: rAF timestamps, draws and triangles per frame, GPU time per frame (timer queries), long tasks.
const INIT = `(() => {
  const P = window.__v9 = { frames: [], perFrame: [], gpu: [], long: [], on: false, draws: 0, tris: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let pending = [], open = null;
  const gpuTick = () => { if (!P.gl) { const c = document.querySelector('canvas[aria-label="Live 3D view of the world"]'); const g = c && c.getContext('webgl2'); const e = g && g.getExtension('EXT_disjoint_timer_query_webgl2'); if (e) { P.gl = g; P.ext = e; } } const gl = P.gl, ext = P.ext; if (!gl) return; try {
    if (open) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); open = null; }
    const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
    pending = pending.filter((x) => { if (!dis && !gl.getQueryParameter(x, gl.QUERY_RESULT_AVAILABLE)) return true; if (!dis && P.on) P.gpu.push(gl.getQueryParameter(x, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(x); return false; });
    if (pending.length < 4) { open = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, open); } } catch (e) { P.gpuErr = String(e).slice(0, 120); } };
  const tick = (t) => { gpuTick(); if (P.on) { P.frames.push(t); if (P.draws) P.perFrame.push([P.draws, P.tris]); } P.draws = 0; P.tris = 0; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const wrap = (proto) => { if (!proto) return;
    const o = (name, fn) => { const orig = proto[name]; if (orig) proto[name] = function (...a) { try { fn(a); } catch {} return orig.apply(this, a); }; };
    const draw = (count, inst, mode) => { P.draws++; if (mode === 4) P.tris += (count / 3) * (inst || 1); };
    o('drawElements', (a) => draw(a[1], 1, a[0])); o('drawArrays', (a) => draw(a[2], 1, a[0]));
    o('drawElementsInstanced', (a) => draw(a[1], a[4], a[0])); o('drawArraysInstanced', (a) => draw(a[2], a[3], a[0])); o('drawRangeElements', (a) => draw(a[3], 1, a[0]));
    const ge = proto.getExtension; proto.getExtension = function (n) { const e = ge.call(this, n); if (e && n === 'WEBGL_multi_draw' && !e.__v9) { e.__v9 = true; const md = e.multiDrawElementsWEBGL; if (md) e.multiDrawElementsWEBGL = function (mode, counts, co, type, offs, oo, dc) { for (let i = 0; i < dc; i++) { P.draws++; if (mode === 4) P.tris += counts[co + i] / 3; } return md.apply(this, arguments); }; } return e; };
  };
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
})();`;

function args(argv) {
  const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) continue; const k = a.slice(2), v = argv[i + 1]; if (v == null || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** A schedule's stop: `end()` wakes every waiting agent at once. */
const stopper = () => { let end; const s = { done: false, ended: new Promise((r) => { end = r; }) }; s.end = () => { s.done = true; end(); }; return s; };
const log = (s) => console.log(`[page-souls ${new Date().toISOString().slice(11, 19)}] ${s}`);
const cpusAllowed = () => { try { return /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? null; } catch { return null; } };
const host = () => ({ load1: +loadavg()[0].toFixed(2), cpusAllowed: cpusAllowed() });

/** The shape's acts for every joined Soul, until `stop.end()`: walks (gathered: the meetup place; spread: any
 *  open place), speech, gestures, sitting where it stands, and the catalog's read, eat and music spots. → counts. */
async function drive({ base, souls, sched, ids, meet, stop, counts, call, sayBody, SAY_PATH, actBody, clientHeaders }) {
  const t0 = Date.now(), pickOf = (xs, k) => (xs?.length ? xs[k % xs.length] : null);
  const one = async (soul, a) => {
    const key = `v9-${soul.i}-${a.at}-${Date.now()}`, h = clientHeaders(soul, { key });
    if (a.kind === 'say') { const r = await call(`${base}${SAY_PATH}`, { method: 'POST', headers: h, body: sayBody(`Hello from ${soul.i} at the gathering.`) }); counts[r.status === 200 ? 'said' : 'sayFailed']++; return; }
    const id = a.kind === 'walk' ? (a.place === 'gathered' ? pickOf(meet, a.pick) : pickOf(ids.walk, a.pick))
      : a.kind === 'sit' || a.kind === 'sit-ground' ? 'sit-ground:here' : pickOf(ids[a.kind], a.pick);
    if (!id) { counts.noId++; return; }
    const r = await call(`${base}/v1/edge/act`, { method: 'POST', headers: h, body: actBody(id, key) });
    counts.acts++; if (r.status !== 200 && r.status !== 202) counts.actFailed++; else if (r.data?.accepted === false) counts.refused++;
  };
  await Promise.all(sched.agents.map(async (ag) => {
    const soul = souls[ag.i]; if (!soul) return;
    for (const a of ag.acts) { await Promise.race([sleep(t0 + a.at * 1000 - Date.now()), stop.ended]); if (stop.done) return; await one(soul, a).catch(() => { counts.errors++; }); }
  }));
}

async function launchBrowser(chromium) {
  const { GPU_CANDIDATES, softwareGl } = await import(pathToFileURL(join(REPO, '.claude/skills/proof/record.mjs')).href);
  const base = ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-gpu-rasterization', '--enable-precise-memory-info'];
  const readGl = async (b) => { const p = await b.newPage(); try { return await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const x = gl?.getExtension('WEBGL_debug_renderer_info'); return gl ? { vendor: gl.getParameter(x ? x.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) } : {}; }); } finally { await p.close(); } };
  const tried = [];
  for (const c of GPU_CANDIDATES) {
    let b; try { b = await chromium.launch({ headless: true, args: [...base, ...c.args], ...(c.channel ? { channel: c.channel } : {}) }); } catch (e) { tried.push({ label: c.label, error: String(e?.message ?? e).split('\n')[0].slice(0, 120) }); continue; }
    const gl = await readGl(b).catch(() => ({})); tried.push({ label: c.label, renderer: gl.renderer ?? null });
    if (!softwareGl(gl.renderer)) return { browser: b, gl: { ...gl, flags: c.label, software: false, tried } };
    await b.close();
  }
  const b = await chromium.launch({ headless: true, args: [...base, '--enable-unsafe-swiftshader'] });
  const gl = await readGl(b).catch(() => ({}));
  return { browser: b, gl: { ...gl, flags: 'default', software: softwareGl(gl.renderer), tried } };
}

/** One arm: a fresh context on the page, arrival, warm-up, the measured window; a CPU profile after it when asked. */
async function arm({ browser, url, tier, VIEWPORTS, worldArrived, warmSec, measureSec, profileSec, shot }) {
  const ctx = await browser.newContext({ ...VIEWPORTS[tier] });
  try {
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(worldArrived, null, { timeout: 240_000, polling: 500 });
    const arrivedMs = Date.now() - t0;
    await page.waitForTimeout(warmSec * 1000);
    await page.evaluate(() => { const P = window.__v9; P.frames = []; P.perFrame = []; P.gpu = []; P.from = performance.now(); P.on = true; });
    await page.waitForTimeout(measureSec * 1000);
    const d = await page.evaluate(() => {
      const P = window.__v9; P.on = false; const to = performance.now(), w = window.__soulsEntity, s = w?.stats?.() ?? {}, long = P.long.filter(([a]) => a >= P.from && a < to);
      return { frames: P.frames, perFrame: P.perFrame, gpu: P.gpu, gpuErr: P.gpuErr ?? null, timer: !!P.ext, long: { n: long.length, totalMs: Math.round(long.reduce((n, [, x]) => n + x, 0)), max: long.length ? Math.round(Math.max(...long.map(([, x]) => x))) : 0 },
        mem: { heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null, geometries: s.geometries ?? null, textures: s.textures ?? null, entities: s.entities ?? null, instances: s.instances ?? null },
        page: { quality: window.__soulsQuality?.tier ?? null, souls: w?.residents?.().length ?? null, camera: document.querySelector('canvas[data-camera-mode]')?.dataset.cameraMode ?? null, buffer: (() => { const c = document.querySelector('canvas[aria-label="Live 3D view of the world"]'); return c ? [c.width, c.height] : null; })() },
        crowd: (() => { const r = w?.residents?.() ?? []; if (!r.length) return null; const med = (k) => { const v = r.map((x) => x.p[k]).sort((a, b) => a - b); return +v[Math.floor(v.length / 2)].toFixed(1); }; return [med(0), med(1), med(2)]; })() };
    });
    const tris = d.perFrame.map(([, t]) => t), draws = d.perFrame.map(([n]) => n);
    const row = { arrivedMs, frame: frameStats(d.frames), draws: { p50: q(draws, 0.5), p95: q(draws, 0.95), trisP50k: tris.length ? r1(q(tris, 0.5) / 1000) : null }, gpu: { timer: d.timer, n: d.gpu.length, p50: r1(q(d.gpu, 0.5)), p95: r1(q(d.gpu, 0.95)), error: d.gpuErr },
      long: d.long, mem: d.mem, page: d.page, crowd: d.crowd, errors: errors.slice(0, 5) };
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
    if (profileSec) {
      const cdp = await ctx.newCDPSession(page);
      try { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); await page.waitForTimeout(profileSec * 1000); row.profile = topCosts((await cdp.send('Profiler.stop')).profile); }
      catch (e) { row.profile = { error: String(e?.message ?? e).slice(0, 160) }; }
    }
    return row;
  } finally { await ctx.close().catch(() => {}); }
}

async function main() {
  const o = args(process.argv.slice(2)), short = !!o.short;
  const sizes = String(o.souls ?? (short ? '12' : '12,50,200,500')).split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const shape = String(o.shape ?? 'event'), repeats = Number(o.repeats ?? (short ? 1 : 2));
  const warmSec = Number(o['warm-sec'] ?? (short ? 5 : 20)), measureSec = Number(o['measure-sec'] ?? (short ? 10 : 60)), settleSec = Number(o['settle-sec'] ?? (short ? 20 : 60)), profileSec = Number(o['profile-sec'] ?? (short ? 5 : 10));
  const port = Number(o.port ?? 18990), out = resolve(o.out ?? join(REPO, '.local/page-souls', new Date().toISOString().replace(/[:.]/g, '-')));
  if (port >= 4930 && port <= 4987) throw new Error(`refusing live-world port ${port}`);
  if (!['event', 'uniform'].includes(shape)) throw new Error('--shape event|uniform');
  mkdirSync(out, { recursive: true });
  const { startWorld, stopWorld } = await import(pathToFileURL(join(REPO, 'tools/playtest/arena/provision.mjs')).href);
  const { rawJoin, wordIds } = await import(pathToFileURL(join(REPO, 'tools/playtest/eval/load.mjs')).href);
  const cs = await import(pathToFileURL(join(REPO, 'tools/bench/capacity/meetup/client-soul.mjs')).href);
  const { schedule, describe, SHAPES } = await import(pathToFileURL(join(REPO, 'tools/bench/capacity/profiles/shapes.mjs')).href);
  const { VIEWPORTS } = await import(pathToFileURL(join(REPO, 'tools/proof/clip-presets.mjs')).href);
  const { worldArrived } = await import(pathToFileURL(join(REPO, 'tools/playtest/lib/arrival.mjs')).href);
  const { resolvePlaywright } = await import(pathToFileURL(join(REPO, 'tools/playtest/lib/platform.mjs')).href);
  const pw = resolvePlaywright({ serverRoot: REPO }); if (!pw) throw new Error('no Playwright: pnpm install --frozen-lockfile');
  const gathered = SHAPES.agents[shape].place.gatheredShare.value;
  const nv = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' });
  const res = { schema: 'page-souls/1', shape, sizes, repeats, warmSec, measureSec, settleSec, profileSec, cores: availableParallelism(), gpuName: nv.status === 0 ? nv.stdout.trim().split('\n')[0] : null, gl: null, rows: [], profiles: [], schedules: [], driver: { joined: 0, joinS: [], counts: null }, crossings: null };
  const save = () => { res.crossings = crossings(res.rows); writeFileSync(join(out, 'results.json'), JSON.stringify(res, null, 1)); writeFileSync(join(out, 'REPORT.md'), renderReport(res)); };
  log(`booting Eden 2026 (fake minds) on :${port}; shape ${shape}, sizes ${sizes.join(',')}, ${repeats} repeats`);
  const w = await startWorld({ serverRoot: REPO, slug: 'eden-load', port, genesis: 'worlds/templates/eden-2026.json', dataDir: join(out, 'world', 'data'), log: join(out, 'world.log') });
  const { browser, gl } = await launchBrowser(pw.chromium); res.gl = gl;
  log(`world up in ${Math.round(w.bootMs / 1000)} s; gl ${gl.renderer ?? 'none'} (${gl.software ? 'software' : 'hardware'}, ${gl.flags})`);
  const souls = [], counts = { acts: 0, refused: 0, actFailed: 0, said: 0, sayFailed: 0, noId: 0, errors: 0, firstWalks: 0 };
  let cat = null, ids = null, meet = null, stop = stopper(), running = Promise.resolve();
  const { rng } = await import(pathToFileURL(join(REPO, 'tools/playtest/lib/hash.mjs')).href);
  try {
    for (const n of sizes) {
      const j0 = Date.now(), fresh = [];
      for (let i = souls.length; i < n; i += 8) await Promise.all(Array.from({ length: Math.min(8, n - i) }, async (_, j) => { const s = await rawJoin(w.base, i + j); souls[i + j] = s; fresh.push(s); }));
      if (!cat) { cat = (await cs.startPicture(w.base, souls[0])).catalog; ids = cs.catalogIds(cat); meet = wordIds(cat).bandstand; if (!meet?.length) throw new Error('no bandstand in the catalog'); }
      res.driver.joined = souls.length; res.driver.joinS.push({ souls: n, s: Math.round((Date.now() - j0) / 1000) });
      log(`${n} Souls joined (${fresh.length} new in ${Math.round((Date.now() - j0) / 1000)} s); first walks, then the ${shape} schedule`);
      // the previous size's schedule ends; the new one covers every joined Soul for this size's whole stay
      stop.end(); await running;
      const perSize = settleSec + repeats * TIERS.length * CAMERAS.length * (warmSec + measureSec + 120) + (n === sizes.at(-1) ? TIERS.length * CAMERAS.length * profileSec : 0);
      const sched = schedule(shape, n, perSize, `v9|${shape}|${n}`, { actSec: 10 }); res.schedules.push({ souls: n, seconds: perSize, summary: describe(sched.summary) });
      const r = rng(n);
      await Promise.all(fresh.map(async (s) => { const id = r() < gathered ? meet[Math.floor(r() * meet.length)] : ids.walk[Math.floor(r() * ids.walk.length)]; const key = `v9-first-${s.i}`;
        const a = await cs.clientCall(`${w.base}/v1/edge/act`, { method: 'POST', headers: cs.clientHeaders(s, { key }), body: cs.actBody(id, key) }); if (a.status === 200 || a.status === 202) counts.firstWalks++; }));
      stop = stopper(); running = drive({ base: w.base, souls, sched, ids, meet, stop, counts, call: cs.clientCall, sayBody: cs.sayBody, SAY_PATH: cs.SAY_PATH, actBody: cs.actBody, clientHeaders: cs.clientHeaders });
      await sleep(settleSec * 1000);
      let crowd = null;
      for (let rep = 1; rep <= repeats; rep++) for (const tier of TIERS) for (const camera of CAMERAS) {
        const at = crowd ?? [0, 0, 0], url = camera === 'free' ? `${w.base}?dev=1&eye=${at[0]},${+(at[1] + 40).toFixed(1)},${+(at[2] + 40).toFixed(1)}&at=${at.join(',')}` : `${w.base}?dev=1`;
        const profile = rep === 1 && n === sizes.at(-1) ? profileSec : 0, h0 = host();
        log(`n${n} r${rep} ${tier} ${camera}: load ${h0.load1}`);
        let row;
        try { row = await arm({ browser, url, tier, VIEWPORTS, worldArrived, warmSec, measureSec, profileSec: profile, shot: rep === 1 ? join(out, `n${n}-${tier}-${camera}.png`) : null }); }
        catch (e) { row = { error: String(e?.message ?? e).split('\n')[0].slice(0, 200) }; }
        const { profile: prof, ...rest } = row;
        res.rows.push({ souls: n, repeat: rep, tier, camera, joined: souls.length, view: camera === 'free' ? { at, up: 40, back: 40 } : null, host: { start: h0, end: host() }, ...rest });
        if (prof) res.profiles.push({ souls: n, tier, camera, ...prof });
        if (!crowd && row.crowd) crowd = row.crowd;
        if (row.error) log(`  error: ${row.error}`); else log(`  frame p50 ${row.frame.p50} p95 ${row.frame.p95} ms, ${row.frame.fps} fps, draws ${row.draws.p50}, gpu ${row.gpu.p50 ?? '-'} ms, heap ${row.mem.heapMB} MB, long ${row.long.n}/${row.long.totalMs} ms, Souls in page ${row.page.souls}, camera ${row.page.camera}, tier ${row.page.quality}`);
        res.driver.counts = { ...counts }; save();
      }
    }
  } finally {
    stop.end(); await Promise.race([running, sleep(5000)]);
    await browser.close().catch(() => {}); await stopWorld({ pid: w.pid });
    res.driver.counts = { ...counts }; save();
  }
  log(`done: ${join(out, 'REPORT.md')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().then(() => process.exit(0), (e) => { console.error(String(e?.stack ?? e)); process.exit(1); });   // an agent's pending sleep must not hold the process
