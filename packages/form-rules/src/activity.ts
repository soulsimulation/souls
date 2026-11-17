// An activity is a node Souls enter, with roles as links (Soul Actions SA-G1a, #2872), for Engine v2 B5 (#2724).
//
// An activity kind carries a `roles` section: each role is one of the kind's link types, with whether it is
// `required`, `replaceable` or `optional`, and `places`, where a member of that role may be. Entering is an ordinary
// form of the kind: the form that links the role to the actor, and whose `reparent` puts the actor into a slot
// argument. `place` fills that argument by the role's rule; `enter` asks who may (SA-F7a), places, and works out the
// form's effects (SA-F2b), so a Soul joins by its own act and the world moves no body.
//
// A role's places, in a fixed order:
// - `in: "this"`: the activity's own slots named in `slots`, in that order (a body becomes the activity's child);
// - `in: "here"`: the slots of the things loose in the place the activity is in, other than the activity, whose
//   origin is within `within_mm` of the activity's origin; nearest first (distances compared as squares, in big
//   integers), then by node id, then in the order the thing's kind declares its slots.
// Either way only a slot that admits a body, and, if the role names one, in its `posture`. The first one with room
// is the place; if none has room, the answer is no, `no_free_place`, naming the role and how many places it looked at.
// Positions (`at_mm` on a node) are its origin in the frame of the place it is in, supplied by the engine.

import { effects, type Done, type Refused, type Unknown } from './effects.ts';
import { whoMay, type Entry, type Input, type Read, type Verdict, type WhoVerdict } from './rules.ts';

export const ROLE_NEEDS = Object.freeze(['required', 'replaceable', 'optional']);
export const PLACES_IN = Object.freeze(['this', 'here']);
export type Places = { in: string; slots?: string[]; within_mm?: number; posture?: string };
export type Role = { need: string; places: Places };
export type Activity = Entry & { roles?: Record<string, Role> };
export type SlotPlace = { node: string; slot: string };
export type PlaceVerdict =
  | { verdict: 'yes'; role: string; place: SlotPlace; args: Record<string, unknown>; read: Read[] }
  | { verdict: 'no'; reason: 'no_free_place'; role: string; detail: { places: number }; read: Read[] }
  | { verdict: 'no'; reason: 'bad_input'; detail: Record<string, unknown>; read: Read[] };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const whole = (v: unknown): v is number => Number.isSafeInteger(v);
const vec = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(whole);

/** The role a form enters, and the slot argument it puts the actor in. */
export function entering(entry: Activity, form: string): { role: string; arg: string } | { bad: string } {
  const f = has(entry.forms, form) ? entry.forms![form] : undefined;
  if (!f) return { bad: 'no_such_form' };
  const effectList = f.effects ?? [];
  const roles = effectList.filter((e) => e && e.change === 'link' && (e.from ?? 'actor') === 'actor' && has(entry.roles, e.link ?? ''));
  if (roles.length !== 1) return { bad: 'not_an_entering_form' };
  const into = effectList.find((e) => e && e.change === 'reparent' && e.what === 'actor')?.into;
  if (!into || typeof into !== 'object' || typeof (into as { arg?: unknown }).arg !== 'string') return { bad: 'no_place_argument' };
  return { role: roles[0].link!, arg: (into as { arg: string }).arg };
}

/** Where the actor would be in the role `input.act.form` enters: the first free place by the role's rule. Never throws. */
export function place(input: Input): PlaceVerdict {
  const read: Read[] = [];
  const bad = (what: string, extra: Record<string, unknown> = {}): PlaceVerdict => ({ verdict: 'no', reason: 'bad_input', detail: { what, ...extra }, read });
  if (!input || typeof input !== 'object' || !input.act || !input.state || !input.kinds) return bad('malformed');
  const { kinds, act, state } = input;
  const nodes = state.nodes ?? {};
  const self = has(nodes, act.this) ? nodes[act.this] : undefined;
  const entry = self?.kind && has(kinds, self.kind) ? (kinds[self.kind] as Activity) : undefined;
  if (!entry) return bad('no_such_kind');
  const enters = entering(entry, act.form);
  if ('bad' in enters) return bad(enters.bad, { form: act.form });
  const role = entry.roles![enters.role];
  const where = role?.places;
  if (!where || !PLACES_IN.includes(where.in)) return bad('malformed_places', { role: enters.role });

  // Candidate places, in the fixed order.
  const candidates: SlotPlace[] = [];
  const bodySlots = (kind: Entry, only?: string[]) =>
    (only ?? Object.keys(kind.slots ?? {})).filter((s) => {
      const d = kind.slots?.[s] as { admits?: string; posture?: string } | undefined;
      return d && d.admits === 'body' && (where.posture === undefined || d.posture === where.posture);
    });
  if (where.in === 'this') {
    if (!Array.isArray(where.slots)) return bad('malformed_places', { role: enters.role });
    for (const slot of bodySlots(entry, where.slots)) candidates.push({ node: act.this, slot });
  } else {
    if (!whole(where.within_mm) || where.within_mm < 0) return bad('malformed_places', { role: enters.role });
    const room = Object.keys(nodes).sort().find((id) => nodes[id].loose?.includes(act.this));
    if (room === undefined) return bad('not_in_a_place', { node: act.this });
    const origin = self!.at_mm;
    if (!vec(origin)) return bad('no_position', { node: act.this });
    read.push([`${act.this}/at_mm`, origin]);
    const limit = BigInt(where.within_mm) * BigInt(where.within_mm);
    const near: [bigint, string, string[]][] = [];
    for (const id of nodes[room].loose ?? []) {
      const n = nodes[id];
      const kind = id !== act.this && n?.kind && has(kinds, n.kind) ? kinds[n.kind] : undefined;
      const slots = kind ? bodySlots(kind) : [];
      if (!slots.length) continue;
      const at = n.at_mm;
      if (!vec(at)) return bad('no_position', { node: id });
      read.push([`${id}/at_mm`, at]);
      let d = 0n;
      for (let k = 0; k < 3; k++) d += (BigInt(at[k]) - BigInt(origin[k])) ** 2n;
      if (d <= limit) near.push([d, id, slots]);
    }
    near.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [, id, slots] of near) for (const slot of slots) candidates.push({ node: id, slot });
  }

  for (const c of candidates) {
    const holder = nodes[c.node];
    const most = (kinds[holder.kind!].slots![c.slot] as { most: number }).most;
    const taken = Array.isArray(holder.slots?.[c.slot]) ? holder.slots![c.slot].length : 0;
    read.push([`${c.node}/slot/${c.slot}`, taken]);
    if (taken < most) return { verdict: 'yes', role: enters.role, place: c, args: { ...(act.args ?? {}), [enters.arg]: c }, read };
  }
  return { verdict: 'no', reason: 'no_free_place', role: enters.role, detail: { places: candidates.length }, read };
}

/** `Unknown` is effects' answer for a draw the world has not made yet: passed through unchanged, as effects gives it. */
export type Entered = (Done & { role: string; place: SlotPlace }) | Refused | Verdict | WhoVerdict | PlaceVerdict | Unknown;

/** Enter the role a form enters: who may (SA-F7a), then the place, then the form's needs and effects (SA-F2b). */
export function enter(input: Input & { receipt: string }): Entered {
  const who = whoMay(input);
  if (who.verdict !== 'yes') return who;
  const at = place(input);
  if (at.verdict !== 'yes') return at;
  const done = effects({ kinds: input.kinds, state: input.state, act: { ...input.act, args: at.args }, receipt: input.receipt });
  return done.verdict === 'yes' && 'changes' in done ? { ...done, role: at.role, place: at.place } : done;
}
