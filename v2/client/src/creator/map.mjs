// R8d (0.133): the world at a glance, `souls-god map`, from the creator's copy (the daemon's `describe`, the root's
// `fields`) and the kinds' entries the home keeps: the extent of what stands on the ground, the buildings (a thing with
// rooms in it), the named things, the roads and paths, and the land-use zones, each with its centre and size in metres.
// Read only. A centre is its frames' spots added up, mm in each parent, so a thing inside a turned frame is approximate;
// a building or anything on the open ground is exact. At most MAP_MOST of each, the rest counted.
export const MAP_MOST = 30;
const ROAD = /(^|[:_-])(road|footpath|path|street|lane|track|bridge)($|[_-])/;
const ROOM = /:room$/;
const m = (mm) => Math.round(mm / 100) / 10; // metres, to 10 cm

/** `{ ok, extent, buildings, named, roads, zones }`, each list `{ shown: [...], more }`. */
export function mapOf(d, rootFields = {}, entries = {}, { zonesField = 142 } = {}) {
  const nodes = new Map(d.nodes.map((n) => [String(n.id), n]));
  const world = new Map();
  const centre = (id, k = 0) => {
    if (world.has(id)) return world.get(id);
    const n = nodes.get(id);
    if (!n || k > 64) return [0, 0, 0];
    const up = n.parent == null ? [0, 0, 0] : centre(String(n.parent), k + 1), at = n.at ?? [0, 0, 0];
    const p = [up[0] + at[0], up[1] + at[1], up[2] + at[2]];
    world.set(id, p);
    return p;
  };
  const size = (n) => { const b = entries[String(n.kind).split('@')[0]]?.geometry?.bounds_mm; return Array.isArray(b) ? [m(b[0]), m(b[2])] : null; };
  const row = (n) => { const [x, , z] = centre(String(n.id)), s = size(n); return { id: n.id, kind: n.kind, ...(n.text ? { name: n.text } : {}), at: [m(x), m(z)], ...(s ? { size: s } : {}) }; };
  const list = (rows) => ({ shown: rows.slice(0, MAP_MOST), ...(rows.length > MAP_MOST ? { more: rows.length - MAP_MOST } : {}) });
  const byX = (a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1];
  // the ground: a root's child that holds the world's things (the one most of them stand in)
  const roots = d.nodes.filter((n) => n.parent == null).map((n) => String(n.id));
  const under = new Map();
  for (const n of d.nodes) if (n.parent != null) under.set(String(n.parent), (under.get(String(n.parent)) ?? 0) + 1);
  // the ground: the root, or a child of it, that holds the most (Eden's ground; a small world's place itself)
  const ground = [...nodes.values()].filter((n) => roots.includes(String(n.id)) || roots.includes(String(n.parent))).sort((a, b) => (under.get(String(b.id)) ?? 0) - (under.get(String(a.id)) ?? 0))[0];
  const standing = d.nodes.filter((n) => String(n.parent) === String(ground?.id));
  const buildings = d.nodes.filter((n) => n !== ground && !roots.includes(String(n.id)) && d.nodes.some((c) => String(c.parent) === String(n.id) && ROOM.test(String(c.kind))));
  const roads = d.nodes.filter((n) => ROAD.test(String(n.kind).split('@')[0].split(':').pop()));
  const named = d.nodes.filter((n) => n.text && !buildings.includes(n) && !roads.includes(n));
  // the extent: what stands on the ground, each with half its size around its centre
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const n of standing) { const r = row(n), [w, dd] = r.size ?? [0, 0]; x0 = Math.min(x0, r.at[0] - w / 2); x1 = Math.max(x1, r.at[0] + w / 2); z0 = Math.min(z0, r.at[1] - dd / 2); z1 = Math.max(z1, r.at[1] + dd / 2); }
  const extent = Number.isFinite(x0) ? { west: m(x0 * 1000), east: m(x1 * 1000), north: m(z0 * 1000), south: m(z1 * 1000), width: m((x1 - x0) * 1000), depth: m((z1 - z0) * 1000), things: standing.length } : null;
  // zones (root field 142): `[zone:<name>, use:<use>, [[x, z] mm, ...]]`
  const zones = (Array.isArray(rootFields[zonesField]) ? rootFields[zonesField] : []).map((z) => {
    const pts = Array.isArray(z[2]) ? z[2] : [], xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    return { name: String(z[0]).replace(/^zone:/, ''), use: String(z[1]).replace(/^use:/, ''), ...(pts.length ? { at: [m((Math.min(...xs) + Math.max(...xs)) / 2), m((Math.min(...zs) + Math.max(...zs)) / 2)], size: [m(Math.max(...xs) - Math.min(...xs)), m(Math.max(...zs) - Math.min(...zs))] } : {}) };
  });
  return {
    ok: true, frame: 'metres; x east, z south; centres of each thing', extent,
    buildings: list(buildings.map((n) => ({ ...row(n), rooms: d.nodes.filter((c) => String(c.parent) === String(n.id) && ROOM.test(String(c.kind))).length })).sort(byX)),
    named: list(named.map(row).sort(byX)),
    roads: list(roads.map(row).sort(byX)),
    zones: list(zones),
  };
}
