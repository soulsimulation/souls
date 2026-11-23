// Stage 4 (#4175): what a v2 body is doing beyond walking, in the old take's words. A body in a thing's slot sits on it
// (or lies, on a bed); a thing whose frame is a body is held by it. Pure: the bridge records these as parts arrive and
// takes.ts writes them into each chunk as the old server's changes (`activity`, `seatHeight`, `prop`).

/** A body's seat while it is in a slot: the slot's height above its thing's base (mm), and whether it lies there. */
export type Seat = { height: number; lie: boolean };

/** Things a body lies on rather than sits on, by kind name (`<pack>:<name>@<rev>`). */
const LIE_ON = /(^|[:_-])(bed|bunk|cot|hammock|mattress|sleeping[_-]?bag|futon)([_-]|@|$)/i;

/** The seat a slot gives: `slot` is its row `[n, x, y, z, yaw mdeg, capacity]` (mm), `kind` its thing's kind. */
export function seatOf(kind: string, slot: readonly number[] | undefined): Seat {
  return { height: Math.max(0, slot?.[2] ?? 0), lie: LIE_ON.test(kind) };
}

/** The old take's posture for a still body at `seat` (null: standing). */
export const postureOf = (seat: Seat | null | undefined) => (seat ? (seat.lie ? 'lie' : 'sit') : null);

/** The old renderer's hand props (mars/viewer/app/engine-view/activity-poses.ts PROPS), by words in a thing's kind. */
const PROP_WORDS: [RegExp, string][] = [
  [/book|novel|journal|notebook/, 'book'], [/cup|mug|glass|bottle|flask|teapot/, 'cup'], [/plate|bowl|dish/, 'plate'],
  [/flower|bouquet|rose|tulip/, 'flower'], [/bread|loaf|bun/, 'bread'], [/letter|envelope|note|card/, 'letter'],
  [/pen|pencil|quill/, 'pen'], [/brush/, 'brush'], [/spoon|ladle/, 'spoon'], [/guitar/, 'guitar'], [/violin|fiddle/, 'violin'],
  [/flute/, 'flute'], [/frisbee/, 'frisbee'], [/boule|ball/, 'boule'], [/rod/, 'rod'], [/apple|fruit|food|sandwich|cake/, 'food'],
];

/** The prop the old page draws in the hand for a held thing of `kind`; a thing it has no prop for is drawn as a tool. */
export function propOf(kind: string): string {
  const name = kind.split('@')[0].split(':').pop()!.toLowerCase();
  for (const [re, prop] of PROP_WORDS) if (re.test(name)) return prop;
  return 'tool';
}

/** A change of what a body holds: world time (µs) and the prop, null when its hands are empty again. */
export type Held = { at: number; prop: string | null };

/** What `held` (in time order) has in the hand at world time `t` µs. */
export function heldAt(held: readonly Held[] | undefined, t: number): string | null {
  let prop: string | null = null;
  for (const h of held ?? []) { if (h.at > t) break; prop = h.prop; }
  return prop;
}
