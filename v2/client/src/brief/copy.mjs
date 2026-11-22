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
const publicRef = (record) => {
  const audience = record.get(5), fields = record.get(6);
  const ref = fields instanceof Map && fields.get(4);
  return audience instanceof Map && audience.get(1) === 1 && ref instanceof Uint8Array && ref.length === 32 ? hex(ref) : null;
};

/** After canonical validation, validate the complete optional same-record sidecar before installing any name. */
export function rememberPublicNames(copy, bytes, allowed = null) {
  const frame = decode(bytes);
  if (!frame.has(26)) return;
  const records = frame.get(22), pairs = frame.get(26);
  if (frame.has(23) || frame.has(24) || !Array.isArray(records) || !Array.isArray(pairs)) throw new Error('public-name-frame');
  const refs = new Set(records.map((raw) => {
    if (!(raw instanceof Uint8Array)) throw new Error('public-name-record');
    return publicRef(decode(raw));
  }).filter(Boolean));
  const pending = new Map();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !(pair[0] instanceof Uint8Array) || pair[0].length !== 32 || !(pair[1] instanceof Uint8Array)) throw new Error('public-name-pair');
    const key = hex(pair[0]);
    if (!refs.has(key) || (allowed && !allowed.has(key)) || pending.has(key)) throw new Error('public-name-reference');
    if (createHash('sha256').update(pair[1]).digest('hex') !== key) throw new Error('public-name-hash');
    pending.set(key, new TextDecoder('utf-8', { fatal: true }).decode(pair[1]));
  }
  for (const [key, text] of pending) namesOf(copy).set(key, text);
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
  const frame = decode(bytes), pairs = frame.get(27), records = frame.get(22);
  if (!Array.isArray(pairs) || !Array.isArray(records)) return;
  const held = new Set();
  for (const raw of records) {
    if (!(raw instanceof Uint8Array)) continue;
    const r = decode(raw), audience = r.get(5), fields = r.get(6);
    if (!(audience instanceof Map && audience.get(1) === 1 && fields instanceof Map)) continue;
    for (const v of fields.values()) if (v instanceof Map && Array.isArray(v.get(21))) held.add(idText(v.get(21)));
  }
  const kept = publicWordsOf(copy);
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(pair[0]) || !(pair[1] instanceof Uint8Array)) continue;
    const ref = idText(pair[0]);
    if (!held.has(ref)) continue;
    try { kept.set(ref, new TextDecoder('utf-8', { fatal: true }).decode(pair[1])); } catch { /* not text */ }
  }
}

/** A field's public words given beside its record (`{21: id}`, key 27), or null when there are none. */
function wordsAt(copy, fields, n) {
  const v = fields.get(n) ?? fields.get(BigInt(n));
  const ref = v instanceof Map && Array.isArray(v.get(21)) ? idText(v.get(21)) : null;
  return (ref && publicWordsOf(copy).get(ref)?.trim()) || null;
}

/** Current reachable public records, never a dictionary or records retained outside the Copy's roots. */
export function publicNameRecords(copy, missingOnly = true) {
  const todo = Object.values(JSON.parse(copy.roots())), seen = new Set(), found = [];
  while (todo.length) {
    const hash = todo.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const record = decode(bytes), reference = publicRef(record);
    if (reference && (!missingOnly || !namesOf(copy).has(reference))) found.push({ hash, bytes, reference });
    todo.push(...(record.get(10) ?? []).map(hex));
  }
  return found;
}
/** An id `[scope, counter]` as text: `<scope hex>-<counter>`. */
export const idText = (v) => `${hex(v[0])}-${v[1]}`;
/** A kind `namespace:name@hash` as its plain name. */
/** A node's course field (replica `schedule::F_COURSE`): a thing that moves on its own track. */
export const F_COURSE = 80;
/** A place's title (#3699): field 4, a public name's hash (named at import) or a creator's words (`{21: id}`). */
export const F_TITLE = 4;
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

const DECODED = new Map(); // hash → { record, own }; a hash names the same record for ever
const KEEP_DECODED = 50_000;
/** The full names of the creator's own kinds (#3697) the copy holds: field 1 of each `souls:kind` node at a root. */
export function definedNames(copy) {
  const out = new Set();
  for (const h of Object.values(JSON.parse(copy.roots()))) {
    const root = copy.record(h);
    if (!root) continue;
    for (const c of decode(root).get(10) ?? []) {
      const bytes = copy.record(hex(c));
      if (!bytes) continue;
      const m = decode(bytes), f = m.get(6) instanceof Map ? m.get(6) : new Map(), full = f.get(1) ?? f.get(1n);
      if (plainKind(m.get(2)) === 'souls:kind' && typeof full === 'string') out.add(full);
    }
  }
  return out;
}

function read(copy, hash) {
  let d = DECODED.get(hash);
  if (!d) {
    const bytes = copy.record(hash);
    if (!bytes) return null;
    const m = decode(bytes), rest = new Map(m);
    rest.delete(10);
    d = { m, own: JSON.stringify(plain(rest)) };
    if (DECODED.size >= KEEP_DECODED) DECODED.clear();
    DECODED.set(hash, d);
  }
  return d;
}

/**
 * The copy's rows by id, walked from its roots (`copy.roots()`): `{ id, name, kind, entry, parent, path, children, text, soul,
 * own }`, `soul` on a body that names its Soul, `entry` on a thing that borrows another kind's entry ([`entryKind`]).
 * A node is named by its kind's plain name and its counter ("cup 7") unless a text field gives it one; text in its
 * fields is the world's or a Soul's words and is carried as `text`, to be quoted, never followed.
 */
export function rowsOf(copy) {
  const rows = new Map(), own = definedNames(copy);
  const todo = Object.values(JSON.parse(copy.roots())).map((h) => [h, []]);
  while (todo.length) {
    const [hash, path] = todo.pop();
    const d = read(copy, hash);
    if (!d) continue;
    const { m } = d, id = idText(m.get(1)), kind = plainKind(m.get(2));
    const fields = m.get(6) instanceof Map ? m.get(6) : new Map();
    const text = [...fields].filter(([n, v]) => typeof v === 'string' && Number(n) !== F_ENTRY).map(([, v]) => v);
    // A thing of a creator's kind (#3697) goes by that kind's full name, so its own revision's record is read.
    const full = String(m.get(2)), entry = own.has(full) ? full : entryKind(m);
    const name = namesOf(copy).get(publicRef(m)) ?? wordsAt(copy, fields, F_TITLE) ?? `${kind.replace(/^.*:/, '')} ${m.get(1)[1]}`;
    const aliases = wordsAt(copy, fields, F_ALIASES)?.split('\n').map((a) => a.trim()).filter(Boolean) ?? [];
    const children = (m.get(10) ?? []).map(hex);
    // C30 (#3556): a body born by a join (C3) owns its `souls:body-of` link to its Soul: the row names that Soul.
    const of = (m.get(9) ?? []).map(([, l]) => l).find((l) => l instanceof Map && plainKind(l.get(1)) === 'souls:body-of');
    // #3603: a thing on a course (replica's F_COURSE, field 80) moves by itself; a rider in it may steer it.
    const moving = fields.has(F_COURSE) || fields.has(BigInt(F_COURSE));
    // #3699: a place's opening hours (replica's F_HOURS, field 81), as its creator wrote them.
    const hours = hoursText(fields.get(F_HOURS) ?? fields.get(BigInt(F_HOURS)));
    const pose = m.get(7) instanceof Map ? m.get(7) : m.get(8) instanceof Map && m.get(8).get(5) instanceof Map ? m.get(8).get(5) : null;
    const at = pose && Array.isArray(pose.get(2)) ? { pos: pose.get(2).map(Number), ...(Array.isArray(pose.get(3)) ? { rot: pose.get(3).map(Number) } : {}) } : {};
    rows.set(id, { id, name, kind, ...(entry !== kind ? { entry } : {}), parent: m.has(3) ? idText(m.get(3)) : null, path, children: children.length, ...at, ...(text.length ? { text } : {}), ...(of ? { soul: idText(of.get(2)[1]) } : {}), ...(moving ? { moving: true } : {}), ...(hours ? { hours } : {}), ...(aliases.length ? { aliases } : {}), own: d.own });
    for (const c of children) todo.push([c, [...path, name]]);
  }
  return rows;
}

/**
 * Where each node stands in its parent, for the creator (#3694: placing by relation): `{ at: [x, y, z] mm, slot }`
 * by id, from each record's pose (field 7, its position in µm) and slot (field 4). Rows never carry this; only the
 * creator's describe does.
 */
export function posesOf(copy) {
  const out = new Map();
  const todo = Object.values(JSON.parse(copy.roots()));
  while (todo.length) {
    const d = read(copy, todo.pop());
    if (!d) continue;
    const { m } = d, pose = m.get(7), p = pose instanceof Map ? pose.get(2) : null;
    out.set(idText(m.get(1)), {
      ...(Array.isArray(p) ? { at: p.map((n) => Math.round(Number(n) / 1000)) } : {}),
      ...(m.has(4) ? { slot: Number(m.get(4)) } : {}),
    });
    todo.push(...(m.get(10) ?? []).map(hex));
  }
  return out;
}

/** What changed between two sets of rows: the names added, removed or changed in their own record, in name order. */
export function changedBetween(before, after) {
  const out = [];
  for (const [id, r] of after) if (before.get(id)?.own !== r.own) out.push({ id, name: r.name, ...(before.has(id) ? {} : { added: true }) });
  for (const [id, r] of before) if (!after.has(id)) out.push({ id, name: r.name, removed: true });
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}
