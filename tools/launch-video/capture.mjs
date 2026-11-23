#!/usr/bin/env node
// capture.mjs — one take of a world on the old page (#1963; 0.135 P3 on the new engine): the world's own canvas and the
// game's own sound, recorded together, uncut and at real speed.
//
//   node tools/launch-video/capture.mjs --url <local world url> --out <file.mp4> [--seconds 10] [--size 1080x1350]
//        [--fps 60] [--mbps 30] [--hour HH:MM] [--settle 6] [--music on|off] [--headed]
//        [--shot <shot.json>] [--follow <soul id>]
//
// --shot:   a planned camera (`souls-shot/1`, apps/web/src/WorldShotTrack.ts). A range over the world's history
//           (fromTick..toTick, take ticks as `#t=` names them) is cued paused on its first frame and played at the
//           world's own speed, and the take lasts exactly the range. A live track (`live: true`, `seconds`) starts its
//           clock with the take.
// --follow: the camera follows that Soul (its id as the page's Souls have it, the new client's `s_…-n`), as a
//           person's Follow does.
// --hour:   the picture's light (`?hour=`); a world on the new engine keeps its own clock.
//
// Unlike the proof recorder (a screencast of the whole page, no sound), this records the WebGL canvas alone
// (canvas.captureStream), so no interface is on screen, with the soundscape's own tap (`__edenSound.tap()`) as the
// audio track of the same MediaRecorder, so picture and sound stay in sync. Real Chrome on the GPU under the shared
// Chrome lease. Frame pacing is measured in the page and written to the sidecar (<out>.json). Local worlds only (fake
// minds); the canvas carries no URL, and name tags and speech bubbles (DOM, not canvas) are not in the picture. Never
// commit the output: write under .local/. `capture()` is the same as a function, for scene.mjs.
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setEffects, setMusic } from '../browser/world-controls.mjs';
import { worldArrived } from '../playtest/lib/arrival.mjs';
import { isMain } from '../lib/is-main.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page's address for a take: `?hour=` for the light, `?track=` for a planned camera (served by the capture). */
export function takeUrl(url, { hour = null, shot = false } = {}) {
  const u = new URL(url);
  if (hour) u.searchParams.set('hour', hour);
  if (shot) u.searchParams.set('track', '/__lv/shot.json');
  return u.href;
}
/** A take's length: a range's exactly (its ticks at its dt), a live track's its seconds, else the asked seconds. */
export const takeSeconds = (shot, seconds) => (shot && !shot.live ? (shot.toTick - shot.fromTick) * shot.dt : shot?.live ? shot.seconds : seconds);

/** Records one take. `onPlay()` is called as the recording starts (a staged scene's beats run from then). → the sidecar */
export async function capture({ url, out, seconds = 10, size = '1080x1350', fps = 60, mbps = 30, hour = null, settle = 6, music = false, headed = false, shot = null, follow = null, onPlay = null, log = () => {} }) {
  if (!url || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw Error('--url must be a local world URL');
  out = resolve(out);
  seconds = takeSeconds(shot, seconds);
  const [width, height] = size.split('x').map(Number);
  mkdirSync(dirname(out), { recursive: true });
  const chromium = createRequire(resolve(root, 'mars/viewer/package.json'))('@playwright/test').chromium;
  const { chromeLease } = await import(process.env.CHROME_LEASE_MODULE ?? '../god-skill/lib/chrome-lease.mjs');
  const release = await chromeLease('launch-video');
  const raw = out.replace(/\.mp4$/, '') + '.webm';
  let pacing = null, gpu = null; const errors = [];
  try {
    const args = ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
    const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args }).catch(() => chromium.launch({ headless: !headed, args }));
    try {
      const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
      const file = createWriteStream(raw); let pending = Promise.resolve();
      await page.exposeFunction('__lvChunk', (b64) => { pending = pending.then(() => new Promise((r) => file.write(Buffer.from(b64, 'base64'), r))); });
      if (shot) await page.route((u) => u.pathname === '/__lv/shot.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(shot) }));
      await page.goto(takeUrl(url, { hour, shot: !!shot }), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(worldArrived, null, { timeout: 180_000 });
      await page.waitForFunction(() => !!window.__edenSound, null, { timeout: 60_000 });
      await page.mouse.click(width / 2, height / 2); // a real gesture: unlocks the page's sound
      await setEffects(page, true); await setMusic(page, music);
      // the top bar takes some of the page: grow the window until the canvas itself is the asked size
      const drawn = await page.evaluate(() => { const c = document.querySelector('canvas[aria-label="Live 3D view of the world"]'); return c ? [c.clientWidth, c.clientHeight] : null; });
      if (drawn && (drawn[0] !== width || drawn[1] !== height)) await page.setViewportSize({ width: width + (width - drawn[0]), height: height + (height - drawn[1]) });
      await sleep(settle * 1000);
      if (follow) {
        await page.waitForFunction((id) => window.__soulsV2?.souls?.has?.(id), follow, { timeout: 60_000 }).catch(() => log(`follow: ${follow} is not among the page's Souls`));
        await page.evaluate((id) => window.dispatchEvent(new CustomEvent('sim:follow-soul', { detail: { soulId: id } })), follow);
        await sleep(1500);
      }
      if (shot) {
        await page.waitForFunction(() => !!window.__soulsShot, null, { timeout: 30_000 });
        if (!(await page.evaluate(() => window.__soulsShot.cue()))) throw Error('the shot\'s range is not in the world\'s history');
        if (!shot.live) await sleep(2500); // the first frame of the range, people drawn, camera on its first pose
      }
      gpu = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'), x = c?.getExtension('WEBGL_debug_renderer_info'); return x ? c.getParameter(x.UNMASKED_RENDERER_WEBGL) : null; });
      onPlay?.();
      pacing = await page.evaluate(async ({ seconds, fps, mbps }) => {
        const canvas = document.querySelector('canvas[aria-label="Live 3D view of the world"]');
        if (!canvas) throw Error('no world canvas');
        const stream = canvas.captureStream(fps), sound = window.__edenSound.tap();
        for (const t of sound?.getAudioTracks() ?? []) stream.addTrack(t);
        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: mbps * 1e6, audioBitsPerSecond: 256_000 });
        const sends = [];
        rec.ondataavailable = (e) => { if (e.data.size) sends.push(e.data.arrayBuffer().then((b) => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return window.__lvChunk(btoa(s)); })); };
        const dts = []; let last = 0, on = true;
        const tick = (t) => { if (last) dts.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
        rec.start(1000); requestAnimationFrame(tick); window.__soulsShot?.play();
        await new Promise((r) => setTimeout(r, seconds * 1000));
        on = false; const stopped = new Promise((r) => { rec.onstop = r; }); rec.stop(); await stopped;
        for (const s of sends) await s;
        dts.sort((a, b) => a - b); const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
        return { shotTick: window.__soulsShot?.tick() ?? null, cameraShot: canvas.dataset.cameraShot ?? null, mime, audio: !!sound, canvas: [canvas.width, canvas.height], frames: dts.length, fps: +(dts.length / seconds).toFixed(1), ms: { p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) }, over25ms: dts.filter((d) => d > 25).length };
      }, { seconds, fps, mbps });
      await pending; await new Promise((r) => file.end(r));
    } finally { await browser.close(); }
  } finally { release(); }

  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-r', String(fps), '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out], { encoding: 'utf8' });
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,nb_frames,avg_frame_rate,duration', '-of', 'json', out], { encoding: 'utf8' });
  const vol = spawnSync('ffmpeg', ['-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/(mean|max)_volume: [-\d.]+ dB/g) ?? [];
  const sidecar = { size: [width, height], seconds, shot: shot ? { move: shot.move, live: !!shot.live, fromTick: shot.fromTick ?? null, toTick: shot.toTick ?? null } : null, follow, fps, hour, music, gpu, pacing, volume: vol, streams: JSON.parse(probe.stdout || '{}').streams ?? [], pageErrors: errors, ffmpeg: ff.status === 0 ? 'ok' : ff.stderr.slice(0, 400) };
  writeFileSync(`${out}.json`, JSON.stringify(sidecar, null, 1));
  if (ff.status !== 0) throw Error(`ffmpeg: ${ff.stderr.slice(0, 300)}`);
  return sidecar;
}

if (isMain(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const flag = (k) => process.argv.includes(`--${k}`);
  const sidecar = await capture({ url: arg('url'), out: arg('out', '.local/launch-video/take.mp4'), seconds: Number(arg('seconds', 10)), size: arg('size', '1080x1350'),
    fps: Number(arg('fps', 60)), mbps: Number(arg('mbps', 30)), hour: arg('hour', null), settle: Number(arg('settle', 6)), music: arg('music', 'off') === 'on', headed: flag('headed'),
    shot: arg('shot') ? JSON.parse(readFileSync(resolve(arg('shot')), 'utf8')) : null, follow: arg('follow', null) });
  console.log(JSON.stringify(sidecar, null, 1));
}
