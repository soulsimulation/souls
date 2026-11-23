// A creator's roads and areas (#3728, today's `eden-god place <def> --path | --area | --rect | --circle`): a thing laid
// on the open ground by its shape, as N1 imports Eden's footpaths, lawns and pitches (`v2/tools/import-eden`): placed
// at the ground's origin, its line (field 16) and width (field 17) for a path, and its outline (field 11) in mm; a
// path's outline is the ribbon its line and width make, which the page drapes on the ground (`v2/web` `drapes.ts`).
// A named area (`eden:place`) is derived from an area (field 20, `eden:area`), as N1's are.
//
//   place <kind> --path '[[x,z],...]' [--width m]     a road, a footpath, a hedge or a wall along a line (metres)
//   place <kind> --area '[[x,z],...]' | --rect cx,cz,w,d | --circle cx,cz,r      a lawn, a pitch, a bed, a place
//   [--in <id>] [--field n=v ...]                     the open ground unless named

/** N1's fields (`v2/tools/import-eden/src/lib.rs`). */
export const F = { OUTLINE: 11, LINE: 16, LINE_WIDTH: 17, PLACE_OF: 20 };
const Q = 1 << 30;
const no = (code, detail) => ({ ok: false, code, detail });
const mm = (pts) => pts.map(([x, z]) => [Math.round(x * 1000), Math.round(z * 1000)]);

const points = (v, flag, least) => {
  let p;
  try { p = JSON.parse(String(v)); } catch { p = null; }
  if (!Array.isArray(p) || p.length < least || p.some((q) => !Array.isArray(q) || q.length !== 2 || q.some((n) => !Number.isFinite(n)))) {
    return no('shape.flag', `--${flag} takes JSON like '[[x,z],[x,z]]' in metres, at least ${least} points`);
  }
  return p;
};
const numbers = (v, flag, n) => {
  const p = String(v ?? '').split(',').map(Number);
  return p.length === n && p.every(Number.isFinite) ? p : no('shape.flag', `--${flag} takes ${n} numbers in metres`);
};

/** The outline a line of `width` m makes: each side offset by half the width, joined at the ends. */
export function ribbon(line, width) {
  const h = width / 2, left = [], right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    left.push([line[i][0] + nx * h, line[i][1] + nz * h]);
    right.push([line[i][0] - nx * h, line[i][1] - nz * h]);
  }
  return [...left, ...right.reverse()];
}

/** The shape flags of `a` as metres: { line, width } or { area }; or a refusal; or null when none is given. */
export function shapeOf(a) {
  const given = ['path', 'area', 'rect', 'circle'].filter((k) => a[k] !== undefined);
  if (!given.length) return null;
  if (given.length > 1) return no('shape.flag', `one of --path, --area, --rect or --circle, not ${given.join(' and ')}`);
  if (a.path !== undefined) {
    const line = points(a.path, 'path', 2);
    if (line.ok === false) return line;
    const width = a.width === undefined ? 2 : Number(a.width);
    if (!(width > 0 && width <= 100)) return no('shape.flag', `--width is more than 0 and at most 100 m, not ${a.width}`);
    return { line, width };
  }
  if (a.width !== undefined) return no('shape.flag', '--width goes with --path');
  if (a.area !== undefined) { const area = points(a.area, 'area', 3); return area.ok === false ? area : { area }; }
  if (a.rect !== undefined) {
    const r = numbers(a.rect, 'rect', 4);
    if (r.ok === false) return r;
    const [cx, cz, w, d] = r;
    if (!(w > 0 && d > 0)) return no('shape.flag', '--rect cx,cz,w,d: w and d more than 0');
    return { area: [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]] };
  }
  const c = numbers(a.circle, 'circle', 3);
  if (c.ok === false) return c;
  const [cx, cz, r] = c;
  if (!(r > 0)) return no('shape.flag', '--circle cx,cz,r: r more than 0');
  return { area: Array.from({ length: 24 }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / 24), cz + r * Math.sin((2 * Math.PI * i) / 24)].map((v) => Math.round(v * 100) / 100)) };
}

/**
 * The place that lays `kind` by its shape (`shapeOf(a)`) in `parent` (the open ground's id unless `a.in` names one),
 * with `a.fields` ({ n: value }) beside it. Gives { ops, says } or a refusal by name.
 */
export function shapeOps(kind, a, ground) {
  const s = shapeOf(a);
  if (!s) return no('shape.flag', 'give --path, --area, --rect or --circle');
  if (s.ok === false) return s;
  const parent = a.in ?? ground;
  if (!parent) return no('shape.no-ground', 'this world has no open ground: name a parent with --in');
  const fields = { ...(a.fields ?? {}) };
  if (s.line) Object.assign(fields, { [F.LINE]: mm(s.line), [F.LINE_WIDTH]: Math.round(s.width * 1000), [F.OUTLINE]: mm(ribbon(s.line, s.width)) });
  else fields[F.OUTLINE] = mm(s.area);
  if (String(kind).split('@')[0] === 'eden:place' && fields[F.PLACE_OF] === undefined) fields[F.PLACE_OF] = 'eden:area';
  const op = { op: 'place', name: 1, kind, in: parent, atUm: [0, 0, 0], orientation: [Q, 0, 0, 0], support: { which: 1, node: parent, height: 0 }, fields };
  const n = (s.line ?? s.area).length;
  return { ops: [op], says: s.line ? `${kind.split('@')[0]} along ${n} points, ${s.width} m wide` : `${kind.split('@')[0]} over an area of ${n} corners` };
}
