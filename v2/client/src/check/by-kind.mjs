// A sit by kind (#3178): `act sit:<kind>` ("sit on a bench", "sit on any chair") names no seat. It goes to the world as
// `<ns>:sit` aimed at I5's free-slot selector, `<kind>@<node>` (`wireIntent`): any free place of that kind where the Soul
// stands, nearest it. The world picks the seat as the sit starts, so Souls who send it at once each get their own; one
// left over is refused `place.none-free`, naming the nearest free place of another kind or to wait. `daemon.mjs`
// `actsOf` asks this before it reads a word as `<verb>:<id>`.

import { whereOf } from '../brief/brief.mjs';
import { plainKind } from '../brief/copy.mjs';

const ID = /^[0-9a-f]{32}-\d+$/;
/** A kind: its plain name (`chair`) or with its namespace (`eden:chair`). */
const KIND = /^([A-Za-z][A-Za-z0-9_-]*:)?[A-Za-z][A-Za-z0-9_-]*$/;

const refusal = (code, detail) => Object.assign(new Error(detail), { code });

/**
 * The kind `word` names: as given with a namespace; else the entry (or kind) of a thing in the copy whose plain name it
 * is (a Mars chair goes by `eden:chair`); else `<ns>:<word>`.
 */
export function kindNamed(word, rows, ns) {
  if (word.includes(':')) return word;
  const want = word.replace(/-/g, '_').toLowerCase(), named = (k) => k && plainKind(k).replace(/^.*:/, '').toLowerCase() === want;
  for (const r of rows.values()) {
    if (named(r.entry)) return plainKind(r.entry);
    if (named(r.kind)) return r.kind;
  }
  return `${ns}:${want}`;
}

/**
 * Act word `w` as a sit by kind (`{ verb, this }`, `this` the selector's text), or null for any other word (`sit:<id>`
 * included). The selector's node is the floor the Soul stands on, else the room it is in (`whereOf`): every seat on that
 * floor is filed under it, whichever room holds it. Throws `sit-kind-unplaced` when the copy does not place the Soul.
 */
export function sitByKind(w, { rows, me, ns }) {
  const m = /^sit:(.+)$/.exec(String(w));
  if (!m || ID.test(m[1]) || !KIND.test(m[1])) return null;
  const at = whereOf(rows, me), node = at?.floor ?? at?.room;
  if (!node) throw refusal('sit-kind-unplaced', 'the copy does not show where this Soul is yet: run look, then sit by kind again');
  return { verb: `${ns}:sit`, this: `${kindNamed(m[1], rows, ns)}@${node.id}` };
}
