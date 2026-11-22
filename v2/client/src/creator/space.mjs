// A creator's space reads (#3699 follow-on, today's `eden-god where`, `clear` and `free`), on Engine v2: read from the
// world the page draws on this machine (the public stream, in the headless browser `shoot` uses), so no world is asked
// and no edit is made. World metres, x east and z south, in plan.
//
//   where <x,z|name|id>                   the room and the areas it is in, and the nearest things
//   clear <x,z|name|id> --size WxD         whether a W x D footprint there is free of things and buildings, and what is in it
//   free WxD --near <x,z|name|id>          the nearest such footprint that is free, searched outward to FREE_M
//
// What fills ground is a thing's footprint (its solids, at any height) or a building's room outline; a thing the page
// draws with no solids counts as a disc of THING_M. Areas (a plaza, a quarter) hold ground and never fill it. Not here:
// the ground's height, slope and water (the page's terrain is not read), and `reach` (no route planner on the client).

import { join } from 'node:path';
import { findPlaywright, globalNodeModules, pageOf, withWorld } from '../shoot/shoot.mjs';

export const USAGE = 'where <x,z|name|id>  |  clear <x,z|name|id> --size WxD  |  free WxD --near <x,z|name|id>  [--page <url>]';
/** How far around the point things are gathered, m; how far `free` searches, m; its step, m; a solid-less thing, m. */
export const GATHER_M = 80, FREE_M = 60, STEP_M = 1, THING_M = 0.5;
const NEAREST = 6;

const fail = (code, detail) => Object.assign(new Error(detail), { code });
const size = (t) => {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(t ?? ''));
  if (!m || +m[1] <= 0 || +m[2] <= 0 || +m[1] > 500 || +m[2] > 500) throw fail('usage', `a size is WxD in metres, up to 500, not ${t}. ${USAGE}`);
  return [+m[1], +m[2]];
};

/** The arguments of `where`, `clear` or `free`. */
export function parseSpace(verb, args) {
  const a = [...args], take = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v; };
  const page = take('--page') ?? null;
  if (verb === 'where') { if (a.length !== 1) throw fail('usage', USAGE); return { verb, at: a[0], page }; }
  if (verb === 'clear') { const s = take('--size'); if (a.length !== 1) throw fail('usage', USAGE); return { verb, at: a[0], size: size(s), page }; }
  if (verb === 'free') { const near = take('--near'); if (a.length !== 1 || !near) throw fail('usage', USAGE); return { verb, at: near, size: size(a[0]), page }; }
  throw fail('usage', USAGE);
}

/**
 * Runs in the page (serialized: it uses nothing from this module). The point `asked` names (`x,z`, or a name or id
 * the page's capture resolves), and what fills or holds ground within `reach` m of it.
 */
export function gatherSpace([asked, reach]) {
  const v = globalThis.v2, w = v.world, t = v.director.t ?? null;
  const plain = (k) => String(k).split('@')[0];
  const SKIP = new Set(['souls:place', 'eden:world', 'eden:ground', 'eden:floor', 'eden:window', 'eden:doorway']);
  const ap = (m, x, y, z) => { const e = m.elements; return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
  const at = (id) => {
    const n = w.nodes.get(id);
    if (!n) return null;
    const p = t === null ? null : w.tracks.get(id)?.at(t);
    return p ? ap(w.frame(n.parent), p[0] * 1e-6, p[1] * 1e-6, p[2] * 1e-6) : ap(w.frame(id), 0, 0, 0);
  };
  const spots = v.capture.where(), byId = new Map(spots.map((s) => [s.id, s]));
  let point = null, named = null;
  const xz = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(asked);
  if (xz) point = [+xz[1], +xz[2]];
  else {
    const spot = v.capture.aim(asked, false)?.spot;
    if (!spot) return { code: 'nothing-by-that-name' };
    const p = at(spot.id);
    if (!p) return { code: 'nothing-by-that-name' };
    point = [p[0], p[2]], named = { id: spot.id, name: spot.name };
  }
  const near = ([x, z]) => Math.hypot(x - point[0], z - point[1]) <= reach;
  const fills = [], rooms = [], areas = [], things = [];
  for (const n of w.nodes.values()) {
    const kind = plain(n.kind), s = byId.get(n.id), name = s?.name ?? kind;
    if (n.outline?.length >= 3) {
      const outline = n.outline.map(([x, z]) => [x / 1000, z / 1000]);
      (kind === 'eden:room' ? rooms : areas).push({ id: n.id, name, outline }); // few; a big area holds far points
      if (kind === 'eden:room') continue;
    }
    if (SKIP.has(kind) || kind === 'eden:room') continue;
    const p = at(n.id);
    if (!p) continue;
    if (s?.role !== 'place' && near([p[0], p[2]])) things.push({ id: n.id, name, p: [p[0], p[2]], soul: s?.role === 'soul' });
    if (s?.role === 'soul') continue;
    if (n.solids?.length && n.at === null) {
      const f = w.frame(n.id), mm = 1e-3 * ((n.scale ?? 1_000_000) / 1_000_000);
      for (const [cx, cz, hx, hz, yaw] of n.solids) {
        const c = ap(f, cx * mm, 0, cz * mm);
        if (!near([c[0], c[2]]) && Math.hypot(hx, hz) * mm < reach) continue;
        const a = (yaw / 1000) * (Math.PI / 180), co = Math.cos(a), si = Math.sin(a);
        fills.push({ id: n.id, name, poly: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, k]) => {
          const x = u * hx * mm, z = k * hz * mm, q = ap(f, cx * mm + x * co + z * si, 0, cz * mm - x * si + z * co);
          return [q[0], q[2]];
        }) });
      }
    } else if (s?.role === 'thing' && near([p[0], p[2]])) fills.push({ id: n.id, name, disc: [p[0], p[2]] });
  }
  return { t, point, named, fills, rooms, areas, things };
}

// --- Plan geometry, pure ------------------------------------------------------------------------------------------

export function inside(poly, [x, z]) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) r = !r;
  }
  return r;
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const segs = (a, b, c, d) => cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
const rectOf = ([x, z], [w, d]) => [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]];
/** Whether two simple polygons overlap (an edge crosses, or one holds a corner of the other). */
export function overlap(p, q) {
  if (p.some((c) => inside(q, c)) || q.some((c) => inside(p, c))) return true;
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) if (segs(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
  return false;
}
const discHits = (rect, [cx, cz], r) => {
  const [[x0, z0], , [x1, z1]] = rect, dx = Math.max(x0 - cx, 0, cx - x1), dz = Math.max(z0 - cz, 0, cz - z1);
  return Math.hypot(dx, dz) < r;
};
const r1 = (n) => Math.round(n * 10) / 10;
const named = (x) => ({ id: String(x.id).replace(/\.(\d+)$/, '-$1'), name: x.name });

/** `where`: the room and areas holding the point, and the nearest things to it. */
export function whereOf(input) {
  const p = input.point;
  return {
    at: p.map(r1), ...(input.named ? { of: named(input.named) } : {}),
    room: input.rooms.filter((r) => inside(r.outline, p)).map(named)[0] ?? null,
    areas: input.areas.filter((a) => inside(a.outline, p)).map(named),
    nearest: input.things.filter((t) => !input.named || t.id !== input.named.id)
      .map((t) => ({ ...named(t), distance: r1(Math.hypot(t.p[0] - p[0], t.p[1] - p[1])), ...(t.soul ? { soul: true } : {}) }))
      .sort((a, b) => a.distance - b.distance).slice(0, NEAREST),
  };
}

/** What fills a W x D footprint centred at `p` (axis-aligned), by id, the asked-about thing aside. */
export function blocking(input, p, sz) {
  const rect = rectOf(p, sz), out = new Map();
  for (const f of input.fills) {
    if (input.named && f.id === input.named.id) continue;
    if (f.poly ? overlap(rect, f.poly) : discHits(rect, f.disc, THING_M)) out.set(f.id, named(f));
  }
  for (const r of input.rooms) if (overlap(rect, r.outline)) out.set(r.id, { ...named(r), room: true });
  return [...out.values()];
}

/** `clear`: whether the footprint at the point is free, and what is in it. */
export function clearOf(input, sz) {
  const b = blocking(input, input.point, sz);
  return { at: input.point.map(r1), size: sz, clear: b.length === 0, blocked_by: b };
}

/** `free`: the nearest free footprint, searched in square rings of STEP_M outward to FREE_M; null when none. */
export function freeOf(input, sz, most = FREE_M) {
  const [x0, z0] = input.point;
  let best = null;
  for (let k = 0; k * STEP_M <= most && !best; k++) {
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== k) continue;
      const p = [x0 + i * STEP_M, z0 + j * STEP_M], d = Math.hypot(i, j) * STEP_M;
      if (d > most || (best && best.d <= d)) continue;
      if (!blocking(input, p, sz).length) best = { p, d };
    }
  }
  return best ? { near: input.point.map(r1), size: sz, at: best.p.map(r1), distance: r1(best.d) } : { near: input.point.map(r1), size: sz, at: null, within: most };
}

/** `souls-god where|clear|free …`: read from the page drawn on this machine. */
export async function runSpace(verb, args, { home, env = {}, cwd = process.cwd(), pw } = {}) {
  const o = parseSpace(verb, args);
  const page = pageOf(o, home, env);
  const roots = [env.SOULS_PLAYWRIGHT, cwd, home];
  return withWorld({ address: page, profile: join(home, 'cache', 'shoot-browser'), size: [640, 360], pw: pw !== undefined ? pw : findPlaywright([...roots, globalNodeModules()]) }, async (p) => {
    const input = await p.evaluate(gatherSpace, [o.at, verb === 'free' ? GATHER_M + FREE_M : GATHER_M]);
    if (input.code) throw fail(input.code, `nothing called "${o.at}" in the page; give x,z or an id describe lists`);
    const out = verb === 'where' ? whereOf(input) : verb === 'clear' ? clearOf(input, o.size) : freeOf(input, o.size);
    return { ok: true, ...out, t: input.t };
  });
}
