#!/usr/bin/env node
// Strobe detector (#1265): hold the camera still at fixed poses on a local fake-mind world with a paused clock, read
// consecutive drawn frames straight from the GPU, and fail where a region flips back and forth between frames with
// nothing moving (A→B→A). A still image cannot show this; the counts here are the evidence.
//
//   node tools/render-checks/strobe.mjs <new-out-dir> [mars|hamlet|poses.json] [template.json]
//
// mars (default): the tire ring zoom on mars-two from 1.5 m to 60 m and several bearings (#1265's case); hamlet: a
// doorframe sweep round the hello-hamlet cottage. poses.json: [{"name":"x","eye":[x,y,z],"at":[x,y,z]}, ...] with a
// template. The ordinary viewer is used (still things freeze and cull there, not on ?shot=1 pages); STROBE_PAGE=shot
// uses the pinned shot page instead.
// Writes <out>/<pose>.webm (real-speed canvas recording), <pose>-heat.png (where pixels flipped) and summary.json.
// Exit 1 when any pose fails the bar below. Port 4995 must be free. Build the web app first.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, stop, delay, ROOT, MARS_TWO_TEMPLATE } from '../mars-rotation/proof/lib.mjs';
import { openBrowser } from '../playtest/observer/browser.mjs';

/** The bar: a pixel strobes when its luma jumps by more than JUMP and comes back within BACK on the next frame,
 *  at least HITS times in the run. A pose fails when more than MAX_SHARE of the frame strobes, or any 32 px tile
 *  has more than MAX_TILE of its pixels strobing. */
export const BAR = { frames: 120, JUMP: 24, BACK: 8, HITS: 3, MAX_SHARE: 0.0005, MAX_TILE: 0.05, TILE: 32 };

const LIVE = process.env.STROBE_PAGE !== 'shot';
const RING = [-170, -104];
const ring = (name, dist, height, yawDeg, lookUp = 0) => { const a = yawDeg * Math.PI / 180, at = [RING[0], 0.6, RING[1]]; return { name, eye: [at[0] - Math.sin(a) * dist, height, at[2] + Math.cos(a) * dist], at: [at[0], at[1] + lookUp, at[2]] }; };
export const DEFAULT_POSES = [
  ring('ring-zoom-1.5m-north', 1.5, 0.9, 0, 0.3), ring('ring-zoom-3m-north', 3, 1.2, 0, 0.3), ring('ring-zoom-8m-north', 8, 2.5, 0),
  ring('ring-zoom-1.5m-east', 1.5, 0.9, 90, 0.3), ring('ring-zoom-3m-northeast', 3, 1.2, 45, 0.3), ring('ring-zoom-25m-north', 25, 8, 0),
  ring('ring-zoom-60m-northwest', 60, 18, -45),
];
const COTTAGE = [44, 10];
const door = (name, dist, height, yawDeg) => { const a = yawDeg * Math.PI / 180; return { name, eye: [COTTAGE[0] - Math.sin(a) * dist, height, COTTAGE[1] + Math.cos(a) * dist], at: [COTTAGE[0], 1.4, COTTAGE[1]] }; };
export const HAMLET_POSES = [0, 90, 180, 270].flatMap((y) => [door(`cottage-6m-${y}`, 6, 1.6, y), door(`cottage-18m-${y}`, 18, 4, y)]);

const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: strobe.mjs <new-out-dir> [mars|hamlet|poses.json] [template.json]'); process.exit(2); }
const set = process.argv[3] ?? 'mars';
const template = resolve(process.argv[4] ?? (set === 'hamlet' ? resolve(ROOT, 'worlds/templates/hello-hamlet.json') : MARS_TWO_TEMPLATE));
const poses = set === 'mars' ? DEFAULT_POSES : set === 'hamlet' ? HAMLET_POSES : JSON.parse(readFileSync(resolve(set), 'utf8'));
mkdirSync(out, { recursive: true });
let world, browser, failed = false;
try {
  world = await boot({ slug: 'strobe', port: 4995, template, out: out + '/world' });
  const r = await world.api('/v1/god/act', { body: { ops: [{ op: 'world', state: { time: { set: { hour: 11, n: 100 }, paused: true, clock: 'accelerated' }, weather: { kind: 'clear', clouds: 0, wind: 0, rain: 0, fog: 0 } } }] } });
  if (!r.accepted) throw Error(JSON.stringify(r));
  browser = await openBrowser({ serverRoot: ROOT, gpu: 'metal' });
  const context = await browser.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const results = [];
  for (const pose of poses) {
    // shot: the pinned still-camera page; live: the ordinary viewer opened at the same eye and target (no pin)
    await page.goto(`${world.base}/?${LIVE ? '' : 'shot=1&'}eye=${pose.eye.join(',')}&at=${pose.at.join(',')}`, { timeout: 120000 });
    await page.waitForFunction((live) => window.__soulsEntity && (live || document.title === 'ready'), LIVE, { timeout: 120000 });
    await delay(LIVE ? 15000 : 4000);
    const res = await page.evaluate(async (bar) => {
      const { renderer, camera } = window.__soulsEntity, gl = renderer.getContext(), cv = renderer.domElement, W = cv.width, H = cv.height;
      const px = new Uint8Array(W * H * 4), hits = new Uint16Array(W * H);
      let a = null, b = null, frames = 0, done;
      const finished = new Promise((r) => { done = r; });
      const stream = cv.captureStream(60), chunks = [], rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 12e6 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const eye0 = camera.position.toArray(), near = camera.near, far = camera.far;
      let moved = 0;
      // read each drawn frame right after the app draws it (before the compositor clears the buffer)
      const render = renderer.render; let pending = false;
      renderer.render = function (...args) {
        const out = render.apply(this, args);
        if (!pending && renderer.getRenderTarget() === null && frames < bar.frames) {
          pending = true;
          queueMicrotask(() => {
            pending = false; if (frames >= bar.frames) return;
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const c = new Uint8Array(W * H);
            for (let i = 0; i < c.length; i++) { const j = i * 4; c[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) | 0; }
            if (a && b) for (let i = 0; i < c.length; i++) { const d1 = b[i] - a[i], d2 = c[i] - b[i]; if (Math.abs(d1) > bar.JUMP && Math.abs(d2) > bar.JUMP && Math.sign(d1) !== Math.sign(d2) && Math.abs(c[i] - a[i]) <= bar.BACK) hits[i]++; }
            moved = Math.max(moved, camera.position.distanceTo({ x: eye0[0], y: eye0[1], z: eye0[2] }));
            a = b; b = c; frames++; if (frames >= bar.frames) done();
          });
        }
        return out;
      };
      rec.start(); await finished; renderer.render = render;
      await new Promise((r) => { rec.onstop = r; rec.stop(); }); stream.getTracks().forEach((t) => t.stop());
      // tiles and heat map (gl rows are bottom-up)
      let strobing = 0, worstTile = 0, worstAt = null; const T = bar.TILE, tiles = [];
      const heat = document.createElement('canvas'); heat.width = W; heat.height = H; const hx = heat.getContext('2d'), img = hx.createImageData(W, H);
      for (let i = 0; i < hits.length; i++) { if (hits[i] >= bar.HITS) strobing++; const y = H - 1 - Math.floor(i / W), x = i % W, k = (y * W + x) * 4, v = Math.min(255, hits[i] * 16); img.data[k] = v; img.data[k + 1] = 0; img.data[k + 2] = 0; img.data[k + 3] = 255; }
      for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) { let n = 0, s = 0; for (let y = ty; y < Math.min(H, ty + T); y++) for (let x = tx; x < Math.min(W, tx + T); x++) { n++; if (hits[y * W + x] >= bar.HITS) s++; } const f = s / n; if (f > bar.MAX_TILE) tiles.push([tx, H - ty - T, +f.toFixed(3)]); if (f > worstTile) { worstTile = f; worstAt = [tx, H - ty - T]; } }
      hx.putImageData(img, 0, 0);
      const blob = new Blob(chunks, { type: 'video/webm' }), bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { frames, W, H, near, far, moved, share: strobing / hits.length, strobing, worstTile, worstAt, failingTiles: tiles.length, tiles: tiles.slice(0, 40), video: btoa(bin), heat: heat.toDataURL('image/png').split(',')[1] };
    }, BAR);
    writeFileSync(`${out}/${pose.name}.webm`, Buffer.from(res.video, 'base64'));
    writeFileSync(`${out}/${pose.name}-heat.png`, Buffer.from(res.heat, 'base64'));
    await page.screenshot({ path: `${out}/${pose.name}.png` });
    delete res.video; delete res.heat;
    const pass = res.moved < 1e-3 && res.share <= BAR.MAX_SHARE && res.worstTile <= BAR.MAX_TILE;
    if (!pass) failed = true;
    results.push({ pose, pass, ...res });
    console.log(JSON.stringify({ pose: pose.name, pass, share: +res.share.toFixed(5), worstTile: +res.worstTile.toFixed(3), worstAt: res.worstAt, failingTiles: res.failingTiles, moved: res.moved, near: res.near, far: res.far }));
  }
  writeFileSync(`${out}/summary.json`, JSON.stringify({ bar: BAR, gpu: browser.gpu, results, errors }, null, 2));
} finally { await browser?.close(); if (world) await stop(world); }
process.exit(failed ? 1 : 0);
