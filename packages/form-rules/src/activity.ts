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
//
// Leaving, the "now" line and the end (SA-G1b, #2873):
// - Leaving is an ordinary form of the kind too: the form that unlinks exactly one role from the actor (and moves the
//   actor out of its place by the actor's own `reparent`). `leave` runs it, then the role's rule for leaving: a
//   `required` role leaving ends the activity; a `replaceable` one re-opens its place (its link and its slot are free
//   again); an `optional` one changes nothing. A one-off activity also ends when its last member leaves.
// - Ending releases every member, unlinking each from its role (a body seated in another thing's slot stays seated:
//   the world moves no body), moves any body still in the activity's own slots out to the place the activity is in,
//   so that removing the activity removes no body, and removes the activity. Nothing removes a member for being quiet.
// - The `now` section names the parts of the activity's "now" line, a fact Souls read and schedule themselves by:
//   `floor`, the link type whose ends have the floor; `stage`, an enum field; `ends`, a timed field (SA-F5a) counting
//   down, whose crossing of 0 is when it ends. An activity nobody entered is removed at that time by its own world form
//   (`who: "world"`, `starts: "timer"`), whose needs are that time and no member; the engine's timer runs it.

// A standing activity (a course, a job; SA-G2, #2874) outlasts a sitting. Its `standing` section names `members`, the
// link type of those who belong across days (joining and parting are forms that link and unlink; the activity is not
// ended by its last member parting, nor by nobody being present), `present`, the link type of those at the sitting now
// (a role entered by `enter`, so places are chosen by its rule), `enough`, how many present start a sitting, and the
// enum field `stage` with its values `sitting` and `idle`. The check is made when a member arrives: once `enough` are
// present the rules set the stage to `sitting` (event `sitting_began`); when the last one rises it returns to `idle`
// (event `sitting_ended`). Present is a subset of members: only a member may arrive (the arriving form's `who`), and a
// member cannot part while present (refused `still_present`). The end date is its `ends` field: its own world form
// removes it at that time, members or not; `lapse` then releases every member first. Nothing waits for a time.

import { apply, effects, parentOf, type Change, type Done, type Event, type Refused, type State, type Unknown } from './effects.ts';
import { crossing, seesAudience, whoMay, type Audience, type Entry, type Input, type Int, type Read, type Verdict, type WhoVerdict } from './rules.ts';

export const ROLE_NEEDS = Object.freeze(['required', 'replaceable', 'optional']);
export const PLACES_IN = Object.freeze(['this', 'here']);
export type Places = { in: string; slots?: string[]; within_mm?: number; posture?: string };
export type Role = { need: string; places?: Places };
export const NOW_PARTS = Object.freeze(['floor', 'stage', 'ends']);
export type Now = { floor?: string; stage?: string; ends?: string };
export const STANDING_PARTS = Object.freeze(['members', 'present', 'enough', 'stage', 'sitting', 'idle']);
export type Standing = { members: string; present: string; enough: number; stage: string; sitting: string; idle: string };
export type Activity = Entry & { roles?: Record<string, Role>; now?: Now; standing?: Standing };
/** The now line: a member of the activity's own section (17, `roles.now`), or a top-level `now` in the test kinds. */
const nowOf = (entry: Activity): Now | undefined => entry.now ?? ((entry.roles as Record<string, unknown> | undefined)?.now as Now | undefined);
/** The role names of an activity: its roles section, less its now line. */
const roleNames = (entry: Activity): string[] => Object.keys(entry.roles ?? {}).filter((k) => k !== 'now');
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


/** The `standing` section if the kind has one and it is whole; `{bad}` if it is malformed; null if it is a one-off. */
export function standingOf(entry: Activity): Standing | { bad: string } | null {
  const s = entry.standing;
  if (s === undefined) return null;
  if (!s || typeof s !== 'object' || Object.keys(s).some((k) => !STANDING_PARTS.includes(k))) return { bad: 'malformed_standing' };
  if (![s.members, s.present].every((l) => typeof l === 'string' && has(entry.links, l) && has(entry.roles, l)) || s.members === s.present) return { bad: 'malformed_standing' };
  const most = entry.links![s.present].most;
  if (!whole(s.enough) || s.enough < 1 || s.enough > most) return { bad: 'malformed_standing' };
  const def = has(entry.state, s.stage) ? entry.state![s.stage] : undefined;
  const values = (def as { values?: unknown } | undefined)?.values;
  if (!def || def.type !== 'enum' || !Array.isArray(values) || !values.includes(s.sitting) || !values.includes(s.idle) || s.sitting === s.idle) return { bad: 'malformed_standing' };
  return s;
}

const namespace = (entry: Entry) => (entry.kind.includes(':') ? entry.kind.slice(0, entry.kind.indexOf(':')) : entry.kind);
/** The stage field's value on a node, its default when never set. */
const stageOf = (entry: Entry, node: { fields?: Record<string, unknown> }, field: string): unknown => (has(node.fields, field) ? node.fields![field] : entry.state![field].default);

export type Joined = (Done & { role: string }) | Refused | Verdict | WhoVerdict | LeaveBad | Unknown;
/** Join a standing activity: the form that links the actor as a member, with no place (membership is not being there). */
export function join(input: Input & { receipt: string }): Joined {
  const who = whoMay(input);
  if (who.verdict !== 'yes') return who;
  const { kinds, act, state } = input;
  const entry = kinds[state.nodes[act.this].kind!] as Activity;
  const standing = standingOf(entry);
  if (!standing || 'bad' in standing) return { verdict: 'no', reason: 'bad_input', detail: { what: standing ? standing.bad : 'not_standing' } };
  const f = has(entry.forms, act.form) ? entry.forms![act.form] : undefined;
  const links = (f?.effects ?? []).filter((e) => e && e.change === 'link' && (e.from ?? 'actor') === 'actor');
  if (!f || links.length !== 1 || links[0].link !== standing.members) return { verdict: 'no', reason: 'bad_input', detail: { what: 'not_a_joining_form', form: act.form } };
  const done = effects({ kinds, state, act, receipt: input.receipt });
  return done.verdict === 'yes' && 'changes' in done ? { ...done, role: standing.members } : done;
}

/** A set of the stage, as its own event. */
function setStage(entry: Activity, standing: Standing, id: string, to: string, name: string, done: Done): Done {
  const changes = [...done.changes, { change: 'set' as const, node: id, field: standing.stage, n: entry.state![standing.stage].n, to }];
  return { ...done, changes, events: [...done.events, { event: `${namespace(entry)}:${name}`, node: id, changes: [changes.length - 1] }] };
}

/** When the sitting starts: once `enough` are present and the stage is not yet `sitting`, set it; else add nothing. */
function sittingBegins(entry: Activity, standing: Standing, nodes: State['nodes'], id: string, done: Done): Done {
  const present = (nodes[id].links?.[standing.present] ?? []).length;
  if (present < standing.enough || stageOf(entry, nodes[id], standing.stage) === standing.sitting) return done;
  return setStage(entry, standing, id, standing.sitting, 'sitting_began', done);
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
  if (done.verdict !== 'yes' || !('changes' in done)) return done;
  const entry = input.kinds[input.state.nodes[input.act.this].kind!] as Activity;
  const standing = standingOf(entry);
  if (!standing || 'bad' in standing || at.role !== standing.present) return { ...done, role: at.role, place: at.place };
  // The sitting is checked as a member arrives: on the state with the arrival done.
  const after = apply(input.state, done);
  if (!after.ok) return { ...done, role: at.role, place: at.place };
  return { ...sittingBegins(entry, standing, after.state.nodes, input.act.this, done), role: at.role, place: at.place };
}

/** The role a form leaves: the form that unlinks exactly one role from the actor. */
export function leaving(entry: Activity, form: string): { role: string } | { bad: string } {
  const f = has(entry.forms, form) ? entry.forms![form] : undefined;
  if (!f) return { bad: 'no_such_form' };
  const roles = (f.effects ?? []).filter((e) => e && e.change === 'unlink' && (e.from ?? 'actor') === 'actor' && has(entry.roles, e.link ?? ''));
  return roles.length === 1 ? { role: roles[0].link! } : { bad: 'not_a_leaving_form' };
}

export type LeaveBad = { verdict: 'no'; reason: 'bad_input' | 'still_present'; detail: Record<string, unknown> };
/** `ended` is 1 when this leave ended the activity, which is then removed; else 0. */
/** `Unknown` is effects' answer for a draw the world has not made yet: passed through unchanged, as `enter` does. */
export type Left = (Done & { role: string; ended: 0 | 1 }) | Refused | Verdict | WhoVerdict | LeaveBad | Unknown;

/**
 * Leave the role a form leaves: who may (SA-F7a), the form's own needs and effects (SA-F2b), then the role's rule for
 * leaving. When the activity ends, the rules add two events of the activity's own: `released`, unlinking every
 * remaining member and moving a body still in the activity's own slots out to its place, and `ended`, removing it.
 */
export function leave(input: Input & { receipt: string }): Left {
  const bad = (what: string, extra: Record<string, unknown> = {}): LeaveBad => ({ verdict: 'no', reason: 'bad_input', detail: { what, ...extra } });
  const who = whoMay(input);
  if (who.verdict !== 'yes') return who;
  const { kinds, act, state } = input;
  const entry = kinds[state.nodes[act.this].kind!] as Activity;
  const leaves = leaving(entry, act.form);
  if ('bad' in leaves) return bad(leaves.bad, { form: act.form });
  const need = entry.roles![leaves.role]?.need;
  if (!ROLE_NEEDS.includes(need)) return bad('malformed_role', { role: leaves.role });
  const standing = standingOf(entry);
  if (standing && 'bad' in standing) return bad(standing.bad);
  // A member cannot part while present: the sitting has to be left first.
  if (standing && leaves.role === standing.members && (state.nodes[act.this].links?.[standing.present] ?? []).includes(state.actor)) {
    return { verdict: 'no', reason: 'still_present', detail: { link: standing.present } };
  }
  const done = effects({ kinds, state, act, receipt: input.receipt });
  if (done.verdict !== 'yes' || !('changes' in done)) return done;
  const after = apply(state, done);
  if (!after.ok) return bad(after.reason, { change: after.change });
  const nodes = after.state.nodes;
  const self = nodes[act.this];
  const members: [string, string][] = [];
  for (const role of roleNames(entry)) for (const end of (self.links?.[role] ?? []) as string[]) members.push([role, end]);
  if (standing) {
    // A standing activity outlasts its members: it ends only by its required roles or its end date. The last one
    // present rising ends the sitting.
    const back = leaves.role === standing.present && (self.links?.[standing.present] ?? []).length === 0 && stageOf(entry, self, standing.stage) === standing.sitting;
    if (need !== 'required') return { ...(back ? setStage(entry, standing, act.this, standing.idle, 'sitting_ended', done) : done), role: leaves.role, ended: 0 };
  }
  else if (need !== 'required' && members.length > 0) return { ...done, role: leaves.role, ended: 0 };

  // The activity ends: release every member, then remove it.
  const at = parentOf(nodes, act.this);
  if (!at || has(at, 'slot') || has(at, 'hand')) return bad('not_in_a_place', { node: act.this });
  const ns = entry.kind.includes(':') ? entry.kind.slice(0, entry.kind.indexOf(':')) : entry.kind;
  const changes: Change[] = [...done.changes];
  const events: Event[] = [...done.events];
  const released: Event = { event: `${ns}:released`, node: act.this, changes: [] };
  for (const [role, end] of members) {
    released.changes.push(changes.length);
    changes.push({ change: 'unlink', node: act.this, link: role, n: entry.links![role].n, end });
  }
  for (const slot of Object.keys(self.slots ?? {}).sort()) {
    for (const body of (self.slots![slot] ?? []) as string[]) {
      released.changes.push(changes.length);
      changes.push({ change: 'reparent', node: body, to: { node: at.node } });
    }
  }
  if (released.changes.length) events.push(released);
  events.push({ event: `${ns}:ended`, node: act.this, changes: [changes.length] });
  changes.push({ change: 'remove', node: act.this });
  const result: Done & { role: string; ended: 1 } = { ...done, changes, events, role: leaves.role, ended: 1 };
  const check = apply(state, result);
  return check.ok ? result : bad(check.reason, { change: check.change });
}

export type Lapsed = (Done & { released: number }) | Refused | Verdict | LeaveBad | Unknown;
/**
 * The end date of an activity, as the engine's timer runs its world form (`starts: "timer"`, whose need is the time and
 * nothing else, so members do not hold it): the form's own effects, with every member released first. Each is unlinked
 * from its role (event `released`); a body seated in another thing's slot stays seated, and one in the activity's own
 * slots is moved out to its place, so removing the activity removes no body.
 */
export function lapse(input: Omit<Input, 'asker'> & { receipt: string }): Lapsed {
  const done = effects(input);
  if (done.verdict !== 'yes' || !('changes' in done)) return done;
  const { kinds, state, act } = input;
  const self = state.nodes[act.this];
  const entry = kinds[self.kind!] as Activity;
  const members: [string, string][] = [];
  for (const role of roleNames(entry)) for (const end of (self.links?.[role] ?? []) as string[]) members.push([role, end]);
  if (!members.length) return { ...done, released: 0 };
  const releases: Change[] = members.map(([role, end]) => ({ change: 'unlink', node: act.this, link: role, n: entry.links![role].n, end }));
  // A body standing in the activity's own slots is moved out to the place the activity is in, as `leave`'s ending does,
  // so removing the activity removes no body (SA-G4: a lapsed offer's asker stands in its own place).
  const at = parentOf(state.nodes, act.this);
  for (const slot of Object.keys(self.slots ?? {}).sort()) for (const body of (self.slots![slot] ?? []) as string[]) if (at && !has(at, 'slot') && !has(at, 'hand')) releases.push({ change: 'reparent', node: body, to: { node: at.node } });
  const k = releases.length;
  const released: Event = { event: `${namespace(entry)}:released`, node: act.this, changes: releases.map((_, i) => i) };
  const result: Done & { released: number } = {
    ...done,
    changes: [...releases, ...done.changes],
    events: [released, ...done.events.map((e) => ({ ...e, changes: e.changes.map((c) => c + k) }))],
    timers: done.timers.map((t) => ({ ...t, event: t.event + 1 })),
    released: members.length,
  };
  const check = apply(state, result);
  return check.ok ? result : { verdict: 'no', reason: 'bad_input', detail: { what: check.reason, change: check.change } };
}

/** `ends_us` is SA-F5a's `Int`: a number when safe, a BigInt beyond 2^53. */
export type NowLine = { floor?: string[]; stage?: unknown; ends_us?: Int };
export type NowVerdict =
  | { verdict: 'yes'; now: NowLine; unseen: string[]; read: Read[] }
  | { verdict: 'no'; reason: 'bad_input'; detail: Record<string, unknown>; read: Read[] };

/**
 * The activity's "now" line as the asker may see it: who has the floor, the stage, and when it ends (the first
 * microsecond at which its `ends` field reaches 0, by SA-F5a's `crossing`; left out when it never does). A part outside
 * the asker's audience is left out and named in `unseen`. Never throws.
 */
export function nowLine(input: { kinds: Record<string, Entry>; state: { nodes: Input['state']['nodes'] }; node: string; asker: Input['asker'] }): NowVerdict {
  const read: Read[] = [];
  const bad = (what: string, extra: Record<string, unknown> = {}): NowVerdict => ({ verdict: 'no', reason: 'bad_input', detail: { what, ...extra }, read });
  if (!input || !input.kinds || !input.state || !input.asker) return bad('malformed');
  const { kinds, state, node, asker } = input;
  const n = has(state.nodes, node) ? state.nodes[node] : undefined;
  const entry = n?.kind && has(kinds, n.kind) ? (kinds[n.kind] as Activity) : undefined;
  if (!n || !entry) return bad('no_such_kind');
  const parts = nowOf(entry);
  if (!parts || typeof parts !== 'object') return bad('no_now');
  const extra = Object.keys(parts).filter((k) => !NOW_PARTS.includes(k));
  if (extra.length) return bad('malformed_now', { parts: extra });
  const sees = (audience: Audience) => seesAudience(asker.sees, audience);
  const now: NowLine = {};
  const unseen: string[] = [];
  if (parts.floor !== undefined) {
    const def = has(entry.links, parts.floor) ? entry.links![parts.floor] : undefined;
    if (!def) return bad('no_such_link', { link: parts.floor });
    if (!sees(def.audience)) unseen.push('floor');
    else {
      now.floor = [...((n.links?.[parts.floor] ?? []) as string[])];
      read.push([`${node}/link/${def.n}/ends`, now.floor]);
    }
  }
  for (const part of ['stage', 'ends'] as const) {
    const field = parts[part];
    if (field === undefined) continue;
    const def = has(entry.state, field) ? entry.state![field] : undefined;
    if (!def || def.type !== (part === 'stage' ? 'enum' : 'timed')) return bad('malformed_now', { part, field: field ?? null });
    if (!sees(def.audience)) {
      unseen.push(part);
      continue;
    }
    const value = has(n.fields, field) ? n.fields![field] : def.default;
    read.push([`${node}/field/${def.n}`, value]);
    if (part === 'stage') now.stage = value;
    else {
      const at = crossing(def, value, { at_most: 0 }, (value as { set_us?: unknown } | null)?.set_us);
      if (at !== null && typeof at === 'object') return bad(at.bad, { field });
      if (at !== null) now.ends_us = at;
    }
  }
  return { verdict: 'yes', now, unseen, read };
}
