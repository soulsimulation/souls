// Today's kit JSON (`define-kit`, tools/god-skill: a name and primitive shapes in metres) as a `souls-entry/1` record
// with `geometry.parts`, for `souls-god.mjs define-kit` (#3697). The world keeps the record as a creator's kind; a page
// draws its parts. Whole numbers only, as every entry: lengths in mm, angles in millidegrees, `glow` and `scale` in
// permille (a part's `scale` is [x, y, z] permille). The frame is the kit's: y = 0 the ground, +y up, the front +z.
//
// What does not carry: kit programs (`repeat`, `radial`, `mirror`, `$param` arithmetic, `outline`, `arch.pointed`) are
// refused, by name (`kit.program`), so nothing is drawn other than it was written; behaviour (`actions`, `components`,
// `state`, ...) is reported as not carried, since a creator's kind says what it does as `forms` in a record (`define`).

const KINDS = new Set(['box', 'wedge', 'rbox', 'cyl', 'cone', 'capsule', 'sphere', 'ring', 'torus', 'arch', 'lathe', 'extrude', 'loft', 'sweep']);
/** A shape's keys that are lengths (one number, a point or a list of points), angles, or carried as written. */
const LENGTH = ['at', 'size', 'r', 'r2', 'h', 'round', 'profile', 'polygon', 'holes', 'top', 'path', 'from', 'to', 'pivot'];
const ANGLE = ['yaw', 'pitch', 'roll', 'arc'];
const AS_IS = ['kind', 'segments', 'color', 'material', 'tint', 'collide', 'role', 'pattern', 'faces', 'when'];
const PROGRAM = ['repeat', 'radial', 'mirror', 'outline'];
/** Top-level kit keys this translation reads; the rest are reported back, never dropped silently. */
const READ = ['schema', 'name', 'version', 'description', 'tags', 'box', 'shapes', 'layer', 'v', 'palette'];

const refuse = (code, detail) => Object.assign(new Error(detail), { code });
const mm = (v, what) => {
  if (Array.isArray(v)) return v.map((x) => mm(x, what));
  if (typeof v !== 'number' || !Number.isFinite(v)) throw refuse('kit.invalid', `${what}: ${JSON.stringify(v)} is not a number of metres`);
  return Math.round(v * 1000);
};
const mdeg = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw refuse('kit.invalid', `${what}: ${JSON.stringify(v)} is not an angle in radians`);
  return Math.round((v * 180_000) / Math.PI);
};

/** One kit shape as a part. */
export function part(s, i) {
  const where = `shapes[${i}]`;
  if (!s || typeof s !== 'object') throw refuse('kit.invalid', `${where} is not a shape`);
  if (!KINDS.has(s.kind)) throw refuse('kit.invalid', `${where}.kind ${JSON.stringify(s.kind)} is not one of ${[...KINDS].join(', ')}`);
  const program = PROGRAM.filter((k) => s[k] !== undefined);
  if (program.length || s.kind === 'arch.pointed' || JSON.stringify(s).includes('"$')) {
    throw refuse('kit.program', `${where}: ${program.join(', ') || 'a $param'}: write each shape out (a program is not carried)`);
  }
  if (!Array.isArray(s.at) && !(Array.isArray(s.from) && Array.isArray(s.to))) throw refuse('kit.invalid', `${where} needs at:[x,y,z] (or from and to)`);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (LENGTH.includes(k)) out[k] = mm(v, `${where}.${k}`);
    else if (ANGLE.includes(k)) out[k] = mdeg(v, `${where}.${k}`);
    else if (k === 'glow') out.glow = Math.round(Math.min(1, Math.max(0, Number(v))) * 1000);
    else if (k === 'scale') out.scale = (Array.isArray(v) ? v : [v, v, v]).map((x) => Math.round(Number(x) * 1000));
    else if (AS_IS.includes(k)) out[k] = v;
    else throw refuse('kit.invalid', `${where}.${k} is not a shape field`);
  }
  return out;
}

/** The kind's name: the namespace and the kit's name, as a kind name is written (`a-z0-9-` : `a-z0-9_`). */
export function kindName(ns, name) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(ns)) throw refuse('kind.namespace', `${ns}: a namespace is a-z, 0-9 and -, starting with a letter`);
  if (!/^[a-z]/.test(n)) throw refuse('kit.invalid', `name ${JSON.stringify(name)} must start with a letter`);
  return `${ns}:${n}`;
}

/** The kit as a record: `{ entry, not_carried }`. */
export function kitEntry(kit, { ns = 'kit' } = {}) {
  if (kit?.schema === 'def/1') throw refuse('kit.invalid', 'a def/1 definition is today\'s server format: write a kit {name, shapes} or a souls-entry/1 record');
  if (!kit?.name || !Array.isArray(kit.shapes) || kit.shapes.length === 0) throw refuse('kit.invalid', 'a kit is {"name": .., "shapes": [..]}');
  if (kit.shapes.length > 96) throw refuse('kit.invalid', `${kit.shapes.length} shapes, over 96`);
  const parts = kit.shapes.map(part);
  let bounds = kit.box ? mm(kit.box, 'box') : boundsOf(parts);
  if (bounds.length !== 3 || bounds.some((n) => n < 50 || n > 400_000)) throw refuse('kit.invalid', 'box is [w, h, d], 0.05 to 400 m');
  bounds = bounds.map((n) => Math.max(50, n));
  const palette = kit.palette && typeof kit.palette === 'object' ? kit.palette : undefined;
  const entry = {
    format: 'souls-entry/1',
    kind: kindName(ns, kit.name),
    owner: 'thing',
    geometry: { bounds_mm: bounds, parts, ...(palette ? { palette } : {}) },
    text: { name: String(kit.name), ...(kit.description ? { description: String(kit.description) } : {}) },
    ...(Array.isArray(kit.tags) && kit.tags.length ? { card: { tags: kit.tags.map(String) } } : {}),
  };
  return { entry, not_carried: Object.keys(kit).filter((k) => !READ.includes(k)) };
}

/** A box round the parts, mm, when the kit gives none: each part's reach from its `at` (a rough box, as today's). */
function boundsOf(parts) {
  const lo = [Infinity, 0, Infinity], hi = [-Infinity, 0, -Infinity];
  for (const p of parts) {
    const at = p.at ?? p.from;
    const half = p.size ? p.size.map((n) => n / 2) : [p.r ?? 500, (p.h ?? 2 * (p.r ?? 500)) / 2, p.r ?? 500];
    const centred = ['box', 'rbox', 'sphere', 'capsule', 'wedge'].includes(p.kind);
    lo[0] = Math.min(lo[0], at[0] - half[0]); hi[0] = Math.max(hi[0], at[0] + half[0]);
    lo[2] = Math.min(lo[2], at[2] - half[2]); hi[2] = Math.max(hi[2], at[2] + half[2]);
    hi[1] = Math.max(hi[1], at[1] + (centred ? half[1] : 2 * half[1]));
  }
  return [hi[0] - lo[0], hi[1], hi[2] - lo[2]].map((n) => Math.round(n));
}
