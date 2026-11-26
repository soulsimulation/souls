// 0.133 G1: the old god panel on a world the new engine runs. The panel's undo, redo and weather are the creator's own
// edits on the gateway's creator socket, signed in with a token the session exchange gives for the page's sign-in
// (gatewayd `creator.rs`, `POST /v2/creator-token`); its command box goes to the creator's agent through the gateway
// mailbox (as the owner's box does for a Soul, owner-mailbox.ts), so the agent's `listen` prints it. 0.133 item 6: the
// panel's Build places, moves and removes a thing with the same verb's batch (place, move and remove, as the creator
// client's `souls-god place|move|remove` send them; god-ui/BuildBar.tsx). Nothing outside v2/ imports from it (K14), so
// the session and the edit's bytes follow v2/web/src/panel/session.ts and edit.ts (T10's intent, `souls:edit`) rather
// than importing them.
// The token stays in memory only.
import { MailBox, BoxSocket, NothingOwned, V2OwnerMailbox, v2MailboxPlace, v2World, viewToken, type MailboxPlace } from './owner-mailbox.ts';
import { session as pageSession } from '../auth-session.ts';
import type { AgentInbox } from '../AgentMessageBox.tsx';

/** An id as T3 writes it: `[scope, counter]`. */
export type IdValue = [Uint8Array, number];
/** A version: lineage, zone, epoch, sequence (T3). */
export type Version = [Uint8Array, IdValue, number, number];
/** A point in a parent's frame, µm (T4). */
export type Spot = { x: number; y: number; z: number };
/** A turn `[w, x, y, z]`, each scaled by 2^30, as the stream's nodes carry it. */
export type Turn = [number, number, number, number];
/** One operation of a build batch (`replica::edit::wire`): a place names its new thing by a number of the batch until the
 *  receipt maps it; a move keeps the thing's facing and slot when given them. */
export type Op =
  | { op: 'place'; name: number; kind: string; parent: string; at: Spot }
  | { op: 'move'; node: string; at: Spot; rot?: Turn; slot?: number | null }
  | { op: 'remove'; node: string };
/** What an edit asks: a batch of sets (weather), a build batch, or an undo or a redo of the newest edit (G4). */
export type Asked = { undo: 'undo' | 'redo' } | { sets: { node: string; field: number; value: string | number }[] } | { ops: Op[] };
/** An answer, as the panel reads it: a receipt maps a place's batch name to its new id (`<scope hex>.<counter>`). */
export type Frame =
  | { t: 'outcome'; name: string }
  | { t: 'receipt'; sequence: number; version: Version | null; names: Map<number, string> }
  | { t: 'refused'; sequence: number; version: Version | null; reason: string }
  | { t: 'other' };
type Cbor = { encode(v: unknown): Uint8Array; decode(b: Uint8Array, o: { useMaps: true }): unknown };

export const VERB = 'souls:edit';
/** Refusals an edit is sent again once for: planned against a version since changed, or numbered under a sequence the
 *  creator's agent has out at that moment (gatewayd `SEQUENCE_IN_USE`, #5006). */
const AGAIN = new Set(['edit.stale', 'intent.seq-in-use']);
/** The gateway's protocol version (v2/web/src/source/socket.ts `PROTOCOL`). */
const PROTOCOL = 2;
const EXPIRY = 9223372036854775807n;
/** G4's undo parameter (`replica::edit::wire`): `{5: 1}` undoes the newest edit, `{5: 2}` redoes. */
const UNDO = 5;
export const ZERO: Version = [new Uint8Array(16), [new Uint8Array(16), 0], 0, 0];

const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
/** An id from the page's text, `<scope hex>.<counter>` (the stream's) or `<scope hex>-<counter>` (a grant's). */
export function idOf(text: string): IdValue {
  const m = /^([0-9a-f]{32})[.-](\d+)$/.exec(text);
  if (!m) throw new Error(`not an id: ${text}`);
  return [bytes(m[1]!), Number(m[2])];
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const num = (v: unknown) => Number(v as number | bigint);
const sequenceOf = (v: Version | null) => (v ? num(v[3]) : 0);

const IDENTITY: Turn = [1 << 30, 0, 0, 0];
/** A whole number, never -0 (cborg writes -0 as a float, which T0's integers are not). */
const whole = (v: number) => Math.round(v) || 0;
/** A spot `{1: position, 2: orientation, 3: support, 4: slot}`: held by its slot when it has one, else on nothing (as a
 *  place `--at` and a move `--at` are). */
function spotValue(s: Spot, rot: Turn = IDENTITY, slot: number | null = null): Map<number, unknown> {
  const m = new Map<number, unknown>([[1, [s.x, s.y, s.z].map(whole)], [2, rot.map(whole)], [3, new Map([[1, slot === null ? 0 : 2]])]]);
  if (slot !== null) m.set(4, slot);
  return m;
}

/** One build operation's value (`replica::edit::wire`): place `{1: 1, 2: name, 3: kind, 4: kind's hash, 5: parent, 6:
 *  spot}`, move `{1: 2, 2: node, 3: spot}`, remove `{1: 4, 2: node}`. */
export function opValue(o: Op): Map<number, unknown> {
  if (o.op === 'remove') return new Map<number, unknown>([[1, 4], [2, idOf(o.node)]]);
  if (o.op === 'move') return new Map<number, unknown>([[1, 2], [2, idOf(o.node)], [3, spotValue(o.at, o.rot, o.slot ?? null)]]);
  const [plain, h] = o.kind.split('@');
  const m = new Map<number, unknown>([[1, 1], [2, o.name], [3, plain]]);
  if (h) m.set(4, bytes(h));
  m.set(5, idOf(o.parent));
  m.set(6, spotValue(o.at));
  return m;
}

/** The edit intent's value (v2/web/src/panel/edit.ts `editIntent`): by the creator, its sequence, planned against `basis`. */
export function intentOf(creator: IdValue, sequence: number, basis: Version, asked: Asked): Map<number, unknown> {
  const params = 'undo' in asked
    ? new Map<number, unknown>([[UNDO, asked.undo === 'undo' ? 1 : 2]])
    : 'ops' in asked ? new Map<number, unknown>([[1, asked.ops.map(opValue)]])
    : new Map<number, unknown>([[1, asked.sets.map((s) => new Map<number, unknown>([[1, 3], [2, idOf(s.node)], [3, s.field], [4, s.value]]))]]);
  return new Map<number, unknown>([[1, new Map<number, unknown>([[1, 2], [2, creator]])], [2, VERB], [4, params], [5, sequence], [6, basis], [7, EXPIRY]]);
}

/** One binary frame from the gateway: the sign-in's outcome `{4: name}`, or an answer `{1: version, 2: answer}`. */
export function readFrame(v: unknown): Frame {
  if (!(v instanceof Map)) return { t: 'other' };
  if (typeof v.get(4) === 'string') return { t: 'outcome', name: v.get(4) };
  const a = v.get(2);
  if (!(a instanceof Map)) return { t: 'other' };
  const version = Array.isArray(v.get(1)) ? (v.get(1) as Version) : null, sequence = num(a.get(2)), kind = num(a.get(3));
  if (kind === 1) {
    const names = new Map<number, string>();
    if (a.get(6) instanceof Map) for (const [n, id] of a.get(6) as Map<unknown, IdValue>) if (Array.isArray(id)) names.set(num(n), `${hex(id[0])}.${num(id[1])}`);
    return { t: 'receipt', sequence, version, names };
  }
  if (kind === 2 || kind === 5) return { t: 'refused', sequence, version, reason: String(a.get(4)) };
  return { t: 'other' };
}

/** E6's weather on the world node (`replica::sky`; v2/client/src/creator/world.mjs `weatherOps`): kind, cloud, rain and
 *  wind 0 to 100, and its end. The panel's Rain and Haze are rain and fog, for an hour of world time. */
const SKY = { WEATHER_UNTIL: 65, WEATHER: 75, CLOUD: 76, RAIN: 77, WIND: 78 };
const KINDS = { rain: [90, 60, 30], fog: [60, 0, 5] } as const;
export function weatherSets(world: string, kind: keyof typeof KINDS, now: number, minutes = 60): Asked {
  const [cloud, rain, wind] = KINDS[kind];
  return { sets: [{ node: world, field: SKY.WEATHER, value: `souls:${kind}` }, { node: world, field: SKY.CLOUD, value: cloud },
    { node: world, field: SKY.RAIN, value: rain }, { node: world, field: SKY.WIND, value: wind },
    { node: world, field: SKY.WEATHER_UNTIL, value: now + Math.round(minutes * 60_000_000) }] };
}

/** What the session needs of a socket: a browser WebSocket in the page, a stand-in in tests. */
export type Sock = { send(b: Uint8Array): void };

/** The creator's socket (v2/web/src/panel/session.ts `CreatorSession`): T10's first frame each way, the sign-in by
 *  message, its outcome, then edits in and answers out. A stale edit (`edit.stale`: planned against a version older than
 *  a node it sets) is sent again once, against the version the refusal carried. Each edit is numbered by `clock` (the
 *  page's: µs), never below the last: the world keeps one sequence per creator, and the creator's agent numbers its
 *  edits by the clock too (v2/client daemon `editOnce`), so neither locks the other out (`intent.stale-seq`). The
 *  gateway keeps this socket beside the agent's and answers each on its own (gatewayd `shared`, #5006); a sequence the
 *  agent's socket has out at that moment (`intent.seq-in-use`) is sent again once, under the next. */
export class CreatorSession {
  latest: Version = ZERO;
  state: 'hello' | 'signing-in' | 'open' | 'refused' = 'hello';
  outcome = '';
  onOpen: () => void = () => {};
  private next: number;
  private readonly waiting = new Map<number, { asked: Asked; again: boolean; done: (f: Frame) => void }>();
  private readonly sock: Sock;
  private readonly cbor: Cbor;
  private readonly creator: IdValue;
  private readonly token: string;
  private readonly clock: () => number;
  constructor(sock: Sock, cbor: Cbor, creator: IdValue, token: string, first: number, clock: () => number = () => 0) {
    this.sock = sock; this.cbor = cbor; this.creator = creator; this.token = token; this.clock = clock;
    this.next = first;
    sock.send(cbor.encode(new Map<number, unknown>([[1, PROTOCOL], [2, new Uint8Array(0)]])));
  }

  frame(b: Uint8Array): void {
    if (this.state === 'hello') {
      this.state = 'signing-in';
      this.sock.send(this.cbor.encode(new Map([[1, this.token]])));
      return;
    }
    let v: unknown;
    try { v = this.cbor.decode(b, { useMaps: true }); } catch { return; }
    const f = readFrame(v);
    if (f.t === 'outcome') {
      this.outcome = f.name;
      this.state = f.name.startsWith('stream.') ? 'open' : 'refused';
      if (this.state === 'open') this.onOpen();
      return;
    }
    if (f.t !== 'receipt' && f.t !== 'refused') return;
    if (sequenceOf(f.version) > sequenceOf(this.latest)) this.latest = f.version!;
    const w = this.waiting.get(f.sequence);
    if (!w) return;
    this.waiting.delete(f.sequence);
    if (f.t === 'refused' && AGAIN.has(f.reason) && w.again) return void this.send(w.asked, false, w.done);
    w.done(f);
  }

  /** Sends one edit; its answer, when the world gives it. */
  edit(asked: Asked): Promise<Frame> {
    if (this.state !== 'open') return Promise.reject(new Error('the creator is not signed in'));
    return new Promise((done) => this.send(asked, true, done));
  }

  /** The socket closed: every edit still waiting is answered `creator.closed`, so no press waits for ever (the edit may
   *  still have been made: its answer is the world's, kept for a resume this page does not make). */
  closed(): void {
    for (const [sequence, w] of this.waiting) w.done({ t: 'refused', sequence, version: null, reason: CLOSED });
    this.waiting.clear();
  }

  private send(asked: Asked, again: boolean, done: (f: Frame) => void): void {
    const sequence = Math.max(this.next, Math.floor(this.clock()));
    this.next = sequence + 1;
    this.waiting.set(sequence, { asked, again, done });
    this.sock.send(this.cbor.encode(intentOf(this.creator, sequence, this.latest, asked)));
  }
}

/** The page's session as the exchange takes it: the directory's test sign-in by name (`?as=`, a local `dev:<name>`) as
 *  `test:<name>`, else the provider's token. */
async function sessionOf(place: MailboxPlace): Promise<string> {
  if ('testName' in place.session) return `test:${place.session.testName}`;
  const t = await pageSession().getToken().catch(() => null);
  if (!t) throw new Error('Sign in first.');
  return t.startsWith('dev:') ? `test:${t.slice(4)}` : t;
}

/** The session exchange (`POST /v2/creator-token` beside the gateway's socket): the creator's token and grant, or the
 *  refusal by name (`not-the-creator`, `session-refused`). */
export async function creatorToken(place: MailboxPlace, post: typeof fetch = fetch, session = sessionOf): Promise<{ token: string; grant: string }> {
  // beside the socket: `/w/<world>/v2/ws` → `/w/<world>/v2/creator-token` (the front door's route), `/v2/ws` → `/v2/creator-token`
  const url = new URL('creator-token', place.gateway.replace(/^ws/, 'http'));
  const res = await post(url.href, { method: 'POST', headers: { authorization: `Bearer ${await session(place)}` }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  const body = await res.json().catch(() => ({})) as { token?: string; grant?: string; refused?: string };
  if (!res.ok || !body.token || !body.grant) throw new Error(body.refused ?? `the gateway said ${res.status}`);
  return { token: body.token, grant: body.grant };
}

// The inline config as owner-mailbox.ts read it when the page loaded: this module loads later (the panel imports it on
// demand), after the page's main has deleted the inline config, so a read here found none and named no gateway.
const placeNow = (stream: string) => (stream === v2World() ? v2MailboxPlace() : null);

/** The world as the page's stream reader has it (use-v2-souls.ts `__soulsV2`): its own node and its time now. */
const worldNow = () => (window as unknown as { __soulsV2?: { world?: string | null; newestTo?: number | null } }).__soulsV2 ?? null;

/** Whether the exchange is worth asking: the directory's view token lists a creator grant for this account. A person
 *  with none (a visitor, an owner of Souls only) is not asked for, so a world with no creator (Eden: the gateway's
 *  `no-creator`, a 404) logs nothing on a normal visit (first day, 25 Nov). A view the directory cannot give now leaves it
 *  to the exchange, as before. */
export async function mayCreate(place: MailboxPlace, view: (p: MailboxPlace) => Promise<{ owned: readonly { grant: string }[] }> = viewToken): Promise<boolean> {
  try { return creatorGrant((await view(place)).owned) !== null; } catch (e) { return !(e instanceof NothingOwned); }
}

/** The panel's creator on a v2 world: the exchange, the socket and the creator's mailbox. One a page and sign-in. */
export class V2Creator {
  private session: Promise<CreatorSession> | null = null;
  private box: V2OwnerMailbox | null = null;
  private readonly stream: string;
  constructor(stream: string) { this.stream = stream; }

  /** Whether the signed-in person is this world's creator (the exchange answers) and its creator grant, the one its
   *  agent pairs with (`souls-god.mjs pair <world> --creator <grant>`), or the refusal's name. */
  who(): Promise<{ creator: true; grant: string } | { creator: false; refused: string }> {
    this.whoAsked ??= (async () => {
      const place = placeNow(this.stream);
      if (!place) return { creator: false as const, refused: 'no-gateway' };
      if (!(await mayCreate(place))) return { creator: false as const, refused: 'not-the-creator' };
      try { return { creator: true as const, grant: (await creatorToken(place)).grant }; } catch (e) { return { creator: false as const, refused: (e as Error).message }; }
    })();
    return this.whoAsked;
  }
  private whoAsked: Promise<{ creator: true; grant: string } | { creator: false; refused: string }> | null = null;

  private open(): Promise<CreatorSession> {
    this.session ??= (async () => {
      const place = placeNow(this.stream);
      if (!place) throw new Error('This world\'s gateway is not reachable from this page.');
      const [{ token, grant }, cborg] = await Promise.all([creatorToken(place), import('cborg')]);
      const ws = new WebSocket(place.gateway);
      ws.binaryType = 'arraybuffer';
      return await new Promise<CreatorSession>((ok, fail) => {
        ws.onopen = () => {
          const s = new CreatorSession({ send: (b) => ws.send(b as Uint8Array<ArrayBuffer>) }, cborg as unknown as Cbor, idOf(grant.replace(/^creator-/, '')), token, Date.now() * 1000, () => Date.now() * 1000);
          s.onOpen = () => ok(s);
          ws.onmessage = (e) => { if (typeof e.data !== 'string') s.frame(new Uint8Array(e.data as ArrayBuffer)); };
          ws.onclose = () => { this.session = null; s.closed(); if (s.state !== 'open') fail(new Error(s.outcome || 'the creator socket closed')); };
        };
        ws.onerror = () => fail(new Error('the creator socket could not open'));
      });
    })();
    this.session.catch(() => { this.session = null; });
    return this.session;
  }

  /** One edit; the words the panel's note shows: what was done, or the refusal by name (and what it means, for one of
   *  build safety's). */
  async edit(asked: Asked, done: string): Promise<string> {
    return (await this.answer(asked, done)).said;
  }

  /** One edit and its receipt's names (a place's new id), or the refusal as `edit` throws it. */
  async answer(asked: Asked, done: string): Promise<{ said: string; names: Map<number, string> }> {
    const f = await (await this.open()).edit(asked);
    if (f.t === 'receipt') return { said: done, names: f.names };
    throw new Error(f.t === 'refused' ? refusalText(f.reason) : 'The world did not answer.');
  }

  undo(which: 'undo' | 'redo'): Promise<string> { return this.edit({ undo: which }, which === 'undo' ? 'Undid the newest edit.' : 'Redid the newest undone edit.'); }

  weather(kind: 'rain' | 'fog'): Promise<string> {
    const w = worldNow();
    if (!w?.world || typeof w.newestTo !== 'number') return Promise.reject(new Error('The world\'s sky is not loaded yet.'));
    return this.edit(weatherSets(w.world, kind, w.newestTo), kind === 'rain' ? 'Rain.' : 'Haze.');
  }

  /** The old command box's inbox (god-store.ts `GodInbox`) from the creator's mailbox: `text` sent first when given.
   *  Connected while the gateway says a socket is signed in for the creator's grant (#5006 rows 2 and 5: it said
   *  connected always, so the panel never showed the line to give the agent); listening then, away otherwise. */
  async inbox(text?: string): Promise<{ v2: true; connected: boolean; presence: 'listening' | 'away'; lastSeenAt: null; latest: NonNullable<ReturnType<typeof ticketOf>> | null; log: NonNullable<ReturnType<typeof ticketOf>>[]; queued: number }> {
    const box = this.mailbox(), a = text === undefined ? await box.read() : await box.send(text), t = ticketOf(a);
    return { v2: true, connected: a.connected, presence: a.connected ? 'listening' : 'away', lastSeenAt: null, latest: t, log: t ? [t] : [], queued: a.queued ?? 0 };
  }

  /** The creator's mailbox: the command box's words to the creator's agent (its `listen` prints them). */
  mailbox(): V2OwnerMailbox {
    this.box ??= new V2OwnerMailbox(async (self) => {
      const place = placeNow(this.stream);
      if (!place) throw new Error('This world\'s mailbox is not reachable from this page.');
      const renew = () => viewToken(place);
      const g = await renew();
      const own = creatorGrant(g.owned);
      if (!own) throw new Error('You are not this world\'s creator.');
      self.attach(new MailBox(), new BoxSocket(place.gateway, g, renew), own);
    });
    return this.box;
  }
}

/** Build safety's refusals (AGENTS.md BUILDSAFE) and the plain words the panel shows beside the name (souls-god.mjs). */
export const BUILDSAFE: Record<string, string> = {
  'edit.would-bury': 'a Soul stands there now: wait until it has moved, or choose another place',
  'edit.would-cut-off': 'that would shut a Soul in: leave it a way out, or wait until it has moved',
  'edit.in-use': 'a Soul is using that thing: wait until it is done',
};
/** What a press answered when the creator's socket closed before the world answered it (`CreatorSession.closed`). */
export const CLOSED = 'creator.closed';
export const refusalText = (reason: string) => reason === CLOSED
  ? 'The world\'s answer did not reach this page (its connection closed): look at the world before you press again.'
  : `Refused: ${reason}${BUILDSAFE[reason] ? ` (${BUILDSAFE[reason]})` : ''}`;

/** The creator's grant among a view token's grants (directoryd `view.rs`: `creator-<scope hex>-<counter>`): the box the
 *  creator's agent reads (gatewayd `mailbox.rs`: a Soul's, or a world's creator's). */
export const creatorGrant = (owned: readonly { grant: string }[]): string | null => owned.find((o) => /^creator-[0-9a-f]{32}-\d+$/.test(o.grant))?.grant ?? null;

/** The old command log's ticket for the box's newest message (god-store.ts `Ticket`). */
export function ticketOf(inbox: AgentInbox): { id: string; text: string; state: 'sent' | 'delivered' | 'acknowledged'; sentAt: number; reply?: string; outcome?: 'done' | 'failed' | 'withdrawn' } | null {
  const m = inbox.latest;
  if (!m) return null;
  return { id: m.id || 'sending', text: m.text, state: m.state, sentAt: m.sentAt ?? Date.now(), ...(m.reply ? { reply: m.reply } : {}), ...(m.outcome ? { outcome: m.outcome } : {}) };
}
