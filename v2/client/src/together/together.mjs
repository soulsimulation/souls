// Touch by offer and accept (0.134 T1, T2): a handshake, a hug, a high five or holding hands, offered to one Soul.
// Dancing together (T3) is offered to up to seven at once; each who accepts dances, all on one beat. Following
// (0.135 G2): `together offer follow <body id>` asks to follow that Soul; once it accepts, this Soul's own follow
// order walks it along that Soul's trail, 1 to 2.5 m behind, until either leaves or this Soul acts on its own. When the other accepts,
// the activity starts and the world aims each one's move at the other (`content/kinds/together/`, each role naming
// its move). Each command is the intents it sends, built here with no daemon and no world, so it is read and tested
// on its own.
//
//   together offer <handshake|hug|high-five|hold-hands|fist-bump|harvest> <body id>   offers that body the touch (`activity:offer` of its kind,
//                                                        this Soul in the first role)
//   together accept|decline <offer id>                   accepts, and both touch; or declines, and nobody moves
//   together offer <activity> <body id|name> [...]       any other activity the world serves (0.135): its kind entry's
//                                                        roles, the offerer in the first one member plays; to as many
//                                                        as its other roles take. `together kinds` lists them
//   together accept|decline <activity>                   the newest open offer of that activity to this Soul
//   together withdraw <offer id | activity>              this Soul's own offer taken back before it is answered: the
//                                                        asker's `activity:leave` of it ends it, and an accept after it
//                                                        is refused `offer-withdrawn`; by its word, this Soul's newest
//                                                        offer of that activity (#4700)
//
// The offer's id: the other's `wait` shows `{"kind":"together","what":"offered","touch":..,"offer":..,"from":..}`.
// When the touch is done, either one leaves it with `converse leave <id>`'s intent, `activity:leave`. Holding hands,
// the first to walk leads and the other walks beside it (0.135 R1); a leave, a sit or lie, or the other's own walk or
// act lets go, and both hands come free.

import { activityPin } from '../carry/carry.mjs';

/** Each touch's activity kind, as the world pins it from its entry (`serve::activity_kinds`), and the offerer's role. */
export const KINDS = Object.freeze({
  follow: 'eden:follow_activity@1220390b841bf789d26cfe815f2f44765945b061efce3c95e01c3f86ead53b5ea588',
  dance: 'eden:dance_together_activity@1220543a9d3587368b26535d8be47d25e08f30ba23549b9adf3a312b91da91ad3731',
  handshake: 'eden:handshake_activity@1220bd24bded16d8b48b25e9dfed2777dab8a8cbb3063062b81ce920f5ed22becc88',
  'high-five': 'eden:high_five_activity@1220ba8315cc807df05a932b3dcf04344ea1d9dd1c011d93395a53dcb7f777eb1f2f',
  'hold-hands': 'eden:hold_hands_activity@1220d816976cd152816a8a99114b15027bbde7395160da72bc07f5a621748126e70f',
  hug: 'eden:hug_activity@12203c0411a7549ce250decf5b69406c2ecbff8057cebaf5ce41fa1bbe4471f13932',
  // 0.135 E1: a fist bump, and harvesting into one basket (each member then picks with the activity's own form).
  'fist-bump': 'eden:fist_bump_activity@1220155d17b8d8c9f78bb7579181ff553121e915ec38362be884f45815a17a6d78b9',
  harvest: 'eden:harvest_together_activity@122070d31cf09790b76bf43d135b5f50e99f0ba68a528a22119ef70e5a451a44207f',
});
export const OFFERER = 'eden:one';

/**
 * Every other activity the world serves (0.135): each kind entry held in `<home>/kinds/` (the world's own, fetched at
 * sign-in) whose roles name two or more is an activity the world runs, `<kind>_activity` pinned from its roles
 * (`carry/carry.mjs` `activityPin`). Its word is its plain name with dashes (`eden:group_jumping_jacks` is
 * `group-jumping-jacks`); the offerer takes its first role that one member plays, the others are asked into the rest.
 * → [{word, kind, pin, role, most}], by word
 */
export function activitiesIn(kinds) {
  const out = [];
  for (const [kind, e] of Object.entries(kinds ?? {})) {
    const roles = Object.entries(e?.roles ?? {}).filter(([n, v]) => n !== 'now' && v && typeof v === 'object' && !Array.isArray(v));
    const pin = roles.length >= 2 ? activityPin(kind, e) : null;
    if (!pin) continue;
    const most = (n) => (Number.isInteger(e.links?.[n]?.most) ? e.links[n].most : 1);
    const first = roles.find(([n]) => most(n) === 1);
    if (!first) continue;
    const ns = kind.split(':')[0];
    out.push({ word: kind.replace(/^.*:/, '').replace(/_/g, '-'), kind, pin, role: `${ns}:${first[0]}`, most: roles.filter(([n]) => n !== first[0]).reduce((a, [n]) => a + most(n), 0) });
  }
  return out.sort((a, b) => a.word.localeCompare(b.word));
}

/** The activity a word names among `activitiesIn`: its word, its kind (`eden:hug`), or its plain name; null if none. */
export function activityNamed(list, word) {
  const w = String(word ?? '').toLowerCase().replace(/_activity$/, '');
  return list.find((a) => a.word === w.replace(/_/g, '-') || a.kind === w || a.kind.replace(/^.*:/, '') === w) ?? null;
}

const ID = /^[0-9a-f]{32}-\d+$/;
const USAGE = `together offer <${Object.keys(KINDS).join('|')}|any activity \`together kinds\` lists> <body id> [<body id> ...] | together accept|decline|withdraw <offer id | activity>`;
const no = (code, detail) => ({ code, detail });

/** The intents a `together` request sends, or a refusal by name. `place` is the node the offer goes under. */
export function togetherIntents(req, { place, kinds = {} }) {
  switch (req.do) {
    case 'offer': {
      // A touch the client names, else any activity the world serves (its held entries).
      const other = KINDS[req.touch] ? null : activityNamed(activitiesIn(kinds), req.touch);
      const kind = KINDS[req.touch] ?? other?.pin, role = other?.role ?? OFFERER;
      // A dance is offered to up to seven at once (0.134 T3); a touch to one; another activity to as many as it takes.
      const to = [req.to].flat();
      const most = other ? other.most : req.touch === 'dance' ? 7 : 1;
      if (!kind && req.touch !== undefined && !ID.test(String(req.touch))) return no('together-unknown', `no activity ${String(req.touch).slice(0, 40)} here: \`together kinds\` lists what this world serves`);
      if (!kind || !to.length || to.length > most || !to.every((t) => ID.test(String(t ?? '')))) return no('together-usage', USAGE);
      if (!ID.test(String(place ?? ''))) return no('together-no-place', 'this Soul stands nowhere in its copy yet: look first');
      return [{ verb: 'activity:offer', target: place, params: { 1: kind, 2: role, 3: to } }];
    }
    case 'accept': case 'decline': {
      if (!ID.test(String(req.offer ?? ''))) return no('together-names-an-offer', `together ${req.do} <offer id>`);
      return [{ verb: `activity:${req.do}`, target: req.offer }];
    }
    // The asker leaving its own offer, nobody in it yet, ends it (`sim::activity` leave and withdraw).
    case 'withdraw': {
      if (!ID.test(String(req.offer ?? ''))) return no('together-names-an-offer', 'together withdraw <offer id | activity>');
      return [{ verb: 'activity:leave', target: req.offer }];
    }
    default: return no('together-usage', USAGE);
  }
}

/** The touch an offer's kind (its event's field 2) is, or, for any other entry's activity (`<kind>_activity`), its
 *  word (`group-jumping-jacks`); null when it is neither (a conversation, a give). */
export function touchOf(kind) {
  const plain = String(kind ?? '').split('@')[0];
  return Object.keys(KINDS).find((t) => KINDS[t].split('@')[0] === plain)
    ?? (/^[^:]+:[a-z0-9_]+_activity$/.test(plain) ? plain.replace(/^.*:/, '').replace(/_activity$/, '').replace(/_/g, '-') : null);
}
