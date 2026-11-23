// The daemon's copy as R2's form-rules input (Engine v2 R8, #2703): `{actor, nodes}` with each node's kind by its
// plain name (its entry's, when it names one) and its fields by the names its kind's entry gives their numbers. Only fields: the copy's records carry
// no pose, hands or the actor's moves, and links and slots are not read here yet, so only a field's `no` is a local
// one (`SEEN_FIELDS`). A kind with no entry held gives a node with no fields, and its candidates are `unknown`.
//
// Kind entries (`souls-entry/1`) are read from a folder, `<home>/kinds/`, by their `kind` name.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, entryKind, idText } from '../brief/copy.mjs';

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
    const state = kinds[kind]?.state ?? {};
    const byN = Object.fromEntries(Object.entries(state).map(([name, def]) => [def.n, name]));
    const fields = {};
    // An enum's value is held as a name (`souls:stand`); the entry lists its values by their local part (`stand`).
    const valueOf = (def, v) => (def?.type === 'enum' && typeof v === 'string' && def.values?.includes(v.replace(/^[^:]*:/, '')) ? v.replace(/^[^:]*:/, '') : v);
    if (m.get(6) instanceof Map) for (const [n, v] of m.get(6)) if (byN[n]) fields[byN[n]] = state[byN[n]].type === 'text' ? textValue(v) : valueOf(state[byN[n]], plain(v));
    nodes[id] = { ...nodes[id], kind, ...(Object.keys(fields).length ? { fields } : {}) };
    for (const c of m.get(10) ?? []) todo.push(Buffer.from(c).toString('hex'));
  }
  return { actor: me, nodes };
}
