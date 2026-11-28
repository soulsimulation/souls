// What the world's default body is made of (#5068), as the world itself says it: the world node's field 146
// (`replica::bodies::F_DEFAULT_FAMILY`), `{1: kind, 2: [{1: name, 2: class, 3: slot}, ...]}`: the default body's exact
// pinned kind (`namespace:name@revision`) and its family's resources in order, each with its class (1 locomotion,
// 2 manipulator, 3 gaze, 4 voice) and, for a manipulator, the body's slot that holds what it holds. Only the world
// writes the field, so which slot is which hand is read here and never guessed.
//
// Which body it speaks for (`resourcesOf`): a body that wears a catalogue body (field 32) is that body's own
// hash-bound kind file's to describe, never this field's; a body that wears none takes these resources only when its
// kind is exactly the kind the field names.

/** The world node's default-family field. */
export const F_DEFAULT_FAMILY = 146;
/** A resource's class: 1 locomotion, 2 manipulator, 3 gaze, 4 voice. */
export type ResourceClass = 1 | 2 | 3 | 4;
export const MANIPULATOR = 2;
/** One resource of a family; `slot` on a manipulator only. */
export type BodyResource = { name: string; class: ResourceClass; slot?: number };
/** The default body's kind, by its full pinned name, and its resources in the family's order. */
export type DefaultFamily = { kind: string; resources: BodyResource[] };

const whole = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
/** A decoded map's entries by number, or null when it is not a map or holds a key outside 1..`most`. */
function entries(v: unknown, most: number): Map<number, unknown> | null {
  if (!(v instanceof Map)) return null;
  const out = new Map<number, unknown>();
  for (const [k, x] of v) {
    const n = whole(k);
    if (n === null || n < 1 || n > most) return null;
    out.set(n, x);
  }
  return out;
}

/** The default family a node's field map holds, or undefined: when it holds none (any node but the world's), or holds
 *  anything but a whole, well-formed one (an unknown key or class, a slot on a resource that is no manipulator, two
 *  resources of one name), as `replica`'s `Family::from_value` refuses it. */
export function defaultFamilyOf(f: Map<number, unknown>): DefaultFamily | undefined {
  const m = entries(f.get(F_DEFAULT_FAMILY), 2);
  const kind = m?.get(1), list = m?.get(2);
  if (typeof kind !== 'string' || !Array.isArray(list)) return undefined;
  const resources: BodyResource[] = [];
  for (const row of list) {
    const r = entries(row, 3);
    const name = r?.get(1), cls = whole(r?.get(2));
    if (!r || typeof name !== 'string' || cls === null || cls < 1 || cls > 4) return undefined;
    if (resources.some((x) => x.name === name)) return undefined;
    const one: BodyResource = { name, class: cls as ResourceClass };
    if (r.has(3)) {
      const slot = whole(r.get(3));
      if (slot === null || cls !== MANIPULATOR) return undefined;
      one.slot = slot;
    }
    resources.push(one);
  }
  return { kind, resources };
}

/** The resources the world's default family gives `body`, or null when it does not speak for it: the body wears a
 *  catalogue body (`body`, field 32: explicit selection comes first), the world published no family, or the body's
 *  kind is not exactly the kind the family names. */
export function resourcesOf(body: { kind: string; body?: string }, family: DefaultFamily | undefined): BodyResource[] | null {
  if (body.body !== undefined || !family || body.kind !== family.kind) return null;
  return family.resources;
}
