// A creator's furnish (#3728, today's `eden-god furnish <house>[/room] [--style s]`): today's recipes (L2's furnish/1,
// `recipes.mjs`) run on the daemon's copy against a building's rooms, as one edit of places.
//
// From the copy (an export of it, `genesis.mjs`): the building (a node holding floors that hold rooms), its style from
// today's def (field 2, `core-townhouse@3` is `townhouse`), each room's kind from today's room id (field 1,
// `e_…/bedroom-2` is `bedroom`), its outline (field 11, the room's frame, mm), the doorways (field 22 on their owning
// room: x, z, yaw, width in the floor's frame) and the stairs (field 21 on a floor: width and path). The front is the
// side of the building its door to the outside is on. Each recipe item is placed as today places it: at a fraction of
// the room's free range in the building's canonical frame (front = +z), facing as asked, its first pose that stays in
// the room, out of every doorway (0.8 m deep), off the ends of the stairs (0.9 m round) and their flight, and clear of
// every piece standing there; else it is dropped, with the reason. A recipe's def is the world's pinned kind of the
// same name (`core/bench-seat@1` is `eden:bench_seat`), its size the kind entry's bounds. An item `on` another is put
// in that piece's first slot. Each piece is named as today names it (field 1, `<room>-<item>`), so a second furnish
// leaves what is there.
//
// A solid piece also keeps the room's ways through (`ways.mjs`, today's check): its doorways, stair ends and the
// pieces standing there stay reachable from each other, and the piece is reached from a doorway.
//
// Not here: today's check of every seat's way on and off (the world's own placement rules still hold), a recipe's
// params (a kind has no size of its own to set), and prices.

import { RECIPES } from './recipes.mjs';
import { waysOf } from './ways.mjs';

const FRONT_YAW = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };
const ROOM = 'eden:room', FLOOR = 'eden:floor', WINDOW = 'eden:window', DOOR = 'eden:door';
const Q = 1 << 30;
/** The most operations one edit carries (`replica::edit::OPS_MOST`). */
const OPS_MOST = 256;

const no = (code, detail) => ({ ok: false, code, detail });
const plain = (k) => String(k ?? '').split('@')[0];
const text = (v) => (v && typeof v === 'object' && v.hex !== undefined ? Buffer.from(v.hex, 'hex').toString() : v == null ? '' : String(v));
const yawOf = (o) => (Array.isArray(o) ? 2 * Math.atan2(Number(o[2]), Number(o[0])) : 0);
const quat = (yaw) => [Math.round(Math.cos(yaw / 2) * Q), 0, Math.round(Math.sin(yaw / 2) * Q), 0];
const rot = ([x, z], a) => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
const mm = (at) => (at ?? [0, 0, 0]).map((v) => Number(v) / 1000);
const boxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** The box round a rectangle of half sides `h` at `c`, turned by `a`. */
const turned = (c, [hx, hz], a) => {
  const ex = Math.abs(hx * Math.cos(a)) + Math.abs(hz * Math.sin(a)), ez = Math.abs(hx * Math.sin(a)) + Math.abs(hz * Math.cos(a));
  return [c[0] - ex, c[1] - ez, c[0] + ex, c[1] + ez];
};

/** Whether (x, z) is inside the polygon `poly`. */
const inside = (poly, [x, z]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/** The style of today's def ref (`core-townhouse@3` → `townhouse`). */
export const styleOf = (def) => text(def).replace(/@.*/, '').replace(/^[a-z0-9]+-/, '');
/** A room's recipe kind from today's room id (`e_…/bedroom-2` → `bedroom`), as today's `kindOf`. */
export const roomKindOf = (origin) => text(origin).split('/').pop().replace(/-\d+$/, '').replace(/-room$/, '');
/** The world's pinned kind for a recipe def (`core/bench-seat@1` → `eden:bench_seat@…`), or null. */
export function kindFor(def, kinds) {
  const name = `eden:${String(def).replace(/^[^/]*\//, '').replace(/@.*/, '').replace(/-/g, '_')}`;
  return Object.keys(kinds).find((k) => plain(k) === name) ?? null;
}

/** Whether `parent` (a full kind) admits `child` (a full kind), in its `slot` when given, as describe shows it; yes
 *  when the kinds' admissions are not known here (the world's check still judges it). */
function admits(kinds, parent, child, slot) {
  const k = kinds[parent];
  if (!k?.admits) return true;
  const list = slot === undefined ? k?.admits ?? [] : k?.slots?.[slot] ?? [];
  return list.some((a) => a === child || a === plain(child) || a === kinds[child]?.owner);
}

/**
 * The places that furnish `ref` (a building's id or one of its rooms') on `nodes` (an export of the copy), with
 * `kinds` (the pinned kinds, as describe shows them: full name → { owner, admits, slots }) and `entries` (kind
 * entries by plain kind, their `geometry.bounds_mm`). `style` overrides the building's. Gives { ops, placed, dropped,
 * notes, says } or a refusal by name. Without `kinds`, the kinds the world already uses are its kinds, and their
 * admissions are left to the world's check (a piece on another goes in its first slot).
 */
export function furnishOps(nodes, ref, { style, kinds = {}, entries = {} } = {}) {
  if (!Object.keys(kinds).length) kinds = Object.fromEntries(nodes.map((n) => [n.kind, {}]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const under = (id) => kids.get(id) ?? [];
  const target = byId.get(String(ref ?? ''));
  if (!target) return no('furnish.where', `furnish <building or room id>: no ${ref} in this world`);
  const isRoom = plain(target.kind) === ROOM;
  const building = isRoom ? byId.get(byId.get(target.parent)?.parent) : target;
  const floors = building ? under(building.id).filter((n) => plain(n.kind) === FLOOR) : [];
  const roomsAll = floors.flatMap((f) => under(f.id).filter((n) => plain(n.kind) === ROOM).map((r) => ({ r, f })));
  if (!building || !roomsAll.length) return no('furnish.no-rooms', `${ref} is not a building with rooms, nor one of its rooms`);
  const own = styleOf(building.fields?.[2]);
  if (style !== undefined && !RECIPES[style]) return no('furnish.style', `no furnish style ${style}; styles: ${Object.keys(RECIPES).join(', ')}`);
  const st = style ?? (RECIPES[own] ? own : 'cottage');
  const recipe = RECIPES[st];
  const notes = [];
  if (style === undefined && !RECIPES[own]) notes.push(`no "${own || 'unknown'}" furnish recipe; furnished as a cottage (give --style: ${Object.keys(RECIPES).join(', ')})`);

  // The building's frame: each floor at its pose, each room at its pose on its floor (x, z mm, yaw).
  const floorAt = new Map(floors.map((f) => [f.id, { at: mm(f.pose?.at), yaw: yawOf(f.pose?.orientation), level: Number(f.fields?.[5] ?? 0) }]));
  const inFloor = (fid, [x, z]) => { const f = floorAt.get(fid); const [a, b] = rot([x, z], -f.yaw); return [a + f.at[0], b + f.at[2]]; };
  const roomFrame = (r, f) => { const at = mm(r.pose?.at), yaw = yawOf(r.pose?.orientation); return { at, yaw, fid: f.id, toB: (p) => { const [a, b] = rot(p, -yaw); return inFloor(f.id, [a + at[0], b + at[2]]); }, yawB: yaw + floorAt.get(f.id).yaw }; };
  const frames = new Map(roomsAll.map(({ r, f }) => [r.id, roomFrame(r, f)]));
  const roomIds = new Set(roomsAll.map(({ r }) => r.id));
  // Doorways (rows on their owning room, in its floor's frame) and which floor; the door out sets the front.
  const doors = [];
  let outside = null;
  for (const { r, f } of roomsAll) {
    for (const row of Array.isArray(r.fields?.[22]) ? r.fields[22] : []) {
      const [link, , x, z, yaw, width] = row;
      const c = inFloor(f.id, [Number(x), Number(z)]), a = (Number(yaw) / 1000) * (Math.PI / 180) + floorAt.get(f.id).yaw;
      doors.push({ c, a, width: Number(width), level: floorAt.get(f.id).level });
      const l = (r.links ?? []).find((k) => k.id === link?.id);
      if (l && l.ends.some((e) => !roomIds.has(e))) outside ??= c;
    }
  }
  const all = roomsAll.flatMap(({ r }) => (Array.isArray(r.fields?.[11]) ? r.fields[11] : []).map((p) => frames.get(r.id).toB(p.map(Number))));
  const [bx0, bz0, bx1, bz1] = boxOf(all), mid = [(bx0 + bx1) / 2, (bz0 + bz1) / 2];
  let front = 's';
  if (outside) {
    const dx = outside[0] - mid[0], dz = outside[1] - mid[1];
    front = Math.abs(dz) >= Math.abs(dx) ? (dz >= 0 ? 's' : 'n') : (dx >= 0 ? 'e' : 'w');
  }
  const th = FRONT_YAW[front];
  const R = (p) => rot(p, th), Ri = (p) => rot(p, -th); // canonical → building, building → canonical
  // Stairs: their flights, and their ends on the floors they join.
  const stairs = floors.flatMap((f) => (Array.isArray(f.fields?.[21]) ? f.fields[21] : []).map(([, , to, width, , , path]) => {
    const pts = (path ?? []).map((p) => inFloor(f.id, p.map(Number)));
    const [x0, z0, x1, z1] = boxOf(pts), w = Number(width) / 2;
    return { from: floorAt.get(f.id).level, to: Number(to), flight: [x0 - w, z0 - w, x1 + w, z1 + w], foot: pts[0], head: pts.at(-1) };
  })).filter((s) => s.foot);
  const sizeOf = (kind) => entries[plain(kind)]?.geometry?.bounds_mm;
  const solid = (size) => size[1] > 60;

  const want = isRoom ? [target.id] : roomsAll.map(({ r }) => r.id);
  const ops = [], placed = [], dropped = [];
  for (const { r, f } of roomsAll) {
    if (!want.includes(r.id)) continue;
    const level = floorAt.get(f.id).level, fr = frames.get(r.id);
    const origin = text(r.fields?.[1]), items = recipe.rooms?.[roomKindOf(origin)] ?? recipe.default ?? [];
    const outline = (Array.isArray(r.fields?.[11]) ? r.fields[11] : []).map((p) => fr.toB(p.map(Number)));
    if (!items.length || outline.length < 3) continue;
    // What stands there: an obstacle, and its name (today's) to keep a second furnish from doubling it.
    const taken = [], names = new Set();
    for (const c of under(r.id)) {
      names.add(text(c.fields?.[1]));
      const k = plain(c.kind), size = sizeOf(c.kind);
      if (k === WINDOW || k === DOOR || !size || !solid(size) || c.pose?.slot !== undefined) continue;
      taken.push(turned(fr.toB(mm(c.pose?.at).filter((_, i) => i !== 1)), [size[0] / 2, size[2] / 2], fr.yawB + yawOf(c.pose?.orientation)));
    }
    const canon = outline.map(Ri), [x0, z0, x1, z1] = boxOf(canon);
    const k = outline.length > 4 ? 0.7 : 1, cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
    const ax0 = cxm - (cxm - x0) * k, ax1 = cxm + (x1 - cxm) * k, az0 = czm - (czm - z0) * k, az1 = czm + (z1 - czm) * k;
    const zones = [
      ...doors.filter((d) => d.level === level).map((d) => turned(d.c, [d.width / 2 + 100, 800], d.a)),
      ...stairs.flatMap((s) => [...(s.from === level ? [s.foot] : []), ...(s.to === level ? [s.head] : [])]).map((p) => [p[0] - 900, p[1] - 900, p[0] + 900, p[1] + 900]),
      ...stairs.filter((s) => s.from === level || s.to === level).map((s) => s.flight),
    ];
    const ways = waysOf(outline, doors.filter((d) => d.level === level), stairs.flatMap((s) => [...(s.from === level ? [s.foot] : []), ...(s.to === level ? [s.head] : [])]).filter((p) => inside(outline, p)));
    const named = {};
    for (const it of items) {
      const name = `${origin}-${it.name ?? 'item'}`.slice(0, 48);
      if (names.has(name)) { notes.push(`${name} already there`); continue; }
      const kind = (Array.isArray(it.def) ? it.def : [it.def]).map((d) => kindFor(d, kinds)).find(Boolean);
      if (!kind) { dropped.push({ name, why: `no kind among ${[].concat(it.def).join(', ')}` }); continue; }
      const field = { 1: { hex: Buffer.from(name).toString('hex') } };
      if (it.on) {
        const host = named[it.on];
        const slots = kinds[host?.kind]?.admits ? Object.keys(kinds[host.kind].slots ?? {}) : ['1'];
        const slot = host ? slots.find((s) => admits(kinds, host.kind, kind, s)) : undefined;
        if (!host) { dropped.push({ name, why: `no ${it.on} to put it on` }); continue; }
        if (slot === undefined) { dropped.push({ name, why: `${plain(host.kind)} has no slot for ${plain(kind)}` }); continue; }
        ops.push({ op: 'place', name: ops.length + 1, kind, in: host.name, slot: Number(slot), fields: field });
        placed.push({ name, kind: plain(kind), room: origin, on: it.on });
        continue;
      }
      if (!admits(kinds, r.kind, kind)) { dropped.push({ name, why: `a room does not admit ${plain(kind)}` }); continue; }
      const size = sizeOf(kind);
      if (!size) { dropped.push({ name, why: `no size known for ${plain(kind)}` }); continue; }
      let why = 'no pose fits', got = null;
      for (const [fx, fz, face = 's'] of it.try ?? [[...(it.at ?? [0.5, 0.5]), it.face ?? 's']]) {
        const fyaw = FRONT_YAW[face] ?? 0, side = face === 'e' || face === 'w';
        const hx = (side ? size[2] : size[0]) / 2 + 40, hz = (side ? size[0] : size[2]) / 2 + 40;
        if (ax1 - ax0 < 2 * hx || az1 - az0 < 2 * hz) { why = 'too big for the room'; continue; }
        const p = R([ax0 + hx + fx * (ax1 - ax0 - 2 * hx), az0 + hz + fz * (az1 - az0 - 2 * hz)]);
        const box = turned(p, [hx - 40, hz - 40], fyaw + th);
        if (solid(size) && zones.slice(0, doors.filter((d) => d.level === level).length).some((z) => meets(box, z))) { why = 'in a doorway'; continue; }
        if (zones.slice(doors.filter((d) => d.level === level).length).some((z) => meets(box, z))) { why = 'at the stairs'; continue; }
        if (solid(size) && taken.some((t) => meets(box, t))) { why = 'overlaps another piece'; continue; }
        if (solid(size)) { const w = ways.ok(taken, box); if (!w.ok) { why = w.why; continue; } }
        got = { p, box, yaw: fyaw + th };
        break;
      }
      if (!got) { dropped.push({ name, why }); continue; }
      if (solid(size)) taken.push(got.box);
      // Into the room's frame: from the building's, less the floor's and the room's place and turn.
      const f0 = floorAt.get(f.id), q = rot([got.p[0] - f0.at[0], got.p[1] - f0.at[2]], f0.yaw), local = rot([q[0] - fr.at[0], q[1] - fr.at[2]], fr.yaw);
      const at = [Math.round(local[0]), 0, Math.round(local[1])];
      const nm = ops.length + 1;
      ops.push({ op: 'place', name: nm, kind, in: r.id, at, orientation: quat(got.yaw - fr.yawB), support: { which: 1, node: r.id, height: 0 }, fields: field });
      named[it.name ?? 'item'] = { name: nm, kind };
      placed.push({ name, kind: plain(kind), room: origin });
    }
  }
  if (ops.length > OPS_MOST) return no('furnish.too-many', `${ops.length} pieces; one edit places at most ${OPS_MOST}: furnish one room at a time`);
  const rooms = new Set(placed.map((p) => p.room)).size;
  return { ops, placed, dropped, notes, says: `furnish ${building.id} (${st}, front ${front}): ${placed.length} pieces in ${rooms} rooms, ${dropped.length} dropped` };
}
