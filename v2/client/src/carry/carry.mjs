// Carrying together and building with parts (0.135 C and A lanes) by a Soul's own commands. The world already takes
// each step as an intent through the gateway (`worldd/src/engine.rs`: `activity:offer|accept|leave`, `carry:lift`,
// `carry:set-down`, `part:take|put|unseat`); here each command is the intents it sends, built from the copy and the
// kind entries held in `<home>/kinds/`, with no daemon and no world, so it is read and tested on its own. No new world
// path: a walk is the Soul's own `<ns>:walk` to a point, as any walk.
//
//   carry offer <body id> [<body id> ...] [--on <thing id>]   a crew (the carry entry's activity, this Soul in front),
//                                     offered to those bodies on the open ground, or on a part to hold it where it stands
//   carry accept|decline <offer id>   joins the crew, or declines; carry leave <crew id> lets go (always taken)
//   carry grip <thing id> front|back|left|right|side <n> [--from <m>] [--out <m>]   walks to that end of a load (its
//                                     grip's place, from its entry, as for one lying when it stands on the floor;
//                                     beside the edges of a part that stands in a stand or a bay, 0.49 m off each
//                                     along its wider side: `part take` holds it at its edges), beside it along its
//                                     own x (1.2 m), or to the n-th side carrier's place, beside a grip between its
//                                     ends; front or back --out <m>: that far off its line, away from the middle of what
//                                     it is seated in (an unseated part comes down at its carriers' middle: outside)
//   carry grip <load> left|right <n>  beside its n-th grip between its ends, from its back: a side carrier's (spot.mjs)
//   carry lift <crew id> <load id>    lifts a load with the crew (`carry:lift`)
//   carry to <crew id> <x,z | thing id> [<slot>] [--go <time>]   walks this Soul so the crew's load reaches there (its
//                                     middle, or a bay's slot), keeping this Soul's place at the load. The front's
//                                     walks the whole crew (the world keeps each carrier's place) and, into a slot or
//                                     a loading spot's bay, turns it square (the walk names the load's heading there,
//                                     parameter 3); the others may send their own, at the moment --go names when it
//                                     names one
//   carry to <crew id> the loading spot   into the spot's first free bay that takes the load (spot.mjs)
//   carry set-down <crew id>          sets the lifted load down where it is
//   carry list                        the crews in the copy, each with what it holds
//   part take|unseat <crew id> <part id>   the crew takes a loose part, or one out of a bay or stand
//   part put <crew id> <bay id> <slot name | number>   seats the crew's part in that slot
//   part put <crew id> here | x,z     lays it on the open ground, under the crew or at that point
//
// Points are metres in the world's frame (x east, z south). The asked Soul's `wait` shows the offer and how long it
// has left: `{"kind":"carry","what":"offered","offer":..,"from":..,"open_s":60,"note":..}`; a crew offered to several
// adds `each_accept_s` and `open_most_s`: each accept keeps it open that much more for the rest, never past the most.

import { createHash } from 'node:crypto';
import { isSpot, sideSpot, toSpot } from './spot.mjs';

export const CARRY_ENTRY = 'mars:carry';
const ID = /^[0-9a-f]{32}-\d+$/;
const M = 1_000_000;
/** sim::activity::carry::REACH: a carrier stands this far beyond its grip, µm. */
export const REACH = 350_000;
/** sim::activity::carry::SIDE_REACH: a side carrier stands this far off its load's side, µm (#5067: room to stand on
 * when the part is seated beside it). */
export const SIDE_REACH = 450_000;
/** How far beyond the edge of a part that stands upright in a stand or a bay (no long axis on the plan) each of its
 * two carriers stands, along its wider side on the plan, µm (#5067). `part:take` holds a standing part at its edges
 * along the line its carriers stand on and refuses a carrier more than 0.7 m from its hold (`part.grip-out-of-reach`),
 * so its carriers stand beside its edges: 1.1 m from the middle of a 1.22 m rack frame, clear of a frame stand's walk
 * box (1.05 m) and of the frame's own columns in a bay (0.95 m). It was 2.2 m off its faces, 2.16 m from the hold. One
 * standing on the floor is lifted as one lying. */
export const STANDING_OFF = 490_000;
/** Where a crew stands from a thing of no entry, as from a part standing, µm. */
export const STANDING_FROM = 2_200_000;
/** Where a holder stands beside a part, along its own x, µm: 0.135 A3's change of crew. */
export const BESIDE = 1_200_000;
const ONE = 2 ** 30;
const no = (code, detail) => ({ code, detail });

export const USAGE = {
  carry: 'carry offer <name or body id> [...] [--on <thing id>] | carry accept|decline <offer id> | carry leave <crew id> | carry grip <thing id> front|back|left|right [<n>]|side <n> [--from <m>] [--out <m>] | carry lift <crew id> <load id> | carry to <crew id> <x,z | thing id> [<slot>] [--go <hh:mm:ss>] | carry to <crew id> the loading spot | carry set-down <crew id> | carry list',
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
  // standing (its length is its height): its wider side on the plan, its own x or z, where its carriers hold its edges
  const wide = b[0] >= b[2] ? 0 : 2;
  return { axis, long, halfLength: b[axis] * 500, halfWidth, wide, inner, middle: [0, b[1] * 500, 0], places: [along[0] - REACH, along.at(-1) + REACH] };
}

/** `v` turned by the quaternion `q` ([w, x, y, z], any scale), as the copy's poses hold it. */
export function turn(q, v) {
  const n = Math.hypot(...q) || 1, [w, x, y, z] = q.map((c) => c / n);
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}

/**
 * Where a carrier stands at a thing for its `end`, on the plan, µm. Front or back: on a load that lies, its place along
 * its long axis (front at the + end); on one that stands (a frame): `floor` (it stands on the open ground, as a frame
 * set down does), along its own z, front at +, its places as `carry:lift` checks them on that line (REACH beyond its
 * outermost grips: the 2.4 m frame's 1.13 m out, the 6.1 m frame's 3.1 m; #5067, where 2.2 m was 1.42 m from the 2.4 m
 * frame's grip and refused `carry-grip-out-of-reach`); else (in a stand or a bay, to be taken standing) beside its
 * edges, along its wider side on the plan (a frame's own x), front at +, STANDING_OFF beyond each edge (`from`, when
 * given, is from its middle along that line). A thing of no entry: 2.2 m along its z. Left or right is beside it
 * along its own x, `from` (default 1.2 m), right at +. `side<n>` is the n-th side carrier's place
 * (`sim::activity::carry::Load::side_places`): beside its n-th grip between its ends, counted from the back, along the
 * line its front and back stand on, half its width and SIDE_REACH off that line, the first on its + side, then alternating;
 * null when it has no such grip. `from` in µm; `at`: the thing's place in the world ({pos, rot}). `away`, for front or
 * back: `{ by, from }`, the spot moved `by` µm across the line, on the side away from the point `from` (µm on the plan:
 * the middle of what the thing is seated in), so a part unseated to its carriers' middle comes down outside its bay.
 */
export function gripSpot(at, load, end, from = null, away = null, floor = false) {
  const rot = at.rot ?? [ONE, 0, 0, 0], sign = end === 'front' || end === 'right' ? 1 : -1;
  const mid = turn(rot, load?.middle ?? [0, 0, 0]).map((c, k) => c + at.pos[k]);
  const unit = (v) => { const f = Math.hypot(v[0], v[2]) || 1; return [v[0] / f, v[2] / f]; };
  const v = load ? turn(rot, load.long) : [0, 0, 0], flat = Math.hypot(v[0], v[2]);
  const lies = load && 2 * flat >= load.halfLength;
  // The line its front and back stand on: its long axis lying; standing on the floor (to be lifted and laid along
  // that line), its own z; standing in a stand or a bay (to be taken as it stands, held at its edges), its wider side.
  const edges = load && !lies && !floor;
  const line = lies ? unit(v) : unit(turn(rot, edges && load.wide === 0 ? [M, 0, 0] : [0, 0, M]));
  const side = /^side([1-4])$/.exec(end);
  if (side) {
    const k = Number(side[1]) - 1, along = load?.inner?.[k];
    if (along === undefined) return null;
    const across = (load.halfWidth + SIDE_REACH) * (k % 2 === 0 ? 1 : -1);
    return [mid[0] + line[0] * along - line[1] * across, mid[2] + line[1] * along + line[0] * across];
  }
  if (end === 'left' || end === 'right') {
    // Beside it, along its own x (a frame's face, a beam's side): a holder's place.
    const x = unit(turn(rot, [M, 0, 0])), d = (from ?? BESIDE) * sign;
    return [mid[0] + x[0] * d, mid[2] + x[1] * d];
  }
  const d = from != null ? from * sign : load && (lies || floor) ? load.places[end === 'front' ? 1 : 0]
    : edges ? (load.halfWidth + STANDING_OFF) * sign : STANDING_FROM * sign;
  const p = [mid[0] + line[0] * d, mid[2] + line[1] * d];
  if (!away) return p;
  // Across the line, the side its middle lies from `away.from` (both ends the same side).
  const n = [-line[1], line[0]], s = Math.sign((mid[0] - away.from[0]) * n[0] + (mid[2] - away.from[1]) * n[1]) || 1;
  return [p[0] + n[0] * away.by * s, p[1] + n[1] * away.by * s];
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
    let named = all.filter((r) => [r.name, ...(r.aliases ?? [])].some((n) => String(n ?? '').trim().toLowerCase() === want));
    // None by the whole name: as said ("the loading spot" for `loading-spot`), dashes and underscores as spaces.
    const said = (n) => String(n ?? '').trim().toLowerCase().replace(/^the\s+/, '').replace(/[\s_-]+/g, ' ');
    if (!named.length) named = all.filter((r) => [r.name, ...(r.aliases ?? [])].some((n) => said(n) === said(v)));
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
/** A walk with the crew's load's heading at its end (parameter 3, from its back toward its front, µm on the plan): sent
 *  by the crew's front, the world turns the whole crew with it as it walks; from any other carrier it is not read. */
const heading = (w, h) => {
  if (h) w.params[3] = [Math.round(h[0] * M) || 0, Math.round(h[1] * M) || 0];
  return w;
};

/**
 * The intents a `carry` or `part` request sends, in order, or a refusal by name. `ctx`: `ns` (the world's form
 * namespace), `ground` (the open ground's id), `kinds` (the held entries), `me` (this Soul's body id), `placeOf(id)`
 * (a node's place in the world, {pos, rot} µm, or null), `kindOf(id)` (a node's entry kind), `parentOf(id)` (the node
 * it is in, for `grip --out`), and `crewMiddle(crew)`
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
      if (req.n !== undefined && (req.end === 'left' || req.end === 'right')) {
        // A side carrier's place (spot.mjs): beside the load's n-th grip between its ends, from its back.
        const s = /^[1-4]$/.test(String(req.n)) ? sideSpot(at, loadOf(kinds[kindOf(req.thing)]), req.end, Number(req.n)) : null;
        return s ? [walk(ns, ground, s)] : no('carry-grip-unknown', `${req.thing} has no grip ${req.n} between its ends (count from its back, 1 to ${loadOf(kinds[kindOf(req.thing)])?.inner.length ?? 0})`);
      }
      // --out: off the line, outside what the part is seated in (a rail lifted off its posts comes down clear of them).
      const out = req.out === undefined ? null : Number(req.out);
      if (out !== null && !(out > 0 && out < 5 && (req.end === 'front' || req.end === 'back'))) return no('carry-usage', 'front|back --out <metres, 0 to 5>');
      const bay = out === null ? null : ctx.parentOf?.(req.thing), bayAt = bay && bay !== ground ? placeOf(bay) : null;
      if (out !== null && !bayAt) return no('carry-out-unseated', `${req.thing} is not seated in anything here: --out stands outside what a part is seated in`);
      const away = bayAt ? { by: out * M, from: [bayAt.pos[0], bayAt.pos[2]] } : null;
      // A part standing on the floor (a frame set down) is lifted where its grips are (#5067); one in a stand, from clear of it.
      const floor = ctx.parentOf?.(req.thing) === ground;
      const load = loadOf(kinds[kindOf(req.thing)]), spot = gripSpot(at, load, req.end, from === null ? null : from * M, away, floor);
      // A side stands at a grip between the ends: a load with fewer such grips takes fewer (sim's carry-crew-too-large).
      const inner = load?.inner?.length ?? 0;
      if (!spot) return no('carry-grip-unknown', `${req.thing} has ${inner} grip${inner === 1 ? '' : 's'} between its ends, so no ${req.end.replace('side', 'side ')}: a crew of ${2 + inner} at most carries it`);
      return [walk(ns, ground, spot)];
    }
    case 'to': {
      if (!id(req.crew) || req.where === undefined) return usage;
      if (req.slot === undefined && id(req.where) && isSpot(kinds[kindOf(req.where)])) {
        // A loading spot (spot.mjs): its first free bay that takes the crew's load, square in it.
        const s = toSpot(req, ctx, req.where);
        return s.code ? s : Object.assign([heading(walk(ns, ground, s.point), s.heading)], { bay: s.bay });
      }
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
        // or a frame's face on z), its front and back at their ends of that line, each as far from the middle as it is
        // now: so the part goes in square, not turned by however its carriers happened to stand. A side keeps its place
        // along and across the line, beside its grip.
        const at = placeOf(req.where), s = slotPoint(at, kinds[kindOf(req.where)], req.slot);
        const q = times(at.rot ?? [ONE, 0, 0, 0], yawQuat(s.yaw)), flat = (v) => { const f = Math.hypot(v[0], v[2]) || 1; return [v[0] / f, v[2] / f]; };
        const sz = flat(turn(q, [0, 0, M])), sx = flat(turn(q, [M, 0, 0])), dot = (a, b) => a[0] * b[0] + a[1] * b[1];
        // The crew's line now, from its back to its front (`ctx.crewEnds`: their ids and places); without it, z.
        const ends = ctx.crewEnds?.(req.crew) ?? null, line = ends && [ends.at[0][0] - ends.at[1][0], ends.at[0][1] - ends.at[1][1]];
        const lf = line ? Math.hypot(...line) : 0;
        const w = lf ? [line[0] / lf, line[1] / lf] : null;
        let u = !w || Math.abs(dot(sz, w)) >= Math.abs(dot(sx, w)) ? sz : sx;
        if (w && dot(u, w) < 0) u = [-u[0], -u[1]];
        // A slot off the bay's middle across that line (a beam's, at the frames' posts) is reached from its own side:
        // the load stops lined up on the slot's axis outside the bay, and `part put` sets it in on the world's straight
        // track. Walks end within 0.3 m of their goal, so a beam carried in between two frames' posts (a few cm to
        // spare at each end) met a post whenever its crew had drifted (0.135, PR #4993's second bay).
        const mouth = mouthOf(ctx, req, at, s, u, mid);
        if (mouth) dest = mouth;
        const crossed = crossedOnTheWay(req, ctx, at, s, mid, mouth);
        if (crossed) return crossed;
        if (!w) {
          const side = dot(off, sz) < 0 ? -1 : 1, d = Math.hypot(...off) * side;
          return [heading(walk(ns, ground, [dest[0] + sz[0] * d, dest[1] + sz[1] * d]), [sz[0] * side, sz[1] * side])];
        }
        const end = ends.ids.includes(me);
        const along = end ? Math.hypot(...off) * (dot(off, w) < 0 ? -1 : 1) : dot(off, w), across = end ? 0 : off[1] * w[0] - off[0] * w[1];
        return [heading(walk(ns, ground, [dest[0] + u[0] * along - u[1] * across, dest[1] + u[1] * along + u[0] * across]), u)];
      }
      return [walk(ns, ground, [dest[0] + off[0], dest[1] + off[1]])];
    }
    default: return usage;
  }
}

/** sim::activity::carry::HEIGHT: a carried load's middle above its carriers' feet, µm. */
export const HEIGHT = 900_000;
/** The furthest ahead a `--go` moment may be, ms: a command waits for it within its daemon's patience (30 s). */
export const GO_MOST_MS = 20_000;

/** A `--go` word as Unix ms: digits are Unix ms; hh:mm:ss[.s] is today's time in UTC; else an ISO time. NaN when it is
 *  none of these. */
export function goTime(word, now = Date.now()) {
  const w = String(word ?? '');
  if (/^\d{10,}$/.test(w)) return Number(w);
  const t = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)Z?$/.exec(w);
  if (t) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +t[1], +t[2]) + Math.round(+t[3] * 1000); }
  return /T/.test(w) ? Date.parse(w) : NaN;
}

/** How far outside a bay's bounds a load lined up on its slot stops, µm: within worldd's PUT_REACH (1 m) of the slot,
 *  however short of its goal a walk ends (0.3 m). */
export const MOUTH_CLEAR = 200_000;

/** The part a crew holds and its half extents as it is held now (its turn in the copy): `ext` [x, up, z], the heights
 *  it spans as carried (`band`), and its half length and half width on the plan. Null when the copy cannot say. */
function heldExtent(ctx, crew) {
  const { kinds, kindOf, placeOf } = ctx, id = ctx.heldBy?.(crew), b = id && kinds[kindOf(id)]?.geometry?.bounds_mm, hp = id && placeOf(id);
  if (!Array.isArray(b) || b.length !== 3 || !hp) return null;
  const hb = b.map((v) => v * 500);
  const corners = [-1, 1].flatMap((a) => [-1, 1].flatMap((c) => [-1, 1].map((e) => turn(hp.rot ?? [ONE, 0, 0, 0], [a * hb[0], c * hb[1], e * hb[2]]))));
  const ext = [0, 1, 2].map((k) => Math.max(...corners.map((v) => Math.abs(v[k]))));
  return { id, ext, band: [HEIGHT - ext[1], HEIGHT + ext[1]], long: Math.max(ext[0], ext[2]), across: Math.min(ext[0], ext[2]) };
}

/**
 * Where a crew carrying into a bay's slot stops, on the plan, µm, when that slot is off the bay's middle across the
 * crew's line `u` (a beam's, at the frames' posts) and the crew is on the slot's side of the bay: on the slot's axis,
 * the load's middle `MOUTH_CLEAR` beyond the bay's bounds and its own half width, so `part put` sets it in from there.
 * Null for a slot on the bay's middle (a frame's, entering by its open end) or a crew across the bay from the slot,
 * which carries it straight in as before.
 */
function mouthOf(ctx, req, bay, s, u, mid) {
  const b = ctx.kinds[ctx.kindOf(req.where)]?.geometry?.bounds_mm;
  if (!Array.isArray(b) || b.length !== 3) return null;
  const a = [-u[1], u[0]], dot = (p, q) => p[0] * q[0] + p[1] * q[1], c = [bay.pos[0], bay.pos[2]];
  const o = dot([s.point[0] - c[0], s.point[1] - c[1]], a);
  if (Math.abs(o) < 100_000 || dot([mid[0] - c[0], mid[1] - c[1]], a) * o <= 0) return null;
  const flat = (v) => { const f = Math.hypot(v[0], v[2]) || 1; return [v[0] / f, v[2] / f]; };
  const rot = bay.rot ?? [ONE, 0, 0, 0], half = Math.abs(dot(a, flat(turn(rot, [M, 0, 0])))) * b[0] * 500 + Math.abs(dot(a, flat(turn(rot, [0, 0, M])))) * b[2] * 500;
  const out = Math.sign(o) * (half + (heldExtent(ctx, req.crew)?.across ?? 0) + MOUTH_CLEAR) - o;
  return [s.point[0] + a[0] * out, s.point[1] + a[1] * out];
}

/**
 * A part already seated in another slot of the bay a crew carries its load into, met on the straight way there at the
 * height the load is carried (0.135 C7: the world stops that carry, `souls:carry-blocked`, and sets its load down
 * under the part): a refusal naming it, before anyone moves; else null. On the bay's plan, the load lined up on the
 * slot's z as it goes in, its middle from `mid` to the slot; each seated part where its slot holds it. `ctx.seated(id)`
 * the parts in a node's slots ({id, slot}), `ctx.heldBy(crew)` the part a crew holds; without them nothing is read.
 */
function crossedOnTheWay(req, ctx, bay, s, mid, mouth = null) {
  const { kinds, kindOf } = ctx, held = heldExtent(ctx, req.crew), entry = kinds[kindOf(req.where)];
  const box = (id) => { const b = kinds[kindOf(id)]?.geometry?.bounds_mm; return Array.isArray(b) && b.length === 3 ? b.map((v) => v * 500) : null; };
  if (!held || !ctx.seated) return null;
  const { band, long, across } = held;
  // Into the bay's frame (its turn about y only): x across the slots, z along them.
  const inv = [...(bay.rot ?? [ONE, 0, 0, 0])]; inv[1] = -inv[1]; inv[2] = -inv[2]; inv[3] = -inv[3];
  const local = ([x, z]) => { const p = turn(inv, [x - bay.pos[0], 0, z - bay.pos[2]]); return [p[0], p[2]]; };
  const [from, to] = [local(mid), local(mouth ?? s.point)];
  const names = Object.keys(entry?.slots ?? {});
  for (const p of ctx.seated(req.where)) {
    const name = names[p.slot - 1], at = entry?.slots?.[name]?.at_mm, pb = box(p.id);
    // A part with solids (a frame: its posts, at the slots' ends) is met as those, by the world's own check.
    if (p.id === held.id || name === s.name || !Array.isArray(at) || !pb || kinds[kindOf(p.id)]?.geometry?.solids_mm) continue;
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
 * is still in the copy, does not hold this Soul yet and has not lapsed (a crew that formed stays in the copy after its
 * offer lapses). `mine`: this Soul's ids. → [{crew, from}], newest last.
 */
export function openCrewOffers(logged, rows, mine) {
  const seen = new Set(), out = [];
  for (const e of [...logged].reverse()) {
    if (e.what === 'lapsed' && e.conversation) seen.add(e.conversation);
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
