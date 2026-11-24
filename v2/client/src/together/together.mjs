// Touch by offer and accept (0.134 T1, T2): a handshake, a hug, a high five or holding hands, offered to one Soul.
// Dancing together (T3) is offered to up to seven at once; each who accepts dances, all on one beat. Following
// (0.135 G2): `together offer follow <body id>` asks to follow that Soul; once it accepts, this Soul's own follow
// order walks it along that Soul's trail, 1 to 2.5 m behind, until either leaves or this Soul acts on its own. When the other accepts,
// the activity starts and the world aims each one's move at the other (`content/kinds/together/`, each role naming
// its move). Each command is the intents it sends, built here with no daemon and no world, so it is read and tested
// on its own.
//
//   together offer <activity> <body id|name> [...]       an activity the world serves, by its word (`hug`, `dance`,
//                                                        `group-jumping-jacks`): `together kinds` lists each with its
//                                                        card, how many it asks, how close they stand and where it is
//                                                        played. One played at a thing (a harvest's basket) is offered
//                                                        at the nearest of that kind in the copy; any other where this
//                                                        Soul stands
//   together accept|decline <offer id>                   accepts, and both touch; or declines, and nobody moves
//   together accept|decline <activity>                   the newest open offer of that activity to this Soul
//   together leave <offer id | activity>                 leaves it (\`activity:leave\`, always taken): a touch, a dance,
//                                                        any activity; by its word, the newest of that kind in the copy
//
// The offer's id: the other's `wait` shows `{"kind":"together","what":"offered","touch":..,"offer":..,"from":..}`.
// When the touch is done, either one leaves it with `together leave <id>` (`activity:leave`). Holding hands,
// the first to walk leads and the other walks beside it (0.135 R1); a leave, a sit or lie, or the other's own walk or
// act lets go, and both hands come free.

import { CARRY_ENTRY } from '../carry/carry.mjs';

/**
 * The activities the world serves (0.135), as it serves them: its `souls-activities/1` record, fetched with its entries
 * (`pair/pair.mjs` `activitiesServed`). Each is offered by its word (`group-jumping-jacks`), under the name the world
 * serves it by (never one worked out here), the offerer in the role the world names, to as many as it asks; `card` is
 * its entry's card, `near_m` how close two members stand for its moves to reach (none: no distance is checked), `at` the
 * kind of thing it is played at (none: anywhere). The carry crew is `carry offer`'s; one with no offerer is proposed at
 * its thing, not offered. → [{word, kind, pin, role, most, card, near_m, at}], by word
 */
export function activitiesIn(served) {
  const list = Array.isArray(served?.activities) ? served.activities : [];
  return list
    .filter((a) => typeof a?.name === 'string' && typeof a.kind === 'string' && typeof a.word === 'string' && typeof a.offerer === 'string' && a.kind !== CARRY_ENTRY)
    .map((a) => ({ word: a.word, kind: a.kind, pin: a.name, role: a.offerer, most: Number.isInteger(a.asks) ? a.asks : 1, card: typeof a.card === 'string' ? a.card : '', near_m: typeof a.near_m === 'number' ? a.near_m : null, at: typeof a.at === 'string' ? a.at : null }))
    .sort((a, b) => a.word.localeCompare(b.word));
}

/** The activity a word names among `activitiesIn`: its word, its kind (`eden:hug`), its plain name, or the one word it
 *  starts (`dance` for `dance-together`); null if none. */
export function activityNamed(list, word) {
  const w = String(word ?? '').toLowerCase().replace(/_activity$/, '');
  const d = w.replace(/_/g, '-');
  const exact = list.find((a) => a.word === d || a.kind === w || a.kind.replace(/^.*:/, '') === w);
  if (exact) return exact;
  const starts = list.filter((a) => a.word.startsWith(`${d}-`));
  return starts.length === 1 ? starts[0] : null;
}

const ID = /^[0-9a-f]{32}-\d+$/;
const USAGE = 'together offer <activity `together kinds` lists> <body id|name> [...] | together accept|decline|leave <offer id | activity>';
const no = (code, detail) => ({ code, detail });

/** The intents a `together` request sends, or a refusal by name. `place` is the node an offer played anywhere goes
 *  under; `thingAt(kind)`, the nearest thing of that kind in the copy, the one an offer played at a thing goes under. */
export function togetherIntents(req, { place, served = null, thingAt = null }) {
  switch (req.do) {
    case 'offer': {
      // An activity the world serves, by its word; one played at a thing goes under the nearest of that kind.
      const a = activityNamed(activitiesIn(served), req.touch);
      const to = [req.to].flat();
      if (!a && !(served?.activities)) return no('together-not-served', 'this world has served no list of its activities yet: `status`, then try again once the daemon has signed in');
      if (!a && req.touch !== undefined && !ID.test(String(req.touch))) return no('together-unknown', `no activity ${String(req.touch).slice(0, 40)} here: \`together kinds\` lists what this world serves`);
      if (!a || !to.length || to.length > a.most || !to.every((t) => ID.test(String(t ?? '')))) return no('together-usage', a ? `together offer ${a.word} <body id|name>${a.most > 1 ? ` [... up to ${a.most}]` : ''}` : USAGE);
      const under = a.at ? thingAt?.(a.at) ?? null : place;
      if (a.at && !ID.test(String(under ?? ''))) return no('together.at-its-thing', `${a.word} is played at a ${a.at.replace(/^.*:/, '').replace(/_/g, ' ')} (${a.at}): none is in this Soul's copy; \`find ${a.at.replace(/^.*:/, '').replace(/_/g, ' ')}\``);
      if (!ID.test(String(under ?? ''))) return no('together-no-place', 'this Soul stands nowhere in its copy yet: look first');
      return [{ verb: 'activity:offer', target: under, params: { 1: a.pin, 2: a.role, 3: to } }];
    }
    case 'accept': case 'decline': case 'leave': {
      if (!ID.test(String(req.offer ?? ''))) return no('together-names-an-offer', `together ${req.do} <offer id | activity>`);
      return [{ verb: `activity:${req.do}`, target: req.offer }];
    }
    default: return no('together-usage', USAGE);
  }
}

/** The word an offer's kind (its event's field 2) is offered by, `<entry>_activity` with dashes (`hug`,
 *  `group-jumping-jacks`); null when it is no entry's activity (a conversation, a give). */
export function touchOf(kind) {
  const plain = String(kind ?? '').split('@')[0];
  return /^[^:]+:[a-z0-9_]+_activity$/.test(plain) ? plain.replace(/^.*:/, '').replace(/_activity$/, '').replace(/_/g, '-') : null;
}
