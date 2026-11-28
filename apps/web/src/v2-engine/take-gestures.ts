// #3741 on the old page (0.132 B1-2): a v2 run's gesture move (the stream's `souls:form-move` record, read by
// v2/web/src/source) plays the old renderer's own gesture pose (mars/viewer/app/engine-view/activity-poses.ts) as the
// body's take activity, from the move's start to its end, or to the run's ending when that comes first. Pure.

import { recordedConsumeMove, type ConsumeMove } from '../../../../mars/viewer/app/engine-view/held-entry.ts';
import type { MoveRec } from './source/source.ts';

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
/** The existing humanoid resource names, with the move’s authoritative phase times in world µs. */
export type FormPress = { hand: 'left' | 'right'; start: number; contact: number; end: number; cut?: number; current?: boolean };
export type Gesture = { press?: FormPress; point?: { hand: 'left' | 'right'; ends: readonly number[]; contact?: string }; start: number; end: number; activity: string | null; target?: string | null; toward?: [number, number]; hold?: boolean; run?: string };

export const isConsume = (name: string): boolean => name.slice(name.indexOf(':') + 1).split('@')[0] === 'consume';

/** Replace late move endings without mutating a record already published in a take. */
export function recordConsume(history: readonly ConsumeMove[] | undefined, move: MoveRec): ConsumeMove[] {
  const before = history ?? [], prior = before.find(c => c.body === move.body && c.run === move.run && c.start === move.start);
  const next = recordedConsumeMove({ ...move, ...(prior?.ended && !move.ended ? { ended: prior.ended } : {}), ...(prior?.runEnd ? { runEnd: prior.runEnd } : {}) });
  if (!next) return [...before];
  return [...before.filter(c => c !== prior), next].sort((a, b) => a.start - b.start);
}

/** Keep run termination distinct from the move's own native ending; never invent a completion. */
export function endConsumes(history: readonly ConsumeMove[] | undefined, end: { at: number; run?: string; how?: string }): ConsumeMove[] | undefined {
  return history?.map(c => end.run !== undefined && c.run === end.run && c.start <= end.at && c.runEnd === undefined
    ? recordedConsumeMove({ ...c, runEnd: { at: end.at, ...(end.how === undefined ? {} : { how: end.how }) } }) ?? c : c);
}

/** Last begun observation, including its recorded completion/recovery facts. This is not an active-pose claim. */
export function consumeAt(history: readonly ConsumeMove[] | undefined, t: number): ConsumeMove | undefined {
  let out: ConsumeMove | undefined;
  for (const c of history ?? []) if (c.start <= t && (!out || c.start >= out.start)) out = c;
  return out;
}

/** The old activity a move plays, or null: `souls:wave`, `wave@2` and `wave` alike. */
export function gestureOf(move: string): string | null {
  const name = move.slice(move.indexOf(':') + 1).split('@')[0];
  return GESTURES[name] ?? null;
}

/** A move record (start and phase ends, µs) as a gesture, or null when its move is not one. */
export function gestureFrom(move: { name: string; start: number; ends: readonly number[]; target?: string | null; run?: string; limbs?: readonly string[]; contact?: string }, toward?: [number, number] | null): Gesture | null {
  const activity = gestureOf(move.name), last = move.ends[move.ends.length - 1];
  const hold = HOLDS.has(move.name.slice(move.name.indexOf(':') + 1).split('@')[0]);
  if (!(activity || hold) || !(last > move.start)) return null;
  const end = activity && LOOPS.has(activity) ? last + LOOP_HOLD : last;
  const hands = (move.limbs ?? []).filter(x => x === 'souls:hand-left' || x === 'souls:hand-right');
  const press: FormPress | undefined = activity === 'operate' && hands.length === 1 && move.ends.length >= 2 && move.ends[0] > move.start && last > move.ends[0]
    ? { hand: hands[0] === 'souls:hand-left' ? 'left' : 'right', start: move.start, contact: move.ends[0], end: last } : undefined;
  const point: Gesture['point'] = activity === 'point' && hands.length === 1 && move.target && toward?.every(Number.isFinite)
    ? { hand: hands[0] === 'souls:hand-left' ? 'left' : 'right', ends: [...move.ends], ...(move.contact ? { contact: move.contact } : {}) } : undefined;
  return { ...(press ? { press } : {}), ...(point ? { point } : {}), start: move.start, end, activity: hold ? null : activity, ...(move.target ? { target: move.target } : {}), ...(toward ? { toward: [...toward] as [number, number] } : {}), ...(hold ? { hold } : {}), ...(move.run ? { run: move.run } : {}) };
}

/** Cosmetic named-target bearing only, metres/world µs. Retain the existing half-second point return. */
export function pointAimAt(gestures: readonly Gesture[] | undefined, t: number) {
  let g: Gesture | undefined;
  for (const candidate of gestures ?? []) if (candidate.start <= t) g = candidate;
  const point = g?.point;
  if (!g || !point || !g.target || !g.toward || t > g.end + 500_000) return null;
  return { target: g.target, at: g.toward.map(n => n / 1000) as [number, number], hand: point.hand, start: g.start,
    ends: [...point.ends], ...(g.end < point.ends.at(-1)! ? { cut: g.end } : {}), ...(point.contact ? { contact: point.contact } : {}), ...(g.run ? { run: g.run } : {}) };
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

/** Keep only the recorded free-hand recovery after an early run end; never extend the activity itself. */
export function pressAt(gestures: readonly Gesture[] | undefined, t: number): FormPress[] | null {
  const out: FormPress[] = [];
  const latest = (gestures ?? []).filter(g=>g.start<=t).at(-1);
  for (const g of gestures ?? []) {
    const p = g.press; if (!p || g.start > t) continue;
    const cut = g.end < p.end ? g.end : undefined;
    // Retain a zero-weight normal endpoint through the renderer's 0.3s generic fade window.
    // This is metadata only: gestureAt still ends at the native end.
    const end = cut === undefined ? p.end + 300_000 : cut + Math.max(300_000,p.end-p.contact);
    if (t < end) out.push({ ...p, current:g===latest, ...(cut === undefined ? {} : { cut }) });
  }
  return out.length ? out : null;
}
