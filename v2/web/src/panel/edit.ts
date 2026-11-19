// The creator's edits as T10 carries them (Engine v2 G1b, #3362; v2/docs/intents.md rule 15), for the creator's panel
// (W5, #2801): an intent whose verb is `souls:edit`, its batch in parameter 1, planned against the version in its
// basis. The panel has no other way to change the world: every change it makes is one of these, sent on the
// gateway's socket, and the world's answer rules. Bytes are T0's profile (v2/docs/encoding.md): cborg writes integers
// and lengths in their shortest form and a map's integer keys in ascending order, which is that profile for the
// values here (integer keys only, no floats).
import { decode, encode } from 'cborg';

/** An id as T3 writes it: `[scope, counter]`. */
export type IdValue = [Uint8Array, number];
/** A version: lineage, zone, epoch, sequence (T3). */
export type Version = [Uint8Array, IdValue, number, number];
/** A point in a parent's frame, µm (T4). */
export type Spot = { x: number; y: number; z: number };
/** One operation of a batch: a place names its thing by a number of the batch's own until the receipt maps it. */
export type Op =
  | { op: 'place'; name: number; kind: string; parent: string; at: Spot }
  | { op: 'move'; node: string | number; at: Spot };

export const VERB = 'souls:edit';
/** An edit lasts as long as the world will hold it: its expiry is the latest world time (the world's own limit). */
const EXPIRY = 9223372036854775807n;
const IDENTITY = [1 << 30, 0, 0, 0];

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** An id from the page's text, `<scope hex>.<counter>` (the stream's) or `<scope hex>-<counter>` (a grant's). */
export function idOf(text: string): IdValue {
  const m = /^([0-9a-f]{32})[.-](\d+)$/.exec(text);
  if (!m) throw new Error(`not an id: ${text}`);
  return [bytes(m[1]!), Number(m[2])];
}

/** An id as the stream's pages key it. */
export const idText = (v: IdValue): string => `${hex(v[0])}.${Number(v[1])}`;

/** The version before anything: what an edit is planned against before the panel has seen the world answer. */
export const ZERO: Version = [new Uint8Array(16), [new Uint8Array(16), 0], 0, 0];

const spot = (s: Spot) => new Map<number, unknown>([[1, [s.x, s.y, s.z].map(Math.round)], [2, IDENTITY], [3, new Map([[1, 0]])]]);

export function opValue(o: Op): Map<number, unknown> {
  if (o.op === 'move') return new Map<number, unknown>([[1, 2], [2, typeof o.node === 'number' ? o.node : idOf(o.node)], [3, spot(o.at)]]);
  const [plain, h] = o.kind.split('@');
  const m = new Map<number, unknown>([[1, 1], [2, o.name], [3, plain]]);
  if (h) m.set(4, bytes(h));
  m.set(5, idOf(o.parent));
  m.set(6, spot(o.at));
  return m;
}

/** The edit intent's bytes: `ops` by the creator `creator`, its `sequence`, planned against `basis`. */
export function editIntent(creator: IdValue, sequence: number, basis: Version, ops: Op[], expiry: number | bigint = EXPIRY): Uint8Array {
  return encode(new Map<number, unknown>([
    [1, new Map<number, unknown>([[1, 2], [2, creator]])],
    [2, VERB],
    [4, new Map([[1, ops.map(opValue)]])],
    [5, sequence],
    [6, basis],
    [7, expiry],
  ]));
}

/** A frame from the gateway, as the panel reads it. */
export type Frame =
  | { t: 'outcome'; name: string }
  | { t: 'receipt'; sequence: number; version: Version | null; names: Map<number, string> }
  | { t: 'refused'; sequence: number; version: Version | null; reason: string; op: number | null }
  | { t: 'other' };

const num = (v: unknown) => Number(v as number | bigint);

/** Reads one binary frame: the sign-in's outcome `{4: name}`, or an answer `{1: version, 2: answer}`. */
export function readFrame(b: Uint8Array): Frame {
  let v: unknown;
  try {
    v = decode(b, { useMaps: true });
  } catch {
    return { t: 'other' };
  }
  if (!(v instanceof Map)) return { t: 'other' };
  if (typeof v.get(4) === 'string') return { t: 'outcome', name: v.get(4) };
  const a = v.get(2);
  if (!(a instanceof Map)) return { t: 'other' };
  const version = Array.isArray(v.get(1)) ? (v.get(1) as Version) : null;
  const sequence = num(a.get(2));
  if (num(a.get(3)) === 1) {
    const names = new Map<number, string>();
    if (a.get(6) instanceof Map) for (const [n, id] of a.get(6) as Map<unknown, IdValue>) names.set(num(n), idText(id));
    return { t: 'receipt', sequence, version, names };
  }
  if (num(a.get(3)) === 2 || num(a.get(3)) === 5) {
    return { t: 'refused', sequence, version, reason: String(a.get(4)), op: a.has(7) ? num(a.get(7)) : null };
  }
  return { t: 'other' };
}

/** The version's sequence, to compare two. */
export const sequenceOf = (v: Version | null) => (v ? num(v[3]) : 0);
