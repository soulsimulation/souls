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
