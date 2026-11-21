// Which camera the page shows (V20, #2764): broadcast (the page lands on it, as today's site does), free (the viewer's
// own: one finger or the mouse orbits, a pinch or the wheel zooms, two fingers or the right button pan), a flight to a
// Soul, and following one. A tap or click on a Soul (its chip or its body) flies to it and follows; a name typed in the
// find box does the same; `follow=<id>` in the address opens on that Soul, and the address carries it while following.
// Any gesture during broadcast hands the camera to the viewer. With `camera=free`, or on a link to a past moment, the
// page starts on the free camera. Cameras observe: none of them moves anything in the world.
// C2 (#3674): once the world is drawn, a first-time visitor gets the welcome card, and in Eden a guided camera tour
// (`tour` mode) flies between today's Explore views; any gesture, Esc or "Leave tour" gives the free camera from there.
// #3738: in Eden the Explore list flies the camera to one view (`view` mode), then gives the free camera from there.
// On a phone (#3675): first-touch hints, a short vibration when a tap follows or a flight arrives, and a fast one-finger
// sideways flick while following goes to the next (left) or previous (right) Soul; pinch and two-finger drags stay the
// camera's.
import * as THREE from 'three';
import { farLimit, type FreeCamera } from './camera.ts';
import { Broadcast, SHOT } from './broadcast.ts';
import { Flight, PoseFlight, shotOffset } from './flight.ts';
import { FOLLOW_MAX, FOLLOW_MIN, Follow, TARGET_UP, bodyAt } from './follow.ts';
import type { WorldView } from '../draw/world.ts';
import type { PageSouls } from '../souls/page.ts';
import type { PartRec } from '../source/source.ts';
import { Tour } from '../welcome/tour.ts';
import { EDEN_STOPS } from '../welcome/stops.ts';
import { mountWelcome, worldOf, type Welcome } from '../welcome/welcome.ts';
import { mountExplore, type Explore } from '../welcome/explore.ts';
import { EDEN_VIEWS } from '../welcome/views.ts';
import type { Stop } from '../welcome/stops.ts';
import type { ViewShots } from '../welcome/shots.ts';
import { Flicks, SoulSwipe, hapticTick, soulRing } from '../phone/touch.ts';
import { touchHints } from '../phone/hints.ts';

export type Mode = 'broadcast' | 'free' | 'fly' | 'follow' | 'tour' | 'view';
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
  tour: Tour | null = null;
  welcome: Welcome | null = null;
  explore: Explore | null = null;
  /** Explore's pictures, given by the page (it holds the renderer). */
  shots: ViewShots | null = null;
  private view: PoseFlight | null = null;
  private flicks = new Flicks();
  private swipe = new SoulSwipe();
  /** When each body was last heard (it spoke, or a named event happened to it; µs), for the swipe's order. */
  private heard = new Map<string, number>();
  /** The Soul whose page a tap on its label opened (the Soul page opens it), so a swipe turns that page to the next. */
  private card: string | null = null;

  constructor(cam: FreeCamera, canvas: HTMLCanvasElement, world: WorldView, souls: PageSouls, params: URLSearchParams, history: boolean) {
    this.cam = cam;
    this.world = world;
    this.souls = souls;
    this.pending = params.get('follow');
    this.mode = history || params.get('camera') === 'free' ? 'free' : 'broadcast';
    const take = () => {
      if (this.mode === 'broadcast' || this.mode === 'fly' || this.mode === 'tour' || this.mode === 'view') this.free();
      this.follow?.touched();
    };
    canvas.addEventListener('pointerdown', (e) => {
      // Whether a flight to a Soul was under way: a flick then swipes on from it rather than taking the camera.
      const flying = this.mode === 'fly';
      this.down = [e.clientX, e.clientY];
      this.flicks.pointerdown(e);
      if (!(flying && e.pointerType === 'touch' && this.flicks.fingers === 1)) take();  // a pinch takes it at once
    });
    canvas.addEventListener('pointercancel', (e) => this.flicks.cancel(e));
    canvas.addEventListener('wheel', take, { passive: true });
    canvas.addEventListener('pointerup', (e) => {
      const dir = this.flicks.pointerup(e);
      const on = this.mode === 'follow' ? this.follow?.id : this.mode === 'fly' ? this.flight?.id : null;
      if (dir && on) return void this.swipeFrom(on, dir);
      if (this.mode === 'fly' && e.pointerType === 'touch') this.free();  // a touch that was not a flick takes the camera
      if (!this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > TAP_PX) return;
      const id = this.hit(e.clientX, e.clientY);
      this.card = id && this.souls.placed.some((p) => p.id === id && e.clientX >= p.x && e.clientX <= p.x + p.w && e.clientY >= p.y && e.clientY <= p.y + p.h) ? id : this.card;
      if (id && this.fly(id)) hapticTick();
    });
    touchHints();
    cam.controls.addEventListener('start', () => ((this.panned = 0), this.follow?.touched()));
    addEventListener('keydown', (e) => /^(Key[WASD]|Arrow)/.test(e.code) && take());
    this.find = this.findBox();
    // N-V21 (#3678): opening a conversation frames its members; the viewer's camera from there.
    souls.framer = (eye, target) => (this.free(), this.show(eye, target));
  }

  /** A part's named events, for broadcast. */
  part(p: PartRec): void {
    this.broadcast.heard(p);
    for (const s of p.said ?? []) this.heard.set(s.speaker, Math.max(this.heard.get(s.speaker) ?? 0, s.at));
    for (const h of p.happened ?? []) if (h.name) this.heard.set(h.node, Math.max(this.heard.get(h.node) ?? 0, h.at));
  }

  /** A flick while following (or flying to) Soul `on`: flies to the next (+1) or previous (-1) Soul drawn. */
  private swipeFrom(on: string, dir: 1 | -1): void {
    if (this.t === null) return;
    const t = this.t, v = new THREE.Vector3(), here: { id: string; p: [number, number, number]; walking: boolean }[] = [];
    for (const id of this.souls.copy.souls.keys()) {
      if (!bodyAt(this.world, id, t, v)) continue;
      const k = this.world.tracks.get(id)?.samples;
      here.push({ id, p: [v.x, v.y, v.z], walking: !!k && k.length > 1 && k[k.length - 1].at > t - 1_000_000 });
    }
    const next = this.swipe.step(on, here.map((s) => s.id), dir, performance.now(), () => soulRing(on, here, this.heard, t));
    if (!next || !this.fly(next)) return;
    hapticTick();
    // The Soul's page that was open turns with the swipe, as today's follow chip names the Soul now shown.
    const pageOpen = [...document.querySelectorAll('aside')].some((a) => a.style.display === 'block');
    if (this.card === on && pageOpen) this.souls.open((this.card = next));
  }

  /** Each frame, `dt` ms on, the world drawn at `t` (µs). */
  update(dt: number, t: number | null): void {
    const s = dt / 1000;
    this.t = t;
    if (t === null) return this.cam.update(dt);
    if (!this.welcome && this.world.nodes.size > 0) {
      const world = worldOf(location.pathname, new URLSearchParams(location.search), () => [...this.world.nodes.values()].map((n) => n.kind));
      this.welcome = mountWelcome(document, this, { world, tour: world === 'eden', store: () => localStorage });
      if (world === 'eden')
        this.explore = mountExplore(document, { world: 'Eden', views: EDEN_VIEWS, go: (v) => this.toView(v), picture: (v) => this.shots?.shot(v) ?? Promise.resolve(null), closed: () => this.shots?.cancel() });
    }
    if (this.explore && !this.explore.panel.hidden) this.shots?.pump();
    if (this.mode === 'view') return this.onView(s);
    if (this.mode === 'tour') return this.onTour(s);
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
    this.follow = this.tour = null;
    this.welcome?.frame(null);
    return true;
  }

  /** Starts the guided Eden tour from where the camera is. */
  startTour(): boolean {
    this.free();
    this.tour = new Tour(EDEN_STOPS, this.cam.camera.position, this.cam.controls.target);
    this.mode = 'tour';
    return true;
  }

  /** Flies the camera to an Explore view, then gives the free camera there. */
  toView(v: Stop): boolean {
    this.free();
    this.view = new PoseFlight(this.cam.camera.position, this.cam.controls.target, new THREE.Vector3(...v.p), new THREE.Vector3(...v.target));
    this.mode = 'view';
    return true;
  }

  private onView(s: number): void {
    const pose = this.view!.step(s);
    this.show(pose.eye, pose.target);
    if (pose.done) this.free();
  }

  leaveTour(): void {
    if (this.mode === 'tour') this.free();
  }

  nextStop(): void {
    if (this.tour && !this.tour.next()) this.free();
  }

  private onTour(s: number): void {
    const pose = this.tour!.step(s);
    this.show(pose.eye, pose.target);
    this.welcome?.frame({ stop: pose.stop, index: pose.index, of: this.tour!.stops.length });
    if (pose.done) this.free();
  }

  /** The free camera, from where the camera is now. */
  free(): void {
    this.mode = 'free';
    this.follow = this.flight = this.tour = this.view = null;
    this.welcome?.frame(null);
    this.cam.controls.minDistance = 0;
    this.cam.controls.maxDistance = farLimit(this.world.extent);
    this.link(null);
  }

  private target(id: string): THREE.Vector3 | null {
    if (this.t === null) return null;
    const p = bodyAt(this.world, id, this.t);
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
    hapticTick();  // the follow starts
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

  /** The find box: a Soul's name, then Enter, flies there. */
  private findBox(): HTMLInputElement {
    const el = document.createElement('input');
    Object.assign(el, { id: 'find', type: 'search', placeholder: 'find a Soul', enterKeyHint: 'go', autocomplete: 'off', spellcheck: false });
    el.setAttribute('aria-label', 'Find a Soul by name');
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;width:min(240px,calc(100vw - 24px));box-sizing:border-box;padding:8px 10px;'
      + 'background:rgba(16,20,26,0.85);color:#e8e6e1;border:1px solid #3a4250;border-radius:4px;font:14px system-ui,sans-serif';
    // Typing is not steering: keys stay in the box.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const id = findSoul(this.souls.copy.souls.values(), el.value);
      if (id && this.fly(id)) return void ((el.value = ''), (el.placeholder = 'find a Soul'), el.blur());
      el.placeholder = `no Soul here named “${el.value.trim()}”`;
      el.value = '';
    });
    document.body.append(el);
    return el;
  }
}
