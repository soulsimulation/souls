// Full-frame capture qualification, independent of product camera behavior. All output is private attempt evidence.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const fail = name => { throw Error('proof.capture-' + name); };
export function captureDeficit(size, metadata) {
  for (const n of [size?.width, size?.height, metadata?.deviceWidth, metadata?.deviceHeight]) if (!Number.isSafeInteger(n) || n <= 0) fail('geometry-invalid');
  return { width: size.width - metadata.deviceWidth, height: size.height - metadata.deviceHeight };
}
export function checkCapturePixels(bytes, actual, size, tolerance = 50) {
  if (actual.width !== size.width || actual.height !== size.height || bytes.length !== size.width * size.height * 3) fail('resolution-mismatch');
  const samples = [[8, 8, [255, 0, 0]], [size.width - 9, 8, [0, 255, 0]], [8, size.height - 9, [0, 0, 255]], [size.width - 9, size.height - 9, [255, 255, 0]]];
  for (const [x, y, color] of samples) {
    const at = (y * size.width + x) * 3;
    if (color.some((v, i) => Math.abs(bytes[at + i] - v) > tolerance)) fail('edge-pixels-mismatch');
  }
  return true;
}
export function inspectCaptureFrame(file, size, seconds = null) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file], { timeout: 5000, encoding: 'utf8' }));
  const actual = probe.streams?.[0] ?? {};
  const pixels = execFileSync('ffmpeg', ['-v', 'error', ...(seconds === null ? [] : ['-ss', String(seconds)]), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  checkCapturePixels(pixels, actual, size); return { seconds, width: actual.width, height: actual.height, edges: 'pass' };
}
export async function waitCapturePresentation(page, { signal, timeoutMs = 5000 } = {}) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    await Promise.race([
      page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('proof.capture-presentation-timeout')), timeoutMs);
        abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    signal?.throwIfAborted();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function rawFrame(cdp, page, signal, timeoutMs) {
  let timer, abort, handler;
  try {
    const frame = new Promise((ok, no) => {
      timer = setTimeout(() => no(Error('proof.capture-frame-timeout')), timeoutMs);
      abort = () => no(signal.reason); signal?.addEventListener('abort', abort, { once: true });
      handler = event => { void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); ok(event); };
      cdp.on('Page.screencastFrame', handler);
    });
    signal?.throwIfAborted();
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 100 });
    await page.evaluate(() => document.body.dataset.captureFrame = String(Number(document.body.dataset.captureFrame ?? 0) + 1));
    return await frame;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); if (handler) cdp.off('Page.screencastFrame', handler);
    await cdp.send('Page.stopScreencast').catch(() => {});
  }
}
/** Neutral calibration only: no overlays, poses or JS mutations are added to the product page. Geometry and encoded
 * corner pixels must pass before the actual-page recording begins. No crop, scaling, or fixed chrome-height offset. */
export async function prepareCaptureViewport(page, { size, directory, signal, timeoutMs = 5000 }) {
  if (!Number.isSafeInteger(size?.width) || !Number.isSafeInteger(size?.height) || size.width < 32 || size.height < 32) fail('size-invalid');
  mkdirSync(directory, { recursive: true });
  const evidence = { size, frames: [], corrected: false, status: 'fail', normalSpeedPlayback: 'not-demonstrated' };
  const cdp = await page.context().newCDPSession(page);
  const css = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const geometry = value => { if (value.width !== size.width || value.height !== size.height || value.dpr !== 1) fail('css-viewport-mismatch'); };
  let recording = false;
  try {
    await page.setContent('<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#162536;color:white}i{position:fixed;width:18px;height:18px}.tl{left:0;top:0;background:#f00}.tr{right:0;top:0;background:#0f0}.bl{left:0;bottom:0;background:#00f}.br{right:0;bottom:0;background:#ff0}p{margin:24px;font:18px sans-serif}b{position:fixed;left:45%;top:45%;width:20px;height:20px;background:white;animation:move .7s infinite alternate linear}@keyframes move{to{transform:translateX(30px)}}</style><i class=tl></i><i class=tr></i><i class=bl></i><i class=br></i><p>Full viewport capture calibration</p><b></b>');
    geometry(await css());
    await waitCapturePresentation(page, { signal, timeoutMs });
    let frame = await rawFrame(cdp, page, signal, timeoutMs);
    writeFileSync(join(directory, 'raw-before.jpg'), Buffer.from(frame.data, 'base64'), { flag: 'wx' });
    evidence.frames.push({ phase: 'before', metadata: frame.metadata });
    const deficit = captureDeficit(size, frame.metadata);
    if (deficit.width || deficit.height) {
      const window = await cdp.send('Browser.getWindowForTarget');
      evidence.correction = { deficit, bounds: window.bounds };
      await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { width: window.bounds.width + deficit.width, height: window.bounds.height + deficit.height } });
      geometry(await css());
      await waitCapturePresentation(page, { signal, timeoutMs });
      frame = await rawFrame(cdp, page, signal, timeoutMs); evidence.corrected = true;
      evidence.frames.push({ phase: 'after', metadata: frame.metadata });
    }
    const after = captureDeficit(size, frame.metadata); if (after.width || after.height) fail('raw-viewport-mismatch');
    const raw = join(directory, 'raw-verified.jpg'); writeFileSync(raw, Buffer.from(frame.data, 'base64'), { flag: 'wx' }); inspectCaptureFrame(raw, size);
    await page.screenshot({ path: join(directory, 'reference.png') });
    const video = join(directory, 'calibration.webm'); await page.screencast.start({ path: video, size }); recording = true;
    await page.waitForTimeout(1200); signal?.throwIfAborted(); await page.screencast.stop(); recording = false;
    evidence.encodedFrames = [.25, .5, .75].map(seconds => inspectCaptureFrame(video, size, seconds));
    evidence.status = 'pass'; return evidence;
  } catch (error) { evidence.error = String(error); throw error; }
  finally {
    if (recording) await page.screencast.stop().catch(() => {});
    await cdp.detach().catch(() => {}); writeFileSync(join(directory, 'capture-geometry.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }
}
