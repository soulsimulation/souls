// Scaling V2 (#2520): anonymous viewers on their own sender. A token-less viewer only ever receives what the hub broadcasts
// with no filter, plus the public form of `stats`; none of it needs the host, the database, auth or private-view state at
// send time. This class owns those viewers' sockets and sends them that public stream. It is fed through one narrow
// interface (PublicFeed, plus the pushes pub/reset/down) and reads nothing else, so the same class can later be fed across
// a thread boundary (V5). Here it runs on the world's thread, behind SIM_ANON_FANOUT=1; the Hub hands it every upgrade whose
// URL carries `hello=` (the page's entry socket and an anonymous reconnect).
//
// What it reproduces from the hub (hub.ts), and the oracle test (anon-fanout.test.ts) holds the two paths together: the join
// set (welcome, the shared join picture in the peer's negotiated form, its log list, the batches after it, then the rest of
// the join set), resume (`since` + the hub's epoch, from its own ring of the last 600 batches), `resync`, the take
// transports (its own TakeEntitiesEncoderV1 / TakeChunksEncoderV1 and kernel-tick), backpressure, per-tick corking, the
// load dial's join hold, the hello and message rate limits, the ping sweep and the 15 s hello deadline.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { addressKey } from '../address-key.ts';
import { COLUMNS_V1, packColumnsV1, joinTableOrderV1, PROTO, TAKE_BOUNDARY_WIRE_V1, stringifyTakeBoundaryWireV1, TAKE_ENTITIES_WIRE_V1, TAKE_ENTITIES_JOIN_V1,
  TakeEntitiesEncoderV1, TAKE_CHUNKS_WIRE_V1, TakeChunksEncoderV1, kernelRestV1, stationHelloCapabilitiesV1Schema, type ClientMsg, type ServerMsg } from '@souls/protocol';

/** The hub's inbound schema (one definition: the hub imports it from here). */
export const clientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), proto: z.number(), token: z.string().max(4000).optional(), since: z.number().optional(), epoch: z.string().max(40).optional(),
    stationContracts:stationHelloCapabilitiesV1Schema.shape.stationContracts,takeTransport:z.literal(TAKE_BOUNDARY_WIRE_V1).optional(),
    // an unknown later contract is not an error: the peer simply gets the full table
    takeEntities:z.string().max(40).optional(),takeChunks:z.string().max(40).optional(),takeEntitiesJoin:z.string().max(40).optional(),snapshotColumns:z.string().max(40).optional() }),
  z.object({ t: z.literal('resync'), reason: z.string().max(200) }),
  z.object({ t: z.literal('ping'), n: z.number() }),
]);

export type Load = 'green' | 'amber' | 'red' | 'black';
type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
type Snapshot = Extract<ServerMsg, { t: 'snapshot' }>;
/** The welcome's world part (the same for every anonymous viewer); `privateMe`: the world speaks me-live/1, so each welcome
 *  carries a connection id with no user. */
export type WelcomeFields = Pick<Welcome, 'build' | 'proto' | 'worldId' | 'rulesVersion' | 'schema' | 'dt' | 'clockRate' | 'serverTick' | 'epoch' | 'paused'> & { privateMe?: true };
/** One join's world part: the shared picture (V1's join cache) with its seq, its log list (already a string), and the rest
 *  of the join set in order: strings sent as they are, and the two message objects that need per-peer encoding, `kernel`
 *  (kernel-tick) and `takes` (the take transports). */
export type PublicJoin = { seq: number; snapshot: Snapshot; log: string; rest: (string | ServerMsg)[] };
export interface PublicFeed {
  welcome(): WelcomeFields;
  join(): PublicJoin;
  /** The world clock is running. */
  available(): boolean;
  load(): Load;
}

const MAX_CONNECTIONS = 20_000, MAX_PER_IP = 200, MAX_BUFFERED = 1_000_000, RING = 600, SWEEP_MS = 15_000;
type Peer = { ws: WebSocket; ip: string; ready: boolean; alive: boolean; joinedAt: number; msgs: number; windowStart: number; lastHello: number; lastSnapshot: number; heldSince?: number;
  generation: number; resyncs: number; takeTransport?: typeof TAKE_BOUNDARY_WIRE_V1; takeEntities?: { last: number | null; join?: true }; takeChunks?: { last: number | null; kernel?: string };
  columns: boolean; awaitingTakes: boolean; joinSend: boolean; joinPending: number };

export class AnonFanout {
  readonly wss: WebSocketServer;
  private peers = new Set<Peer>();
  private perIp = new Map<string, number>();
  /** The last RING batches as the hub stringified them, with their seq. */
  private ring: { seq: number; s: string }[] = [];
  /** The oldest batch a peer may resume from (#1221); -1: the first batch after the last reset. */
  private resumeFrom = 0;
  private readonly takeEntities = new TakeEntitiesEncoderV1();
  private readonly takeChunks = new TakeChunksEncoderV1();
  private timers: ReturnType<typeof setInterval>[] = [];
  private feed: PublicFeed; private wake: () => void;

  constructor(feed: PublicFeed, o: { wake?: () => void } = {}) {
    this.feed = feed; this.wake = o.wake ?? (() => {});
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024, clientNoContextTakeover: true, serverNoContextTakeover: true, concurrencyLimit: 4 } });
    this.timers.push(setInterval(() => this.sweep(), SWEEP_MS).unref());
    // a socket that never introduces itself is not a viewer (judged after the poll phase, as the hub does)
    this.timers.push(setInterval(() => setImmediate(() => { const now = Date.now(); for (const p of this.peers) if (!p.ready && now - p.joinedAt > 15_000 + this.stallMs) { p.ws.close(1008, 'no hello'); this.drop(p); } }), 5_000).unref());
  }
  /** Sockets held (ready or still joining): the fanout's part of the host's viewerCount(). */
  get size() { return this.peers.size; }
  hasReady() { for (const p of this.peers) if (p.ready) return true; return false; }
  stopTimers() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  /** The world's stop: every socket gets the "going away" code. */
  close(reason: string) { for (const ws of this.wss.clients) ws.close(1001, reason); }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) { this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, req)); }

  // ------------------------------------------------------------------ the three pushes
  /** Every unfiltered broadcast as the hub stringified it; `m` only for `takes` (s unused) and `kernel`. */
  pub(t: string, s: string, m?: ServerMsg) {
    if (t === 'batch') {
      const seq = Number(/^\{"t":"batch","seq":(\d+)/.exec(s)?.[1] ?? (JSON.parse(s) as { seq: number }).seq);
      this.ring.push({ seq, s }); if (this.ring.length > RING) this.ring.shift();
      if (this.resumeFrom < 0) this.resumeFrom = seq;
    }
    if (!this.peers.size) return;
    if (!this.feed.available()) return this.down();
    if (t === 'takes') {
      const strings = new Map<string, string>();
      for (const p of this.peers) { if (!p.ready || p.ws.readyState !== 1) continue; this.hold(p.ws); this.sendMsg(p, m!, strings); }
      return;
    }
    const rest = t === 'kernel' && m?.t === 'kernel' ? kernelRestV1(m.view) : undefined;
    // a batch is never dropped for backpressure: a missing one is a seq gap, and the gap costs the viewer a whole snapshot
    for (const p of this.peers) { if (!p.ready || p.ws.readyState !== 1) continue; if (p.ws.bufferedAmount > MAX_BUFFERED && t !== 'batch') continue;
      const out = m ? this.kernelWire(p, m, s, rest) : s; this.hold(p.ws); p.ws.send(out); }
  }
  /** A recovery (#1221): the ring is cleared (nothing before it resumes) and every viewer gets the picture again where it is. */
  reset() {
    this.ring = []; this.resumeFrom = -1;
    let j: PublicJoin | null = null;
    for (const p of this.peers) if (p.ready) { j ??= this.feed.join(); this.picture(p, j); }
  }
  /** The clock is unavailable: everyone is told to try later. */
  down() { for (const p of this.peers) { p.ready = false; p.ws.close(1013, 'world unavailable'); } }

  // ------------------------------------------------------------------ connections
  private onConnect(ws: WebSocket, req: IncomingMessage) {
    const ip = addressKey(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress) ?? '';   // as the hub (#2543): an IPv6 network by its /64
    if (this.peers.size >= MAX_CONNECTIONS || (this.perIp.get(ip) ?? 0) >= MAX_PER_IP) { ws.close(1013, 'too many connections'); return; }
    const now = Date.now();
    const p: Peer = { ws, ip, ready: false, alive: true, joinedAt: now, msgs: 0, windowStart: now, lastHello: 0, lastSnapshot: 0, generation: 0, resyncs: 0, columns: false, awaitingTakes: false, joinSend: false, joinPending: 0 };
    this.peers.add(p); this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.wake();
    ws.on('pong', () => (p.alive = true));
    ws.on('close', () => this.drop(p));
    ws.on('error', () => this.drop(p));
    const inbound = (data: unknown) => {
      const t = Date.now(); if (t - p.windowStart > 10_000) { p.windowStart = t; p.msgs = 0; }
      if (++p.msgs > 20) { ws.close(1008, 'too many messages'); return; }
      let raw: unknown; try { raw = JSON.parse(String(data)); } catch { return; }
      const r = clientMsg.safeParse(raw); if (!r.success) return;
      // signed-in viewers belong to the hub: the page signs in on a bare /ws
      if (r.data.t === 'hello' && r.data.token !== undefined) { p.ready = false; ws.close(4401, 'signed-in hello on the anonymous socket'); return; }
      this.onMessage(p, r.data as ClientMsg);
    };
    ws.on('message', (data) => inbound(data));
    const q = req.url?.indexOf('?') ?? -1;
    let hello: string | null = null; try { hello = q < 0 ? null : new URLSearchParams(req.url!.slice(q + 1)).get('hello'); } catch { /* no hello */ }
    if (hello && hello.length <= 2048) inbound(hello);
  }
  private drop(p: Peer) {
    if (!this.peers.delete(p)) return;
    const n = (this.perIp.get(p.ip) ?? 1) - 1; if (n > 0) this.perIp.set(p.ip, n); else this.perIp.delete(p.ip);
  }

  private onMessage(p: Peer, m: ClientMsg) {
    if (!this.feed.available()) { p.ready = false; p.ws.close(1013, 'world unavailable'); return; }
    if (m.t === 'ping') { this.write(p, JSON.stringify({ t: 'pong', n: m.n, serverTime: Date.now() } satisfies ServerMsg)); return; }
    const now = Date.now();
    // load dial (black): a join or resync waits (up to 30 s) instead of adding its cost to a world that cannot keep up
    if ((m.t === 'hello' || m.t === 'resync') && this.feed.load() === 'black') {
      p.heldSince ??= now;
      if (now - p.heldSince < 30_000) { if (now - p.heldSince < 100) this.write(p, JSON.stringify({ t: 'load', level: 'black' })); setTimeout(() => { if (this.peers.has(p)) this.onMessage(p, m); }, 2_000).unref(); return; }
    }
    p.heldSince = undefined;
    if (m.t === 'resync') { if (now - p.lastSnapshot < 2_000) return; p.lastSnapshot = now; p.resyncs++; this.picture(p, this.feed.join()); return; }
    if (m.t !== 'hello') return;
    if (now - p.lastHello < 3_000) return; p.lastHello = now; p.lastSnapshot = now;
    p.generation++; p.ready = false; p.takeTransport = undefined; p.takeEntities = undefined; p.takeChunks = undefined; p.columns = false; p.awaitingTakes = false;
    const w = this.feed.welcome(), { privateMe, ...fields } = w;
    if (m.proto !== PROTO) {
      this.write(p, JSON.stringify({ t: 'welcome', ...fields, proto: PROTO, you: null, serverTime: Date.now() } as Welcome));
      this.write(p, JSON.stringify({ t: 'error', code: 'proto', message: `server speaks protocol ${PROTO}` } satisfies ServerMsg)); return;
    }
    p.takeTransport = m.takeTransport === TAKE_BOUNDARY_WIRE_V1 ? TAKE_BOUNDARY_WIRE_V1 : undefined;
    p.takeEntities = m.takeEntities === TAKE_ENTITIES_WIRE_V1 ? { last: null, ...(m.takeEntitiesJoin === TAKE_ENTITIES_JOIN_V1 ? { join: true as const } : {}) } : undefined;
    p.takeChunks = m.takeChunks === TAKE_CHUNKS_WIRE_V1 ? { last: null } : undefined; p.columns = m.snapshotColumns === COLUMNS_V1;
    const welcome: Welcome = { t: 'welcome', ...fields, you: null, serverTime: Date.now(),
      ...(privateMe ? { privateMe: { contract: 'me-live/1' as const, connectionId: randomUUID(), userId: null, revision: 1 as const } } : {}),
      ...(p.takeTransport ? { takeTransport: p.takeTransport } : {}), ...(p.takeEntities ? { takeEntities: TAKE_ENTITIES_WIRE_V1 } : {}), ...(p.takeEntities?.join ? { takeEntitiesJoin: TAKE_ENTITIES_JOIN_V1 } : {}), ...(p.takeChunks ? { takeChunks: TAKE_CHUNKS_WIRE_V1 } : {}) };
    if (!this.write(p, JSON.stringify(welcome))) return;
    // the join set is bounded (one per hello, hellos at most every 3 s) and is never dropped for backpressure
    p.joinSend = true; p.awaitingTakes = true;
    try {
      const ring = this.ring, last = ring.at(-1)?.seq;
      const resume = typeof m.since === 'number' && m.epoch === w.epoch && this.resumeFrom >= 0 && m.since >= this.resumeFrom && last !== undefined && m.since >= ring[0].seq - 1 && m.since <= last;
      const j = this.feed.join();
      if (resume) { for (const b of ring) if (b.seq > m.since!) this.write(p, b.s); this.write(p, j.log); }
      else this.picture(p, j, true);
      for (const x of j.rest) typeof x === 'string' ? this.write(p, x) : this.sendMsg(p, x);
    } finally { p.joinSend = false; }
    p.ready = p.ws.readyState === 1;
  }
  /** The shared picture in this peer's form, (on a join) its log list, then every batch after it. */
  private picture(p: Peer, j: PublicJoin, log = false) {
    const w = this.snapshotWire(j.snapshot, !!p.takeEntities?.join, p.columns);
    if (this.write(p, w.s) && w.table !== null && p.takeEntities) p.takeEntities.last = w.table;
    if (log) this.write(p, j.log);
    for (const b of this.ring) if (b.seq > j.seq) this.write(p, b.s);
  }

  // ------------------------------------------------------------------ encoding (as the hub's send)
  /** Per picture, its strings by negotiated form; the entity table registered in this fanout's own encoder. */
  private wire = new WeakMap<object, Map<string, { s: string; table: number | null }>>();
  private snapshotWire(m: Snapshot, join: boolean, columns: boolean) {
    let forms = this.wire.get(m); if (!forms) this.wire.set(m, forms = new Map());
    const key = `${join}|${columns}`; let w = forms.get(key);
    if (!w) {
      const joined = join ? this.takeEntities.register(m.entities) : null;
      if (!joined && !columns) w = { s: JSON.stringify(m), table: null };
      else { const { entities, ...rest } = m; w = { s: JSON.stringify(joined ? { ...rest, entitiesTable: joined.id } : rest).slice(0, -1) + ',"entities":' + (columns ? this.columnsOf(entities, joined?.json) : joined!.json) + '}', table: joined?.id ?? null }; }
      forms.set(key, w);
    }
    return w;
  }
  private lastColumns: { json: string; packed: string } | null = null;
  private columnsOf(entities: unknown, json = JSON.stringify(entities)): string {
    if (this.lastColumns?.json === json) return this.lastColumns.packed;
    const p = packColumnsV1(entities, joinTableOrderV1), packed = p ? JSON.stringify(p) : json; this.lastColumns = { json, packed }; return packed;
  }
  /** `kernel` or `takes` for one peer. `strings`: this broadcast's encodings by peer state (shared by peers in the same one). */
  private sendMsg(p: Peer, m: ServerMsg, strings?: Map<string, string>) {
    if (p.ws.readyState !== 1) return false;
    if (p.ws.bufferedAmount > MAX_BUFFERED && !p.joinSend && !(m.t === 'takes' && p.awaitingTakes)) return false;
    if (m.t !== 'takes') return this.write(p, this.kernelWire(p, m, JSON.stringify(m)));
    let s: string, nextTable: number | null | undefined, nextTake: number | null | undefined;
    try {
      const mode = p.takeTransport ? 'wire' : 'raw';
      const chunks = p.takeChunks ? this.takeChunks.encode(m, p.takeChunks.last) : null;
      const stream = (chunks ? chunks.stream : m) as ServerMsg;
      const entities = stream.t === 'takes' && p.takeEntities ? this.takeEntities.encode(stream, p.takeEntities.last) : null;
      const key = (entities ? `${mode}|${p.takeEntities!.last}` : mode) + (chunks ? `|c${p.takeChunks!.last}` : '');
      const inner = (v: unknown) => mode === 'wire' ? stringifyTakeBoundaryWireV1(v) : JSON.stringify(v);
      s = strings?.get(key) ?? (() => {
        const packed = entities ? JSON.stringify({ t: 'take-entities', contract: TAKE_ENTITIES_WIRE_V1, ids: entities.envelope.ids }).slice(0, -1) + ',"payload":' + inner(entities.envelope.payload) + '}' : inner(stream);
        return chunks ? JSON.stringify({ t: 'take-chunks', contract: TAKE_CHUNKS_WIRE_V1, ids: chunks.ids, same: chunks.same }).slice(0, -1) + ',"payload":' + packed + '}' : packed;
      })();
      strings?.set(key, s);
      if (entities) nextTable = entities.last;
      if (chunks) nextTake = chunks.last;
    } catch {
      p.ready = false; p.ws.send(JSON.stringify({ t: 'error', code: 'takes.transport-invalid', message: 'The take transport cannot be encoded exactly.' })); p.ws.close(1011, 'invalid take transport'); return false;
    }
    this.write(p, s);
    if (nextTable !== undefined && p.takeEntities) p.takeEntities.last = nextTable;
    if (nextTake !== undefined && p.takeChunks) p.takeChunks.last = nextTake;
    if (m.chunks.length) p.awaitingTakes = false;
    return true;
  }
  /** take-chunk-ref/1 peers: a kernel view that differs from the last one sent only in its tick travels as kernel-tick. */
  private kernelWire(p: Peer, m: ServerMsg, s: string, rest?: string | null): string {
    if (m.t !== 'kernel' || !p.takeChunks) return s;
    const r = rest === undefined ? kernelRestV1(m.view) : rest;
    if (r !== null && r === p.takeChunks.kernel) return JSON.stringify({ t: 'kernel-tick', tick: m.view.tick });
    p.takeChunks.kernel = r ?? undefined; return s;
  }
  private write(p: Peer, s: string) {
    if (!this.feed.available()) { p.ready = false; p.ws.close(1013, 'world unavailable'); return false; }
    if (p.ws.readyState !== 1) return false;
    if (p.joinSend) { p.joinPending++; p.ws.send(s, () => { p.joinPending--; }); } else p.ws.send(s);
    return true;
  }
  /** Some peer's join set is still being compressed or written within `holdMs` of its hello (the hub's lane P5 clock hold). */
  joining(now: number, holdMs: number) { for (const p of this.peers) if (p.joinPending && now - p.lastHello < holdMs && p.ws.readyState === 1) return true; return false; }

  /** A tick's frames reach each socket as one write (the hub's srv-hub-physics cork). */
  private held = new Set<Duplex>();
  private hold(ws: WebSocket) {
    const sock = (ws as unknown as { _socket?: Duplex })._socket;
    if (!sock || this.held.has(sock) || sock.destroyed) return;
    sock.cork(); this.held.add(sock);
    if (this.held.size === 1) process.nextTick(this.release);
  }
  private release = () => { for (const sock of this.held) sock.uncork(); this.held.clear(); };

  /** Lag-aware ping sweep (as the hub's): a sweep that ran more than 5 s late, or a black world, judges nobody. */
  private sweepAt = Date.now();
  stallMs = 0;
  private sweep() {
    const now = Date.now(); this.stallMs = Math.max(0, now - this.sweepAt - SWEEP_MS); this.sweepAt = now;
    const judge = this.stallMs <= 5_000 && this.feed.load() !== 'black';
    setImmediate(() => { for (const p of this.peers) { if (!p.alive && judge) { p.ws.terminate(); this.drop(p); continue; } p.alive = false; try { p.ws.ping(); } catch { /* closed */ } } });
  }
}
