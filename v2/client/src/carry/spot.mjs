// A loading spot and the loads crews carry to it (0.135, the holy grail: Souls that each run their own agent carry heavy
// equipment to a loading spot together). Read from the copy and the kind entries only, like the rest of `carry.mjs`;
// the world sees nothing new: each carrier's own `<ns>:walk`, then one `carry:set-down`.
//
//   carry grip <load> left|right <n>   beside the load's n-th grip between its ends, counted from its back: a side
//                                      carrier's place (the n-th side to join the crew takes the n-th grip)
//   carry to <crew id> the loading spot   each carrier walks so the crew's load goes into the spot's first free bay that
//                                      takes it, square in it, each carrier keeping its place at the load
//
// A spot is a thing whose slots state what fits in them (`fits_mm`, its entry's section 6) and which loads they take
// (`kinds`): `content/kinds/construction/loading_spot.json`. A bay is taken while a thing on the ground has its middle
// inside the bay's footprint; a load another crew is carrying there takes it only once it is set down.

import { REACH, turn } from './carry.mjs';

const M = 1_000_000;
const ONE = 2 ** 30;
const no = (code, detail) => ({ code, detail });
const yawQuat = (mdeg) => { const h = (mdeg / 1000) * (Math.PI / 360); return [Math.cos(h) * ONE, 0, Math.sin(h) * ONE, 0]; };
const times = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : null; };

/** Whether an entry is a loading spot's: some slot states what fits in it. */
export const isSpot = (entry) => Object.values(entry?.slots ?? {}).some((s) => Array.isArray(s?.fits_mm));

/** How many must carry a load (`state.carry_crew`, else `state.hold_crew`, else two), as the world reads it. */
export const crewOf = (entry) => entry?.state?.carry_crew?.default ?? entry?.state?.hold_crew?.default ?? 2;

/**
 * Where a side carrier stands at a load (µm on the plan): beside its `n`-th grip between its ends, counted from its back
 * (its − end), REACH off its side (`sim::activity::carry::Load::side_places`), on its right (+ its own x, or + its own z
 * when it lies along x) or its left. Null when it has no such grip.
 */
export function sideSpot(at, load, side, n) {
  const g = load?.inner?.[n - 1];
  if (g === undefined) return null;
  const rot = at.rot ?? [ONE, 0, 0, 0], mid = turn(rot, load.middle).map((c, k) => c + at.pos[k]);
  const along = unit([turn(rot, load.long)[0], turn(rot, load.long)[2]]) ?? [0, 1];
  const x = turn(rot, load.axis === 0 ? [0, 0, M] : [M, 0, 0]), across = unit([x[0], x[2]]) ?? [1, 0];
  const d = (load.halfWidth + REACH) * (side === 'right' ? 1 : -1);
  return [mid[0] + along[0] * g + across[0] * d, mid[2] + along[1] * g + across[1] * d];
}

/**
 * The bays of a spot that take `kind`, each with its footprint in the world: `{n, name, point: [x, z] µm, axis: [x, z]
 * (its long side, a unit), half: [along, across] µm}`. `at`: the spot's place ({pos, rot}).
 */
export function baysOf(at, entry, kind) {
  const rot = at.rot ?? [ONE, 0, 0, 0];
  return Object.entries(entry?.slots ?? {}).map(([name, s], k) => ({ name, s, n: k + 1 }))
    .filter(({ s }) => Array.isArray(s.fits_mm) && Array.isArray(s.at_mm) && (!s.kinds?.length || s.kinds.includes(kind)))
    .map(({ name, s, n }) => {
      const p = turn(rot, s.at_mm.map((c) => c * 1000)).map((c, i) => c + at.pos[i]);
      const q = times(rot, yawQuat(Number.isInteger(s.yaw_mdeg) ? s.yaw_mdeg : 0)), [fx, , fz] = s.fits_mm;
      const v = turn(q, fz >= fx ? [0, 0, M] : [M, 0, 0]);
      return { n, name, point: [p[0], p[2]], axis: unit([v[0], v[2]]), half: [Math.max(fx, fz) * 500, Math.min(fx, fz) * 500] };
    });
}

/** Whether a point on the plan lies inside a bay's footprint. */
const inside = (bay, p) => {
  const d = [p[0] - bay.point[0], p[1] - bay.point[1]];
  return Math.abs(d[0] * bay.axis[0] + d[1] * bay.axis[1]) <= bay.half[0] && Math.abs(d[0] * bay.axis[1] - d[1] * bay.axis[0]) <= bay.half[1];
};

/**
 * `carry to <crew> <spot>` with no slot named: this Soul's walk so the crew's load goes into the spot's first free bay
 * that takes it, square in it (its length along the bay's), each carrier keeping its place at the load; or a refusal by
 * name: `carry-crew-unseen` (nothing lifted), `carry-crew-too-small`, `carry-spot-wrong-load`, `carry-spot-no-fit`,
 * `carry-spot-full`. `ctx` as `carryIntents` takes it, with `heldBy(crew)`, `crewEnds(crew)` ([front, back] on the
 * plan, µm), `crewSize(crew)` and `loose()` (the ids of things on the open ground). → {point: [x, z] µm, bay} or a refusal
 */
export function toSpot(req, ctx, spot) {
  const { kinds, kindOf, placeOf, me } = ctx;
  const held = ctx.heldBy?.(req.crew), mid = ctx.crewMiddle(req.crew);
  if (!held || !mid) return no('carry-crew-unseen', `${req.crew} holds nothing the copy places: lift the load first`);
  const kind = kindOf(held), entry = kinds[kind] ?? null, need = crewOf(entry), have = ctx.crewSize?.(req.crew);
  if (Number.isInteger(have) && have < need) return no('carry-crew-too-small', `${have} carrying ${kind}; it takes ${need}: offer the crew to ${need - have} more`);
  const at = placeOf(spot), bays = at ? baysOf(at, kinds[kindOf(spot)], kind) : [];
  if (!bays.length) return no('carry-spot-wrong-load', `no bay of ${spot} takes ${kind}`);
  // Its length and width on the plan, as it lies along its long side, against each bay's.
  const b = entry?.geometry?.bounds_mm, plan = Array.isArray(b) ? [Math.max(b[0], b[2]) * 500, Math.min(b[0], b[2]) * 500] : [0, 0];
  const fits = bays.filter((bay) => plan[0] <= bay.half[0] && plan[1] <= bay.half[1]);
  if (!fits.length) return no('carry-spot-no-fit', `${kind} (${plan.map((h) => Math.round(h / 500)).join(' by ')} mm) fits no bay of ${spot}`);
  const things = (ctx.loose?.() ?? []).filter((id) => id !== held && id !== spot).map((id) => ({ id, p: placeOf(id) })).filter((t) => t.p);
  const takenBy = (bay) => things.find((t) => inside(bay, [t.p.pos[0], t.p.pos[2]]));
  const bay = fits.find((x) => !takenBy(x));
  if (!bay) return no('carry-spot-full', `every bay of ${spot} that takes ${kind} is taken: ${fits.map((x) => `${x.name} by ${takenBy(x).id}`).join(', ')}`);
  // The crew turned about the load's middle so its length lies along the bay (the nearer way), then moved onto it.
  const ends = ctx.crewEnds?.(req.crew), a = ends ? unit([ends[0][0] - ends[1][0], ends[0][1] - ends[1][1]]) : null;
  let u = bay.axis;
  if (a && a[0] * u[0] + a[1] * u[1] < 0) u = [-u[0], -u[1]];
  const [c, s] = a ? [a[0] * u[0] + a[1] * u[1], a[0] * u[1] - a[1] * u[0]] : [1, 0];
  const mine = placeOf(me);
  if (!mine) return no('carry-me-unseen', 'this Soul\'s body is not in the copy yet: look first');
  const off = [mine.pos[0] - mid[0], mine.pos[2] - mid[1]];
  return { point: [bay.point[0] + c * off[0] - s * off[1], bay.point[1] + s * off[0] + c * off[1]], bay: bay.name };
}
