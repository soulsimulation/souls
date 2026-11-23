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
/** Moves drawn as the old renderer's hand hold (`human.handHold`) with the member they reach, not as a pose. */
const HOLDS: ReadonlySet<string> = new Set(['hold_hand']);

/** A gesture as the take draws it: world time µs, its end (planned or cut, `Infinity`-like for a held move), the old
 *  activity id (null for a hold); the body it is aimed at, if any, and (0.134 B1's aimed moves) where its target stood
 *  when it began, world x and z in mm; whether it holds that body's hand. */
export type Gesture = { start: number; end: number; activity: string | null; target?: string | null; toward?: [number, number]; hold?: boolean };

/** The old activity a move plays, or null: `souls:wave`, `wave@2` and `wave` alike. */
export function gestureOf(move: string): string | null {
  const name = move.slice(move.indexOf(':') + 1).split('@')[0];
  return GESTURES[name] ?? null;
}

/** A move record (start and phase ends, µs) as a gesture, or null when its move is not one. */
export function gestureFrom(move: { name: string; start: number; ends: readonly number[]; target?: string | null }, toward?: [number, number] | null): Gesture | null {
  const activity = gestureOf(move.name), end = move.ends[move.ends.length - 1];
  const hold = HOLDS.has(move.name.slice(move.name.indexOf(':') + 1).split('@')[0]);
  if (!(activity || hold) || !(end > move.start)) return null;
  return { start: move.start, end, activity: hold ? null : activity, ...(move.target ? { target: move.target } : {}), ...(toward ? { toward } : {}), ...(hold ? { hold } : {}) };
}

/** Ends a body's gesture running at `at` (its run ended early); one that has not begun or is over stays as it is. */
export function cut(gestures: Gesture[], at: number): void {
  for (const g of gestures) if (g.start <= at && at < g.end) g.end = at;
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
