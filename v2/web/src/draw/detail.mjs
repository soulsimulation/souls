// C12's measure (#3683), run by hand on hardware GL: the page as a phone sees it (390×844 CSS px, three device pixels,
// touch, so the phone tier; the CPU slowed `throttle` times as today's phone measures were), at the page's own first
// view (the crowd's middle from 55 m, Eden's busy square) with distance detail off (`detail=0`) and on, alternating,
// `repeats` times each. Each arm waits until every model has arrived, then times `seconds` of frames. Prints a JSON
// summary (no addresses or device names).
//
//   node v2/web/src/draw/detail.mjs '<page url with ?stream=…&models=…>' [seconds=20] [repeats=2] [throttle=4]
//
// Playwright and the hardware GL arguments come from tools/playtest/lib/platform.mjs.
import { browsersPath, launchArgs, resolvePlaywright } from '../../../../tools/playtest/lib/platform.mjs';

const [url, seconds = '20', repeats = '2', throttle = '4'] = process.argv.slice(2);
if (!url) throw new Error('usage: node detail.mjs <page url> [seconds] [repeats] [throttle]');
const pw = resolvePlaywright();
if (!pw) throw new Error('no Playwright');
browsersPath();
const { args, gpu } = launchArgs({ gpu: 'metal' });
const browser = await pw.chromium.launch({ headless: true, args });
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);

async function arm(name, extra) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url + extra);
  await page.waitForFunction(() => {
    const v = globalThis.v2, l = v?.things?.layer;
    return v && /playing/.test(document.getElementById('status').textContent) && v.world.extent && l && l.loaded > 0 && l.settled;
  }, null, { timeout: 300_000, polling: 500 });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(throttle) });
  await page.waitForTimeout(3000);
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
    const l = v.things.layer;
    return {
      frames: gaps.length, frameMs: { p50: q(gaps, 0.5), p95: q(gaps, 0.95) }, renderCpuMs: { p50: q(cpu, 0.5), p95: q(cpu, 0.95) },
      calls: q(calls, 0.5), triangles: q(tris, 0.5), tier: matchMedia('(pointer: coarse)').matches ? 'phone' : 'full',
      detail: l.detail, bands: { ...l.stats }, things: l.things.size,
    };
  }, Number(seconds) * 1000);
  await ctx.close();
  return { arm: name, ...frames, frameMs: { p50: r2(frames.frameMs.p50), p95: r2(frames.frameMs.p95) }, renderCpuMs: { p50: r2(frames.renderCpuMs.p50), p95: r2(frames.renderCpuMs.p95) }, bands: { ...frames.bands, cpuMs: r2(frames.bands.cpuMs) }, errors };
}

const runs = [];
for (let i = 0; i < Number(repeats); i++) for (const [name, extra] of [['off', '&detail=0'], ['on', '']]) runs.push(await arm(name, extra));
await browser.close();
console.log(JSON.stringify({ measure: 'C12 phone frame time, busy square', gpu, seconds: Number(seconds), throttle: Number(throttle), runs }, null, 1));
