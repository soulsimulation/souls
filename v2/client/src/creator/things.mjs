// A creator's moves and copies of things (#3728, today's `eden-god move <ref> --by dx,dz` and `clone`): made on the
// daemon's copy (an export of it, `genesis.mjs`) and sent as any edit is, so the world checks, records and refuses them
// as it does any edit.
//
//   move <id> [<id> ...] --by dx,dz [--yaw r]     each thing that far over (metres, in its parent's frame), what is in
//                                                it riding along; a thing resting on the open ground keeps its height
//                                                over the ground, which rises or falls under it; a shape's outline and
//                                                line (fields 11, 16) move with it
//   clone <id> [--at x,z] [--count n] [--step dx,dz] [--yaw r]   copies of a thing and everything in it, its doorways
//                                                and stairs among them; without --at the first copy is one step away
//                                                (the step, as today's, is one and a half widths, at least 2 m)
//
// A move is a pose change written in the batch: its facing (unless --yaw turns it), its slot and its support are kept,
// as a move must keep them (`replica::wasm` `spot_of`). A clone is an import (`genesis.mjs` `importOf`) of a file that
// holds the copies under new ids, beside the nodes they name: placed parents first, a level an edit, then the links.

import { FORMAT } from './genesis.mjs';

/** N1's field numbers (`v2/tools/import-eden`): a shape's outline and line, in the parent's frame, mm. */
export const F = { OUTLINE: 11, LINE: 16 };
const Q = 1 << 30;
/** The most copies one clone makes. */
export const CLONES_MOST = 100;

const no = (code, detail) => ({ ok: false, code, detail });
const um = (v) => Number(v);
const quatOf = (yaw) => [Math.round(Math.cos(yaw / 2) * Q), 0, Math.round(Math.sin(yaw / 2) * Q), 0];

/** `x,z` metres, or a refusal by `code`. */
export function pairOf(v, flag, code) {
  const p = String(v ?? '').split(',').map(Number);
  if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) return no(code, `--${flag} x,z in metres, not ${v ?? 'nothing'}`);
  return p;
}

const kidsOf = (nodes) => {
  const m = new Map();
  for (const n of nodes) { if (!m.has(n.parent)) m.set(n.parent, []); m.get(n.parent).push(n); }
  return m;
};
/** `id` and everything under it, parents first. */
function subtree(kids, id) {
  const out = [], todo = [id];
  while (todo.length) { const x = todo.shift(); out.push(x); for (const c of kids.get(x) ?? []) todo.push(c.id); }
  return out;
}
/** A shape's points moved by (dx, dz) mm. */
const shifted = (pts, dx, dz) => pts.map(([x, z]) => [Number(x) + dx, Number(z) + dz]);

/**
 * The batch that moves each of `refs` by `by` ([dx, dz] metres) on `nodes` (an export of the copy), turned to `yaw`
 * (radians) when given. `lift(xUm, zUm)` is the open ground's height there (µm, null off it), for things resting on
 * `ground` (its id). A ref under another ref rides with it. Gives { ops, says } or a refusal by name.
 */
export function moveByOps(nodes, refs, by, { yaw, ground, lift } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const missing = refs.filter((r) => !byId.has(r));
  if (!refs.length || missing.length) return no('move.where', `move <id> --by dx,dz: no ${missing.join(', ') || 'id'} in this world`);
  const [dx, dz] = by.map((v) => Math.round(v * 1000));
  const chosen = new Set(refs);
  const under = (n) => { for (let p = byId.get(n.parent); p; p = byId.get(p.parent)) if (chosen.has(p.id)) return true; return false; };
  const ops = [];
  for (const id of new Set(refs)) {
    const n = byId.get(id);
    if (n.parent === null) return no('edit.root', 'the world\'s root is never moved');
    if (under(n)) continue;
    // A shape (a footpath, a lawn, a place) stands at its parent's origin and draws its points: they move, not it.
    const shape = [F.OUTLINE, F.LINE].filter((f) => Array.isArray(n.fields?.[f]) && n.fields[f].length);
    if (shape.length) {
      for (const f of shape) ops.push({ op: 'set', node: id, field: f, value: shifted(n.fields[f], dx, dz) });
      continue;
    }
    if (!n.pose) return no('move.no-pose', `${id} has no spot to move from`);
    const [x, y, z] = n.pose.at.map(um), nx = x + dx * 1000, nz = z + dz * 1000;
    let ny = y;
    if (n.parent === ground && lift) {
      const h0 = lift(x, z), h1 = lift(nx, nz);
      if (h1 === null) return no('move.off-the-ground', `${id} would be off the world's ground at ${nx / 1e6}, ${nz / 1e6}`);
      ny = y + (h1 - (h0 ?? h1));
    }
    ops.push({
      op: 'move', node: id, atUm: [nx, ny, nz], orientation: yaw === undefined ? n.pose.orientation.map(um) : quatOf(yaw),
      ...(n.pose.slot !== undefined ? { slot: n.pose.slot } : {}), support: supportOf(n.pose.support),
    });
  }
  return { ops, says: `moved ${new Set(ops.map((o) => o.node)).size} by (${by[0]}, ${by[1]}) m` };
}

const supportOf = (s) => (!s ? { which: 0 } : { which: s.which, ...(s.node ? { node: s.node } : {}), ...(s.height !== undefined ? { height: Number(s.height) } : {}) });

/** Every `{ id }` in a value, renamed through `to`. */
const renamed = (v, to) => {
  if (Array.isArray(v)) return v.map((x) => renamed(x, to));
  if (v && typeof v === 'object') {
    if (v.id !== undefined && Object.keys(v).length === 1) return { id: to.get(v.id) ?? v.id };
    if (v.map) return { map: v.map.map(([k, x]) => [k, renamed(x, to)]) };
  }
  return v;
};

/**
 * The file whose import makes `count` copies of `ref` on `nodes` (an export of the copy): each copy of its subtree
 * under new ids (`clone-<k>-<id>`, links too), the first `at` ([x, z] metres in its parent's frame) or one `step`
 * from the original, each next one a step on; and beside them, as they are, every node a copy names (its parents up
 * to the root, its support, a link's far end), which the import finds in the world by id. `lift` and `ground` as for
 * `moveByOps`; `width` (mm) the thing's, for the default step. Gives { file, says } or a refusal by name.
 */
export function cloneFile(nodes, ref, { at, count = 1, step, yaw, ground, lift, width } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const src = byId.get(String(ref ?? ''));
  if (!src) return no('clone.where', `clone <id>: no ${ref} in this world`);
  if (src.parent === null || !src.pose) return no('clone.where', `${ref} is not a thing to copy`);
  if (!(Number.isInteger(count) && count >= 1 && count <= CLONES_MOST)) return no('clone.count', `--count is 1 to ${CLONES_MOST}`);
  const ids = subtree(kidsOf(nodes), src.id), inside = new Set(ids);
  const s = step ?? [Math.max(2, ((width ?? 0) / 1000) * 1.5), 0];
  // A shape's spot is its points' middle; it is copied by moving its points, its pose kept.
  const pts = src.fields?.[F.OUTLINE] ?? src.fields?.[F.LINE], shaped = Array.isArray(pts) && pts.length > 0;
  const [x0, y0, z0] = shaped ? [pts.reduce((a, q) => a + Number(q[0]), 0) / pts.length * 1000, 0, pts.reduce((a, q) => a + Number(q[1]), 0) / pts.length * 1000] : src.pose.at.map(um);
  const base = at ? [at[0] * 1e6, at[1] * 1e6] : [x0 + s[0] * 1e6, z0 + s[1] * 1e6];
  const h0 = src.parent === ground && lift && !shaped ? lift(x0, z0) : null;
  const copies = [], linksOut = new Set();
  for (let k = 0; k < count; k++) {
    const to = new Map(ids.map((id) => [id, `clone-${k}-${id}`]));
    for (const id of ids) for (const l of byId.get(id).links ?? []) to.set(l.id, `clone-${k}-${l.id}`);
    const x = Math.round(base[0] + s[0] * 1e6 * k), z = Math.round(base[1] + s[1] * 1e6 * k);
    let y = y0;
    if (h0 !== null) {
      const h = lift(x, z);
      if (h === null) return no('clone.off-the-ground', `copy ${k + 1} would be off the world's ground at ${x / 1e6}, ${z / 1e6}`);
      y = y0 + (h - h0);
    }
    for (const id of ids) {
      const n = byId.get(id), root = id === src.id;
      const fields = Object.fromEntries(Object.entries(n.fields ?? {}).map(([f, v]) => [f, renamed(v, to)]));
      if (root) for (const f of [F.OUTLINE, F.LINE]) if (Array.isArray(fields[f])) fields[f] = shifted(fields[f], Math.round((x - x0) / 1000), Math.round((z - z0) / 1000));
      const pose = n.pose && {
        ...n.pose,
        ...(root && !shaped ? { at: [x, y, z], ...(yaw !== undefined ? { orientation: quatOf(yaw) } : {}) } : {}),
        support: { ...n.pose.support, ...(n.pose.support?.node ? { node: to.get(n.pose.support.node) ?? n.pose.support.node } : {}) },
      };
      copies.push({
        id: to.get(id), kind: n.kind, parent: root ? n.parent : to.get(n.parent), fields, ...(pose ? { pose } : {}),
        ...(n.links ? { links: n.links.map((l) => ({ ...l, id: to.get(l.id), ends: l.ends.map((e) => to.get(e) ?? e) })) } : {}),
      });
      for (const l of n.links ?? []) for (const e of l.ends) if (!inside.has(e)) linksOut.add(e);
      if (n.pose?.support?.node && !inside.has(n.pose.support.node)) linksOut.add(n.pose.support.node);
    }
  }
  // What the copies name outside themselves, as it is (found in the world by id): the original's parents up to the
  // root, the original itself (so no copy is taken for it), its support and its links' far ends.
  const beside = new Map();
  for (let p = src; p; p = byId.get(p.parent)) beside.set(p.id, p);
  for (const id of linksOut) if (byId.has(id)) beside.set(id, byId.get(id));
  const keep = [...beside.values()].map((n) => ({ id: n.id, kind: n.kind, parent: n.parent, fields: n.parent === null ? {} : n.fields }));
  // Parents first: the beside nodes from the root down, then the copies in subtree order.
  keep.sort((a, b) => depth(byId, a.id) - depth(byId, b.id));
  return {
    file: { format: FORMAT, nodes: [...keep, ...copies] },
    says: `cloned ${ref}${count > 1 ? ` ×${count}` : ''} (${ids.length} node${ids.length > 1 ? 's' : ''} each) from ${(base[0] / 1e6).toFixed(2)}, ${(base[1] / 1e6).toFixed(2)}${count > 1 ? ` a step of ${s[0]}, ${s[1]} m` : ''}`,
  };
}

const depth = (byId, id) => { let d = 0; for (let p = byId.get(id); p && p.parent !== null; p = byId.get(p.parent)) d++; return d; };
