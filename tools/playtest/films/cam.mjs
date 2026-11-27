// One live camera on a world's old page, recorded uncut at real speed (the canvas and the page's own sound), for as long
// as asked or until <out>.stop appears. The camera is a planned live track (souls-shot/1, ?track=): a continuous move,
// a function of the seconds since the recording started, so several cameras can film one scene without any cue.
//   node cam.mjs --url <world page> --out <file.webm> --seconds 1500 --cam '<json>' [--size 1920x1080] [--fps 30]
//        [--hour 16:30] [--gpu vulkan|egl] [--mbps 14]
// cam: {move: 'orbit', c: [x, z], r, h, look, fov, period, phase, dir}
//      {move: 'pass', a: [x, z], b: [x, z], ta: [x, z], tb: [x, z], h, ty, fov, period}   (there and back, eased ends)
//      {move: 'drift', p1: [x,y,z], p2: [x,y,z], t1: [x,y,z], t2: [x,y,z], fov, period}  (pose 1 to 2 and back)
// Writes <out> as it records, <out>.json (start time in ms since epoch, frame pacing) at the end.
import { chromium } from '@playwright/test';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt('url'), out = opt('out'), seconds = Number(opt('seconds', 600)), cam = JSON.parse(opt('cam'));
const [width, height] = opt('size', '1920x1080').split('x').map(Number), fps = Number(opt('fps', 30)), mbps = Number(opt('mbps', 14));
const log = (s) => console.error(`cam ${cam.name ?? cam.move}: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lerp = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);
const pose = (t) => {
  if (cam.move === 'orbit') {
    const a = (cam.phase ?? 90) * Math.PI / 180 + (cam.dir ?? 1) * 2 * Math.PI * t / cam.period;
    return { position: [cam.c[0] + cam.r * Math.cos(a), cam.h, cam.c[1] + cam.r * Math.sin(a)], target: [cam.c[0], cam.look ?? 1.3, cam.c[1]], fov: cam.fov ?? 45 };
  }
  const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / cam.period);
  if (cam.move === 'pass') { const p = lerp(cam.a, cam.b, u), q = lerp(cam.ta, cam.tb, u); return { position: [p[0], cam.h, p[1]], target: [q[0], cam.ty ?? 1.2, q[1]], fov: cam.fov ?? 42 }; }
  if (cam.move === 'drift') return { position: lerp(cam.p1, cam.p2, u), target: lerp(cam.t1, cam.t2, u), fov: cam.fov ?? 45 };
  throw Error(`move ${cam.move}`);
};
const hz = 10, samples = [];
for (let i = 0; i <= seconds * hz; i++) samples.push({ t: i / hz, ...pose(i / hz), key: 'desired', cut: false, valid: true, readability: 1 });
const shot = { schema: 'souls-shot/1', live: true, seconds, aspect: width / height, move: cam.name ?? cam.move, track: { schema: 'mars-camera-track/1', hz, duration: seconds, samples } };

const gpuArgs = opt('gpu', 'vulkan') === 'egl' ? ['--use-gl=angle', '--use-angle=gl-egl'] : ['--use-angle=vulkan', '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE'];
const browser = await chromium.launch({ headless: true, args: [...gpuArgs, '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'] });
let side = { url, cam, seconds, size: [width, height], fps };
try {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const file = createWriteStream(out); let pending = Promise.resolve();
  await page.exposeFunction('__lvChunk', (b64) => { pending = pending.then(() => new Promise((r) => file.write(Buffer.from(b64, 'base64'), r))); });
  await page.exposeFunction('__camStarted', (ms) => { side.startMs = ms; writeFileSync(`${out}.start`, String(ms)); log(`recording from ${new Date(ms).toISOString()}`); });
  await page.route((u) => u.pathname === '/__lv/shot.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(shot) }));
  const u = new URL(url); u.searchParams.set('hour', opt('hour', '16:30')); u.searchParams.set('dpr', '1'); u.searchParams.set('track', '/__lv/shot.json');
  await page.goto(u.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.body && !document.querySelector('.viewer-arrival') && !!document.querySelector('.viewer-history[data-viewer-ready="true"]'), null, { timeout: 300_000 });
  await page.waitForFunction(() => !!window.__edenSound && !!window.__soulsShot, null, { timeout: 60_000 }).catch(() => log('no sound or track handle'));
  await page.mouse.click(width / 2, height / 2);   // a real gesture: unlocks the page's sound
  // the top bar takes some of the page: grow the window until the canvas itself is the asked size
  const drawn = await page.evaluate(() => { const c = document.querySelector('canvas[aria-label="Live 3D view of the world"]'); return c ? [c.clientWidth, c.clientHeight] : null; });
  if (drawn && (drawn[0] !== width || drawn[1] !== height)) await page.setViewportSize({ width: width + (width - drawn[0]), height: height + (height - drawn[1]) });
  await sleep(4000);
  const stopFile = `${out}.stop`;
  await page.exposeFunction('__camStop', () => existsSync(stopFile));
  side.pacing = await page.evaluate(async ({ seconds, fps, mbps, mimes, mode }) => {
    const canvas = document.querySelector('canvas[aria-label="Live 3D view of the world"]');
    const stream = mode === 'norec' ? null : canvas.captureStream(mode === 'manual' ? 0 : fps), sound = mode === 'nosound' || mode === 'norec' ? null : window.__edenSound?.tap?.();
    for (const t of sound?.getAudioTracks() ?? []) stream.addTrack(t);
    const mime = [...mimes, 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = mode === 'norec' ? { start() {}, stop() { this.onstop?.(); } } : new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: mbps * 1e6, audioBitsPerSecond: 192_000 });
    const sends = [];
    rec.ondataavailable = (e) => { if (e.data.size) sends.push(e.data.arrayBuffer().then((b) => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return window.__lvChunk(btoa(s)); })); };
    let frames = 0, slow = 0, last = 0, on = true;
    const tick = (t) => { if (last) { frames++; if (t - last > 40) slow++; } last = t; if (on) requestAnimationFrame(tick); };
    rec.start(1000); requestAnimationFrame(tick); window.__soulsShot?.play(); window.__camStarted(Date.now());
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000 && !(await window.__camStop())) await new Promise((r) => setTimeout(r, 2000));
    const took = (performance.now() - t0) / 1000;
    on = false; const stopped = new Promise((r) => { rec.onstop = r; }); rec.stop(); await stopped;
    for (const s of sends) await s;
    return { mime, audio: !!sound, seconds: took, fps: +(frames / took).toFixed(1), over40ms: slow, canvas: [canvas.width, canvas.height] };
  }, { seconds, fps, mbps, mimes: opt('mime', '').split(' ').filter(Boolean), mode: opt('mode', 'rec') });
  await pending; await new Promise((r) => file.end(r));
  side.pageErrors = errors;
} finally { await browser.close(); writeFileSync(`${out}.json`, JSON.stringify(side, null, 1)); }
log(`done ${JSON.stringify(side.pacing)}`);
