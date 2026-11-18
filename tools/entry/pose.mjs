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

/** A signed whole-number quotient rounded to the nearest unit, halves away from zero (Engine v2's rule for a position;
 *  truncating would be biased and make a slide and its reverse differ). Whole-number arithmetic only. */
const roundDiv = (n, d) => (n < 0 ? -Math.floor((-n * 2 + d) / (2 * d)) : Math.floor((n * 2 + d) / (2 * d)));
const between = (a, b, k) => a.map((v, i) => v + roundDiv((b[i] - v) * k, PERMILLE));

/** Each phase's time in microseconds after the start (`count` sips, bites, blows or strokes each hold `consume_us`, `strike_us` or `pump_us`): contact is the instant, `end_us` the end of recovery. */
export function timesOf(move, count = 1) {
  const {start_up_us: up, slide_us: slide = 0, pour_us: pour = 0, consume_us: eat = 0, strike_us: hit = 0, pump_us: stroke = 0, recovery_us: rec} = move.phases;
  const hold = slide + pour + (eat + hit + stroke) * count;
  return {contact_us: up, slide_end_us: up + hold, end_us: up + hold + rec};
}

/** Where the hand must be for the move's effector to be at the contact point. A `held_point` effector is a point of the
 *  held thing (a spout): the record carries `effector_mm`, its offset from the hand in the world's axes at the pose it
 *  is held in, and the hand goes to the contact point minus that offset. A pour holds the hand there for `pour_us`; a consume (a cup's rim or a roll's bitten edge at the mouth point, `contact_mm`) for `consume_us` times the record's `count` (default 1). A strike (a hammer's head on the thing struck, `contact_mm`) holds the head there for `strike_us` per blow and a pump (the pump's head on its fitting) for `pump_us` per stroke, `count` of them. */
export function handTarget(move, record) {
  const {contact_mm: at, effector_mm: off} = record;
  return move.effector === 'held_point' ? at.map((v, i) => v - off[i]) : [...at];
}

/** Where the effector is at `t_us`: the hand, plus the held point's offset for a `held_point` move. */
export function effectorAt(move, record, t_us) {
  const h = handAt(move, record, t_us);
  return move.effector === 'held_point' ? h.map((v, i) => v + record.effector_mm[i]) : h;
}

/** The hand's position in whole millimetres at `t_us` (the same clock as `record.start_us`). */
export function handAt(move, record, t_us) {
  const {contact_us, slide_end_us, end_us} = timesOf(move, record.count);
  const t = t_us - record.start_us;
  const {from_mm: rest} = record;
  const at = handTarget(move, record);
  const away = move.phases.slide_us ? record.to_mm : at;
  if (t <= 0) return [...rest];
  if (t < contact_us) return between(rest, at, eased(t, contact_us));
  if (t < slide_end_us) return between(at, away, eased(t - contact_us, slide_end_us - contact_us));
  if (t < end_us) return between(away, rest, eased(t - slide_end_us, end_us - slide_end_us));
  return [...rest];
}
