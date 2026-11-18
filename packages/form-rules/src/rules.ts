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

export const NEEDS = Object.freeze(['state', 'slot_free', 'within_reach', 'hand', 'held_by_actor', 'linked', 'unlinked', 'room', 'enough', 'sum', 'any', 'moves']);
export const REASONS = Object.freeze([
  'field_differs',
  'slot_taken',
  'out_of_reach',
  'no_free_hand',
  'hand_not_empty',
  'not_holding_kind',
  'not_held',
  'not_linked',
  'already_linked',
  'no_room',
  'not_enough',
  'link_full',
  'moves_by',
  'motion_unsaid',
  'needs_souls',
  'bad_input',
]);
export const MAX_HANDS = 8;
/** How a thing moves (entry section 18, `motion.how`), one list with tools/entry/format.mjs and Engine v2 E5 (#2778):
 *  carried in one or two hands, pushed by one Soul or by two, or fixed. A body acts alone, so two Souls' push is refused. */
export const CARRIED: Readonly<Record<string, number>> = Object.freeze({ one_hand: 1, two_hands: 2 });
export const PUSHED: Readonly<Record<string, number>> = Object.freeze({ pushed_by_one: 1, wheeled: 1, two_souls: 2 });

export type Ref = string | { arg: string };
export type SlotRef = string | { node: string; slot: string };
export type Need = {
  need: string;
  /** A field of this kind, or a `field` argument: one of the form's own closed list of fields. */
  field?: Ref;
  is?: unknown;
  not?: unknown;
  at_least?: number;
  at_most?: number;
  slot?: Ref;
  point?: Ref;
  link?: string;
  /** The thing a need reads, given as a form argument; omitted means this thing. `within_reach`: the thing whose point
   *  it is. `state`: the field is read through that thing's kind. */
  of?: Ref;
  /** A `sum` need: int fields of this kind added up; with `after_moves`, as this form's transfers leave them. An `any`
   *  need: at least one of these fields is `not` the value. */
  fields?: string[];
  after_moves?: boolean;
  free?: boolean;
  /** A `hand` need: every hand holds nothing. */
  empty?: boolean;
  holds?: string;
  /** The words of this need's refusal: a key of the entry's text table, returned on a `no` (SA-F6b). */
  says?: string;
  /** `held_by_actor` and `moves`: the thing argument the need is about (default, for held: this thing). */
  thing?: Ref;
  /** `moves`: how the form moves the thing, `carry` or `push`. */
  by?: string;
};
/** An argument's type. A `field` or `value` argument is a choice from the form's own closed list, `of`. */
export type Takes = Record<string, { type: string; of?: string[] }>;
export type Form = {
  who?: unknown;
  starts?: string;
  takes?: Takes;
  needs?: Need[];
  steps?: { step: string; move?: string; at?: Ref; toward?: Ref; point?: Ref }[];
  effects?: Effect[];
};
/** An effect as an entry writes it. `transfer` moves an amount of one field from one node to another (SA-F2b). */
export type Effect = {
  change: string;
  event?: string;
  /** A `set` may name a `field` argument: one of the form's own closed list of fields. */
  field?: Ref;
  to?: unknown;
  link?: string;
  what?: string | { arg: string };
  into?: unknown;
  kind?: string;
  from?: unknown;
  amount?: unknown;
  /** A transfer between two fields of one thing: the field it lands in (`field` is the one it leaves). */
  into_field?: string;
  form?: string;
  after_us?: number;
  /** A `draw`: the table the world draws one outcome from (SA-F13). */
  outcomes?: DrawRow[];
  /** A set on a timed value: its new rate per second, settled at the act's time. */
  rate?: number;
  /** A set on an int field may add `by` (signed) to its value instead of naming `to`: a count, or an amount used up. */
  by?: number;
};
/** One row of a draw table. `weight` is a whole number or `{field}`, one whole-number field of the thing (a practice count): nothing else. */
export type DrawRow = { name: string; weight: number | { field: string }; event: string; set: { field: string; to: unknown }[] };
export type Entry = {
  kind: string;
  state?: Record<string, { n: number; default: unknown; audience: Audience; type?: string; unit?: string; min?: number; max?: number }>;
  links?: Record<string, { n: number; most: number; audience: Audience }>;
  points?: Record<string, { at_mm: number[] }>;
  slots?: Record<string, { admits: string; most: number; at_mm?: number[] }>;
  forms?: Record<string, Form>;
  /** A closed kind: the fields it names take the container's audience and declare none of their own (SA-F8, #2849). */
  closed?: { audience: Audience; fields?: string[] };
  motion?: { how?: string };
};
export type Node = {
  kind?: string;
  fields?: Record<string, unknown>;
  links?: Record<string, unknown[]>;
  slots?: Record<string, unknown[]>;
  hands?: Record<string, string | null>;
  effector_mm?: number[];
  /** Its origin in the frame of the place it is loose in, whole mm, supplied by the engine (an activity's places, SA-G1a). */
  at_mm?: number[];
  /** Things resting loose in this node (on its ground or a surface), not in a slot or a hand. */
  loose?: string[];
  /** Pending timers this node owns (Engine v2 T6 rule 15): each named by the form it starts. */
  timers?: { id: string; form: string; due_us?: number }[];
};
/** A field's audience: a rule object of the entry format (SA-F8), or a bare string left in old data. */
export type Audience = string | { rule: 'everyone' | 'owner' | 'creator' } | { rule: 'linked'; link: string };

/** Whether an asker whose `sees` is `sees` belongs to `audience`: the one resolver every audience read uses. */
export function seesAudience(sees: unknown, audience: Audience): boolean {
  if (sees === 'all') return true;
  const list = Array.isArray(sees) ? sees : [];
  if (typeof audience !== 'object' || audience === null) return typeof audience === 'string' && list.includes(audience); // a bare string keeps its old meaning; none declared is seen by no list
  if (audience.rule === 'everyone') return true;
  if (audience.rule === 'linked') return list.includes(`linked:${audience.link}`);
  return list.includes(audience.rule);
}
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
  | { verdict: 'no'; reason: string; need: number; detail: Record<string, unknown>; fix: Fix | null; read: Read[]; says?: string }
  | { verdict: 'unknown'; need: number; node: string; field?: string; link?: string; read: Read[] };

type Outcome = { ok: true } | { ok: false; no: Verdict } | { ok: 'unknown'; unknown: Verdict };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const sorted = (o: object | undefined): string[] => (o ? Object.keys(o).sort() : []);
const whole = (v: unknown): v is number => Number.isSafeInteger(v);
/** A whole number as a safe integer or a big integer (a timed value beyond 2^53, SA-F5a). */
const int = (v: unknown): v is number | bigint => whole(v) || typeof v === 'bigint';
/** A flag is stored as 0 or 1 (Engine v2's encoding has no booleans); an entry may still write true or false. */
const flag = (def: { type?: string }, v: unknown): unknown => (def.type === 'bool' && typeof v === 'boolean' ? Number(v) : v);

/** Who may see a state field: the container's audience when the kind is closed and names it, else the field's own. */
const audienceOf = (entry: Entry | undefined, field: string, def = entry?.state?.[field]): Audience =>
  entry?.closed?.fields?.includes(field) ? entry.closed.audience : (def?.audience as Audience);

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
  // A field or value argument is one of the form's own choices, so a form never writes a field it does not name.
  const takes: Takes = form.takes && typeof form.takes === 'object' ? form.takes : {};
  for (const name of sorted(takes)) {
    const t = takes[name];
    if (!t || (t.type !== 'field' && t.type !== 'value') || !has(args, name)) continue;
    if (!Array.isArray(t.of) || !t.of.includes(args[name] as string)) return bad(-1, 'not_a_choice', { arg: name, value: (args[name] ?? null) as unknown });
  }
  // The asker's `sees` lists the audiences it belongs to: `owner`, `creator`, and `linked:<link type>` for each link
  // it holds to the thing. `everyone` is seen by any asker; a bare string keeps its old meaning.
  const sees = (audience: Audience) => seesAudience(asker.sees, audience);

  // A fix taken only from data: a form of this kind that anyone, or its holder, may start as an act and has an effect
  // that meets the need. A holder's form refused for want of holding names its own fix (take).
  // `ready`, when given, passes over a form its own needs would refuse now (a dimmer step on a lamp that is dark).
  const formFix = (meets: (e: Effect) => boolean, ready?: (f: Form) => boolean): Fix | null => {
    for (const name of sorted(entry.forms)) {
      const f = entry.forms![name];
      if (name === act.form || (f.who !== 'anyone' && f.who !== 'holder') || f.starts !== 'act') continue;
      if (ready && !ready(f)) continue;
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
      if (has(n, 'link')) return placeState(n, i);
      if (has(n, 'of')) return argState(n, i);
      // A field argument names one of the form's fields; a value argument the value compared with (a choice each).
      for (const k of ['field', 'is', 'not'] as const) if (isRef(n[k]) && !has(args, (n[k] as { arg: string }).arg)) return { ok: false, no: bad(i, 'argument_missing', { arg: (n[k] as { arg: string }).arg }) };
      const field = resolve(n.field, args) ?? '';
      const target = { is: valueOf(n.is, args), not: valueOf(n.not, args) };
      const def = has(entry.state, field) ? entry.state![field] : undefined;
      if (!def) return { ok: false, no: bad(i, 'no_such_field', { field }) };
      if (!sees(audienceOf(entry, field))) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, field, read } };
      let value = has(self.fields, field) ? self.fields![field] : def.default;
      if (def.type === 'timed') {
        const now = valueAt(def, value, state.now_us);
        if (typeof now === 'object') return { ok: false, no: bad(i, now.bad, { field }) };
        value = now;
      }
      read.push([`${act.this}/field/${def.n}`, value]);
      const ranged = has(n, 'at_least') || has(n, 'at_most');
      if (ranged && !int(value)) return { ok: false, no: bad(i, 'not_whole_number', { field }) };
      const holds = (m: Need, v: unknown) =>
        (!has(m, 'is') || flag(def, v) === flag(def, m.is)) &&
        (!has(m, 'not') || flag(def, v) !== flag(def, m.not)) &&
        (!has(m, 'at_least') || (int(v) && v >= (m.at_least as number))) &&
        (!has(m, 'at_most') || (int(v) && v <= (m.at_most as number)));
      const meetsWith = (v: unknown, t: { is: unknown; not: unknown }) =>
        (!has(n, 'is') || flag(def, v) === flag(def, t.is)) &&
        (!has(n, 'not') || flag(def, v) !== flag(def, t.not)) &&
        (!has(n, 'at_least') || (int(v) && v >= (n.at_least as number))) &&
        (!has(n, 'at_most') || (int(v) && v <= (n.at_most as number)));
      const meets = (v: unknown) => meetsWith(v, target);
      if (meets(value)) return { ok: true };
      const wanted: Record<string, unknown> = {};
      for (const k of ['is', 'not', 'at_least', 'at_most']) if (has(n, k)) wanted[k] = k === 'is' || k === 'not' ? target[k] : (n as Record<string, unknown>)[k];
      // The closest fix is this same act with another choice of the value it compares with (brush the other way); a
      // field argument's other choices are other acts, not fixes (another shoot is not this one).
      for (const k of ['is', 'not'] as const) {
        const ref = n[k];
        if (!isRef(ref)) continue;
        const choices = takes[ref.arg]?.type === 'value' ? takes[ref.arg].of ?? [] : [];
        for (const c of choices) {
          if (c === args[ref.arg] || !meetsWith(value, { ...target, [k]: c })) continue;
          return { ok: false, no: { verdict: 'no', reason: 'field_differs', need: i, detail: { field, found: value, wanted }, fix: { form: act.form, args: { ...args, [ref.arg]: c } }, read } };
        }
      }
      // a transfer in fills toward the field's max and one out empties toward its min: it meets the need if that end does;
      // a set with `by` meets it if the value it adds up to does, within the field's bounds (a crank that adds charge)
      const after = (by: unknown) => (whole(by) && whole(value) ? value + by : null);
      const fix = formFix((e) => (e.change === 'set' && e.field === field && !has(e, 'by') && (e.to === null || typeof e.to !== 'object') && meets(e.to)) ||
        (e.change === 'set' && e.field === field && after(e.by) !== null && after(e.by)! >= (def.min ?? 0) && (!whole(def.max) || after(e.by)! <= def.max) && meets(after(e.by))) ||
        (e.change === 'transfer' && ((e.into === 'this' && (e.into_field ?? e.field) === field && whole(def.max) && meets(def.max)) || (e.from === 'this' && e.field === field && meets(def.min ?? 0)))),
        // the fix's own needs on this field of this thing (not an argument's or the place's) must hold now, or it would be
        // refused in turn
        (f) => (f.needs ?? []).every((m) => m.need !== 'state' || has(m, 'of') || has(m, 'link') || m.field !== field || holds(m, value)));
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
      // Reach to another thing, in this order (decided 17 Nov): (1) walk-first: a form that walks to the thing first
      // reaches it by that walk, so the need is met when the thing is in the actor's place (the engine walks); (2) else
      // the measured pose: `of` names the thing by a form argument, its point is in its own frame, placed by its
      // `at_mm` in the input; (3) else unknown.
      const thingRef = n.of !== undefined ? n.of : n.point;
      const thingId = n.of !== undefined ? (n.of && typeof n.of === 'object' ? resolve(n.of, args) : null) : name;
      const walks = (form.steps ?? []).some((s) => s.step === 'walk_to' && sameRef(s.point, thingRef));
      const isThing = thingId !== null && has(nodes, thingId) && (n.of !== undefined || (!has(entry.points, name) && !has(entry.slots, name)));
      if (walks && isThing) {
        const there = placeOf(nodes, thingId!), mine = placeOf(nodes, state.actor);
        read.push([`${thingId}/place`, there]);
        if (there !== null && there === mine) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'out_of_reach', need: i, detail: { thing: thingId }, fix: { step: 'walk_to', thing: thingId }, read } };
      }
      if (n.of === undefined && isThing) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: thingId!, field: 'at_mm', read } };
      let owner = entry;
      let ownerId: string | null = null;
      let origin: number[] | null = null;
      if (n.of !== undefined) {
        const argName = (n.of as { arg?: unknown } | null)?.arg;
        if (typeof argName !== 'string') return { ok: false, no: bad(i, 'malformed_need') };
        if (!has(args, argName)) return { ok: false, no: bad(i, 'argument_missing', { arg: argName }) };
        ownerId = typeof args[argName] === 'string' ? (args[argName] as string) : null;
        const other = ownerId !== null && has(nodes, ownerId) ? nodes[ownerId] : undefined;
        const otherKind = other?.kind && has(kinds, other.kind) ? kinds[other.kind] : undefined;
        if (!other || !otherKind) return { ok: false, no: bad(i, 'no_such_node', { node: ownerId }) };
        owner = otherKind;
        origin = Array.isArray(other.at_mm) && other.at_mm.length === 3 && other.at_mm.every(whole) ? other.at_mm : null;
      }
      const place = has(owner.points, name) ? owner.points![name].at_mm : has(owner.slots, name) ? owner.slots![name].at_mm : undefined;
      if (!Array.isArray(place) || place.length !== 3 || !place.every(whole)) return { ok: false, no: bad(i, 'no_such_point', { point: name }) };
      if (ownerId !== null && !origin) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: ownerId, field: 'at_mm', read } };
      const same = (s: { at?: Ref; toward?: Ref }) => (ownerId === null ? resolve(s.at, args) === name : (s.toward as { arg?: string } | undefined)?.arg === (n.of as { arg: string }).arg);
      const step = (form.steps ?? []).find((s) => s.step === 'move' && same(s));
      if (!step || typeof step.move !== 'string') return { ok: false, no: bad(i, 'no_move_at_point', { point: name }) };
      const move = has(state.moves, step.move) ? state.moves![step.move] : undefined;
      if (!move || !whole(move.reach_mm) || move.reach_mm < 0) return { ok: false, no: bad(i, 'no_move_reach', { move: step.move }) };
      const from = actor.effector_mm;
      if (!Array.isArray(from) || from.length !== 3 || !from.every(whole)) return { ok: false, no: bad(i, 'no_effector') };
      read.push([`${state.actor}/effector_mm`, from]);
      read.push([`move/${step.move}/reach_mm`, move.reach_mm]);
      let distanceSq = 0n;
      if (ownerId !== null) read.push([`${ownerId}/at_mm`, origin]);
      for (let k = 0; k < 3; k++) {
        const d = BigInt(from[k]) - BigInt(place[k]) - BigInt(origin ? origin[k] : 0);
        distanceSq += d * d;
      }
      const reach = BigInt(move.reach_mm);
      if (distanceSq <= reach * reach) return { ok: true };
      return { ok: false, no: { verdict: 'no', reason: 'out_of_reach', need: i, detail: ownerId === null ? { point: name, move: step.move } : { point: name, of: ownerId, move: step.move }, fix: ownerId === null ? { step: 'walk_to', point: name } : { step: 'walk_to', point: has(owner.points, 'stand') ? 'stand' : name, thing: ownerId }, read } };
    },

    hand(n, i) {
      const h = hands();
      if (typeof h === 'string') return { ok: false, no: bad(i, h) };
      const names = sorted(h);
      if (n.free === true) {
        if (names.some((k) => h[k] === null || h[k] === undefined)) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'no_free_hand', need: i, detail: {}, fix: names.length ? { step: 'put' } : null, read } };
      }
      if (n.empty === true) {
        const holding = names.filter((k) => h[k] !== null && h[k] !== undefined).length;
        if (!holding) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'hand_not_empty', need: i, detail: { holding }, fix: { step: 'put' }, read } };
      }
      if (typeof n.holds === 'string') {
        const kind = n.holds;
        if (names.some((k) => typeof h[k] === 'string' && nodes[h[k] as string]?.kind === kind)) return { ok: true };
        return { ok: false, no: { verdict: 'no', reason: 'not_holding_kind', need: i, detail: { kind }, fix: names.length ? { step: 'take', kind } : null, read } };
      }
      return { ok: false, no: bad(i, 'malformed_need') };
    },

    held_by_actor(n, i) {
      const thing = n.thing === undefined ? act.this : resolve(n.thing, args);
      if (thing === null) return { ok: false, no: bad(i, 'argument_missing', { arg: (n.thing as { arg: string })?.arg ?? null }) };
      const h = hands();
      if (typeof h === 'string') return { ok: false, no: bad(i, h) };
      if (sorted(h).some((k) => h[k] === thing)) return { ok: true };
      return { ok: false, no: { verdict: 'no', reason: 'not_held', need: i, detail: n.thing === undefined ? {} : { thing }, fix: { step: 'take', thing }, read } };
    },

    // How the thing moves, from its kind's section 18: carried needs that many free hands, pushed needs one Soul.
    moves(n, i) {
      const thing = resolve(n.thing, args);
      if (thing === null) return { ok: false, no: bad(i, 'argument_missing', { arg: (n.thing as { arg: string })?.arg ?? null }) };
      const node = has(nodes, thing) ? nodes[thing] : undefined;
      const kind = node?.kind && has(kinds, node.kind) ? kinds[node.kind] : undefined;
      if (!kind) return { ok: false, no: bad(i, 'no_such_kind', { node: thing }) };
      if (n.by !== 'carry' && n.by !== 'push') return { ok: false, no: bad(i, 'malformed_need') };
      const how = kind.motion?.how;
      read.push([`${node!.kind}/motion`, how ?? null]);
      const no = (reason: string, detail: Record<string, unknown>): Outcome => ({ ok: false, no: { verdict: 'no', reason, need: i, detail: { thing, by: n.by, ...detail }, fix: null, read } });
      if (typeof how !== 'string' || !(has(CARRIED, how) || has(PUSHED, how) || how === 'fixed')) return no('motion_unsaid', {});
      const table = n.by === 'carry' ? CARRIED : PUSHED;
      if (!has(table, how)) return no('moves_by', { how });
      if (n.by === 'push') return PUSHED[how] > 1 ? no('needs_souls', { how, souls: PUSHED[how] }) : { ok: true };
      const h = hands();
      if (typeof h === 'string') return { ok: false, no: bad(i, h) };
      const free = sorted(h).filter((k) => h[k] === null || h[k] === undefined).length;
      if (free >= CARRIED[how]) return { ok: true };
      return { ok: false, no: { verdict: 'no', reason: 'no_free_hand', need: i, detail: { thing, how, hands: CARRIED[how] }, fix: { step: 'put' }, read } };
    },

    linked: (n, i) => link(n, i, true),
    unlinked: (n, i) => link(n, i, false),

    // Every amount the form moves has room where it lands (SA-F2b): a pour never overflows. `enough`: every amount the
    // form asks is there to give, so a pour of three units from a pitcher holding two is refused rather than made smaller.
    room: (_n, i) => moves(i, 'room'),
    enough: (_n, i) => moves(i, 'enough'),

    // The sum of int fields of this kind (a well whose portions are kept in two fields). With `after_moves`, each
    // field as this form's transfers would leave it, measured as the `room` need measures them: a capacity shared
    // by several fields is never overfilled.
    sum(n, i) {
      const fields = Array.isArray(n.fields) ? n.fields : [];
      if (fields.length < 2) return { ok: false, no: bad(i, 'malformed_need') };
      let total = 0;
      for (const field of fields) {
        const def = has(entry.state, field) ? entry.state![field] : undefined;
        if (!def || def.type !== 'int') return { ok: false, no: bad(i, 'no_such_field', { field }) };
        if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, field, read } };
        const value = has(self.fields, field) ? self.fields![field] : def.default;
        if (!whole(value)) return { ok: false, no: bad(i, 'not_whole_number', { field }) };
        read.push([`${act.this}/field/${def.n}`, value]);
        total += value;
      }
      if (n.after_moves === true) {
        for (const e of (form.effects ?? []).filter((x) => x && x.change === 'transfer')) {
          const m = measure(kinds, nodes, act.this, args, e);
          if ('bad' in m) return { ok: false, no: bad(i, m.bad, m.detail) };
          if (m.from === act.this && fields.includes(m.field)) total -= m.moved;
          if (m.into === act.this && fields.includes(m.intoField)) total += m.moved;
        }
      }
      const wanted: Record<string, unknown> = {};
      for (const k of ['at_least', 'at_most']) if (has(n, k)) wanted[k] = (n as Record<string, unknown>)[k];
      if (!Object.keys(wanted).length || !Object.values(wanted).every(whole)) return { ok: false, no: bad(i, 'malformed_need') };
      if ((!has(n, 'at_least') || total >= n.at_least!) && (!has(n, 'at_most') || total <= n.at_most!)) return { ok: true };
      const detail = { fields, found: total, wanted, ...(n.after_moves === true ? { after_moves: true } : {}) };
      return { ok: false, no: { verdict: 'no', reason: 'field_differs', need: i, detail, fix: null, read } };
    },

    // At least one of two or more fields of this kind is not a value (sand not yet smooth everywhere). A refusal lists
    // every field's value; its fix is a form that sets one of them to another value, where the data offers one.
    any(n, i) {
      const fields = Array.isArray(n.fields) ? n.fields : [];
      if (fields.length < 2 || !has(n, 'not')) return { ok: false, no: bad(i, 'malformed_need') };
      const found: unknown[] = [];
      let differs = false;
      for (const field of fields) {
        const def = has(entry.state, field) ? entry.state![field] : undefined;
        if (!def || def.type === 'timed') return { ok: false, no: bad(i, 'no_such_field', { field }) };
        if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, field, read } };
        const value = has(self.fields, field) ? self.fields![field] : def.default;
        read.push([`${act.this}/field/${def.n}`, value]);
        found.push(value);
        if (flag(def, value) !== flag(def, n.not)) differs = true;
      }
      if (differs) return { ok: true };
      const fix = formFix((e) => e.change === 'set' && typeof e.field === 'string' && fields.includes(e.field) && !has(e, 'by') && e.to !== null && typeof e.to !== 'object' && flag(entry.state![e.field], e.to) !== flag(entry.state![e.field], n.not));
      return { ok: false, no: { verdict: 'no', reason: 'field_differs', need: i, detail: { fields, found, wanted: { not: n.not } }, fix, read } };
    },
  };

  // A field of the place this thing stands in, read through its link to the place (from "place", most 1), never from
  // the tree: a parent means lifetime and frame only (Engine v2 T2). The field is the place kind's, read by its number
  // and seen only by that field's audience. Nothing this kind does changes the place, so a refusal names no fix.
  function placeState(n: Need, i: number): Outcome {
    const type = n.link ?? '';
    const ldef = has(entry!.links, type) ? entry!.links![type] : undefined;
    if (!ldef) return { ok: false, no: bad(i, 'no_such_link', { link: type }) };
    if (!sees(ldef.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: act.this, link: type, read } };
    const ends = self!.links?.[type];
    const count = Array.isArray(ends) ? ends.length : 0;
    read.push([`${act.this}/link/${ldef.n}`, count]);
    if (!count) return { ok: false, no: { verdict: 'no', reason: 'not_linked', need: i, detail: { link: type, count }, fix: null, read } };
    return otherField(n, i, String(ends![0]));
  }

  // A field of the thing a `thing` argument names: the dose's mug, the toast's skewer. It is read through that thing's
  // own kind, by its number and only by its audience; a refusal names no fix (this kind's forms do not change it).
  function argState(n: Need, i: number): Outcome {
    const ref = n.of as { arg?: unknown } | undefined;
    if (!ref || typeof ref !== 'object' || typeof ref.arg !== 'string') return { ok: false, no: bad(i, 'malformed_need') };
    if (!has(args, ref.arg)) return { ok: false, no: bad(i, 'argument_missing', { arg: ref.arg }) };
    const id = args[ref.arg];
    if (typeof id !== 'string' || !has(nodes, id)) return { ok: false, no: bad(i, 'no_such_node', { node: typeof id === 'string' ? id : null }) };
    return otherField(n, i, id);
  }

  // The field `n.field` of another node, read through that node's kind and compared as a state need compares.
  function otherField(n: Need, i: number, id: string): Outcome {
    const other = has(nodes, id) ? nodes[id] : undefined;
    const kind = other?.kind && has(kinds, other.kind) ? kinds[other.kind] : undefined;
    const field = typeof n.field === 'string' ? n.field : '';
    const def = kind && has(kind.state, field) ? kind.state![field] : undefined;
    if (!def) return { ok: false, no: bad(i, 'no_such_field', { node: id, field }) };
    if (!sees(def.audience)) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node: id, field, read } };
    let value = has(other!.fields, field) ? other!.fields![field] : def.default;
    if (def.type === 'timed') {
      const now = valueAt(def, value, state.now_us);
      if (typeof now === 'object') return { ok: false, no: bad(i, now.bad, { node: id, field }) };
      value = now;
    }
    read.push([`${id}/field/${def.n}`, value]);
    const wanted: Record<string, unknown> = {};
    for (const k of ['is', 'not', 'at_least', 'at_most']) if (has(n, k)) wanted[k] = (n as Record<string, unknown>)[k];
    const ranged = has(n, 'at_least') || has(n, 'at_most');
    if (ranged && !int(value)) return { ok: false, no: bad(i, 'not_whole_number', { node: id, field }) };
    if ((!has(n, 'is') || flag(def, value) === flag(def, n.is)) &&
      (!has(n, 'not') || flag(def, value) !== flag(def, n.not)) &&
      (!has(n, 'at_least') || (int(value) && value >= (n.at_least as number))) &&
      (!has(n, 'at_most') || (int(value) && value <= (n.at_most as number)))) return { ok: true };
    return { ok: false, no: { verdict: 'no', reason: 'field_differs', need: i, detail: { node: id, field, found: value, wanted }, fix: null, read } };
  }

  function moves(i: number, which: 'room' | 'enough'): Outcome {
    const transfers = (form!.effects ?? []).filter((e) => e && e.change === 'transfer');
    if (!transfers.length) return { ok: false, no: bad(i, 'no_transfer') };
    for (const e of transfers) {
      const m = measure(kinds, nodes, act.this, args, e);
      if ('bad' in m) return { ok: false, no: bad(i, m.bad, m.detail) };
      for (const [node, def] of [[m.from, m.fromDef], [m.into, m.intoDef]] as const) {
        if (!sees(audienceOf(kinds[nodes[node]?.kind ?? ''], m.field, def))) return { ok: 'unknown', unknown: { verdict: 'unknown', need: i, node, field: m.field, read } };
      }
      read.push([`${m.from}/field/${m.fromDef.n}`, m.there]);
      read.push([`${m.into}/field/${m.intoDef.n}`, m.has]);
      if (which === 'room' && m.room !== null && m.moved > m.room) {
        const detail = { node: m.into, field: m.intoField, room: m.room, amount: m.moved };
        return { ok: false, no: { verdict: 'no', reason: 'no_room', need: i, detail, fix: null, read } };
      }
      if (which === 'enough' && m.moved < m.asked) {
        const detail = { node: m.from, field: m.field, has: m.moved, amount: m.asked };
        return { ok: false, no: { verdict: 'no', reason: 'not_enough', need: i, detail, fix: null, read } };
      }
    }
    return { ok: true };
  }

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
    // A need that names its words returns them with its refusal, by key; bad input is the data's fault, not the need's.
    if (out.ok === false) return typeof n.says === 'string' && out.no.verdict === 'no' && out.no.reason !== 'bad_input' ? { ...out.no, says: n.says } : out.no;
    if (out.ok === 'unknown' && !unknown) unknown = out.unknown;
  }
  return unknown ?? { verdict: 'yes', read };
}

// timed:begin. A value that changes with time (SA-F5a, #2845), shared with Engine v2 F5 (#2770).
// It is stored as three whole numbers, `{value, per_s, set_us}`: the value when it was set, its rate per second
// (in the field's unit) and the world time it was set, in microseconds. Nothing is written between events.
// World time is a signed 64-bit count that never stops, so every number may arrive as a safe integer or a big
// integer (as T0's encoding reads one beyond 2^53), is worked as a big integer, and is refused (`beyond_i64`) only
// outside the signed 64-bit range. A result is a number when it is a safe integer, else a big integer.
// Every number here is a big integer; the lint in timed.test.ts refuses any number literal that is not.

export type Int = number | bigint;
export type Timed = { value: Int; per_s: Int; set_us: Int };
type Bounds = { min?: Int; max?: Int };
type Exact = { v0: bigint; rate: bigint; set: bigint; at: bigint; lo: bigint | null; hi: bigint | null };
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

/** A whole number as a big integer; `null` if it is not one; `beyond` if it lies outside the signed 64-bit range. */
function big(v: unknown): bigint | null | 'beyond' {
  const b = typeof v === 'bigint' ? v : whole(v) ? BigInt(v) : null;
  return b === null ? null : b < I64_MIN || b > I64_MAX ? 'beyond' : b;
}

function exact(def: Bounds, stored: unknown, at: unknown): Exact | { bad: string } {
  if (!stored || typeof stored !== 'object') return { bad: 'not_timed' };
  const { value, per_s, set_us } = stored as Partial<Timed>;
  const three = [value, per_s, set_us].map(big);
  if (three.includes(null)) return { bad: 'not_whole_number' };
  const now = big(at);
  if (now === null) return { bad: 'no_time' };
  const bounds = [def.min, def.max].map((b) => (b === undefined ? undefined : big(b)));
  if (bounds.includes(null)) return { bad: 'not_whole_number' };
  if ([...three, now, ...bounds].includes('beyond')) return { bad: 'beyond_i64' };
  const [v0, rate, set] = three as bigint[];
  const [lo, hi] = bounds.map((b) => (b === undefined ? null : (b as bigint)));
  if ((now as bigint) < set) return { bad: 'time_before_set' };
  if (lo !== null && hi !== null && lo > hi) return { bad: 'bounds_crossed' };
  return { v0: clamp(v0, lo, hi), rate, set, at: now as bigint, lo, hi };
}

function clamp(v: bigint, lo: bigint | null, hi: bigint | null): bigint {
  if (lo !== null && v < lo) return lo;
  if (hi !== null && v > hi) return hi;
  return v;
}

/** A result: a number if it is a safe integer, a big integer beyond that, refused outside the signed 64-bit range. */
function out(v: bigint): Int | { bad: string } {
  if (v < I64_MIN || v > I64_MAX) return { bad: 'beyond_i64' };
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function at(x: Exact, t: bigint): bigint {
  return clamp(x.v0 + (x.rate * (t - x.set)) / 1000000n, x.lo, x.hi);
}

/**
 * The value of a timed field at `now_us`: the whole units accrued since it was set (rate x elapsed / 1,000,000,
 * truncated toward zero) added to its value, held within the field's `min` and `max`.
 */
export function valueAt(def: Bounds, stored: unknown, now_us: unknown): Int | { bad: string } {
  const x = exact(def, stored, now_us);
  if ('bad' in x) return x;
  return out(at(x, x.at));
}

/**
 * The first whole microsecond, at or after `from_us`, at which the value is `at_least` (or `at_most`) the level: the
 * time it crosses, rounded up, so a need on the field turns from no to yes at exactly that time. `null` when it never
 * does: the rate is zero or points away, or a bound stops the value short of the level.
 */
export function crossing(def: Bounds, stored: unknown, level: { at_least?: Int; at_most?: Int }, from_us: unknown): Int | null | { bad: string } {
  const x = exact(def, stored, from_us);
  if ('bad' in x) return x;
  const rising = level && has(level, 'at_least') && !has(level, 'at_most');
  const falling = level && has(level, 'at_most') && !has(level, 'at_least');
  const L = big(rising ? level.at_least : falling ? level.at_most : undefined);
  if (L === null) return { bad: 'malformed_level' };
  if (L === 'beyond') return { bad: 'beyond_i64' };
  const now = at(x, x.at);
  if (rising ? now >= L : now <= L) return out(x.at);
  if (rising ? x.rate <= 0n || (x.hi !== null && x.hi < L) : x.rate >= 0n || (x.lo !== null && x.lo > L)) return null;
  const gap = rising ? L - x.v0 : x.v0 - L;
  const speed = rising ? x.rate : -x.rate;
  return out(x.set + (gap * 1000000n + speed - 1n) / speed);
}
// timed:end

const isRef = (v: unknown): v is { arg: string } => v !== null && typeof v === 'object' && has(v, 'arg') && typeof (v as { arg: unknown }).arg === 'string';
/** A value as written, or the value an argument holds. */
function valueOf(v: unknown, args: Record<string, unknown>): unknown {
  return isRef(v) ? args[v.arg] : v;
}

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
  const sees = seesAudience(asker.sees, def.audience);
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
const sameRef = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' ? a === b : !!a && typeof a === 'object' && !!b && typeof b === 'object' && has(a, 'arg') && (a as { arg: unknown }).arg === (b as { arg: unknown }).arg;

/** The node a node stands loose in, through any slot or hand it is in; null if nowhere. Bounded by the number of nodes. */
function placeOf(nodes: Record<string, Node>, id: string): string | null {
  const ids = sorted(nodes);
  const parent = (x: string): { node: string; loose: boolean } | null => {
    for (const holder of ids) {
      const n = nodes[holder];
      if (n.loose?.includes(x)) return { node: holder, loose: true };
      for (const slot of sorted(n.slots)) if (n.slots![slot]?.includes(x)) return { node: holder, loose: false };
      for (const hand of sorted(n.hands)) if (n.hands![hand] === x) return { node: holder, loose: false };
    }
    return null;
  };
  let at = parent(id);
  for (let hops = 0; at && hops < ids.length; hops++) {
    if (at.loose) return at.node;
    at = parent(at.node);
  }
  return null;
}

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
  /** The field it leaves, and the field it lands in: the same but for a transfer between two fields of one thing. */
  field: string;
  intoField: string;
  from: string;
  into: string;
  fromDef: FieldDef;
  intoDef: FieldDef;
  /** What the source has, what the target has, the target's room (null: no capacity) and the amount moved. */
  there: number;
  has: number;
  room: number | null;
  moved: number;
  /** The amount asked, before the source's limit. */
  asked: number;
};

/**
 * The amount a `transfer` effect moves: the least of what it asks (a whole number, an argument, or `"room"`, the
 * target's room up to its field's `max`) and what the source has above its `min`. Both ends are int fields of one name and unit; amounts are whole and
 * never negative. Shared by the `room` need and by effects.ts, so both work out one number.
 */
export function measure(kinds: Record<string, Entry>, nodes: Record<string, Node>, self: string, args: Record<string, unknown>, e: Effect): Measure | { bad: string; detail: Record<string, unknown> } {
  const end = (ref: unknown) => (ref === 'this' ? self : resolve(ref, args));
  const from = end(e.from), into = end(e.into), field = typeof e.field === 'string' ? e.field : '';
  const intoField = typeof e.into_field === 'string' ? e.into_field : field;
  // One node gives and takes only between two of its fields; two nodes move one field.
  if (!from || !into || (from === into) === (intoField === field)) return { bad: 'malformed_transfer', detail: { from, into } };
  const defs: FieldDef[] = [];
  const values: number[] = [];
  for (const [id, name] of [[from, field], [into, intoField]]) {
    const node = has(nodes, id) ? nodes[id] : undefined;
    const entry = node?.kind && has(kinds, node.kind) ? kinds[node.kind] : undefined;
    const def = entry && has(entry.state, name) ? entry.state![name] : undefined;
    if (!node || !def || def.type !== 'int') return { bad: 'no_such_field', detail: { node: id, field: name } };
    const value = has(node.fields, name) ? node.fields![name] : def.default;
    if (!whole(value) || value < 0) return { bad: 'not_whole_number', detail: { node: id, field: name } };
    defs.push(def);
    values.push(value);
  }
  const [fromDef, intoDef] = defs;
  const [there, held] = values;
  if (fromDef.unit !== intoDef.unit) return { bad: 'units_differ', detail: { field } };
  // The target's room is up to its field's `max`; the source gives down to its `min` (0 if none).
  let room: number | null = null;
  if (has(intoDef, 'max')) {
    if (!whole(intoDef.max) || intoDef.max < held) return { bad: 'over_capacity', detail: { node: into, field: intoField } };
    room = intoDef.max - held;
  }
  const floor = has(fromDef, 'min') ? fromDef.min : 0;
  if (!whole(floor) || floor < 0) return { bad: 'not_whole_number', detail: { node: from, field } };
  let want: unknown = e.amount;
  if (e.amount === 'room') {
    if (room === null) return { bad: 'no_capacity', detail: { node: into, field: intoField } };
    want = room;
  } else if (e.amount && typeof e.amount === 'object' && has(e.amount, 'arg')) want = args[(e.amount as { arg: string }).arg];
  if (!whole(want) || want < 0) return { bad: 'not_whole_number', detail: { amount: e.amount ?? null } };
  return { field, intoField, from, into, fromDef, intoDef, there, has: held, room, moved: Math.min(want, Math.max(0, there - floor)), asked: want };
}
