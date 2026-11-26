// Carrying together and building with parts (0.135 C and A lanes) by a Soul's own commands. The world already takes
// each step as an intent through the gateway (`worldd/src/engine.rs`: `activity:offer|accept|leave`, `carry:lift`,
// `carry:set-down`, `part:take|put|unseat`); here each command is the intents it sends, built from the copy and the
// kind entries held in `<home>/kinds/`, with no daemon and no world, so it is read and tested on its own. No new world
// path: a walk is the Soul's own `<ns>:walk` to a point, as any walk.
//
//   carry offer <body id> [<body id> ...] [--on <thing id>]   a crew (the carry entry's activity, this Soul in front),
//                                     offered to those bodies on the open ground, or on a part to hold it where it stands
//   carry accept|decline <offer id>   joins the crew, or declines; carry leave <crew id> lets go (always taken)
//   carry grip <thing id> front|back|left|right [--from <m>]   walks to that end of a load (its grip's place, from its
//                                     entry; 2.2 m off a part that stands), or beside it along its own x (1.2 m)
//   carry lift <crew id> <load id>    lifts a load with the crew (`carry:lift`)
//   carry to <crew id> <x,z | thing id> [<slot>]   walks this Soul so the crew's load reaches there (its middle, or a
//                                     bay's slot), keeping this Soul's place at the load. The front's walks the whole
//                                     crew (the world keeps each carrier's place) and, into a slot, turns it square
//                                     (the walk names the load's heading there); the others may send their own
//   carry set-down <crew id>          sets the lifted load down where it is
//   carry list                        the crews in the copy, each with what it holds
//   part take|unseat <crew id> <part id>   the crew takes a loose part, or one out of a bay or stand
//   part put <crew id> <bay id> <slot name | number>   seats the crew's part in that slot
//   part put <crew id> here | x,z     lays it on the open ground, under the crew or at that point
//
// Points are metres in the world's frame (x east, z south). The asked Soul's `wait` shows the offer:
// `{"kind":"carry","what":"offered","offer":..,"from":..}`.

import { createHash } from 'node:crypto';

export const CARRY_ENTRY = 'mars:carry';
const ID = /^[0-9a-f]{32}-\d+$/;
const M = 1_000_000;
/** sim::activity::carry::REACH: a carrier stands this far beyond its grip, µm. */
export const REACH = 350_000;
/** Where a crew stands from a part that stands upright (no long axis on the plan), µm: 0.135 A3's frames. */
export const STANDING_FROM = 2_200_000;
/** Where a holder stands beside a part, along its own x, µm: 0.135 A3's change of crew. */
export const BESIDE = 1_200_000;
const ONE = 2 ** 30;
const no = (code, detail) => ({ code, detail });

export const USAGE = {
  carry: 'carry offer <name or body id> [...] [--on <thing id>] | carry accept|decline <offer id> | carry leave <crew id> | carry grip <thing id> front|back|left|right [--from <m>] | carry lift <crew id> <load id> | carry to <crew id> <x,z | thing id> [<slot>] | carry set-down <crew id> | carry list',
  part: 'part take|unseat <crew id> <part id> | part put <crew id> <bay id> <slot> | part put <crew id> here | x,z',
};

/**
 * An activity kind's pinned name as the world pins it from its entry (`worldd::serve::activity_kinds`): `<kind>_activity@1220`
 * and the SHA-256 of `souls/activity/<kind>/<its roles as JSON>` and, when a role stands in the entry's slots, their
 * stands. Null for an entry with fewer than two roles.
 */
export function activityPin(kind, entry) {
  const roles = Object.entries(entry?.roles ?? {}).filter(([n, v]) => n !== 'now' && v && typeof v === 'object' && !Array.isArray(v));
  if (roles.length < 2) return null;
  const stands = roles.map(([, v]) => (Array.isArray(v.places?.slots) ? v.places.slots : []).filter((s) => typeof s === 'string').map((slot) => {
    const s = entry.slots?.[slot];
    if (!s) return null;
    const at = (typeof s.stand === 'string' && entry.points?.[s.stand]) || s, a = at.at_mm;
    if (!Array.isArray(a) || a.length < 3 || !a.slice(0, 3).every(Number.isInteger)) return null;
    return `${a[0] * 1000},${a[1] * 1000},${a[2] * 1000},${Number.isInteger(at.yaw_mdeg) ? at.yaw_mdeg : 0}`;
  }).filter(Boolean));
  const tail = stands.some((s) => s.length) ? `/stands/${stands.map((s) => s.join(';')).join('|')}` : '';
  const hash = createHash('sha256').update(`souls/activity/${kind}/${JSON.stringify(Object.fromEntries(roles))}${tail}`).digest('hex');
  return `${kind}_activity@1220${hash}`;
}

/** The carry's entry among the held kinds: `mars:carry`, else one whose roles are a front and a back and whose slot
 *  takes a thing (the load). → [kind, entry] or null */
export function carryEntryOf(kinds) {
  if (kinds?.[CARRY_ENTRY]?.roles) return [CARRY_ENTRY, kinds[CARRY_ENTRY]];
  return Object.entries(kinds ?? {}).find(([, e]) => e?.roles?.front && e.roles.back && Object.values(e.slots ?? {}).some((s) => s?.admits === 'thing')) ?? null;
}

/** Whether a row's kind is a carry's activity (its plain name `<carry entry>_activity`). */
export const isCrew = (kind) => /(^|:)carry_activity$/.test(String(kind ?? '').split('@')[0]);

/**
 * A load as `sim::activity::carry::Load::of` reads its entry: its long axis (the longest side), its middle above its
 * origin, and where its back and front carriers stand along that axis from its middle (µm, REACH beyond its outermost
 * grips). Null when the entry states no bounds or fewer than two grips apart.
 */
export function loadOf(entry) {
  const b = entry?.geometry?.bounds_mm;
  if (!Array.isArray(b) || b.length !== 3 || !b.every(Number.isInteger)) return null;
  const axis = [0, 1, 2].reduce((best, i) => (b[i] > b[best] ? i : best), 0);
  const middle = axis === 1 ? b[1] / 2 : 0;
  const along = Object.values(entry.points ?? {}).filter((p) => p?.role === 'grip' && Number.isInteger(p.at_mm?.[axis]))
    .map((p) => (p.at_mm[axis] - middle) * 1000).sort((x, y) => x - y);
  if (along.length < 2 || along.at(-1) <= along[0]) return null;
  const long = [0, 0, 0]; long[axis] = b[axis] * 500;
  return { axis, long, halfLength: b[axis] * 500, middle: [0, b[1] * 500, 0], places: [along[0] - REACH, along.at(-1) + REACH] };
}

/** `v` turned by the quaternion `q` ([w, x, y, z], any scale), as the copy's poses hold it. */
export function turn(q, v) {
  const n = Math.hypot(...q) || 1, [w, x, y, z] = q.map((c) => c / n);
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}

/**
 * Where a carrier stands at a thing for its `end` (front or back), on the plan, µm: on a load that lies, its place
 * along its long axis (front at the + end); on one that stands (a frame), `from` (default 2.2 m) along its own z, front
 * at +. Left or right is beside it along its own x, `from` (default 1.2 m), right at +. `from` in µm; `at`: the
 * thing's place in the world ({pos, rot}).
 */
export function gripSpot(at, load, end, from = null) {
  const rot = at.rot ?? [ONE, 0, 0, 0], sign = end === 'front' || end === 'right' ? 1 : -1;
  const mid = turn(rot, load?.middle ?? [0, 0, 0]).map((c, k) => c + at.pos[k]);
  if (end === 'left' || end === 'right') {
    // Beside it, along its own x (a frame's face, a beam's side): a holder's place.
    const x = turn(rot, [M, 0, 0]), xf = Math.hypot(x[0], x[2]) || 1, d = (from ?? BESIDE) * sign;
    return [mid[0] + (x[0] / xf) * d, mid[2] + (x[2] / xf) * d];
  }
  const v = load ? turn(rot, load.long) : [0, 0, 0], flat = Math.hypot(v[0], v[2]);
  if (load && 2 * flat >= load.halfLength) {
    const d = from != null ? from * sign : load.places[end === 'front' ? 1 : 0];
    return [mid[0] + (v[0] / flat) * d, mid[2] + (v[2] / flat) * d];
  }
  const z = turn(rot, [0, 0, M]), zf = Math.hypot(z[0], z[2]) || 1, d = (from ?? STANDING_FROM) * sign;
  return [mid[0] + (z[0] / zf) * d, mid[2] + (z[2] / zf) * d];
}

/** A turn about +y by `mdeg` millidegrees, as a quaternion [w, x, y, z]. */
const yawQuat = (mdeg) => { const h = (mdeg / 1000) * (Math.PI / 360); return [Math.cos(h) * ONE, 0, Math.sin(h) * ONE, 0]; };
const times = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];

/**
 * Where each node is in the world, µm ({pos, rot}), its pose composed with its parents', as the world composes it
 * (`sim::ground::scene::xform_to`): a thing in a slot stands from that slot's point, here its parent's entry's
 * (`slots`, numbered from 1). `rows`: the copy's rows; `slotOf(id)`: a node's slot number or null; `entryOf(row)`: a
 * row's kind entry. → a function of an id, null for a node the copy lacks.
 */
export function placer(rows, slotOf, entryOf) {
  const memo = new Map();
  const place = (id) => {
    if (memo.has(id)) return memo.get(id);
    const r = rows.get(id);
    if (!r) return null;
    const up = r.parent ? place(r.parent) : null, n = r.parent ? slotOf(id) : null;
    const s = n != null ? Object.values(entryOf(rows.get(r.parent))?.slots ?? {})[n - 1] : null;
    const pos = (r.pos ?? [0, 0, 0]).map((c, k) => c + (Array.isArray(s?.at_mm) ? s.at_mm[k] * 1000 : 0)), rot = r.rot ?? [ONE, 0, 0, 0];
    const out = up ? { pos: turn(up.rot, pos).map((c, k) => c + up.pos[k]), rot: times(up.rot, rot) } : { pos, rot };
    memo.set(id, out);
    return out;
  };
  return place;
}

/** A slot of a thing in the world, µm on the plan: its entry's slot (by name, or its number counting from 1). */
export function slotPoint(at, entry, slot) {
  const names = Object.keys(entry?.slots ?? {});
  const k = /^\d+$/.test(String(slot)) ? Number(slot) - 1 : names.indexOf(String(slot));
  const s = entry?.slots?.[names[k]];
  if (!s || !Array.isArray(s.at_mm)) return null;
  const p = turn(at.rot ?? [ONE, 0, 0, 0], s.at_mm.map((c) => c * 1000)).map((c, i) => c + at.pos[i]);
  return { n: k + 1, name: names[k], point: [p[0], p[2]], yaw: Number.isInteger(s.yaw_mdeg) ? s.yaw_mdeg : 0 };
}

/** A point word, `x,z` in metres, as µm; null when it is not one. */
export function pointOf(word) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(word ?? ''));
  return m ? [Math.round(Number(m[1]) * M), Math.round(Number(m[2]) * M)] : null;
}

/**
 * The request with each thing it names by its name rather than its id (a creator's title for it: `part take <crew>
 * "rack frame 1"`) as that thing's id, from the copy's rows (`rowsOf`). Crews and bodies stay ids. A name is matched
 * whole, in any case, against each row's name and aliases; a refusal by name when no thing or several go by it.
 */
export function byName(req, rows) {
  const out = { ...req }, all = [...rows.values()];
  for (const k of ['part', 'into', 'thing', 'load', 'where', 'on']) {
    const v = out[k];
    if (v === undefined || ID.test(String(v)) || v === 'here' || pointOf(v)) continue;
    const want = String(v).trim().toLowerCase();
    const named = all.filter((r) => [r.name, ...(r.aliases ?? [])].some((n) => String(n ?? '').trim().toLowerCase() === want));
    // A map's place can share a thing's name (Mars College's `rack-bay` place and its rack bay): a place is never
    // gripped, taken or seated into, so with a thing of that name the thing is meant.
    const things = named.filter((r) => !/:place$/.test(String(r.kind ?? '')));
    const hits = things.length ? things : named;
    if (hits.length === 1) { out[k] = hits[0].id; continue; }
    return hits.length
      ? no('carry-name-ambiguous', `${hits.length} things go by "${v}": ${hits.map((r) => r.id).join(', ')}; name one by its id`)
      : no('carry-name-unknown', `nothing in the copy goes by "${v}": look or find, then name it as shown or by its id`);
  }
  return out;
}

const walk = (ns, ground, [x, z]) => ({ verb: `${ns}:walk`, target: ground, params: { 1: [Math.round(x), 0, Math.round(z)] } });

/**
 * The intents a `carry` or `part` request sends, in order, or a refusal by name. `ctx`: `ns` (the world's form
 * namespace), `ground` (the open ground's id), `kinds` (the held entries), `me` (this Soul's body id), `placeOf(id)`
 * (a node's place in the world, {pos, rot} µm, or null), `kindOf(id)` (a node's entry kind), and `crewMiddle(crew)`
 * (where a crew's load is now, µm on the plan, or null).
 */
export function carryIntents(req, ctx) {
  const { ns, ground, kinds, me, placeOf, kindOf } = ctx;
  const usage = no(`${req.kind === 'part' ? 'part' : 'carry'}-usage`, USAGE[req.kind === 'part' ? 'part' : 'carry']);
  const id = (v) => ID.test(String(v ?? ''));
  if (!id(ground)) return no('carry-no-ground', 'no open ground in the copy yet: look first');
  if (req.kind === 'part') {
    if (!id(req.crew)) return usage;
    if (req.do === 'take' || req.do === 'unseat') return id(req.part) ? [{ verb: `part:${req.do}`, target: req.crew, params: { 1: req.part } }] : usage;
    if (req.do !== 'put') return usage;
    if (id(req.into)) {
      const at = placeOf(req.into), s = at && slotPoint(at, kinds[kindOf(req.into)], req.slot);
      if (!s) return no('part-slot-unknown', `${req.into} has no slot ${req.slot ?? '(none named)'} in its entry here`);
      return [{ verb: 'part:put', target: req.crew, params: { 1: req.into, 2: s.n } }];
    }
    const p = req.into === 'here' ? ctx.crewMiddle(req.crew) : pointOf(req.into);
    if (!p) return req.into === 'here' ? no('part-crew-unseen', `${req.crew} holds nothing the copy places`) : usage;
    return [{ verb: 'part:put', target: req.crew, params: { 1: ground, 3: [Math.round(p[0]), 0, Math.round(p[1])] } }];
  }
  switch (req.do) {
    case 'offer': {
      const to = [req.to].flat().filter((t) => t !== undefined);
      if (!to.length || to.length > 5 || !to.every(id) || (req.on !== undefined && !id(req.on))) return usage;
      const carry = carryEntryOf(kinds);
      if (!carry) return no('carry-kind-unknown', 'no carry entry among the kinds this machine holds (`kinds/`)');
      // The name the world serves the crew's activity by; worked out from its entry only for a world serving none.
      const pin = ctx.served?.activities?.find((a) => a?.kind === carry[0] && typeof a.name === 'string')?.name ?? activityPin(...carry);
      const front = `${carry[0].split(':')[0]}:front`;
      return [{ verb: 'activity:offer', target: req.on ?? ground, params: { 1: pin, 2: front, 3: to } }];
    }
    case 'accept': case 'decline': case 'leave':
      return id(req.crew) ? [{ verb: `activity:${req.do}`, target: req.crew }] : usage;
    case 'lift':
      return id(req.crew) && id(req.load) ? [{ verb: 'carry:lift', target: req.crew, params: { 1: req.load } }] : usage;
    case 'set-down':
      return id(req.crew) ? [{ verb: 'carry:set-down', target: req.crew }] : usage;
    case 'grip': {
      if (!id(req.thing) || !['front', 'back', 'left', 'right'].includes(req.end)) return usage;
      const at = placeOf(req.thing);
      if (!at) return no('carry-thing-unseen', `${req.thing} is not in the copy`);
      const from = req.from === undefined ? null : Number(req.from);
      if (from !== null && !(from > 0 && from < 10)) return no('carry-usage', '--from <metres, 0 to 10>');
      return [walk(ns, ground, gripSpot(at, loadOf(kinds[kindOf(req.thing)]), req.end, from === null ? null : from * M))];
    }
    case 'to': {
      if (!id(req.crew) || req.where === undefined) return usage;
      let dest = pointOf(req.where);
      if (!dest && id(req.where)) {
        const at = placeOf(req.where);
        if (!at) return no('carry-thing-unseen', `${req.where} is not in the copy`);
        if (req.slot !== undefined) {
          const s = slotPoint(at, kinds[kindOf(req.where)], req.slot);
          if (!s) return no('part-slot-unknown', `${req.where} has no slot ${req.slot} in its entry here`);
          dest = s.point;
        } else dest = [at.pos[0], at.pos[2]];
      }
      if (!dest) return usage;
      const mid = ctx.crewMiddle(req.crew), mine = placeOf(me);
      if (!mid) return no('carry-crew-unseen', `${req.crew} holds nothing the copy places: lift or take first`);
      if (!mine) return no('carry-me-unseen', 'this Soul\'s body is not in the copy yet: look first');
      const off = [mine.pos[0] - mid[0], mine.pos[2] - mid[1]];
      if (req.slot !== undefined) {
        // Into a slot, the crew lines up on the slot's own z (the way a slot holds a rack part, a frame's face or a
        // beam's length), each carrier at its end of the line and as far from the middle as it is now: so the part
        // goes in square, not turned by however its carriers happened to stand.
        const at = placeOf(req.where), s = slotPoint(at, kinds[kindOf(req.where)], req.slot);
        const crossed = crossedOnTheWay(req, ctx, at, s, mid);
        if (crossed) return crossed;
        const z = turn(times(at.rot ?? [ONE, 0, 0, 0], yawQuat(s.yaw)), [0, 0, M]), zf = Math.hypot(z[0], z[2]) || 1, u = [z[0] / zf, z[2] / zf];
        const side = off[0] * u[0] + off[1] * u[1] < 0 ? -1 : 1, d = Math.hypot(...off) * side;
        // Parameter 3, the load's heading there (from its back toward its front, µm on the plan): sent by the crew's
        // front, the world turns the whole crew with it as it walks; from any other carrier it is not read.
        const w = walk(ns, ground, [dest[0] + u[0] * d, dest[1] + u[1] * d]);
        w.params[3] = [Math.round(u[0] * side * M) || 0, Math.round(u[1] * side * M) || 0];
        return [w];
      }
      return [walk(ns, ground, [dest[0] + off[0], dest[1] + off[1]])];
    }
    default: return usage;
  }
}

/** sim::activity::carry::HEIGHT: a carried load's middle above its carriers' feet, µm. */
export const HEIGHT = 900_000;

/**
 * A part already seated in another slot of the bay a crew carries its load into, met on the straight way there at the
 * height the load is carried (0.135 C7: the world stops that carry, `souls:carry-blocked`, and sets its load down
 * under the part): a refusal naming it, before anyone moves; else null. On the bay's plan, the load lined up on the
 * slot's z as it goes in, its middle from `mid` to the slot; each seated part where its slot holds it. `ctx.seated(id)`
 * the parts in a node's slots ({id, slot}), `ctx.heldBy(crew)` the part a crew holds; without them nothing is read.
 */
function crossedOnTheWay(req, ctx, bay, s, mid) {
  const { kinds, kindOf, placeOf } = ctx, held = ctx.heldBy?.(req.crew), entry = kinds[kindOf(req.where)];
  const box = (id) => { const b = kinds[kindOf(id)]?.geometry?.bounds_mm; return Array.isArray(b) && b.length === 3 ? b.map((v) => v * 500) : null; };
  const hb = held && box(held), hp = held && placeOf(held);
  if (!hb || !hp || !ctx.seated) return null;
  // The load's half extents as it is held now (its turn in the copy), up and on the plan.
  const corners = [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [-1, 1].map((c) => turn(hp.rot ?? [ONE, 0, 0, 0], [a * hb[0], b * hb[1], c * hb[2]]))));
  const ext = [0, 1, 2].map((k) => Math.max(...corners.map((v) => Math.abs(v[k]))));
  const band = [HEIGHT - ext[1], HEIGHT + ext[1]], long = Math.max(ext[0], ext[2]), across = Math.min(ext[0], ext[2]);
  // Into the bay's frame (its turn about y only): x across the slots, z along them.
  const inv = [...(bay.rot ?? [ONE, 0, 0, 0])]; inv[1] = -inv[1]; inv[2] = -inv[2]; inv[3] = -inv[3];
  const local = ([x, z]) => { const p = turn(inv, [x - bay.pos[0], 0, z - bay.pos[2]]); return [p[0], p[2]]; };
  const [from, to] = [local(mid), local(s.point)];
  const names = Object.keys(entry?.slots ?? {});
  for (const p of ctx.seated(req.where)) {
    const name = names[p.slot - 1], at = entry?.slots?.[name]?.at_mm, pb = box(p.id);
    // A part with solids (a frame: its posts, at the slots' ends) is met as those, by the world's own check.
    if (p.id === held || name === s.name || !Array.isArray(at) || !pb || kinds[kindOf(p.id)]?.geometry?.solids_mm) continue;
    const q = [at[0] * 1000, at[2] * 1000], quarter = Math.abs((entry.slots[name].yaw_mdeg ?? 0) % 180_000) === 90_000;
    const [hx, hz] = quarter ? [pb[2], pb[0]] : [pb[0], pb[2]], up = [at[1] * 1000, at[1] * 1000 + 2 * pb[1]];
    if (up[0] >= band[1] || up[1] <= band[0]) continue;   // wholly under or over the load as it is carried
    if (meets(from, to, q, [across + hx, long + hz])) {
      return no('carry-way-crossed', `on the way to ${s.name}, the load meets the part in ${name} (${p.id}), seated ${Math.round(up[0] / 1000)} to ${Math.round(up[1] / 1000)} mm up, at the height it is carried (${Math.round(band[0] / 1000)} to ${Math.round(band[1] / 1000)} mm): bring it in from the bay's other side, or seat ${s.name} before ${name} (and take ${name} out first)`);
    }
  }
  return null;
}

/** Whether a point going straight from `a` to `b` comes inside the box of half sides `h` about `c` (touching is not). */
function meets(a, b, c, h) {
  let t0 = 0, t1 = 1;
  for (const k of [0, 1]) {
    const d = b[k] - a[k];
    if (d === 0) { if (Math.abs(a[k] - c[k]) >= h[k]) return false; continue; }
    const u = (c[k] - h[k] - a[k]) / d, v = (c[k] + h[k] - a[k]) / d;
    t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
    if (t0 >= t1) return false;
  }
  return true;
}

/** The crews in the copy: each carry activity, where it is and what it holds (its children). `rows`: the copy's rows. */
export function crewsIn(rows) {
  const all = [...rows.values()];
  return all.filter((r) => isCrew(r.kind)).map((r) => ({ id: r.id, on: r.parent, holds: all.filter((c) => c.parent === r.id).map((c) => ({ id: c.id, name: c.name, kind: c.kind })) }));
}

// Group work, as an agent finds and joins it: who needs hands near this Soul, an open crew offer accepted by its
// offerer's name, and what each step's answer says to do next. Plain facts from the copy and the kind entries; the
// world decides nothing here.

/** How many carry a load, as the world reads its entry (`sim::activity::carry::Load::of`): its `carry_crew`, else its
 *  `hold_crew`, else two; never fewer than a crew's front and back. */
export function crewNeeds(entry) {
  const n = entry?.state?.carry_crew?.default ?? entry?.state?.hold_crew?.default;
  return Math.max(2, Number.isInteger(n) ? n : 2);
}

/** Words for "whoever is near" in `carry offer anyone`: every other Soul within NEAR_M metres, nearest first. */
export const NEAR_WORDS = new Set(['anyone', 'everyone', 'near', 'nearby']);
export const NEAR_M = 20;
/** The most a crew is offered to at once (`carry offer`'s own limit). */
export const OFFER_MOST = 5;

/**
 * The crew offers to this Soul still open: each `offered` of kind carry it was told (`logged`, oldest first) whose crew
 * is still in the copy and does not hold this Soul yet. `mine`: this Soul's ids. → [{crew, from}], newest last.
 */
export function openCrewOffers(logged, rows, mine) {
  const seen = new Set(), out = [];
  for (const e of [...logged].reverse()) {
    if (e.kind !== 'carry' || e.what !== 'offered' || !e.offer || seen.has(e.offer)) continue;
    seen.add(e.offer);
    const r = rows.get(e.offer);
    if (!r || r.members?.some((m) => mine.includes(m.body) || mine.includes(m.soul))) continue;
    out.unshift({ crew: e.offer, from: e.from });
  }
  return out;
}

/**
 * `carry accept|decline [<crew id | name>]`: the crew by its id, by its offerer's name (`Ada`), or with no word the
 * newest open offer to this Soul. `offers`: `openCrewOffers`; `nameOf(id)`: a body's name. → {crew}, or a refusal by
 * name that says what to do instead.
 */
export function crewOffered(word, offers, nameOf) {
  if (ID.test(String(word ?? ''))) return { crew: word };
  if (!offers.length) return no('carry-no-offer', 'no crew offer to you is open: `look` shows the crews near (`work`) and who leads each; ask one (`say --to <name> "I can help"`) to offer you a place');
  if (word === undefined) return { crew: offers.at(-1).crew };
  const want = String(word).trim().toLowerCase();
  const hit = offers.filter((o) => String(nameOf(o.from) ?? '').toLowerCase() === want || o.from === word);
  if (hit.length) return { crew: hit.at(-1).crew };
  return no('carry-no-offer', `no open crew offer from ${String(word).slice(0, 40)}: the open ones are from ${offers.map((o) => nameOf(o.from) ?? o.from).join(', ')}`);
}

/**
 * Whom `carry offer anyone` asks: every other body within `within` metres, nearest first, at most OFFER_MOST.
 * `bodies`: [{id, m}] (metres from this Soul). → ids, or a refusal by name when nobody is near.
 */
export function offerNear(bodies, within = NEAR_M) {
  const near = bodies.filter((b) => Number.isFinite(b.m) && b.m <= within).sort((a, b) => a.m - b.m).slice(0, OFFER_MOST);
  return near.length ? near.map((b) => b.id) : no('carry-nobody-near', `no other Soul within ${within} m: shout what you need ("Who can help carry the rack frames?"), wait, then offer by name`);
}

const metresText = (m) => `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)} m`;

/**
 * "Who needs help?": the group work near this Soul as plain lines (`look`'s `work`): each crew offer to it still open,
 * with the command that joins it; then each crew near that it is not in: who is in it, what it holds and how many
 * hands that takes, and whom to ask. `crews`: `crewsIn(rows)`; `offers`: `openCrewOffers`; `nameOf(id)`; `metres(id)`
 * from this Soul (undefined when unplaced); `needs(id)`: how many carry a thing (`crewNeeds` of its entry);
 * `nearest(id)`: the name of the thing nearest a crew that holds none.
 */
export function workLines({ crews, rows, mine, offers, nameOf, metres, needs, nearest = () => null, within = 40, most = 4 }) {
  const out = [];
  for (const o of offers.slice(-2).reverse()) {
    const c = crews.find((x) => x.id === o.crew), held = c?.holds?.[0]?.name, by = nearest(o.crew), who = nameOf(o.from) ?? o.from;
    out.push(`${who} offers you a place in a carry crew${held ? ` holding ${held}` : by ? ` near ${by}` : ''} (${o.crew}): carry accept ${who}`);
  }
  const offered = new Set(offers.map((o) => o.crew)), membersOf = (id) => rows.get(id)?.members ?? [];
  const near = crews.filter((c) => !offered.has(c.id) && !membersOf(c.id).some((m) => mine.includes(m.body) || mine.includes(m.soul)))
    .map((c) => ({ c, m: Math.min(metres(c.id) ?? Infinity, ...membersOf(c.id).map((x) => metres(x.body) ?? Infinity)) }))
    .filter((x) => x.m <= within).sort((a, b) => a.m - b.m);
  for (const { c, m } of near) {
    if (out.length >= most) break;
    const members = membersOf(c.id), lead = members.find((x) => /:front$/.test(x.role)) ?? members[0];
    const load = c.holds?.[0], want = load ? needs(load.id) : null, short = want === null || members.length < want;
    const hands = want ? `, ${members.length} of ${want} hands${short ? `: ${want - members.length} more wanted` : ''}` : '';
    const at = load ? `holds ${load.name}` : nearest(c.id) ? `by ${nearest(c.id)}` : 'here';
    const ask = short && lead ? `; to help, ask ${nameOf(lead.body)}: say --to ${nameOf(lead.body)} "I can help"` : '';
    out.push(`a carry crew (${c.id}, ${metresText(m)}) ${at}: ${members.map((x) => nameOf(x.body)).join(', ') || 'nobody yet'}${hands}${ask}`);
  }
  return out;
}

/** What a step's answer says to do next, plainly (the `next` of `carry` and `part` answers). `req`: the request sent;
 *  `load`: the name of what the crew holds; `bay`: `slotsCard` of the thing a part was put into, when it was. */
export function nextStep(req, { load = null, bay = null } = {}) {
  const c = req.crew ?? '<crew id>';
  switch (req.kind === 'part' ? `part ${req.do}` : req.do) {
    case 'grip': return 'you are at your end: the one who leads offers the crew (carry offer <name>); each other accepts (carry accept <their name>)';
    case 'offer': return `wait for an accept (\`wait\` shows joined); then take or lift it (part take ${c} <part> | carry lift ${c} <load>) and say where it goes`;
    case 'accept': return `you are in the crew: be at your end (carry grip <load> back) before it is taken; when the front walks it (carry to ${c} <where>), you walk with it, keeping your place`;
    case 'lift': case 'part take': case 'part unseat': return `${load ?? 'it'} is up: say where it goes; the front sends carry to ${c} <x,z | bay id> [<slot>] and the crew walks with it, each in its place (into a slot, it turns the load square too)`;
    case 'to': return `when every carrier has arrived, one of you seats it (part put ${c} <bay id> <slot>) or sets it down (carry set-down ${c})`;
    case 'part put':
      if (bay?.left?.length) return `seated: ${bay.built}; still to fill: ${bay.left.join(', ')}. A seated frame stays held while one of you stays in its crew; the others: carry leave ${c}`;
      if (bay) return `seated: ${bay.built}, so it is built: everyone in its crews can let go (carry leave <crew id>)`;
      return `laid down: carry leave ${c} when you are done`;
    case 'set-down': return `set down: lift it again, or let go (carry leave ${c})`;
    case 'leave': return 'you let go: `look` shows the crews near that still want hands';
    default: return null;
  }
}
