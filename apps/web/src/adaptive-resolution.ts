// Lane PERF: adaptive resolution for new (entity) worlds. On the M3 Max the GPU time of littlemartians-two at dpr 2 is
// ~8.5 ms a frame (4.4 M triangles, ~460 textures); a small laptop's GPU is several times slower, so the same scene
// would run well under 60 fps at full retina resolution. Rendering at 1 instead of 2 drawing-buffer pixels per CSS
// pixel cut that GPU time by a third (8.6 → 5.8 ms), so the pixel ratio is the dial:
//   - every 2 s window the median rAF interval is compared with the display's (the best median seen);
//   - two slow windows in a row (median > 1.3× the display's) step the pixel ratio down by 15%, never below 0.5;
//   - a step that does not make frames faster (CPU-bound) is undone, and no step down is tried for 2 min;
//   - after 12 s of full-rate frames it steps back up; if that makes it slow again, it steps down and stays for 60 s.
// A fast machine never leaves its device ratio (capped at 2, as before). Nothing adapts in the first 8 s (loading). After
// that a window with a stall (one frame over 250 ms and over 4× the window's median: a hitch, a hidden tab) does not
// count, but a renderer that is slow on every frame does: SwiftShader drew Eden at about 2 fps and, when every 2 s
// window held a frame over 250 ms, it never stepped down. A software renderer (SwiftShader, llvmpipe: no GPU) starts at
// 0.5 and LiveWorld turns its shadows off. `?dpr=fixed` turns it off; `?dpr=<n>` pins a ratio.
import type * as THREE from 'three';

const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const MODE = q.get('dpr');
/** The lowest pixel ratio adaptive resolution steps down to, and where a software renderer starts. */
export const MIN_PIXEL_RATIO = 0.5;

/** A WebGL renderer string that names a software rasterizer (no GPU): SwiftShader, llvmpipe, softpipe. */
export function softwareRenderer(name: string | null | undefined) {
  return !!name && /swiftshader|llvmpipe|softpipe|software/i.test(name);
}
/** The renderer's WebGL renderer string (unmasked where the browser allows it); null when it cannot be read. */
export function rendererName(renderer: THREE.WebGLRenderer): string | null {
  try {
    const gl = renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '') || null;
  } catch { return null; }
}

/** W2b: screenshots use one drawing-buffer pixel per requested viewport pixel, even on slow GPUs. A software renderer
 *  (not in shot mode) starts at MIN_PIXEL_RATIO. */
export function worldResolution(renderer: THREE.WebGLRenderer, deviceRatio: number, entityWorld: boolean, shotMode: boolean, software = false) {
  const start = shotMode ? 1 : software ? Math.min(deviceRatio, MIN_PIXEL_RATIO) : Math.min(deviceRatio, 2);
  renderer.setPixelRatio(start);
  return entityWorld && !shotMode ? new AdaptiveResolution(renderer, deviceRatio, start) : null;
}

export class AdaptiveResolution {
  private readonly max: number;
  private ratio: number;
  private last = 0;
  private window: number[] = [];
  private windowStart = 0;
  private best = Infinity;
  private slowRuns = 0;
  private fastFor = 0;
  private lockedUntil = 0;
  private justRaised = 0;
  private noDownUntil = 0;
  private lastDown: { from: number; median: number } | null = null;
  private readonly started = performance.now();
  readonly log: { t: number; ratio: number; median: number }[] = [];
  // An explicit field, not a parameter property, so Node's strip-only TypeScript loader can run the tests.
  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, deviceRatio: number, start?: number) {
    this.renderer = renderer;
    this.max = Math.min(deviceRatio, 2);
    const pinned = MODE && Number.isFinite(Number(MODE)) ? Math.max(0.5, Math.min(2, Number(MODE))) : null;
    this.ratio = pinned ?? start ?? this.max;
    if (pinned) renderer.setPixelRatio(pinned);
  }
  get pixelRatio() { return this.ratio; }
  get enabled() { return MODE !== 'fixed' && !(MODE && Number.isFinite(Number(MODE))); }

  /** Call once per rendered frame. */
  frame(now: number) {
    if (!this.enabled) return;
    if (this.last) this.window.push(now - this.last);
    this.last = now;
    if (!this.windowStart) this.windowStart = now;
    // a window is 2 s, held open (up to 10 s) until it has 3 frames, so a renderer at 1 fps is judged too
    if (now - this.windowStart < 2000 || (this.window.length < 3 && now - this.windowStart < 10_000)) return;
    const iv = this.window; this.window = []; this.windowStart = now;
    if (iv.length < 3 || now - this.started < 8000) { this.slowRuns = 0; return; }
    const s = [...iv].sort((a, b) => a - b), median = s[s.length >> 1];
    // a stall (one long frame among quicker ones) says nothing of the renderer; a frame that is slow like the rest does
    if (s[s.length - 1] > Math.max(250, median * 4)) { this.slowRuns = 0; return; }
    this.best = Math.min(this.best, Math.max(median, 1000 / 240), 1000 / 60);   // never judge against less than 60 Hz: a slow machine is slow from its first frame
    const slow = median > this.best * 1.3, fast = median < this.best * 1.08;
    // a step down that did not help: the frame is CPU-bound, fewer pixels only blur it; undo and leave it for 2 min
    if (this.lastDown) { const d = this.lastDown; this.lastDown = null; if (median > d.median * 0.95) { this.noDownUntil = now + 120_000; this.slowRuns = 0; this.set(d.from, now, median); return; } }
    if (slow) {
      this.fastFor = 0;
      if (++this.slowRuns >= 2 || (this.justRaised && now - this.justRaised < 6000)) {
        if (this.justRaised && now - this.justRaised < 6000) this.lockedUntil = now + 60_000;
        this.justRaised = 0; this.slowRuns = 0;
        if (now > this.noDownUntil && this.ratio > MIN_PIXEL_RATIO) { this.lastDown = { from: this.ratio, median }; this.set(Math.max(MIN_PIXEL_RATIO, this.ratio * 0.85), now, median); }
      }
      return;
    }
    this.slowRuns = 0;
    if (fast) {
      this.fastFor += 2000;
      if (this.ratio < this.max && this.fastFor >= 12_000 && now > this.lockedUntil) { this.fastFor = 0; this.justRaised = now; this.set(Math.min(this.max, this.ratio / 0.85), now, median); }
    } else this.fastFor = 0;
  }
  private set(r: number, now: number, median: number) {
    r = Math.round(r * 100) / 100;
    if (Math.abs(r - this.ratio) < 0.01) return;
    this.ratio = r; this.renderer.setPixelRatio(r);
    this.log.push({ t: Math.round(now), ratio: r, median: Math.round(median * 10) / 10 });
  }
}
