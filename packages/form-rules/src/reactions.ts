// Things react: a rule on a kind, written as data (Soul Actions SA-F15, #2853).
//
// A kind may carry `reactions`, each `{when, do}`: one trigger and the effects it applies, taken from the two closed
// lists in reactions.json, the one file shared with Engine v2 E18 (#2788). Two functions:
// - `react` works out what one cause (a generic change, or a timer coming due) makes the rules do: the rules it starts
//   and their changes and named events, in the shape `effects` returns, so `apply` applies them. It answers one cause;
//   running a chain of rules (its depth, a fan-out spread over ticks) is the engine's.
// - `checkReactions` is the check gate's: it refuses a rule outside the lists, a rule that names a body, an offer or a
//   draw, and a set of rules that could feed itself, naming the cycle, on the graph of kind, field and link type.
// A rule never chooses and never draws. Only "set": setting a field to its own value is no change and starts nothing.
// No float decides anything; nothing here imports more than the rules and the lists.

import LISTS from './reactions.json' with { type: 'json' };
import { parentOf, type Change, type Done, type Event } from './effects.ts';
import { valueAt, type Entry, type Node } from './rules.ts';

export const TRIGGERS = Object.freeze(Object.keys(LISTS.triggers));
export const REACTION_EFFECTS = Object.freeze(Object.keys(LISTS.effects));

export type Trigger = { on: string; field?: string; link?: string; timer?: string; is?: unknown; not?: unknown };
export type ReactionEffect = { change: string; field: string; to?: unknown; by?: number; per_s?: number; target?: 'this' | { link: string }; event?: string };
export type Reaction = { when: Trigger; do: ReactionEffect[] };
export type Kinds = Record<string, Entry & { owner?: string; reactions?: Record<string, Reaction> }>;
/** What happened: a generic `set` or `reparent` change, or a timer of `node` coming due. */
export type Cause = Change | { due: string; node: string };
export type ReactState = { nodes: Record<string, Node>; now_us?: number; world?: string };
export type Reacted = Done & { fired: [string, string][] };
export type ReactRefused = { verdict: 'no'; reason: 'bad_input'; detail: Record<string, unknown> };

const has = (o: unknown, k: string): boolean => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const sorted = (o: object | undefined): string[] => (o ? Object.keys(o).sort() : []);
const whole = (v: unknown): v is number => Number.isSafeInteger(v);
const scalar = (v: unknown) => v === null || typeof v === 'boolean' || typeof v === 'string' || whole(v);
const triggerDef = (on: string) => (LISTS.triggers as Record<string, { takes: string[]; carries_value: boolean; fields?: string[] }>)[on];
// A timed value's numbers may be big integers (SA-F5a): compared by value, a safe one equal to its number.
const plain = (_k: string, x: unknown) => (typeof x === 'bigint' ? (x >= BigInt(Number.MIN_SAFE_INTEGER) && x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : { big: String(x) }) : x);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a, plain) === JSON.stringify(b, plain);
const isTriggerValue = (v: unknown) => !!v && typeof v === 'object' && sameValue(v, LISTS.trigger_value);

/** What one cause makes the rules do. The state is as it was before the cause. Never throws: bad data is `bad_input`. */
export function react(input: { kinds: Kinds; state: ReactState; cause: Cause; receipt: string }): Reacted | ReactRefused {
  const bad = (what: string, extra: Record<string, unknown> = {}): ReactRefused => ({ verdict: 'no', reason: 'bad_input', detail: { what, ...extra } });
  if (!input || !input.kinds || !input.state || !input.cause || typeof input.receipt !== 'string') return bad('malformed');
  const { kinds, state, cause, receipt } = input;
  const nodes = state.nodes ?? {};
  const kindOf = (id: string) => (has(nodes, id) && nodes[id].kind && has(kinds, nodes[id].kind!) ? kinds[nodes[id].kind!] : undefined);
  const value = (id: string | undefined, field: string): unknown => {
    if (id === undefined || !has(nodes, id)) return undefined;
    const def = kindOf(id)?.state?.[field];
    if (!def) return undefined;
    return has(nodes[id].fields, field) ? nodes[id].fields![field] : def.default;
  };
  const rules = (id: string, on: string): [string, Reaction][] =>
    sorted(kindOf(id)?.reactions)
      .map((name) => [name, kindOf(id)!.reactions![name]] as [string, Reaction])
      .filter(([, r]) => r && r.when && r.when.on === on);
  // What rests on a node: in its slots or loose in it (a hand holds; it is not a support).
  const resting = (id: string): string[] => {
    const n = has(nodes, id) ? nodes[id] : undefined;
    if (!n) return [];
    const out = [...(n.loose ?? [])];
    for (const slot of sorted(n.slots)) out.push(...((n.slots![slot] ?? []) as string[]));
    return out.sort();
  };
  const isBody = (id: string) => kindOf(id)?.owner === 'family';

  const fires: { node: string; rule: string; r: Reaction; value?: unknown }[] = [];
  const fire = (node: string, on: string, match: (t: Trigger) => boolean, carried?: { value: unknown }) => {
    for (const [rule, r] of rules(node, on)) {
      if (!match(r.when)) continue;
      if (carried && has(r.when, 'is') && !sameValue(carried.value, r.when.is)) continue;
      if (carried && has(r.when, 'not') && sameValue(carried.value, r.when.not)) continue;
      fires.push({ node, rule, r, ...(carried ? { value: carried.value } : {}) });
    }
  };

  if (has(cause, 'due')) {
    const c = cause as { due: unknown; node: unknown };
    if (typeof c.due !== 'string' || typeof c.node !== 'string' || !has(nodes, c.node)) return bad('malformed_cause');
    fire(c.node, 'due', (t) => t.timer === c.due);
  } else if ((cause as Change).change === 'set') {
    const c = cause as Extract<Change, { change: 'set' }>;
    if (typeof c.node !== 'string' || !has(nodes, c.node) || typeof c.field !== 'string') return bad('malformed_cause');
    // Setting a field to its own value is no change, and starts nothing.
    if (!sameValue(value(c.node, c.field), c.to)) {
      const carried = { value: c.to };
      fire(c.node, 'changed', (t) => t.field === c.field, carried);
      for (const id of sorted(nodes)) {
        // A link is indexed from both ends (T2): either end may list the other.
        const linked = (link: string) => (nodes[id].links?.[link] ?? []).includes(c.node) || (nodes[c.node].links?.[link] ?? []).includes(id);
        if (id !== c.node) fire(id, 'linked_changed', (t) => t.field === c.field && typeof t.link === 'string' && linked(t.link), carried);
      }
      for (const id of resting(c.node)) fire(id, 'support_changed', (t) => t.field === c.field, carried);
      if (state.world !== undefined && c.node === state.world) for (const id of sorted(nodes)) fire(id, 'world', (t) => t.field === c.field, carried);
    }
  } else if ((cause as Change).change === 'reparent') {
    const c = cause as Extract<Change, { change: 'reparent' }>;
    if (typeof c.node !== 'string' || !has(nodes, c.node) || !c.to || typeof c.to.node !== 'string' || !has(nodes, c.to.node)) return bad('malformed_cause');
    const from = parentOf(nodes, c.node)?.node;
    const to = c.to.node;
    if (from !== to) {
      if (from !== undefined) fire(from, 'left', () => true);
      fire(to, 'rested', () => true);
      if (isBody(c.node)) {
        if (from !== undefined) for (const id of resting(from)) if (id !== c.node) fire(id, 'body_left', () => true);
        for (const id of resting(to)) fire(id, 'body_entered', () => true);
      }
      // Its support changed: each support rule sees the new support's field, when it differs from the old one's.
      for (const [rule, r] of rules(c.node, 'support_changed')) {
        const field = r.when.field ?? '';
        const before = value(from, field), after = value(to, field);
        if (sameValue(before, after)) continue;
        if (has(r.when, 'is') && !sameValue(after, r.when.is)) continue;
        if (has(r.when, 'not') && sameValue(after, r.when.not)) continue;
        fires.push({ node: c.node, rule, r, value: after });
      }
    }
  } else return bad('unknown_cause');

  // Work the rules out in order on a copy of the fields, so a later effect sees an earlier one.
  const work: Record<string, Record<string, unknown>> = {};
  const now = (id: string, field: string) => (has(work[id], field) ? work[id][field] : value(id, field));
  const done: Reacted = { verdict: 'yes', receipt, actor: 'world', changes: [], events: [], timers: [], fired: [] };
  for (const f of fires) {
    done.fired.push([f.node, f.rule]);
    const list = Array.isArray(f.r.do) ? f.r.do : [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const targets = !e || e.target === undefined || e.target === 'this' ? [f.node] : has(e.target, 'link') ? ((nodes[f.node].links?.[(e.target as { link: string }).link] ?? []) as string[]) : null;
      if (!targets) return bad('malformed_target', { node: f.node, rule: f.rule, effect: i });
      for (const t of targets) {
        const def = kindOf(t)?.state?.[e.field];
        if (!def) return bad('no_such_field', { node: t, field: e.field ?? null, rule: f.rule, effect: i });
        const old = now(t, e.field);
        let to: unknown;
        if (e.change === 'set') to = isTriggerValue(e.to) ? f.value : e.to;
        else if (e.change === 'add') {
          if (!whole(old) || !whole(e.by)) return bad('not_whole_number', { node: t, field: e.field });
          let v = old + e.by;
          if (whole(def.min) && v < def.min) v = def.min;
          if (whole(def.max) && v > def.max) v = def.max;
          to = v;
        } else if (e.change === 'rate') {
          const stored = old as { per_s?: unknown };
          if (!whole(e.per_s) || !stored || typeof stored !== 'object') return bad('not_timed', { node: t, field: e.field });
          if (sameValue(stored.per_s, e.per_s)) continue;
          const settled = valueAt(def, stored, state.now_us);
          // SA-F5a's contract: a whole number (a number when safe, else a big integer), or a refusal `{bad}`.
          if (typeof settled === 'object') return bad(settled.bad, { node: t, field: e.field });
          to = { value: settled, per_s: e.per_s, set_us: state.now_us };
        } else return bad('unknown_effect', { change: e.change ?? null, rule: f.rule });
        if (sameValue(old, to)) continue;
        (work[t] ??= {})[e.field] = to;
        const event: Event = { event: e.event ?? f.rule, node: t, changes: [done.changes.length] };
        done.changes.push({ change: 'set', node: t, field: e.field, n: def.n, to });
        done.events.push(event);
      }
    }
  }
  return done;
}

export type CheckError = { kind: string; rule?: string; path: string; reason: string; [key: string]: unknown };

/**
 * The check gate's rule check, over every kind loaded together, in load order (the order of `kinds`' keys). Refuses a
 * rule outside the closed lists, a rule that names a body, an offer or a draw, and a set of rules that could feed
 * itself: on the graph whose nodes are (kind, field) and whose edges run from what a rule watches to what it writes,
 * across a link type to every kind that declares it, any cycle is refused, naming its fields and rules. The kind
 * refused is the one loaded last among the cycle's rules. An empty list means every rule is accepted.
 */
export function checkReactions(kinds: Kinds): CheckError[] {
  const errors: CheckError[] = [];
  const order = Object.keys(kinds);
  const fieldsOf = (k: string) => kinds[k]?.state ?? {};
  const declaring = (link: string) => order.filter((k) => has(kinds[k].links, link));
  const edges: { from: string; to: string; rule: string; kind: string }[] = [];
  const refused = LISTS.refused as Record<string, string[]>;
  const named = (word: unknown) => (typeof word === 'string' ? Object.keys(refused).find((reason) => refused[reason].includes(word)) : undefined);

  for (const kind of order) {
    const reactions = kinds[kind].reactions;
    if (reactions === undefined) continue;
    if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) {
      errors.push({ kind, path: 'reactions', reason: 'not_an_object' });
      continue;
    }
    for (const rule of Object.keys(reactions)) {
      const r = reactions[rule] as unknown as Record<string, unknown>;
      const err = (path: string, reason: string, extra: Record<string, unknown> = {}) => errors.push({ kind, rule, path: `reactions.${rule}${path}`, reason, ...extra });
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        err('', 'not_an_object');
        continue;
      }
      // A body, an offer or a draw named anywhere in the rule, as a key or as what it starts, does or acts on.
      let namedOne = false;
      const scan = (v: unknown, path: string) => {
        if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${path}[${i}]`));
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
          const reason = named(k) ?? (['on', 'change', 'target'].includes(k) ? named(x) : undefined);
          if (reason) {
            err(`${path}.${k}`, reason, { names: named(k) ? k : x });
            namedOne = true;
          }
          scan(x, `${path}.${k}`);
        }
      };
      scan(r, '');
      if (namedOne) continue;
      for (const k of Object.keys(r)) if (k !== 'when' && k !== 'do') err(`.${k}`, 'unknown_key');
      const when = r.when as Trigger | undefined;
      const def = when && typeof when === 'object' && typeof when.on === 'string' ? triggerDef(when.on) : undefined;
      if (!def) {
        err('.when.on', 'unknown_trigger', { on: (when as Trigger | undefined)?.on ?? null });
        continue;
      }
      const allowed = ['on', ...def.takes, ...(def.carries_value ? LISTS.filters : [])];
      for (const k of Object.keys(when!)) if (!allowed.includes(k)) err(`.when.${k}`, 'unknown_key');
      for (const k of def.takes) if (typeof (when as Record<string, unknown>)[k] !== 'string') err(`.when.${k}`, 'missing');
      for (const k of LISTS.filters) if (has(when, k) && !scalar((when as Record<string, unknown>)[k])) err(`.when.${k}`, 'not_a_constant');
      if (def.fields && !def.fields.includes(when!.field!)) err('.when.field', 'not_announced', { field: when!.field ?? null });
      if (when!.on === 'changed' && !has(fieldsOf(kind), when!.field!)) err('.when.field', 'no_such_field');
      if (when!.on === 'linked_changed' && !has(kinds[kind].links, when!.link!)) err('.when.link', 'no_such_link');

      // What it watches, as (kind, field) graph nodes.
      const watched: string[] = [];
      const node = (k: string, f: string) => `${k}#${f}`;
      if (when!.on === 'changed') watched.push(node(kind, when!.field!));
      if (when!.on === 'linked_changed') for (const k of declaring(when!.link!)) if (has(fieldsOf(k), when!.field!)) watched.push(node(k, when!.field!));
      if (when!.on === 'support_changed') for (const k of order) if (has(fieldsOf(k), when!.field!)) watched.push(node(k, when!.field!));

      const effects = r.do;
      if (!Array.isArray(effects) || effects.length === 0) {
        err('.do', 'no_effects');
        continue;
      }
      effects.forEach((e: ReactionEffect, i: number) => {
        const p = `.do[${i}]`;
        const eff = e && typeof e === 'object' ? (LISTS.effects as Record<string, { takes: string[]; types: string[] }>)[e.change] : undefined;
        if (!eff) return err(`${p}.change`, 'unknown_effect', { change: e?.change ?? null });
        for (const k of Object.keys(e)) if (!['change', 'target', 'event', ...eff.takes].includes(k)) err(`${p}.${k}`, 'unknown_key');
        if (typeof e.event !== 'undefined' && (typeof e.event !== 'string' || !/^[a-z][a-z0-9_]*$/.test(e.event))) err(`${p}.event`, 'not_a_name');
        let targetKinds: string[];
        if (e.target === undefined || e.target === 'this') targetKinds = [kind];
        else if (e.target && typeof e.target === 'object' && Object.keys(e.target).length === 1 && typeof e.target.link === 'string') {
          const link = kinds[kind].links?.[e.target.link] as { from?: string } | undefined;
          if (!link) return err(`${p}.target.link`, 'no_such_link');
          if (link.from === 'body' || link.from === 'soul') return err(`${p}.target.link`, 'acts_on_body', { names: e.target.link });
          targetKinds = declaring(e.target.link).filter((k) => has(fieldsOf(k), e.field));
        } else return err(`${p}.target`, 'unknown_target');
        if (targetKinds.length === 0) return err(`${p}.field`, 'no_such_field', { field: e.field ?? null });
        for (const k of targetKinds) {
          const t = fieldsOf(k)[e.field]?.type ?? '';
          if (!eff.types.includes(t)) err(`${p}.field`, 'wrong_type', { of: k, type: t });
        }
        if (e.change === 'set') {
          if (isTriggerValue(e.to)) {
            if (!def.carries_value) err(`${p}.to`, 'trigger_has_no_value');
          } else if (!scalar(e.to)) err(`${p}.to`, 'not_a_constant');
        }
        if (e.change === 'add' && !(whole(e.by) && e.by !== 0)) err(`${p}.by`, 'not_whole_number');
        if (e.change === 'rate' && !whole(e.per_s)) err(`${p}.per_s`, 'not_whole_number');
        for (const k of targetKinds) for (const w of watched) edges.push({ from: w, to: node(k, e.field), rule, kind });
      });
    }
  }

  // Cycles: from each graph node in order, a path back to itself along the edges, each cycle reported once.
  const out = new Map<string, typeof edges>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const reported = new Set<string>();
  for (const start of [...out.keys()].sort()) {
    const back = new Map<string, (typeof edges)[number]>();
    const queue = [start];
    let closing: (typeof edges)[number] | undefined;
    for (let q = 0; q < queue.length && !closing; q++) {
      for (const e of out.get(queue[q]) ?? []) {
        if (e.to === start) {
          closing = e;
          break;
        }
        if (!back.has(e.to)) {
          back.set(e.to, e);
          queue.push(e.to);
        }
      }
    }
    if (!closing) continue;
    const path = [closing];
    for (let at = closing.from; at !== start; at = back.get(at)!.from) path.unshift(back.get(at)!);
    const cycle = [start, ...path.map((e) => e.to)];
    const key = [...new Set(cycle)].sort().join(' ');
    if (reported.has(key)) continue;
    reported.add(key);
    const rules = path.map((e) => `${e.kind}/${e.rule}`);
    const last = path.map((e) => e.kind).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    errors.push({ kind: last, path: 'reactions', reason: 'cycle', cycle, rules });
  }
  return errors;
}
