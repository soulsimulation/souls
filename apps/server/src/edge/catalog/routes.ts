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
    things.push({id, kind: e.def, name: L.thingName?.(id) ?? e.name ?? e.label ?? id, at: [x, z], place: place && place.parent !== null ? place.id : null, hand: L.thingActs?.(id)});
  }
  return buildCatalog({worldId: L.host.worldId, places: [...L.places.byId.values()].filter(p => open(p.id)), spots: L.spots.spots, things});
}

export function mountCatalogRoute(app: Hono, deps: {ledger: EdgeLedger}) {
  const L = deps.ledger;
  let kept: {key: string; value: ReturnType<typeof buildCatalog>} | null = null;
  const current = () => {
    // the static world (places, spots, navigation), which places are secret, and how many things there are. Bodies are not
    // structure: a Soul arriving or leaving rebuilds nothing.
    // (#1751: and which things a shut container keeps out of sight: opening a drawer publishes what is in it)
    let things = 0, hidden = '';
    for (const [id, e] of Object.entries((L.host.engine.world as unknown as {entities: Record<string, WorldEntity>}).entities)) if (e.def && !e.human) {things++; if (L.concealedThing?.(id)) hidden += id;}
    const key = `${L.staticVersion()}|${L.knowledge?.version ?? 0}|${things}|${hidden}`;
    if (kept?.key !== key) kept = {key, value: ledgerCatalog(L)};
    return kept.value;
  };
  app.get('/v1/edge/catalog', (c: Context) => {
    const cat = current();
    c.header('Cache-Control', 'public, max-age=0, must-revalidate'); c.header('ETag', cat.etag); c.header('Content-Type', 'application/json; charset=utf-8');
    const asked = (c.req.header('if-none-match') ?? '').split(',').map(s => s.trim());
    if (asked.some(s => s === cat.etag || s === 'W/' + cat.etag)) return c.body(null, 304);
    return c.body(cat.serialized, 200);
  });
  // The version alone: what an answer names so a client knows its copy is old.
  return {version: () => current().version};
}
