// The Souls on the page (W4, #2748): chips, status and speech over the view, and a Soul's page, all drawn from the
// copy the page already holds (`SoulsCopy`, fed by the parts it plays). Nothing here makes a request. Clicking a chip or
// a line of speech opens that Soul's page; `soul=<id>` opens one from the address; `chips=0` draws none.
// A Soul's page shows only what the public may see: name, description, status and recent public events. Every field is
// set as text (`textContent`), never as markup.
import * as THREE from 'three';
import type { PartRec } from '../source/source.ts';
import type { WorldView } from '../draw/world.ts';
import { SoulsCopy, label, wrap, type Status } from './souls.ts';
import { SPEECH_W, measurer, paint, place, type Candidate, type Ctx, type Placed } from './layer.ts';
import { mountCard } from './mine.ts';

const UM = 1e-6, HEAD = 2.1, FAR = 150;

export type PageSouls = { copy: SoulsCopy; apply(p: PartRec): void; draw(t: number, camera: THREE.Camera): void; open(id: string | null): void; placed: Placed[] };

/** The Soul page's panel: one element, its fields set as text. */
function panel(onClose: () => void) {
  const el = document.createElement('aside');
  el.style.cssText = 'position:fixed;right:12px;top:12px;width:min(320px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;'
    + 'padding:12px 14px;background:rgba(16,20,26,0.9);color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;border-radius:6px;display:none;box-sizing:border-box';
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.style.cssText = 'float:right;background:none;border:0;color:inherit;font-size:20px;line-height:1;cursor:pointer';
  close.onclick = onClose;
  const name = document.createElement('h2'), desc = document.createElement('p'), status = document.createElement('p'), list = document.createElement('ol');
  name.style.cssText = 'margin:0 0 4px;font-size:16px';
  desc.style.cssText = 'margin:0 0 6px;color:#c9c4ba';
  status.style.cssText = 'margin:0 0 8px;color:#9fb3c4;font-size:12px';
  list.style.cssText = 'margin:0;padding:0 0 0 18px';
  el.append(close, name, desc, status, list);
  document.body.append(el);
  return { el, name, desc, status, list };
}

const clock = (us: number) => {
  const s = Math.floor(us / 1e6);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function pageSouls(view: HTMLCanvasElement, world: WorldView, params: URLSearchParams): PageSouls {
  const copy = new SoulsCopy();
  const on = params.get('chips') !== '0';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none';
  view.after(canvas);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  const width = measurer(ctx);
  const lines = (s: string) => wrap(s, SPEECH_W, width);
  const ui = panel(() => out.open(null));
  // W11: a world's page carries the line that brings a new Soul (`mine.ts`).
  const worldName = params.get('world');
  if (worldName) mountCard(worldName);
  let open: string | null = params.get('soul');
  let shown = '';
  const v = new THREE.Vector3(), m = new THREE.Vector3();

  const showPage = (t: number) => {
    const p = open ? copy.page(open, t, world) : null;
    ui.el.style.display = p ? 'block' : 'none';
    if (!p) return;
    // Rebuilt only when what it shows changed.
    const key = `${p.name}\u0000${p.description}\u0000${p.status}\u0000${p.recent.map((r) => `${r.at}${r.ref}`).join()}`;
    if (key === shown) return;
    shown = key;
    ui.name.textContent = p.name;
    ui.desc.textContent = p.description;
    ui.status.textContent = p.status;
    ui.list.replaceChildren(...p.recent.map((r) => {
      const li = document.createElement('li');
      li.textContent = `${clock(r.at)} said “${r.words}”`;
      return li;
    }));
    if (!p.recent.length) {
      const li = document.createElement('li');
      li.textContent = 'nothing said in view yet';
      ui.list.append(li);
    }
  };

  // A click (not a drag) on a placed label opens that Soul's page.
  let down: [number, number] | null = null;
  view.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  view.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const hit = out.placed.find((p) => e.clientX >= p.x && e.clientX <= p.x + p.w && e.clientY >= p.y && e.clientY <= p.y + p.h);
    if (hit) out.open(hit.id);
  });
  addEventListener('keydown', (e) => e.key === 'Escape' && out.open(null));

  const out: PageSouls = {
    copy,
    placed: [],
    apply: (p) => copy.apply(p),
    open(id) {
      open = id;
      shown = '';
    },
    draw(t, camera) {
      const dpr = Math.min(devicePixelRatio, 2), vw = innerWidth, vh = innerHeight;
      if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) (canvas.width = Math.round(vw * dpr)), (canvas.height = Math.round(vh * dpr));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      showPage(t);
      if (!on) return void (out.placed = []);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const speaking = copy.speaking(t);
      const eye = camera.getWorldPosition(m);
      const cands: Candidate[] = [];
      for (const s of copy.souls.values()) {
        const n = world.nodes.get(s.id);
        if (!n) continue;
        const p = world.tracks.get(s.id)?.at(t);
        if (p) v.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(world.frame(n.parent));
        else v.setFromMatrixPosition(world.frame(s.id));
        v.y += HEAD;
        const dist = v.distanceTo(eye);
        if (dist > FAR) continue;
        v.project(camera);
        if (v.z > 1 || v.z < -1) continue;
        const said = speaking.get(s.id);
        const status: Status = copy.status(s.id, t, world, speaking);
        cands.push({ id: s.id, x: (v.x + 1) * 0.5 * vw, y: (1 - v.y) * 0.5 * vh, dist, chip: label(s), status, speech: said?.words ?? null });
      }
      out.placed = place(cands, width, lines, vw, vh);
      paint(ctx, out.placed);
    },
  };
  return out;
}
