// Between two Souls (Soul Actions SA-G4, #2876): give, hug, handshake, high five, dance, push the swing. For Engine v2
// E8 (#2779, offers with an expiry), E24 (#2793, a give), B8 (#2740, a move on a beat) and B6 (#2725, contact).
//
// A pair is an activity (activity.ts) with two required roles. One Soul offers: the offer is a proposal node (made by
// E8) whose `invited` link names the one Soul it is for; the asker enters its role by its own act. The invited Soul
// accepts by entering the other role, in time: the accepting form's `who` is the invited link and it needs the
// asker's role linked, so a body is touched only once both have joined. Being near is not consent. The offer's
// countdown (`now.ends`, a timed field) reaching 0 with nobody accepting runs its world form, which `lapse` runs: the
// asker is released (event `released`, unlinking it) and the form's own named event says the offer lapsed.
//
// A give names the link to the thing that changes hands (`gives`). Its accepting form moves that thing into the
// accepter's free hand, in the same batch as the joining: both sides or neither. At that instant the asker must still
// hold it (`not_held`), and the accepter must have a free hand (`no_free_hand`), or nothing changes.
//
// The `pair` section states, in the activity's own frame, each role's contact points: a move from content/moves, the
// point its effector touches (whole millimetres) and the beat its contact lands on (beat 1 is the first after both
// joined; a beat is `beat_us` whole microseconds). Placing a move on the beat is B8's.

import { enter, entering, leaving, type Activity, type Entered } from './activity.ts';
import { parentOf } from './effects.ts';
import { whoMay, type Input, type WhoVerdict } from './rules.ts';

export const PAIR_PARTS = Object.freeze(['invited', 'accept', 'expires', 'gives', 'beat_us', 'contact']);
export type Contact = { role: string; move: string; contact_mm: number[]; beat: number };
export type PairSection = { invited: string; accept: string; expires: string; gives?: string; beat_us: number; contact: Contact[] };
export type Pair = PairSection & { asker: string; partner: string };
export type PairBad = { bad: string; detail: Record<string, unknown> };
export type Move = { move: string };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const whole = (v: unknown): v is number => Number.isSafeInteger(v);
const vec = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(whole);
const sameLink = (who: unknown, link: string) => !!who && typeof who === 'object' && (who as { link?: unknown }).link === link;

/**
 * Whether a kind is a pair: an activity of two required roles, an offer to one invited Soul accepted in time, with an
 * expiry, contact points and beats stated as data. Returns the section with its two roles, or `{bad, detail}` naming
 * the first thing wrong. `moves` are the moves by name (content/moves).
 */
export function pairOf(entry: Activity & { pair?: unknown }, moves: Record<string, Move>): Pair | PairBad {
  const no = (bad: string, detail: Record<string, unknown> = {}): PairBad => ({ bad, detail });
  const p = entry.pair as PairSection | undefined;
  if (!p || typeof p !== 'object') return no('not_a_pair');
  const extra = Object.keys(p).filter((k) => !PAIR_PARTS.includes(k));
  if (extra.length) return no('malformed_pair', { parts: extra });
  const roles = Object.keys(entry.roles ?? {});
  if (roles.length !== 2 || roles.some((r) => entry.roles![r].need !== 'required')) return no('not_two_required_roles', { roles });
  if (!has(entry.links, p.invited) || roles.includes(p.invited)) return no('no_invited_link', { link: p.invited ?? null });

  // Accepting: the invited Soul enters one role, in time, once the other is linked.
  const accept = has(entry.forms, p.accept) ? entry.forms![p.accept] : undefined;
  const enters = accept ? entering(entry, p.accept) : { bad: 'no_such_form' };
  if (!accept || 'bad' in enters) return no('no_accepting_form', { form: p.accept ?? null });
  const partner = enters.role;
  const asker = roles.find((r) => r !== partner)!;
  if (!sameLink(accept.who, p.invited)) return no('accept_not_by_the_invited', { form: p.accept });
  const needs = accept.needs ?? [];
  if (!needs.some((n) => n.need === 'linked' && n.link === asker)) return no('accept_before_the_asker', { form: p.accept, role: asker });
  const ends = entry.now?.ends;
  const clock = ends && has(entry.state, ends) ? entry.state![ends] : undefined;
  const countdown = clock?.type === 'timed' && (clock.default as { per_s?: unknown } | undefined)?.per_s;
  if (!ends || !whole(countdown) || countdown >= 0) return no('no_countdown', { field: ends ?? null });
  if (!needs.some((n) => n.need === 'state' && n.field === ends && n.at_least === 1)) return no('accept_not_in_time', { form: p.accept, field: ends });

  // The asker offers by its own act, and only the Soul the proposal names may (a link, never anyone).
  const offers = Object.keys(entry.forms ?? {}).filter((f) => { const e = entering(entry, f); return !('bad' in e) && e.role === asker; });
  if (!offers.length || offers.some((f) => !entry.forms![f].who || typeof entry.forms![f].who !== 'object')) return no('no_offering_form', { role: asker });
  // Each can always leave.
  for (const role of roles) if (!Object.keys(entry.forms ?? {}).some((f) => { const l = leaving(entry, f); return !('bad' in l) && l.role === role; })) return no('no_leaving_form', { role });

  // The expiry: the world's timer form, at the countdown's end, while nobody accepted; it removes the offer.
  const lapse = has(entry.forms, p.expires) ? entry.forms![p.expires] : undefined;
  if (!lapse || lapse.who !== 'world' || lapse.starts !== 'timer') return no('no_expiry', { form: p.expires ?? null });
  const lapseNeeds = lapse.needs ?? [];
  if (!lapseNeeds.some((n) => n.need === 'state' && n.field === ends && n.at_most === 0)) return no('expiry_not_at_the_countdown', { form: p.expires });
  if (!lapseNeeds.some((n) => n.need === 'unlinked' && n.link === partner)) return no('expiry_after_accepting', { form: p.expires });
  if (!(lapse.effects ?? []).some((e) => e.change === 'remove' && e.what === 'this')) return no('expiry_keeps_the_offer', { form: p.expires });

  // Nothing but a give's own thing is moved by link: no form names a body or another link.
  for (const [name, f] of Object.entries(entry.forms ?? {})) {
    for (const e of f.effects ?? []) {
      const what = (e as { what?: unknown }).what;
      if (what === undefined || what === 'actor' || what === 'this') continue;
      if (!p.gives || !sameLink(what, p.gives) || name !== p.accept || e.change !== 'reparent' || e.into !== 'actor_hand') return no('moves_what_it_may_not', { form: name });
    }
  }
  if (p.gives !== undefined && (!has(entry.links, p.gives) || !(accept.effects ?? []).some((e) => sameLink((e as { what?: unknown }).what, p.gives!)))) return no('gives_nothing', { link: p.gives });

  // Contact points and beats, in the activity's own frame.
  if (!whole(p.beat_us) || p.beat_us <= 0) return no('malformed_beat', { beat_us: p.beat_us ?? null });
  if (!Array.isArray(p.contact) || !p.contact.length) return no('no_contact');
  for (const [i, c] of p.contact.entries()) {
    if (!c || !roles.includes(c.role) || !has(moves, c.move) || !vec(c.contact_mm) || !whole(c.beat) || c.beat < 1) return no('malformed_contact', { contact: i });
  }
  return { ...p, asker, partner };
}

export type Accepted = Entered | WhoVerdict | { verdict: 'no'; reason: 'not_held' | 'bad_input'; detail: Record<string, unknown> };

/**
 * Accept an offer: enter the role its accepting form enters (who may, the place, the needs and effects). For a give,
 * once who may is answered, the asker must still hold what it offered, in a hand; if not, `not_held` and nothing changes.
 */
export function accept(input: Input & { receipt: string }): Accepted {
  const node = input?.state?.nodes?.[input.act?.this];
  const entry = node?.kind ? (input.kinds[node.kind] as Activity & { pair?: PairSection }) : undefined;
  if (!entry?.pair) return { verdict: 'no', reason: 'bad_input', detail: { what: 'not_a_pair' } };
  const who = whoMay(input);
  if (who.verdict !== 'yes') return who;
  const gives = entry.pair.gives;
  if (gives !== undefined) {
    const enters = entering(entry, input.act.form);
    if ('bad' in enters) return { verdict: 'no', reason: 'bad_input', detail: { what: enters.bad } };
    const asker = Object.keys(entry.roles ?? {}).find((r) => r !== enters.role)!;
    const by = (node.links?.[asker] ?? [])[0] as string | undefined;
    // Before the asker has joined, the accepting form's own need refuses it.
    for (const thing of by === undefined ? [] : ((node.links?.[gives] ?? []) as string[])) {
      const at = parentOf(input.state.nodes, thing);
      if (!at || at.node !== by || !has(at, 'hand')) return { verdict: 'no', reason: 'not_held', detail: { thing, by: by ?? null } };
    }
  }
  return enter(input);
}
