// Place preview pictures (#3676, parity with today's WorldPlacePreviews): a small picture of a place from its framed
// view (places.ts), drawn from the live scene by the page's own renderer, so it costs no second model, context or
// download. Work is lazy and paced as today's: a picture is drawn only when asked (a card shown, a list row scrolled
// into view), one at a time, each in a browser-idle moment, and never before the page's first frame of motion. At
// most 24 pictures are kept; a place whose frame is not known yet (the world not drawn) gets none, and the next ask
// retries.
import * as THREE from 'three';

/** Picture size (px): today's shot size. */
export const SHOT_W = 320, SHOT_H = 224;
const KEEP = 24;

type Frame = { eye: THREE.Vector3; target: THREE.Vector3 };

/** Waits for a browser-idle moment (a frame later where `requestIdleCallback` is missing). */
const idle = () => new Promise<void>((done) => {
  const g = globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  if (g.requestIdleCallback) g.requestIdleCallback(() => done(), { timeout: 2000 });
  else setTimeout(done, 50);
});

export class PlacePreviews {
  private images = new Map<string, string>();
  private pending = new Map<string, Promise<string | null>>();
  private tail: Promise<unknown> = Promise.resolve();
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  /** For the measure: each picture's main-thread ms. */
  readonly ms: number[] = [];

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.scene = scene;
  }

  /** The picture of place `id` from `frame` (asked lazily: `frame` runs when its turn comes); null when nothing of it
   *  is drawn yet or the frame is unknown. */
  picture(id: string, frame: () => Frame | null): Promise<string | null> {
    const kept = this.images.get(id);
    if (kept) return Promise.resolve(kept);
    const asked = this.pending.get(id);
    if (asked) return asked;
    const job = this.tail.then(idle).then(() => {
      const f = frame();
      return f ? this.shoot(f) : null;
    }).catch(() => null).then((image) => {
      this.pending.delete(id);
      if (image) {
        this.images.set(id, image);
        if (this.images.size > KEEP) this.images.delete(this.images.keys().next().value!);
      }
      return image;
    });
    this.pending.set(id, job);
    this.tail = job;
    return job;
  }

  /** One synchronous render into a small target and its read-back; the renderer's state is back before the page's
   *  next frame. The shadow map is the main view's, left as it is. */
  private shoot(f: Frame): string | null {
    const t0 = performance.now(), r = this.renderer, camera = new THREE.PerspectiveCamera(38, SHOT_W / SHOT_H, 0.3, 4000);
    camera.position.copy(f.eye);
    camera.lookAt(f.target);
    camera.updateMatrixWorld(true);
    const target = new THREE.WebGLRenderTarget(SHOT_W, SHOT_H, { depthBuffer: true });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const previous = r.getRenderTarget(), shadows = r.shadowMap.autoUpdate, due = r.shadowMap.needsUpdate, pixels = new Uint8Array(SHOT_W * SHOT_H * 4);
    try {
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(target);
      r.render(this.scene, camera);
      r.readRenderTargetPixels(target, 0, 0, SHOT_W, SHOT_H, pixels);
    } finally {
      r.setRenderTarget(previous);
      r.shadowMap.autoUpdate = shadows;
      r.shadowMap.needsUpdate = due;
      target.dispose();
    }
    const canvas = document.createElement('canvas');
    canvas.width = SHOT_W;
    canvas.height = SHOT_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(SHOT_W, SHOT_H);
    for (let y = 0; y < SHOT_H; y++) image.data.set(pixels.subarray((SHOT_H - 1 - y) * SHOT_W * 4, (SHOT_H - y) * SHOT_W * 4), y * SHOT_W * 4);
    ctx.putImageData(image, 0, 0);
    const webp = canvas.toDataURL('image/webp', 0.82), url = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
    this.ms.push(Math.round(performance.now() - t0));
    return url;
  }
}
