// #3741 on the old page (0.132 B1-2): a v2 run's gesture move (the stream's `souls:form-move` record, read by
// v2/web/src/source) plays the old renderer's own gesture pose (mars/viewer/app/engine-view/activity-poses.ts) as the
// body's take activity, from the move's start to its end, or to the run's ending when that comes first. Pure.

/** Old activity ids by content move name (`content/moves`); the rest of the moves are not gestures and draw nothing. */
const GESTURES: Readonly<Record<string, string>> = {
  wave: 'wave', bow: 'bow', clap: 'clap', nod: 'nod', shake_head: 'shake-head', cheer: 'cheer', point: 'point',
  dance: 'dance', jump: 'jump', stretch: 'stretch',
  // No old pose of their own: the nearest one (listed on #3756).
  shrug: 'shake-head', look_around: 'listen', slump: 'listen',
};

/** A gesture as the take draws it: world time µs, its end (planned or cut), the old activity id. */
export type Gesture = { start: number; end: number; activity: string };

/** The old activity a move plays, or null: `souls:wave`, `wave@2` and `wave` alike. */
export function gestureOf(move: string): string | null {
  const name = move.slice(move.indexOf(':') + 1).split('@')[0];
  return GESTURES[name] ?? null;
}

/** A move record (start and phase ends, µs) as a gesture, or null when its move is not one. */
export function gestureFrom(move: { name: string; start: number; ends: readonly number[] }): Gesture | null {
  const activity = gestureOf(move.name), end = move.ends[move.ends.length - 1];
  return activity && end > move.start ? { start: move.start, end, activity } : null;
}

/** Ends a body's gesture running at `at` (its run ended early); one that has not begun or is over stays as it is. */
export function cut(gestures: Gesture[], at: number): void {
  for (const g of gestures) if (g.start <= at && at < g.end) g.end = at;
}

/** The activity of the gesture playing at world time t (the newest begun), or null. */
export function gestureAt(gestures: readonly Gesture[] | undefined, t: number): string | null {
  let out: string | null = null;
  for (const g of gestures ?? []) if (g.start <= t && t < g.end) out = g.activity;
  return out;
}
