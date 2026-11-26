// Carrying together and building with parts (0.135 C and A lanes) by a Soul's own commands. The world already takes
// each step as an intent through the gateway (`worldd/src/engine.rs`: `activity:offer|accept|leave`, `carry:lift`,
// `carry:set-down`, `part:take|put|unseat`); here each command is the intents it sends, built from the copy and the
// kind entries held in `<home>/kinds/`, with no daemon and no world, so it is read and tested on its own. No new world
// path: a walk is the Soul's own `<ns>:walk` to a point, as any walk.
//
//   carry offer <body id> [<body id> ...] [--on <thing id>]   a crew (the carry entry's activity, this Soul in front),
//                                     offered to those bodies on the open ground, or on a part to hold it where it stands
//   carry accept|decline <offer id>   joins the crew, or declines; carry leave <crew id> lets go (always taken)
//   carry grip <thing id> front|back|left|right|side <n> [--from <m>]   walks to that end of a load (its grip's place,
//                                     from its entry; a part that stands is taken at its own x, by its posts), beside
//                                     it along its own x (1.2 m), or to the n-th side carrier's place at a grip between
//   carry lift <crew id> <load id>    lifts a load with the crew (`carry:lift`)
//   carry to <crew id> <x,z | thing id> [<slot>]   walks this Soul so the crew's load reaches there (its middle, or a
//                                     bay's slot), keeping this Soul's place at the load: each carrier sends its own
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
/** Where a crew stands from a part that stands upright and whose entry names no grips, µm: 0.135 A3's frames. */
export const STANDING_FROM = 2_200_000;
/** Where a holder stands beside a part, along its own x, µm: 0.135 A3's change of crew. */
export const BESIDE = 1_200_000;
const ONE = 2 ** 30;
const no = (code, detail) => ({ code, detail });

export const USAGE = {
  carry: 'carry offer <name or body id> [...] [--on <thing id>] | carry accept|decline <offer id> | carry leave <crew id> | carry grip <thing id> front|back|left|right|side <n> [--from <m>] | carry lift <crew id> <load id> | carry to <crew id> <x,z | thing id> [<slot>] | carry set-down <crew id> | carry list',
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
  // its grips between its ends, from the back toward the front (a side carrier's each, at most four), and half its
  // width on the plan as it is carried: the larger of its other two sides
  const inner = along.slice(1, -1).slice(0, 4), halfWidth = Math.max(...[0, 1, 2].filter((i) => i !== axis).map((i) => b[i])) * 500;
  return { axis, long, halfLength: b[axis] * 500, halfWidth, inner, middle: [0, b[1] * 500, 0], places: [along[0] - REACH, along.at(-1) + REACH] };
}

/** `v` turned by the quaternion `q` ([w, x, y, z], any scale), as the copy's poses hold it. */
export function turn(q, v) {
  const n = Math.hypot(...q) || 1, [w, x, y, z] = q.map((c) => c / n);
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}

/**
 * Where a carrier stands at a thing for its `end`, on the plan, µm. Front or back: on a load that lies, its place along
 * its long axis (front at the + end); on one that stands (a frame), along its own x, by its posts, as far from its
 * middle as a lift checks its ends' places (`places`: a standing load's carriers' line, sim::activity::carry
 * `Load::check`), so the hands are at its edges and not 2.2 m off them; `from` instead when given (2.2 m along its z
 * for a part whose entry names no grips). Left or right is beside it along its own x, `from` (default 1.2 m), right at
 * +. `side<n>` is the n-th side carrier's place (`Load::side_places`): beside its n-th grip between its ends, counted
 * from the back, half its width and REACH off its line, the first on its + side, then alternating; null when it has no
 * such grip. `from` in µm; `at`: the thing's place in the world ({pos, rot}).
 */
export function gripSpot(at, load, end, from = null) {
  const rot = at.rot ?? [ONE, 0, 0, 0], sign = end === 'front' || end === 'right' ? 1 : -1;
  const mid = turn(rot, load?.middle ?? [0, 0, 0]).map((c, k) => c + at.pos[k]);
  const unit = (v) => { const f = Math.hypot(v[0], v[2]) || 1; return [v[0] / f, v[2] / f]; };
  const v = load ? turn(rot, load.long) : [0, 0, 0], flat = Math.hypot(v[0], v[2]);
  const lies = load && 2 * flat >= load.halfLength;
  // The line its front and back stand on: its long axis lying; standing, its own x.
  const line = lies ? unit(v) : unit(turn(rot, [M, 0, 0]));
  const side = /^side([1-4])$/.exec(end);
  if (side) {
    const k = Number(side[1]) - 1, along = load?.inner?.[k];
    if (along === undefined) return null;
    const across = (load.halfWidth + REACH) * (k % 2 === 0 ? 1 : -1);
    return [mid[0] + line[0] * along - line[1] * across, mid[2] + line[1] * along + line[0] * across];
  }
  if (end === 'left' || end === 'right') {
    // Beside it, along its own x (a frame's face, a beam's side): a holder's place.
    const x = unit(turn(rot, [M, 0, 0])), d = (from ?? BESIDE) * sign;
    return [mid[0] + x[0] * d, mid[2] + x[1] * d];
  }
  if (load) {
    const d = from != null ? from * sign : load.places[end === 'front' ? 1 : 0];
    return [mid[0] + line[0] * d, mid[2] + line[1] * d];
  }
  const z = unit(turn(rot, [0, 0, M])), d = (from ?? STANDING_FROM) * sign;
  return [mid[0] + z[0] * d, mid[2] + z[1] * d];
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
      if (!id(req.thing) || !/^(front|back|left|right|side[1-4])$/.test(String(req.end))) return usage;
      const at = placeOf(req.thing);
      if (!at) return no('carry-thing-unseen', `${req.thing} is not in the copy`);
      const from = req.from === undefined ? null : Number(req.from);
      if (from !== null && !(from > 0 && from < 10)) return no('carry-usage', '--from <metres, 0 to 10>');
      const load = loadOf(kinds[kindOf(req.thing)]), spot = gripSpot(at, load, req.end, from === null ? null : from * M);
      // A side stands at a grip between the ends: a load with fewer such grips takes fewer (sim's carry-crew-too-large).
      const inner = load?.inner?.length ?? 0;
      if (!spot) return no('carry-grip-unknown', `${req.thing} has ${inner} grip${inner === 1 ? '' : 's'} between its ends, so no ${req.end.replace('side', 'side ')}: a crew of ${2 + inner} at most carries it`);
      return [walk(ns, ground, spot)];
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
        // Into a slot, the crew lines up on the slot's own z or x, whichever its line now runs nearer (a beam's length
        // on z; a frame carried by its posts on x), its front and back at their ends of that line, each as far from
        // the middle as it is now: so the part goes in square, not turned by however its carriers happened to stand.
        // A side keeps its place along and across the line, beside its grip.
        const at = placeOf(req.where), s = slotPoint(at, kinds[kindOf(req.where)], req.slot);
        const crossed = crossedOnTheWay(req, ctx, at, s, mid);
        if (crossed) return crossed;
        const q = times(at.rot ?? [ONE, 0, 0, 0], yawQuat(s.yaw)), flat = (v) => { const f = Math.hypot(v[0], v[2]) || 1; return [v[0] / f, v[2] / f]; };
        const sz = flat(turn(q, [0, 0, M])), sx = flat(turn(q, [M, 0, 0])), dot = (a, b) => a[0] * b[0] + a[1] * b[1];
        // The crew's line now, from its back to its front (`ctx.crewEnds`: their ids and places); without it, z.
        const ends = ctx.crewEnds?.(req.crew) ?? null, line = ends && [ends.at[0][0] - ends.at[1][0], ends.at[0][1] - ends.at[1][1]];
        const lf = line ? Math.hypot(...line) : 0;
        if (!lf) {
          const d = Math.hypot(...off) * (dot(off, sz) < 0 ? -1 : 1);
          return [walk(ns, ground, [dest[0] + sz[0] * d, dest[1] + sz[1] * d])];
        }
        const w = [line[0] / lf, line[1] / lf];
        let u = Math.abs(dot(sz, w)) >= Math.abs(dot(sx, w)) ? sz : sx;
        if (dot(u, w) < 0) u = [-u[0], -u[1]];
        const end = ends.ids.includes(me);
        const along = end ? Math.hypot(...off) * (dot(off, w) < 0 ? -1 : 1) : dot(off, w), across = end ? 0 : off[1] * w[0] - off[0] * w[1];
        return [walk(ns, ground, [dest[0] + u[0] * along - u[1] * across, dest[1] + u[1] * along + u[0] * across])];
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
