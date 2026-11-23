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
//   land extend --toward n|s|e|w|ne|nw|se|sw --metres m | --bounds x0,z0,x1,z1      the ground grows that way
//   expand <m>                                                         the ground grows to a centred square m a side
//
// Growing the ground (#3728, today's `expand` and `land extend`): new tiles, flat outward from the old ground's edge,
// and the world's extent, a place (`eden:extent`) whose outline the open ground is cut to, so Souls walk the new ground.
// It only grows.
//
// Not here: `smooth` (a brush that samples its neighbours is not folded onto tiles) and `move` of a landform. Each is
// refused by name.

import { decode, idText, plainKind } from '../../brief/copy.mjs';
import { F, bodiesUnder, changedCells, expand, grownTiles, heightAt, tileRange } from './terrain.mjs';

/** A body's radius and margin on the open ground (`sim::ground::HUMAN_RADIUS + MARGIN`), µm: the world's own. */
export const BODY_REACH_UM = 350_000;
const TILE_SIZE = 24;
/** The most operations one edit carries (`replica::edit::OPS_MOST`). */
const OPS_MOST = 256;
/** The most bytes one creator's edit carries (`replica::intents::BULK_MOST`), less room for the rest of the edit. */
const EDIT_BYTES = (8 << 20) - (64 << 10);
/** What a place that is the world's extent is derived from (field 20): data, as `eden:landform` is. */
const EXTENT = 'eden:extent';

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
  let placeKind = null, extent = null;
  for (const [id, m] of records) {
    if (m.get(3) === undefined || idText(m.get(3)) !== ground.id) continue;
    const kind = String(m.get(2));
    const f = m.get(6) instanceof Map ? m.get(6) : new Map();
    if (plainKind(kind) === 'eden:place') {
      placeKind ??= kind;
      if (f.has(F.WATER_LEVEL)) waters.set(id, { level: num(f.get(F.WATER_LEVEL)) });
      if (f.get(F.PLACE_OF) === EXTENT) extent = { id, outline: (f.get(F.OUTLINE) ?? []).map(([x, z]) => [num(x) / 1000, num(z) / 1000]) };
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
  return { id: ground.id, tileMm: num(ground.f.get(TILE_SIZE)), tiles, things, bodies, placeKind: placeKind ?? 'eden:place', waters, extent };
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
    default: throw Object.assign(new Error(`land raise, lower, flatten, knoll, hill, mountain, plateau, terrace, valley, ditch, cliff, pond, lake, water or extend, not ${verb}`), { code: 'land.verb' });
  }
}

const COMPASS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
const WORDS = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
const boxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

/** The bounds ([x0, z0, x1, z1] m) `expand <m>` or `land extend` asks for, from the world's extent now `cur`. */
export function boundsOf(a, cur) {
  if (a.land !== 'extend') {
    const h = n(a.extent, 'extent', 1, 16000) / 2;
    return [Math.min(cur[0], -h), Math.min(cur[1], -h), Math.max(cur[2], h), Math.max(cur[3], h)];
  }
  if (a.bounds !== undefined) {
    const b = String(a.bounds).split(',').map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite) || !(b[2] > b[0] && b[3] > b[1])) throw Object.assign(new Error('--bounds x0,z0,x1,z1 in metres'), { code: 'land.flag' });
    return [Math.min(cur[0], b[0]), Math.min(cur[1], b[1]), Math.max(cur[2], b[2]), Math.max(cur[3], b[3])];
  }
  const k = String(a.toward ?? '').toLowerCase().replace(/[^a-z]/g, ''), dir = COMPASS[k] ?? COMPASS[WORDS[k] ?? ''];
  if (!dir) throw Object.assign(new Error('extend needs --toward n, s, e, w, ne, nw, se or sw, and --metres'), { code: 'land.flag' });
  const d = n(a.metres, 'metres', 1, 8000);
  return [cur[0] - (dir[0] < 0 ? d : 0), cur[1] - (dir[1] < 0 ? d : 0), cur[2] + (dir[0] > 0 ? d : 0), cur[3] + (dir[1] > 0 ? d : 0)];
}

/** The batch that grows the open ground (`expand <m>`, `land extend`): the new tiles with the old, the extent place
 *  made or its outline set, and a move for each thing resting off the old tiles whose ground the new ones raise. */
export function extentOps(g, a) {
  const side = g.tileMm / 1000;
  const tb = boxOf(g.tiles.flatMap((t) => [[t.tx * side, t.tz * side], [(t.tx + 1) * side, (t.tz + 1) * side]]));
  const cur = g.extent?.outline.length ? boxOf(g.extent.outline) : tb;
  let b;
  try { b = boundsOf(a, cur); } catch (e) { return no(e.code ?? 'land.flag', e.message); }
  if (b[2] - b[0] > 16000 || b[3] - b[1] > 16000) return no('land.flag', `the world would be ${b[2] - b[0]} by ${b[3] - b[1]} m; each side at most 16000 m`);
  // Sized before it is made: the tiles go whole in one edit.
  const r = tileRange(g.tiles, g.tileMm, b), count = g.tiles.length + (r[2] - r[0] + 1) * (r[3] - r[1] + 1) - (() => { const o = tileRange(g.tiles); return (o[2] - o[0] + 1) * (o[3] - o[1] + 1); })();
  const perTile = g.tiles[0].heights.length * 4 + g.tiles[0].classes.length + 16;
  if (count * perTile > EDIT_BYTES) {
    const most = Math.floor(EDIT_BYTES / perTile), across = Math.floor(Math.sqrt(most)) * side;
    return no('expand.too-large', `the ground would be ${count} tiles of ${side} m (${Math.round((count * perTile) / 1e5) / 10} MB); one edit carries at most ${most} (about ${across} m square)`);
  }
  const added = grownTiles(g.tiles, g.tileMm, b);
  if (!added.length && b.every((v, k) => v === cur[k])) return no('expand.nothing', `the world already reaches [${cur.join(', ')}] m`);
  const tiles = [...g.tiles, ...added];
  const outside = (p) => heightAt(g.tiles, g.tileMm, p[0], p[2]) === null;
  const under = g.bodies.filter((x) => outside(x.position) && (heightAt(added, g.tileMm, x.position[0], x.position[2]) ?? 0n) !== 0n);
  if (under.length) return no('edit.terrain-under-soul', under.map((x) => `${x.id} stands at (${Number(x.position[0]) / 1e6}, ${Number(x.position[2]) / 1e6}) m, where the new ground is not at 0`).join('; '));
  const outline = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, z]) => [Math.round(x * 1000), Math.round(z * 1000)]);
  const hexOf = (u) => ({ hex: Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('hex') });
  const ops = [
    { op: 'set', node: g.id, field: F.TILES, value: tiles.map((t) => [t.tx, t.tz, hexOf(t.heights), hexOf(t.classes)]) },
    g.extent
      ? { op: 'set', node: g.extent.id, field: F.OUTLINE, value: outline }
      : { op: 'place', name: 1, kind: g.placeKind, in: g.id, at: [0, 0, 0], fields: { [F.OUTLINE]: outline, [F.PLACE_OF]: EXTENT } },
  ];
  for (const th of g.things) {
    if (!outside(th.position)) continue;
    const rise = heightAt(added, g.tileMm, th.position[0], th.position[2]) ?? 0n;
    if (rise !== 0n) ops.push({ op: 'move', node: th.id, atUm: [Number(th.position[0]), Number(th.position[1] + rise), Number(th.position[2])], orientation: th.orientation, support: th.support });
  }
  if (ops.length > OPS_MOST) return no('land.too-many-things', `${ops.length - 2} things rest where the new ground rises; one edit moves at most ${OPS_MOST - 2}`);
  return { ops, says: `the world reaches [${b.join(', ')}] m: ${added.length} new tile(s) of ${side} m, ${tiles.length} in all` };
}

/** The batch a land verb makes on `copy` (`a` its flags, `a.land` the verb and `a.ref`), or `expand`'s (`a.verb`,
 *  `a.extent`); or a refusal by name. */
export function landOps(copy, a) {
  const g = groundOf(copy);
  if (!g || !g.tiles.length || !g.tileMm) return no('land.no-ground', 'this world has no open ground with tiles');
  if (a.verb === 'expand' || a.land === 'extend') return extentOps(g, a);
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
  if (out.ops.length > OPS_MOST) {
    return no('land.too-many-things', `this landform would move ${moved} things resting on the ground; one edit moves at most ${OPS_MOST - 2}: shape a smaller area`);
  }
  return { ops: out.ops, says: `${made.says}: ${out.patched} tile(s) change${moved ? `, ${moved} resting thing(s) moved with the ground` : ''}` };
}
