// GET /v1/edge/live (#1737, soul-live/1): the whole world's live picture as one small public answer a Soul's client
// follows: who is where doing what, and what was said, anywhere. Everyone knows everything for now (the scope field is
// where a later privacy model withholds). Built at most twice a second whoever asks; behind the launcher it is a C3
// public read answered from the micro-cache, so the world's cost does not grow with the number of clients.
//
// #1755: the same picture's changes are pushed over the event stream a Soul's client already holds (`live=1` on
// GET /v1/edge/events). One build and one diff per change for the whole world, each frame serialised once and shared by
// every client; a client resumes from the world's seq, or takes the whole picture. Nothing runs while no client asks.
import type {Context, Hono} from 'hono';
import type {EdgeLedger} from '../ledger/ledger.ts';
import {inPoly} from '../ledger/places.ts';
import {liveDelta, liveHash, type LivePicture} from './live-delta.ts';

export const LIVE_CONTRACT = 'soul-live/1';
/** Lines of speech kept and sent: the newest. A client keeps its own longer history by id. */
export const LIVE_SPEECH = 40;
/** World ticks one built answer serves (10 ticks = 0.5 s at clock rate 1). */
const KEEP_TICKS = 10;
/** #1755: changes kept for a client that comes back (about two minutes at two a second), how often the push looks for a
 *  change, and how often it sends the picture's hash (the client's check, and the stream's sign of life). */
export const LIVE_RING = 240, PUSH_EVERY_MS = 250, CHECK_EVERY_MS = 5_000;
/** More changes missed than this (a minute at two a second) are sent as the whole picture instead. */
export const LIVE_REPLAY_MAX = 120;

type Line = {id: string; tick: number; at: number; soul: string; name: string; text: string; place: string | null; untrusted: true};
type Spectated = {kind: string; tick: number; at: number; id?: unknown; from?: {soulId?: unknown; name?: unknown}; channel?: {placeId?: unknown; base?: {placeId?: unknown}}; text?: unknown};
type Body = {pose?: {p: number[]}; human?: {activity?: string}};

/** What a push subscriber is handed: an SSE event name, its data, and the whole SSE frame as bytes, encoded once for every client. */
export type LiveSend = (event: 'live' | 'live.full', data: string, sse: Uint8Array) => void;
export type LiveHub = {
  /** Subscribe from `after` (`<epoch>:<seq>` the client holds, or null): the changes since then, or the whole picture. */
  subscribe(after: string | null, send: LiveSend): () => void;
  /** The whole picture, serialised (what GET /v1/edge/live answers). */
  full(): string;
  /** An SSE frame's bytes. */
  sse(event: 'live' | 'live.full', data: string): Uint8Array;
  subscribers(): number;
  close(): void;
};

export function mountLiveRoute(app: Hono, deps: {ledger: EdgeLedger}, comms: {onSpectator(l: (m: Spectated) => void): unknown}, catalogVersion: () => string | null): LiveHub {
  // each line with where it was said (its speaker's place path and position then), so a place made secret later withholds it
  const L = deps.ledger, speech: Line[] = [], saidAt = new WeakMap<Line, {path: string[]; x: number | null; z: number | null}>(), secret = (id: string | null | undefined) => !!id && !!L.knowledge?.isSecret(id);
  // The catalog's rule (knowledge.hidesPoint for a Soul that knows no secret place): a point inside a secret place's
  // outline is hidden on any floor, so a secret room upstairs hides who stands under it too. The outlines are kept.
  let outlines: {key: string; polys: (readonly (readonly [number, number])[])[]} | null = null;
  const hidden = (x: number, z: number) => {
    const key = `${L.knowledge?.version ?? 0}|${L.places.version}`;
    if (outlines?.key !== key) outlines = {key, polys: L.knowledge?.marked().size ? [...L.places.byId.values()].filter(p => p.polygon.length && secret(p.id)).map(p => p.polygon as readonly (readonly [number, number])[]) : []};
    return outlines.polys.length > 0 && outlines.polys.some(poly => inPoly(x, z, poly as never));
  };
  comms.onSpectator(m => {
    if (m.kind !== 'speech' || typeof m.id !== 'string' || typeof m.text !== 'string') return;
    const place = m.channel?.placeId ?? m.channel?.base?.placeId, from = String(m.from?.soulId ?? '');
    // what is said in a place kept off the map (or by someone standing in one, or inside one's outline) stays there
    if ((typeof place === 'string' && secret(place)) || L.placePathOf(from).some(p => secret(p.id))) return;
    const pose = L.poseOf?.(from); if (pose && hidden(pose.x, pose.z)) return;
    const line: Line = {id: m.id, tick: m.tick, at: m.at, soul: from, name: String(m.from?.name ?? ''), text: m.text, place: typeof place === 'string' ? place : null, untrusted: true};
    saidAt.set(line, {path: [...(typeof place === 'string' ? [place] : []), ...L.placePathOf(from).map(p => p.id)], x: pose?.x ?? null, z: pose?.z ?? null});
    speech.push(line);
    if (speech.length > LIVE_SPEECH) speech.shift();
  });
  const build = (tick: number): LivePicture => {
    const world = L.host.engine.world as unknown as {entities: Record<string, Body>}, r1 = (n: number) => Math.round(n * 10) / 10;
    type Row = {id: string; name: string; at: number[] | null; place: string | null; doing: string | null};
    const souls = [...L.host.minds.values()].flatMap((m): Row[] => {
      const e = world.entities[m.entityId], p = e?.pose?.p; if (!p || L.faded.has(m.soulId)) return [];
      const path = L.placePathOf(m.soulId);
      // a Soul in a secret place (or inside one's outline, on any floor) is in the world, but where is not said
      if (path.some(x => secret(x.id)) || hidden(p[0]!, p[2]!)) return [{id: m.soulId, name: m.name, at: null, place: null, doing: null}];
      return [{id: m.soulId, name: m.name, at: [r1(p[0]!), r1(p[2]!)], place: path.find(x => x.kind !== 'occupier')?.id ?? null, doing: e.human?.activity ?? null}];
    }).sort((a, b) => a.id < b.id ? -1 : 1);
    // a line said before its place was made secret is withheld from then on too (where its speaker stood, on any floor)
    const open = (l: Line) => { const w = saidAt.get(l); return !secret(l.place) && !w?.path.some(secret) && !(w && w.x !== null && hidden(w.x, w.z!)); };
    return {contract: LIVE_CONTRACT, worldId: L.host.worldId, scope: 'public', tick, at: Date.now(), catalog: catalogVersion(), souls, speech: speech.filter(open)};
  };

  // ---- one picture at a time, numbered: every build that changes something a client keeps is the next seq
  // (an epoch per process: a restarted world's seq starts again, and a client holding the old one takes the whole picture)
  const epoch = Date.now().toString(36);
  let kept: {key: string; pic: LivePicture; seq: number; body: string | null; hash: string | null} | null = null;
  const ring: {seq: number; frame: string; sse: Uint8Array}[] = [], subs = new Set<LiveSend>(), enc = new TextEncoder();
  const sseOf = (event: string, data: string) => enc.encode(`event: ${event}\ndata: ${data}\n\n`);
  const fanout = (event: 'live' | 'live.full', data: string, sse = sseOf(event, data)) => { for (const s of [...subs]) try { s(event, data, sse); } catch { subs.delete(s); } };
  // A change kept for a client coming back was public when it was made. A place made secret (or the places changed) since
  // may have made it not so: the kept changes are dropped, and a client coming back takes the whole picture as it is now.
  let shown = '';
  const current = () => {
    const nowShown = `${L.knowledge?.version ?? 0}|${L.places.version}`;
    if (nowShown !== shown) { shown = nowShown; ring.length = 0; }
    const tick = L.host.engine.world.tick, key = `${Math.floor(tick / KEEP_TICKS)}|${speech.at(-1)?.id ?? ''}|${L.knowledge?.version ?? 0}`;
    if (kept?.key === key) return kept;
    const pic = build(tick);
    if (!kept) { kept = {key, pic, seq: 1, body: null, hash: null}; return kept; }
    const d = liveDelta(kept.pic, pic, kept.seq + 1);
    if (!d) { kept = {...kept, key, pic}; kept.body = null; return kept; }   // the clock alone moved: same seq, no frame
    kept = {key, pic, seq: d.seq, body: null, hash: null};
    const frame = JSON.stringify({epoch, ...d}), sse = sseOf('live', frame);
    ring.push({seq: d.seq, frame, sse}); if (ring.length > LIVE_RING) ring.shift();
    fanout('live', frame, sse);
    return kept;
  };
  const full = () => { const k = current(); return k.body ??= JSON.stringify({...k.pic, epoch, seq: k.seq}); };
  const check = () => { const k = current(); k.hash ??= liveHash(k.pic); fanout('live', JSON.stringify({epoch, seq: k.seq, check: k.hash})); };

  // ---- the push: only while someone holds it. Its own time is measured and logged once a minute while it runs.
  let timer: ReturnType<typeof setInterval> | null = null, lastCheck = 0;
  const cost = {runs: 0, ms: [] as number[], since: Date.now()};
  const step = () => {
    const t0 = performance.now();
    try { current(); if (Date.now() - lastCheck >= CHECK_EVERY_MS) { lastCheck = Date.now(); check(); } }
    catch (error) { console.error('[live-push] fault', error instanceof Error ? error.message : String(error)); }
    cost.runs++; cost.ms.push(performance.now() - t0);
    if (Date.now() - cost.since >= 60_000) {
      const s = cost.ms.sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3);
      console.log(`[live-push] subscribers=${subs.size} runs=${cost.runs} seq=${kept?.seq ?? 0} ms p50=${q(0.5)} p99=${q(0.99)} max=${q(1)}`);
      cost.runs = 0; cost.ms = []; cost.since = Date.now();
    }
  };
  const subscribe = (after: string | null, send: LiveSend) => {
    const k = current(), [e, n] = (after ?? '').split(':'), have = Number(n);
    // the changes since the client's seq while the ring still has every one of them, else the whole picture
    if (e === epoch && Number.isSafeInteger(have) && have <= k.seq && k.seq - have <= LIVE_REPLAY_MAX && (have === k.seq || (ring[0] && ring[0].seq <= have + 1))) { for (const r of ring) if (r.seq > have) send('live', r.frame, r.sse); }
    else { const body = full(); send('live.full', body, sseOf('live.full', body)); }
    subs.add(send);
    if (!timer) { timer = setInterval(step, PUSH_EVERY_MS); timer.unref?.(); cost.since = Date.now(); }
    return () => { subs.delete(send); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
  };

  app.get('/v1/edge/live', (c: Context) => {
    c.header('Cache-Control', 'no-store'); c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(full(), 200);
  });
  return {subscribe, full: () => full(), sse: (event: 'live' | 'live.full', data: string) => sseOf(event, data), subscribers: () => subs.size, close() { if (timer) clearInterval(timer); timer = null; subs.clear(); }};
}
