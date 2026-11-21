// Gestures on the page (#3741): a run's move record from the stream (`souls:form-move`) plays its move's clip over
// the body's posture, then the body returns to it. The clip, its weight and its phase are a function of the record
// and world time alone, as the rest of the pose (V7): nothing here moves a body or keeps time of its own.
//
// - Which clip a move plays is today's choice (`mars/viewer/app/engine-view/clip-library.ts`): nod is `Yes` and
//   shake-head `Idle_No_Loop`, both at 1.6x; cheer is `Celebration` fitted to the move; dance `Dance_Loop`. Wave plays
//   the library's `Wave`, and bow `Bow`, made at bake time from the idle with today's bend (`activity-poses.ts`: the
//   back leans 0.55 rad and the head 0.2, on a half sine over the move). A move with no clip draws nothing new.
// - Weight comes in over the move's start-up (its start to contact) and goes out over `LEAVE` after its end: the
//   planned end, or the run's ending when that comes first (a cancel). As `../pose/gesture.ts`.
// - Seated, a move plays its seated clip where today has one (nod: `Sitting_Nodding_Loop`), and only above the hips.
import type { MoveRec, PartRec, RunEndRec } from '../source/source.ts';

export type GestureClip = { clip: string; mode: 'loop' | 'once'; rate?: number; seated?: string };

/** Each move with a clip, by its content name (`content/moves`). */
export const GESTURE_CLIPS: Readonly<Record<string, GestureClip>> = {
  wave: { clip: 'Wave', mode: 'loop' },
  bow: { clip: 'Bow', mode: 'once' },
  nod: { clip: 'Yes', mode: 'loop', rate: 1.6, seated: 'Sitting_Nodding_Loop' },
  shake_head: { clip: 'Idle_No_Loop', mode: 'loop', rate: 1.6 },
  cheer: { clip: 'Celebration', mode: 'once' },
  dance: { clip: 'Dance_Loop', mode: 'loop' },
  look_around: { clip: 'Idle_LookAround_Loop', mode: 'loop' },
  slump: { clip: 'Idle_Tired_Loop', mode: 'loop' },
};

/** The gesture clips the page bakes, beside its posture clips. */
export const GESTURE_CLIP_NAMES = [...new Set(Object.values(GESTURE_CLIPS).flatMap((g) => (g.seated ? [g.clip, g.seated] : [g.clip])))];

/** Seconds a gesture takes to leave once its move ends (`../pose/gesture.ts`'s LEAVE). */
export const LEAVE = 0.4;
/** Moves kept per body: the newest few are all a frame can draw. */
const KEEP = 4;

/** A move as drawn: its record and, once the run ended early, when. */
export type Drawn = MoveRec & { cut?: number };
/** What a body draws at a time: the clip's name, its phase in cycles (`seconds` is the clip's length) and weight. */
export type Gesture = { clip: string; phase: number; weight: number };

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** The gesture of `moves` (a body's, in start order) at world time `t` (µs), or null; `seconds(clip)` is a clip's
 * length, or undefined when the model has no such clip. */
export function gestureAt(moves: readonly Drawn[], t: number, seated: boolean, seconds: (clip: string) => number | undefined): Gesture | null {
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    if (m.start > t) continue;
    const g = GESTURE_CLIPS[m.name];
    const end = Math.min(m.cut ?? Infinity, m.ends[m.ends.length - 1]);
    if (t > end + LEAVE * 1e6) return null;
    if (!g) return null;
    const clip = (seated && g.seated) || g.clip, len = seconds(clip);
    if (len === undefined) return null;
    const contact = m.ends[0];
    const weight = smooth((t - m.start) / Math.max(1, contact - m.start)) * (1 - smooth((t - end) / (LEAVE * 1e6)));
    const since = (t - m.start) / 1e6;
    // A one-shot is fitted to the move (its planned span) and holds its last frame; a loop plays at its rate.
    const span = (m.ends[m.ends.length - 1] - m.start) / 1e6;
    const phase = g.mode === 'once' ? Math.min(0.999, since / Math.max(1e-3, span)) : (since * (g.rate ?? 1)) / len;
    return { clip, phase, weight };
  }
  return null;
}

/** Every body's recent moves, from the stream's parts. */
export class Gestures {
  readonly moves = new Map<string, Drawn[]>();

  /** Takes a part's move records and run endings. */
  apply(p: Pick<PartRec, 'moves' | 'runEnds' | 'removed'>): void {
    for (const m of p.moves ?? []) {
      const list = this.moves.get(m.body) ?? this.moves.set(m.body, []).get(m.body)!;
      if (list.some((x) => x.start === m.start && x.name === m.name)) continue;
      list.push({ ...m });
      list.sort((a, b) => a.start - b.start);
      if (list.length > KEEP) list.shift();
    }
    for (const e of p.runEnds ?? []) this.end(e);
    for (const id of p.removed ?? []) this.moves.delete(id);
  }

  /** A run ended: a move of its body still going then is cut there (a cancel; a done run ends with its move). */
  private end(e: RunEndRec): void {
    for (const m of this.moves.get(e.body) ?? []) if (m.start <= e.at && e.at < m.ends[m.ends.length - 1] && m.cut === undefined) m.cut = e.at;
  }

  at(body: string, t: number, seated: boolean, seconds: (clip: string) => number | undefined): Gesture | null {
    const list = this.moves.get(body);
    return list ? gestureAt(list, t, seated, seconds) : null;
  }
}
