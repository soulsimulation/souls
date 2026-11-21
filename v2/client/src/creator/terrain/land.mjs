// A creator's land and water (#3695, today's `eden-god land`): each verb is one landform (`packages/ground`'s record,
// as today's `apps/server/src/god/land.ts` makes it from the same flags and defaults), expanded on the daemon's copy of
// the open ground into one edit (`terrain.mjs`): the landform's place, the open ground's tiles with the changed ones
// patched, and a move for each thing resting where the ground rises or falls. The world refuses it whole if a Soul
// stands where the ground changes, a building stands there, or a resting thing is not moved (`sim::edit::terrain`);
// a Soul standing there is found here first, so nothing is sent. Walkers follow the new ground through G3 (the commit
// rebuilds the open ground and the walks planned on it).
//
//   land raise|lower|flatten --at x,z [--radius m] [--amount m] [--level m]
//   land knoll|hill|mountain --at x,z [--height m] [--radius m] [--peak 0.25..6]     (--path '[[x,z],...]': a ridge)
//   land plateau --rect cx,cz,w,d | --circle cx,cz,r | --area '[[x,z],...]' [--height m] [--edge m]
//   land terrace (an area as plateau) [--level m | --step m] [--edge m]
//   land valley|ditch --path '[[x,z],...]' [--depth m] [--width m] [--edge m]
//   land cliff --path '[[x,z],...]' [--height m] [--side 1|-1] [--face m] [--steps n] [--width m]
//   land pond|lake (an area as plateau) [--level m] [--depth m]          a water over a carved bed
//   land water <id> --level m | --by m                                 an existing water's level
//
// Not here: `smooth` (a brush that samples its neighbours is not folded onto tiles), `move` of a landform, and
// `extend` (the world's ground grows with #3728's `expand`). Each is refused by name.

import { decode, idText, plainKind } from '../../brief/copy.mjs';
import { F, bodiesUnder, changedCells, expand, heightAt } from './terrain.mjs';

/** A body's radius and margin on the open ground (`sim::ground::HUMAN_RADIUS + MARGIN`), µm: the world's own. */
export const BODY_REACH_UM = 350_000;
const TILE_SIZE = 24;

const no = (code, detail) => ({ ok: false, code, detail });
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

/** The open ground and what stands on it, from the copy: its id and tiles, the place kind its places use, the things
 *  resting on it (with their facing and support, as a move must keep them) and the bodies standing on it. */
export function groundOf(copy) {
  const roots = Object.values(JSON.parse(copy.roots()));
  const todo = [...roots], seen = new Set();
  let ground = null;
  const records = new Map();
  while (todo.length) {
    const hash = todo.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const m = decode(bytes);
    const id = idText(m.get(1));
    records.set(id, m);
    const f = m.get(6) instanceof Map ? m.get(6) : new Map();
    if (!ground && f.has(F.TILES)) ground = { id, m, f };
    for (const c of m.get(10) ?? []) todo.push(Buffer.from(c).toString('hex'));
  }
  if (!ground) return null;
  const tiles = (ground.f.get(F.TILES) ?? []).map(([tx, tz, h, c]) => {
    const b = Buffer.from(h);
    const heights = new Int32Array(b.length / 4);
    for (let i = 0; i < heights.length; i++) heights[i] = b.readInt32LE(i * 4);
    return { tx: num(tx), tz: num(tz), heights, classes: new Uint8Array(c) };
  });
  const things = [], bodies = [], waters = new Map();
  let placeKind = null;
  for (const [id, m] of records) {
    if (m.get(3) === undefined || idText(m.get(3)) !== ground.id) continue;
    const kind = String(m.get(2));
    const f = m.get(6) instanceof Map ? m.get(6) : new Map();
    if (plainKind(kind) === 'eden:place') {
      placeKind ??= kind;
      if (f.has(F.WATER_LEVEL)) waters.set(id, { level: num(f.get(F.WATER_LEVEL)) });
      continue;
    }
    const pose = m.get(7);
    if (!(pose instanceof Map)) continue;
    const frame = pose.get(1);
    if (Array.isArray(frame) && frame.length > 1) continue; // in a slot of the ground: not resting on it
    const position = (pose.get(2) ?? [0, 0, 0]).map(big);
    const link = (m.get(9) ?? []).map(([, l]) => l).find((l) => l instanceof Map && plainKind(l.get(1)) === 'souls:body-of');
    if (link) { bodies.push({ id, position }); continue; }
    const s = pose.get(4) instanceof Map ? pose.get(4) : new Map([[1, 0]]);
    const which = num(s.get(1));
    const support = { which, ...(s.has(2) ? { node: idText(s.get(2)) } : {}), ...(s.has(3) ? { height: num(s.get(3)) } : {}) };
    things.push({ id, position, orientation: (pose.get(3) ?? [1_000_000, 0, 0, 0]).map(num), support });
  }
  return { id: ground.id, tileMm: num(ground.f.get(TILE_SIZE)), tiles, things, bodies, placeKind: placeKind ?? 'eden:place', waters };
}

const pt = (v, what) => {
  const p = String(v ?? '').split(',').map(Number);
  if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) throw Object.assign(new Error(`--${what} x,z in metres, not ${v}`), { code: 'land.flag' });
  return p;
};
const list = (v, what, least) => {
  let p;
  try { p = JSON.parse(String(v)); } catch { p = null; }
  if (!Array.isArray(p) || p.length < least || p.some((q) => !Array.isArray(q) || q.length !== 2 || q.some((n) => !Number.isFinite(n)))) {
    throw Object.assign(new Error(`--${what} takes JSON like '[[x,z],[x,z]]', at least ${least} points`), { code: 'land.flag' });
  }
  return p;
};
const n = (v, what, lo, hi, d) => {
  if (v === undefined) {
    if (d === undefined) throw Object.assign(new Error(`--${what} is needed`), { code: 'land.flag' });
    return d;
  }
  const x = Number(v);
  if (!(x >= lo && x <= hi)) throw Object.assign(new Error(`--${what} is ${lo} to ${hi}, not ${v}`), { code: 'land.flag' });
  return x;
};
const r2 = (x) => Math.round(x * 100) / 100;
const circle = ([cx, cz], r, k = 24) => Array.from({ length: k }, (_, i) => [r2(cx + r * Math.cos((2 * Math.PI * i) / k)), r2(cz + r * Math.sin((2 * Math.PI * i) / k))]);
const box = (pts, pad) => {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad];
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
};
const areaOf = (a) => {
  if (a.area !== undefined) return list(a.area, 'area', 3);
  if (a.rect !== undefined) {
    const [cx, cz, w, d] = String(a.rect).split(',').map(Number);
    if (![cx, cz, w, d].every(Number.isFinite) || w <= 0 || d <= 0) throw Object.assign(new Error('--rect cx,cz,w,d'), { code: 'land.flag' });
    return [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];
  }
  if (a.circle !== undefined) {
    const [cx, cz, r] = String(a.circle).split(',').map(Number);
    if (![cx, cz, r].every(Number.isFinite) || r <= 0) throw Object.assign(new Error('--circle cx,cz,r'), { code: 'land.flag' });
    return circle([cx, cz], r);
  }
  throw Object.assign(new Error('give --rect cx,cz,w,d, --circle cx,cz,r or --area \'[[x,z],...]\''), { code: 'land.flag' });
};
const centre = (pts) => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
/** A path resampled every `step` metres (today's `resample`), so a channel's levels follow the ground. */
const resample = (path, step) => {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]], len = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.round(len / step));
    for (let j = 1; j <= k; j++) out.push([r2(a[0] + ((b[0] - a[0]) * j) / k), r2(a[1] + ((b[1] - a[1]) * j) / k)]);
  }
  return out.slice(0, 512);
};

/** The landform (and its outline, and water) a verb makes, as today's `landOps` does; `ground(x, z)` is metres. */
export function landformOf(verb, a, ground, id) {
  switch (verb) {
    case 'raise': case 'lower': case 'flatten': {
      const c = pt(a.at, 'at'), r = n(a.radius, 'radius', 1, 400, 12);
      const amount = verb === 'flatten' ? n(a.amount, 'amount', 0, 1, 1) : n(a.amount, 'amount', 0, 60, 3);
      const level = verb === 'flatten' ? n(a.level, 'level', -200, 400, r2(ground(c[0], c[1]))) : undefined;
      return { landform: { id, kind: 'brush', op: verb, c, r, amount, ...(level !== undefined ? { level } : {}) }, outline: circle(c, r), says: `${verb} ${r} m round ${c}` };
    }
    case 'knoll': case 'hill': case 'mountain': {
      const lim = { knoll: [0.5, 15, 4, 5, 60, 18], hill: [5, 60, 25, 20, 300, 80], mountain: [40, 400, 180, 60, 1200, 200] }[verb];
      const h = n(a.height, 'height', lim[0], lim[1], lim[2]), r = n(a.radius, 'radius', lim[3], lim[4], lim[5]);
      const peak = a.peak === undefined ? 1 : n(a.peak, 'peak', 0.25, 6);
      if (a.path !== undefined) {
        const path = list(a.path, 'path', 2);
        return { landform: { id, kind: 'ridge', path, w: r, h, peak }, outline: box(path, r), says: `a ${verb} ridge ${h} m high` };
      }
      const c = pt(a.at, 'at');
      return { landform: { id, kind: 'bump', c, r, h, peak }, outline: circle(c, r), says: `a ${verb} ${h} m high, ${r} m across at ${c}` };
    }
    case 'plateau': {
      const area = areaOf(a);
      return { landform: { id, kind: 'plateau', area, h: n(a.height, 'height', 0.5, 60, 4), edge: n(a.edge, 'edge', 1, 100, 10) }, outline: area, says: 'a plateau' };
    }
    case 'terrace': {
      const area = areaOf(a), c = centre(area);
      const t = a.step !== undefined ? { step: n(a.step, 'step', 0.3, 20) } : { level: n(a.level, 'level', -200, 400, r2(ground(c[0], c[1]))) };
      return { landform: { id, kind: 'terrace', area, ...t, edge: n(a.edge, 'edge', 0.5, 60, 4) }, outline: area, says: 'a terrace' };
    }
    case 'valley': case 'ditch': {
      const ctrl = list(a.path, 'path', 2), path = resample(ctrl, verb === 'ditch' ? 3 : 6);
      const depth = n(a.depth, 'depth', 0.2, 120, verb === 'ditch' ? 1 : 8), w = n(a.width, 'width', 0.5, 200, verb === 'ditch' ? 1.2 : 8);
      const edge = n(a.edge, 'edge', 0.5, 60, verb === 'ditch' ? 0.8 : Math.min(60, Math.max(4, depth * 2.5)));
      const levels = path.map(([x, z]) => r2(ground(x, z) - depth));
      return { landform: { id, kind: 'channel', path, levels, w, edge, mode: 'cut' }, outline: box(path, w / 2 + edge), says: `a ${verb} ${depth} m deep` };
    }
    case 'cliff': {
      const path = list(a.path, 'path', 2);
      const h = n(a.height, 'height', -120, 200, 10), side = n(a.side, 'side', -1, 1, 1) < 0 ? -1 : 1;
      const w = n(a.width, 'width', 0, 400, 30);
      return { landform: { id, kind: 'cliff', path, h, side, face: n(a.face, 'face', 0.5, 60, 3), steps: Math.round(n(a.steps, 'steps', 1, 12, 1)), w }, outline: box(path, w + 12), says: `a cliff ${h} m high` };
    }
    case 'pond': case 'lake': {
      const area = areaOf(a), c = centre(area);
      const level = n(a.level, 'level', -100, 400, r2(ground(c[0], c[1]) - 0.2));
      const depth = n(a.depth, 'depth', 0.2, 60, verb === 'pond' ? 1.2 : 4);
      return { landform: { id, kind: 'carve', area, bed: r2(level - depth), edge: n(a.edge, 'edge', 0.5, 60, verb === 'pond' ? 2 : 6) }, outline: area, water: { level }, says: `a ${verb}, its water at ${level} m over a bed ${depth} m deep` };
    }
    case 'smooth': throw Object.assign(new Error('smooth samples its neighbours and is not folded onto the tiles: use flatten'), { code: 'land.smooth' });
    case 'move': throw Object.assign(new Error('a landform is not moved: remove its place and shape the land again'), { code: 'land.move' });
    case 'extend': throw Object.assign(new Error('the ground grows with the world\'s expand'), { code: 'land.extend' });
    default: throw Object.assign(new Error(`land raise, lower, flatten, knoll, hill, mountain, plateau, terrace, valley, ditch, cliff, pond, lake or water, not ${verb}`), { code: 'land.verb' });
  }
}

/** The batch a land verb makes on `copy` (`a` its flags, `a.land` the verb and `a.ref`); or a refusal by name. */
export function landOps(copy, a) {
  const g = groundOf(copy);
  if (!g || !g.tiles.length || !g.tileMm) return no('land.no-ground', 'this world has no open ground with tiles');
  const metres = (x, z) => Number(heightAt(g.tiles, g.tileMm, BigInt(Math.round(x * 1e6)), BigInt(Math.round(z * 1e6))) ?? 0n) / 1e6;
  if (a.land === 'water') {
    const w = g.waters.get(String(a.ref ?? ''));
    if (!w) return no('land.no-water', `water <id of a pond, lake or river under the open ground>, not ${a.ref ?? 'nothing'}`);
    let level;
    try { level = a.level !== undefined ? n(a.level, 'level', -100, 400) : w.level / 1000 + n(a.by, 'by', -60, 60); } catch (e) { return no(e.code, e.message); }
    return { ops: [{ op: 'set', node: a.ref, field: F.WATER_LEVEL, value: Math.round(level * 1000) }], says: `the water's level is ${r2(level)} m` };
  }
  let made;
  try { made = landformOf(a.land, a, metres, `l_${Date.now().toString(36)}`); } catch (e) { return no(e.code ?? 'land.flag', e.message); }
  let out;
  try {
    out = expand({ ground: g, landform: made.landform, water: made.water, things: g.things, placeKind: g.placeKind, outline: made.outline });
  } catch (e) { return no('land.landform', String(e.message ?? e).slice(0, 300)); }
  if (out.patched === 0) return no('land.nothing', 'the landform changes no ground here: is it on the world\'s ground?');
  const under = bodiesUnder(changedCells(g.tiles, out.tiles, g.tileMm), g.bodies, BODY_REACH_UM);
  if (under.length) {
    return no('edit.terrain-under-soul', under.map((b) => `${b.id} stands at (${Number(b.position[0]) / 1e6}, ${Number(b.position[2]) / 1e6}) m, where the ground changes`).join('; '));
  }
  const moved = out.ops.filter((o) => o.op === 'move').length;
  return { ops: out.ops, says: `${made.says}: ${out.patched} tile(s) change${moved ? `, ${moved} resting thing(s) moved with the ground` : ''}` };
}
