// GET /v1/edge/catalog (#1737): the world's structure, public, built once per static version and served by tag. It needs
// no Soul and no admission; behind the launcher it is a C3 public read answered from the micro-cache.
import type {Context, Hono} from 'hono';
import type {EdgeLedger} from '../ledger/ledger.ts';
import {buildCatalog, type CatalogThingIn} from './catalog.ts';

type WorldEntity = {def?: string; label?: string; name?: string; human?: unknown; pose?: {p: number[]}};

export function ledgerCatalog(L: EdgeLedger) {
  const world = L.host.engine.world as unknown as {entities: Record<string, WorldEntity>};
  const open = (id: string) => !L.knowledge?.isSecret(id), locate = L.places.locator();
  const things: CatalogThingIn[] = [];
  for (const [id, e] of Object.entries(world.entities)) {
    if (e.human || !e.def || !e.pose || L.concealedThing?.(id)) continue;
    const x = e.pose.p[0]!, z = e.pose.p[2]!; if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const place = locate(x, z, 0);
    things.push({id, kind: e.def, name: L.thingName?.(id) ?? e.name ?? e.label ?? id, at: [x, z], place: place && place.parent !== null ? place.id : null});
  }
  // a spot of a thing the world no longer has (a god removed it; a world's authored spots outlive it) is not an act
  const spots = L.spots.spots.filter(s => !L.spotThingGone(s.id));
  return buildCatalog({worldId: L.host.worldId, places: [...L.places.byId.values()].filter(p => open(p.id)), spots, things});
}

const STARTING_MAX_MS = 30_000;
export function mountCatalogRoute(app: Hono, deps: {ledger: EdgeLedger}) {
  const L = deps.ledger;
  let kept: {key: string; value: ReturnType<typeof buildCatalog>} | null = null;
  const current = () => {
    // the static world (places, spots, navigation), which places are secret, how many things there are, and the god's edits
    // (a thing moved or renamed changes neither count nor navigation). Bodies are not structure: a Soul arriving or leaving
    // rebuilds nothing.
    let things = 0; for (const e of Object.values((L.host.engine.world as unknown as {entities: Record<string, WorldEntity>}).entities)) if (e.def && !e.human) things++;
    const key = `${L.staticVersion()}|${L.knowledge?.version ?? 0}|${things}|${L.thingsVersion?.() ?? ''}`;
    if (kept?.key !== key) kept = {key, value: ledgerCatalog(L)};
    return kept.value;
  };
  // Just after listen the world is still placing its places and activity spots (slices on its clock, a few seconds on Eden):
  // a catalog then would have no acts, and a client would keep it. Until the first whole picture, ask again shortly.
  // Bounded: a world that is still not whole STARTING_MAX_MS after the first ask is served as it is.
  let ready = false, firstAsk = 0;
  const isReady = () => {
    if (ready) return true;
    firstAsk ||= Date.now();
    return (ready = (L.structureReady?.() ?? true) || Date.now() - firstAsk > STARTING_MAX_MS);
  };
  app.get('/v1/edge/catalog', (c: Context) => {
    if (!isReady()) {c.header('Retry-After', '2'); c.header('Cache-Control', 'no-store'); return c.json({contract: 'eden-edge/1', error: {code: 'world.starting', message: 'The world is still laying out its places; ask again in 2 s.'}}, 503);}
    const cat = current();
    c.header('Cache-Control', 'public, max-age=0, must-revalidate'); c.header('ETag', cat.etag); c.header('Content-Type', 'application/json; charset=utf-8');
    const asked = (c.req.header('if-none-match') ?? '').split(',').map(s => s.trim());
    if (asked.some(s => s === cat.etag || s === 'W/' + cat.etag)) return c.body(null, 304);
    return c.body(cat.serialized, 200);
  });
  // The version alone: what an answer names so a client knows its copy is old.
  // (null until the catalog is served: a client then has nothing to compare and keeps asking the catalog itself)
  return {version: () => isReady() ? current().version : null};
}
