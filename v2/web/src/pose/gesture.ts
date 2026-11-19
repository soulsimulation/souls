// Gestures and moods as drawn (Engine v2 E11, #2782): the clip and caption of a gesture or mood, from its record and
// world time alone, as the rest of the pose (V7).
//
// - A gesture's record (`v2/crates/sim/src/gesture.rs`) is B2's move record, whose move is the stand-in named by its
//   clip, with the words' reference, the stand-in the agent named and whom it looks at. The words are resolved by the
//   viewer (T8's audience: null when it may not see them, or they were removed).
// - The clip is the viewer's: its own clip for those words when it has one (`GESTURE_CLIPS`, an exact lookup, never
//   the nearest), else the stand-in's, else the idle. So a later viewer with a real clip draws it from the same record.
// - A mood is held from its record until the next; it takes the idle's place, so a walk blends over it and leaves it.
// - The caption is the words, while the gesture is drawn, else the mood's.
import type { MoveRecord, PoseModel } from './pose.ts';

/** A gesture's record: its move (the stand-in), its words by reference, the stand-in named, the gaze target. */
export type GestureRecord = { move: MoveRecord; words: string; like?: string; gaze?: string };
/** A body's mood from `since` (µs) until the next record: its words by reference and stand-in; words null clears it. */
export type MoodRecord = { since: number; words: string | null; like?: string };
/** The words of a reference, for this viewer: null when it may not see them or they were removed. */
export type Words = (ref: string) => string | null;

/** The viewer's own clips for words, by the words (trimmed, lower case). Added as clips are made. */
export const GESTURE_CLIPS: Readonly<Record<string, string>> = { 'do a cartwheel': 'Cartwheel' };
/** Seconds a gesture takes to leave once its move ends. */
const LEAVE = 0.4;

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

export type Expression = {
  /** The gesture's clip, its phase (cycles) and weight; clip -1 for none. */
  gesture: number; gesturePhase: number; gestureWeight: number;
  /** The clip in the idle's place: the mood's, else the idle. */
  idle: number;
  /** The words shown beside the body, or null. */
  caption: string | null;
};

/** The clip drawn for `words` said as stand-in `standIn`: the viewer's own clip for the words, else the stand-in's. */
export function clipFor(model: PoseModel, said: string | null, standIn: string | undefined): number {
  const clip = (n: string | undefined) => (n === undefined ? -1 : model.clips.findIndex((c) => c.name === n));
  const own = said === null ? -1 : clip(GESTURE_CLIPS[said.trim().toLowerCase()]);
  return own >= 0 ? own : clip(standIn);
}

/** The gesture and mood drawn at `t` (µs), from the records alone. */
export function expressionAt(
  gestures: readonly GestureRecord[], moods: readonly MoodRecord[], model: PoseModel, t: number, words: Words, idle: number,
): Expression {
  let mood = -1, caption: string | null = null;
  for (let i = moods.length - 1; i >= 0; i--) {
    const m = moods[i];
    if (m.since > t) continue;
    if (m.words !== null) {
      caption = words(m.words);
      mood = clipFor(model, caption, m.like ?? 'Idle');
    }
    break;
  }
  let gesture = -1, gesturePhase = 0, gestureWeight = 0;
  for (let i = gestures.length - 1; i >= 0; i--) {
    const g = gestures[i], m = g.move;
    if (m.start > t) continue;
    const end = m.ended ? m.ended.at : m.ends[m.ends.length - 1];
    if (t > end + LEAVE * 1e6) break;
    const said = words(g.words);
    gesture = clipFor(model, said, m.name);
    if (gesture < 0) gesture = idle;
    gestureWeight = smooth((t - m.start) / (m.ends[0] - m.start)) * (1 - smooth((t - end) / (LEAVE * 1e6)));
    gesturePhase = (t - m.start) / 1e6 / (gesture >= 0 ? model.clips[gesture].seconds : 1);
    if (said !== null) caption = said;
    break;
  }
  return { gesture, gesturePhase, gestureWeight, idle: mood >= 0 ? mood : idle, caption };
}
