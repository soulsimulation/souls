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

export const NEEDS = Object.freeze(['state', 'slot_free', 'within_reach', 'hand', 'held_by_actor', 'linked', 'unlinked']);
export const REASONS = Object.freeze([
  'field_differs',
  'slot_taken',
  'out_of_reach',
  'no_free_hand',
  'not_holding_kind',
  'not_held',
  'not_linked',
  'already_linked',
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
  effects?: { change: string; field?: string; to?: unknown; link?: string }[];
};
export type Entry = {
  kind: string;
  state?: Record<string, { n: number; default: unknown; audience: string }>;
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
};
export type Input = {
  kinds: Record<string, Entry>;
  act: { this: string; form: string; args?: Record<string, unknown> };
  state: { actor: string; nodes: Record<string, Node>; moves?: Record<string, { reach_mm: number }> };
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
  const formFix = (meets: (e: { change: string; field?: string; to?: unknown; link?: string }) => boolean): Fix | null => {
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
      const value = has(self.fields, field) ? self.fields![field] : def.default;
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

function resolve(ref: unknown, args: Record<string, unknown>): string | null {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && has(ref, 'arg')) {
    const v = args[(ref as { arg: string }).arg];
    return typeof v === 'string' ? v : null;
  }
  return null;
}
