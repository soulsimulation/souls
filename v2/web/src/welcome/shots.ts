// Explore's preview pictures (#3738), rendered from the v2 page itself: the drawn scene seen from a view's eye, small,
// one picture at a time, paced, and only for the rows the list asks for (the visible ones); reading a picture back and
// encoding it are asynchronous, so the frame pays only the small draw. Today's page draws its
// pictures the same way when the CDN has none (apps/web/src/WorldPlacePreviews.ts). A picture taken while models are
// still arriving is shown but not kept, so the next look takes it again. It reads the scene and writes nothing to it.
import * as THREE from 'three';
import type { Stop } from './stops.ts';

/** The picture's size in pixels (today's place shots are 320 × 224), and the least time between two pictures (ms), so
 *  the page keeps its frame rate while the list fills. */
export const SHOT_W = 320, SHOT_H = 224, SHOT_GAP_MS = 120;

type Ask = { stop: Stop; done: (src: string | null) => void };

export class ViewShots {
  private kept = new Map<string, string>();
  private asks: Ask[] = [];
  private camera = new THREE.PerspectiveCamera(50, SHOT_W / SHOT_H, 0.5, 2000);
  private target: THREE.WebGLRenderTarget | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private settled: () => boolean;
  private last = -Infinity;
  private busy = false;

  /** `settled` says every model the scene asked for has arrived; until then pictures are not kept. */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, settled: () => boolean = () => true) {
    this.renderer = renderer;
    this.scene = scene;
    this.settled = settled;
  }

  /** The picture of `stop`'s view: at once if kept, else on a later frame. */
  shot(stop: Stop): Promise<string | null> {
    const have = this.kept.get(stop.id);
    if (have) return Promise.resolve(have);
    return new Promise((done) => this.asks.push({ stop, done }));
  }

  /** Forgets the pictures not yet taken (the list closed). */
  cancel(): void {
    for (const a of this.asks.splice(0)) a.done(null);
  }

  /** Starts the next asked picture, one at a time and at most one each SHOT_GAP_MS. Call once a frame, before the
   *  page's own draw. The draw is on this frame; reading it back and encoding it are asynchronous, off this frame. */
  pump(now = performance.now()): void {
    if (this.busy || !this.asks.length || now - this.last < SHOT_GAP_MS) return;
    // Newest first: the rows just come into sight (after a scroll or a search) before ones asked for earlier.
    const ask = this.asks.pop()!;
    const have = this.kept.get(ask.stop.id);
    if (have) return ask.done(have);
    this.busy = true;
    this.take(ask.stop)
      .catch(() => null)
      .then((src) => {
        this.busy = false;
        this.last = performance.now();
        if (src && this.settled()) this.kept.set(ask.stop.id, src);
        ask.done(src);
      });
  }

  private async take(stop: Stop): Promise<string | null> {
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(SHOT_W, SHOT_H, { depthBuffer: true });
      this.target.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const target = this.target;
    this.camera.position.set(...stop.p);
    this.camera.lookAt(new THREE.Vector3(...stop.target));
    this.camera.updateMatrixWorld();
    const before = this.renderer.getRenderTarget(), shadows = this.renderer.shadowMap.autoUpdate;
    try {
      // The sun's shadow square follows the page's own camera; the picture reuses this frame's rather than drawing it again.
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(before);
      this.renderer.shadowMap.autoUpdate = shadows;
    }
    const pixels = new Uint8Array(SHOT_W * SHOT_H * 4);
    await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, SHOT_W, SHOT_H, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = SHOT_W;
    canvas.height = SHOT_H;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const image = g.createImageData(SHOT_W, SHOT_H);
    // GL rows run bottom up.
    for (let y = 0; y < SHOT_H; y++) image.data.set(pixels.subarray((SHOT_H - 1 - y) * SHOT_W * 4, (SHOT_H - y) * SHOT_W * 4), y * SHOT_W * 4);
    g.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', 0.8));
    return blob ? URL.createObjectURL(blob) : null;
  }
}
