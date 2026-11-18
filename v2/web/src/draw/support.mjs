// Does anything float, and what do the shadows cost? Run by hand on hardware GL: the page on Eden's stream, once every
// model asked for has arrived, runs `v2.support()` (support.ts: each placed thing's base against its slot, the drawn
// ground, the water, a deck or its room's floor), then times `seconds` of frames at the page's own first view (the
// crowd's middle from 55 m). Prints a JSON summary (no addresses or device names).
//
//   node v2/web/src/draw/support.mjs '<page url with ?stream=…&models=…>' [seconds=30]
//
// Playwright and the hardware GL arguments come from tools/playtest/lib/platform.mjs.
import { browsersPath, launchArgs, resolvePlaywright } from '../../../../tools/playtest/lib/platform.mjs';

const [url, seconds = '30'] = process.argv.slice(2);
if (!url) throw new Error('usage: node support.mjs <page url> [seconds]');
const pw = resolvePlaywright();
if (!pw) throw new Error('no Playwright');
browsersPath();
const { args, gpu } = launchArgs({ gpu: 'metal' });
const browser = await pw.chromium.launch({ headless: true, args });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
await page.goto(url);
await page.waitForFunction(() => {
  const v = globalThis.v2, l = v?.things?.layer;
  return v && /playing/.test(document.getElementById('status').textContent) && v.world.extent && l && l.loaded > 0 && l.settled;
}, null, { timeout: 300_000, polling: 500 });
await page.waitForTimeout(3000);
const support = await page.evaluate(() => globalThis.v2.support());
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
    const tick = (now) => {
      gaps.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  r.render = render;
  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    frames: gaps.length, frameMs: { p50: r2(q(gaps, 0.5)), p95: r2(q(gaps, 0.95)) }, renderCpuMs: { p50: r2(q(cpu, 0.5)), p95: r2(q(cpu, 0.95)) },
    draws: q(calls, 0.5), triangles: q(tris, 0.5), shadows: r.shadowMap.enabled, bodies: v.world.bodyIds?.length,
    status: document.getElementById('status').textContent.split('\n').slice(-1)[0],
  };
}, Number(seconds) * 1000);
console.log(JSON.stringify({ gpu, support, frames, errors }, null, 1));
await browser.close();
