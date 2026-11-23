// The daemon's copy as R2's form-rules input (Engine v2 R8, #2703): `{actor, nodes}` with each node's kind by its
// plain name (its entry's, when it names one) and its fields by the names its kind's entry gives their numbers. Only fields: the copy's records carry
// no pose, hands or the actor's moves, and links and slots are not read here yet, so only a field's `no` is a local
// one (`SEEN_FIELDS`). A kind with no entry held gives a node with no fields, and its candidates are `unknown`.
//
// Kind entries (`souls-entry/1`) are read from a folder, `<home>/kinds/`, by their `kind` name, and a creator's own
// kinds (#3697) from the copy: each a `souls:kind` node at the root holding its record (`kindsHeld`).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, entryKind, idText, plainKind } from '../brief/copy.mjs';

/**
 * The `souls-entry/1` entries in `dir`, by kind name; none if the folder is missing. Unreadable files are skipped.
 * `body`, a body kind with no entry of its own (a served Soul's `souls:body`), gets the family entry (owner `family`)
 * when the folder holds exactly one: its forms are the body's (E21, #2791; replica's `kinds::entry::family_forms`).
 */
export function kindsIn(dir, body) {
  const kinds = {};
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return kinds; }
  for (const f of names) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e?.format === 'souls-entry/1' && typeof e.kind === 'string') kinds[e.kind] = e;
    } catch { /* not an entry */ }
  }
  const families = Object.values(kinds).filter((e) => e.owner === 'family');
  if (body && !kinds[body] && families.length === 1) kinds[body] = { ...families[0], kind: body };
  return kinds;
}

/**
 * The records of a creator's own kinds (#3697) the copy holds, by full name (`namespace:name@hash`, field 1 of each
 * `souls:kind` node at a root; field 2 the record's bytes, `souls-entry/1`), as the world's loader reads them
 * (`replica::kinds::defined`). A thing's row names its creator kind by that full name (`rowsOf`'s `entry`), so two
 * revisions of one kind never lend each other their forms or state. The plain name also finds a record while only one
 * revision of it is defined.
 */
export function definedIn(copy) {
  const kinds = {}, plains = {};
  if (!copy) return kinds;
  for (const h of Object.values(JSON.parse(copy.roots()))) {
    const root = copy.record(h);
    if (!root) continue;
    for (const c of decode(root).get(10) ?? []) {
      const bytes = copy.record(Buffer.from(c).toString('hex'));
      if (!bytes) continue;
      const m = decode(bytes);
      if (plainKind(m.get(2)) !== 'souls:kind') continue;
      const f = m.get(6) instanceof Map ? m.get(6) : new Map(), b = f.get(2) ?? f.get(2n), full = f.get(1) ?? f.get(1n);
      if (!(b instanceof Uint8Array) || typeof full !== 'string') continue;
      try {
        const e = JSON.parse(Buffer.from(b).toString('utf8'));
        if (e?.format !== 'souls-entry/1' || typeof e.kind !== 'string' || plainKind(full) !== e.kind) continue;
        kinds[full] = e;
        (plains[e.kind] ??= []).push(e);
      } catch { /* not a record */ }
    }
  }
  for (const [plain, es] of Object.entries(plains)) if (es.length === 1) kinds[plain] = es[0];
  return kinds;
}

/** Every kind entry this Soul holds: the world's, from `dir`, and the creator's own from the copy (`definedIn`). */
export function kindsHeld(dir, copy, body) {
  return { ...definedIn(copy), ...kindsIn(dir, body) };
}

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
/** A text field's value as the rules read it: its words' reference (`{21: id}`, K16) as the id's text once written,
 *  null once cleared (`{}`) or never written, so a need on `is: null` tells them apart. */
export const textValue = (v) => (v instanceof Map && v.has(21) ? idText(v.get(21)) : null);

/**
 * The copy (R5's `Copy`) as `{actor, nodes}` for `me`, walked from its roots. `memo` (an object the caller keeps) holds
 * each record's reading by its hash between calls (G-late): the copy is addressed by hash, so a record already read
 * reads the same while the kinds are the same, and only what a sync changed is read and decoded again.
 */
export function stateOf(copy, kinds, me, memo = null) {
  const nodes = { [me]: {} }, parents = new Map();
  if (memo && memo.kinds !== kinds) Object.assign(memo, { kinds, byHash: new Map() });
  const seen = memo ? new Map() : null;
  const todo = Object.values(JSON.parse(copy.roots()));
  while (todo.length) {
    const h = todo.pop();
    let r = memo?.byHash.get(h);
    if (!r) {
      const bytes = copy.record(h);
      if (!bytes) continue;
      const m = decode(bytes), kind = entryKind(m);
      // A creator's kind by its full name first (#3697): its own revision's state numbering.
      const state = (kinds[String(m.get(2))] ?? kinds[kind])?.state ?? {};
      const byN = Object.fromEntries(Object.entries(state).map(([name, def]) => [def.n, name]));
      const fields = {};
      // An enum's value is held as a name (`souls:stand`); the entry lists its values by their local part (`stand`).
      const valueOf = (def, v) => (def?.type === 'enum' && typeof v === 'string' && def.values?.includes(v.replace(/^[^:]*:/, '')) ? v.replace(/^[^:]*:/, '') : v);
      if (m.get(6) instanceof Map) for (const [n, v] of m.get(6)) if (byN[n]) fields[byN[n]] = state[byN[n]].type === 'text' ? textValue(v) : valueOf(state[byN[n]], plain(v));
      r = { id: idText(m.get(1)), kind, fields: Object.keys(fields).length ? fields : null, parent: m.has(3) ? idText(m.get(3)) : null,
        children: (m.get(10) ?? []).map((c) => Buffer.from(c).toString('hex')) };
    }
    seen?.set(h, r);
    nodes[r.id] = { ...nodes[r.id], kind: r.kind, ...(r.fields ? { fields: r.fields } : {}) };
    if (r.parent !== null) parents.set(r.id, r.parent);
    todo.push(...r.children);
  }
  if (memo) memo.byHash = seen; // only the records of this walk are kept
  // D8: a body taken into a seat or a bed by the thing's own form (a reparent into its slot) holds no posture field;
  // its posture is the slot's, when the thing's body slots all give one (an armchair's `sit`, a bed's `lie`).
  // D10: nor does that form write over a `stand` a rise wrote before, so a seat's posture wins over a written `stand`.
  for (const [id, parent] of parents) {
    const n = nodes[id], def = kinds[n.kind]?.state?.posture;
    if (!def || (n.fields?.posture !== undefined && n.fields.posture !== 'stand')) continue;
    const slots = Object.values(kinds[nodes[parent]?.kind]?.slots ?? {}).filter((t) => t?.admits === 'body' && typeof t.posture === 'string');
    const postures = [...new Set(slots.map((t) => t.posture))];
    if (postures.length === 1 && (def.values ?? []).includes(postures[0])) n.fields = { ...n.fields, posture: postures[0] };
  }
  return { actor: me, nodes };
}
