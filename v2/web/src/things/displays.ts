// Eden's displays (N-V10, N-V11, #3725): the library's two hung pictures and the classroom screen's lesson slide, as
// today's page draws them (apps/web `WorldWallFrames.ts`, `WorldEdenExpansion.ts` with `classroom-lesson.ts` and
// the venue's projection panel). Each is placed in the frame of the imported thing it belongs to: the library
// (today's `eden-library-1`) and the classroom court's screen (today's `eden-classroom-screen-1`), so they come and
// go with those things. The frames keep today's places exactly: (70.6, 2.42, -3.225) and (77.2, 2.45, -3.225), turned
// half round. Today's lesson is a 4.8 m panel at (42, 2.25, -18.35) on the expansion's stage wall. Eden 2026 has no
// stage there, and its court wall would hide the panel, so the slide is drawn on the screen's own face instead:
// today's `core-screen` display, 2.25 m by 1.25 m, 1.6 m up. The loop (today's video, drawn) plays only while it is
// within 80 m, faces the eye and the page is shown, as today. Today's lesson slides change only in a viewer's own view, and its buttons are
// never shown, so the screen shows the first slide.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';

/** One authored display in its thing's frame (m, radians): a framed picture or loop, or the lesson panel. */
export type Display = {
  id: string; origin: string; at: [number, number, number]; yaw: number; width: number; height: number;
  media: { kind: 'image'; url: string } | { kind: 'loop' }; frame: boolean;
};

/** Today's colour loop (`apps/web/src/media/gallery-loop.mp4`: 320 by 200, 12 frames a second, 4 s), drawn instead of
 *  played: a 3 px frame line and two squares on a ground whose colours drift. Each frame's ground, line and squares'
 *  colours, read from the video's 48 frames, so it draws today's frames exactly (#3725: the repository keeps no
 *  media). */
const LOOP = '20374471977fe4b873c07770 203744739681e2b971c0786e 223646739681e1ba71be796c 223646739681dfbb6fbe7a6a 223646739681ddbd6dbc7b68 223646739583dabe6dbc7b68 243548739585d9c06bbb7c66 243548739487d7c06bbb7c64 243548739487d5c169b97e62 25344a739489d4c269b87f60 25344a739489d1c469b8805e 25344a73948bcfc567b6805e 27334a73948bcdc667b4815c 27334a74938dccc767b4825a 27324c74928fc9c867b38358 28314c749291c7ca65b18458 28314c749291c5ca65b08556 2a314c749291c4cb65b08554 2a314c749291c1cd65ae8654 2a314c749291bfce65ac8752 2c304e739291becf65ab8852 2c304e739291bad065a98950 2d2f4e739291b9d165a88a50 2d2f4e739291b7d265a68b4e 2d2f4e739291b6d365a68b4e 2f2e4e749293b2d465a48d4c 2f2e4e749293b1d567a38e4c 302d4e769095afd567a18e4a 302d4e769095aed667a08f4a 302d4e778f97aad8679e904a 322d4e778f97a9d8699c9148 322d4e778f97a7d9699b9248 342c4e778f97a6da6b999348 342c4e798e99a2db6b989448 342c4e798e99a1dc6d969548 352b4e798e999fdc6d949646 352b4e798e999edd6f939746 372a4e7b8c9b9cde6f919846 372a4e7c8c9d9ade71909846 38294e7e8a9f99de738e9946 38294e7e8a9f97df738d9a46 38294e7f899f94e1758b9b46 3a284c7f899f92e177899c46 3a284c7f899f91e179889c46 3a284c7f899f8fe279869d46 3c284c81899f8ee27b859e46 3c284c83889f8ee27d839e48 3d274c83889f8ce37f819f48'.split(' ').map((f) => [0, 6, 12, 18].map((i) => '#' + f.slice(i, i + 6)));
export const LOOP_FPS = 12;
/** Draws the loop's frame `n` (0 to 47) on a 320 by 200 canvas. */
export function drawLoop(g: CanvasRenderingContext2D, n: number): void {
  const [ground, line, big, small] = LOOP[((n % LOOP.length) + LOOP.length) % LOOP.length];
  g.fillStyle = ground;
  g.fillRect(0, 0, 320, 200);
  g.strokeStyle = line;
  g.lineWidth = 3;
  g.strokeRect(26.5, 26.5, 267, 147);
  g.fillStyle = big;
  g.fillRect(70, 70, 80, 70);
  g.fillStyle = small;
  g.fillRect(185, 90, 60, 50);
}
export const LOOP_FRAMES = LOOP.length;

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
  { id: 'eden-library-colour-loop', origin: LIBRARY.origin, at: local(LIBRARY, [77.2, 2.45, -3.225]), yaw: Math.PI, width: 1.55, height: 0.97, frame: true, media: { kind: 'loop' } },
  { id: 'eden-classroom-local-projection', origin: SCREEN.origin, at: [0, 1.6, 0.066], yaw: 0, width: 2.25, height: 1.25, frame: false, media: { kind: 'image', url: slide(0) } },
];

type Loop = { g: CanvasRenderingContext2D; texture: THREE.CanvasTexture; mesh: THREE.Mesh; shown: number };

/** The displays of the imported things the page holds, each in its thing's frame. */
export class Displays {
  readonly group = new THREE.Group();
  private by = new Map<string, Display[]>();
  private placed = new Map<string, THREE.Group>();
  private cube = new THREE.BoxGeometry(1, 1, 1);
  private surround = new THREE.MeshStandardMaterial({ color: '#4e4033', roughness: 0.75 });
  private owned: { dispose(): void }[] = [];
  private loops: Loop[] = [];
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
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext('2d');
      if (!g) return owner;
      drawLoop(g, 0);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      material.map = texture;
      this.owned.push(texture);
      this.loops.push({ g, texture, mesh, shown: 0 });
    }
    return owner;
  }
  /** Plays the loop only while it is within 80 m, faces the eye, is in view and the page is shown (today's rule for
   *  its video); a paused loop keeps its frame. `seconds`: the page's clock. */
  update(camera: THREE.Camera, seconds = performance.now() / 1000): void {
    if (!this.loops.length) return;
    const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const eye = camera.getWorldPosition(new THREE.Vector3()), at = new THREE.Vector3(), normal = new THREE.Vector3();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const frame = Math.floor(seconds * LOOP_FPS) % LOOP_FRAMES;
    for (const v of this.loops) {
      v.mesh.updateWorldMatrix(true, false);
      at.setFromMatrixPosition(v.mesh.matrixWorld);
      const on = shown && v.mesh.parent?.parent?.parent === this.group && eye.distanceToSquared(at) < 80 ** 2
        && normal.set(0, 0, 1).transformDirection(v.mesh.matrixWorld).dot(eye.clone().sub(at)) > 0 && this.frustum.intersectsObject(v.mesh);
      if (!on || frame === v.shown) continue;
      v.shown = frame;
      drawLoop(v.g, frame);
      v.texture.needsUpdate = true;
    }
  }
  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.cube.dispose();
    this.surround.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
