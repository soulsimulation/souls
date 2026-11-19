// Conversations (Engine v2 E26, #3329): an activity Souls join, which the other may decline. Each command is the
// intents it sends, built here with no daemon and no world, so it is read and tested on its own.
//
//   converse start <body id> "<text>" [--private]   offers a conversation to that body (E8's `activity:offer`, the
//                                                   kind in replica/fixtures/activities/conversation.diag, this Soul
//                                                   the opener) and gives the opening line to that body alone (a
//                                                   whisper), as an invitation carries it: nothing is said into the
//                                                   conversation before the other joins
//   converse accept|decline <conversation id>       joins it as its member, or declines; a decline is named to the
//                                                   opener (`souls:offer-declined`, addressed to it alone)
//   converse say <conversation id> "<text>" [--private]   a turn. Public by default: ordinary talk, heard at talk's
//                                                   reach. Private: a `say` into the conversation (E26a), its members'
//                                                   alone, refused `not-a-member` to anyone else
//   converse leave <conversation id>                leaves it; always accepted. It ends with its last member
//
// The conversation's id: the invitation names it (`wait` shows `{"kind":"conversation","what":"invited",...}`), and
// the opener finds it in its copy (`converse list`). A turn's words come back from memory and `history`.

/** The conversation kind's pinned name (`conversation.diag`), its two roles, and the engine's own act verbs. */
export const KIND = 'souls:conversation@1220070284220bb6e0bbfc46dc1efce8ad751cf0af39f0958875c2e4b9e077135c51';
export const OPENER = 'souls:opener';
export const MEMBER = 'souls:member';
export const KIND_PLAIN = 'souls:conversation';
/** The offer's events the daemon tells its Soul about, by name: what each means for it. */
export const OFFER_EVENTS = { 'souls:offer': 'invited', 'souls:offer-declined': 'declined', 'souls:offer-lapsed': 'lapsed' };

const ID = /^[0-9a-f]{32}-\d+$/;
const WORDS_MOST = 1000;
const no = (code, detail) => ({ code, detail });

/**
 * The intents a `converse` request sends, in order, each `{verb, target?, params?, words?}`, or a refusal by name.
 * `ns` is the world's form namespace (a say's and a whisper's), `place` the node this Soul's body stands under (where
 * an offer puts the conversation), `privateOf(id)` whether a conversation was made private on this side.
 */
export function converseIntents(req, { ns, place, privateOf = () => false }) {
  const words = req.words === undefined ? undefined : String(req.words);
  const wordsOk = words !== undefined && words.trim() && [...words].length <= WORDS_MOST;
  switch (req.do) {
    case 'start': {
      if (!ID.test(String(req.with ?? ''))) return no('converse-names-a-body', 'converse start <body id> "<text>"');
      if (!ID.test(String(place ?? ''))) return no('converse-no-place', 'this Soul stands nowhere in its copy yet: look first');
      if (words !== undefined && !wordsOk) return no('words-empty-or-long', `1 to ${WORDS_MOST} characters`);
      const offer = { verb: 'activity:offer', target: place, params: { 1: KIND, 2: OPENER, 3: [req.with] } };
      return words === undefined ? [offer] : [offer, { verb: `${ns}:whisper`, target: req.with, words }];
    }
    case 'accept': case 'decline': case 'leave': {
      if (!ID.test(String(req.conversation ?? ''))) return no('converse-names-a-conversation', `converse ${req.do} <conversation id>`);
      return [{ verb: `activity:${req.do}`, target: req.conversation }];
    }
    case 'say': {
      if (!ID.test(String(req.conversation ?? ''))) return no('converse-names-a-conversation', 'converse say <conversation id> "<text>"');
      if (!wordsOk) return no('words-empty-or-long', `1 to ${WORDS_MOST} characters`);
      return req.private || privateOf(req.conversation)
        ? [{ verb: `${ns}:say`, target: req.conversation, words }]
        : [{ verb: `${ns}:say`, words }];
    }
    default: return no('converse-unknown', 'converse start|accept|decline|say|leave|list');
  }
}

/**
 * What an offer's event means for this Soul (`me`, its body's id), as an event for `wait`, or null when it does not
 * concern it. The view tier addresses an offer to the bodies asked and its decline or lapse to the opener alone
 * (`replica::activity::addressed`), so an offer that reaches this Soul and is not its own is an invitation, and a
 * decline or a lapse naming it as the opener is its answer. Field 1 is the conversation, 2 the opener.
 */
export function offerNote(ev, me) {
  const what = OFFER_EVENTS[ev.name];
  if (!what) return null;
  const f = ev.fields ?? {}, mine = f[2] === me;
  if (what === 'invited' ? mine : !mine) return null;
  return { kind: 'conversation', what, conversation: f[1], ...(what === 'invited' ? { from: f[2] } : {}) };
}
