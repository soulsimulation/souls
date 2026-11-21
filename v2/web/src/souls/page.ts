// The Souls on the page (W4, #2748): chips, status and speech over the view, and a Soul's page, all drawn from the
// copy the page already holds (`SoulsCopy`, fed by the parts it plays). Opening a card also reads its immutable test mark. Clicking a chip or
// a line of speech opens that Soul's page; `soul=<id>` opens one from the address; `chips=0` draws none.
// A Soul's page shows only what the public may see: name, description, status and recent public events. Every field is
// set as text (`textContent`), never as markup.
// Conversations (N-V21, #3678): public lines fold into threads (`layer.ts` `Conversations`); a button over each live group
// on screen, a Soul's page listing its threads, and the dock showing one thread's members and lines, live. Opening one
// frames its members in the view (`framer`, set by the camera) and outlines their chips in the thread's colour.
import * as THREE from 'three';
import type { NodeRec, PartRec } from '../source/source.ts';
import type { WorldView } from '../draw/world.ts';
import { SoulsCopy, TestMark, label, spoken, TALK_MM, wrap, type Status } from './souls.ts';
import { Conversations, SPEECH_W, groupShot, measurer, paint, place, type Candidate, type Ctx, type Placed, type Thread } from './layer.ts';
import { mountCard } from './mine.ts';

const UM = 1e-6, HEAD = 2.1, FAR = 150;

export type PageSouls = {
  copy: SoulsCopy; snapshot(nodes: NodeRec[], removed: string[]): void; apply(p: PartRec): void; draw(t: number, camera: THREE.Camera): void; open(id: string | null): void; placed: Placed[];
  /** The page's public conversations, and the one shown in the dock (null: the dock is closed). */
  talk: Conversations; converse(id: string | null, frame?: boolean): void;
  /** Puts the camera at `eye` looking at `target`; the camera director sets it. */
  framer: ((eye: THREE.Vector3, target: THREE.Vector3) => void) | null;
};

/** How many group buttons are over the view at most, how near (m) and how recent (µs) a group must be, as today. */
const MARKERS = 6, MARKER_M = 48, MARKER_US = 60_000_000;
const ago = (us: number) => (us < 60e6 ? 'now' : us < 3600e6 ? `${Math.round(us / 60e6)}m ago` : `${Math.round(us / 3600e6)}h ago`);
const joinNames = (n: string[], most = 3) => {
  const shown = n.length > most ? [...n.slice(0, most - 1), `${n.length - most + 1} others`] : n;
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} & ${shown.at(-1)}`;
};

/** The conversation dock: one element, its fields set as text, over the view's lower left. */
function dock(onClose: () => void, onFollow: () => void) {
  const el = document.createElement('aside');
  el.id = 'conversation';
  el.setAttribute('aria-label', 'Live conversation');
  el.style.cssText = 'position:fixed;z-index:12;left:12px;bottom:56px;width:min(340px,calc(100vw - 24px));max-height:min(40vh,420px);display:none;flex-direction:column;'
    + 'padding:10px 12px;background:rgba(16,20,26,0.92);color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;border-radius:6px;box-sizing:border-box;border-left:3px solid transparent';
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close conversation');
  close.style.cssText = 'position:absolute;right:8px;top:6px;background:none;border:0;color:inherit;font-size:20px;line-height:1;cursor:pointer';
  close.onclick = onClose;
  const who = document.createElement('button');
  who.title = 'Frame this conversation in the view';
  who.style.cssText = 'display:block;max-width:calc(100% - 28px);text-align:left;background:none;border:0;padding:0;color:inherit;font:600 14px system-ui,sans-serif;cursor:pointer';
  who.onclick = onFollow;
  const hear = document.createElement('p');
  hear.style.cssText = 'margin:2px 0 6px;color:#9fb3c4;font-size:12px';
  const list = document.createElement('ol');
  list.setAttribute('aria-label', 'Lines, newest last');
  list.tabIndex = 0;
  list.style.cssText = 'margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;min-height:0';
  el.append(close, who, hear, list);
  document.body.append(el);
  return { el, who, hear, list };
}

/** The Soul page's panel: one element, its fields set as text. */
function panel(onClose: () => void) {
  const el = document.createElement('aside');
  el.id = 'soul-page';
  el.style.cssText = 'position:fixed;z-index:11;right:12px;top:12px;width:min(320px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;'
    + 'padding:12px 14px;background:rgba(16,20,26,0.9);color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;border-radius:6px;display:none;box-sizing:border-box';
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.style.cssText = 'float:right;background:none;border:0;color:inherit;font-size:20px;line-height:1;cursor:pointer';
  close.onclick = onClose;
  const test = document.createElement('p');
  test.style.cssText = 'margin:0 0 6px;font-weight:bold';
  const name = document.createElement('h2'), desc = document.createElement('p'), status = document.createElement('p'), list = document.createElement('ol');
  name.style.cssText = 'margin:0 0 4px;font-size:16px';
  desc.style.cssText = 'margin:0 0 6px;color:#c9c4ba';
  status.style.cssText = 'margin:0 0 8px;color:#9fb3c4;font-size:12px';
  list.style.cssText = 'margin:0;padding:0 0 0 18px';
  const talks = document.createElement('ol');
  talks.setAttribute('aria-label', 'Conversations');
  talks.style.cssText = 'margin:10px 0 0;padding:0;list-style:none';
  el.append(close, name, test, desc, status, list, talks);
  document.body.append(el);
  return { el, name, test, desc, status, list, talks };
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
  const talk = new Conversations();
  let focus: string | null = null, dockShown = '', talksShown = '';
  const names = new Map<string, string>(); // the last name each Soul had, so a thread keeps it after the Soul goes
  const nameOf = (id: string) => { const s = copy.souls.get(id); return s ? label(s) : names.get(id) ?? 'someone'; };
  const d = dock(() => out.converse(null), () => focus && frame(focus));
  let lastCamera: THREE.Camera | null = null, lastT: number | null = null;
  /** Where a body's feet were at world time `at`, metres; null when it is not drawn. */
  const where = (id: string, at: number) => {
    const n = world.nodes.get(id);
    if (!n) return null;
    const p = world.tracks.get(id)?.at(at);
    const w = new THREE.Vector3();
    if (p) w.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(world.frame(n.parent));
    else w.setFromMatrixPosition(world.frame(id));
    return w;
  };
  /** Frames a thread's members: the camera goes to a shot that holds them all. */
  const frame = (id: string): boolean => {
    const t = talk.threads.get(id), camera = lastCamera as THREE.PerspectiveCamera | null;
    if (!t || !camera || lastT === null || !out.framer) return false;
    const heads = Conversations.members(t).flatMap((m) => { const p = where(m, lastT!); return p ? [p.setY(p.y + HEAD)] : []; });
    const shot = groupShot(heads, camera.fov ?? 50, camera.aspect ?? innerWidth / innerHeight, camera.getWorldPosition(new THREE.Vector3()));
    if (!shot) return false;
    out.framer(new THREE.Vector3(shot.eye.x, shot.eye.y, shot.eye.z), new THREE.Vector3(shot.target.x, shot.target.y, shot.target.z));
    return true;
  };
  // The group buttons: a small pool reused every frame, never an element per Soul.
  const markers: HTMLButtonElement[] = [];
  const marker = (i: number) => {
    if (markers[i]) return markers[i];
    const b = document.createElement('button');
    b.textContent = '💬';
    b.title = 'Open this conversation and frame who is in it';
    b.style.cssText = 'position:fixed;z-index:10;display:none;transform:translate(-50%,-100%);padding:3px 7px;border:0;border-radius:12px;'
      + 'background:rgba(16,20,26,0.85);color:#fff;font:14px/1 system-ui,sans-serif;cursor:pointer;border-bottom:3px solid transparent';
    b.onclick = () => b.dataset.thread && out.converse(b.dataset.thread, true);
    document.body.append(b);
    return (markers[i] = b);
  };
  /** A thread's line as text: the speaker's name, then the words. */
  const lineText = (l: { speaker: string; words: string }) => `${nameOf(l.speaker)}: ${l.words}`;
  const showDock = (t: number) => {
    const th = focus ? talk.threads.get(focus) : undefined;
    const said = th ? Conversations.by(th, t) : [];
    d.el.style.display = th ? 'flex' : 'none';
    if (!th) return;
    const members = Conversations.members(th).map(nameOf);
    const speakers = new Set(Conversations.members(th));
    const also = [...th.hearers].filter(([id, at]) => !speakers.has(id) && th.lastAt - at < 240_000_000).map(([id]) => nameOf(id));
    const hear = `💬 aloud · anyone near hears${also.length ? ` · also heard by ${joinNames(also, 2)}` : ''} · ${ago(Math.max(0, t - (said.at(-1)?.at ?? t)))}`;
    const key = `${th.id}\u0000${said.length}\u0000${talk.version}\u0000${members.join()}\u0000${hear}`;
    if (key === dockShown) return;
    const fresh = !dockShown.startsWith(`${th.id}\u0000`);
    dockShown = key;
    d.el.style.borderLeftColor = th.colour;
    d.who.textContent = joinNames(members);
    d.who.setAttribute('aria-label', `Frame the conversation with ${joinNames(members)}`);
    d.hear.textContent = hear;
    const l = d.list as HTMLOListElement & { scrollTop: number; scrollHeight: number; clientHeight: number };
    // Follows the newest line unless the reader scrolled up.
    const stick = fresh || !(l.scrollHeight > 0) || l.scrollTop + l.clientHeight >= l.scrollHeight - 12;
    l.replaceChildren(...said.map((line) => {
      const li = document.createElement('li');
      li.style.cssText = 'margin:0 0 4px';
      li.textContent = lineText(line);
      return li;
    }));
    if (stick) l.scrollTop = l.scrollHeight ?? 0;
  };
  /** The open Soul's conversations on its page: the newest three, each opening in the dock. */
  const showTalks = (t: number) => {
    const mine = open ? talk.of(open).filter((th) => Conversations.by(th, t).length).slice(0, 3) : [];
    const key = `${open}\u0000${mine.map((th) => `${th.id}:${Conversations.by(th, t).length}`).join()}`;
    if (key === talksShown) return;
    talksShown = key;
    ui.talks.replaceChildren(...mine.map((th) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      const others = Conversations.members(th).filter((m) => m !== open).map(nameOf);
      b.textContent = `${others.length ? `With ${joinNames(others, 2)}` : 'Aloud'} · ${lineText(Conversations.by(th, t).at(-1)!)}`;
      b.title = 'Open this conversation and frame who is in it';
      b.style.cssText = `display:block;width:100%;margin:0 0 4px;padding:6px 8px;text-align:left;background:#1d242d;color:inherit;border:0;border-left:3px solid ${th.colour};border-radius:4px;font:12px/1.4 system-ui,sans-serif;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
      b.onclick = () => out.converse(th.id, true);
      li.append(b);
      return li;
    }));
  };
  // W11: a world's page carries the line that brings a new Soul (`mine.ts`).
  const worldName = params.get('world');
  if (worldName) mountCard(worldName);
  let open: string | null = params.get('soul');
  let shown = '';
  const mark = new TestMark(async (soul) => {
    const response = await fetch('/v1/pair/test-status', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ soul }),
      credentials: 'omit', redirect: 'error',
    });
    if (!response.ok) return null;
    const answer = await response.json();
    return typeof answer.test === 'boolean' ? answer.test : null;
  });
  let marked: string | null | undefined;
  const showMark = () => {
    const soul = open ? copy.souls.get(open)?.soul ?? null : null;
    if (soul === marked) return;
    marked = soul;
    mark.open(soul, (test) => { ui.test.textContent = test === true ? 'Test Soul' : test === false ? '' : 'Test status unavailable'; });
  };
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
      li.textContent = `${clock(r.at)} ${r.reach > TALK_MM ? 'shouted' : 'said'} “${r.words}”`;
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
  addEventListener('keydown', (e) => e.key === 'Escape' && (focus ? out.converse(null) : out.open(null)));

  const out: PageSouls = {
    copy,
    talk,
    framer: null,
    placed: [],
    snapshot: (nodes, removed) => { copy.snapshot(nodes, removed); showMark(); },
    apply: (p) => {
      copy.apply(p);
      for (const s of copy.souls.values()) names.set(s.id, label(s));
      for (const s of p.said ?? []) talk.add(s, where, copy.souls.keys());
      showMark();
    },
    converse(id, framed = false) {
      focus = id && talk.threads.has(id) ? id : null;
      dockShown = '';
      // On a phone the Soul's page would cover the view the conversation is framed in (today's 700 px breakpoint).
      if (focus && innerWidth <= 700) out.open(null);
      if (focus && framed) frame(focus);
    },
    open(id) {
      open = id;
      shown = '';
      marked = undefined;
      showMark();
    },
    draw(t, camera) {
      const dpr = Math.min(devicePixelRatio, 2), vw = innerWidth, vh = innerHeight;
      if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) (canvas.width = Math.round(vw * dpr)), (canvas.height = Math.round(vh * dpr));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      (lastCamera = camera), (lastT = t);
      if (focus && !talk.threads.has(focus)) focus = null;
      showPage(t);
      showTalks(t);
      showDock(t);
      if (!on) {
        for (const b of markers) b.style.display = 'none';
        return void (out.placed = []);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const speaking = copy.speaking(t);
      const eye = camera.getWorldPosition(m);
      const cands: Candidate[] = [];
      const shown = focus ? talk.threads.get(focus) : undefined;
      const ring = new Map(shown ? Conversations.members(shown).map((m) => [m, shown.colour]) : []);
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
        cands.push({ id: s.id, x: (v.x + 1) * 0.5 * vw, y: (1 - v.y) * 0.5 * vh, dist, chip: label(s), status, speech: said ? spoken(said) : null, ...(ring.has(s.id) ? { ring: ring.get(s.id) } : {}) });
      }
      out.placed = place(cands, width, lines, vw, vh);
      paint(ctx, out.placed);
      // A button over each live group of two or more on screen and near, at most `MARKERS`, as today.
      const at = new Map(cands.filter((c) => c.dist <= MARKER_M).map((c) => [c.id, c]));
      let k = 0;
      for (const th of talk.live(t, MARKER_US)) {
        if (k >= MARKERS) break;
        const pts = Conversations.members(th).flatMap((m) => (at.has(m) ? [at.get(m)!] : []));
        if (pts.length < 2) continue;
        const b = marker(k++);
        b.dataset.thread = th.id;
        b.setAttribute('aria-label', `Open the conversation with ${joinNames(Conversations.members(th).map(nameOf))}`);
        b.style.left = `${pts.reduce((n, c) => n + c.x, 0) / pts.length}px`;
        // Above the highest label of its members (a chip or a line of speech), else above their heads.
        const tops = pts.map((c) => out.placed.find((p) => p.id === c.id)?.y ?? c.y);
        b.style.top = `${Math.min(...tops) - 4}px`;
        b.style.borderBottomColor = th.colour;
        b.style.display = 'block';
      }
      for (; k < markers.length; k++) markers[k].style.display = 'none';
    },
  };
  return out;
}
