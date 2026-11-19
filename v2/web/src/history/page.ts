// History on the page (V9, #2719): opened from a link to a moment (`link.ts`), it seeks there with V4's two requests,
// places the link's camera, and plays bundles forward; a scrub bar over the day reads V4's coarse level while the
// handle moves and opens the moment on release; "back to live" hands the clock to V5's live stream (`clock.ts`);
// "link" copies a link to the moment and camera shown.
import * as THREE from 'three';
import type { FreeCamera } from '../camera/camera.ts';
import { cameraAt, placeCamera } from '../camera/link.ts';
import type { NodeRec, SampleRec } from '../source/source.ts';
import { HistoryClock } from './clock.ts';
import { historyBase, writeMoment, type Moment } from './link.ts';
import type { HistoryMsg, Seeked } from './worker.ts';

export { readMoment } from './link.ts';

const DAY_US = 86_400_000_000, SLOT_US = 600_000_000;

export type HistoryHooks = {
  apply(nodes: NodeRec[], removed: string[], samples: SampleRec[]): void;
  /** A node's world matrix, once drawn (the camera's frame). */
  frame(id: string): THREE.Matrix4 | null;
  /** The world's root node, once known. */
  root(): string | null;
  /** Starts the live stream at `address` (V5's `StreamSource`). */
  live(address: string): void;
};

export class HistoryPage {
  readonly clock: HistoryClock;
  readonly base: URL;
  /** For the proof: the state hash at the moment opened, the time from navigation to its first frame, the seek's time
   *  (V4's measure: asked to ready to draw) and its bytes. */
  readonly opened = { hash: null as string | null, readyMs: null as number | null, seekMs: null as number | null, workerMs: [] as number[], bytes: 0 };
  private asked = performance.now();
  private worker: Worker;
  private seq = 0;
  private loadedTo: number;
  private nextStart: number | null = null;
  private fetching = false;
  private cameraPlaced = false;
  private error = '';
  private bar: HTMLInputElement;
  private moment: Moment;
  private cam: FreeCamera;
  private hooks: HistoryHooks;
  live = false;

  constructor(moment: Moment, cam: FreeCamera, hooks: HistoryHooks) {
    this.moment = moment;
    this.cam = cam;
    this.hooks = hooks;
    this.clock = new HistoryClock(moment.at);
    this.loadedTo = moment.at;
    this.base = new URL(historyBase(moment), location.href);
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<HistoryMsg>) => this.message(e.data);
    this.bar = this.controls();
    // Another moment (a scrub's release, a pasted link) opens cold, as the link would on another machine.
    addEventListener('hashchange', () => location.reload());
    this.seek(moment.at);
    this.worker.postMessage({ base: this.base.href, counts: Math.floor(moment.at / DAY_US) });
  }

  private seek(at: number) {
    this.fetching = true;
    // Only the link's moment is hashed (A2); bundles played forward are not.
    this.worker.postMessage({ base: this.base.href, seq: ++this.seq, at, hash: this.opened.hash === null });
  }

  private message(m: HistoryMsg) {
    if (m.t === 'error') return void (m.seq === this.seq && ((this.error = m.message), (this.fetching = false)));
    if (m.t === 'counts') return this.drawCounts(m.rows);
    const s: Seeked = m.s;
    if (s.seq !== this.seq) return; // a newer seek replaced it
    this.fetching = false;
    this.hooks.apply(s.nodes, [], s.samples);
    this.loadedTo = s.next ?? s.start + s.length;
    this.nextStart = s.next;
    if (this.opened.hash === null) Object.assign(this.opened, { hash: s.hash, bytes: s.bytes, seekMs: performance.now() - this.asked, workerMs: s.ms });
  }

  /** Each frame: the time to draw, or null until the moment has loaded. Hands over to the live clock when it returns. */
  step(dtMs: number, liveNow: number | null, liveTo: number | null): number | null {
    if (this.opened.hash === null) return null;
    if (!this.cameraPlaced) this.placeCamera();
    const r = this.clock.step(dtMs, this.loadedTo, this.clock.returning ? liveNow : null, liveTo);
    this.live = r.live;
    if (r.live) this.box?.remove();
    // Plays forward: the next bundle is fetched ten seconds before the clock needs it.
    if (!this.fetching && this.nextStart !== null && r.t > this.loadedTo - 10_000_000) this.seek(this.nextStart);
    if (!this.dragging) this.bar.value = String(Math.round((r.t % DAY_US) / 1e6));
    return r.t;
  }

  private placeCamera() {
    const c = this.moment.camera, frame = c ? this.hooks.frame(c.node) : null;
    if (c && !frame) return;
    this.cameraPlaced = true;
    // Ready: the frame after the one that first draws the moment.
    requestAnimationFrame(() => requestAnimationFrame(() => (this.opened.readyMs = performance.now())));
    if (!c || !frame) return;
    const p = placeCamera(c, frame);
    this.cam.controls.target.copy(p.target);
    this.cam.camera.position.copy(p.eye);
    this.cam.controls.update();
  }

  /** The fragment of a link to `at`, from the camera as it stands, framed on the world's root. */
  fragment(at = this.clock.t): string {
    const root = this.hooks.root() ?? '', frame = this.hooks.frame(root) ?? new THREE.Matrix4();
    const camera = cameraAt(root, frame, this.cam.camera.position, this.cam.controls.target);
    return writeMoment({ ...this.moment, at, camera });
  }

  /** Back to live: the live stream named by the history's `live` file. */
  async backToLive() {
    const res = await fetch(new URL('live', this.base));
    if (!res.ok) return void (this.error = 'no live stream for this world');
    this.hooks.live(new URL(`../../../${(await res.text()).trim()}/`, this.base).href);
    this.clock.returning = true;
  }

  status(): string {
    const s = Math.floor(this.clock.t / 1e6);
    const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    return `history           ${hms}  (${this.clock.state}${this.clock.cut ? ', cut' : ''}, ×${this.clock.speed})\n`
      + `state hash        ${this.opened.hash?.slice(0, 16) ?? '…'} at the link's moment`
      + (this.error ? `\n${this.error}` : '');
  }

  private dragging = false;
  private box: HTMLDivElement | null = null;
  private counts: HTMLCanvasElement | null = null;

  private controls(): HTMLInputElement {
    const box = (this.box = document.createElement('div'));
    box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;display:flex;gap:8px;align-items:center;'
      + 'font:13px ui-monospace,Menlo,monospace;color:#e8e6e1;background:rgba(16,20,26,.78);padding:8px;border-radius:4px';
    const button = (label: string, on: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = on;
      box.append(b);
      return b;
    };
    const play = button('pause', () => ((this.clock.paused = !this.clock.paused), (play.textContent = this.clock.paused ? 'play' : 'pause')));
    const speed = button('×1', () => ((this.clock.speed = this.clock.speed >= 8 ? 1 : this.clock.speed * 2), (speed.textContent = `×${this.clock.speed}`)));
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;flex:1;height:28px';
    this.counts = document.createElement('canvas');
    this.counts.width = 144;
    this.counts.height = 1;
    this.counts.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;opacity:.6';
    const bar = document.createElement('input');
    bar.type = 'range';
    bar.min = '0';
    bar.max = String(DAY_US / 1e6 - 1);
    bar.style.cssText = 'position:absolute;inset:0;width:100%;margin:0';
    // While the handle moves only the coarse level is read; the moment opens on release, cold, from its own link.
    bar.oninput = () => (this.dragging = true);
    bar.onchange = () => {
      this.dragging = false;
      const day = Math.floor(this.clock.t / DAY_US) * DAY_US;
      location.hash = this.fragment(day + Number(bar.value) * 1e6);
    };
    wrap.append(this.counts, bar);
    box.append(wrap);
    button('back to live', () => void this.backToLive());
    button('link', () => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}${this.fragment()}`).catch(() => {}));
    document.body.append(box);
    return bar;
  }

  /** The day's timeline: events per ten minutes, all kinds, as V4's coarse level counts them. */
  private drawCounts(rows: number[][]) {
    const per = new Array(DAY_US / SLOT_US).fill(0);
    for (const [slot, , n] of rows) per[slot % per.length] += n;
    const most = Math.max(1, ...per), g = this.counts?.getContext('2d');
    if (!g) return;
    per.forEach((n, i) => ((g.fillStyle = `rgba(242,165,65,${n / most})`), g.fillRect(i, 0, 1, 1)));
  }
}
