// A part's ways as places a Soul can see and name (racks: a frame's standing places, a sheet's deck, a flight's top,
// and the ladders and stairs up to them). What a part is walked on and up is its kind's entry (`geometry.floors`,
// `stairs`, `ladders`); the world makes each floor a node under the part (`<part>/floor-<n>`, n the floor's place in
// the entry, from 1), and the copy holds those nodes (`../brief/copy.mjs` `nodeOf`: their level and surfaces). This
// module names them, says which exist now, and gives the point a walk to one is sent with: the floor's middle at its
// height, in the floor node's frame (its part's), as the engine's own climb test sends it (`eden:walk`, parameter 1).
//
// A standing place (`while_joined`) exists only while braced, as the world reads it (`sim::ground::scene::braced`): a
// part beside its part in the same parent, linked to it and in a slot, sits at its height within half that part's own
// height, and nothing else in that parent lies over it within a standing body's height (a box, or another part's
// floor: a sheet's top). A ladder or a stair is a way up only to a place that exists now.

/** A standing body's height, µm (`sim::ground::BODY_HIGH`). */
const BODY_HIGH_UM = 1_800_000;
const ONE = 2 ** 30;

/** `v` turned by quaternion `q` ([w, x, y, z], any scale). */
function turn(q = [ONE, 0, 0, 0], v) {
  const n = Math.hypot(...q) || 1, [w, x, y, z] = q.map((c) => c / n);
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
/** Point `p` (µm, in `row`'s frame) in the frame of `row`'s parent. A node in a slot is posed in that slot's frame:
 *  the slot's point and yaw in its parent (the parent's slots field, `[n, x, y, z, yaw mdeg, ...]` mm). */
function up(row, p, rows) {
  const q = turn(row.rot, p).map((c, k) => c + (row.pos?.[k] ?? 0));
  const s = row.slot !== undefined ? rows?.get(row.parent)?.slots?.find((r) => r[0] === row.slot) : null;
  if (!s) return q;
  const half = ((s[4] ?? 0) / 1000) * (Math.PI / 360);
  return turn([Math.cos(half), 0, Math.sin(half), 0], q).map((c, k) => c + s[k + 1] * 1000);
}

const metres = (mm) => `${(Math.round(mm / 100) / 10).toFixed(1)} m`;
const faceOf = (z) => (z < 0 ? 'back' : z > 0 ? 'front' : null);

/** The entry's ways of `thing` (`geometry`), or null when it declares none. */
function declared(entry) {
  const g = entry?.geometry;
  return g && (g.floors?.length || g.stairs?.length || g.ladders?.length) ? { floors: g.floors ?? [], stairs: g.stairs ?? [], ladders: g.ladders ?? [] } : null;
}

/** Children of each node, built once per call. */
function kidsOf(rows) {
  const out = new Map();
  for (const r of rows.values()) if (r.parent) (out.get(r.parent) ?? out.set(r.parent, []).get(r.parent)).push(r);
  return out;
}

/** A floor's rectangle in its part's parent, `[x0, z0, x1, z1]` µm, and its top, µm; null with no surfaces. */
function planOf(rows, floor, part) {
  let bb = [Infinity, Infinity, -Infinity, -Infinity], top = null;
  for (const [y, ring] of floor.surfaces ?? []) {
    for (const [x, z] of ring ?? []) {
      const q = up(part, [x * 1000, y * 1000, z * 1000], rows);
      bb = [Math.min(bb[0], q[0]), Math.min(bb[1], q[2]), Math.max(bb[2], q[0]), Math.max(bb[3], q[2])];
      top = Math.max(top ?? -Infinity, q[1]);
    }
  }
  return top === null ? null : { bb, top };
}

/** Whether standing place `floor` of `part` is there now (see the head of this file). */
export function braced(rows, floor, part, kids = kidsOf(rows)) {
  const y = floor.surfaces?.[0]?.[0];
  if (y === undefined || !part.parent) return false;
  const siblings = (kids.get(part.parent) ?? []).filter((r) => r.id !== part.id);
  // Joined at its height: a linked part in a slot of the same parent, within half its own height.
  const level = up(part, [0, y * 1000, 0], rows)[1];
  const joined = siblings.some((o) => {
    if (o.slot === undefined || !((part.links ?? []).includes(o.id) || (o.links ?? []).includes(part.id))) return false;
    const half = Math.max(0, ...(o.solids ?? []).map((b) => (b[6] - b[5]) * 1000)) / 2;
    return Math.abs(up(o, [0, 0, 0], rows)[1] - level) <= half;
  });
  if (!joined) return false;
  // Headroom: nothing else in the parent over it within a standing body's height.
  const plan = planOf(rows, floor, part);
  if (!plan) return false;
  const over = (r, y0) => y0 > plan.top && y0 < plan.top + BODY_HIGH_UM && r[0] < plan.bb[2] && r[2] > plan.bb[0] && r[1] < plan.bb[3] && r[3] > plan.bb[1];
  for (const s of siblings) {
    for (const [cx, cz, hx, hz, yaw, y0] of s.solids ?? []) {
      const a = (Number(yaw) / 1000) * (Math.PI / 180), c = Math.cos(a), sn = Math.sin(a);
      const pts = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, v]) => up(s, [(cx + u * c + v * sn) * 1000, 0, (cz - u * sn + v * c) * 1000], rows));
      const r = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[2])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[2]))];
      if (over(r, y0 * 1000 + pts[0][1])) return false;
    }
    for (const f of kids.get(s.id) ?? []) {
      if (f.kind !== 'eden:floor') continue;
      const p = planOf(rows, f, s);
      if (p && over(p.bb, p.top)) return false;
    }
  }
  return true;
}

/**
 * The places and ways up of `part` (a row) whose kind's entry is `entry`, that exist now: `{places: [{id, name,
 * point, standing, of}], ways: [{name, kind, to}]}`; null when its entry declares no ways. `point` is the walk's,
 * µm in the floor node's frame.
 */
export function waysOf(rows, part, entry, kids = kidsOf(rows)) {
  const d = part ? declared(entry) : null;
  if (!d) return null;
  const floors = new Map((kids.get(part.id) ?? []).filter((r) => r.kind === 'eden:floor').map((r) => [r.level, r]));
  const tops = new Set(d.stairs.map((s) => s.top_mm));
  const places = [];
  d.floors.forEach((f, k) => {
    const node = floors.get(k + 1), [x, z] = f.at_mm ?? [0, 0];
    if (!node) return;
    if (f.while_joined && !braced(rows, node, part, kids)) return;
    const face = faceOf(z);
    const name = f.while_joined ? `standing place, ${metres(f.top_mm)}, ${face ? `${face} face of ${part.name}` : `on ${part.name}`}`
      : tops.has(f.top_mm) ? `top of ${part.name}` : `deck of ${part.name}`;
    places.push({ id: node.id, name, point: [x * 1000, f.top_mm * 1000, z * 1000], standing: Boolean(f.while_joined), of: part.id, top_mm: f.top_mm, z });
  });
  // A way up reaches the place at its top's height nearest its top (import-eden's `level_at`): a ladder's on its face.
  const reach = (top, z) => places.filter((p) => p.top_mm === top).sort((a, b) => Math.abs(a.z - z) - Math.abs(b.z - z))[0];
  const ways = [];
  for (const l of d.ladders) {
    const to = reach(l.top_mm, l.face === 'back' ? -1e9 : 1e9);
    if (to && faceOf(to.z) === l.face) ways.push({ name: `ladder up ${part.name}'s ${l.face} face, to its ${metres(l.top_mm)} standing place`, kind: 'ladder', to: to.id });
  }
  for (const s of d.stairs) {
    const to = reach(s.top_mm, s.to_mm?.[1] ?? 0);
    if (to) ways.push({ name: `stair up ${part.name}, to ${to.name}`, kind: 'stair', to: to.id });
  }
  return { places: places.map(({ top_mm: _t, z: _z, ...p }) => p), ways };
}

/** Every place of a part in the copy that exists now, by id, with the ways up to it (`ways`: their names). */
export function placesIn(rows, kinds) {
  const out = new Map(), kids = kidsOf(rows);
  for (const r of rows.values()) {
    const entry = kinds[r.entry ?? r.kind];
    if (!declared(entry)) continue;
    const w = waysOf(rows, r, entry, kids);
    for (const p of w.places) out.set(p.id, { ...p, ways: w.ways.filter((x) => x.to === p.id).map((x) => x.name) });
  }
  return out;
}

/** The place `id` names, existing now, or null: a floor node of a part whose entry declares it. */
export function placeAt(rows, kinds, id) {
  const r = rows.get(String(id ?? '')), part = r?.kind === 'eden:floor' && r.parent ? rows.get(r.parent) : null;
  return part ? waysOf(rows, part, kinds[part.entry ?? part.kind])?.places.find((p) => p.id === r.id) ?? null : null;
}

/** The rows with each place that exists now under its own name and its ways up as aliases, for `find` and `query`. */
export function rowsWithPlaces(rows, kinds) {
  const places = placesIn(rows, kinds);
  if (!places.size) return rows;
  const out = new Map(rows);
  for (const p of places.values()) {
    const r = rows.get(p.id);
    out.set(p.id, { ...r, name: p.name, ...(p.ways.length ? { aliases: [...(r.aliases ?? []), ...p.ways] } : {}) });
  }
  return out;
}

/** `object <part>`'s offers for its standing places: `climb to <place>`, sent as a walk to the place. */
export function climbOffers(w) {
  return (w?.places ?? []).filter((p) => p.standing).map((p) => ({ name: `climb to ${p.name}`, act: `walk:${p.id}`, place: p.id, usage: `act ${p.id}` }));
}

/** `object <part> climb to <place id | its name>` (the words as one offer, or `climb` then `to ...`): the offer it
 *  names, null when it names none, undefined when the action is no climb. */
export function climbNamed(offers, action, args = []) {
  const words = String(action) === 'climb' && args[0] === 'to' ? `climb to ${args.slice(1).join(' ')}` : String(action ?? '');
  const m = /^climb to (.+)$/.exec(words);
  if (!m) return undefined;
  const to = m[1].trim();
  return offers.find((o) => o.place && (o.place === to || o.name === `climb to ${to}`)) ?? null;
}
