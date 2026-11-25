// #3741 on the old page (0.132 B1-2): a v2 run's gesture move (the stream's `souls:form-move` record, read by
// v2/web/src/source) plays the old renderer's own gesture pose (mars/viewer/app/engine-view/activity-poses.ts) as the
// body's take activity, from the move's start to its end, or to the run's ending when that comes first. Pure.

/** Old activity ids by content move name (`content/moves`); the rest of the moves are not gestures and draw nothing. */
const GESTURES: Readonly<Record<string, string>> = {
  wave: 'wave', bow: 'bow', clap: 'clap', nod: 'nod', shake_head: 'shake-head', cheer: 'cheer', point: 'point',
  dance: 'dance', jump: 'jump', stretch: 'stretch',
  // 0.134 B2: each its own pose, never another move's (shrug, look-around, slump, look and touch were drawn for this).
  shrug: 'shrug', look_around: 'look-around', slump: 'slump', look: 'look', touch: 'touch', press: 'operate',
  jumping_jacks: 'jumping-jacks', yoga: 'yoga', push_ups: 'pushups', sit_ups: 'situps', sing: 'sing', listen: 'listen',
  tell_story: 'tell-story', stargaze: 'stargaze',
  // 0.134 B4: lane T's touches, aimed at the other member (the take faces it and names it the partner).
  handshake: 'handshake', hug: 'hug', high_five: 'high-five',
};
/** Only named upper-body moves may overlay an authoritative seat; this adapter stays independent of scene modules. */
const WHOLE_BODY:ReadonlySet<string>=new Set(['dance','jump','stretch','jumping-jacks','yoga','pushups','situps','stargaze']);
export const SEATED_GESTURES:ReadonlySet<string>=new Set([...Object.values(GESTURES).filter(a=>!WHOLE_BODY.has(a)),'read']);
/** Moves drawn as the old renderer's hand hold (`human.handHold`) with the member they reach, not as a pose. */
const HOLDS: ReadonlySet<string> = new Set(['hold_hand']);
/** 0.134 T3: looped activities a dance on the beat repeats, one record a cycle, the next on the next whole beat after
 *  each ends. A cycle is drawn on until the next begins (at most a beat later), so the loop never drops to idle between
 *  cycles; the last one, when the member leaves, plays on that much past its end. */
export const LOOPS: ReadonlySet<string> = new Set(['dance']);
/** How long a looped cycle is drawn past its end: a beat and a little (beats are about half a second), µs. */
export const LOOP_HOLD = 700_000;

/** A gesture as the take draws it: world time µs, its end (planned or cut, `Infinity`-like for a held move), the old
 *  activity id (null for a hold); the body it is aimed at, if any, and (0.134 B1's aimed moves) where its target stood
 *  when it began, world x and z in mm; whether it holds that body's hand. */
export type Gesture = { start: number; end: number; activity: string | null; target?: string | null; toward?: [number, number]; hold?: boolean; run?: string };

/** The old activity a move plays, or null: `souls:wave`, `wave@2` and `wave` alike. */
export function gestureOf(move: string): string | null {
  const name = move.slice(move.indexOf(':') + 1).split('@')[0];
  return GESTURES[name] ?? null;
}

/** A move record (start and phase ends, µs) as a gesture, or null when its move is not one. */
export function gestureFrom(move: { name: string; start: number; ends: readonly number[]; target?: string | null; run?: string }, toward?: [number, number] | null): Gesture | null {
  const activity = gestureOf(move.name), last = move.ends[move.ends.length - 1];
  const hold = HOLDS.has(move.name.slice(move.name.indexOf(':') + 1).split('@')[0]);
  if (!(activity || hold) || !(last > move.start)) return null;
  const end = activity && LOOPS.has(activity) ? last + LOOP_HOLD : last;
  return { start: move.start, end, activity: hold ? null : activity, ...(move.target ? { target: move.target } : {}), ...(toward ? { toward } : {}), ...(hold ? { hold } : {}), ...(move.run ? { run: move.run } : {}) };
}
/** How long a reading is drawn at most when its run's end never reaches the page, µs. */
export const READ_LONGEST = 600_000_000;
/** A move aimed at a book the body holds (a book's `read` form looks at its spine, then waits) as the old renderer's
 *  `read` pose, the book open in both hands, until the run ends (`cut`) or the book leaves the hand (`endReading`).
 *  `heldProp`: the prop of the move's target when this body holds it, else null. Null when it is not a reading. */
export function readingFrom(move: { start: number; run?: string }, heldProp: string | null): Gesture | null {
  return heldProp === 'book' ? { start: move.start, end: move.start + READ_LONGEST, activity: 'read', ...(move.run ? { run: move.run } : {}) } : null;
}
/** Ends the reading running at `at`: the book left the body's hand. */
export function endReading(gestures: Gesture[], at: number): void {
  for (const g of gestures) if (g.activity === 'read' && g.start <= at && at < g.end) g.end = at;
}

/** Ends the gesture of the move that started at `start` at `at` (a held move let go, 0.134 T2). */
export function endGesture(gestures: Gesture[], start: number, at: number, run?: string): void {
  for (const g of gestures) if ((run === undefined || g.run === run) && g.start === start && at < g.end) g.end = Math.max(g.start, at);
}

/** Ends a body's gesture running at `at` (its run ended early); one that has not begun or is over stays as it is. */
export function cut(gestures: Gesture[], at: number, run?: string): void {
  for (const g of gestures) if ((run === undefined || g.run === run) && g.start <= at && at < g.end) g.end = at;
}

/** The gesture playing at world time t (the newest begun), or null. */
export function gestureNow(gestures: readonly Gesture[] | undefined, t: number): Gesture | null {
  let out: Gesture | null = null;
  for (const g of gestures ?? []) if (g.start <= t && t < g.end) out = g;
  return out;
}

/** Where the gesture playing at world time t is aimed (its target's world x and z, mm), or null. */
export function towardAt(gestures: readonly Gesture[] | undefined, t: number): [number, number] | null {
  return gestureNow(gestures, t)?.toward ?? null;
}

/** The activity of the gesture playing at world time t, or null (none, or a hand hold). */
export function gestureAt(gestures: readonly Gesture[] | undefined, t: number): string | null {
  return gestureNow(gestures, t)?.activity ?? null;
}
