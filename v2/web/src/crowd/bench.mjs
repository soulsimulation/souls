#!/usr/bin/env node
// The crowd's measurement (V6, #2715), in #2554's table shape: frame time (median, 95th), draws, the frame's own work,
// main-thread busy share, JS heap and long tasks, for the desktop and phone presets of the proof recorder
// (tools/proof/clip-presets.mjs), each a fresh browser context on bench.html: 1,000 bodies, 400 walking. Each arm warms
// up, then measures `--measure` seconds; the first repeat of each tier then takes a V8 CPU profile (`--profile` s)
// whose idle share gives main-thread busy, and keeps it as a .cpuprofile, with a screenshot.
//
//   node v2/web/src/crowd/bench.mjs [--bodies <dir of the body files>] [--tiers desktop,phone] [--repeats 2]
//        [--warm 10] [--measure 60] [--profile 10] [--n 1000] [--walking 400] [--port 5179] [--out dir]
//        [--kind <the importer's <name>.json>] [--area 2.5]   (B13, #2744: one authored body kind in place of the
//        three people; ground per body, m²)
//
// The body files (character-wire.ts's mesh and clips files) are copied into v2/web/.local/bodies (ignored) and the page
// is served by `vite` from v2/web. Frame times are requestAnimationFrame deltas; draws are counted by wrapping WebGL
// before the page loads. Hardware GL on macOS (ANGLE Metal); the renderer string is recorded. A laptop's GPU is not a
// phone's: the phone preset is the phone's screen, touch and pixel ratio on the same machine.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = resolve(import.meta.dirname, '../..');
const REPO = resolve(WEB, '../..');
const FILES = ['animated-casual.mesh.glb', 'animated-punk.mesh.glb', 'animated-woman.mesh.glb', 'clips-ual.glb', 'clips-ual-woman.glb'];
const imp = (p) => import(pathToFileURL(join(REPO, p)).href);

const INIT = `(() => {
  const P = window.__v6 = { frames: [], draws: [], long: [], on: false, n: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const tick = (t) => { if (P.on) { P.frames.push(t); P.draws.push(P.n); } P.n = 0; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    const orig = proto[name]; proto[name] = function (...a) { P.n++; return orig.apply(this, a); };
  }
})();`;

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) o[argv[i].slice(2)] = true;
    else (o[argv[i].slice(2)] = v), i++;
  }
  return o;
}
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]; };
const r1 = (x) => (x == null ? null : +x.toFixed(1));
const log = (s) => console.log(`[crowd-bench ${new Date().toISOString().slice(11, 19)}] ${s}`);

async function vite(port) {
  const p = spawn(process.execPath, [join(WEB, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/src/crowd/bench.html`)).ok) return p; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('vite did not start');
}

async function arm({ browser, url, tier, VIEWPORTS, o, profileTo, topCosts }) {
  const ctx = await browser.newContext({ ...VIEWPORTS[tier] });
  try {
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__crowd?.ready || window.__crowd?.error, null, { timeout: 120_000, polling: 250 });
    const failed = await page.evaluate(() => window.__crowd.error);
    if (failed) throw new Error(failed);
    await page.waitForTimeout(o.warm * 1000);
    await page.evaluate(() => { const P = window.__v6; P.frames = []; P.draws = []; P.from = performance.now(); P.on = true; window.__crowd.work = []; window.__crowd.on = true; });
    const load = loadavg()[0];
    await page.waitForTimeout(o.measure * 1000);
    const d = await page.evaluate(() => {
      const P = window.__v6, C = window.__crowd; P.on = false; C.on = false;
      const to = performance.now(), long = P.long.filter(([a]) => a >= P.from && a < to);
      return { frames: P.frames, draws: P.draws, work: C.work, stats: C.stats(), premise: C.premise, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        long: { n: long.length, totalMs: Math.round(long.reduce((n, [, x]) => n + x, 0)) }, buffer: [document.querySelector('canvas').width, document.querySelector('canvas').height] };
    });
    const iv = d.frames.slice(1).map((t, i) => t - d.frames[i]), span = d.frames.at(-1) - d.frames[0];
    const row = {
      tier, frames: iv.length, fps: r1((iv.length * 1000) / span), p50: r1(q(iv, 0.5)), p95: r1(q(iv, 0.95)), max: r1(Math.max(...iv)), over33: iv.filter((x) => x > 1000 / 30).length,
      draws: q(d.draws, 0.5), work: { p50: +q(d.work, 0.5).toFixed(2), p95: +q(d.work, 0.95).toFixed(2) }, stats: d.stats, heapMB: d.heapMB, long: d.long, buffer: d.buffer,
      load1: +load.toFixed(1), premise: d.premise, errors,
    };
    if (profileTo) await page.screenshot({ path: profileTo.replace(/\.cpuprofile$/, '.png') });
    if (profileTo) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
      await page.waitForTimeout(o.profile * 1000);
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(profileTo, JSON.stringify(profile));
      row.profile = topCosts(profile, 8);
    }
    return row;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function report(res) {
  const L = [`# Crowd bench (#2715): ${res.n} bodies, ${res.walking} walking${res.kind ? `, all of the kind ${res.kind}` : ''}`, '',
    `Renderer: ${res.gl}. Laptop load (1 min) at each arm's start is in the table. Each arm: ${res.warm} s warm-up, ${res.measure} s measured. Frame times are requestAnimationFrame deltas (ms); draws are WebGL draw calls per frame (shadow pass included); work is the page's own time per frame (moving the walkers, filling the crowd's buffers, three's render call); busy is the main thread's share not idle in a ${res.profile} s CPU profile after the window.`, '',
    '| tier | rep | frame p50 | frame p95 | fps | >33 ms | draws | crowd draws | in view | levels 0/1/2 | work p50 / p95 ms | busy | heap MB | long tasks | load 1m |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of res.rows) {
    if (r.error) { L.push(`| ${r.tier} | ${r.repeat} | error: ${r.error} |`); continue; }
    L.push(`| ${r.tier} | ${r.repeat} | ${r.p50} | ${r.p95} | ${r.fps} | ${r.over33} | ${r.draws} | ${r.stats.draws} | ${r.stats.visible} | ${r.stats.byLevel.join(' / ')} | ${r.work.p50} / ${r.work.p95} | ${r.profile ? `${Math.round(100 * r.profile.busyShare)} %` : '-'} | ${r.heapMB} | ${r.long.n} / ${r.long.totalMs} ms | ${r.load1} |`);
  }
  const p = res.rows.find((r) => r.premise)?.premise;
  if (p) {
    L.push('', `Bodies (bake ${p.bakeMs} ms for all three):`, '', '| model | bones | materials | triangles level 0 / 1 / 2 | height m | clips (frames) |', '|---|---|---|---|---|---|');
    for (const m of p.models) L.push(`| ${m.name} | ${m.bones} | ${m.materials} | ${m.triangles.join(' / ')} | ${m.height} | ${m.clips.join(', ')} |`);
  }
  for (const r of res.rows.filter((x) => x.profile)) {
    L.push('', `Profile, ${r.tier} rep ${r.repeat}: busy ${Math.round(100 * r.profile.busyShare)} % of ${r.profile.totalMs} ms. Self: ${r.profile.self.slice(0, 6).map((x) => `${x.fn} ${x.ms} ms`).join('; ')}.`);
  }
  return L.join('\n') + '\n';
}

async function main() {
  const a = args(process.argv.slice(2));
  const o = { warm: Number(a.warm ?? 10), measure: Number(a.measure ?? 60), profile: Number(a.profile ?? 10), repeats: Number(a.repeats ?? 2), n: Number(a.n ?? 1000), walking: Number(a.walking ?? 400), area: Number(a.area ?? 2.5) };
  const tiers = String(a.tiers ?? 'desktop,phone').split(',');
  const port = Number(a.port ?? 5179);
  const out = resolve(a.out ?? join(REPO, '.local/crowd-bench', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  const bodies = join(WEB, '.local/bodies');
  mkdirSync(bodies, { recursive: true });
  let kind = '';
  if (a.kind) {
    const entry = resolve(a.kind), k = JSON.parse(readFileSync(entry, 'utf8'));
    mkdirSync(join(bodies, 'kinds/models'), { recursive: true });
    for (const f of [k.full, k.simple]) copyFileSync(join(dirname(entry), f), join(bodies, 'kinds', f));
    copyFileSync(entry, join(bodies, 'kinds', basename(entry)));
    kind = `&kind=kinds/${basename(entry)}`;
  }
  for (const f of a.kind ? [] : FILES) if (!existsSync(join(bodies, f))) {
    if (!a.bodies) throw new Error(`no ${f} in v2/web/.local/bodies: pass --bodies <the directory holding the body files>`);
    copyFileSync(join(resolve(a.bodies), f), join(bodies, f));
  }
  const { resolvePlaywright, browsersPath, launchArgs } = await imp('tools/playtest/lib/platform.mjs');
  const { VIEWPORTS } = await imp('tools/proof/clip-presets.mjs');
  const { topCosts } = await imp('tools/test-harness/page-souls.mjs');
  browsersPath();
  const pw = resolvePlaywright();
  if (!pw) throw new Error('Playwright not found (PLAYTEST_PLAYWRIGHT_PKG names a package.json that depends on it)');
  const server = await vite(port);
  const browser = await pw.chromium.launch({ headless: true, args: [...launchArgs().args, '--enable-precise-memory-info'] });
  try {
    const probe = await browser.newPage();
    const gl = await probe.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); const x = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); });
    await probe.close();
    log(`renderer ${gl}`);
    const url = `http://127.0.0.1:${port}/src/crowd/bench.html?bodies=/.local/bodies/&n=${o.n}&walking=${o.walking}${kind}&area=${o.area}`;
    const res = { ...o, kind: a.kind ? basename(a.kind) : null, gl, rows: [] };
    for (let rep = 1; rep <= o.repeats; rep++) for (const tier of tiers) {
      log(`${tier} rep ${rep}`);
      const row = await arm({ browser, url, tier, VIEWPORTS, o, topCosts, profileTo: rep === 1 && o.profile > 0 ? join(out, `${tier}.cpuprofile`) : null }).catch((e) => ({ tier, error: String(e?.message ?? e).slice(0, 200) }));
      row.repeat = rep;
      res.rows.push(row);
      log(row.error ? `  error ${row.error}` : `  p50 ${row.p50} p95 ${row.p95} fps ${row.fps} draws ${row.draws} in view ${row.stats.visible} work ${row.work.p50}/${row.work.p95} heap ${row.heapMB}`);
    }
    writeFileSync(join(out, 'results.json'), JSON.stringify(res, null, 1));
    writeFileSync(join(out, 'REPORT.md'), report(res));
    log(`done: ${join(out, 'REPORT.md')}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().then(() => process.exit(0), (e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
