// A thing's kind state on the page (#3871). A node's fields (record key 6) hold its kind's state by each field's stable
// number `n` (`content/kinds`, `souls-entry/1`; replica `kinds/entry.rs` section 3): a bool as 0 or 1, an int or
// duration as a whole number, an enum as its value's text and a timed value as its three stored whole numbers
// `[value, per_s, set_us]` (replica `timed.rs`). The worker keeps every such plain field of a node (`fieldsOf`); the
// page names them by its kind's entry and reads a timed value at the world time it draws (`kindState`).
import { isTimed, valueAt, type Int, type Timed } from './timed.ts';

/** A node's plain fields by number: whole numbers, texts and timed values. */
export type Fields = Record<number, Int | string | Timed>;

/** A kind's state field, as its entry declares it. */
export type StateDef = { n: number; type: string; values?: string[]; min?: number; max?: number; unit?: string; default?: unknown };

const whole = (v: unknown): v is Int => (typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'bigint';
/** A whole number as a number when it is a safe one, else kept as a big integer. */
const int = (v: Int): Int => (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

/** Every plain field of a node's field map (record key 6): a whole number, a text, or a timed value's three numbers.
 *  Bytes, references, rows and other records are not state a look reads, so they are left out. Undefined when none. */
export function fieldsOf(f: Map<number, unknown>): Fields | undefined {
  let out: Fields | undefined;
  for (const [k, v] of f) {
    let x: Int | string | Timed | undefined;
    if (whole(v)) x = int(v);
    else if (typeof v === 'string') x = v;
    else if (Array.isArray(v) && v.length === 3 && v.every(whole)) x = { value: int(v[0]), per_s: int(v[1]), set_us: int(v[2]) };
    if (x !== undefined) (out ??= {})[k] = x;
  }
  return out;
}

/** A field's default as the entry writes it, in the node's terms. */
function defaultOf(d: StateDef): Int | string | Timed | undefined {
  const v = d.default;
  if (d.type === 'bool') return v === true ? 1 : v === false ? 0 : undefined;
  if (isTimed(v) || whole(v) || typeof v === 'string') return v;
  return undefined;
}

/** The thing's state by field name, as a look reads it: a bool as true or false, an enum as its value, a number as
 *  it is, a timed value as its value at `now_us` (as set, before it was set; its stored numbers when no time is known
 *  yet). A field the node does not hold takes the entry's default. Text, list and schedule fields are left out. */
export function kindState(fields: Fields | undefined, defs: Record<string, StateDef>, now_us?: Int): Record<string, boolean | Int | string | Timed> {
  const out: Record<string, boolean | Int | string | Timed> = {};
  for (const [name, d] of Object.entries(defs)) {
    const held = fields?.[d.n] ?? defaultOf(d);
    if (held === undefined) continue;
    if (d.type === 'bool') { if (whole(held)) out[name] = Number(held) !== 0; }
    else if (d.type === 'enum') { if (typeof held === 'string') out[name] = held; }
    else if (d.type === 'timed') {
      if (!isTimed(held)) continue;
      if (now_us === undefined) { out[name] = held; continue; }
      const t = BigInt(now_us) < BigInt(held.set_us) ? held.set_us : now_us;
      const v = valueAt({ min: d.min, max: d.max }, held, t);
      if (typeof v !== 'object') out[name] = v;
    } else if ((d.type === 'int' || d.type === 'duration' || d.type === 'number') && whole(held)) out[name] = held;
  }
  return out;
}
