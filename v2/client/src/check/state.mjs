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

/** The `souls-entry/1` entries in `dir`, by kind name; none if the folder is missing. Unreadable files are skipped. */
export function kindsIn(dir) {
  const kinds = {};
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return kinds; }
  for (const f of names) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e?.format === 'souls-entry/1' && typeof e.kind === 'string') kinds[e.kind] = e;
    } catch { /* not an entry */ }
  }
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
export function kindsHeld(dir, copy) {
  return { ...definedIn(copy), ...kindsIn(dir) };
}

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
/** A text field's value as the rules read it: its words' reference (`{21: id}`, K16) as the id's text once written,
 *  null once cleared (`{}`) or never written, so a need on `is: null` tells them apart. */
export const textValue = (v) => (v instanceof Map && v.has(21) ? idText(v.get(21)) : null);

/** The copy (R5's `Copy`) as `{actor, nodes}` for `me`, walked from its roots. */
export function stateOf(copy, kinds, me) {
  const nodes = { [me]: {} };
  const todo = Object.values(JSON.parse(copy.roots()));
  while (todo.length) {
    const bytes = copy.record(todo.pop());
    if (!bytes) continue;
    const m = decode(bytes), id = idText(m.get(1)), kind = entryKind(m);
    // A creator's kind by its full name first (#3697): its own revision's state numbering.
    const state = (kinds[String(m.get(2))] ?? kinds[kind])?.state ?? {};
    const byN = Object.fromEntries(Object.entries(state).map(([name, def]) => [def.n, name]));
    const fields = {};
    if (m.get(6) instanceof Map) for (const [n, v] of m.get(6)) if (byN[n]) fields[byN[n]] = state[byN[n]].type === 'text' ? textValue(v) : plain(v);
    nodes[id] = { ...nodes[id], kind, ...(Object.keys(fields).length ? { fields } : {}) };
    for (const c of m.get(10) ?? []) todo.push(Buffer.from(c).toString('hex'));
  }
  return { actor: me, nodes };
}
