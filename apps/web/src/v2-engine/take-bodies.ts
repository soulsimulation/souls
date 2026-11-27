// Stage 4 (#4175): what a v2 body is doing beyond walking, in the old take's words. A body in a thing's slot sits on it
// (or lies, on a bed); a thing whose frame is a body is held by it. Pure: the bridge records these as parts arrive and
// takes.ts writes them into each chunk as the old server's changes (`activity`, `seatHeight`, `prop`).

import { lookBody } from '../humanoid/look.ts';
import type { BodySlot } from './source/kind-bounds.ts';
import type { HeldSet } from '../../../../mars/viewer/app/engine-view/held-entry.ts';

/** A body's seat while it is in a slot: the slot's height above its thing's base (mm), and whether it lies there. */
/** `heading` (radians, atan2(dz, dx)): the way a sitter faces, out of the seat (the slot's yaw turning the thing's +z),
 *  absent for a bed or a ride. */
export type Seat = { height: number; lie: boolean; ride?: true; heading?: number };

/** Things a body lies on rather than sits on, by kind name (`<pack>:<name>@<rev>`). */
const LIE_ON = /(^|[:_-])(bed|bunk|cot|hammock|mattress|sleeping[_-]?(?:bag|mat)|futon)([_-]|@|$)/i;

/** Body places declared by an entry. Their numbers follow the native entry order, including non-body slots. */
export function bodySlotsOf(entry: unknown): BodySlot[] {
  const e = entry as { owner?: unknown; slots?: Record<string, { admits?: unknown; at_mm?: unknown; posture?: unknown; yaw_mdeg?: unknown; most?: unknown }> } | null;
  if (!e || e.owner !== 'thing' || !e.slots || typeof e.slots !== 'object') return [];
  return Object.values(e.slots).flatMap((s, i) => {
    if (s?.admits !== 'body' || !Array.isArray(s.at_mm) || s.at_mm.length !== 3 || !s.at_mm.every(Number.isSafeInteger)) return [];
    const posture = s.posture === 'sit' || s.posture === 'lie' ? s.posture : 'stand';
    return [{ row: [i + 1, ...s.at_mm, typeof s.yaw_mdeg === 'number' ? s.yaw_mdeg : 0, typeof s.most === 'number' ? s.most : 1], posture }];
  });
}

/** A declared standing place keeps the recorded root (including its platform height). Only a declared seat/bed
 *  lowers the take's root to the floor and supplies seatHeight. Legacy kinds without an entry keep their old rule. */
export function seatOf(kind: string, slot: readonly number[] | undefined): Seat;
export function seatOf(kind: string, slot: readonly number[] | undefined, declared: BodySlot | undefined): Seat | undefined;
export function seatOf(kind: string, slot: readonly number[] | undefined, declared?: BodySlot): Seat | undefined {
  if (declared?.posture === 'stand') return undefined;
  return { height: Math.max(0, slot?.[2] ?? 0), lie: declared ? declared.posture === 'lie' : LIE_ON.test(kind) };
}

/** The old take's posture for a still body at `seat` (null: standing). K4 (0.135): in a ride's slot (a thing on a course,
 *  a balloon's basket) it stands at the slot and rides (activity-poses.ts `ride`: hands on the rim). */
export const postureOf = (seat: Seat | null | undefined) => (seat ? (seat.ride ? 'ride' : seat.lie ? 'lie' : 'sit') : null);

/** The old renderer's hand props (mars/viewer/app/engine-view/activity-poses.ts PROPS), by words in a thing's kind. */
const PROP_WORDS: [RegExp, string][] = [
  [/book|novel|journal|notebook/, 'book'], [/cup|mug|glass|bottle|flask|teapot/, 'cup'], [/plate|bowl|dish/, 'plate'],
  [/flower|bouquet|rose|tulip/, 'flower'], [/bread|loaf|bun/, 'bread'], [/letter|envelope|note|card/, 'letter'],
  [/pen|pencil|quill/, 'pen'], [/brush/, 'brush'], [/spoon|ladle/, 'spoon'], [/guitar/, 'guitar'], [/violin|fiddle/, 'violin'],
  [/flute/, 'flute'], [/frisbee/, 'frisbee'], [/boule|ball/, 'boule'], [/rod/, 'rod'], [/apple|fruit|food|sandwich|cake/, 'food'],
  [/basket/, 'basket'], [/dumbbell/, 'dumbbell'],
];

/** The prop the old page draws in the hand for a held thing of `kind`; a thing it has no prop for is drawn as a tool. */
export function propOf(kind: string): string {
  const name = kind.split('@')[0].split(':').pop()!.toLowerCase();
  for (const [re, prop] of PROP_WORDS) if (re.test(name)) return prop;
  return 'tool';
}

/** A change of what a body holds: world time (µs) and the prop, null when its hands are empty again. */
export type Held = { at: number; prop: string | null };

/** Public held-record observations. No observation before t means unknown, not an empty hand. */
export function heldEntriesAt(history: readonly HeldSet[] | undefined, t: number): HeldSet | undefined {
  let found: HeldSet | undefined;
  for (const sample of history ?? []) { if (sample.observedAt > t) break; found = sample; }
  return found;
}

/** What `held` (in time order) has in the hand at world time `t` µs. */
export function heldAt(held: readonly Held[] | undefined, t: number): string | null {
  let prop: string | null = null;
  for (const h of held ?? []) { if (h.at > t) break; prop = h.prop; }
  return prop;
}

/** Both pages' default people, in the same order (v2/web/src/crowd/bodies.ts BODIES; people-light.ts PEOPLE). */
export const LOOKS = ['casual', 'punk', 'woman'] as const;
/** The v2 page's id hash (crowd/bodies.ts: FNV-1a) and the old page's (people-light.ts hashId). */
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const legacyHash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** The default look the v2 page gives body node `id` (no body-kind hash): one of LOOKS by its id. */
export const defaultLookOf = (id: string) => LOOKS[fnv(id) % LOOKS.length];

/** The take entity id for body node `id` whose old-page look is `look`: the old page picks a default person by the
 *  entity id's hash, so `base` gets one letter that makes that pick `look` (h·31 + c, mod 3: a, b and c cover all three). */
export function entityWithLook(base: string, look: string): string {
  const want = LOOKS.indexOf(look as (typeof LOOKS)[number]);
  if (want < 0) return base;
  for (const c of 'abc') if (legacyHash(`${base}_${c}`) % LOOKS.length === want) return `${base}_${c}`;
  return base;
}

/** One body of the v2 catalogue (`souls/bodies/1`, v2/tools/import-body/presets.ts Entry): its hash and the old page's
 *  record of the same body (`legacy[0]`, a BODY-v1 RenderBody). */
export type BodyResource = readonly [string, number, number?];
export type CatalogueBody = { hash: string; legacy?: unknown[]; entry?: string; entryHash?: string; resources?: readonly BodyResource[] };

/** Read only hash-verified companion metadata. Missing/ambiguous slots stay unknown. */
export function bodyResources(value: unknown): readonly BodyResource[] | undefined {
  if (!Array.isArray(value) || !value.length || value.some(r => !Array.isArray(r) || r.length < 2 || r.length > 3
    || typeof r[0] !== 'string' || !Number.isSafeInteger(r[1]) || r[2] !== undefined && (!Number.isSafeInteger(r[2]) || r[2] < 1))) return undefined;
  if (new Set(value.map(r => r[0])).size !== value.length) return undefined;
  const slots = value.filter(r => r[1] === 2 && r[2] !== undefined).map(r => r[2]);
  if (new Set(slots).size !== slots.length) return undefined;
  return value.map(r => Object.freeze([...r]) as BodyResource);
}

/** Existing catalogue entryHash binds model JSON and its additive resource metadata to this exact body kind. */
export async function loadBodyResources(rows: readonly CatalogueBody[], base: string, read: typeof fetch = fetch): Promise<CatalogueBody[]> {
  return Promise.all(rows.map(async row => {
    if (!row.entry || !/^[a-z][a-z0-9_]*\.json$/.test(row.entry) || !/^[a-f0-9]{64}$/.test(row.entryHash ?? '')) return {...row, resources: undefined};
    try {
      const response = await read(base + row.entry); if (!response.ok) return {...row, resources: undefined};
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== row.entryHash) return {...row, resources: undefined};
      const json = JSON.parse(new TextDecoder().decode(bytes));
      if (json.kindHash !== row.hash) return {...row, resources: undefined};
      return {...row, resources: bodyResources(json.resources)};
    } catch { return {...row, resources: undefined}; }
  }));
}

/** The old page's body record for a v2 body-kind hash, from the catalogue; null when it has none (drawn by default). */
export function legacyBodyOf(hash: string | undefined, catalogue: ReadonlyMap<string, CatalogueBody> | null): Record<string, unknown> | null {
  const b = hash ? catalogue?.get(hash)?.legacy?.[0] : null;
  return b && typeof b === 'object' && !Array.isArray(b) && ((b as { family?: unknown }).family === 'humanoid' || (b as { family?: unknown }).family === 'floater')
    ? { ...(b as Record<string, unknown>), ...(catalogue?.get(hash!)?.resources ? { nativeResources: catalogue.get(hash!)!.resources, nativeKindHash: hash } : {}) } : null;
}

/** V3: the old body record (BODY-v1, the old renderer's humanoid look) for a body's own look, field 33's params as
 *  JSON (G2's `life:look`); null when there are none or they are not a look the old page's look code takes. */
export function lookBodyOf(params: string | undefined): Record<string, unknown> | null {
  if (!params) return null;
  try { return lookBody(JSON.parse(params)); } catch { return null; }
}

/** The catalogue's rows from `bodies.json` (`souls/bodies/1`); null for anything else. */
export function catalogueOf(json: unknown): CatalogueBody[] | null {
  const c = json as { format?: unknown; bodies?: unknown } | null;
  if (!c || c.format !== 'souls/bodies/1' || !Array.isArray(c.bodies)) return null;
  return c.bodies.filter((b): b is CatalogueBody => !!b && typeof b === 'object' && typeof (b as CatalogueBody).hash === 'string' && /^[a-f0-9]{64}$/.test((b as CatalogueBody).hash));
}

const BODIES_DIR = /^\/[A-Za-z0-9._-][A-Za-z0-9._/-]*\/$/; // one leading slash: never `//host/`
/** The catalogue's address: `value` names a same-origin directory of the v2 page's body assets (as its `?bodies=`,
 *  `…/assets/bodies/`); null when it names none or anything else. */
export function bodiesUrl(value: unknown): string | null {
  return typeof value === 'string' && BODIES_DIR.test(value) && !value.split('/').some((s) => s === '.' || s === '..') ? `${value}bodies.json` : null;
}
