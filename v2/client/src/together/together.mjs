// Touch by offer and accept (0.134 T1): a handshake, a hug or a high five, offered to one Soul. When the other accepts,
// the activity starts and the world aims each one's move at the other (`content/kinds/together/`, each role naming
// its move). Each command is the intents it sends, built here with no daemon and no world, so it is read and tested
// on its own.
//
//   together offer <handshake|hug|high-five> <body id>   offers that body the touch (`activity:offer` of its kind,
//                                                        this Soul in the first role)
//   together accept|decline <offer id>                   accepts, and both touch; or declines, and nobody moves
//
// The offer's id: the other's `wait` shows `{"kind":"together","what":"offered","touch":..,"offer":..,"from":..}`.
// When the touch is done, either one leaves it with `converse leave <id>`'s intent, `activity:leave`.

/** Each touch's activity kind, as the world pins it from its entry (`serve::activity_kinds`), and the offerer's role. */
export const KINDS = Object.freeze({
  handshake: 'eden:handshake_activity@1220b6204784ae7087cc16cd7d3b0b22bc7f851c2de8c2af7ae6b677d0a59b381682',
  'high-five': 'eden:high_five_activity@1220fd403508fcecb98fb4aff58e9b5450e67696a75b6fef0c7307b130be85453111',
  hug: 'eden:hug_activity@1220fe29f4c50afff5fc6ec78e7fd295cf2e4bde5b6a888d7dbfb4252e779446abd1',
});
export const OFFERER = 'eden:one';

const ID = /^[0-9a-f]{32}-\d+$/;
const USAGE = `together offer <${Object.keys(KINDS).join('|')}> <body id> | together accept|decline <offer id>`;
const no = (code, detail) => ({ code, detail });

/** The intents a `together` request sends, or a refusal by name. `place` is the node the offer goes under. */
export function togetherIntents(req, { place }) {
  switch (req.do) {
    case 'offer': {
      const kind = KINDS[req.touch];
      if (!kind || !ID.test(String(req.to ?? ''))) return no('together-usage', USAGE);
      if (!ID.test(String(place ?? ''))) return no('together-no-place', 'this Soul stands nowhere in its copy yet: look first');
      return [{ verb: 'activity:offer', target: place, params: { 1: kind, 2: OFFERER, 3: [req.to] } }];
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
