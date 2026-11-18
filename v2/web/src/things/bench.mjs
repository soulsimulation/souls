// V8's measure (#2718), run by hand: the page with Eden's things doubled (`copies=2`) and without (`things=0`), the
// same stream of 1,000 walkers, the same overview of both copies; `<seconds>` of frames each, `<repeats>` times,
// alternating arms. Then, with things, one floor lamp switched on and off ten times: what the switch cost and what
// the next frame uploaded beyond the frame before it. Prints a JSON summary (no addresses or device names).
//
//   node v2/web/src/things/bench.mjs '<page url with ?stream=…&models=…>' <out.json> [seconds=60] [repeats=2]
//
// Playwright and the hardware GL arguments come from tools/playtest/lib/platform.mjs.
import { writeFileSync } from 'node:fs';
import { browsersPath, launchArgs, resolvePlaywright } from '../../../../tools/playtest/lib/platform.mjs';

const [url, out, seconds = '60', repeats = '2'] = process.argv.slice(2);
if (!out) throw new Error('usage: node bench.mjs <page url> <out.json> [seconds] [repeats]');
const pw = resolvePlaywright();
if (!pw) throw new Error('no Playwright');
browsersPath();
const { args, gpu } = launchArgs({ gpu: 'metal' });
const browser = await pw.chromium.launch({ headless: true, args });
const models = await (await fetch(new URL('models.json', new URL(new URL(url).searchParams.get('models'), url)))).json();
const lamp = models.kinds?.find((k) => k.ref === 'core-floor-lamp@2')?.model;

const q = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => (a.length ? q(a)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);

async function arm(name, extra) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url + extra);
  const things = name === 'things';
  const t0 = Date.now();
  await page.waitForFunction((things) => {
    const v = globalThis.v2;
    if (!v || v.world.bodies.count < 1000 || !v.world.extent) return false; // playing: every body drawn
    if (!things) return true;
    const l = v.things.layer;
    return l && l.things.size >= 10_000 && l.loaded > 0 && l.settled;
  }, things, { timeout: 240_000, polling: 500 });
  const ready = (Date.now() - t0) / 1000;
  // The same overview for both arms: both copies' ground in view.
  await page.evaluate(() => {
    const v = globalThis.v2, [x0, z0, x1, z1] = v.world.extent, w = x1 - x0;
    const at = v.cam.camera.position.clone().set(x0 + w, 0, (z0 + z1) / 2);
    v.cam.setExtent([x0, z0, x1 + w, z1]);
    v.cam.look(at, 0.0, -0.75, 1.1 * w);
  });
  await page.waitForTimeout(2000);
  const frames = await page.evaluate(async (ms) => {
    const v = globalThis.v2, r = v.renderer, render = r.render;
    const cpu = [], calls = [], tris = [], gaps = [];
    r.render = function (...a) {
      const s = performance.now();
      render.apply(this, a);
      cpu.push(performance.now() - s);
      calls.push(r.info.render.calls);
      tris.push(r.info.render.triangles);
    };
    let last = performance.now();
    await new Promise((done) => {
      const end = last + ms;
      const tick = (now) => { gaps.push(now - last); last = now; now < end ? requestAnimationFrame(tick) : done(); };
      requestAnimationFrame(tick);
    });
    r.render = render;
    const gl = r.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    return { cpu, calls, tris, gaps: gaps.slice(1), heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
      gl: info ? /swiftshader|llvmpipe|software/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) ? 'software' : 'hardware' : 'unknown',
      bodies: v.world.bodyIds.length, things: v.things.layer?.things.size ?? 0, boxes: v.things.layer?.waiting ?? 0, draws: v.things.layer?.draws ?? 0, loaded: v.things.layer?.loaded ?? 0, failed: v.things.layer?.failed ?? 0 };
  }, Number(seconds) * 1000);
  let profile = null;
  if (things && lamp) profile = await page.evaluate(async (lamp) => {
    const v = globalThis.v2, r = v.renderer, gl = r.getContext(), render = r.render, l = v.things.layer;
    const id = [...l.things.values()].find((t) => t.model === lamp && t.slots.some((s) => s.glow))?.id;
    if (!id) return { error: 'no floor lamp drawn' };
    let log = [];
    const wrap = (fn, bytes) => { const f = gl[fn].bind(gl); gl[fn] = (...a) => (log.push(`${fn}:${bytes(a)}`), f(...a)); };
    const size = (x) => (x && x.byteLength !== undefined ? x.byteLength : typeof x === 'number' ? x : 0);
    wrap('bufferData', (a) => size(a[1]));
    wrap('bufferSubData', (a) => (a[4] !== undefined ? a[4] * a[2].BYTES_PER_ELEMENT : a[3] !== undefined ? size(a[2]) - a[3] * a[2].BYTES_PER_ELEMENT : size(a[2])));
    for (const fn of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) wrap(fn, (a) => a.slice(1, 6).filter((x) => typeof x === 'number').join('x'));
    const rendered = [];
    r.render = function (...a) {
      log = [];
      const s = performance.now();
      render.apply(this, a);
      rendered.push({ ms: performance.now() - s, uploads: log });
    };
    const frame = () => new Promise((d) => requestAnimationFrame(() => d()));
    const runs = [];
    for (let k = 0; k < 10; k++) {
      await frame(); await frame();
      const before = rendered.length;
      await new Promise((d) => setTimeout(d, 0));
      const s = performance.now();
      const slots = l.light(id, k % 2 === 0);
      const switchMs = performance.now() - s;
      await frame(); await frame();
      const prev = rendered[before - 1], next = rendered[before];
      const extra = [...next.uploads];
      for (const u of prev.uploads) { const i = extra.indexOf(u); if (i >= 0) extra.splice(i, 1); }
      runs.push({ on: k % 2 === 0, slots, switchMs, frameMs: next.ms, frameBeforeMs: prev.ms, extraUploads: extra,
        geometryUploads: next.uploads.filter((u) => u.startsWith('bufferData')).length });
    }
    r.render = render;
    return { runs };
  }, lamp);
  await page.close();
  const fps = frames.gaps.map((g) => 1000 / g);
  return {
    arm: name, readySec: Math.round(ready), gl: frames.gl, bodies: frames.bodies, things: frames.things, boxes: frames.boxes, models: { loaded: frames.loaded, failed: frames.failed },
    frames: frames.gaps.length, frameMs: { p50: r2(pct(frames.gaps, 50)), p95: r2(pct(frames.gaps, 95)) }, fpsP50: r2(pct(fps, 50)),
    renderCpuMs: { p50: r2(pct(frames.cpu, 50)), p95: r2(pct(frames.cpu, 95)) },
    draws: { p50: pct(frames.calls, 50), max: Math.max(...frames.calls) }, layerDraws: frames.draws,
    trianglesM: r2(pct(frames.tris, 50) / 1e6), heapMB: r2(frames.heapMB), errors, profile,
  };
}

const results = [];
for (let k = 0; k < Number(repeats); k++) {
  results.push(await arm('things', '&copies=2'));
  results.push(await arm('none', '&things=0'));
  console.log(JSON.stringify(results.slice(-2).map(({ profile, ...x }) => x)));
}
await browser.close();
writeFileSync(out, JSON.stringify({ gpu, seconds: Number(seconds), repeats: Number(repeats), results }, null, 1) + '\n');
