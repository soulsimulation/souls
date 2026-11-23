// Touch by offer and accept (0.134 T1, T2): a handshake, a hug, a high five or holding hands, offered to one Soul.
// Dancing together (T3) is offered to up to seven at once; each who accepts dances, all on one beat. Following
// (0.135 G2): `together offer follow <body id>` asks to follow that Soul; once it accepts, this Soul's own follow
// order walks it along that Soul's trail, 1 to 2.5 m behind, until either leaves or this Soul acts on its own. When the other accepts,
// the activity starts and the world aims each one's move at the other (`content/kinds/together/`, each role naming
// its move). Each command is the intents it sends, built here with no daemon and no world, so it is read and tested
// on its own.
//
//   together offer <handshake|hug|high-five|hold-hands> <body id>   offers that body the touch (`activity:offer` of its kind,
//                                                        this Soul in the first role)
//   together accept|decline <offer id>                   accepts, and both touch; or declines, and nobody moves
//
// The offer's id: the other's `wait` shows `{"kind":"together","what":"offered","touch":..,"offer":..,"from":..}`.
// When the touch is done, either one leaves it with `converse leave <id>`'s intent, `activity:leave`. Holding hands
// lasts until one of them leaves or walks; then both hands come free.

/** Each touch's activity kind, as the world pins it from its entry (`serve::activity_kinds`), and the offerer's role. */
export const KINDS = Object.freeze({
  follow: 'eden:follow_activity@1220390b841bf789d26cfe815f2f44765945b061efce3c95e01c3f86ead53b5ea588',
  dance: 'eden:dance_together_activity@1220d1b1f5c438e9e7b3ba287320f4f18114892f5d4777e5e044844a0ebd5333ad5d',
  handshake: 'eden:handshake_activity@1220b6204784ae7087cc16cd7d3b0b22bc7f851c2de8c2af7ae6b677d0a59b381682',
  'high-five': 'eden:high_five_activity@1220fd403508fcecb98fb4aff58e9b5450e67696a75b6fef0c7307b130be85453111',
  'hold-hands': 'eden:hold_hands_activity@1220117af957e071c2126cdc18220b7ec1220944908b29afadb24f89e9a5ef6531f5',
  hug: 'eden:hug_activity@1220fe29f4c50afff5fc6ec78e7fd295cf2e4bde5b6a888d7dbfb4252e779446abd1',
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
