// 0.133 R3b: a private turn's words, for the members of its conversation alone. The public stream says who spoke, when
// and among whom (`souls:said-privately`, take-talk.ts), never the words. The world keeps them (K16) and its view tier
// sends a turn with its words to each subscription that follows one of the turn's hearers (its members' bodies) and
// whose audiences may read the conversation's (`worldd::views::subscription` rules 5 and 6, E26a). The gateway gives a
// view socket the audiences of its view token's grants (`gatewayd::views::audiences`), and the directory gives the
// token for the page's own sign-in (B3-2's exchange, owner-mailbox.ts `viewToken`). So a signed-in page follows the
// bodies of its own Souls on one view socket and reads each turn they hear, with its words; a page that is not a
// member's gets nothing, and one that is not signed in gets no socket (the gateway refuses it `token.refused`).
//
// Frames (gatewayd's `views.rs`, as v2/web/src/source/socket.ts speaks them): hello, the sign-in `{1: token}` (answered
// `{4: "view.started"}`), then `{30: {1: [{2: body}, ...], 2: level, 3: budget}}`; the gateway sends `{31: item}`. An
// utterance is R4's addressed item `{1: 9, 2: entry, 3: words}` (replica::speech `heard`). Nothing is stored: the words
// go to the bridge, which shows them in the dock as the old page showed a member its conversation.
import { decode, encode } from 'cborg';
import { session, watchSession } from '../auth-session.ts';
import { NothingOwned, v2MailboxPlace, viewToken, type MailboxPlace } from './owner-mailbox.ts';

/** A private turn as a member's page reads it: its conversation, the body that spoke, when (µs) and its words. */
export type Heard = { conversation: string; speaker: string; at: number; words: string };

type IdValue = [Uint8Array, number | bigint];
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** An id as the page keys it, `<scope hex>.<n>` (as the stream's worker does). */
const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
const idValue = (k: string): IdValue => { const [h, n] = k.split('.'); return [Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)), Number(n)]; };

/** A turn into a conversation, with its words, from one of R4's items; null for anything else: another item, a public
 *  utterance, or a turn sent without its words (a subscriber that may not read them). */
export function heardOf(item: Uint8Array): Heard | null {
  const m = decode(item, { useMaps: true }) as Map<number, unknown>;
  if (num(m.get(1)) !== 9 || !(m.get(3) instanceof Uint8Array) || !(m.get(2) instanceof Uint8Array)) return null;
  const e = decode(m.get(2) as Uint8Array, { useMaps: true }) as Map<number, unknown>;
  const aud = e.get(5) as Map<number, unknown> | undefined;
  if (!aud || num(aud.get(1)) !== 2) return null;
  const said = ((e.get(8) as Map<number, unknown>[] | undefined) ?? []).some((ev) => ev.get(1) === 'souls:said');
  if (!said) return null;
  return { conversation: key(aud.get(2) as IdValue), speaker: key(e.get(6) as IdValue), at: num(e.get(2)), words: new TextDecoder().decode(m.get(3) as Uint8Array) };
}

/** The frame that follows `bodies` (counts: no motion wanted, only what they hear) on a view socket. */
export const followFrame = (bodies: readonly string[]) =>
  encode(new Map<number, unknown>([[30, new Map<number, unknown>([[1, bodies.map((b) => new Map([[2, idValue(b)]]))], [2, 4], [3, 8_000]])]]));

/** The gateway's protocol version the page speaks (v2/web/src/source/socket.ts `PROTOCOL`). */
const PROTOCOL = 2;
/** How long a signed-in page that owns nothing waits before it asks the directory again. */
export const NOTHING_OWNED_MS = 60_000;

/** One view socket for the signed-in person's own Souls: signs in, follows their bodies, hands on what they hear; the
 *  token is renewed on the open socket before it expires, and the socket comes back after a drop. */
class HeardSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly place: MailboxPlace;
  private readonly onHeard: (h: Heard) => void;
  private readonly bodiesOf: (grants: string[]) => string[];
  constructor(place: MailboxPlace, onHeard: (h: Heard) => void, bodiesOf: (grants: string[]) => string[]) {
    this.place = place; this.onHeard = onHeard; this.bodiesOf = bodiesOf;
  }
  start(): void {
    if (this.stopped) return;
    // Signed in and owning nothing yet is a normal state: asked again once a minute (a Soul made since), not every 5 s.
    viewToken(this.place).then((g) => this.connect(g), (e) => (this.timer = setTimeout(() => this.start(), e instanceof NothingOwned ? NOTHING_OWNED_MS : 5_000)));
  }
  private connect(g: { token: string; expires: number; owned: { grant: string }[] }): void {
    // The bodies its Souls drive, as the stream names them, once the page holds them. (The directory's `follow` is the
    // Soul's own id, which is not its body on an imported world, so it is not read.)
    if (this.stopped || !g.owned.length) return;
    const bodies = this.bodiesOf(g.owned.map((o) => o.grant));
    if (!bodies.length) return void (this.timer = setTimeout(() => this.start(), 5_000));
    const ws = new WebSocket(this.place.gateway);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let step = 0; // 0 hello sent, 1 sign-in sent, 2 following
    ws.onopen = () => ws.send(encode(new Map<number, unknown>([[1, PROTOCOL], [2, new Uint8Array(0)]])));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return; // the owner's box's frames (owner-mailbox.ts)
      if (step === 0) return void ((step = 1), ws.send(encode(new Map([[1, g.token]]))));
      const m = decode(new Uint8Array(ev.data as ArrayBuffer), { useMaps: true }) as Map<number, unknown>;
      if (step === 1 && m.get(4) === 'view.started') { step = 2; ws.send(followFrame(bodies)); this.renewLater(g.expires); return; }
      const item = m.get(31);
      if (item instanceof Uint8Array) { const h = heardOf(item); if (h) this.onHeard(h); }
    };
    ws.onclose = () => { this.ws = null; if (!this.stopped) this.timer = setTimeout(() => this.start(), 1_000); };
    ws.onerror = () => ws.close();
  }
  private renewLater(expires: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const g = await viewToken(this.place);
        if (this.ws?.readyState === 1) this.ws.send(encode(new Map([[1, g.token]])));
        this.renewLater(g.expires);
      } catch { /* kept until it expires; the socket then closes and signs in again */ }
    }, Math.min(Math.max(1_000, expires * 1_000 - Date.now() - 30_000), 2 ** 31 - 1));
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }
}

/** Hands `onHeard` the private turns the signed-in person's Souls hear on this v2 world, while it is signed in; again
 *  after each sign-in. Nothing on an old-engine world or a page that names no gateway. */
export function memberTurns(onHeard: (h: Heard) => void, bodiesOf: (grants: string[]) => string[]): { stop(): void } {
  const place = v2MailboxPlace();
  if (!place) return { stop() {} };
  let sock: HeardSocket | null = null;
  let who: string | null = null;
  const restart = () => {
    const s = session(), now = `${s.authed}|${s.label ?? ''}`;
    if (now === who) return;
    who = now; sock?.stop(); sock = new HeardSocket(place, onHeard, bodiesOf); sock.start();
  };
  const unwatch = watchSession(restart);
  restart();
  return { stop() { unwatch(); sock?.stop(); } };
}
