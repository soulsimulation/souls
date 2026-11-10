// GET /v1/edge/live (#1737, soul-live/1): the whole world's live picture as one small public answer a Soul's client
// follows: who is where doing what, and what was said, anywhere. Everyone knows everything for now (the scope field is
// where a later privacy model withholds). Built at most twice a second whoever asks; behind the launcher it is a C3
// public read answered from the micro-cache, so the world's cost does not grow with the number of clients.
import type {Context, Hono} from 'hono';
import type {EdgeLedger} from '../ledger/ledger.ts';

export const LIVE_CONTRACT = 'soul-live/1';
/** Lines of speech kept and sent: the newest. A client keeps its own longer history by id. */
export const LIVE_SPEECH = 40;
/** World ticks one built answer serves (10 ticks = 0.5 s at clock rate 1). */
const KEEP_TICKS = 10;

type Line = {id: string; tick: number; at: number; soul: string; name: string; text: string; place: string | null; untrusted: true};
type Spectated = {kind: string; tick: number; at: number; id?: unknown; from?: {soulId?: unknown; name?: unknown}; channel?: {placeId?: unknown; base?: {placeId?: unknown}}; text?: unknown};
type Body = {pose?: {p: number[]}; human?: {activity?: string}};

export function mountLiveRoute(app: Hono, deps: {ledger: EdgeLedger}, comms: {onSpectator(l: (m: Spectated) => void): unknown}, catalogVersion: () => string) {
  const L = deps.ledger, speech: Line[] = [], secret = (id: string | null | undefined) => !!id && !!L.knowledge?.isSecret(id);
  comms.onSpectator(m => {
    if (m.kind !== 'speech' || typeof m.id !== 'string' || typeof m.text !== 'string') return;
    const place = m.channel?.placeId ?? m.channel?.base?.placeId;
    // what is said in a place kept off the map (or by someone standing in one) stays there
    if ((typeof place === 'string' && secret(place)) || L.placePathOf(String(m.from?.soulId ?? '')).some(p => secret(p.id))) return;
    speech.push({id: m.id, tick: m.tick, at: m.at, soul: String(m.from?.soulId ?? ''), name: String(m.from?.name ?? ''), text: m.text, place: typeof place === 'string' ? place : null, untrusted: true});
    if (speech.length > LIVE_SPEECH) speech.shift();
  });
  let kept: {key: string; body: string} | null = null;
  const build = (tick: number) => {
    const world = L.host.engine.world as unknown as {entities: Record<string, Body>}, r1 = (n: number) => Math.round(n * 10) / 10;
    type Row = {id: string; name: string; at: number[] | null; place: string | null; doing: string | null};
    const souls = [...L.host.minds.values()].flatMap((m): Row[] => {
      const e = world.entities[m.entityId], p = e?.pose?.p; if (!p || L.faded.has(m.soulId)) return [];
      const path = L.placePathOf(m.soulId);
      // a Soul in a secret place is in the world, but where is not said
      if (path.some(x => secret(x.id))) return [{id: m.soulId, name: m.name, at: null, place: null, doing: null}];
      return [{id: m.soulId, name: m.name, at: [r1(p[0]!), r1(p[2]!)], place: path.find(x => x.kind !== 'occupier')?.id ?? null, doing: e.human?.activity ?? null}];
    }).sort((a, b) => a.id < b.id ? -1 : 1);
    return JSON.stringify({contract: LIVE_CONTRACT, worldId: L.host.worldId, scope: 'public', tick, at: Date.now(), catalog: catalogVersion(), souls, speech});
  };
  app.get('/v1/edge/live', (c: Context) => {
    const tick = L.host.engine.world.tick, key = `${Math.floor(tick / KEEP_TICKS)}|${speech.at(-1)?.id ?? ''}`;
    if (kept?.key !== key) kept = {key, body: build(tick)};
    c.header('Cache-Control', 'no-store'); c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(kept.body, 200);
  });
}
