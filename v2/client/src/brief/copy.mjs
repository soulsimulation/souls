// The copy as rows (Engine v2 R7, #2701): the daemon's copy of its scope (R5's `Copy`, in WASM memory) read record by
// record from its roots down, each record decoded once by its hash. A row is a node: its id, its name, its kind, its
// parent and the path of names above it, its text quoted, and `own`, its record without its children's hashes, so
// that two versions of a node compare equal when only something below it changed. A row carries its pose as the
// record holds it (#3851: body motion reaches the copy, #3799): `pos`, µm in its parent's frame, and `rot`, a quaternion
// [w, x, y, z]; a moving node's is where its last sample put it.
//
// The records are CBOR in T0's profile (`v2/docs/encoding.md`): unsigned and negative integers, bytes, text, arrays,
// maps and the simple values; this reader takes those and nothing else.

import { createHash } from 'node:crypto';
import { F_HOURS, hoursText } from '../schedule/hours.mjs';

const SIMPLE = { 20: false, 21: true, 22: null };
/** Names in the order a person reads them (`brief.mjs` `byName`, which imports this module). */
const byName = new Intl.Collator('en', { numeric: true }).compare;

/** One CBOR item in T0's profile, as plain values: integers as numbers (BigInt past 2^53), bytes as Uint8Array. */
export function decode(bytes) {
  let at = 0;
  const arg = (info) => {
    if (info < 24) return info;
    const n = 1 << (info - 24);
    if (info > 27) throw new Error('cbor: not in the profile');
    let v = 0n;
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(bytes[at++]);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  const item = () => {
    const b = bytes[at++], major = b >> 5, info = b & 31;
    if (major === 7) { if (!(info in SIMPLE)) throw new Error('cbor: not in the profile'); return SIMPLE[info]; }
    const n = arg(info);
    switch (major) {
      case 0: return n;
      case 1: return typeof n === 'bigint' ? -1n - n : -1 - n;
      case 2: { const out = bytes.slice(at, at + n); at += n; return out; }
      case 3: { const out = Buffer.from(bytes.subarray(at, at + n)).toString('utf8'); at += n; return out; }
      case 4: return Array.from({ length: n }, item);
      case 5: { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
      default: throw new Error('cbor: not in the profile');
    }
  };
  const v = item();
  if (at !== bytes.length) throw new Error('cbor: bytes after the item');
  return v;
}

const hex = (b) => Buffer.from(b).toString('hex');
const NAMES = new WeakMap();
const namesOf = (copy) => { if (!NAMES.has(copy)) NAMES.set(copy, new Map()); return NAMES.get(copy); };
/** The public names the copy was told, `sha256 hex` -> words (#3728: a world's export carries them). */
export const publicNames = (copy) => new Map(namesOf(copy));
const publicRef = (record) => {
  const audience = record.get(5), fields = record.get(6);
  const ref = fields instanceof Map && fields.get(4);
  return audience instanceof Map && audience.get(1) === 1 && ref instanceof Uint8Array && ref.length === 32 ? hex(ref) : null;
};

// A row's name and words come from what the copy was told beside its records as well as from the record itself, so a
// name or words learned bump the copy's generation, and `rowsOf` reads its rows again.
const LEARNED = new WeakMap();
const learned = (copy) => LEARNED.set(copy, (LEARNED.get(copy) ?? 0) + 1);
/** A records answer's records decoded once, for its names, its words and the next rows (`takeRecords`). */
const recordsIn = (frame) => (Array.isArray(frame.get(22)) ? frame.get(22).map((raw) => (raw instanceof Uint8Array && raw.length ? { raw, m: decode(raw) } : null)) : null);

/** After canonical validation, validate the complete optional same-record sidecar before installing any name. */
export function rememberPublicNames(copy, bytes, allowed = null) {
  const frame = decode(bytes);
  namesFrom(copy, frame, frame.has(26) ? recordsIn(frame) : null, allowed);
}
function namesFrom(copy, frame, read, allowed) {
  if (!frame.has(26)) return;
  const records = frame.get(22), pairs = frame.get(26);
  if (frame.has(23) || frame.has(24) || !Array.isArray(records) || !Array.isArray(pairs)) throw new Error('public-name-frame');
  const refs = new Set(read.map((r) => {
    if (!r) throw new Error('public-name-record'); // not bytes, or a withheld record's none
    return publicRef(r.m);
  }).filter(Boolean));
  const pending = new Map();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !(pair[0] instanceof Uint8Array) || pair[0].length !== 32 || !(pair[1] instanceof Uint8Array)) throw new Error('public-name-pair');
    const key = hex(pair[0]);
    if (!refs.has(key) || (allowed && !allowed.has(key)) || pending.has(key)) throw new Error('public-name-reference');
    if (createHash('sha256').update(pair[1]).digest('hex') !== key) throw new Error('public-name-hash');
    pending.set(key, new TextDecoder('utf-8', { fatal: true }).decode(pair[1]));
  }
  const names = namesOf(copy);
  let fresh = false;
  for (const [key, text] of pending) if (names.get(key) !== text) { names.set(key, text); fresh = true; }
  if (fresh) learned(copy);
}

const WORDS = new WeakMap();
/** #3703: the public words the world sent beside a records answer (key 27), by reference (`<scope hex>-<counter>`). */
export const publicWordsOf = (copy) => { if (!WORDS.has(copy)) WORDS.set(copy, new Map()); return WORDS.get(copy); };
/**
 * Keeps the `[[reference, words], ...]` sidecar (key 27) of a records answer: only a reference some public record of
 * the same answer holds in its fields, so words reach the copy only beside the record that names them. Anything else
 * in it is ignored, never trusted.
 */
export function rememberPublicWords(copy, bytes) {
  const frame = decode(bytes);
  wordsFrom(copy, frame, Array.isArray(frame.get(27)) ? recordsIn(frame) : null);
}
function wordsFrom(copy, frame, read) {
  const pairs = frame.get(27);
  if (!Array.isArray(pairs) || !read) return;
  const held = new Set();
  for (const r of read) {
    if (!r) continue;
    const audience = r.m.get(5), fields = r.m.get(6);
    if (!(audience instanceof Map && audience.get(1) === 1 && fields instanceof Map)) continue;
    for (const v of fields.values()) if (v instanceof Map && Array.isArray(v.get(21))) held.add(idText(v.get(21)));
  }
  const kept = publicWordsOf(copy);
  let fresh = false;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(pair[0]) || !(pair[1] instanceof Uint8Array)) continue;
    const ref = idText(pair[0]);
    if (!held.has(ref)) continue;
    try {
      const words = new TextDecoder('utf-8', { fatal: true }).decode(pair[1]);
      if (kept.get(ref) !== words) { kept.set(ref, words); fresh = true; }
    } catch { /* not text */ }
  }
  if (fresh) learned(copy);
}

// Records a sync took, decoded as they came, by hash, for the rows read once it ends (`rowsOf`).
const TAKEN = new WeakMap();
/**
 * A sync's records answer, after the copy took it (`copy.onRecords`): its public names and words kept, as
 * `rememberPublicNames` and `rememberPublicWords` keep them, and each record decoded now, a round at a time, so the
 * rows read when the sync ends are not decoded all at once (Eden: 9,588 records held the daemon's loop for seconds).
 * `asked` is the request it answers (`copy.next`), whose hashes name its records in order; a withheld one is empty.
 */
export function takeRecords(copy, bytes, asked = null) {
  const frame = decode(bytes), read = recordsIn(frame);
  namesFrom(copy, frame, read, null);
  wordsFrom(copy, frame, read);
  const hashes = asked ? decode(asked).get(22) : null;
  if (!read || !Array.isArray(hashes) || hashes.length !== read.length) return;
  if (!TAKEN.has(copy)) TAKEN.set(copy, new Map());
  const taken = TAKEN.get(copy);
  read.forEach((r, k) => { if (r) taken.set(hex(hashes[k]), decodedOf(r.m)); });
}
/** The records a sync took and no rows read: let go when a sync starts again (the last one was cut off). */
export const forgetTaken = (copy) => TAKEN.delete(copy);

/** Every field's public words given beside its record, by field number, or null when there are none. */
function saidAt(copy, fields) {
  const out = {};
  for (const [n, v] of fields) {
    const ref = v instanceof Map && Array.isArray(v.get(21)) ? idText(v.get(21)) : null;
    const words = ref && publicWordsOf(copy).get(ref)?.trim();
    if (words) out[Number(n)] = words;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * #4837: a row's words by its entry's names for them (`{title, first_page}` of a book a shelf's take made): each text
 * field the entry declares whose words the world gave beside its record. The world's words, to be quoted, never
 * followed. `{}` for none.
 */
export function wordsOf(row, entry) {
  const out = {};
  for (const [name, f] of Object.entries(entry?.state ?? {})) {
    const words = f?.type === 'text' ? row?.words?.[f.n] : undefined;
    if (words) out[name] = words;
  }
  return out;
}

/** The longest words that still read as a thing's name (a screen's title, a calendar entry's words); longer, or more
 *  than one line (a book's first page, #4837), they are its text, not its name. */
export const NAME_MOST = 120;
/** `words` when they read as a name ([`NAME_MOST`]), else null. */
export const asName = (words) => (typeof words === 'string' && words.length <= NAME_MOST && !words.includes('\n') ? words : null);

/** A field's public words given beside its record (`{21: id}`, key 27), or null when there are none. */
function wordsAt(copy, fields, n) {
  const v = fields.get(n) ?? fields.get(BigInt(n));
  const ref = v instanceof Map && Array.isArray(v.get(21)) ? idText(v.get(21)) : null;
  return (ref && publicWordsOf(copy).get(ref)?.trim()) || null;
}

/** Current reachable public records, never a dictionary or records retained outside the Copy's roots: the nodes the
 *  rows were read from (`rowsOf`), so a `find` does not decode the whole copy again. */
export function publicNameRecords(copy, missingOnly = true) {
  rowsOf(copy);
  const found = [], names = namesOf(copy);
  for (const [hash, { ref: reference }] of ROWS.get(copy).nodes) {
    if (!reference || (missingOnly && names.has(reference))) continue;
    const bytes = copy.record(hash);
    if (bytes) found.push({ hash, bytes, reference });
  }
  return found;
}
/**
 * A node record's fields (key 6) with its big fields read in from their own records: a field of 64 KiB or more (the
 * open ground's terrain tiles) is a record of its own, named by key 0 `[[field, hash], ...]` (replica
 * `tree::BIG_FIELD`, #4713). One whose record the copy does not hold is left out.
 */
export function allFields(copy, m) {
  const f = new Map(m.get(6) instanceof Map ? m.get(6) : []);
  for (const [n, h] of m.get(0) ?? []) {
    const bytes = copy.record(hex(h));
    const own = bytes ? decode(bytes).get(6) : null;
    if (own instanceof Map && own.has(n)) f.set(n, own.get(n));
  }
  return f;
}

/** An id `[scope, counter]` as text: `<scope hex>-<counter>`. */
export const idText = (v) => `${hex(v[0])}-${v[1]}`;
/** A kind `namespace:name@hash` as its plain name. */
/** A node's course field (replica `schedule::F_COURSE`): a thing that moves on its own track. */
export const F_COURSE = 80;
/** A place's title (#3699): field 4, a public name's hash (named at import) or a creator's words (`{21: id}`). */
export const F_TITLE = 4;
/** A Soul's body's public name (worldd `words::NAME`, field 30): its owner's words for it, set by a describe (`{21: id}`). */
export const F_BODY_NAME = 30;
/** A place's aliases (#3699): a creator's words (`{21: id}`), one alias a line; `find` scores them. */
export const F_ALIASES = 101;
export const plainKind = (k) => String(k).replace(/@.*$/, '');
/** A node's Soul Actions entry field (import-eden `F_ENTRY`): the entry its world's map names for its kind. */
export const F_ENTRY = 27;
/** The kind name a node's entry goes by: the entry its fields name (`F_ENTRY`: a Mars chair borrows `eden:chair`), else its own kind's. */
export const entryKind = (m) => {
  const f = m.get(6) instanceof Map ? m.get(6) : new Map(), e = f.get(F_ENTRY) ?? f.get(BigInt(F_ENTRY));
  return typeof e === 'string' ? plainKind(e) : plainKind(m.get(2));
};
/** A version `[lineage, zone, epoch, sequence]`'s bytes in hex, as its sequence. */
export const sequenceOf = (versionHex) => (versionHex ? Number(decode(Buffer.from(versionHex, 'hex'))[3]) : 0);

/** Plain JSON for comparing records: bytes as hex, maps as sorted pairs. */
const plain = (v) => v instanceof Uint8Array ? hex(v) : Array.isArray(v) ? v.map(plain) : v instanceof Map ? [...v].map(([k, x]) => [k, plain(x)]) : typeof v === 'bigint' ? String(v) : v;

// A copy's records decoded, by hash (a hash names the same record for ever): only those its last walk from the roots
// reached. A moving body re-hashes itself and every node above it at each follow; keeping every version decoded grew
// the daemon by megabytes a second while a Soul walked (a room's record holds each child's hash), until Node's heap ran out.
const DECODED = new WeakMap();
/** A record decoded, with `own`: itself without its children's hashes, as JSON, so a node compares equal across versions. */
function decodedOf(m) {
  const rest = new Map(m);
  rest.delete(10);
  return { m, own: JSON.stringify(plain(rest)) };
}
/** A walk from the copy's roots: `read` decodes a record once, `done` keeps only what the walk reached. */
function walkOf(copy) {
  const was = DECODED.get(copy), kept = new Map();
  return {
    read(hash) {
      let d = kept.get(hash) ?? was?.get(hash);
      if (!d) {
        const bytes = copy.record(hash);
        if (!bytes) return null;
        d = decodedOf(decode(bytes));
      }
      kept.set(hash, d);
      return d;
    },
    done() { DECODED.set(copy, kept); },
  };
}

/** The full names of the creator's own kinds (#3697) the copy holds: field 1 of each `souls:kind` node at a root. */
export function definedNames(copy, read = (h) => { const bytes = copy.record(h); return bytes ? decode(bytes) : null; }) {
  const out = new Set();
  for (const h of Object.values(JSON.parse(copy.roots()))) {
    const root = read(h);
    if (!root) continue;
    for (const c of root.get(10) ?? []) {
      const m = read(hex(c));
      if (!m) continue;
      const f = m.get(6) instanceof Map ? m.get(6) : new Map(), full = f.get(1) ?? f.get(1n);
      if (plainKind(m.get(2)) === 'souls:kind' && typeof full === 'string') out.add(full);
    }
  }
  return out;
}

/** An activity node's (`replica::activity`, a `<kind>_activity`, a conversation, a give) members and whether it has
 *  started, as its fields hold them (2: 1 proposed, 2 started; 4: [[role, body, soul, link, intent], ...]):
 *  `{members: [{role, body, soul}], started}`, or nothing for any other node. */
function membersAt(kind, fields) {
  if (!/_activity$|^souls:(conversation|give)$/.test(kind)) return {};
  const ms = fields.get(4) ?? fields.get(4n), state = Number(fields.get(2) ?? fields.get(2n));
  if (!Array.isArray(ms) || !ms.every((m) => Array.isArray(m) && m.length === 5 && typeof m[0] === 'string')) return {};
  return { members: ms.map(([role, body, soul]) => ({ role, body: idText(body), soul: idText(soul) })), started: state === 2 };
}

/**
 * The copy's rows by id, walked from its roots (`copy.roots()`): `{ id, name, kind, entry, parent, path, children, text, soul,
 * members, started, own }`, `soul` on a body that names its Soul, `members` and `started` on an activity ([`membersAt`]), `entry` on a thing that borrows another kind's entry ([`entryKind`]).
 * A node is named by its kind's plain name and its counter ("cup 7") unless a text field gives it one; text in its
 * fields is the world's or a Soul's words and is carried as `text`, to be quoted, never followed.
 */
export function rowsOf(copy) {
  // Read again only when the copy's roots or what it was told (names, words) changed, and then only the nodes whose
  // record or path changed: a follow re-hashes a moving body and the nodes above it, not the world. Every command, the
  // copy's follow and its hearing read the rows, and reading Eden's 9,588 afresh each time held the daemon's loop for
  // seconds (26 Nov 2026). The rows given are shared: a caller never changes them.
  const roots = copy.roots(), gen = LEARNED.get(copy) ?? 0, was = ROWS.get(copy);
  if (was && was.roots === roots && was.gen === gen) return was.rows;
  // Each record decoded once: kept from the last read, taken by the sync as it came, or read now.
  const taken = TAKEN.get(copy), kept = DECODED.get(copy), fresh = new Map();
  const read = (hash) => {
    let d = was?.nodes.get(hash)?.d ?? taken?.get(hash) ?? kept?.get(hash) ?? fresh.get(hash);
    if (!d) { const bytes = copy.record(hash); if (!bytes) return null; fresh.set(hash, (d = decodedOf(decode(bytes)))); }
    return d;
  };
  const own = definedNames(copy, (h) => read(h)?.m ?? null), ownKey = [...own].sort().join(' ');
  const prev = was && was.gen === gen && was.ownKey === ownKey ? was.nodes : null;
  const rows = new Map(), nodes = new Map(), decoded = new Map();
  const todo = Object.values(JSON.parse(roots)).map((h) => [h, []]);
  while (todo.length) {
    const [hash, path] = todo.pop();
    let n = prev?.get(hash);
    if (!n || !samePath(n.row.path, path)) {
      const d = read(hash);
      if (!d) continue;
      n = nodeOf(copy, d, path, own);
    }
    taken?.delete(hash);
    nodes.set(hash, n);
    decoded.set(hash, n.d);
    rows.set(n.row.id, n.row);
    for (const c of n.children) todo.push([c, n.under]);
  }
  DECODED.set(copy, decoded);
  ROWS.set(copy, { roots, gen, ownKey, nodes, rows });
  return rows;
}
const ROWS = new WeakMap();
const samePath = (a, b) => a === b || (a.length === b.length && a.every((x, k) => x === b[k]));

/** One node's row from its decoded record (`d`) and the names above it, with its children's hashes and their path. */
function nodeOf(copy, d, path, own) {
  const { m } = d, id = idText(m.get(1)), kind = plainKind(m.get(2));
  const fields = m.get(6) instanceof Map ? m.get(6) : new Map();
  const text = [];
  for (const [n, v] of fields) if (typeof v === 'string' && Number(n) !== F_ENTRY) text.push(v);
  // A thing of a creator's kind (#3697) goes by that kind's full name, so its own revision's record is read.
  const full = String(m.get(2)), entry = own.has(full) ? full : entryKind(m);
  // C30 (#3556): a body born by a join (C3) owns its `souls:body-of` link to its Soul: the row names that Soul.
  const of = (m.get(9) ?? []).map(([, l]) => l).find((l) => l instanceof Map && plainKind(l.get(1)) === 'souls:body-of');
  // 0.133 Q1: a Soul's body goes by its owner's name for it (field 30), so another Soul finds it by that name; a
  // thing by its field 30 words (a screen's title, a calendar entry's words) when they read as a name, never by a
  // page of text there (a book's first page, #4837: a held book is named by its title, `brief.mjs` `holdingOf`).
  const body = of || kind === 'souls:body', at30 = wordsAt(copy, fields, F_BODY_NAME), ref = publicRef(m);
  const name = namesOf(copy).get(ref) ?? wordsAt(copy, fields, F_TITLE) ?? (body ? at30 : asName(at30)) ?? `${kind.replace(/^.*:/, '')} ${m.get(1)[1]}`;
  const aliases = wordsAt(copy, fields, F_ALIASES)?.split('\n').map((a) => a.trim()).filter(Boolean) ?? [];
  const children = (m.get(10) ?? []).map(hex);
  // #3603: a thing on a course (replica's F_COURSE, field 80) moves by itself; a rider in it may steer it.
  const moving = fields.has(F_COURSE) || fields.has(BigInt(F_COURSE));
  // #3699: a place's opening hours (replica's F_HOURS, field 81), as its creator wrote them.
  const hours = hoursText(fields.get(F_HOURS) ?? fields.get(BigInt(F_HOURS)));
  const pose = m.get(7) instanceof Map ? m.get(7) : m.get(8) instanceof Map && m.get(8).get(5) instanceof Map ? m.get(8).get(5) : null;
  const members = membersAt(kind, fields);
  // Its fields set one by one, in the order they print (spreading each optional one cost a third of reading a row)
  const row = { id, name, kind };
  if (entry !== kind) row.entry = entry;
  row.parent = m.has(3) ? idText(m.get(3)) : null;
  row.path = path;
  row.children = children.length;
  if (pose && Array.isArray(pose.get(2))) { row.pos = pose.get(2).map(Number); if (Array.isArray(pose.get(3))) row.rot = pose.get(3).map(Number); }
  if (text.length) row.text = text;
  if (of) row.soul = idText(of.get(2)[1]);
  if (moving) row.moving = true;
  if (hours) row.hours = hours;
  if (aliases.length) row.aliases = aliases;
  if (members.members) { row.members = members.members; row.started = members.started; }
  row.own = d.own;
  // First-day round 4: its course as the record holds it, for `check/aboard.mjs` (not enumerable: never printed)
  if (moving) Object.defineProperty(row, 'course', { value: fields.get(F_COURSE) ?? fields.get(BigInt(F_COURSE)) });
  // #4837: the public words its text fields hold, by field number (a book's title and first page), for `wordsOf`
  // (not enumerable: printed only where an answer names them)
  const said = saidAt(copy, fields);
  if (said) Object.defineProperty(row, 'words', { value: said });
  return { d, ref, row, children, under: [...path, name] };
}

/**
 * Where each node stands in its parent, for the creator (#3694: placing by relation): `{ at: [x, y, z] mm, slot }`
 * by id, from each record's pose (field 7, its position in µm) and slot (field 4). Rows never carry this; only the
 * creator's describe does.
 */
export function posesOf(copy) {
  const out = new Map();
  const walk = walkOf(copy);
  const todo = Object.values(JSON.parse(copy.roots()));
  while (todo.length) {
    const d = walk.read(todo.pop());
    if (!d) continue;
    const { m } = d, pose = m.get(7), p = pose instanceof Map ? pose.get(2) : null;
    out.set(idText(m.get(1)), {
      ...(Array.isArray(p) ? { at: p.map((n) => Math.round(Number(n) / 1000)) } : {}),
      ...(m.has(4) ? { slot: Number(m.get(4)) } : {}),
    });
    todo.push(...(m.get(10) ?? []).map(hex));
  }
  walk.done();
  return out;
}

/** What changed between two sets of rows: the names added, removed or changed in their own record, in name order. */
export function changedBetween(before, after) {
  const out = [];
  for (const [id, r] of after) if (before.get(id)?.own !== r.own) out.push({ id, name: r.name, ...(before.has(id) ? {} : { added: true }) });
  for (const [id, r] of before) if (!after.has(id)) out.push({ id, name: r.name, removed: true });
  return out.sort((a, b) => byName(a.name, b.name));
}
