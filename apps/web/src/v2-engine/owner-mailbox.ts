// Stage 4 (#4178): the old owner box on a world the new engine runs. The old box reads and writes
// `/v1/edge/owner/:id/inbox`, which no v2 service serves; on a v2 world its words travel the gateway mailbox instead
// (R13/W10: the directory's `/v1/mailbox/*`, reached from a page only through the gateway's view socket). Nothing
// outside v2/ imports from it (K14), so the box's text frames, the view-token exchange and the box-only socket are read
// here as the v2 page reads them (v2/web/src/owner/box.ts `OwnerBox`, source/socket.ts `exchange`, owner/mail-socket.ts
// `MailSocket`). This file turns the box's messages into the old box's `AgentInbox`, so the old card draws them
// unchanged. Nothing here makes a Soul act, and the token stays in memory only.
import { useEffect, useState } from 'react';
import type { AgentInbox } from '../AgentMessageBox.tsx';
import { session as pageSession, useSession } from '../auth-session.ts';
import { v2Stream } from './use-v2-souls.ts';
import { BASE } from '../base-path.ts';
import { worldKeyFrom } from '../snapshot-prefetch.ts';

/** One message, as the v2 page's box keeps it (v2/web/src/owner/box.ts `Message`). */
export type BoxMessage = {
  words: string;
  id: string | null;
  state: 'sending' | 'waiting' | 'thinking' | 'doing' | 'done' | 'failed' | 'refused';
  act: { verb: string; phase: string; outcome: string | null } | null;
  outcome: string | null;
  reply?: string | null;
  notes?: string[];
};
/** The directory's test sign-in by name (`?as=` on a loopback page), or the page's own sign-in (B3-2): its session is
 *  exchanged for the gateway's view token (a provider's session token as the bearer; a local `dev:<name>` as the
 *  directory's test sign-in by that name, which only a directory with the test sign-in on accepts). */
type Session = { testName: string } | { page: true };
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
 * `?gateway=` and `?directory=` (as the v2 page does). The session is the page's own sign-in, or on loopback the
 * directory's test sign-in by `?as=<person>`.
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
  return gateway && directory ? { directory, gateway, session: name ? { testName: name } : { page: true } } : null;
}

/** The card's one owner state from the gateway's `{"agent"}` frame: whether a socket is signed in for the Soul (its
 *  agent's client is connected now); null until the gateway said. */
export function linkOf(agent: boolean | null): AgentInbox['link'] {
  if (agent === null) return undefined;
  return agent ? { state: 'connected', reason: 'listening', since: null, holder: null } : { state: 'disconnected', reason: 'stopped-listening', since: null, holder: null };
}

/** The old box's inbox for the v2 box's messages: the newest one (refusals are thrown at send, not kept). `agent` is
 *  whether the Soul's agent is connected (null: not told yet), which the card's status line shows. */
export function inboxOf(messages: readonly BoxMessage[], sentAt: ReadonlyMap<BoxMessage, number>, agent: boolean | null): AgentInbox {
  const connected = agent === true, link = linkOf(agent), linked = link ? { link } : {};
  const shown = messages.filter((m) => m.state !== 'refused');
  const m = shown.at(-1);
  if (!m) return { connected, lastSeenAt: null, latest: null, queued: 0, ...linked };
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
    ...linked,
  };
}

/** The longest message (the mailbox's, bytes), the longest reply drawn and the notes kept, as the v2 page's box. */
const WORDS_MOST = 2000, REPLY_MOST = 1000, NOTES_KEPT = 5;
const clip = (s: string) => [...s].slice(0, REPLY_MOST).join('');

/**
 * The box's state, fed the gateway's text frames (gatewayd's mailbox.rs; as v2/web/src/owner/box.ts reads them):
 * page → gateway `put <grant>\n<words>`; gateway → page `{"sent": {"id"} | {"refused"}}`, `{"mail": {"id", "state":
 * "picked"}}`, `{"doing": {"seq", "verb", "phase", "outcome"}}`, `{"note": {"id", "reply"}}`, `{"close": {"id", "state",
 * "outcome", "reply"?}}`.
 */
export class MailBox {
  readonly messages: BoxMessage[] = [];
  /** Whether each grant's agent is connected, as the gateway last said (`{"agent": {"grant", "connected"}}`). */
  readonly agents = new Map<string, boolean>();
  private readonly picked = new Set<string>();
  onChange: () => void = () => {};

  /** The frame that puts `words` for `grant`; null for empty or long words. */
  put(grant: string, words: string): string | null {
    const w = words.trim();
    if (!w || new TextEncoder().encode(w).length > WORDS_MOST) return null;
    this.messages.push({ words: w, id: null, state: 'sending', act: null, outcome: null });
    this.onChange();
    return `put ${grant}\n${w}`;
  }

  /** One text frame from the gateway; false if it is not the box's. */
  text(frame: string): boolean {
    let f: Record<string, Record<string, unknown> | undefined>;
    try { f = JSON.parse(frame); } catch { return false; }
    if (!f || typeof f !== 'object') return false;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const byId = (id: unknown) => this.messages.find((m) => m.id !== null && m.id === id);
    if (f.agent) {
      const grant = str(f.agent.grant);
      if (!grant || typeof f.agent.connected !== 'boolean') return true;
      this.agents.set(grant, f.agent.connected);
    } else if (f.sent) {
      const m = this.messages.find((x) => x.state === 'sending');
      if (!m) return true;
      const id = str(f.sent.id);
      if (id) { m.id = id; m.state = this.picked.delete(id) ? 'thinking' : 'waiting'; }
      else { m.state = 'refused'; m.outcome = str(f.sent.refused) ?? 'refused'; }
    } else if (f.mail) {
      if (f.mail.state !== 'picked') return true;
      const m = byId(f.mail.id);
      if (!m) this.picked.add(String(f.mail.id)); // picked up before the put's answer came
      else if (m.state === 'waiting') m.state = 'thinking';
    } else if (f.doing) {
      // an act the agent began after it picked up a message: the newest open message's
      const m = [...this.messages].reverse().find((x) => OPEN.has(x.state));
      if (!m) return true;
      m.state = 'doing';
      m.act = { verb: str(f.doing.verb) ?? '?', phase: str(f.doing.phase) ?? '?', outcome: str(f.doing.outcome) };
    } else if (f.note) {
      const m = byId(f.note.id), note = str(f.note.reply)?.trim();
      if (!m || !note || !OPEN.has(m.state)) return true;
      m.notes = [...(m.notes ?? []), clip(note)].slice(-NOTES_KEPT);
    } else if (f.close) {
      const m = byId(f.close.id);
      if (!m) return true;
      m.state = f.close.state === 'done' ? 'done' : 'failed';
      m.outcome = str(f.close.outcome);
      const reply = str(f.close.reply)?.trim();
      if (reply) m.reply = clip(reply);
    } else return false;
    this.onChange();
    return true;
  }
}

type Box = Pick<MailBox, 'messages' | 'agents' | 'onChange' | 'put' | 'text'>;
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

  /** Whether the Soul's agent is connected now, as the gateway said; null until it did. */
  private agent(): boolean | null { return this.box!.agents.get(this.grant!) ?? null; }

  /** The box as the old card reads it; throws while the mailbox cannot be reached (the card then shows nothing). */
  async read(): Promise<AgentInbox> {
    await this.ready;
    return inboxOf(this.box!.messages, this.sentAt, this.agent());
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
    if (m.state === 'sending') {
      // failed, as the old box shows a failed send: an error and no receipt; a late answer then binds to nothing
      m.state = 'refused'; m.outcome = 'no-answer';
      throw new Error('The mailbox did not answer. Try again.');
    }
    return inboxOf(box.messages, this.sentAt, this.agent());
  }

  stop(): void { this.sock?.stop(); }
}

/** A signed-in person who owns nothing on the new engine yet (the directory's `{"owned": []}`, or an older directory's
 *  404 `nothing-owned`): a normal state, not a failure. There is no view token to hold; ask again later, quietly. */
export class NothingOwned extends Error {
  constructor() { super('no view: nothing owned'); this.name = 'NothingOwned'; }
}

/** The directory's session exchange (V13b, v2/web/src/source/socket.ts `exchange`): a short-lived view token, held in
 *  memory alone, and the grants it may watch. Throws `NothingOwned` for a signed-in person with no Soul. */
export async function viewToken(place: MailboxPlace, post: typeof fetch = fetch, signedIn: () => Promise<string | null> = () => pageSession().getToken()): Promise<{ token: string; expires: number; owned: { grant: string }[] }> {
  let name = 'testName' in place.session ? place.session.testName : null, bearer: string | null = null;
  if (!name) {
    const t = await signedIn().catch(() => null);
    if (!t) throw new Error('no view: not signed in');
    if (t.startsWith('dev:')) name = t.slice(4); else bearer = t;
  }
  const res = await post(`${place.directory}/v1/account/view-token`, { method: 'POST',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : { 'content-type': 'application/json' },
    ...(bearer ? {} : { body: JSON.stringify({ name }) }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  const body = await res.json() as { token?: unknown; expires?: unknown; owned?: { grant: string }[]; refused?: string };
  if (body.refused === 'nothing-owned' || (res.ok && typeof body.token !== 'string' && Array.isArray(body.owned) && !body.owned.length)) throw new NothingOwned();
  if (!res.ok || typeof body.token !== 'string') throw new Error(`no view: the directory said ${body.refused ?? res.status}`);
  return { token: body.token, expires: Number(body.expires), owned: body.owned ?? [] };
}

/** The gateway's protocol version the page speaks (v2/web/src/source/socket.ts `PROTOCOL`). */
const PROTOCOL = 2;
/** A box-only view socket, as v2/web/src/owner/mail-socket.ts `MailSocket` (that file's cborg resolves from v2/web,
 *  which this app does not install): hello, sign in with the view token, then only the box's text frames; the token
 *  is renewed on the open socket before it expires, and the socket comes back after a drop. */
export class BoxSocket implements Sock {
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

// Read when this module loads: the page's main takes the inline config, and deletes it, when it mounts (inline-config.ts),
// so a later read finds neither the stream nor the mailbox's paths (B3-2).
const PAGE_CONFIG = typeof window === 'undefined' ? undefined : (window as unknown as { __simConfig?: Record<string, unknown> }).__simConfig;
const PAGE_STREAM = typeof window === 'undefined' ? null : v2Stream();
/** This page's v2 stream as its inline config named it when the page loaded; null on an old-engine world. */
export const v2World = (): string | null => PAGE_STREAM;
/** The world's name as the page's inline config gives it (`worldName`), or null: what the page calls the world, never
 *  the tab's title (`<name> · Souls`). */
export const v2PageWorldName = (): string | null => (typeof PAGE_CONFIG?.worldName === 'string' && PAGE_CONFIG.worldName.trim() ? PAGE_CONFIG.worldName.trim() : null);
const WORLD_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** The page's slug (`/w/<slug>/`), as world-path.ts `worldKey` reads it; read here when asked, so this module needs no
 *  `location` when it loads. */
const pageSlug = (): string | null => (typeof location === 'undefined' ? null : worldKeyFrom(location.pathname, BASE));
/** The new engine's name for this page's world: the name a Soul's pairing request and the owner's Soul list use (the
 *  directory's `world`, the world's routes key). The launcher's inline config names it (`v2World`); without it, the
 *  page's slug, which is that key (tools/world-launcher/cutover.mjs `v2World`). Never the stream's folder: on soul.game
 *  that is the world's id (`/s/w/<id>-<id>-0/…`), not its name, and a navbar asking the directory by it listed no Souls
 *  (first day, 25 Nov). Null on an old-engine world. */
export const v2WorldName = (stream: string | null = PAGE_STREAM, cfg: { v2World?: unknown } | undefined = PAGE_CONFIG, slug: string | null = pageSlug()): string | null => {
  if (!stream) return null;
  const named = typeof cfg?.v2World === 'string' ? cfg.v2World : null;
  return named && WORLD_NAME.test(named) ? named : slug && WORLD_NAME.test(slug) ? slug : null;
};
/** R3b: where this page's view socket and directory are, as the box reaches them; null on an old-engine world. */
export const v2MailboxPlace = (): MailboxPlace | null => (PAGE_STREAM && typeof location !== 'undefined' ? mailboxPlace(location.href, PAGE_CONFIG, PAGE_STREAM) : null);

/** B3-2: the page's Soul ids the signed-in person owns on this v2 world (the view token's grants), for the old card's
 *  owner view; empty on an old-engine world, signed out, or while the directory cannot be asked. */
export function useV2OwnedSouls(): readonly string[] {
  const s = useSession();
  const [owned, setOwned] = useState<readonly string[]>([]);
  useEffect(() => {
    const place = PAGE_STREAM ? mailboxPlace(location.href, PAGE_CONFIG, PAGE_STREAM) : null;
    if (!place || (!s.authed && !('testName' in place.session))) { setOwned([]); return; }
    let live = true;
    void (async () => {
      try {
        const [{ soulIdOf }, g] = await Promise.all([import('./bridge.ts'), viewToken(place)]);
        if (live) setOwned(g.owned.map((o) => soulIdOf(o.grant)));
      } catch { if (live) setOwned([]); }
    })();
    return () => { live = false; };
  }, [s.authed, s.mode, s.label]);
  return owned;
}
/** One of the signed-in person's Souls on this world, as the navbar lists it (the directory's `/v1/account/souls`). */
export type V2AccountSoul = { id: string; name: string | null; retireAsked?: true };
/** The rows of `/v1/account/souls` for `world`: its page id and its name; other worlds' Souls are left out. */
export function accountSoulsOf(body: unknown, world: string, soulIdOf: (grant: string) => string): V2AccountSoul[] {
  const rows = (body as { souls?: unknown } | null)?.souls;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => r && typeof r === 'object' && typeof r.soul === 'string' && r.soul.startsWith('soul-') && r.world === world
    ? [{ id: soulIdOf(r.soul), name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : null, ...(r.retire_asked === true ? { retireAsked: true as const } : {}) }] : []);
}

/** A POST to this world's directory signed in as the person (the view-token exchange's sign-in: a provider session as
 *  the bearer, a local `dev:<name>` or `?as=` as the directory's test person); null when no one is signed in. */
async function accountPost(place: MailboxPlace, path: string, body: Record<string, unknown>): Promise<Response | null> {
  let name = 'testName' in place.session ? place.session.testName : null, bearer: string | null = null;
  if (!name) { const t = await pageSession().getToken().catch(() => null); if (!t) return null; if (t.startsWith('dev:')) name = t.slice(4); else bearer = t; }
  return fetch(`${place.directory}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(name ? { ...body, test_person: name } : body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
}

/** The signed-in POST `byDirectory` sends: its status and JSON body (null when no one is signed in). */
export type AccountCall = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown } | null>;
/** What the owner's Soul card does through the directory on a world the new engine runs (route.rs, signed in):
 *  `retire` it for good (`confirm: true`), `revoke` its agent (Disconnect) or `keep` it (clears its agent's ask). */
export type DirectoryAct = 'retire' | 'revoke' | 'keep';
/** 0.137: does `act` for the person's Soul `soulId` (the page's id) on a world the new engine runs. The old routes
 *  (`DELETE /v1/souls/:id`, `/v1/souls/:id/revoke`) are the old process's, which a moved world answers 409
 *  `world.new-engine`: the directory does it instead (`/v1/account/souls/<act>`). A retire takes its token from the
 *  gateway and tells the world, whose body leaves by K10's one path (worldd directory.rs); a revoke takes only its
 *  token; a keep clears its agent's ask, so the agent's `retire wait` hears the owner kept it. Its grant is found in
 *  the person's own list; a Soul not on it is left alone. */
export async function byDirectory(act: DirectoryAct, soulId: string, call: AccountCall, soulIdOf: (grant: string) => string): Promise<boolean> {
  const listed = await call('/v1/account/souls', {});
  const rows = (listed?.body as { souls?: unknown } | null)?.souls;
  const grant = Array.isArray(rows) ? rows.find((r) => r && typeof r.soul === 'string' && soulIdOf(r.soul) === soulId)?.soul as string | undefined : undefined;
  if (listed?.status !== 200 || !grant) return false;
  const done = await call(`/v1/account/souls/${act}`, act === 'retire' ? { soul: grant, confirm: true } : { soul: grant });
  return done?.status === 200 && (done.body as { ok?: unknown } | null)?.ok === true;
}
export const retireByDirectory = (soulId: string, call: AccountCall, soulIdOf: (grant: string) => string) => byDirectory('retire', soulId, call, soulIdOf);
/** `byDirectory(act)` from this page, or null on an old-engine world. Each tells the navbar's list to ask again. */
export function v2Act(act: DirectoryAct): ((soulId: string) => Promise<boolean>) | null {
  const place = typeof window !== 'undefined' && PAGE_STREAM ? mailboxPlace(location.href, PAGE_CONFIG, PAGE_STREAM) : null;
  if (!place) return null;
  return async (soulId) => {
    const { soulIdOf } = await import('./bridge.ts');
    const call: AccountCall = async (path, body) => { const r = await accountPost(place, path, body); return r ? { status: r.status, body: await r.json().catch(() => null) } : null; };
    const ok = await byDirectory(act, soulId, call, soulIdOf);
    if (ok) window.dispatchEvent(new Event(OWNED_CHANGED_EVENT));
    return ok;
  };
}
export const v2Retire = () => v2Act('retire');

/** First day (25 Nov): the signed-in person's Souls on this v2 world, named, whether or not their body is here yet (the
 *  navbar's "your Souls"); asked again when this page approves one. Empty on an old-engine world or signed out. */
export function useV2AccountSouls(world: string | null = v2WorldName()): readonly V2AccountSoul[] {
  const s = useSession();
  const [souls, setSouls] = useState<readonly V2AccountSoul[]>([]);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const again = () => setAsked((n) => n + 1);
    window.addEventListener(OWNED_CHANGED_EVENT, again);
    return () => window.removeEventListener(OWNED_CHANGED_EVENT, again);
  }, []);
  useEffect(() => {
    const place = PAGE_STREAM ? mailboxPlace(location.href, PAGE_CONFIG, PAGE_STREAM) : null;
    if (!place || !world || (!s.authed && !('testName' in place.session))) { setSouls([]); return; }
    let live = true;
    void (async () => {
      try {
        const [{ soulIdOf }, res] = await Promise.all([import('./bridge.ts'), accountPost(place, '/v1/account/souls', {})]);
        if (!res) return;
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (live && body) setSouls(accountSoulsOf(body, world, soulIdOf));
      } catch { /* the directory is unreachable now: keep the last list */ }
    })();
    return () => { live = false; };
  }, [s.authed, s.mode, s.label, asked, world]);
  return souls;
}
/** Said on the window when this page approved a Soul: the owned list is asked again (useV2OwnedSouls). */
export const OWNED_CHANGED_EVENT = 'sim:v2-owned-changed';

const boxes = new Map<string, V2OwnerMailbox>();
/** The page's box for `soulId` on this v2 world (one per Soul a page), or null on an old-engine world. */
export function v2OwnerMailbox(soulId: string): V2OwnerMailbox | null {
  if (typeof window === 'undefined') return null;
  const stream = PAGE_STREAM;
  if (!stream) return null;
  const key = `${soulId} ${pageSession().label ?? ''}`, known = boxes.get(key); // a new sign-in, a new exchange
  if (known) return known;
  const place = mailboxPlace(location.href, PAGE_CONFIG, stream);
  const mb = new V2OwnerMailbox(async (self) => {
    if (!place) throw new Error('This world\'s mailbox is not reachable from this page.');
    // the page's Soul ids for v2 grants, loaded only on a v2 world
    const { soulIdOf } = await import('./bridge.ts');
    const renew = () => viewToken(place);
    const g = await renew();
    const own = g.owned.find((o) => soulIdOf(o.grant) === soulId);
    if (!own) throw new Error('This Soul is not yours on this world.');
    self.attach(new MailBox(), new BoxSocket(place.gateway, g, renew), own.grant);
  });
  boxes.set(key, mb);
  return mb;
}
