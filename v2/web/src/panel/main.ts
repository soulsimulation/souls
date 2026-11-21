import { creatorHandoff } from '../worlds/handoff.ts';
import { browserSession, localTestSignIn, sessionRequest } from '../source/signin.ts';
import { worldAddress } from '../source/address.ts';
// The creator's panel (Engine v2 W5, #2801): the world's one creator places and moves things by hand, through the same
// gate as their agent. The panel opens only after the session exchange (gatewayd's `creator.rs`) gives a creator's
// token for W1's session; anyone else is told `not-the-creator` and the panel stays shut. Its picture is the world's
// public stream (`?stream=`, as the page plays it), drawn from above. A drag draws a ghost here and sends one edit on
// release; the page has no other way to change the world. The world's answer rules: each batch is listed with it.
//
// The prayers waiting for the creator (G11, #3335) are listed beside the batches, on the same socket, and answered
// here as the creator's agent answers them (`prayers.ts`). A prayer's words are shown as text, never as markup.
//
// Sign-in uses the existing provider session, as account and world creation do. Test people are HTTP-loopback only.
import init, { wireHello, wireSignIn } from 'replica';
import { StreamSource } from '../source/stream.ts';
import { reconcileSnapshot, type NodeRec, type SnapshotRec } from '../source/source.ts';
import { idOf, type Frame, type Op } from './edit.ts';
import { CreatorSession } from './session.ts';
import { Drag, refusalText, soulName, type At, type Body } from './drag.ts';
import { ANSWER_MOST, Prayers, prayerRefusal, type Prayer } from './prayers.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const status = $<HTMLDivElement>('status');
const kinds = $<HTMLSelectElement>('kind');
const batches = $<HTMLOListElement>('batches');
const warn = $<HTMLDivElement>('warn');
const params = new URLSearchParams(location.search);
let addressError = '';
const installed = await worldAddress(location.href).catch(e => { addressError = String(e.message); return null; });
const UM = 1e-6;

// The page's copy, from the stream: nodes by id.
const nodes = new Map<string, NodeRec>();
let session: CreatorSession | null = null;
let activeSocket: WebSocket | null = null, openAttempt = 0;
let stopIdentity: (() => void) | null = null;
let prayers: Prayers | null = null;
let placing = false;
/** Things this panel placed, by id, until the stream shows them: the receipt's id at the spot sent. */
const placed = new Map<string, At>();
/** Things moved by the panel, until the stream catches up: drawn where the edit put them. */
const sentTo = new Map<string, At>();

const short = (kind: string) => kind.split('@')[0]!.replace(/^souls:/, '');
const isBody = (n: NodeRec) => n.at !== null || n.name !== undefined || /body/.test(short(n.kind));
function worldAt(id: string): At {
  let x = 0, z = 0, n = nodes.get(id);
  while (n) (x += n.pos[0] * UM), (z += n.pos[2] * UM), (n = n.parent ? nodes.get(n.parent) : undefined);
  return { x, z };
}
const bodies = (): Body[] => [...nodes.values()].filter(isBody).map((n) => ({ id: n.id, name: n.name ?? null, at: worldAt(n.id) }));
/** Things a creator moves: every node with a parent that is not a body and has no children of its own. */
function things(): NodeRec[] {
  const parents = new Set([...nodes.values()].map((n) => n.parent));
  return [...nodes.values()].filter((n) => n.parent && !isBody(n) && !parents.has(n.id));
}
/** Where new things go: the parent of the things there are (a room), else the root's first child. */
function room(): string | null {
  const t = things()[0];
  if (t?.parent) return t.parent;
  const root = [...nodes.values()].find((n) => !n.parent);
  return [...nodes.values()].find((n) => n.parent === root?.id)?.id ?? null;
}

// The view: metres from above, the room's middle at the centre.
let scale = 60, cx = 0, cz = 0;
const toScreen = (a: At) => [canvas.width / 2 + (a.x - cx) * scale, canvas.height / 2 + (a.z - cz) * scale] as const;
const toWorld = (px: number, py: number): At => ({ x: cx + (px - canvas.width / 2) / scale, z: cz + (py - canvas.height / 2) / scale });

function draw() {
  const dpr = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#e9e4d8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  for (let m = -20; m <= 20; m++) {
    const [x0, y0] = toScreen({ x: m, z: -20 }), [x1, y1] = toScreen({ x: m, z: 20 });
    ctx.beginPath(), ctx.moveTo(x0, y0), ctx.lineTo(x1, y1), ctx.stroke();
    const [a0, b0] = toScreen({ x: -20, z: m }), [a1, b1] = toScreen({ x: 20, z: m });
    ctx.beginPath(), ctx.moveTo(a0, b0), ctx.lineTo(a1, b1), ctx.stroke();
  }
  ctx.font = `${12 * dpr}px ui-sans-serif, system-ui`;
  const s = 0.6 * scale;
  for (const n of things()) {
    const at = sentTo.get(n.id) ?? worldAt(n.id);
    const [x, y] = toScreen(at);
    ctx.fillStyle = drag.ghost?.id === n.id ? '#9aa7b4' : '#3f6e9e';
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.fillStyle = '#222';
    ctx.fillText(short(n.kind), x - s / 2, y + s / 2 + 14 * dpr);
  }
  for (const [id, at] of placed) {
    if (nodes.has(id)) continue;
    const [x, y] = toScreen(at);
    ctx.fillStyle = '#3f6e9e';
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
  for (const b of bodies()) {
    const [x, y] = toScreen(b.at);
    ctx.fillStyle = '#c2553d';
    ctx.beginPath(), ctx.arc(x, y, 0.5 * scale, 0, Math.PI * 2), ctx.fill();
    ctx.fillStyle = '#222';
    ctx.fillText(`Soul ${soulName(b)}`, x + 0.55 * scale, y + 4 * dpr);
  }
  const g = drag.ghost;
  if (g) {
    const [x, y] = toScreen(g.at);
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.strokeStyle = g.over ? '#7a1f10' : '#3f6e9e';
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    ctx.setLineDash([]);
  }
  warn.textContent = g?.over ? `This would land on Soul ${soulName(g.over)}: the world will refuse it.` : '';
  requestAnimationFrame(draw);
}

function list(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.textContent = text;
  batches.prepend(li);
  return li;
}

/** The answer's line: a receipt, or the refusal's name, and for a build-safety refusal the Soul the edit was onto. */
function answered(li: HTMLLIElement, what: string, f: Frame, at: At) {
  if (f.t === 'receipt') return void (li.textContent = `${what}: done`), li.classList.add('ok');
  if (f.t !== 'refused') return;
  li.textContent = `${what}: ${refusalText(f.reason, at, bodies())}`;
  li.classList.add('refused');
}

async function send(what: string, ops: Op[], at: At): Promise<Frame | null> {
  if (!session) return null;
  const li = list(`${what}: sent`);
  const signed = session;
  const f = await signed.edit(ops);
  if (session !== signed) return null;
  answered(li, what, f, at);
  status.textContent = `signed in as the creator · edits sent ${signed.sent}`;
  return f;
}

const spot = (parent: string, at: At) => {
  const p = worldAt(parent);
  return { x: (at.x - p.x) / UM, y: 0, z: (at.z - p.z) / UM };
};

const drag = new Drag((id, at) => {
  const parent = nodes.get(id)?.parent ?? room();
  if (!parent) return;
  const attempt = openAttempt;
  sentTo.set(id, at);
  void send(`move ${short(nodes.get(id)?.kind ?? 'thing')}`, [{ op: 'move', node: id, at: spot(parent, at) }], at).then((f) => {
    if (attempt === openAttempt && f?.t !== 'receipt') sentTo.delete(id);
  });
}, bodies);

function hit(at: At): string | null {
  for (const n of things()) {
    const p = sentTo.get(n.id) ?? worldAt(n.id);
    if (Math.abs(p.x - at.x) < 0.4 && Math.abs(p.z - at.z) < 0.4) return n.id;
  }
  return null;
}

const pointer = (e: PointerEvent): At => {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  return toWorld((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
};
canvas.addEventListener('pointerdown', (e) => {
  if (!session || session.state !== 'open') return;
  const at = pointer(e);
  if (placing) {
    const parent = room(), kind = kinds.value;
    placing = false;
    $<HTMLButtonElement>('place').classList.remove('on');
    if (!parent || !kind) return;
    const attempt = openAttempt;
    void send(`place ${short(kind)}`, [{ op: 'place', name: 1, kind, parent, at: spot(parent, at) }], at).then((f) => {
      if (attempt !== openAttempt) return;
      const id = f?.t === 'receipt' ? f.names.get(1) : undefined;
      if (id) placed.set(id, at);
    });
    return;
  }
  const id = hit(at);
  if (!id) return;
  canvas.setPointerCapture(e.pointerId);
  drag.down(id, at);
});
canvas.addEventListener('pointermove', (e) => drag.move(pointer(e)));
canvas.addEventListener('pointerup', () => drag.up());
canvas.addEventListener('pointercancel', () => drag.cancel());
addEventListener('keydown', (e) => e.key === 'Escape' && drag.cancel());
$<HTMLButtonElement>('place').addEventListener('click', (e) => {
  placing = !placing;
  (e.currentTarget as HTMLElement).classList.toggle('on', placing);
});

/** The Soul a prayer is from: its body's name when the stream shows it, else a short form of its grant. */
function prayerFrom(p: Prayer): string {
  const [scope, n] = p.soul.replace(/^soul-/, '').split('-');
  const body = nodes.get(`${scope}.${n}`) ?? nodes.get(`${scope}-${n}`);
  return body?.name ?? `Soul ${scope!.slice(0, 6)}…-${n}`;
}

/** The waiting prayers, each with Answer; nothing when none wait (as today's panel). */
let answering: string | null = null;
function showPrayers() {
  const box = $<HTMLElement>('prayers');
  const waiting = prayers?.waiting ?? [];
  box.replaceChildren();
  box.dataset.prayers = String(waiting.length);
  if (!waiting.length) return;
  const h = document.createElement('div');
  h.className = 'h';
  h.textContent = waiting.length === 1 ? '1 prayer waiting' : `${waiting.length} prayers waiting`;
  const ul = document.createElement('ul');
  for (const p of waiting) {
    const li = document.createElement('li');
    li.dataset.prayer = p.id;
    const who = document.createElement('b');
    who.textContent = prayerFrom(p);
    const words = document.createElement('p');
    words.append(who, ` ${p.text}`);
    li.append(words);
    if (answering === p.id) {
      const form = document.createElement('form');
      const input = Object.assign(document.createElement('input'), { maxLength: ANSWER_MOST, placeholder: `Your answer to ${prayerFrom(p)}` });
      input.dataset.answerText = p.id;
      const sendIt = Object.assign(document.createElement('button'), { textContent: 'Answer' });
      sendIt.dataset.answerSend = p.id;
      const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
      const error = Object.assign(document.createElement('div'), { className: 'refused' });
      cancel.onclick = () => { answering = null; showPrayers(); };
      form.onsubmit = (e) => {
        e.preventDefault();
        sendIt.disabled = true;
        sendIt.textContent = 'Sending…';
        const currentPrayers = prayers;
        void currentPrayers!.answer(p.id, input.value).then((refused) => {
          if (prayers !== currentPrayers) return;
          if (refused) { error.textContent = prayerRefusal(refused); sendIt.disabled = false; sendIt.textContent = 'Answer'; return; }
          answering = null;
          list(`answered a prayer from ${prayerFrom(p)}`).classList.add('ok');
          showPrayers();
        });
      };
      form.append(input, sendIt, cancel, error);
      li.append(form);
      setTimeout(() => input.focus());
    } else {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Answer' });
      b.dataset.answer = p.id;
      b.onclick = () => { answering = p.id; showPrayers(); };
      li.append(b);
    }
    ul.append(li);
  }
  box.append(h, ul);
}

/** Account changes revoke this page's old authority and private UI before any new exchange. */
function invalidateCreator() {
  openAttempt++;
  const previous = activeSocket;
  activeSocket = null; session = null;
  stopIdentity?.(); stopIdentity = null;
  prayers?.stop(); prayers = null; answering = null; showPrayers(); batches.replaceChildren();
  placing = false; drag.cancel(); placed.clear(); sentTo.clear();
  $<HTMLButtonElement>('place').classList.remove('on');
  document.body.classList.remove('creator', 'refused');
  previous?.close();
}

/** The session exchange, then the socket. */
async function open(name: string) {
  invalidateCreator();
  const attempt = openAttempt;
  status.textContent = 'asking the gateway for a creator token';
  const identity = await browserSession(name);
  if (attempt !== openAttempt) return;
  if (!identity) { status.textContent = 'Finish signing in, then open the panel again.'; return; }
  const unsubscribe = identity.subscribeIdentity?.(() => {
    if (attempt !== openAttempt) return;
    invalidateCreator();
    status.textContent = 'Account changed. Open the panel to verify creator access again.';
  });
  if (attempt !== openAttempt) { unsubscribe?.(); return; }
  stopIdentity = unsubscribe ?? null;
  const request = await sessionRequest(identity, 'world');
  if (attempt !== openAttempt) return;
  if (addressError) throw new Error(addressError);
  const res = await fetch(installed?.creatorToken ?? '/v2/creator-token', request);
  const body = (await res.json()) as { token?: string; grant?: string; refused?: string };
  if (attempt !== openAttempt) return;
  if (!res.ok || !body.token || !body.grant) {
    status.textContent = `refused: ${body.refused ?? res.status}. The panel opens only for this world's creator.`;
    document.body.classList.add('refused');
    return;
  }
  await init();
  if (attempt !== openAttempt) return;
  const ws = new WebSocket(installed?.gateway ?? new URL('/v2/ws', location.href.replace(/^http/, 'ws')));
  activeSocket = ws;
  const current = () => attempt === openAttempt && activeSocket === ws;
  ws.binaryType = 'arraybuffer';
  const waiting = new Prayers({ send: (t) => ws.send(t) });
  ws.onopen = () => {
    if (!current()) return;
    const signed = new CreatorSession(ws, idOf(body.grant!.replace(/^creator-/, '')), wireHello(), wireSignIn(body.token!, new Uint8Array(0)), Date.now() * 1000);
    session = signed; prayers = waiting;
    prayers.onChange = () => { if (!answering) showPrayers(); };
    signed.onOpen = () => {
      if (!current() || session !== signed) return;
      waiting.start();
      status.textContent = 'signed in as the creator · edits sent 0';
      document.body.classList.replace('refused', 'creator') || document.body.classList.add('creator');
    };
  };
  ws.onmessage = (e) => current() && (typeof e.data === 'string' ? void waiting.text(e.data) : session?.frame(new Uint8Array(e.data as ArrayBuffer)));
  ws.onclose = () => {
    waiting.stop();
    if (!current()) return;
    const outcome = session?.outcome;
    activeSocket = null; session = null; prayers = null;
    document.body.classList.remove('creator'); showPrayers();
    status.textContent = `the socket closed${outcome ? ` (${outcome})` : ''}`;
  };
}
$<HTMLFormElement>('signin').addEventListener('submit', (e) => {
  e.preventDefault();
  const opening = open($<HTMLInputElement>('who').value.trim()), attempt = openAttempt;
  void opening.catch((e) => { if (attempt === openAttempt) status.textContent = e.message; });
});

$<HTMLInputElement>('who').parentElement!.hidden = !localTestSignIn(location.href);

/** Both the full public baseline and genuine changes update the same panel observation. */
function applyNodes(p: SnapshotRec): void {
  for (const id of p.removed) nodes.delete(id);
  for (const n of p.nodes) nodes.set(n.id, n);
  for (const id of [...sentTo.keys()]) {
    const at = worldAt(id), want = sentTo.get(id)!;
    if (Math.hypot(at.x - want.x, at.z - want.z) < 0.05) sentTo.delete(id);
  }
  const seen = new Set([...kinds.options].map((o) => o.value));
  for (const n of things()) {
    if (seen.has(n.kind)) continue;
    seen.add(n.kind);
    kinds.add(new Option(short(n.kind), n.kind));
  }
  const r = room();
  if (r) ({ x: cx, z: cz } = worldAt(r));
}

const address = installed?.stream ?? (addressError ? null : params.get('stream'));
if (address) {
  new StreamSource(address).start({
    pointer() {},
    snapshot(s) { applyNodes(reconcileSnapshot(nodes.keys(), s)); },
    part: applyNodes,
    error: (m) => (status.textContent = m),
  });
} else status.textContent = addressError || 'no stream: open this page with ?stream=<the stream directory>';
Object.assign(globalThis, { panel: { nodes, get session() { return session; }, get prayers() { return prayers; }, drag } });
requestAnimationFrame(draw);

creatorHandoff($<HTMLElement>('handoff'), installed?.world ?? null, installed?.directory ?? location.origin, () => $<HTMLInputElement>('who').value);
