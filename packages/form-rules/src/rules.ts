// What a form needs, decided from plain data (Soul Actions SA-F2, #2843).
//
// One function, `decide`, answers whether a form of a kind (an entry in the SA-F1 format,
// docs/soul-actions/entry-format.md) can be done now: yes; no, with a named reason, what
// changed or is missing and one act that would fix it where the data offers one; or unknown,
// naming the field or link outside the asker's audience. Every verdict carries what it read.
//
// Rules this file keeps, so that the same answer comes out of the server, the agent's client,
// a browser and, later, Engine v2's shared library (R2, #2685):
// - No imports. Plain data in, plain data out.
// - Whole numbers only. Distances are compared as squares, in big integers.
// - Loops run over lists the entry declares (needs, slots, forms); the one list the asker
//   states (a body's hands) is capped at MAX_HANDS.
// - The cases in ../cases/ are the specification. Never edit a case to make this pass.
//
// What a form does once it may be done is effects.ts (SA-F2b, #2844); the amount a transfer
// moves is measured here, so the `room` need and the effect agree on one number.

export const NEEDS = Object.freeze(['state', 'slot_free', 'within_reach', 'hand', 'held_by_actor', 'linked', 'unlinked', 'room']);
export const REASONS = Object.freeze([
  'field_differs',
  'slot_taken',
  'out_of_reach',
  'no_free_hand',
  'not_holding_kind',
  'not_held',
  'not_linked',
  'already_linked',
  'no_room',
  'link_full',
  'bad_input',
]);
export const MAX_HANDS = 8;

export type Ref = string | { arg: string };
export type SlotRef = string | { node: string; slot: string };
export type Need = {
  need: string;
  field?: string;
  is?: unknown;
  not?: unknown;
  at_least?: number;
  at_most?: number;
  slot?: Ref;
  point?: Ref;
  link?: string;
  free?: boolean;
  holds?: string;
};
export type Form = {
  who?: unknown;
  starts?: string;
  needs?: Need[];
  steps?: { step: string; move?: string; at?: Ref }[];
  effects?: Effect[];
};
/** An effect as an entry writes it. `transfer` moves an amount of one field from one node to another (SA-F2b). */
export type Effect = {
  change: string;
  event?: string;
  field?: string;
  to?: unknown;
  link?: string;
  what?: string;
  into?: unknown;
  kind?: string;
  from?: unknown;
  amount?: unknown;
  form?: string;
  after_us?: number;
};
export type Entry = {
  kind: string;
  state?: Record<string, { n: number; default: unknown; audience: string; type?: string; unit?: string; min?: number; max?: number }>;
  links?: Record<string, { n: number; most: number; audience: string }>;
  points?: Record<string, { at_mm: number[] }>;
  slots?: Record<string, { admits: string; most: number; at_mm?: number[] }>;
  forms?: Record<string, Form>;
};
export type Node = {
  kind?: string;
  fields?: Record<string, unknown>;
  links?: Record<string, unknown[]>;
  slots?: Record<string, unknown[]>;
  hands?: Record<string, string | null>;
  effector_mm?: number[];
  /** Things resting loose in this node (on its ground or a surface), not in a slot or a hand. */
  loose?: string[];
};
export type Input = {
  kinds: Record<string, Entry>;
  act: { this: string; form: string; args?: Record<string, unknown> };
  /** `now_us`: world time in whole microseconds, needed only to read a `timed` field. */
  state: { actor: string; nodes: Record<string, Node>; moves?: Record<string, { reach_mm: number }>; now_us?: number };
  asker: { sees: string[] | 'all' };
};
export type Read = [string, unknown];
export type Fix = { form: string; args?: Record<string, unknown> } | { step: string; [key: string]: unknown };
export type Verdict =
  | { verdict: 'yes'; read: Read[] }
  | { verdict: 'no'; reason: string; need: number; detail: Record<string, unknown>; fix: Fix | null; read: Read[] }
  | { verdict: 'unknown'; need: number; node: string; field?: string; link?: string; read: Read[] };

type Outcome = { ok: true } | { ok: false; no: Verdict } | { ok: 'unknown'; unknown: Verdict };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const sorted = (o: object | undefined): string[] => (o ? Object.keys(o).sort() : []);
const whole = (v: unknown): v is number => Number.isSafeInteger(v);

/** Decide whether `input.act` can be done now. Never throws on bad data: it answers `bad_input`. */
export function decide(input: Input): Verdict {
  const read: Read[] = [];
  const bad = (need: number, what: string, extra: Record<string, unknown> = {}): Verdict => ({
    verdict: 'no',
    reason: 'bad_input',
    need,
    detail: { what, ...extra },
    fix: null,
    read,
  });
  if (!input || typeof input !== 'object' || !input.act || !input.state || !input.kinds || !input.asker) return bad(-1, 'malformed');
  const { act, state, kinds, asker } = input;
  const nodes = state.nodes ?? {};
  const args = act.args ?? {};
  const self = has(nodes, act.this) ? nodes[act.this] : undefined;
  if (!self) return bad(-1, 'no_such_node', { node: act.this });
  const entry = self.kind && has(kinds, self.kind) ? kinds[self.kind] : undefined;
  if (!entry) return bad(-1, 'no_such_kind', { kind: self.kind ?? null });
  const form = has(entry.forms, act.form) ? entry.forms![act.form] : undefined;
  if (!form) return bad(-1, 'no_such_form', { form: act.form });
  const actor = has(nodes, state.actor) ? nodes[state.actor] : undefined;
  if (!actor) return bad(-1, 'no_such_node', { node: state.actor });
  const sees = (audience: string) => asker.sees === 'all' || (Array.isArray(asker.sees) && asker.sees.includes(audience));

  // A fix taken only from data: a form of this kind that anyone may start as an act and has an effect that meets the need.
  const formFix = (meets: (e: Effect) => boolean): Fix | null => {
    for (const name of sorted(entry.forms)) {
      const f = entry.forms![name];
      if (name === act.form || f.who !== 'anyone' || f.starts !== 'act') continue;
      if ((f.effects ?? []).some(meets)) return { form: name };
    }
    return null;
  };

  const hands = (): Record<string, string | null> | string => {
    const h = actor.hands ?? {};
    if (typeof h !== 'object' || Object.keys(h).length > MAX_HANDS) return 'too_many_hands';
    for (const name of sorted(h)) read.push([`${state.actor}/hand/${name}`, h[name] ?? null]);
    return h;
  };

  const checks: Record<string, (n: Need, i: number) => Outcome> = {
    state(n, i) {
      const field = n.field ?? '';
      const def = has(entry.state, field) ? entry.state![field] : undefined;
      if (!def) return { ok: false, no: bad(i, 'no_such_field', { field }) };
      if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, field, read } };
      let value = has(self.fields, field) ? self.fields![field] : def.default;
      if (def.type === 'timed') {
        const now = valueAt(def, value, state.now_us);
        if (typeof now !== 'number') return { ok: false, no: bad(i, now.bad, { field }) };
        value = now;
      }
      read.push([`${act.this}/field/${def.n}`, value]);
      const ranged = has(n, 'at_least') || has(n, 'at_most');
      if (ranged && !whole(value)) return { ok: false, no: bad(i, 'not_whole_number', { field }) };
      const meets = (v: unknown) =>
        (!has(n, 'is') || v === n.is) &&
        (!has(n, 'not') || v !== n.not) &&
        (!has(n, 'at_least') || (whole(v) && v >= (n.at_least as number))) &&
        (!has(n, 'at_most') || (whole(v) && v <= (n.at_most as number)));
      if (meets(value)) return { ok: true };
      const wanted: Record<string, unknown> = {};
      for (const k of ['is', 'not', 'at_least', 'at_most']) if (has(n, k)) wanted[k] = (n as Record<string, unknown>)[k];
      const fix = formFix((e) => e.change === 'set' && e.field === field && (e.to === null || typeof e.to !== 'object') && meets(e.to));
      return { ok: false, no: { verdict: 'no', reason: 'field_differs', need: i, detail: { field, found: value, wanted }, fix, read } };
    },

    slot_free(n, i) {
      let ref: unknown = n.slot;
      let argName: string | null = null;
      if (ref && typeof ref === 'object' && has(ref, 'arg')) {
        argName = (ref as { arg: string }).arg;
        if (!has(args, argName)) return { ok: false, no: bad(i, 'argument_missing', { arg: argName }) };
        ref = args[argName];
      }
      const at = typeof ref === 'string' ? { node: act.this, slot: ref } : (ref as { node?: unknown; slot?: unknown } | null);
      if (!at || typeof at.node !== 'string' || typeof at.slot !== 'string') return { ok: false, no: bad(i, 'malformed_slot') };
      const holder = has(nodes, at.node) ? nodes[at.node] : undefined;
      const kind = holder?.kind && has(kinds, holder.kind) ? kinds[holder.kind] : undefined;
      const def = kind && has(kind.slots, at.slot) ? kind.slots![at.slot] : undefined;
      if (!holder || !def) return { ok: false, no: bad(i, 'no_such_slot', { node: at.node, slot: at.slot }) };
      const count = (name: string) => {
        const list = holder.slots?.[name];
        return Array.isArray(list) ? list.length : 0;
      };
      const taken = count(at.slot);
      read.push([`${at.node}/slot/${at.slot}`, taken]);
      if (taken < def.most) return { ok: true };
      let fix: Fix | null = null;
      if (argName) {
        for (const other of sorted(kind!.slots)) {
          const d = kind!.slots![other];
          if (other === at.slot || d.admits !== def.admits || count(other) >= d.most) continue;
          read.push([`${at.node}/slot/${other}`, count(other)]);
          fix = { form: act.form, args: { ...args, [argName]: typeof ref === 'string' ? other : { node: at.node, slot: other } } };
          break;
        }
      }
      return { ok: false, no: { verdict: 'no', reason: 'slot_taken', need: i, detail: { node: at.node, slot: at.slot }, fix, read } };
    },

    within_reach(n, i) {
      const name = resolve(n.point, args);
      if (name === null) return { ok: false, no: bad(i, 'argument_missing', { arg: (n.point as { arg: string })?.arg ?? null }) };
      const place = has(entry.points, name) ? entry.points![name].at_mm : has(entry.slots, name) ? entry.slots![name].at_mm : undefined;
      if (!Array.isArray(place) || place.length !== 3 || !place.every(whole)) return { ok: false, no: bad(i, 'no_such_point', { point: name }) };
      const step = (form.steps ?? []).find((s) => s.step === 'move' && resolve(s.at, args) === name);
      if (!step || typeof step.move !== 'string') return { ok: false, no: bad(i, 'no_move_at_point', { point: name }) };
      const move = has(state.moves, step.move) ? state.moves![step.move] : undefined;
      if (!move || !whole(move.reach_mm) || move.reach_mm < 0) return { ok: false, no: bad(i, 'no_move_reach', { move: step.move }) };
      const from = actor.effector_mm;
      if (!Array.isArray(from) || from.length !== 3 || !from.every(whole)) return { ok: false, no: bad(i, 'no_effector') };
      read.push([`${state.actor}/effector_mm`, from]);
      read.push([`move/${step.move}/reach_mm`, move.reach_mm]);
      let distanceSq = 0n;
      for (let k = 0; k < 3; k++) {
        const d = BigInt(from[k]) - BigInt(place[k]);
        distanceSq += d * d;
      }
      const reach = BigInt(move.reach_mm);
      if (distanceSq <= reach * reach) return { ok: true };
      return { ok: false, no: { verdict: 'no', reason: 'out_of_reach', need: i, detail: { point: name, move: step.move }, fix: { step: 'walk_to', point: name }, read } };
    },

    hand(n, i) {
      const h = hands();
      if (typeof h === 'string') return { ok: false, no: bad(i, h) };
      const names = sorted(h);
      if (n.free === true) {
        if (names.some((k) => h[k] === null || h[k] === undefined)) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'no_free_hand', need: i, detail: {}, fix: names.length ? { step: 'put' } : null, read } };
      }
      if (typeof n.holds === 'string') {
        const kind = n.holds;
        if (names.some((k) => typeof h[k] === 'string' && nodes[h[k] as string]?.kind === kind)) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'not_holding_kind', need: i, detail: { kind }, fix: names.length ? { step: 'take', kind } : null, read } };
      }
      return { ok: false, no: bad(i, 'malformed_need') };
    },

    held_by_actor(_n, i) {
      const h = hands();
      if (typeof h === 'string') return { ok: false, no: bad(i, h) };
      if (sorted(h).some((k) => h[k] === act.this)) return { ok: true };
      return { ok: false, no: { verdict: 'no', reason: 'not_held', need: i, detail: {}, fix: { step: 'take', thing: act.this }, read } };
    },

    linked: (n, i) => link(n, i, true),
    unlinked: (n, i) => link(n, i, false),

    // Every amount the form moves has room where it lands (SA-F2b): a pour never overflows.
    room(_n, i) {
      const transfers = (form.effects ?? []).filter((e) => e && e.change === 'transfer');
      if (!transfers.length) return { ok: false, no: bad(i, 'no_transfer') };
      for (const e of transfers) {
        const m = measure(kinds, nodes, act.this, args, e);
        if ('bad' in m) return { ok: false, no: bad(i, m.bad, m.detail) };
        for (const [node, def] of [[m.from, m.fromDef], [m.into, m.intoDef]] as const) {
          if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node, field: m.field, read } };
        }
        read.push([`${m.from}/field/${m.fromDef.n}`, m.there]);
        read.push([`${m.into}/field/${m.intoDef.n}`, m.has]);
        if (m.room !== null && m.moved > m.room) {
          const detail = { node: m.into, field: m.field, room: m.room, amount: m.moved };
          return { ok: false, no: { verdict: 'no', reason: 'no_room', need: i, detail, fix: null, read } };
        }
      }
      return { ok: true };
    },
  };

  function link(n: Need, i: number, wantLinked: boolean): Outcome {
    const type = n.link ?? '';
    const def = has(entry!.links, type) ? entry!.links![type] : undefined;
    if (!def) return { ok: false, no: bad(i, 'no_such_link', { link: type }) };
    if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, link: type, read } };
    const list = self!.links?.[type];
    const count = Array.isArray(list) ? list.length : 0;
    read.push([`${act.this}/link/${def.n}`, count]);
    if (count > 0 === wantLinked) return { ok: true };
    const change = wantLinked ? 'link' : 'unlink';
    const fix = formFix((e) => e.change === change && e.link === type);
    return { ok: false, no: { verdict: 'no', reason: wantLinked ? 'not_linked' : 'already_linked', need: i, detail: { link: type, count }, fix, read } };
  }

  let unknown: Verdict | null = null;
  const needs = Array.isArray(form.needs) ? form.needs : [];
  for (let i = 0; i < needs.length; i++) {
    const n = needs[i];
    const check = n && typeof n.need === 'string' && has(checks, n.need) ? checks[n.need] : undefined;
    if (!check) return bad(i, 'unknown_need', { need: n?.need ?? null });
    const out = check(n, i);
    if (out.ok === false) return out.no;
    if (out.ok === 'unknown' && !unknown) unknown = out.unknown;
  }
  return unknown ?? { verdict: 'yes', read };
}

// timed:begin. A value that changes with time (SA-F5a, #2845), shared with Engine v2 F5 (#2770).
// It is stored as three whole numbers, `{value, per_s, set_us}`: the value when it was set, its rate per second
// (in the field's unit) and the world time it was set, in microseconds. Nothing is written between events.
// Every number here is a big integer; the lint in timed.test.ts refuses any number literal that is not.

export type Timed = { value: number; per_s: number; set_us: number };
type Bounds = { min?: number; max?: number };
type Exact = { v0: bigint; rate: bigint; set: bigint; lo: bigint | null; hi: bigint | null };

function exact(def: Bounds, stored: unknown, at: unknown): Exact | { bad: string } {
  if (!stored || typeof stored !== 'object') return { bad: 'not_timed' };
  const { value, per_s, set_us } = stored as Partial<Timed>;
  if (![value, per_s, set_us].every(whole)) return { bad: 'not_whole_number' };
  if (!whole(at)) return { bad: 'no_time' };
  if (at < (set_us as number)) return { bad: 'time_before_set' };
  for (const b of [def.min, def.max]) if (b !== undefined && !whole(b)) return { bad: 'not_whole_number' };
  const lo = def.min === undefined ? null : BigInt(def.min);
  const hi = def.max === undefined ? null : BigInt(def.max);
  if (lo !== null && hi !== null && lo > hi) return { bad: 'bounds_crossed' };
  return { v0: clamp(BigInt(value as number), lo, hi), rate: BigInt(per_s as number), set: BigInt(set_us as number), lo, hi };
}

function clamp(v: bigint, lo: bigint | null, hi: bigint | null): bigint {
  if (lo !== null && v < lo) return lo;
  if (hi !== null && v > hi) return hi;
  return v;
}

/** A big integer back to a number, if it is a safe integer. */
function safe(v: bigint): number | { bad: string } {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { bad: 'out_of_range' };
}

/**
 * The value of a timed field at `now_us`: the whole units accrued since it was set (rate x elapsed / 1,000,000,
 * truncated toward zero, so rising and falling behave alike) added to its value, held within the field's `min` and `max`.
 */
export function valueAt(def: Bounds, stored: unknown, now_us: unknown): number | { bad: string } {
  const x = exact(def, stored, now_us);
  if ('bad' in x) return x;
  return safe(clamp(x.v0 + (x.rate * (BigInt(now_us as number) - x.set)) / 1000000n, x.lo, x.hi));
}

/**
 * The first whole microsecond, at or after `from_us`, at which the value is `at_least` (or `at_most`) the level: the
 * time it crosses, rounded up, so a need on the field turns from no to yes at exactly that time. `null` when it never
 * does: the rate is zero or points away, or a bound stops the value short of the level.
 */
export function crossing(def: Bounds, stored: unknown, level: { at_least?: number; at_most?: number }, from_us: unknown): number | null | { bad: string } {
  const x = exact(def, stored, from_us);
  if ('bad' in x) return x;
  const rising = level && has(level, 'at_least') && !has(level, 'at_most');
  const falling = level && has(level, 'at_most') && !has(level, 'at_least');
  const l = rising ? level.at_least : falling ? level.at_most : undefined;
  if (!whole(l)) return { bad: 'malformed_level' };
  const now = valueAt(def, stored, from_us) as number;
  if (rising ? now >= l : now <= l) return from_us as number;
  const L = BigInt(l);
  if (rising ? x.rate <= 0n || (x.hi !== null && x.hi < L) : x.rate >= 0n || (x.lo !== null && x.lo > L)) return null;
  const gap = rising ? L - x.v0 : x.v0 - L;
  const speed = rising ? x.rate : -x.rate;
  return safe(x.set + (gap * 1000000n + speed - 1n) / speed);
}
// timed:end

// who:begin. Who may do a form (SA-F7a, #2848): one closed list, shared with Engine v2 F6 (#2771). A form's `who` is a
// test on links, never on a field: `anyone` (the default: owning does not lock); `holder`, the thing is in one of the
// actor's hands (holding is a parent); `world`, a form a timer starts, which no Soul's act may do; or
// `{"link": <type>}`, the actor or the actor's Soul (the end of the body's `soul` link, T2) is an end of a link of that
// type on the thing: its owner, a member, the Soul whose turn it is, a role in the activity, a relation its creator
// set. The rule is the form's own data, so it is read before anyone tries; a refusal names it and, for a link, its ends.
// The lint in who.test.ts refuses any read of a field between these markers.

export const WHO = Object.freeze(['anyone', 'holder', 'world', 'link']);
export type WhoVerdict =
  | { verdict: 'yes'; who: unknown; read: Read[] }
  | { verdict: 'no'; reason: 'not_permitted' | 'bad_input'; who: unknown; detail: Record<string, unknown>; read: Read[] }
  | { verdict: 'unknown'; who: unknown; node: string; link: string; read: Read[] };

/** Whether the actor may do `input.act` at all, before its needs: yes, no naming who may, or unknown. Never throws. */
export function whoMay(input: Input): WhoVerdict {
  const read: Read[] = [];
  const bad = (what: string, extra: Record<string, unknown> = {}): WhoVerdict => ({ verdict: 'no', reason: 'bad_input', who: null, detail: { what, ...extra }, read });
  if (!input || typeof input !== 'object' || !input.act || !input.state || !input.kinds || !input.asker) return bad('malformed');
  const { act, state, kinds, asker } = input;
  const nodes = state.nodes ?? {};
  const self = has(nodes, act.this) ? nodes[act.this] : undefined;
  if (!self) return bad('no_such_node', { node: act.this });
  const entry = self.kind && has(kinds, self.kind) ? kinds[self.kind] : undefined;
  if (!entry) return bad('no_such_kind', { kind: self.kind ?? null });
  const form = has(entry.forms, act.form) ? entry.forms![act.form] : undefined;
  if (!form) return bad('no_such_form', { form: act.form });
  const actor = has(nodes, state.actor) ? nodes[state.actor] : undefined;
  if (!actor) return bad('no_such_node', { node: state.actor });
  const who = form.who ?? 'anyone';
  const yes: WhoVerdict = { verdict: 'yes', who, read };
  const refuse = (detail: Record<string, unknown>): WhoVerdict => ({ verdict: 'no', reason: 'not_permitted', who, detail, read });

  if (who === 'anyone') return yes;
  if (who === 'world') return refuse({});
  if (who === 'holder') {
    const h = actor.hands ?? {};
    if (typeof h !== 'object' || Object.keys(h).length > MAX_HANDS) return bad('too_many_hands');
    for (const name of sorted(h)) read.push([`${state.actor}/hand/${name}`, h[name] ?? null]);
    return sorted(h).some((k) => h[k] === act.this) ? yes : refuse({});
  }
  const type = who && typeof who === 'object' && Object.keys(who).length === 1 ? (who as { link?: unknown }).link : undefined;
  if (typeof type !== 'string') return bad('unknown_who', { who });
  const def = has(entry.links, type) ? entry.links![type] : undefined;
  if (!def) return bad('no_such_link', { link: type });
  const sees = asker.sees === 'all' || (Array.isArray(asker.sees) && asker.sees.includes(def.audience));
  if (!sees) return { verdict: 'unknown', who, node: act.this, link: type, read };
  const list = self.links?.[type];
  const ends = Array.isArray(list) ? list : [];
  if (!whole(def.most) || ends.length > def.most) return bad('link_over_most', { link: type });
  // The actor's Soul: a body is linked to its Soul (T2), at most one.
  const souls = actor.links?.soul;
  const soul = Array.isArray(souls) && souls.length === 1 && typeof souls[0] === 'string' ? souls[0] : null;
  read.push([`${state.actor}/soul`, soul]);
  read.push([`${act.this}/link/${def.n}/ends`, ends]);
  return ends.some((e) => e === state.actor || (soul !== null && e === soul)) ? yes : refuse({ link: type, ends });
}
// who:end

function resolve(ref: unknown, args: Record<string, unknown>): string | null {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && has(ref, 'arg')) {
    const v = args[(ref as { arg: string }).arg];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

type FieldDef = NonNullable<Entry['state']>[string];
export type Measure = {
  field: string;
  from: string;
  into: string;
  fromDef: FieldDef;
  intoDef: FieldDef;
  /** What the source has, what the target has, the target's room (null: no capacity) and the amount moved. */
  there: number;
  has: number;
  room: number | null;
  moved: number;
};

/**
 * The amount a `transfer` effect moves: the least of what it asks (a whole number, an argument, or `"room"`, the
 * target's room up to its field's `max`) and what the source has above its `min`. Both ends are int fields of one name and unit; amounts are whole and
 * never negative. Shared by the `room` need and by effects.ts, so both work out one number.
 */
export function measure(kinds: Record<string, Entry>, nodes: Record<string, Node>, self: string, args: Record<string, unknown>, e: Effect): Measure | { bad: string; detail: Record<string, unknown> } {
  const end = (ref: unknown) => (ref === 'this' ? self : resolve(ref, args));
  const from = end(e.from), into = end(e.into), field = typeof e.field === 'string' ? e.field : '';
  if (!from || !into || from === into) return { bad: 'malformed_transfer', detail: { from, into } };
  const defs: FieldDef[] = [];
  const values: number[] = [];
  for (const id of [from, into]) {
    const node = has(nodes, id) ? nodes[id] : undefined;
    const entry = node?.kind && has(kinds, node.kind) ? kinds[node.kind] : undefined;
    const def = entry && has(entry.state, field) ? entry.state![field] : undefined;
    if (!node || !def || def.type !== 'int') return { bad: 'no_such_field', detail: { node: id, field } };
    const value = has(node.fields, field) ? node.fields![field] : def.default;
    if (!whole(value) || value < 0) return { bad: 'not_whole_number', detail: { node: id, field } };
    defs.push(def);
    values.push(value);
  }
  const [fromDef, intoDef] = defs;
  const [there, held] = values;
  if (fromDef.unit !== intoDef.unit) return { bad: 'units_differ', detail: { field } };
  // The target's room is up to its field's `max`; the source gives down to its `min` (0 if none).
  let room: number | null = null;
  if (has(intoDef, 'max')) {
    if (!whole(intoDef.max) || intoDef.max < held) return { bad: 'over_capacity', detail: { node: into, field } };
    room = intoDef.max - held;
  }
  const floor = has(fromDef, 'min') ? fromDef.min : 0;
  if (!whole(floor) || floor < 0) return { bad: 'not_whole_number', detail: { node: from, field } };
  let want: unknown = e.amount;
  if (e.amount === 'room') {
    if (room === null) return { bad: 'no_capacity', detail: { node: into, field } };
    want = room;
  } else if (e.amount && typeof e.amount === 'object' && has(e.amount, 'arg')) want = args[(e.amount as { arg: string }).arg];
  if (!whole(want) || want < 0) return { bad: 'not_whole_number', detail: { amount: e.amount ?? null } };
  return { field, from, into, fromDef, intoDef, there, has: held, room, moved: Math.min(want, Math.max(0, there - floor)) };
}
