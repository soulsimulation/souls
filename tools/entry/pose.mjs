// Where the hand is at any time, from a move, a point and a start time (Soul Actions SA-D4, #2856).
//
// A plain module with no imports, so the same file runs in Node and in a browser build. Whole-number arithmetic only:
// millimetres in and out, microseconds for time, permille for the easing, so the same record and time give the same
// position everywhere. No floating-point number decides anything; a viewer may smooth what it draws from these positions.
//
// The record of a move in progress carries which move, the limb, the contact point and the times:
//   { move: "<kind@hash>", limb: "<name>", start_us, from_mm: [x,y,z], contact_mm: [x,y,z], to_mm?: [x,y,z] }
// `from_mm` is where the hand rests when the move starts; `to_mm` is the end of a slide (a second named point).
// Phases: start-up (rest to the contact point), contact (one instant, the end of start-up), slide (a move that has it:
// contact point to `to_mm`), recovery (back to rest). A phase includes its start and excludes its end.

const PERMILLE = 1000;

/** Eased progress in permille, 0 to 1000, for `num` of `den` microseconds done (smoothstep in whole numbers). */
export function eased(num, den) {
  if (num <= 0) return 0;
  if (num >= den) return PERMILLE;
  const p = Math.floor((num * PERMILLE) / den);
  return Math.floor((p * p * (3 * PERMILLE - 2 * p)) / (PERMILLE * PERMILLE));
}

const between = (a, b, k) => a.map((v, i) => v + Math.trunc(((b[i] - v) * k) / PERMILLE));

/** Each phase's time in microseconds after the start: contact is the instant, `end_us` the end of recovery. */
export function timesOf(move) {
  const {start_up_us: up, slide_us: slide = 0, recovery_us: rec} = move.phases;
  return {contact_us: up, slide_end_us: up + slide, end_us: up + slide + rec};
}

/** The hand's position in whole millimetres at `t_us` (the same clock as `record.start_us`). */
export function handAt(move, record, t_us) {
  const {contact_us, slide_end_us, end_us} = timesOf(move);
  const t = t_us - record.start_us;
  const {from_mm: rest, contact_mm: at} = record;
  const away = move.phases.slide_us ? record.to_mm : at;
  if (t <= 0) return [...rest];
  if (t < contact_us) return between(rest, at, eased(t, contact_us));
  if (t < slide_end_us) return between(at, away, eased(t - contact_us, slide_end_us - contact_us));
  if (t < end_us) return between(away, rest, eased(t - slide_end_us, end_us - slide_end_us));
  return [...rest];
}
