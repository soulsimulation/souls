// Stage 4 (#4178): the old owner box on a world the new engine runs. The old box reads and writes
// `/v1/edge/owner/:id/inbox`, which no v2 service serves; on a v2 world its words travel the gateway mailbox instead
// (R13/W10: the directory's `/v1/mailbox/*`, reached from a page only through the gateway's view socket). The v2 page's
// `OwnerBox` (its text frames) is reused as it is; the view-token exchange and the box-only socket follow its
// `exchange` and `MailSocket`. This file turns the box's messages into the old box's `AgentInbox`, so the old card
// draws them unchanged. Nothing here makes a Soul act, and the token stays in memory only.
import type { AgentInbox } from '../AgentMessageBox.tsx';
import { v2Stream } from './use-v2-souls.ts';

/** The v2 page's box message (v2/web/src/owner/box.ts `Message`; only the fields read here). */
export type BoxMessage = {
  words: string;
  id: string | null;
  state: 'sending' | 'waiting' | 'thinking' | 'doing' | 'done' | 'failed' | 'refused';
  act: { verb: string; phase: string; outcome: string | null } | null;
  outcome: string | null;
  reply?: string | null;
  notes?: string[];
};
type Session = { testName: string };
/** Where this world's mailbox is: the directory (an origin) and the gateway's view socket, and the session to use. */
export type MailboxPlace = { directory: string; gateway: string; session: Session };

const PHASES = new Set(['running', 'done', 'failed', 'refused', 'cut', 'paused']);
const OPEN = new Set(['thinking', 'doing']);
const WAITING = new Set(['sending', 'waiting', 'thinking', 'doing']);
const local = (u: URL) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname));
const PATH = /^\/[A-Za-z0-9._/-]*$/;

/**
 * The mailbox of this page's v2 world, or null (an old-engine world, or a v2 world whose page names no mailbox).
 * The inline config names same-origin paths (`v2Gateway`, `v2Directory`); a loopback page may name loopback ones with
 * `?gateway=` and `?directory=` (as the v2 page does). The session is the directory's local test sign-in
 * (`?as=<person>` on loopback); a signed-in session from the old page's provider is the sign-in row's (#1960 stage 4).
 */
export function mailboxPlace(href: string, cfg: { v2Stream?: unknown; v2Gateway?: unknown; v2Directory?: unknown } | undefined, stream: string | null): MailboxPlace | null {
  if (!stream) return null;
  const at = new URL(href), q = at.searchParams;
  const same = (p: unknown) => typeof p === 'string' && PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..') ? p : null;
  let gateway = same(cfg?.v2Gateway) ? new URL(cfg!.v2Gateway as string, at.href.replace(/^http/, 'ws')).href : null;
  let directory = same(cfg?.v2Directory) ? new URL(cfg!.v2Directory as string, at).origin : null;
  if (local(at)) {
    const g = q.get('gateway'), d = q.get('directory');
    if (g) { const u = new URL(g, at.href.replace(/^http/, 'ws')); if (u.protocol === 'ws:' && local(new URL(u.href.replace(/^ws:/, 'http:'))) && !u.search && !u.hash) gateway = u.href; }
    if (d) { const u = new URL(d, at); if (local(u) && !u.search && !u.hash) directory = u.origin; }
  }
  const name = local(at) ? q.get('as')?.trim() : '';
  return gateway && directory && name ? { directory, gateway, session: { testName: name } } : null;
}

/** The old box's inbox for the v2 box's messages: the newest one (refusals are thrown at send, not kept). */
export function inboxOf(messages: readonly BoxMessage[], sentAt: ReadonlyMap<BoxMessage, number>, connected: boolean): AgentInbox {
  const shown = messages.filter((m) => m.state !== 'refused');
  const m = shown.at(-1);
  if (!m) return { connected, lastSeenAt: null, latest: null, queued: 0 };
  const closed = m.state === 'done' || m.state === 'failed';
  const state = m.state === 'sending' || m.state === 'waiting' ? 'sent' : OPEN.has(m.state) ? 'delivered' : 'acknowledged';
  const doing = m.state === 'thinking' ? { phase: 'thinking' }
    : m.state === 'doing' && m.act ? { phase: PHASES.has(m.act.phase) ? m.act.phase : m.act.outcome ? 'done' : 'running', text: m.act.verb } : undefined;
  return {
    connected, lastSeenAt: null,
    latest: {
      id: m.id ?? '', text: m.words, state, ...(sentAt.has(m) ? { sentAt: sentAt.get(m)! } : {}),
      reply: m.reply ?? null,
      result: m.state === 'done' ? m.outcome ?? 'done' : m.state === 'failed' ? m.outcome ?? 'failed' : null,
      ...(closed ? { outcome: m.state as 'done' | 'failed' } : {}),
      progress: m.notes?.at(-1) ?? null,
    },
    queued: shown.filter((x) => WAITING.has(x.state)).length,
    ...(doing ? { doing } : {}),
  };
}

type Box = { messages: BoxMessage[]; onChange: () => void; put(grant: string, words: string): string | null; text(frame: string): boolean };
type Sock = { onText: ((t: string) => void) | null; sendText(t: string): boolean; start(): void; stop(): void };

/** One Soul's box on the gateway mailbox. */
export class V2OwnerMailbox {
  private readonly sentAt = new Map<BoxMessage, number>();
  private box: Box | null = null;
  private sock: Sock | null = null;
  private grant: string | null = null;
  private readonly ready: Promise<void>;
  private changed: Array<() => void> = [];

  constructor(ready: (self: V2OwnerMailbox) => Promise<void>) { this.ready = ready(this); this.ready.catch(() => {}); }

  /** Called once the view token is held: the box, its socket and the Soul's grant. */
  attach(box: Box, sock: Sock, grant: string): void {
    this.box = box; this.sock = sock; this.grant = grant;
    box.onChange = () => { for (const f of this.changed) f(); };
    sock.onText = (t) => void box.text(t);
    sock.start();
  }

  /** The box as the old card reads it; throws while the mailbox cannot be reached (the card then shows nothing). */
  async read(): Promise<AgentInbox> {
    await this.ready;
    return inboxOf(this.box!.messages, this.sentAt, true);
  }

  /** Puts `text` for the Soul's agent; resolves once the mailbox took it, throws if it was refused. */
  async send(text: string, waitMs = 5000): Promise<AgentInbox> {
    await this.ready;
    const box = this.box!, frame = box.put(this.grant!, text);
    if (!frame) throw new Error('Message is empty or too long.');
    const m = box.messages.at(-1)!;
    this.sentAt.set(m, Date.now());
    const taken = new Promise<void>((ok) => {
      const done = () => { clearTimeout(t); this.changed = this.changed.filter((g) => g !== f); ok(); };
      const f = () => { if (m.state !== 'sending') done(); };
      const t = setTimeout(done, waitMs);
      this.changed.push(f);
    });
    if (!this.sock!.sendText(frame)) box.text(JSON.stringify({ sent: { refused: 'not-connected' } }));
    await taken;
    if (m.state === 'refused') throw new Error(`Message could not be sent (${m.outcome ?? 'refused'}). Try again.`);
    if (m.state === 'sending') throw new Error('The mailbox did not answer. Try again.');
    return inboxOf(box.messages, this.sentAt, true);
  }

  stop(): void { this.sock?.stop(); }
}

/** The directory's session exchange (V13b, v2/web/src/source/socket.ts `exchange`): a short-lived view token, held in
 *  memory alone, and the grants it may watch. */
export async function viewToken(place: MailboxPlace, post: typeof fetch = fetch): Promise<{ token: string; expires: number; owned: { grant: string }[] }> {
  const res = await post(`${place.directory}/v1/account/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: place.session.testName }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  const body = await res.json() as { token?: unknown; expires?: unknown; owned?: { grant: string }[]; refused?: string };
  if (!res.ok || typeof body.token !== 'string') throw new Error(`no view: the directory said ${body.refused ?? res.status}`);
  return { token: body.token, expires: Number(body.expires), owned: body.owned ?? [] };
}

/** The gateway's protocol version the page speaks (v2/web/src/source/socket.ts `PROTOCOL`). */
const PROTOCOL = 2;
/** A box-only view socket, as v2/web/src/owner/mail-socket.ts `MailSocket` (that file's cborg resolves from v2/web,
 *  which this app does not install): hello, sign in with the view token, then only the box's text frames; the token
 *  is renewed on the open socket before it expires, and the socket comes back after a drop. */
class BoxSocket implements Sock {
  onText: ((t: string) => void) | null = null;
  private ws: WebSocket | null = null;
  private open = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token: string;
  private expires: number;
  private readonly url: string;
  private readonly renew: () => Promise<{ token: string; expires: number }>;
  constructor(url: string, g: { token: string; expires: number }, renew: () => Promise<{ token: string; expires: number }>) {
    this.url = url; this.token = g.token; this.expires = g.expires; this.renew = renew;
  }
  start(): void {
    if (this.stopped) return;
    if (Date.now() < this.expires * 1000 - 1000) return void this.connect();
    this.renew().then((g) => ((this.token = g.token), (this.expires = g.expires), this.connect()), () => (this.timer = setTimeout(() => this.start(), 1000)));
  }
  private async connect(): Promise<void> {
    const { encode, decode } = await import('cborg');
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let step = 0; // 0 hello sent, 1 sign-in sent, 2 open
    ws.onopen = () => ws.send(encode(new Map<number, unknown>([[1, PROTOCOL], [2, new Uint8Array(0)]])));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return void this.onText?.(ev.data);
      if (step === 0) return void ((step = 1), ws.send(encode(new Map([[1, this.token]]))));
      const m = decode(new Uint8Array(ev.data as ArrayBuffer), { useMaps: true }) as Map<number, unknown>;
      if (step === 1 && m.get(4) === 'view.started') { step = 2; this.open = true; this.renewLater(encode); }
    };
    ws.onclose = () => { this.open = false; this.ws = null; if (!this.stopped) this.timer = setTimeout(() => this.start(), 1000); };
    ws.onerror = () => ws.close();
  }
  private renewLater(encode: (v: unknown) => Uint8Array<ArrayBuffer>): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(1000, this.expires * 1000 - Date.now() - 30_000);
    this.timer = setTimeout(async () => {
      try {
        const g = await this.renew();
        this.token = g.token; this.expires = g.expires;
        if (this.open) this.ws?.send(encode(new Map([[1, g.token]])));
      } catch { /* kept until it expires; the socket then closes and signs in again */ }
      if (!this.stopped) this.renewLater(encode);
    }, Math.min(wait, 2 ** 31 - 1));
  }
  sendText(t: string): boolean { return this.open && this.ws?.readyState === 1 ? (this.ws.send(t), true) : false; }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }
}

const boxes = new Map<string, V2OwnerMailbox>();
/** The page's box for `soulId` on this v2 world (one per Soul a page), or null on an old-engine world. */
export function v2OwnerMailbox(soulId: string): V2OwnerMailbox | null {
  if (typeof window === 'undefined') return null;
  const stream = v2Stream();
  if (!stream) return null;
  const known = boxes.get(soulId);
  if (known) return known;
  const place = mailboxPlace(location.href, (window as unknown as { __simConfig?: Record<string, unknown> }).__simConfig, stream);
  const mb = new V2OwnerMailbox(async (self) => {
    if (!place) throw new Error('This world\'s mailbox is not reachable from this page.');
    // the v2 page's own box (its text frames), and the page's Soul ids for v2 grants, loaded only on a v2 world
    const [{ OwnerBox }, { soulIdOf }] = await Promise.all([import('../../../../v2/web/src/owner/box.ts'), import('./bridge.ts')]);
    const renew = () => viewToken(place);
    const g = await renew();
    const own = g.owned.find((o) => soulIdOf(o.grant) === soulId);
    if (!own) throw new Error('This Soul is not yours on this world.');
    self.attach(new OwnerBox(), new BoxSocket(place.gateway, g, renew), own.grant);
  });
  boxes.set(soulId, mb);
  return mb;
}
