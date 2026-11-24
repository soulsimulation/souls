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
//
// The offer's id: the other's `wait` shows `{"kind":"together","what":"offered","touch":..,"offer":..,"from":..}`.
// When the touch is done, either one leaves it with `converse leave <id>`'s intent, `activity:leave`. Holding hands,
// the first to walk leads and the other walks beside it (0.135 R1); a leave, a sit or lie, or the other's own walk or
// act lets go, and both hands come free.

/** Each touch's activity kind, as the world pins it from its entry (`serve::activity_kinds`), and the offerer's role. */
export const KINDS = Object.freeze({
  follow: 'eden:follow_activity@1220390b841bf789d26cfe815f2f44765945b061efce3c95e01c3f86ead53b5ea588',
  dance: 'eden:dance_together_activity@1220543a9d3587368b26535d8be47d25e08f30ba23549b9adf3a312b91da91ad3731',
  handshake: 'eden:handshake_activity@1220bd24bded16d8b48b25e9dfed2777dab8a8cbb3063062b81ce920f5ed22becc88',
  'high-five': 'eden:high_five_activity@1220ba8315cc807df05a932b3dcf04344ea1d9dd1c011d93395a53dcb7f777eb1f2f',
  'hold-hands': 'eden:hold_hands_activity@1220925c2d0989adfde15f1b3afd895e9d5fedbf2c6038c7692b5d6c024c5d89369c',
  hug: 'eden:hug_activity@12203c0411a7549ce250decf5b69406c2ecbff8057cebaf5ce41fa1bbe4471f13932',
  // 0.135 E1: a fist bump, and harvesting into one basket (each member then picks with the activity's own form).
  'fist-bump': 'eden:fist_bump_activity@1220155d17b8d8c9f78bb7579181ff553121e915ec38362be884f45815a17a6d78b9',
  harvest: 'eden:harvest_together_activity@122070d31cf09790b76bf43d135b5f50e99f0ba68a528a22119ef70e5a451a44207f',
});
export const OFFERER = 'eden:one';

const ID = /^[0-9a-f]{32}-\d+$/;
const USAGE = `together offer <${Object.keys(KINDS).join('|')}> <body id> (a dance: up to seven) | together accept|decline <offer id>`;
const no = (code, detail) => ({ code, detail });

/** The intents a `together` request sends, or a refusal by name. `place` is the node the offer goes under. */
export function togetherIntents(req, { place }) {
  switch (req.do) {
    case 'offer': {
      const kind = KINDS[req.touch];
      // A dance is offered to up to seven at once (0.134 T3); a touch to one.
      const to = [req.to].flat();
      const most = req.touch === 'dance' ? 7 : 1;
      if (!kind || !to.length || to.length > most || !to.every((t) => ID.test(String(t ?? '')))) return no('together-usage', USAGE);
      if (!ID.test(String(place ?? ''))) return no('together-no-place', 'this Soul stands nowhere in its copy yet: look first');
      return [{ verb: 'activity:offer', target: place, params: { 1: kind, 2: OFFERER, 3: to } }];
    }
    case 'accept': case 'decline': {
      if (!ID.test(String(req.offer ?? ''))) return no('together-names-an-offer', `together ${req.do} <offer id>`);
      return [{ verb: `activity:${req.do}`, target: req.offer }];
    }
    default: return no('together-usage', USAGE);
  }
}

/** The touch an offer's kind (its event's field 2) is, or null when it is not one. */
export function touchOf(kind) {
  const plain = String(kind ?? '').split('@')[0];
  return Object.keys(KINDS).find((t) => KINDS[t].split('@')[0] === plain) ?? null;
}
