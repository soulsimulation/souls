// A reviewed content fix as a creator's edits (`souls-god.mjs apply-batch <file> [--dry-run]`): a `souls-named-batch/1`
// file (worlds/patches/*/batch.json) names each thing by its name in the template, or `<building>/<thing>` inside a
// building, never by a live id. Each name is resolved on the creator's own copy of the world (an export of it,
// `genesis.mjs`): a thing whose name field (4, the SHA-256 of its name, as import-eden keeps names) or title is that
// name, of that def when the op gives one, inside that building when the name gives one. A name that matches nothing,
// or more than one thing, is reported and skipped, never guessed. So is a thing that stands neither where the op says
// it was (`from`) nor where it goes (`at`): moved since (`moved-since`); one already there is `already` and sends
// nothing, so a second run sends nothing. The rest go as ordinary creator edits, at most OPS_MOST operations an edit,
// in the file's order; the world checks each (BUILDSAFE among its rules). An edit the world refuses is sent again one
// op at a time, so each op's outcome is its own; one it does not answer in the daemon's time is never sent again
// (`unanswered`: a dry run says whether it landed). Each op's outcome is printed as one line.
//
// The ops (metres; r in radians about +y, the thing's own origin; `from*` is where it was, the rest where it goes):
//   move           {node, from: [x,y,z], at: [x,y,z], room?, from_r?, r?}   in the room's frame when `room` names the
//                  room it stands in, else the world's
//   turn           {node, at_ground: [x,z], from_r, r}        turned in place; what is in it turns with it
//   move-to-ground {node, from_ground: [x,z] | from_roof: [x,y,z], at_ground: [x,z], from_r?, r?}   to that point on
//                  the open ground, resting on the terrain. A thing on the open ground moves keeping its height over
//                  it; one on a building's floor (a roof) is removed and placed again on the open ground with its
//                  fields (a new parent is not a move: replica `edit::Op::Move`), so it takes a new id, and a new
//                  origin (field 1), which the page draws it by
//   set-param      {node, param, from, to}                     one of its def's params (field 19, JSON); `height`
//                  also moves the walked surfaces of its floors that stood at `from` (field 14); a floor with no room
//                  brought to a step or less is ground cover, as import-eden makes it: it goes, and what stood on it
//                  is placed again on the open ground, lowered with it (a later move of such a thing in the file
//                  places it there instead). A thing whose def keeps no params (an older revision, as live Eden's
//                  `core-deck@1`) has only its floors moved: they are what a walk stands on
//
// The terrain (`--terrain <file>`): a copy whose open ground holds its tile size (field 24) but not its tiles (field
// 25) has no heights to place a thing on the ground by. The file gives them, `{ tileSize, tiles }` as field 25 holds
// them (an export's `[tx, tz, { hex }, { hex }]` rows); it is read only for such a copy, and only at the same tile
// size.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchValue, depthOf, OPS_MOST, PLACE_DEPTH } from './genesis.mjs';

export const SCHEMA = 'souls-named-batch/1';
/** import-eden's field numbers: origin, def, name, walked surfaces, params, tile size, tiles, a place's source. */
export const F = { ORIGIN: 1, DEF: 2, NAME: 4, SURFACES: 14, PARAMS: 19, TILE_SIZE: 24, TILES: 25, PLACE_OF: 20 };
/** How near a thing must stand to `from` or `at` to count as there: 10 mm, 0.01 rad. */
export const NEAR_UM = 10_000, NEAR_RAD = 0.01;
const Q = 2 ** 30;

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const text = (v) => (v && typeof v === 'object' && typeof v.hex === 'string' ? Buffer.from(v.hex, 'hex').toString() : typeof v === 'string' ? v : null);
const num = (v) => Number(v);

// --- poses: positions in µm, orientations [w, x, y, z] scaled 2^30, as the export writes them --------------------
const qmul = ([aw, ax, ay, az], [bw, bx, by, bz]) => [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
const unit = (q) => { const n = Math.hypot(...q) || 1; return q.map((c) => c / n); };
const conj = ([w, x, y, z]) => [w, -x, -y, -z];
const rot = (q, [x, y, z]) => { const r = qmul(qmul(q, [0, x, y, z]), conj(q)); return [r[1], r[2], r[3]]; };
/** An orientation as the pose's sign rule takes it: its first non-zero part positive (q and -q are one turn). */
export const signed = (q) => (q.find((c) => c !== 0) < 0 ? q.map((c) => (c === 0 ? 0 : -c)) : q);
/** A turn about +y by `yaw` radians, as the pose writes it (replica `Quat::from_yaw_mdeg`, `things.mjs`). */
export const quatOfYaw = (yaw) => signed([Math.round(Math.cos(yaw / 2) * Q), 0, Math.round(Math.sin(yaw / 2) * Q), 0]);
const yawOf = (q) => { const [w, , y] = unit(q); return 2 * Math.atan2(y, w); };
const angle = (a, b) => { const d = (((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; return Math.abs(d); };
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= NEAR_UM);
const um = (m) => m.map((v) => Math.round(Number(v) * 1e6));

/** The copy's nodes, by id, with what resolving and posing need. */
export function indexOf(world) {
  const byId = new Map(world.nodes.map((n) => [n.id, n]));
  const byName = new Map();
  const words = world.words ?? {};
  for (const n of world.nodes) {
    const f = n.fields?.[F.NAME];
    const keys = [];
    if (f?.hex) keys.push(f.hex);
    const w = Array.isArray(f?.map) && f.map.length === 1 ? words[f.map[0][1]?.id] : undefined;
    if (typeof w === 'string') keys.push(sha(w.trim()));
    for (const k of keys) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(n); }
  }
  const kids = new Map();
  for (const n of world.nodes) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  // The open ground: the node holding the terrain, or its tile size when the copy came without the tiles
  const ground = world.nodes.find((n) => n.fields?.[F.TILES] !== undefined) ?? world.nodes.find((n) => n.fields?.[F.TILE_SIZE] !== undefined) ?? null;
  return { byId, byName, kids, ground };
}

/** `id`'s pose in the world: `{ at: [x,y,z] µm, q }`, its parents' poses composed (the root's is none). */
export function worldPose(ix, id) {
  const chain = [];
  for (let n = ix.byId.get(id); n; n = ix.byId.get(n.parent)) chain.push(n);
  let at = [0, 0, 0], q = [1, 0, 0, 0];
  for (const n of chain.reverse()) {
    if (!n.pose) continue;
    const local = n.pose.at.map(num), lq = unit(n.pose.orientation.map(num));
    const r = rot(q, local);
    at = [at[0] + r[0], at[1] + r[1], at[2] + r[2]];
    q = unit(qmul(q, lq));
  }
  return { at, q };
}

/**
 * The one thing `name` names on the copy: `{ node }`, or `{ status, detail }` when it names none or several. A thing
 * carries a def (field 2): a named place (an area import-eden derived from it) shares its name and is not it.
 */
export function resolveName(ix, name, def) {
  const parts = String(name ?? '').split('/');
  if (!name || parts.length > 2 || parts.some((p) => !p)) return { status: 'unresolved', detail: `a node is <thing> or <building>/<thing>, not ${name}` };
  const [building, thing] = parts.length === 2 ? parts : [null, parts[0]];
  let found = (ix.byName.get(sha(thing)) ?? []).filter((n) => n.fields?.[F.DEF] !== undefined && n.fields?.[F.PLACE_OF] === undefined);
  if (building) {
    const b = sha(building);
    found = found.filter((n) => { for (let p = ix.byId.get(n.parent); p; p = ix.byId.get(p.parent)) if (p.fields?.[F.NAME]?.hex === b) return true; return false; });
  }
  if (def && found.length) {
    const want = String(def).replace('/', '-'), of = found.filter((n) => text(n.fields[F.DEF]) === want);
    if (!of.length) return { status: 'def-differs', detail: `${name} is ${[...new Set(found.map((n) => text(n.fields[F.DEF])))].join(', ')}, not ${def}` };
    found = of;
  }
  if (!found.length) return { status: 'unresolved', detail: `nothing here is named ${name}` };
  if (found.length > 1) return { status: 'ambiguous', detail: `${found.length} things are named ${name}`, choices: found.map((n) => n.id) };
  return { node: found[0] };
}

const spotOf = (n) => ({ ...(n.pose.slot !== undefined ? { slot: n.pose.slot } : {}), support: { which: n.pose.support.which, ...(n.pose.support.node ? { node: n.pose.support.node } : {}), ...(n.pose.support.height !== undefined ? { height: num(n.pose.support.height) } : {}) } });
const moveTo = (n, atUm, q) => ({ op: 'move', node: n.id, atUm: atUm.map(Math.round), orientation: signed(q.map(Math.round)), ...spotOf(n) });
/** Where it stands and faces now against where it was and where it goes: already, ready or moved-since. */
function where(cur, from, to, yaw, fromR, r) {
  const turned = r === undefined || angle(yaw, r) <= NEAR_RAD, was = fromR === undefined || angle(yaw, fromR) <= NEAR_RAD;
  if (near(cur, to) && turned) return 'already';
  if (near(cur, from) && was) return 'ready';
  return 'moved-since';
}
const metresOf = (a) => a.map((v) => Math.round(v / 1000) / 1000);

/**
 * One op of the file as the creator's operations, on the copy `ix`: `{ status, id, ops, detail? }`. `lift(x, z)` is
 * the open ground's height at (x, z) µm (null off it).
 */
export function planOp(ix, op, lift) {
  const r = resolveName(ix, op.node, op.def);
  // Moved off its roof by an earlier run, it stands on the open ground under its own name, where the op put it.
  if (!r.node && op.op === 'move-to-ground' && String(op.node).includes('/') && ix.ground && Array.isArray(op.at_ground)) {
    const down = resolveName(ix, String(op.node).split('/')[1], op.def).node;
    if (down?.parent === ix.ground.id && down.pose && near([num(down.pose.at[0]), num(down.pose.at[2])], um(op.at_ground))) return { status: 'already', id: down.id, ops: [] };
  }
  if (!r.node) return { status: r.status, detail: r.detail, ...(r.choices ? { choices: r.choices } : {}), ops: [] };
  const n = r.node, id = n.id, parent = ix.byId.get(n.parent);
  if (!n.pose) return { status: 'no-pose', id, detail: `${op.node} has no spot`, ops: [] };
  const wp = worldPose(ix, n.parent), local = n.pose.at.map(num), lq = n.pose.orientation.map(num);
  const mine = worldPose(ix, id), yawW = yawOf(mine.q);
  const toLocal = (w) => rot(conj(wp.q), [w[0] - wp.at[0], w[1] - wp.at[1], w[2] - wp.at[2]]);
  const localQ = (yaw) => unit(qmul(conj(wp.q), quatOfYaw(yaw).map((c) => c / Q))).map((c) => c * Q);
  const said = (status, ops, detail) => ({ status, id, ops: status === 'ready' ? ops : [], ...(detail ? { detail } : {}) });
  if (op.op === 'move') {
    if (!Array.isArray(op.from) || !Array.isArray(op.at)) return said('bad-op', [], 'a move gives from and at, [x, y, z] m');
    const by = ix.replaced.get(id);
    if (by && op.room === undefined) {
      // Placed again on the open ground by an earlier op of this file: it is placed where this op puts it.
      if (!near(mine.at, um(op.from))) return said('moved-since', [], `at ${metresOf(mine.at)}`);
      by.place.atUm = um(op.at);
      if (op.r !== undefined) by.place.orientation = quatOfYaw(op.r);
      return { status: 'ready', id, ops: [], with: by.i, detail: `placed with op ${by.i}, on the open ground` };
    }
    if (op.room !== undefined) {
      const origin = text(parent?.fields?.[F.ORIGIN]) ?? '';
      if (!origin.endsWith(`/${op.room}`)) return said('room-differs', [], `${op.node} stands in ${origin || parent?.id}, not room ${op.room}`);
      const s = where(local, um(op.from), um(op.at), yawOf(lq), op.from_r, op.r);
      return said(s, [moveTo(n, um(op.at), op.r === undefined ? lq : quatOfYaw(op.r))], s === 'moved-since' ? `at ${metresOf(local)} in its room` : undefined);
    }
    const s = where(mine.at, um(op.from), um(op.at), yawW, op.from_r, op.r);
    return said(s, [moveTo(n, toLocal(um(op.at)), op.r === undefined ? lq : localQ(op.r))], s === 'moved-since' ? `at ${metresOf(mine.at)}` : undefined);
  }
  if (op.op === 'turn') {
    if (!Array.isArray(op.at_ground) || op.r === undefined) return said('bad-op', [], 'a turn gives at_ground [x, z] m and r');
    const [x, z] = um(op.at_ground);
    if (!near([mine.at[0], mine.at[2]], [x, z])) return said('moved-since', [], `at ${metresOf(mine.at)}`);
    const s = angle(yawW, op.r) <= NEAR_RAD ? 'already' : op.from_r === undefined || angle(yawW, op.from_r) <= NEAR_RAD ? 'ready' : 'moved-since';
    return said(s, [moveTo(n, local, localQ(op.r))], s === 'moved-since' ? `turned ${yawW.toFixed(4)} rad` : undefined);
  }
  if (op.op === 'move-to-ground') {
    if (!Array.isArray(op.at_ground) || !ix.ground || !lift) return said('bad-op', [], 'a move to the ground gives at_ground [x, z] m, on a world with open ground');
    const [x, z] = um(op.at_ground), h = lift(x, z);
    if (h === null) return said('off-the-ground', [], `${op.at_ground} is off the world's ground`);
    const yaw = op.r ?? yawW;
    if (n.parent === ix.ground.id) {
      const from = op.from_ground ? um(op.from_ground) : null;
      const s = where([mine.at[0], mine.at[2]], from ?? [NaN, NaN], [x, z], yawW, op.from_r, op.r);
      const h0 = lift(mine.at[0], mine.at[2]);
      return said(s, [moveTo(n, [x, local[1] + (h - (h0 ?? h)), z], localQ(yaw))], s === 'moved-since' ? `at ${metresOf(mine.at)}` : undefined);
    }
    // On a building's floor (a roof): placed again on the open ground, with its fields, and removed from the roof.
    if (op.from_roof && !near([local[0], local[2]], [um(op.from_roof)[0], um(op.from_roof)[2]])) return said('moved-since', [], `at ${metresOf(local)} on its floor`);
    if ((ix.kids.get(id) ?? []).length) return said('holds-things', [], `${op.node} holds things; move them first`);
    const { ops, dropped } = onGround(ix, n, [x, h, z], quatOfYaw(yaw), 1);
    return said('ready', [{ op: 'remove', node: id }, ...ops], dropped.length ? `fields not carried: ${dropped.join(', ')}` : 'placed again on the open ground: a new id');
  }
  if (op.op === 'set-param') {
    let params;
    try { params = JSON.parse(text(n.fields?.[F.PARAMS]) ?? 'null'); } catch { params = null; }
    const height = op.param === 'height' && typeof op.from === 'number' && typeof op.to === 'number';
    const [was, now] = height ? [Math.round(op.from * 1000), Math.round(op.to * 1000)] : [];
    const floors = (ix.kids.get(id) ?? []).filter((f) => Array.isArray(f.fields?.[F.SURFACES]));
    const at = (mm) => floors.some((f) => f.fields[F.SURFACES].some((row) => num(row[0]) === mm));
    const ops = [];
    let only;
    if (params && typeof params === 'object' && typeof op.param === 'string') {
      const cur = params[op.param], same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b));
      const s = same(cur, op.to) ? 'already' : same(cur, op.from) ? 'ready' : 'moved-since';
      if (s !== 'ready') return said(s, [], s === 'moved-since' ? `${op.param} is ${JSON.stringify(cur)}` : undefined);
      ops.push({ op: 'set', node: id, field: F.PARAMS, value: { hex: Buffer.from(JSON.stringify({ ...params, [op.param]: op.to })).toString('hex') } });
    } else if (height) {
      // No params (an older def revision): its floors alone. Already when a floor stands at `to`, or when none is
      // left and `to` is ground cover (its floor went).
      only = `${op.node} keeps no params: its floors only`;
      if (!at(was)) return said(at(now) || (!floors.length && now <= STEP_MM) ? 'already' : 'moved-since', [], only);
    } else return said('bad-op', [], `${op.node} keeps no params`);
    if (height) {
      for (const f of ix.kids.get(id) ?? []) {
        const rows = f.fields?.[F.SURFACES], on = ix.kids.get(f.id) ?? [];
        if (!Array.isArray(rows) || !rows.some((row) => num(row[0]) === was)) continue;
        // A floor with no room, a step high or less, is ground cover, walked as the open ground (import-eden
        // `on_floor`): it goes, and what stood on it stands on the open ground, lowered with it (a new id each).
        if (now <= STEP_MM && ix.ground && on.every((c) => c.fields?.[F.DEF] !== undefined && !(ix.kids.get(c.id) ?? []).length)) {
          for (const c of on) {
            const w = worldPose(ix, c.id), again = onGround(ix, c, [w.at[0], w.at[1] - (was - now) * 1000, w.at[2]], unit(w.q).map((v) => v * Q), 1 + ops.filter((o) => o.op === 'place').length);
            ops.push(...again.ops);
            ix.replaced.set(c.id, { place: again.ops[0], i: ix.current });
          }
          ops.push({ op: 'remove', node: f.id });
        } else ops.push({ op: 'set', node: f.id, field: F.SURFACES, value: rows.map((row) => (num(row[0]) === was ? [now, row[1]] : row)) });
      }
    }
    return said('ready', ops, only);
  }
  return { status: 'bad-op', detail: `no op ${op.op}`, ops: [] };
}

/** The origin a thing placed again on the open ground takes: `e_` and 8 hex of its old one's hash, as import-eden's. */
export const originOnGround = (origin) => `${origin.startsWith('h_') ? 'h' : 'e'}_${sha(`${origin}:ground`).slice(0, 8)}`;

/** A step, mm: a floor no higher is ground cover (`sim::ground::STEP`, import-eden `BODY_SPAN.0`). */
export const STEP_MM = 220;

/** `n` placed again on the open ground at `atUm` (the ground's frame is the world's), turned `q`, with its fields: the
 *  place named `name`, then the sets of fields too deep for a place; and the fields not carried. */
function onGround(ix, n, atUm, q, name) {
  const fields = {}, dropped = [];
  for (const [k, v] of Object.entries(n.fields ?? {})) { const b = batchValue(v, new Map(), ix.words ?? {}); if (b === null) dropped.push(Number(k)); else fields[k] = b; }
  // A new origin (field 1): the page draws a thing by its origin, so a copy sharing the removed thing's was taken away
  // with it (live Eden, 27 Nov: the re-placed planters were in the world and not drawn). The same each run.
  const origin = text(fields[F.ORIGIN]);
  if (origin) fields[F.ORIGIN] = { hex: Buffer.from(originOnGround(origin)).toString('hex') };
  const deep = Object.keys(fields).filter((k) => depthOf(fields[k]) > PLACE_DEPTH).map((k) => { const value = fields[k]; delete fields[k]; return { op: 'set', node: name, field: Number(k), value }; });
  return { ops: [{ op: 'place', name, kind: n.kind, in: ix.ground.id, atUm: atUm.map(Math.round), orientation: signed(q.map(Math.round)), support: { which: 1, node: ix.ground.id, height: 0 }, fields }, ...deep], dropped };
}

/** The file's ops planned on the copy, in order: `[{ i, op, node, status, id?, ops, with?, detail? }]`; an op whose
 *  thing an earlier op places again goes `with` that op. */
export function planOf(batch, world, lift) {
  const ix = { ...indexOf(world), words: world.words ?? {}, replaced: new Map(), current: 0 };
  return batch.ops.map((op, i) => { ix.current = i; return { i, op: op.op, node: op.node, ...planOp(ix, op, lift) }; });
}

/** The ready entries in edits of at most `most` operations, file order; each place's name is its own in its edit. */
export function editsOf(plan, most = OPS_MOST) {
  const edits = [];
  let cur = null;
  for (const e of plan.filter((x) => x.status === 'ready' && x.with === undefined)) {
    if (!cur || cur.ops.length + e.ops.length > most) edits.push((cur = { entries: [], ops: [] }));
    const base = cur.ops.filter((o) => o.op === 'place').length;
    cur.ops.push(...e.ops.map((o) => (o.op === 'place' ? { ...o, name: o.name + base } : o.op === 'set' && typeof o.node === 'number' ? { ...o, node: o.node + base } : o)));
    cur.entries.push(e);
  }
  return edits;
}

/** Sends the plan's edits through `ask` (the daemon); an edit refused is sent again one entry at a time. */
export async function sendPlan(plan, ask) {
  let edits = 0;
  for (const edit of editsOf(plan)) {
    const a = await ask({ op: 'edit', ops: edit.ops });
    edits++;
    if (a.ok) { for (const e of edit.entries) e.status = 'applied'; continue; }
    // Not answered in the daemon's time, it may still land: never sent again; a dry run says which ops did.
    if (a.code === 'edit.unanswered') { for (const e of edit.entries) Object.assign(e, { status: 'unanswered', detail: 'the world did not answer in time: run --dry-run to see whether it landed (already) or not (ready)' }); continue; }
    if (edit.entries.length === 1) { Object.assign(edit.entries[0], { status: 'refused', code: a.code, ...(a.detail ? { detail: a.detail } : {}) }); continue; }
    for (const e of edit.entries) {
      const one = await ask({ op: 'edit', ops: editsOf([e])[0].ops });
      edits++;
      Object.assign(e, one.ok ? { status: 'applied' } : one.code === 'edit.unanswered' ? { status: 'unanswered', detail: 'the world did not answer in time: run --dry-run to see whether it landed' } : { status: 'refused', code: one.code, ...(one.detail ? { detail: one.detail } : {}) });
    }
  }
  for (const e of plan) if (e.with !== undefined && e.status === 'ready') { const by = plan.find((x) => x.i === e.with); e.status = by.status; if (by.code) e.code = by.code; }
  return edits;
}

/** The open ground's height at (x, z) µm on an export (null off it), as the engine reads it (`terrain/terrain.mjs`).
 *  `terrain` (`{ tileSize, tiles }`, the `--terrain` file) gives the tiles to a copy whose ground came without them. */
export async function liftOf(world, terrain = null) {
  let g = world.nodes.find((n) => n.fields?.[F.TILES] !== undefined);
  if (!g && terrain) {
    const bare = world.nodes.find((n) => n.fields?.[F.TILE_SIZE] !== undefined);
    if (!bare) return null;
    if (num(terrain.tileSize) !== num(bare.fields[F.TILE_SIZE]) || !Array.isArray(terrain.tiles)) throw Object.assign(new Error(`the terrain file's tiles are ${terrain.tileSize} mm, the ground's ${bare.fields[F.TILE_SIZE]} mm`), { code: 'named.terrain' });
    g = { fields: { [F.TILE_SIZE]: bare.fields[F.TILE_SIZE], [F.TILES]: terrain.tiles } };
  }
  if (!g) return null;
  const { heightAt } = await import('./terrain/terrain.mjs');
  const tiles = g.fields[F.TILES].map(([tx, tz, h, c]) => {
    const b = Buffer.from(h.hex, 'hex'), heights = new Int32Array(b.length / 4);
    for (let i = 0; i < heights.length; i++) heights[i] = b.readInt32LE(i * 4);
    return { tx: num(tx), tz: num(tz), heights, classes: new Uint8Array(Buffer.from(c.hex, 'hex')) };
  });
  const tileMm = num(g.fields[F.TILE_SIZE]);
  return (x, z) => { const h = heightAt(tiles, tileMm, BigInt(Math.round(x)), BigInt(Math.round(z))); return h === null ? null : Number(h); };
}

/** One op's line as printed: where it is in the file, its name, its id and its outcome. */
const lineOf = (e) => ({ i: e.i, op: e.op, node: e.node, ...(e.id ? { id: e.id } : {}), status: e.status, ...(e.code ? { code: e.code } : {}), ...(e.detail ? { detail: e.detail } : {}), ...(e.choices ? { choices: e.choices } : {}) });

/**
 * `apply-batch <file> [--dry-run] [--terrain <file>]`: the file resolved on the copy (`ask` export), each op's line given to `print`,
 * then sent unless dry. The summary: counts by outcome and the edits sent.
 */
export async function runNamed({ file, dry, terrain: terrainFile = null }, ask, print) {
  let batch;
  try { batch = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ok: false, code: 'named.file', detail: `${file}: ${e.code ?? e.message}` }; }
  if (batch?.schema !== SCHEMA || !Array.isArray(batch.ops) || !batch.ops.length) return { ok: false, code: 'named.format', detail: `a ${SCHEMA} file with a list of ops` };
  const tmp = mkdtempSync(join(tmpdir(), 'named-batch-'));
  let world;
  try {
    const out = join(tmp, 'world.souls.json'), x = await ask({ op: 'export', file: out });
    if (x.ok === false) return x;
    world = JSON.parse(readFileSync(out, 'utf8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  let terrain = null, lift;
  if (terrainFile) try { terrain = JSON.parse(readFileSync(terrainFile, 'utf8')); } catch (e) { return { ok: false, code: 'named.terrain', detail: `${terrainFile}: ${e.code ?? e.message}` }; }
  try { lift = await liftOf(world, terrain); } catch (e) { return { ok: false, code: e.code ?? 'named.terrain', detail: e.message }; }
  const plan = planOf(batch, world, lift);
  const edits = dry ? 0 : await sendPlan(plan, ask);
  for (const e of plan) print(lineOf(e));
  const counts = {};
  for (const e of plan) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const left = plan.filter((e) => !['applied', 'already', 'ready'].includes(e.status)).length;
  return { ok: left === 0, dryRun: !!dry, schema: SCHEMA, world: batch.world ?? null, ops: plan.length, counts, edits };
}
