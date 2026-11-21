// Which camera the page shows (V20, #2764): broadcast (the page lands on it, as today's site does), free (the viewer's
// own: one finger or the mouse orbits, a pinch or the wheel zooms, two fingers or the right button pan), a flight to a
// Soul, and following one. A tap or click on a Soul (its chip or its body) flies to it and follows; a name typed in the
// find box does the same; `follow=<id>` in the address opens on that Soul, and the address carries it while following.
// Any gesture during broadcast hands the camera to the viewer. With `camera=free`, or on a link to a past moment, the
// page starts on the free camera. Cameras observe: none of them moves anything in the world.
import * as THREE from 'three';
import { farLimit, type FreeCamera } from './camera.ts';
import { Broadcast, SHOT } from './broadcast.ts';
import { Flight, shotOffset } from './flight.ts';
import { FOLLOW_MAX, FOLLOW_MIN, Follow, TARGET_UP, bodyAt } from './follow.ts';
import type { WorldView } from '../draw/world.ts';
import type { PageSouls } from '../souls/page.ts';
import type { NodeRec, PartRec } from '../source/source.ts';

export type Mode = 'broadcast' | 'free' | 'fly' | 'follow';
/** A tap moves less than this (px); a body this near the tap (px) is the one tapped; a pan this far (m) in one gesture
 *  leaves the follow. */
const TAP_PX = 6, HIT_PX = 36, PAN_LEAVES = 1;
const UP = new THREE.Vector3(0, 1, 0);

/** The Soul a typed name means: its name exactly, then a name it begins, then one it holds (case aside). */
export function findSoul(souls: Iterable<{ id: string; name: string | null }>, typed: string): string | null {
  const q = typed.trim().toLowerCase();
  if (!q) return null;
  const all = [...souls].filter((s) => s.name);
  const by = (f: (n: string) => boolean) => all.find((s) => f(s.name!.toLowerCase()))?.id ?? null;
  return by((n) => n === q) ?? by((n) => n.startsWith(q)) ?? by((n) => n.includes(q));
}

/** The named place a typed name means, when no Soul does (#3574): the same rule over the places' public names. */
export function findPlace(nodes: Iterable<Pick<NodeRec, 'id' | 'placeName'>>, typed: string): string | null {
  return findSoul([...nodes].map((n) => ({ id: n.id, name: n.placeName ?? null })), typed);
}

/** Where a named place is seen, world m: the middle of its outline (world mm) at its own height; null without one. */
export function placeAt(n: Pick<NodeRec, 'outline'>, y: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const o = n.outline;
  if (!o?.length) return null;
  const [x, z] = o.reduce(([a, b], [px, pz]) => [a + px, b + pz], [0, 0]);
  return out.set((x / o.length) / 1000, y, (z / o.length) / 1000);
}

export class CameraDirector {
  mode: Mode;
  readonly broadcast = new Broadcast();
  follow: Follow | null = null;
  flight: Flight | null = null;
  /** For the measure: the last flight asked (page ms) and when it reached its Soul. */
  flown: { id: string; asked: number; seconds: number; done: number | null } | null = null;
  private pending: string | null;
  private t: number | null = null;
  private panned = 0;
  private down: [number, number] | null = null;
  private cam: FreeCamera;
  private world: WorldView;
  private souls: PageSouls;
  readonly find: HTMLInputElement;

  constructor(cam: FreeCamera, canvas: HTMLCanvasElement, world: WorldView, souls: PageSouls, params: URLSearchParams, history: boolean) {
    this.cam = cam;
    this.world = world;
    this.souls = souls;
    this.pending = params.get('follow');
    this.mode = history || params.get('camera') === 'free' ? 'free' : 'broadcast';
    const take = () => {
      if (this.mode === 'broadcast' || this.mode === 'fly') this.free();
      this.follow?.touched();
    };
    canvas.addEventListener('pointerdown', (e) => ((this.down = [e.clientX, e.clientY]), take()));
    canvas.addEventListener('wheel', take, { passive: true });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > TAP_PX) return;
      const id = this.hit(e.clientX, e.clientY);
      if (id) this.fly(id);
    });
    cam.controls.addEventListener('start', () => ((this.panned = 0), this.follow?.touched()));
    addEventListener('keydown', (e) => /^(Key[WASD]|Arrow)/.test(e.code) && take());
    this.find = this.findBox();
  }

  /** A part's named events, for broadcast. */
  part(p: PartRec): void {
    this.broadcast.heard(p);
  }

  /** Each frame, `dt` ms on, the world drawn at `t` (µs). */
  update(dt: number, t: number | null): void {
    const s = dt / 1000;
    this.t = t;
    if (t === null) return this.cam.update(dt);
    if (this.pending && this.target(this.pending)) {
      const target = this.target(this.pending)!;
      this.watch(new Follow(this.pending, shotOffset(this.cam.camera.position, target)));
      this.pending = null;
    }
    if (this.mode === 'broadcast') return this.onBroadcast(t, s);
    if (this.mode === 'fly') return this.onFlight(s);
    if (this.mode === 'follow') return this.onFollow(dt, s);
    this.cam.update(dt);
  }

  /** Flies to Soul `id` and then follows it; false when it is not drawn. */
  fly(id: string): boolean {
    const target = this.target(id);
    if (!target) return false;
    this.flight = new Flight(id, this.cam.camera.position, this.cam.controls.target, target);
    this.flown = { id, asked: performance.now(), seconds: this.flight.seconds, done: null };
    this.mode = 'fly';
    this.follow = null;
    return true;
  }

  /** The free camera, from where the camera is now. */
  free(): void {
    this.mode = 'free';
    this.follow = this.flight = null;
    this.cam.controls.minDistance = 0;
    this.cam.controls.maxDistance = farLimit(this.world.extent);
    this.link(null);
  }

  private target(id: string): THREE.Vector3 | null {
    if (this.t === null) return null;
    const p = bodyAt(this.world, id, this.t);
    const n = this.world.nodes.get(id);
    if (p && n?.placeName) placeAt(n, p.y, p);
    return p && p.setY(p.y + TARGET_UP);
  }

  private watch(f: Follow): void {
    this.follow = f;
    this.flight = null;
    this.panned = 0;
    this.mode = 'follow';
    this.link(f.id);
  }

  /** Shows `eye` looking at `target`, and keeps the free camera's pivot there. */
  private show(eye: THREE.Vector3, target: THREE.Vector3): void {
    this.cam.camera.position.copy(eye);
    this.cam.controls.target.copy(target);
    this.cam.camera.lookAt(target);
  }

  private onBroadcast(t: number, s: number): void {
    const w = this.world, souls = this.souls.copy.souls;
    const pick = this.broadcast.pick(t, s, {
      has: (id) => souls.has(id) && w.nodes.has(id),
      walking: (id) => {
        const k = w.tracks.get(id)?.samples;
        return !!k && k.length > 1 && k[k.length - 1].at > t - 1_000_000;
      },
      ids: () => souls.keys(),
    });
    if (pick.id && (pick.cut || !this.follow || this.follow.id !== pick.id)) this.follow = new Follow(pick.id, this.broadcast.offset());
    const target = pick.id ? this.target(pick.id) : null;
    if (!target || !this.follow) return this.cam.update(s * 1000);
    this.follow.wanted.applyAxisAngle(UP, SHOT.drift * s);
    this.show(this.follow.eye(w, target, s), target);
  }

  private onFlight(s: number): void {
    const f = this.flight!, target = this.target(f.id);
    if (!target) return this.free();
    const pose = f.step(s, target);
    this.show(pose.eye, pose.target);
    if (!pose.done) return;
    if (this.flown?.id === f.id) this.flown.done = performance.now();
    this.watch(new Follow(f.id, f.offset));
  }

  private onFollow(dt: number, s: number): void {
    const f = this.follow!, target = this.target(f.id);
    if (!target) return this.free();
    const c = this.cam.controls;
    c.minDistance = FOLLOW_MIN;
    c.maxDistance = FOLLOW_MAX;
    // The controls apply this frame's orbit and zoom to the asked offset; a pan moves their pivot off the Soul.
    c.target.copy(target);
    this.cam.camera.position.copy(target).add(f.wanted);
    this.cam.update(dt);
    this.panned += c.target.distanceTo(target);
    if (this.panned > PAN_LEAVES) return this.free();
    f.wanted.copy(this.cam.camera.position).sub(target);
    this.show(f.eye(this.world, target, s), target);
  }

  /** The Soul under a tap: its chip, else the nearest body drawn within `HIT_PX` of it. */
  private hit(x: number, y: number): string | null {
    const chip = this.souls.placed.find((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
    if (chip) return chip.id;
    if (this.t === null) return null;
    let best: string | null = null, near = HIT_PX;
    const v = new THREE.Vector3();
    for (const id of this.souls.copy.souls.keys()) {
      if (!bodyAt(this.world, id, this.t, v)) continue;
      v.y += TARGET_UP;
      v.project(this.cam.camera);
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot((v.x + 1) * 0.5 * innerWidth - x, (1 - v.y) * 0.5 * innerHeight - y);
      if (d < near) [best, near] = [id, d];
    }
    return best;
  }

  /** The address carries the followed Soul, so it is a link to the follow. */
  private link(id: string | null): void {
    const u = new URL(location.href);
    if ((u.searchParams.get('follow') ?? null) === id) return;
    if (id) u.searchParams.set('follow', id);
    else u.searchParams.delete('follow');
    history.replaceState(history.state, '', u);
  }

  /** The find box: a Soul's or a named place's name, then Enter, flies there. */
  private findBox(): HTMLInputElement {
    const el = document.createElement('input');
    Object.assign(el, { id: 'find', type: 'search', placeholder: 'find a Soul or place', enterKeyHint: 'go', autocomplete: 'off', spellcheck: false });
    el.setAttribute('aria-label', 'Find a Soul or place by name');
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;width:min(240px,calc(100vw - 24px));box-sizing:border-box;padding:8px 10px;'
      + 'background:rgba(16,20,26,0.85);color:#e8e6e1;border:1px solid #3a4250;border-radius:4px;font:14px system-ui,sans-serif';
    // Typing is not steering: keys stay in the box.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const id = findSoul(this.souls.copy.souls.values(), el.value) ?? findPlace(this.world.nodes.values(), el.value);
      if (id && this.fly(id)) return void ((el.value = ''), (el.placeholder = 'find a Soul or place'), el.blur());
      el.placeholder = `no Soul or place here named “${el.value.trim()}”`;
      el.value = '';
    });
    document.body.append(el);
    return el;
  }
}
