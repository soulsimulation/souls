// Chips and speech on screen (W4, #2748): one 2D canvas over the view, drawn in one pass a frame, never a page element
// per Soul (1,000 elements was today's fault, #2554). Labels are placed nearest first, and one that would overlap a
// placed one is left out, so far ones give way first; at most `MAX_LABELS` a frame. Speech is placed before chips.
// Every word is drawn with `fillText`: text only, never markup, and nothing in it becomes a link.

/** One Soul on screen this frame: where its head projects (CSS px), how far it is (m), and what to draw. */
export type Candidate = { id: string; x: number; y: number; dist: number; chip: string; status: string; speech: string | null; ring?: string };
export type Placed = { id: string; x: number; y: number; w: number; h: number; lines: string[]; speech: boolean; status: string; ring?: string };

export const MAX_LABELS = 160;
const FONT = '12px system-ui, sans-serif', SMALL = '10px system-ui, sans-serif', LINE = 15, PAD = 5, SPEECH_W = 240;

/** What the layer needs from a 2D context; the page's canvas, or a recorder in a test. */
export type Ctx = Pick<CanvasRenderingContext2D, 'fillText' | 'measureText' | 'fillRect' | 'clearRect' | 'setTransform' | 'beginPath' | 'moveTo' | 'lineTo' | 'fill'> & {
  font: string; fillStyle: string | CanvasGradient | CanvasPattern; textBaseline: CanvasTextBaseline;
};

/** Places labels: speech first, then chips, each nearest first; a label overlapping one already placed is left out. */
export function place(cands: Candidate[], width: (s: string, small?: boolean) => number, wrapLines: (s: string) => string[], vw: number, vh: number): Placed[] {
  const out: Placed[] = [];
  const order = [...cands].sort((a, b) => Number(!a.speech) - Number(!b.speech) || a.dist - b.dist);
  for (const c of order) {
    if (out.length >= MAX_LABELS) break;
    const lines = c.speech ? wrapLines(c.speech) : [c.chip];
    const w = Math.max(...lines.map((l) => width(l)), c.speech ? 0 : width(c.status, true)) + 2 * PAD;
    const h = (c.speech ? lines.length * LINE : LINE + 11) + 2 * PAD;
    const x = c.x - w / 2, y = c.y - h - (c.speech ? 8 : 2);
    if (x + w < 0 || y + h < 0 || x > vw || y > vh) continue;
    if (out.some((p) => x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h)) continue;
    out.push({ id: c.id, x, y, w, h, lines, speech: !!c.speech, status: c.status, ...(c.ring ? { ring: c.ring } : {}) });
  }
  return out;
}

/** Draws placed labels, farthest first so the nearest are on top. */
export function paint(ctx: Ctx, placed: Placed[]): void {
  ctx.textBaseline = 'top';
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    // A member of the conversation in the dock is framed in its colour (N-V21, as today's group selection).
    if (p.ring) (ctx.fillStyle = p.ring), ctx.fillRect(p.x - 2, p.y - 2, p.w + 4, p.h + 4);
    ctx.fillStyle = p.speech ? 'rgba(250, 248, 240, 0.94)' : 'rgba(16, 20, 26, 0.72)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    if (p.speech) {
      ctx.beginPath();
      ctx.moveTo(p.x + p.w / 2 - 5, p.y + p.h);
      ctx.lineTo(p.x + p.w / 2 + 5, p.y + p.h);
      ctx.lineTo(p.x + p.w / 2, p.y + p.h + 7);
      ctx.fill();
    }
    ctx.fillStyle = p.speech ? '#1b1d22' : '#f2efe8';
    ctx.font = FONT;
    p.lines.forEach((l, k) => ctx.fillText(l, p.x + PAD, p.y + PAD + k * LINE));
    if (!p.speech) {
      ctx.font = SMALL;
      ctx.fillStyle = '#b8c4cf';
      ctx.fillText(p.status, p.x + PAD, p.y + PAD + LINE);
    }
  }
}

/** Measures text with the context, by string, cached: the same names are measured once, not every frame. */
export function measurer(ctx: Ctx): (s: string, small?: boolean) => number {
  const cache = new Map<string, number>();
  return (s, small = false) => {
    const k = small ? `\u0000${s}` : s;
    let w = cache.get(k);
    if (w === undefined) {
      ctx.font = small ? SMALL : FONT;
      w = ctx.measureText(s).width;
      if (cache.size > 20_000) cache.clear();
      cache.set(k, w);
    }
    return w;
  };
}

export { SPEECH_W };

// Conversations for spectators (N-V21, #3678): the public lines the page already holds, folded into one thread per
// local scene as today's `dialogue-threads.ts` folds aloud talk. A line joins the live thread whose recent speakers
// include its speaker or someone within its reach when it was said; otherwise it opens a new thread. Only lines whose
// words are in the public text file are folded: a whisper or a private conversation's turn is never in the public view,
// and one listed without words is left out. A private conversation's turn shows as its public record does (#3775, today's
// sealed thread): one thread per conversation, its members named, each turn its speaker, its time and '…', never words.
// A line is keyed by its speaker, time and reference, so a part played again
// after a reconnect folds once.

/** A scene stays one thread while someone in it keeps talking within this gap (today's `ALOUD_GAP_MS`), µs. */
export const GAP_US = 240_000_000;
/** Recent lines whose speakers are "the people in this scene"; lines and threads kept, as today. */
export const SCENE_LINES = 8, THREAD_LINES = 80, THREADS = 24;
/** Talk's reach when a line gives none, mm (`sim::speech::LEAVE`). */
const TALK_MM = 5_000;

export type Line = { key: string; at: number; speaker: string; words: string };
/** `members` is set on a private conversation's thread: who is in it, from its public record (#3775). */
export type Thread = { id: string; lines: Line[]; lastAt: number; colour: string; hearers: Map<string, number>; members?: string[] };
/** What a private turn's line shows in place of its words. */
export const HIDDEN = '…';
/** Where a body was at a world time, metres; null when it is not drawn. */
export type Where = (id: string, at: number) => { x: number; y: number; z: number } | null;

const PALETTE = ['#ffd166', '#06d6a0', '#4cc9f0', '#f78c6b', '#c77dff', '#90be6d', '#f15bb5', '#ffb4a2'];
const hue = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return PALETTE[(h >>> 0) % PALETTE.length];
};

export class Conversations {
  readonly threads = new Map<string, Thread>();
  /** Bumped on every change, so the dock is rebuilt only when what it shows changed. */
  version = 0;
  private seen = new Set<string>();
  private order: string[] = [];

  /** Folds one public line; `bodies` are the Souls that could have heard it. Returns its thread, or null. */
  add(s: { speaker: string; at: number; reach: number; ref: string; words: string | null; private?: { conversation: string; members: string[] } }, where: Where, bodies: Iterable<string>): Thread | null {
    if (!s.private && (s.words === null || !s.words.trim())) return null;
    const key = `${s.speaker}|${s.at}|${s.ref}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key), this.order.push(key);
    if (this.order.length > 4000) for (const k of this.order.splice(0, 2000)) this.seen.delete(k);
    if (s.private) {
      const id = `private:${s.private.conversation}`;
      let t = this.threads.get(id);
      if (!t) (t = { id, lines: [], lastAt: s.at, colour: hue(id), hearers: new Map() }), this.threads.set(id, t), this.trim();
      t.members = [...new Set([...(t.members ?? []), ...s.private.members, s.speaker])];
      return this.put(t, { key, at: s.at, speaker: s.speaker, words: HIDDEN }, []);
    }
    const reach = (s.reach > 0 ? s.reach : TALK_MM) / 1000, from = where(s.speaker, s.at);
    const heard: string[] = [];
    if (from) for (const id of bodies) {
      const p = id === s.speaker ? null : where(id, s.at);
      if (p && Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) <= reach) heard.push(id);
    }
    const people = new Set([s.speaker, ...heard]);
    const live = [...this.threads.values()].filter((t) => !t.members && Math.abs(s.at - t.lastAt) <= GAP_US).sort((a, b) => b.lastAt - a.lastAt);
    let t = live.find((t) => t.lines.slice(-SCENE_LINES).some((l) => people.has(l.speaker)));
    if (!t) {
      const id = `${s.speaker}:${s.at}`;
      t = { id, lines: [], lastAt: s.at, colour: hue(id), hearers: new Map() };
      this.threads.set(id, t);
      this.trim();
    }
    return this.put(t, { key, at: s.at, speaker: s.speaker, words: s.words! }, heard);
  }

  /** Keeps the newest `THREADS` threads. */
  private trim(): void {
    if (this.threads.size > THREADS) for (const o of [...this.threads.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, this.threads.size - THREADS)) this.threads.delete(o.id);
  }

  /** Puts `line` in `t` in time order, and notes who heard it. */
  private put(t: Thread, line: Line, heard: string[]): Thread {
    let i = t.lines.length;
    while (i > 0 && t.lines[i - 1].at > line.at) i--;
    t.lines.splice(i, 0, line);
    if (t.lines.length > THREAD_LINES) t.lines.splice(0, t.lines.length - THREAD_LINES);
    t.lastAt = Math.max(t.lastAt, line.at);
    for (const id of heard) t.hearers.set(id, Math.max(t.hearers.get(id) ?? 0, line.at));
    this.version++;
    return t;
  }

  /** A thread's speakers, by their first line; a private conversation's members, from its public record. */
  static members(t: Thread): string[] {
    return t.members ?? [...new Set(t.lines.map((l) => l.speaker))];
  }

  /** The threads a Soul spoke in, newest first. */
  of(soul: string): Thread[] {
    return [...this.threads.values()].filter((t) => t.members?.includes(soul) || t.lines.some((l) => l.speaker === soul)).sort((a, b) => b.lastAt - a.lastAt);
  }

  /** Threads still talking at `t` (a line said at or before `t`, within `within` µs of it), newest first. */
  live(t: number, within = 60_000_000): Thread[] {
    const said = (h: Thread) => { let a = -Infinity; for (const l of h.lines) if (l.at <= t) a = l.at; return a; };
    return [...this.threads.values()].filter((h) => t - said(h) <= within).sort((a, b) => said(b) - said(a));
  }

  /** A thread's lines said by world time `t`: the page plays behind the stream's newest part, so a line is shown once
   *  the picture reaches it, as today's dock holds lines to the shown tick. */
  static by(t: Thread, at: number): Line[] {
    return t.lines.filter((l) => l.at <= at);
  }
}

/** A shot that frames a group (today's `conversationFrame`): their middle, from the side the camera is on, far enough
 *  back that the widest of them fits the view. Points in metres, at head height. */
export function groupShot(points: { x: number; y: number; z: number }[], fov: number, aspect: number, from: { x: number; y: number; z: number }) {
  if (!points.length) return null;
  const c = { x: 0, y: 0, z: 0 };
  for (const p of points) (c.x += p.x / points.length), (c.y += p.y / points.length), (c.z += p.z / points.length);
  const spread = Math.max(1, ...points.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)));
  const d = Math.max(5, (spread / (Math.tan((fov * Math.PI) / 360) * Math.min(1, aspect))) * 1.4);
  let dx = from.x - c.x, dz = from.z - c.z;
  const n = Math.hypot(dx, dz);
  if (n < 0.01) (dx = 0), (dz = 1);
  else (dx /= n), (dz /= n);
  return { eye: { x: c.x + dx * d, y: c.y + Math.max(1.5, d * 0.24), z: c.z + dz * d }, target: c };
}

// Where a line was said (#3776, today's `channelChip`): the dock's hearing label names the place, `inside · <room>` when
// the speaker stands in a named room (an ancestor with a public name and an outline), else `aloud · <place>` for the
// smallest named area beside it (a child of one of its ancestors, the open ground's places) whose outline holds the
// speaker. Read from the copy when drawn, so a renamed
// place shows its new name while the thread is open.

/** What `placeOf` reads of a node. */
export type PlaceNode = { parent: string | null; placeName?: string | null; outline?: number[][] };

/** Whether `[x, z]` mm is inside `poly` (even-odd rule). */
function holds(poly: number[][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Twice a polygon's area, mm². */
const area = (poly: number[][]) => Math.abs(poly.reduce((s, [x, z], i) => { const [x2, z2] = poly[(i + 1) % poly.length]; return s + x * z2 - x2 * z; }, 0));

/** The named place `speaker` stood in when at `p` (world m), or null when none is named. */
export function placeOf(speaker: string, p: { x: number; z: number } | null, nodes: ReadonlyMap<string, PlaceNode>, words: (n: string) => string): { name: string; inside: boolean } | null {
  const up = new Set<string>();
  for (let id = nodes.get(speaker)?.parent ?? null; id && !up.has(id); ) {
    const n = nodes.get(id);
    if (!n) break;
    if (n.placeName && n.outline?.length) return { name: words(n.placeName), inside: true };
    up.add(id), (id = n.parent);
  }
  if (!p) return null;
  const x = p.x * 1000, z = p.z * 1000;
  let best: { name: string; a: number } | null = null;
  for (const n of nodes.values()) {
    if (!n.parent || !up.has(n.parent) || !n.placeName || !n.outline || n.outline.length < 3 || !holds(n.outline, x, z)) continue;
    const a = area(n.outline);
    if (!best || a < best.a) best = { name: words(n.placeName), a };
  }
  return best && { name: best.name, inside: false };
}
