// Standing consent (Engine v2 E8, #2779): "I accept high fives from Ada" as one reflex rule (R9) in the Soul's own
// client. It matches the engine's offer event, `souls:offer {1: offer, 2: kind, 3: [body asked, ...], 4: expires,
// 5: asker's body}` (v2/crates/replica/src/activity.rs), addressed to this Soul, of one kind, from the Souls it names,
// and answers with the accept any Soul would send: `souls:accept` aimed at the offer. No model turn.
//
// It is narrow (one kind, a list of Souls), expiring (seconds, required), listed and removable like every reflex
// (`reflex`, `reflex remove <id>`), and works only while this client runs: stopped, nothing answers and the offer
// lapses. The engine holds no consent of its own (TRUNK T10).

import { Refused } from '../match/match.mjs';

export const OFFER = 'souls:offer';
export const ACCEPT = 'souls:accept';

/** The reflex rule for a standing consent: offers of `kind` from `from` (Soul ids), for `expires` seconds. */
export function consentRule({ kind, from, expires, max } = {}) {
  if (typeof kind !== 'string') throw new Refused('consent-kind-not-a-name', 'kind is the offer\'s activity kind');
  if (!Array.isArray(from) || from.length === 0) throw new Refused('consent-from-none', 'name the Souls whose offers to accept');
  const rule = {
    when: { event: OFFER, from, toMe: true, fields: { 2: kind } },
    send: { verb: ACCEPT, target: '$field:1' },
  };
  if (expires !== undefined) rule.expires = expires;
  if (max !== undefined) rule.max = max;
  return rule;
}
