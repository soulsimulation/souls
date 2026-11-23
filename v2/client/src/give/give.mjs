// The give (0.133 R4): one Soul offers a thing it holds to another, and accepting hands it over (E8's offer with the
// thing named, `sim::activity::offer`'s give). Each command is the intents it sends, built here with no daemon and no
// world, so it is read and tested on its own.
//
//   give <thing id> --to <body id>    offers that body the thing this Soul holds (`activity:offer` of the give's kind,
//                                     replica/fixtures/activities/give.diag, this Soul the giver, parameter 4 the thing)
//   give accept|decline <offer id>    takes it into a free hand, or declines; the giver hears a decline or a lapse
//
// The offer's id: the taker's `wait` shows `{"kind":"give","what":"offered","offer":..,"thing":..,"from":..}`. A
// refused accept names why (`give.no-free-hand`, `give.too-far`, `give.not-held`) and leaves the offer open.

/** The give kind's pinned name (`give.diag`) and the giver's role. */
export const KIND = 'souls:give@1220ffaec2e627417fcf692041788f4295876214a2afb85bda4cf6ff29fb68f3137f';
export const KIND_PLAIN = 'souls:give';
export const GIVER = 'souls:giver';

const ID = /^[0-9a-f]{32}-\d+$/;
const no = (code, detail) => ({ code, detail });

/** The intents a `give` request sends, or a refusal by name. `place` is the node this Soul's body stands under. */
export function giveIntents(req, { place }) {
  switch (req.do) {
    case 'offer': {
      if (!ID.test(String(req.thing ?? '')) || !ID.test(String(req.to ?? ''))) return no('give-usage', 'give <thing id> --to <body id>');
      if (!ID.test(String(place ?? ''))) return no('give-no-place', 'this Soul stands nowhere in its copy yet: look first');
      return [{ verb: 'activity:offer', target: place, params: { 1: KIND, 2: GIVER, 3: [req.to], 4: req.thing } }];
    }
    case 'accept': case 'decline': {
      if (!ID.test(String(req.offer ?? ''))) return no('give-names-an-offer', `give ${req.do} <offer id>`);
      return [{ verb: `activity:${req.do}`, target: req.offer }];
    }
    default: return no('give-usage', 'give <thing id> --to <body id> | give accept|decline <offer id>');
  }
}

/** Whether an offer's event (its field 2, the kind) is a give's. */
export const isGive = (ev) => String(ev.fields?.[2] ?? '').split('@')[0] === KIND_PLAIN;
