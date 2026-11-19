// A direct view for a signed-in owner or creator (Engine v2 V13, #2745): R4's items over the gateway's socket
// (#3292's subscribe frame), near live, beside V1's files. The files still give the world's structure and its time;
// the socket gives the motion samples of the bodies in the subscription's interest set as each tick commits, through
// the same apply (`WorldView.apply`) and the same drawing. `NearClock` (`near.ts`) draws about 150 ms behind them.
//
// This socket is the one exception to "viewers are served as files": a private view (the principal's own audience's
// entries, which the world's hub adds to the public ones, T8) travels over it alone, is held in memory alone, and is
// never written to a file, a cache or storage. It is not a relay for viewers. The token is never logged or shown.
//
// Frames (gatewayd's `views.rs`, after T10's first frame and the sign-in `{1: token}`):
// - page → gateway: `{30: {1: [{2: body}], 2: level, 3: budget}}`, follow `body`'s room at `level`, `budget` bytes a
//   world second.
// - gateway → page: `{31: item}`, R4's item as its bytes; `{32: name}` when the world refused the subscription;
//   `{4: name}` the sign-in's outcome.
import { decode, encode } from 'cborg';
import { NearClock } from './near.ts';
import type { SampleRec, Source, SourceEvents } from './source.ts';

/** A frame's keys (`gatewayd::views`). */
export const SUBSCRIBE = 30, ITEM = 31, REFUSED = 32;
/** R4's item kinds (`worldd::views::subscription::Kind`) the page reads. */
export const ENTRY = 1, GRANT = 5;
/** T7's levels by number. */
export const LEVELS = ['', 'full', 'sampled', 'outline', 'counts'];
/** T10's protocol. */
const PROTOCOL = 1;
/** After a drop, the socket is tried again after this long. */
const RETRY_MS = 1000;

type IdValue = [Uint8Array, number | bigint];
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** An id as the page keys it, `<scope hex>.<n>` (as the stream's worker does). */
export const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
/** A key back to T3's id value. */
export function idValue(k: string): IdValue {
  const [h, n] = k.split('.');
  return [Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)), Number(n)];
}

/** What the page reads from one entry: its world time, its audience (null: everyone) and its motion samples. */
export type EntryRec = { at: number; audience: string | null; samples: SampleRec[] };
/** A grant: the level given, and the level asked for and why when the server lowered it. */
export type GrantRec = { level: string; asked: string | null; reason: string | null };
export type Item = { t: 'entry'; e: EntryRec } | { t: 'grant'; g: GrantRec } | { t: 'other'; kind: number };

/** Reads one of R4's items. An entry's motion changes (T6 change 7, a hand-off) become the page's samples. */
export function readItem(bytes: Uint8Array): Item {
  const m = decode(bytes, { useMaps: true }) as Map<number, unknown>;
  const kind = num(m.get(1));
  if (kind === GRANT) {
    const g = m.get(2) as Map<number, unknown>;
    return { t: 'grant', g: { level: LEVELS[num(g.get(1))], asked: g.has(2) ? LEVELS[num(g.get(2))] : null, reason: (g.get(3) as string) ?? null } };
  }
  if (kind !== ENTRY) return { t: 'other', kind };
  const e = m.get(2) as Map<number, unknown>;
  const aud = e.get(5) as Map<number, unknown>;
  const samples: SampleRec[] = [];
  for (const c of (e.get(7) as Map<number, unknown>[] | undefined) ?? []) {
    if (num(c.get(1)) !== 7) continue;
    const h = c.get(2) as Map<number, unknown>;
    const pose = h.get(5) as Map<number, unknown>;
    const frame = pose.get(1) as unknown[];
    const p = (pose.get(2) as unknown[]).map(num);
    samples.push([key(h.get(1) as IdValue), key(frame[0] as IdValue), frame.length > 1 ? num(frame[1]) : null, num(h.get(2)), p[0], p[1], p[2]]);
  }
  return { t: 'entry', e: { at: num(e.get(2)), audience: num(aud.get(1)) === 2 ? key(aud.get(2) as IdValue) : null, samples } };
}

/** The page's frames to the gateway. */
export const frames = {
  hello: () => encode(new Map<number, unknown>([[1, PROTOCOL], [2, new Uint8Array(0)]])),
  signIn: (token: string) => encode(new Map<number, unknown>([[1, token]])),
  subscribe: (follow: string, level: number, budget: number) =>
    encode(new Map<number, unknown>([[SUBSCRIBE, new Map<number, unknown>([[1, [new Map([[2, idValue(follow)]])]], [2, level], [3, budget]])]])),
};

export type SocketOptions = {
  /** The gateway's socket, `ws(s)://…/v2/ws`. */
  url: string;
  token: string;
  /** The body whose room is followed (its key). */
  follow: string;
  level?: number;
  /** Bytes a world second. */
  budget?: number;
  /** Wall time, ms (a test's own). */
  now?: () => number;
  WebSocket?: typeof WebSocket;
};

/**
 * The socket as a `Source`: each entry's samples as a part with no nodes. Not a stream of numbered parts: `number` is
 * -1 and `from`/`to` are the entry's world time. On a drop it tries again every second; meanwhile the page draws from
 * the files (`NearClock` slows to them).
 */
export class SocketSource implements Source {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly o: Required<SocketOptions>;
  /** Up: signed in and subscribed. */
  up = false;
  /** The newest entry's world time, and the wall time (ms) it arrived. */
  newest: { at: number; wallMs: number } | null = null;
  grant: GrantRec | null = null;
  refused: string | null = null;
  /** Bytes received over the socket, every frame. */
  bytes = 0;
  /** Entries received by audience (`public`, or the audience id's key): what reached the page. */
  readonly seen = new Map<string, number>();

  constructor(o: SocketOptions) {
    this.o = { level: 1, budget: 16_000, now: () => Date.now(), WebSocket: globalThis.WebSocket, ...o };
  }

  /** The world time now as the socket tells it: the newest entry's, moved on by the wall time since; null when down. */
  liveNow(): number | null {
    return this.up && this.newest ? this.newest.at + (this.o.now() - this.newest.wallMs) * 1000 : null;
  }

  /** The page's clock with this socket: V5's `PlaybackClock.step`'s arguments, near live while the socket is up. */
  readonly clock = new NearClock();
  step(dtMs: number, worldNow: number, newestTo: number | null): number | null {
    return this.clock.step(dtMs, this.liveNow(), worldNow, newestTo);
  }

  start(on: SourceEvents): void {
    this.stopped = false;
    const ws = new this.o.WebSocket(this.o.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let step = 0; // 0 hello sent, 1 sign-in sent, 2 subscribed
    ws.onopen = () => ws.send(frames.hello());
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      this.bytes += b.byteLength;
      if (step === 0) return void ((step = 1), ws.send(frames.signIn(this.o.token)));
      const m = decode(b, { useMaps: true }) as Map<number, unknown>;
      if (step === 1) {
        const outcome = m.get(4) as string | undefined;
        if (outcome === 'token.refused') return void on.error('the gateway refused the sign-in');
        step = 2;
        ws.send(frames.subscribe(this.o.follow, this.o.level, this.o.budget));
        return;
      }
      if (m.has(REFUSED)) return void ((this.refused = String(m.get(REFUSED))), on.error(`the world refused the view: ${this.refused}`));
      const bytes = m.get(ITEM);
      if (!(bytes instanceof Uint8Array)) return; // the stream's own frames (answers): not the view's
      const item = readItem(bytes);
      if (item.t === 'grant') this.grant = item.g;
      if (item.t !== 'entry') return;
      this.up = true;
      const aud = item.e.audience ?? 'public';
      this.seen.set(aud, (this.seen.get(aud) ?? 0) + 1);
      const at = item.e.at;
      if (!this.newest || at >= this.newest.at) this.newest = { at, wallMs: this.o.now() };
      if (item.e.samples.length) on.part({ number: -1, from: at, to: at, nodes: [], removed: [], samples: item.e.samples, hash: null });
    };
    ws.onclose = () => {
      this.up = false;
      this.ws = null;
      if (!this.stopped) this.retry = setTimeout(() => this.start(on), RETRY_MS);
    };
    ws.onerror = () => ws.close();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    this.up = false;
  }
}
