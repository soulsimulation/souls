// A creator's world export and import (#3728, today's `eden-god export` / `import`): the daemon writes every node of
// its copy to a file (`souls-world/1`), and reads such a file into the world it is paired with as creator edits,
// parents first, at most OPS_MOST operations an edit (a larger edit, the open ground's tiles, goes by the creator bulk
// route). Ids are the source world's; the import maps each to the node it becomes.
//
// The file:  { format: 'souls-world/1', world, at, nodes: [{ id, kind, parent, fields, pose, links? }], names }
//   fields   { <number>: value } as replica's `ops_of` reads them: an integer, a name, bytes as { hex }, an array
//   pose     { frame, slot?, at: [x, y, z] µm, orientation: [w, x, y, z], support: { which, node?, height? } }
//   links    what a node owns that no place carries (a doorway's or a stair's link): counted, not brought over
//   names    the public names the copy was told (`sha256 hex` -> words), so the file reads as the world does
//
// Bodies (a node owning a `souls:body-of` link) and what they hold are left out: a Soul is not content.

import { decode, idText, plainKind } from '../brief/copy.mjs';

export const FORMAT = 'souls-world/1';
/** The most operations one edit carries (`replica::edit::OPS_MOST`). */
export const OPS_MOST = 256;

const hex = (b) => Buffer.from(b).toString('hex');
const isId = (v) => Array.isArray(v) && v.length === 2 && v[0] instanceof Uint8Array && v[0].length === 16 && (typeof v[1] === 'number' || typeof v[1] === 'bigint');

/** A record value as the batch's JSON reads it: bytes as { hex }, an id as its text { id }, integers as they are. */
export function plainValue(v) {
  if (v instanceof Uint8Array) return { hex: hex(v) };
  if (isId(v)) return { id: idText(v) };
  if (Array.isArray(v)) return v.map(plainValue);
  if (v instanceof Map) return { map: [...v].map(([k, x]) => [Number(k), plainValue(x)]) };
  if (typeof v === 'bigint') return { int: String(v) };
  if (v === true || v === false) return v ? 1 : 0;
  return v;
}

function poseOf(p) {
  if (!(p instanceof Map)) return null;
  const frame = p.get(1) ?? [];
  const s = p.get(4) instanceof Map ? p.get(4) : new Map([[1, 0]]);
  const num = (v) => (typeof v === 'bigint' ? String(v) : v);
  return {
    frame: isId(frame[0]) ? idText(frame[0]) : null,
    ...(frame.length > 1 ? { slot: Number(frame[1]) } : {}),
    at: (p.get(2) ?? [0, 0, 0]).map(num),
    orientation: (p.get(3) ?? [1_000_000, 0, 0, 0]).map(num),
    support: { which: Number(s.get(1)), ...(s.has(2) ? { node: idText(s.get(2)) } : {}), ...(s.has(3) ? { height: num(s.get(3)) } : {}) },
  };
}

/** Every node of the copy, parents first, bodies and what they hold left out; and the bodies' count. */
export function exportOf(copy, { names = new Map(), world = null, at = null } = {}) {
  const roots = Object.values(JSON.parse(copy.roots()));
  const todo = [...roots].reverse(), seen = new Set(), nodes = [];
  let bodies = 0;
  while (todo.length) {
    const hash = todo.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const m = decode(bytes);
    const links = (m.get(9) ?? []).map(([, l]) => l).filter((l) => l instanceof Map);
    if (links.some((l) => plainKind(l.get(1)) === 'souls:body-of')) { bodies++; continue; }
    const fields = m.get(6) instanceof Map ? Object.fromEntries([...m.get(6)].map(([k, v]) => [Number(k), plainValue(v)])) : {};
    const pose = poseOf(m.get(7));
    nodes.push({
      id: idText(m.get(1)), kind: String(m.get(2)), parent: m.has(3) ? idText(m.get(3)) : null, fields,
      ...(pose ? { pose } : {}),
      ...(links.length ? { links: links.map((l) => plainKind(l.get(1))) } : {}),
    });
    const children = (m.get(10) ?? []).map(hex);
    for (let k = children.length - 1; k >= 0; k--) todo.push(children[k]);
  }
  return { format: FORMAT, world, at, nodes, bodies, names: Object.fromEntries(names) };
}

// --- import --------------------------------------------------------------------------------------------------------

/** A file value as a batch's value, ids mapped through `ids`; `null` when it names something not brought over (a
 *  doorway's or a stair's link) or has no batch form. */
export function batchValue(v, ids) {
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) { const y = batchValue(x, ids); if (y === null) return null; out.push(y); }
    return out;
  }
  if (v && typeof v === 'object') {
    if (v.hex !== undefined) return { hex: v.hex };
    if (v.id !== undefined) {
      const to = ids.get(v.id);
      if (!to) return null;
      const [scope, counter] = to.split('-');
      return [{ hex: scope }, Number(counter)];
    }
    if (v.int !== undefined && Number.isSafeInteger(Number(v.int))) return Number(v.int);
    return null;
  }
  return v;
}

/** How deep arrays nest in a batch value (bytes, `{ hex }`, are not an array). An edit intent nests at most 8 deep
 *  (`replica` `intent_limits.txt`): a place's field value may be 3 deep, a set's 4 (one level less around it). */
export const depthOf = (v) => (Array.isArray(v) ? 1 + Math.max(0, ...v.map(depthOf)) : 0);
export const PLACE_DEPTH = 3, SET_DEPTH = 4;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The world node's fields an import carries: the sky's palette. Its clock, calendar and weather are the world's own
 *  (E6 runs them, and its weather is set whole by the weather verb). */
const ROOT_CARRIED = [89];
/** Ids as they are: a target's own values, compared with a file's mapped ones. */
const SELF = { get: (id) => id };

/**
 * The import of `file` (an export) into the world `target` (an export of the copy it goes into), step by step: each
 * `next()` is one edit's operations, and `took(answer)` records the ids its places became. The file's root is the
 * target's root; a node whose id the target holds with the same kind, or the one node of its kind under a node both
 * share (the open ground), is that node, and only its fields that differ are set; every other node is placed, parents
 * first (a child rests on its parent, which an edit names by id, so a level's places follow the level above's answer).
 * A field naming a link (a doorway's, a stair's) is not brought over: links are not places, and are counted.
 */
export function importOf(file, target) {
  if (file?.format !== FORMAT || !Array.isArray(file.nodes)) throw Object.assign(new Error(`not a ${FORMAT} file`), { code: 'import.format' });
  const ids = new Map(), there = new Map(target.nodes.map((n) => [n.id, n]));
  const kids = (nodes) => { const m = new Map(); for (const n of nodes) { if (!m.has(n.parent)) m.set(n.parent, []); m.get(n.parent).push(n); } return m; };
  const srcKids = kids(file.nodes), dstKids = kids(target.nodes);
  const root = file.nodes.find((n) => n.parent === null), troot = target.nodes.find((n) => n.parent === null);
  if (!root || !troot) throw Object.assign(new Error('a world has one root'), { code: 'import.format' });
  const matched = [];
  const match = (s, t) => { ids.set(s.id, t.id); matched.push([s, t]); };
  match(root, troot);
  const depth = new Map([[root.id, 0]]);
  const placed = [];
  for (const n of file.nodes) {
    if (n === root) continue;
    depth.set(n.id, (depth.get(n.parent) ?? 0) + 1);
    const same_ = there.get(n.id);
    if (same_ && same_.kind === n.kind) { match(n, same_); continue; }
    const tp = ids.get(n.parent);
    const sibs = (srcKids.get(n.parent) ?? []).filter((x) => x.kind === n.kind);
    const theirs = tp ? (dstKids.get(tp) ?? []).filter((x) => x.kind === n.kind) : [];
    if (sibs.length === 1 && theirs.length === 1 && !ids.has(n.id)) { match(n, theirs[0]); continue; }
    placed.push(n);
  }
  const counts = { placed: 0, set: 0, matched: matched.length, links: file.nodes.reduce((k, n) => k + (n.links?.length ?? 0), 0), dropped: 0, droppedFields: new Map() };
  const drop = (n, k) => { counts.dropped++; const key = `${n.kind.replace(/@.*/, '')} ${k}`; counts.droppedFields.set(key, (counts.droppedFields.get(key) ?? 0) + 1); };
  const fieldsOf = (n) => {
    const out = {};
    for (const [k, v] of Object.entries(n.fields ?? {})) {
      if (n.parent === null && !ROOT_CARRIED.includes(Number(k))) continue;
      const b = batchValue(v, ids);
      if (b === null || depthOf(b) > SET_DEPTH) drop(n, k); else out[k] = b;
    }
    return out;
  };
  // The matched nodes' fields that differ, one set each (the open ground's tiles are one large set).
  const sets = [];
  for (const [s, t] of matched) {
    for (const [k, v] of Object.entries(fieldsOf(s))) if (!same(batchValue(t.fields?.[k] ?? null, SELF), v)) sets.push({ op: 'set', node: t.id, field: Number(k), value: v });
  }
  // Places by level: a level goes once every node above it is answered.
  const levels = [];
  for (const n of placed) { const d = depth.get(n.id); (levels[d] ??= []).push(n); }
  const todo = levels.filter(Boolean).flat();
  let waiting = null; // the batch sent and not yet answered: name -> source id
  const spot = (n) => {
    const p = n.pose;
    if (!p) return {};
    const sup = p.support.which === 2 ? null : { which: p.support.which, ...(p.support.node ? { node: ids.get(p.support.node) } : {}), ...(p.support.height !== undefined ? { height: Number(p.support.height) } : {}) };
    return { atUm: p.at.map(Number), orientation: p.orientation.map(Number), ...(p.slot !== undefined ? { slot: p.slot } : {}), ...(sup ? { support: sup } : {}) };
  };
  return {
    counts,
    /** The next edit's operations, or null when nothing is left (or the rest waits for an answer). */
    next() {
      if (sets.length) {
        // A large set (the ground's tiles) goes alone; small ones together.
        const big = sets.findIndex((o) => JSON.stringify(o.value).length > 64 << 10);
        const batch = big >= 0 ? sets.splice(big, 1) : sets.splice(0, OPS_MOST);
        counts.set += batch.length;
        return batch;
      }
      const ops = [], names = new Map();
      for (let k = 0; k < todo.length;) {
        const n = todo[k];
        const parent = ids.get(n.parent), sup = n.pose?.support?.node;
        if (!parent || (sup && !ids.has(sup))) { k++; continue; }
        // A field too deep for a place (a floor's outlines) is set on the new node in the same edit.
        const fields = fieldsOf(n), deep = Object.keys(fields).filter((f) => depthOf(fields[f]) > PLACE_DEPTH);
        if (ops.length + 1 + deep.length > OPS_MOST) break;
        todo.splice(k, 1);
        const name = names.size + 1;
        names.set(name, n.id);
        const later = deep.map((f) => { const value = fields[f]; delete fields[f]; return { op: 'set', node: name, field: Number(f), value }; });
        ops.push({ op: 'place', name, kind: n.kind, in: parent, ...spot(n), fields }, ...later);
      }
      if (!ops.length) return null;
      waiting = names;
      counts.placed += names.size;
      return ops;
    },
    /** The answer's `names` (name -> id) for the batch `next` gave. */
    took(answerNames = {}) {
      if (!waiting) return;
      for (const [name, src] of waiting) { const id = answerNames[name] ?? answerNames[String(name)]; if (id) ids.set(src, id); }
      waiting = null;
    },
    left: () => todo.length + sets.length,
    ids,
  };
}
