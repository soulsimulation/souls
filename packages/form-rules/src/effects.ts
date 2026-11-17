// What a form does, as generic changes plus named events (Soul Actions SA-F2b, #2844).
//
// `effects` takes a form that the rules (rules.ts) allow and the state, and returns what it does in the
// two layers of Engine v2's contract T6: generic changes any viewer can apply (set a field, link, unlink,
// reparent, create, remove) and, for each effect the entry declares, its named event and the changes it
// made. `apply` applies such a result to plain state: all of it or none, and once per receipt.
//
// - An amount moved between two things is two `set` changes on one field, each carrying its signed `by`
//   beside the value after; the `by`s of one event sum to zero, and `apply` refuses them if they do not.
// - Holding is a parent: take and put are `reparent` into or out of a hand or a slot.
// - A made thing appears where its form names: a slot, the actor's hand, or `here`, loose in the actor's
//   place (the spot is Engine v2's set-down, E4, and is not chosen here). Its id comes from the receipt.
// - Effects are worked out in order on a copy, so a later effect sees an earlier one, and a form whose
//   changes would not all apply is refused with the effect that failed.
// - A timer is not a change to state: it is returned beside the changes, with its event. A timer is named by the
//   form it starts; starting one replaces the node's pending timer of that form, which it names in `replaces`, so the
//   engine clears it (Engine v2 T6 rule 15: a clear is "fired or cancelled"). A lamp put out early and lit again is
//   not put out by the earlier timer.
// - Every value is one Engine v2's encoding profile holds (T0, v2/docs/encoding.md): whole numbers and names,
//   never a float, a boolean or null. A flag is 0 or 1, text is a key by reference `{text: <key>}` (never
//   words), and a value that is missing is left out: a `set` without `to` clears the field to its default.
// - An event's name is `namespace:name`, the declaring kind's namespace before the name its entry writes.
// No float decides anything; nothing here imports more than the rules.

import { decide, measure, valueAt, type Entry, type Input, type Node, type Verdict } from './rules.ts';

export type Place = { node: string; slot: string } | { node: string; hand: string } | { node: string };
export type Change =
  | { change: 'set'; node: string; field: string; n: number; to?: unknown; by?: number }
  | { change: 'link' | 'unlink'; node: string; link: string; n: number; end: string }
  | { change: 'reparent'; node: string; to: Place }
  | { change: 'create'; node: string; kind: string; to: Place }
  | { change: 'remove'; node: string };
/** The generic changes, Engine v2 T6's list less the motion sample. */
export const CHANGES = Object.freeze(['set', 'link', 'unlink', 'reparent', 'create', 'remove']);
export type Event = { event: string; node: string; changes: number[] };
/** `replaces`: the ids of this node's pending timers of the same form, cleared by this one (present only when there are any). */
export type Timer = { node: string; form: string; after_us: number; event: number; replaces?: string[] };
export type Done = { verdict: 'yes'; receipt: string; actor: string; changes: Change[]; events: Event[]; timers: Timer[] };
/** Refused while working out the effects: `effect` is the index of the effect that could not be done. */
export type Refused = { verdict: 'no'; reason: string; effect: number; detail: Record<string, unknown> };
export type State = Input['state'] & { applied?: string[] };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const sorted = (o: object | undefined): string[] => (o ? Object.keys(o).sort() : []);
const arg = (v: unknown, args: Record<string, unknown>) => (v && typeof v === 'object' && has(v, 'arg') ? args[(v as { arg: string }).arg] : v);

/** A field's value as it is stored: a flag 0 or 1, text a key by reference, and nothing (undefined) for a missing value. */
function stored(def: { type?: string }, v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (def.type === 'bool' && typeof v === 'boolean') return Number(v);
  if (def.type === 'text' && typeof v === 'string') return { text: v };
  return v;
}

const NAME = /^[A-Za-z0-9_\-.:/@]*$/;
const MAX_DEPTH = 32;
/**
 * Where a value leaves Engine v2's encoding profile (T0, v2/docs/encoding.md), with the profile's name for the
 * refusal, or null when it is inside: `null`, `simple` (a boolean or undefined), `float`, `text-not-name` (a
 * string or a key outside the name characters), `too-deep`; and two a JavaScript number adds, `unsafe-integer`
 * (a whole number beyond 2^53, which only a BigInt holds) and `int-out-of-range`. Records here are keyed by
 * names; an adapter numbers them.
 */
export function outsideProfile(v: unknown, at = '', depth = 0): { at: string; refused: string } | null {
  const no = (refused: string) => ({ at, refused });
  if (v === null) return no('null');
  if (v === undefined || typeof v === 'boolean') return no('simple');
  if (typeof v === 'number') return !Number.isInteger(v) ? no('float') : Number.isSafeInteger(v) ? null : no('unsafe-integer');
  if (typeof v === 'bigint') return v >= -(2n ** 64n) && v < 2n ** 64n ? null : no('int-out-of-range');
  if (typeof v === 'string') return NAME.test(v) ? null : no('text-not-name');
  if (typeof v !== 'object') return no('not-a-value');
  if (depth >= MAX_DEPTH) return no('too-deep');
  for (const [k, item] of Object.entries(v)) {
    if (!Array.isArray(v) && !NAME.test(k)) return { at: `${at}/${k}`, refused: 'text-not-name' };
    const out = outsideProfile(item, `${at}/${k}`, depth + 1);
    if (out) return out;
  }
  return null;
}

/** What `input.act` does, or why it is not done. The rules are asked as the world (every field seen). */
export function effects(input: Omit<Input, 'asker'> & { receipt: string }): Done | Refused | Verdict {
  const refuse = (effect: number, reason: string, detail: Record<string, unknown> = {}): Refused => ({ verdict: 'no', reason, effect, detail });
  if (!input || typeof input.receipt !== 'string' || !input.receipt) return refuse(-1, 'bad_input', { what: 'no_receipt' });
  const verdict = decide({ ...input, asker: { sees: 'all' } });
  if (verdict.verdict !== 'yes') return verdict;
  const { kinds, act, state, receipt } = input;
  const self = act.this, actor = state.actor, args = act.args ?? {};
  const entry = kinds[state.nodes[self].kind!];
  const namespace = entry.kind.slice(0, entry.kind.indexOf(':') + 1);
  const work: Record<string, Node> = structuredClone(state.nodes);
  const done: Done = { verdict: 'yes', receipt, actor, changes: [], events: [], timers: [] };
  let made = 0;

  const freeHand = (): Place | null => {
    const hands = work[actor].hands ?? {};
    const name = sorted(hands).find((k) => hands[k] === null || hands[k] === undefined);
    return name === undefined ? null : { node: actor, hand: name };
  };
  const slotPlace = (ref: unknown): Place | string => {
    const v = arg(ref, args);
    const at = typeof v === 'string' ? { node: self, slot: v } : (v as { node?: unknown; slot?: unknown } | null);
    if (!at || typeof at.node !== 'string' || typeof at.slot !== 'string') return 'malformed_slot';
    const holder = has(work, at.node) ? work[at.node] : undefined;
    const def = holder?.kind && has(kinds, holder.kind) ? kinds[holder.kind].slots?.[at.slot] : undefined;
    if (!def) return 'no_such_slot';
    return (holder!.slots?.[at.slot]?.length ?? 0) < def.most ? { node: at.node, slot: at.slot } : 'slot_taken';
  };
  const place = (into: unknown): Place | string => {
    if (into === 'actor_hand') return freeHand() ?? 'no_free_hand';
    if (into === 'here') {
      const where = here(work, actor);
      return where === null ? 'nowhere' : { node: where };
    }
    return slotPlace(into);
  };
  const subject = (what: unknown) => (what === 'actor' ? actor : what === 'this' ? self : null);

  const effectList = entry.forms![act.form].effects ?? [];
  for (let i = 0; i < effectList.length; i++) {
    const e = effectList[i];
    const out: Change[] = [];
    if (!e || typeof e.event !== 'string') return refuse(i, 'bad_input', { what: 'no_event' });
    if (e.change === 'set') {
      const def = has(entry.state, e.field ?? '') ? entry.state![e.field!] : undefined;
      if (!def) return refuse(i, 'bad_input', { what: 'no_such_field', field: e.field ?? null });
      if (def.type === 'timed') {
        // a timed value is settled at the act's time and given its new rate: the three stored numbers are rewritten
        const held = has(work[self].fields, e.field!) ? work[self].fields![e.field!] : def.default;
        const now = valueAt(def, held, state.now_us);
        if (typeof now === 'object' || !Number.isSafeInteger(e.rate)) return refuse(i, 'bad_input', { what: typeof now === 'object' ? now.bad : 'malformed_rate', field: e.field! });
        out.push({ change: 'set', node: self, field: e.field!, n: def.n, to: { value: now, per_s: e.rate!, set_us: state.now_us! } });
      } else if (has(e, 'by')) {
        // a count or an amount used up (a sip): the field's value plus `by`, within its bounds; nothing balances it
        const held = has(work[self].fields, e.field!) ? work[self].fields![e.field!] : def.default;
        const to = Number.isSafeInteger(held) && Number.isSafeInteger(e.by) ? (held as number) + e.by! : null;
        if (to === null || to < (def.min ?? 0) || (def.max !== undefined && to > def.max)) return refuse(i, 'bad_input', { what: 'out_of_range', field: e.field! });
        out.push({ change: 'set', node: self, field: e.field!, n: def.n, to });
      } else {
      const to = stored(def, arg(e.to, args));
      out.push({ change: 'set', node: self, field: e.field!, n: def.n, ...(to === undefined ? {} : { to }) });
      }
    } else if (e.change === 'transfer') {
      const m = measure(kinds, work, self, args, e);
      if ('bad' in m) return refuse(i, 'bad_input', { what: m.bad, ...m.detail });
      if (m.room !== null && m.moved > m.room) return refuse(i, 'no_room', { node: m.into, field: m.field, room: m.room, amount: m.moved });
      out.push({ change: 'set', node: m.from, field: m.field, n: m.fromDef.n, to: m.there - m.moved, by: -m.moved });
      out.push({ change: 'set', node: m.into, field: m.field, n: m.intoDef.n, to: m.has + m.moved, by: m.moved });
    } else if (e.change === 'link' || e.change === 'unlink') {
      const def = has(entry.links, e.link ?? '') ? entry.links![e.link!] : undefined;
      if (!def) return refuse(i, 'bad_input', { what: 'no_such_link', link: e.link ?? null });
      const ends = work[self].links?.[e.link!] ?? [];
      if (e.change === 'link' && ends.includes(actor)) return refuse(i, 'already_linked', { link: e.link });
      if (e.change === 'link' && ends.length >= def.most) return refuse(i, 'link_full', { link: e.link, most: def.most });
      if (e.change === 'unlink' && !ends.includes(actor)) return refuse(i, 'not_linked', { link: e.link });
      out.push({ change: e.change, node: self, link: e.link!, n: def.n, end: actor });
    } else if (e.change === 'reparent' || e.change === 'create') {
      const to = place(e.into);
      if (typeof to === 'string') return refuse(i, to === 'no_free_hand' || to === 'slot_taken' ? to : 'bad_input', { what: to });
      if (e.change === 'create') {
        if (typeof e.kind !== 'string' || !has(kinds, e.kind)) return refuse(i, 'bad_input', { what: 'no_such_kind', kind: e.kind ?? null });
        out.push({ change: 'create', node: `${receipt}.${made++}`, kind: e.kind, to });
      } else {
        const node = subject(e.what);
        if (!node) return refuse(i, 'bad_input', { what: 'malformed_subject' });
        out.push({ change: 'reparent', node, to });
      }
    } else if (e.change === 'remove') {
      const node = subject(e.what);
      if (!node) return refuse(i, 'bad_input', { what: 'malformed_subject' });
      out.push({ change: 'remove', node });
    } else if (e.change === 'timer') {
      if (typeof e.form !== 'string' || !Number.isSafeInteger(e.after_us) || e.after_us! <= 0) return refuse(i, 'bad_input', { what: 'malformed_timer' });
      const pending = (Array.isArray(work[self].timers) ? work[self].timers! : []).filter((t) => t && t.form === e.form).map((t) => t.id);
      done.timers.push({ node: self, form: e.form, after_us: e.after_us!, event: done.events.length, ...(pending.length ? { replaces: pending } : {}) });
    } else return refuse(i, 'bad_input', { what: 'unknown_change', change: e.change ?? null });

    const event: Event = { event: e.event.includes(':') ? e.event : namespace + e.event, node: self, changes: [] };
    const outside = outsideProfile({ out, event, timers: done.timers });
    if (outside) return refuse(i, 'bad_input', { what: 'outside_profile', ...outside });
    for (const c of out) {
      const failed = applyChange(work, c);
      if (failed) return refuse(i, 'bad_input', { what: failed });
      event.changes.push(done.changes.length);
      done.changes.push(c);
    }
    done.events.push(event);
  }
  return done;
}

/**
 * Apply a result of `effects` to plain state: every change or none, and once per receipt. A refusal changes
 * nothing; a receipt already applied changes nothing (`again: true`). Needs no kinds.
 */
export function apply(
  state: State,
  result: Done | Refused | Verdict,
): { ok: true; state: State; again: boolean } | { ok: false; reason: string; change?: number; event?: number; at?: string } {
  if (result.verdict !== 'yes' || !('changes' in result)) return { ok: true, state, again: false };
  const applied = state.applied ?? [];
  if (applied.includes(result.receipt)) return { ok: true, state, again: true };
  const changes = Array.isArray(result.changes) ? result.changes : [];
  // Only values inside Engine v2's encoding profile are accepted, named by the profile's refusal.
  for (const [list, key] of [[changes, 'change'], [result.events ?? [], 'event']] as const) {
    for (let k = 0; k < list.length; k++) {
      const outside = outsideProfile(list[k]);
      if (outside) return { ok: false, reason: outside.refused, [key]: k, at: outside.at };
    }
  }
  for (const event of result.events ?? []) {
    let sum = 0n;
    for (const k of event.changes) {
      const by = (changes[k] as { by?: unknown } | undefined)?.by;
      if (by === undefined) continue;
      if (!Number.isSafeInteger(by)) return { ok: false, reason: 'not_whole_number', change: k };
      sum += BigInt(by as number);
    }
    if (sum !== 0n) return { ok: false, reason: 'amounts_do_not_balance', change: event.changes[0] };
  }
  const nodes: Record<string, Node> = structuredClone(state.nodes);
  for (let k = 0; k < changes.length; k++) {
    const failed = applyChange(nodes, changes[k]);
    if (failed) return { ok: false, reason: failed, change: k };
  }
  return { ok: true, state: { ...state, nodes, applied: [...applied, result.receipt] }, again: false };
}

/** Where a node is: in a slot, in a hand, or loose in another node; null if nowhere. */
export function parentOf(nodes: Record<string, Node>, id: string): Place | null {
  for (const holder of sorted(nodes)) {
    const n = nodes[holder];
    if (n.loose?.includes(id)) return { node: holder };
    for (const slot of sorted(n.slots)) if (n.slots![slot]?.includes(id)) return { node: holder, slot };
    for (const hand of sorted(n.hands)) if (n.hands![hand] === id) return { node: holder, hand };
  }
  return null;
}

/** The node the actor is loose in, through any seat or hand it is in: where a thing made "here" appears. */
function here(nodes: Record<string, Node>, actor: string): string | null {
  let at = parentOf(nodes, actor);
  for (let hops = 0; at && hops < Object.keys(nodes).length; hops++) {
    if (!has(at, 'slot') && !has(at, 'hand')) return at.node;
    at = parentOf(nodes, at.node);
  }
  return null;
}

function contents(n: Node): string[] {
  const out = [...(n.loose ?? [])];
  for (const slot of sorted(n.slots)) out.push(...((n.slots![slot] ?? []) as string[]));
  for (const hand of sorted(n.hands)) if (typeof n.hands![hand] === 'string') out.push(n.hands![hand] as string);
  return out;
}

function detach(nodes: Record<string, Node>, id: string): void {
  const at = parentOf(nodes, id);
  if (!at) return;
  const holder = nodes[at.node];
  if (has(at, 'slot')) {
    const slot = (at as { slot: string }).slot;
    holder.slots![slot] = holder.slots![slot].filter((x) => x !== id);
  } else if (has(at, 'hand')) holder.hands![(at as { hand: string }).hand] = null;
  else holder.loose = holder.loose!.filter((x) => x !== id);
}

function attach(nodes: Record<string, Node>, to: Place, id: string): string | null {
  const holder = to && has(nodes, to.node) ? nodes[to.node] : undefined;
  if (!holder) return 'no_such_node';
  // A node never goes inside itself.
  for (let at: Place | null = to, hops = 0; at && hops <= Object.keys(nodes).length; at = parentOf(nodes, at.node), hops++) {
    if (at.node === id) return 'inside_itself';
  }
  if (has(to, 'slot')) {
    const slot = (to as { slot: string }).slot;
    holder.slots = { ...holder.slots, [slot]: [...(holder.slots?.[slot] ?? []), id] };
  } else if (has(to, 'hand')) {
    const hand = (to as { hand: string }).hand;
    if (!has(holder.hands, hand)) return 'no_such_hand';
    if (holder.hands![hand] !== null && holder.hands![hand] !== undefined) return 'hand_taken';
    holder.hands![hand] = id;
  } else holder.loose = [...(holder.loose ?? []), id];
  return null;
}

/** Apply one generic change in place; returns why it cannot apply, or null. Callers work on a copy and drop it on failure. */
function applyChange(nodes: Record<string, Node>, c: Change): string | null {
  if (!c || typeof c.node !== 'string') return 'malformed_change';
  const node = has(nodes, c.node) ? nodes[c.node] : undefined;
  switch (c.change) {
    case 'set':
      if (!node) return 'no_such_node';
      if (c.by !== undefined && !(Number.isSafeInteger(c.to) && (c.to as number) >= 0)) return 'not_whole_number';
      node.fields = { ...node.fields, [c.field]: c.to };
      // A set without a value clears the field: it reads as its default again.
      if (!has(c, 'to')) delete node.fields[c.field];
      return null;
    case 'link':
    case 'unlink': {
      if (!node) return 'no_such_node';
      const ends = node.links?.[c.link] ?? [];
      if (c.change === 'link' && ends.includes(c.end)) return 'already_linked';
      if (c.change === 'unlink' && !ends.includes(c.end)) return 'not_linked';
      node.links = { ...node.links, [c.link]: c.change === 'link' ? [...ends, c.end] : ends.filter((x) => x !== c.end) };
      return null;
    }
    case 'reparent':
      if (!node) return 'no_such_node';
      if (!parentOf(nodes, c.node)) return 'not_contained';
      detach(nodes, c.node);
      return attach(nodes, c.to, c.node);
    case 'create':
      if (node) return 'node_exists';
      if (typeof c.kind !== 'string') return 'malformed_change';
      nodes[c.node] = { kind: c.kind };
      return attach(nodes, c.to, c.node);
    case 'remove': {
      if (!node) return 'no_such_node';
      detach(nodes, c.node);
      // Removing a node removes what it holds (T2: a parent is lifetime).
      const gone = new Set([c.node]);
      for (const id of gone) if (nodes[id]) for (const child of contents(nodes[id])) gone.add(child);
      for (const id of gone) delete nodes[id];
      return null;
    }
    default:
      return 'unknown_change';
  }
}
