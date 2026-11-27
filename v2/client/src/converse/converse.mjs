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

import { touchOf } from '../together/together.mjs';
import { isCrew } from '../carry/carry.mjs';
import { idsOf } from '../together/members.mjs';

/** The conversation kind's pinned name (`conversation.diag`), its two roles, and the engine's own act verbs. */
export const KIND = 'souls:conversation@1220070284220bb6e0bbfc46dc1efce8ad751cf0af39f0958875c2e4b9e077135c51';
export const OPENER = 'souls:opener';
export const MEMBER = 'souls:member';
export const KIND_PLAIN = 'souls:conversation';
/** The offer's events the daemon tells its Soul about, by name: what each means for it. */
export const OFFER_EVENTS = { 'souls:offer': 'invited', 'souls:offer-declined': 'declined', 'souls:offer-lapsed': 'lapsed' };

const ID = /^[0-9a-f]{32}-\d+$/;
const WORDS_MOST = 1000;
/** The ground's kind: the node that takes every activity as a child (`worldd serve`'s build). */
const GROUND = 'eden:ground';

/** The node an offer (a conversation, a touch, a give) goes under: the open ground in the copy, which admits every
 *  activity, else the node this Soul's body stands under. Never the seat or the bed it is in: a bench admits no
 *  conversation (`child-not-admitted`), and two seated Souls still talk. `rows` the copy's rows, `me` this Soul. */
export function offerPlace(rows, me) {
  const all = [...(rows?.values?.() ?? rows ?? [])];
  return all.find((r) => String(r.kind ?? '').split('@')[0] === GROUND)?.id ?? all.find((r) => r.id === me || r.soul === me)?.parent ?? null;
}
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
      if (!ID.test(String(req.with ?? ''))) return no('converse-names-a-body', 'converse start <name or body id> "<text>"');
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
 * How long an offer asked of this Soul has left, in plain words, from its event's fields and the world time it was
 * written (`at`, µs: its entry's): `open_s` until it lapses unanswered, and for a group's offer (fields 7 and 8, a crew
 * or a dance offered to several) how long each accept keeps it open and the most it stays open. Nothing without `at`.
 */
export function offerTime(f, at) {
  const now = Number(at), until = Number(f?.[4]);
  if (!Number.isFinite(now) || !Number.isFinite(until)) return {};
  const s = (us) => Math.max(0, Math.round(us / 1e6)), open_s = s(until - now);
  const each = Number(f[7]), most = Number(f[8]);
  if (!Number.isFinite(each) || !Number.isFinite(most)) return { open_s, note: `open ${open_s} s from when it was made: answer before it lapses` };
  const each_accept_s = s(each), open_most_s = s(most - now);
  return {
    open_s, each_accept_s, open_most_s,
    note: `open ${open_s} s from when it was made; each accept keeps it open ${each_accept_s} s more for the rest, ${open_most_s} s at most: answer before it lapses`,
  };
}

/**
 * What an offer's event means for this Soul (`me`, its body's id), as an event for `wait`, or null when it does not
 * concern it. `at`, its entry's world time (µs), adds how long an offer asked of it has left ([`offerTime`]). The view tier addresses an offer to the bodies asked, its decline to the opener, and its lapse to the
 * opener and to those it names (`replica::activity::addressed`), so an offer that reaches this Soul and is not its
 * own is an invitation, a decline or a lapse naming it as the opener is its answer, and a lapse naming it among
 * field 3 tells it the offer it was asked is gone. Field 1 is the conversation; an offer's opener is
 * field 5 (field 2 is its kind), while a decline or lapse names its opener in field 2.
 */
export function offerNote(ev, me, at) {
  const what = OFFER_EVENTS[ev.name];
  if (!what) return null;
  const f = ev.fields ?? {}, opener = f[what === 'invited' ? 5 : 2], mine = opener === me;
  // A lapse is told to those asked too (field 3: who did not answer, or those whose accepted pair never started,
  // field 4 that pair): the offer is gone, so `wait`ing on it is over.
  if (what === 'lapsed' && !mine && idsOf(f[3]).includes(me)) {
    return { kind: 'conversation', what, conversation: f[1], from: opener, ...(f[4] !== undefined ? { pair: f[4] } : {}) };
  }
  if (what === 'invited' ? mine : !mine) return null;
  const left = what === 'invited' ? offerTime(f, at) : {};
  // 0.133 R4: an offer that names a thing (field 6) is a give, not a conversation.
  if (what === 'invited' && f[6] !== undefined) return { kind: 'give', what: 'offered', offer: f[1], thing: f[6], from: opener, ...left };
  // 0.135 C: an offer of a carry's kind is a crew to carry a load or hold a part with (`carry accept <offer>`).
  if (what === 'invited' && isCrew(f[2])) return { kind: 'carry', what: 'offered', offer: f[1], from: opener, ...left };
  // 0.134 T1: an offer of a touch's kind is a handshake, a hug or a high five.
  const touch = what === 'invited' ? touchOf(f[2]) : null;
  if (touch) return { kind: 'together', what: 'offered', touch, offer: f[1], from: opener, ...left };
  return { kind: 'conversation', what, conversation: f[1], ...(what === 'invited' ? { from: opener, ...left } : {}) };
}
