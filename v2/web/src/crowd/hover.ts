// Hovering a Soul or a thing highlights it and shows its name (0.131 parity N-V20, #3677), as today's `WorldHover`: a
// pale ring at its feet, a pointer cursor, and its name in a plain-text tooltip. A Soul whose name chip is on screen gets
// the ring and no tooltip (today's #1645: the chip already names it); one whose chip is not drawn (too far, crowded out,
// `chips=0`) gets the tooltip. At most 30 picks a second, only while a mouse or pen rests over the view: touch never
// hovers, and a drag clears it. Read-only: the pick reads the world view's bodies and the thing layer's boxes and
// changes nothing drawn but the ring.
import * as THREE from 'three';
import { rayUnitBox, type ThingHit, type ThingLayer } from '../things/things.ts';
import type { NodeRec } from '../source/source.ts';

const UM = 1e-6, MM = 1e-3;
/** Kinds the world view does not draw as things (`draw/world.ts`'s STRUCTURE). */
const STRUCTURE = new Set(['souls:place', 'eden:world', 'eden:ground', 'eden:floor', 'eden:room', 'eden:window', 'eden:place', 'eden:doorway']);
/** A body for picking: a standing cylinder this wide and tall. */
export const BODY_R = 0.45, BODY_H = 1.9;
/** Nothing farther than this is hovered (the chips' own reach). */
export const FAR = 150;
/** Wall ms between picks. */
const PICK_MS = 34;

/** What the hover needs from the world view (`draw/world.ts`'s `WorldView`). */
export type HoverWorld = {
  nodes: Map<string, NodeRec>;
  tracks: Map<string, { at(t: number): [number, number, number] | null }>;
  frame(id: string | null): THREE.Matrix4;
};
export type HoverOptions = {
  world: HoverWorld;
  /** The page's thing layer, or null when the world view draws the things as its own boxes. */
  things: () => Pick<ThingLayer, 'pick'> | null;
  /** A Soul's public name from the page's copy. */
  name: (id: string) => string | null;
  /** Whether the Soul's name chip is drawn this frame. */
  chipShown: (id: string) => boolean;
};
export type HoverTarget = { kind: 'soul' | 'thing'; id: string; name: string; foot: THREE.Vector3; radius: number };

/** Where a ray (`o + k * d`, `d` unit) enters a standing cylinder on `foot`, or null. */
export function rayBody(o: THREE.Vector3, d: THREE.Vector3, foot: THREE.Vector3, r = BODY_R, h = BODY_H): number | null {
  const ox = o.x - foot.x, oz = o.z - foot.z, oy = o.y - foot.y;
  let near = 0, far = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-12) {
    if (ox * ox + oz * oz > r * r) return null;
  } else {
    const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r, disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    near = Math.max(near, (-b - s) / (2 * a));
    far = Math.min(far, (-b + s) / (2 * a));
  }
  if (Math.abs(d.y) < 1e-12) {
    if (oy < 0 || oy > h) return null;
  } else {
    let k0 = -oy / d.y, k1 = (h - oy) / d.y;
    if (k0 > k1) [k0, k1] = [k1, k0];
    near = Math.max(near, k0);
    far = Math.min(far, k1);
  }
  return near <= far ? near : null;
}

/** A thing's name: its public name, else its kind in plain words (`eden:park-bench@2` is "park bench"). */
export function thingName(n: NodeRec | undefined): string {
  if (!n) return 'thing';
  if (n.name) return n.name;
  return n.kind.split('@')[0].replace(/^.*:/, '').replace(/[-_]+/g, ' ').trim() || 'thing';
}

/** Today's tooltip text: the name, cut at 54 characters. */
export function tooltipText(name: string): string {
  return name.length > 54 ? name.slice(0, 53).trimEnd() + '…' : name;
}

/** Each solid of a thing as the world view draws it (its boxes, or half a metre with none), as unit-box frames
 *  (`rayUnitBox`'s box), with their inverses; kept per node record, so a thing is boxed again only when it changes. */
const boxCache = new WeakMap<NodeRec, { boxes: THREE.Matrix4[]; inverse: THREE.Matrix4[] }>();
function viewBoxes(n: NodeRec, world: HoverWorld) {
  let b = boxCache.get(n);
  if (b) return b;
  const f = world.frame(n.id), s = (n.scale ?? 1_000_000) / 1_000_000;
  const solids = n.solids?.length ? n.solids : [[0, 0, 250, 250, 0, 0, 500]];
  const boxes = solids.map(([cx, cz, hx, hz, yaw, y0, y1]) => f.clone().multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(cx * MM * s, y0 * MM * s, cz * MM * s),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yaw / 1000) * (Math.PI / 180)),
    new THREE.Vector3(Math.max(0.05, 2 * hx * MM * s), Math.max(0.05, (y1 - y0) * MM * s), Math.max(0.05, 2 * hz * MM * s)),
  )));
  b = { boxes, inverse: boxes.map((m) => m.clone().invert()) };
  boxCache.set(n, b);
  return b;
}

/** The thing a ray meets first among the world view's own boxes (a page with no thing layer), within `far`. */
export function pickViewThing(origin: THREE.Vector3, dir: THREE.Vector3, world: HoverWorld, far = Infinity): ThingHit | null {
  let best: { id: string; box: THREE.Matrix4 } | null = null, near = far;
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  for (const n of world.nodes.values()) {
    if (n.at !== null || world.tracks.has(n.id) || STRUCTURE.has(n.kind.split('@')[0])) continue;
    const b = viewBoxes(n, world);
    for (let k = 0; k < b.inverse.length; k++) {
      o.copy(origin).applyMatrix4(b.inverse[k]);
      d.copy(origin).add(dir).applyMatrix4(b.inverse[k]).sub(o);
      const hit = rayUnitBox(o, d);
      if (hit !== null && hit < near) (near = hit), (best = { id: n.id, box: b.boxes[k] });
    }
  }
  if (!best) return null;
  const e = best.box.elements;
  return { id: best.id, distance: near, foot: new THREE.Vector3().applyMatrix4(best.box), radius: Math.hypot(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[8], e[9], e[10])) / 2 };
}

/** The nearest Soul or thing along a ray at world time `t`, within `far`. */
export function pickAt(o: THREE.Vector3, d: THREE.Vector3, t: number, opts: HoverOptions, far = FAR): HoverTarget | null {
  const { world } = opts, foot = new THREE.Vector3();
  let soul: { id: string; k: number; foot: THREE.Vector3 } | null = null, near = far;
  for (const [id, tr] of world.tracks) {
    const n = world.nodes.get(id), p = tr.at(t);
    if (!n || !p) continue;
    foot.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(world.frame(n.parent));
    const k = rayBody(o, d, foot);
    if (k !== null && k < near) (near = k), (soul = { id, k, foot: foot.clone() });
  }
  const layer = opts.things();
  const thing: ThingHit | null = layer ? layer.pick(o, d, near) : pickViewThing(o, d, world, near);
  if (thing) return { kind: 'thing', id: thing.id, name: thingName(world.nodes.get(thing.id)), foot: thing.foot, radius: thing.radius };
  if (soul) return { kind: 'soul', id: soul.id, name: opts.name(soul.id) ?? world.nodes.get(soul.id)?.name ?? 'a Soul', foot: soul.foot, radius: BODY_R };
  return null;
}

export class WorldHover {
  readonly ring: THREE.Mesh;
  readonly tooltip: HTMLDivElement;
  target: HoverTarget | null = null;
  private pointer: { x: number; y: number } | null = null;
  private held = false;
  private last = -Infinity;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: () => THREE.Camera;
  private readonly opts: HoverOptions;

  constructor(canvas: HTMLCanvasElement, camera: () => THREE.Camera, opts: HoverOptions) {
    this.canvas = canvas;
    this.camera = camera;
    this.opts = opts;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.58, 0.67, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#fff0ab', transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }),
    );
    this.ring.name = 'hover ring';
    this.ring.visible = false;
    this.ring.renderOrder = 997;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'world-hover-tooltip';
    this.tooltip.setAttribute('role', 'tooltip');
    this.tooltip.hidden = true;
    this.tooltip.style.cssText = 'position:fixed;z-index:3;pointer-events:none;max-width:260px;padding:4px 7px;border-radius:4px;'
      + 'background:rgba(16,20,26,0.85);color:#f2efe8;font:12px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.body.append(this.tooltip);
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.buttons) return this.clear();
      this.pointer = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerleave', () => ((this.pointer = null), this.clear()));
    canvas.addEventListener('pointerdown', () => ((this.held = true), this.clear()));
    addEventListener('pointerup', () => (this.held = false));
    canvas.addEventListener('pointercancel', () => ((this.held = false), (this.pointer = null), this.clear()));
  }

  /** Once a frame, after the world is placed at world time `t`: re-picks at most every PICK_MS. */
  update(now: number, t: number): void {
    if (this.held || !this.pointer || now - this.last < PICK_MS) return;
    this.last = now;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.ndc.set(((this.pointer.x - r.left) / r.width) * 2 - 1, -((this.pointer.y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera());
    const hit = pickAt(this.ray.ray.origin, this.ray.ray.direction, t, this.opts);
    if (hit) this.show(hit);
    else this.clear();
  }

  private show(h: HoverTarget): void {
    this.target = h;
    this.ring.visible = true;
    this.ring.position.copy(h.foot);
    this.ring.position.y += 0.05;
    this.ring.scale.setScalar(h.kind === 'soul' ? 1 : Math.min(7, Math.max(1, (h.radius + 0.2) / 0.62)));
    this.canvas.style.cursor = 'pointer';
    if (h.kind === 'soul' && this.opts.chipShown(h.id)) return void (this.tooltip.hidden = true);
    const p = this.pointer!;
    this.tooltip.textContent = tooltipText(h.name);
    this.tooltip.title = h.name;
    this.tooltip.style.left = `${Math.max(8, Math.min(innerWidth - 180, p.x + 12))}px`;
    this.tooltip.style.top = `${Math.max(8, p.y - 34)}px`;
    this.tooltip.hidden = false;
  }

  clear(): void {
    this.target = null;
    this.ring.visible = false;
    this.tooltip.hidden = true;
    this.canvas.style.cursor = '';
  }
}
