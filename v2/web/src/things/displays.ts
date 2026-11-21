// Eden's displays (N-V10, N-V11, #3725): the library's two hung pictures and the classroom screen's lesson slide, as
// today's page draws them (apps/web `WorldWallFrames.ts`, `WorldEdenExpansion.ts` with `classroom-lesson.ts` and
// the venue's projection panel). Each is placed in the frame of the imported thing it belongs to: the library
// (today's `eden-library-1`) and the classroom court's screen (today's `eden-classroom-screen-1`), so they come and
// go with those things. The frames keep today's places exactly: (70.6, 2.42, -3.225) and (77.2, 2.45, -3.225), turned
// half round. Today's lesson is a 4.8 m panel at (42, 2.25, -18.35) on the expansion's stage wall. Eden 2026 has no
// stage there, and its court wall would hide the panel, so the slide is drawn on the screen's own face instead:
// today's `core-screen` display, 2.25 m by 1.25 m, 1.6 m up. The video plays only while it is within 80 m, faces the
// eye and the page is shown, as today. Today's lesson slides change only in a viewer's own view, and its buttons are
// never shown, so the screen shows the first slide.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';

/** One authored display in its thing's frame (m, radians): a framed picture or video, or the lesson panel. */
export type Display = {
  id: string; origin: string; at: [number, number, number]; yaw: number; width: number; height: number;
  media: { kind: 'image' | 'video'; url: string }; frame: boolean;
};

/** The imported things they belong to (import-eden's field 1) and where those stand in Eden (m). */
const LIBRARY = { origin: 'e_a0741c1e', at: [74, 0, -7] }, SCREEN = { origin: 'e_ad42afe6' };
const local = (thing: { at: number[] }, p: [number, number, number]): [number, number, number] =>
  [p[0] - thing.at[0], p[1] - thing.at[1], p[2] - thing.at[2]].map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number];

/** Today's lesson (apps/web `classroom-lesson.ts`): three slides, local to the viewer. */
export const LESSON = [
  { title: 'A world with a memory', lines: ['Watch a Soul. Notice what they do.', 'Give them a small direction.', 'Return to see what changed.'] },
  { title: 'Give one direction', lines: ['Choose your own Soul.', 'Ask for one thing in plain language.', 'Keep the request reference.'] },
  { title: 'Watch what changes', lines: ['Received means saved.', 'Understood means interpreted.', 'An action is not the whole purpose.'] },
] as const;
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** A slide as today's SVG, as a data URL. */
export function slide(index: number): string {
  const s = LESSON[index];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#101e28"/><rect x="70" y="75" width="10" height="66" rx="5" fill="#b0dec4"/><text x="110" y="128" fill="#f5f7f2" font-family="Arial,sans-serif" font-size="54" font-weight="700">${escape(s.title)}</text>${s.lines.map((line, i) => `<text x="110" y="${270 + i * 96}" fill="#e1ebe6" font-family="Arial,sans-serif" font-size="40">${escape(line)}</text>`).join('')}<text x="110" y="600" fill="#a8bab6" font-family="Arial,sans-serif" font-size="24">EDEN · LOCAL LESSON · ${index + 1} / ${LESSON.length}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export const DISPLAYS: readonly Display[] = [
  { id: 'eden-library-colour-study', origin: LIBRARY.origin, at: local(LIBRARY, [70.6, 2.42, -3.225]), yaw: Math.PI, width: 0.95, height: 1.2, frame: true, media: { kind: 'image', url: new URL('./media/gallery-study.svg', import.meta.url).href } },
  { id: 'eden-library-colour-loop', origin: LIBRARY.origin, at: local(LIBRARY, [77.2, 2.45, -3.225]), yaw: Math.PI, width: 1.55, height: 0.97, frame: true, media: { kind: 'video', url: new URL('./media/gallery-loop.mp4', import.meta.url).href } },
  { id: 'eden-classroom-local-projection', origin: SCREEN.origin, at: [0, 1.6, 0.066], yaw: 0, width: 2.25, height: 1.25, frame: false, media: { kind: 'image', url: slide(0) } },
];

type Video = { video: HTMLVideoElement; mesh: THREE.Mesh; asking: boolean; retryAt: number };

/** The displays of the imported things the page holds, each in its thing's frame. */
export class Displays {
  readonly group = new THREE.Group();
  private by = new Map<string, Display[]>();
  private placed = new Map<string, THREE.Group>();
  private cube = new THREE.BoxGeometry(1, 1, 1);
  private surround = new THREE.MeshStandardMaterial({ color: '#4e4033', roughness: 0.75 });
  private owned: { dispose(): void }[] = [];
  private videos: Video[] = [];
  private frustum = new THREE.Frustum();
  constructor(rows: readonly Display[] = DISPLAYS) {
    this.group.name = 'displays';
    for (const r of rows) this.by.set(r.origin, [...(this.by.get(r.origin) ?? []), r]);
  }
  /** Places (or removes) the displays of the things among `nodes`; `frame` is a node's frame in the world. */
  apply(nodes: NodeRec[], removed: string[], frame: (id: string) => THREE.Matrix4): void {
    for (const id of removed) this.placed.get(id)?.removeFromParent();
    for (const id of removed) this.placed.delete(id);
    for (const n of nodes) {
      const rows = n.origin ? this.by.get(n.origin) : undefined;
      if (!rows) continue;
      let g = this.placed.get(n.id);
      if (!g) {
        g = new THREE.Group();
        g.name = `displays:${n.id}`;
        g.matrixAutoUpdate = false;
        for (const r of rows) g.add(this.make(r));
        this.placed.set(n.id, g);
        this.group.add(g);
      }
      g.matrix.copy(frame(n.id));
      g.matrixWorldNeedsUpdate = true;
    }
  }
  has(id: string): boolean {
    return this.placed.has(id);
  }
  private make(r: Display): THREE.Group {
    const owner = new THREE.Group();
    owner.name = `display:${r.id}`;
    owner.position.fromArray(r.at);
    owner.rotation.y = r.yaw;
    if (r.frame) {
      const bar = (x: number, y: number, w: number, h: number) => {
        const m = new THREE.Mesh(this.cube, this.surround);
        m.position.set(x, y, -0.025);
        m.scale.set(w, h, 0.055);
        owner.add(m);
      };
      for (const x of [-1, 1]) bar(x * (r.width / 2 + 0.035), 0, 0.07, r.height + 0.14);
      for (const y of [-1, 1]) bar(0, y * (r.height / 2 + 0.035), r.width, 0.07);
    }
    const geometry = new THREE.PlaneGeometry(r.width, r.height);
    const material = new THREE.MeshBasicMaterial({ color: r.frame ? '#e7dfca' : '#ffffff', toneMapped: false });
    this.owned.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `media:${r.id}`;
    owner.add(mesh);
    if (typeof document === 'undefined') return owner;
    if (r.media.kind === 'image') {
      const t = new THREE.TextureLoader().load(r.media.url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        material.map = t;
        material.needsUpdate = true;
      });
      this.owned.push(t);
    } else {
      const video = document.createElement('video');
      Object.assign(video, { crossOrigin: 'anonymous', src: r.media.url, muted: true, loop: true, playsInline: true, preload: 'metadata' });
      const t = new THREE.VideoTexture(video);
      t.colorSpace = THREE.SRGBColorSpace;
      material.map = t;
      this.owned.push(t);
      this.videos.push({ video, mesh, asking: false, retryAt: 0 });
    }
    return owner;
  }
  /** Plays a video only while it is within 80 m, faces the eye, is in view and the page is shown (today's rule). */
  update(camera: THREE.Camera): void {
    if (!this.videos.length) return;
    const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const eye = camera.getWorldPosition(new THREE.Vector3()), at = new THREE.Vector3(), normal = new THREE.Vector3();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const v of this.videos) {
      v.mesh.updateWorldMatrix(true, false);
      at.setFromMatrixPosition(v.mesh.matrixWorld);
      const on = shown && v.mesh.parent?.parent?.parent === this.group && eye.distanceToSquared(at) < 80 ** 2
        && normal.set(0, 0, 1).transformDirection(v.mesh.matrixWorld).dot(eye.clone().sub(at)) > 0 && this.frustum.intersectsObject(v.mesh);
      if (!on) {
        if (!v.video.paused) v.video.pause();
        continue;
      }
      if (v.video.paused && !v.asking && performance.now() >= v.retryAt) {
        v.asking = true;
        void v.video.play().catch(() => void (v.retryAt = performance.now() + 2000)).finally(() => void (v.asking = false));
      }
    }
  }
  dispose(): void {
    for (const v of this.videos) (v.video.pause(), v.video.removeAttribute('src'), v.video.load());
    for (const o of this.owned) o.dispose();
    this.cube.dispose();
    this.surround.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
