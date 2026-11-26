// #5063: a look or a point at a thing the Soul sees beyond its 20 m reach is made from afar. The act's receipt says
// only `done`; the world writes the move's words on the act's end entry, `souls:act-ended {1: body, 2: how, ..., 8:
// words}` (worldd's `answers::FORM_ENDED`), e.g. `souls:look: from afar, 30000 mm to cd:5701, reach 20000 mm`. This
// reads that entry so `receipt` and `act --wait` can say the act was made from afar (`from_afar`).
import { textOf } from './stuck.mjs';

/** The world's entry event that names how an act ended. */
export const ACT_ENDED_ENTRY = 'souls:act-ended';

/** The words of an act of `mine` (my Soul's or my body's id) made from afar, from one of an entry's events; null for
 *  any other event, or an act end without them. */
export function afarOf(ev, mine) {
  if (ev?.name !== ACT_ENDED_ENTRY || !mine.includes(ev.fields?.[1]) || ev.fields?.[8] == null) return null;
  const words = textOf(ev.fields[8]);
  return words && words.includes('from afar') ? words : null;
}

/** The words of the act-end made from afar that belongs to a receipt: the newest in `ended` (`{ sequence, words }`,
 *  oldest first) after entry `after` (the newest seen when the act went) and before entry `before` (its receipt's
 *  version: the version after an entry is its sequence and one). Null when there is none. */
export function afarFor(ended, after, before) {
  return ended.findLast((a) => a.sequence > after && a.sequence < before)?.words ?? null;
}
