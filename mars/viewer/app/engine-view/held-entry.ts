/** Public native held records, carried as discrete take state. These are observations, never grip targets. */
export type HeldValue = null | boolean | number | string | { readonly [key: string]: HeldValue } | readonly HeldValue[];
export type HeldEntry = {
  readonly id: string;
  readonly kind: string;
  readonly parent: string | null;
  readonly slot: number | null;
  /** Native parent-local micrometres and quaternion [w,x,y,z] scaled by 2^30, without reinterpretation. */
  readonly pos: readonly [number, number, number];
  readonly rot: readonly [number, number, number, number];
  readonly fields?: Readonly<Record<string, HeldValue>>;
  /** Existing public state translation; raw fields above remain authoritative. */
  readonly state?: Readonly<Record<string, boolean | number | string>>;
  readonly tint?: readonly (readonly [string, number])[];
  readonly origin?: string;
  readonly def?: string;
  readonly params?: Readonly<Record<string, HeldValue>>;
};
export type HeldSet = {
  /** World µs at which the reader observed this set; not a claimed exact change/event time. */
  readonly observedAt: number;
  /** Empty is an observed empty set. Absent HeldSet means legacy/unknown metadata. */
  readonly entries: readonly HeldEntry[];
};

/** Same lossless large-integer representation as form-rules' public JSON ({big:decimal}); no Number coercion. */
export function heldValue(value: unknown): HeldValue {
  if (typeof value === 'bigint') return Object.freeze({ big: String(value) });
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(heldValue));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, heldValue(v)])));
  throw new TypeError('held entry contains a non-public value');
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isSafeInteger(x));
const json = (v: unknown): boolean => v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)
  || Array.isArray(v) && v.every(json) || object(v) && Object.values(v).every(json);

/** Validate recorded state without supplying missing slots, transforms or contents. Old string takes have none. */
export function recordedHeldSet(value: unknown): HeldSet | undefined {
  if (!object(value) || typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) || !Array.isArray(value.entries)) return undefined;
  const ids = new Set<string>();
  for (const e of value.entries) {
    if (!object(e) || typeof e.id !== 'string' || !e.id || ids.has(e.id) || typeof e.kind !== 'string' || !e.kind
      || !(e.parent === null || typeof e.parent === 'string') || !(e.slot === null || typeof e.slot === 'number' && Number.isSafeInteger(e.slot))
      || !tuple(e.pos, 3) || !tuple(e.rot, 4)) return undefined;
    ids.add(e.id);
    for (const key of ['fields', 'params']) if (e[key] !== undefined && (!object(e[key]) || !json(e[key]))) return undefined;
    if (e.state !== undefined && (!object(e.state) || !Object.values(e.state).every(v => typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)))) return undefined;
    for (const key of ['origin', 'def']) if (e[key] !== undefined && typeof e[key] !== 'string') return undefined;
    if (e.tint !== undefined && (!Array.isArray(e.tint) || !e.tint.every(v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isSafeInteger(v[1])))) return undefined;
  }
  return json(value) ? heldValue(value) as unknown as HeldSet : undefined;
}
