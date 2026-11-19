// Wake rules (Engine v2 R13, #2753): the rules on which the Soul's own daemon starts a model turn, within a budget
// its owner set. Carried over from today's client (tools/world-launcher/soul/wake.mjs, #1929 and #1968): rules as
// data, the budgets, one queue entry per rule, a handed wake held and queued again after 10 minutes. Changed: a rule
// matches R9's events with R9's matcher (../match/match.mjs) and its one action is a wake. Times are R15's.
//
//   wake add '{"when": <pattern>, "why": "<text>", "expires": <seconds>}'   a rule (expires optional: none is kept)
//   wake                         the rules, the queue and the budget
//   wake remove <id>
//   wake budget quiet|normal|lively|unlimited|<n per hour> [--day <n>]
//
// - **Delivery** is R7's `wait`: a reader holds one open (the harness's own background mechanism), and the wakes
//   queued are handed to it, all at once, as one delivery, when the budget allows one more.
// - **The budget** counts deliveries in the last hour (and 24 hours, if a day cap is set). Each delivery is charged
//   once, when handed, and never refunded: a reader that never confirms must not take more turns than the budget
//   (the review of #2053).
// - **With no reader**, a rule's firings merge into its one queue entry (a count and the latest why) and wait.
// - **Held, then queued again:** a handed wake is held until a command from the model's turn (any but `wait` and
//   `status`) confirms it was taken; after 10 minutes unconfirmed it goes back to the queue.
// - A wake whose event another Soul caused is marked `untrusted`: its words are that Soul's, not the owner's.
//
// `now` is the caller's clock in ms; this module reads none.

import { Refused, matches, parseWhen } from '../match/match.mjs';

/** Deliveries an hour per budget name; null is no limit. Until the owner chooses, `normal`. */
export const BUDGETS = { quiet: 4, normal: 12, lively: 60, unlimited: null };
export const QUEUE_MOST = 50;
export const HELD_MS = 600_000;
const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const WHY = /^[^\n]{1,200}$/;

/** Checks a rule as `wake add` takes it; gives it in one form, with no id. Refuses by name. */
export function parseWake(rule, now) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Refused('wake-not-a-rule', 'a rule is an object');
  for (const k of Object.keys(rule)) if (!['when', 'why', 'expires'].includes(k)) throw new Refused('wake-unknown-key', k);
  const when = parseWhen(rule.when);
  if ('why' in rule && !(typeof rule.why === 'string' && WHY.test(rule.why))) throw new Refused('wake-why-not-a-line', 'why is one line of text');
  if ('expires' in rule && !(Number.isSafeInteger(rule.expires) && rule.expires >= 1)) throw new Refused('expires-not-a-count', 'expires is whole seconds');
  return { when, why: rule.why ?? null, expiresAt: 'expires' in rule ? now + rule.expires * 1000 : null };
}

/** The `budget` change: `{hour}` from a name or a number, `{day}` from `--day <n>`. Refuses by name. */
export function parseBudget({ hour, day }) {
  const out = {};
  if (hour !== undefined) {
    if (!(hour in BUDGETS) && !(Number.isSafeInteger(hour) && hour >= 0)) throw new Refused('budget-not-a-budget', `${Object.keys(BUDGETS).join(', ')} or a whole number`);
    out.hour = hour;
  }
  if (day !== undefined) {
    if (!(day === null || (Number.isSafeInteger(day) && day >= 0))) throw new Refused('budget-day-not-a-count', 'day is a whole number, or null');
    out.day = day;
  }
  return out;
}

/** One Soul's wake rules, queue, held wakes and deliveries. */
export class Wakes {
  constructor(self) {
    this.self = self;
    this.rules = [];
    this.next = 1;
    this.queue = []; // one entry per rule: { rule, why, count, at, untrusted? }
    this.held = []; // { at, wakes }
    this.delivered = []; // when each delivery was made, the last 24 hours
    this.budget = { hour: 'normal', day: null };
  }

  perHour() {
    const h = this.budget.hour;
    return typeof h === 'number' ? h : BUDGETS[h];
  }

  add(rule, now) {
    const r = { id: `w${this.next++}`, ...parseWake(rule, now), fired: 0 };
    this.rules.push(r);
    return r;
  }

  remove(id) {
    const k = this.rules.findIndex((r) => r.id === id);
    if (k < 0) throw new Refused('wake-not-found', `no wake rule ${String(id).slice(0, 40)}: wake lists them`);
    return this.rules.splice(k, 1)[0];
  }

  /** One event, as a frame is applied: each matching rule's firing merges into its queue entry. True if any fired. */
  onEvent(event, now) {
    let any = false;
    this.rules = this.rules.filter((r) => r.expiresAt === null || r.expiresAt > now);
    for (const r of this.rules) {
      if (!matches(r.when, event, this.self)) continue;
      r.fired++;
      any = true;
      const why = r.why ?? `${event.name}${event.actor ? ` from ${event.actor}` : ''}`;
      const untrusted = event.actor != null && event.actor !== this.self;
      this.merge([{ rule: r.id, why, count: 1, at: now, ...(untrusted ? { untrusted: true } : {}) }]);
    }
    return any;
  }

  merge(wakes) {
    for (const w of wakes) {
      const e = this.queue.find((x) => x.rule === w.rule);
      if (e) Object.assign(e, { why: w.why, at: w.at, count: e.count + w.count, ...(w.untrusted ? { untrusted: true } : {}) });
      else this.queue.push({ ...w });
    }
    this.queue = this.queue.slice(-QUEUE_MOST);
  }

  /** Held wakes older than HELD_MS go back to the queue; what queued since is newer, so its why stands. */
  expire(now) {
    const old = this.held.filter((g) => now - g.at >= HELD_MS);
    if (!old.length) return;
    this.held = this.held.filter((g) => !old.includes(g));
    const since = this.queue;
    this.queue = [];
    this.merge(old.flatMap((g) => g.wakes));
    this.merge(since);
  }

  over(now) {
    this.delivered = this.delivered.filter((t) => now - t < DAY_MS);
    const hour = this.perHour(), day = this.budget.day;
    return (hour !== null && this.delivered.filter((t) => now - t < HOUR_MS).length >= hour)
      || (day !== null && this.delivered.length >= day);
  }

  /** What a reader is handed now: the whole queue, as one delivery charged once, if the budget allows; else none. */
  deliver(now) {
    this.expire(now);
    if (!this.queue.length || this.over(now)) return [];
    const wakes = this.queue;
    this.queue = [];
    this.held.push({ at: now, wakes });
    this.delivered.push(now);
    return wakes;
  }

  /** When the budget next allows a delivery, if the queue waits on it (ms on the caller's clock), else null. */
  nextFree(now) {
    if (!this.queue.length || !this.over(now)) return null;
    const inHour = this.delivered.filter((t) => now - t < HOUR_MS);
    const day = this.budget.day;
    const byHour = this.perHour() !== null && inHour.length >= this.perHour() ? inHour[inHour.length - this.perHour()] + HOUR_MS : now;
    const byDay = day !== null && this.delivered.length >= day ? this.delivered[this.delivered.length - day] + DAY_MS : now;
    return Math.max(byHour, byDay);
  }

  /** A command from the model's turn: what was handed was taken. */
  confirm() {
    this.held = [];
  }

  view(now) {
    this.expire(now);
    this.over(now);
    return {
      rules: this.rules.map((r) => ({ id: r.id, when: r.when, why: r.why, fired: r.fired,
        expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt).toISOString() })),
      queued: this.queue, held: this.held.reduce((n, g) => n + g.wakes.length, 0),
      budget: { ...this.budget, perHour: this.perHour(),
        deliveredLastHour: this.delivered.filter((t) => now - t < HOUR_MS).length, deliveredLast24h: this.delivered.length },
    };
  }

  /** The daemon's `{"op":"wake"}`: `{do: "add", rule}`, `{do: "remove", id}`, `{do: "budget", hour, day}`, or a list. */
  op(req, now) {
    if (req.do === 'add') return { ok: true, added: this.add(req.rule, now).id, ...this.view(now) };
    if (req.do === 'remove') return { ok: true, removed: this.remove(req.id).id, ...this.view(now) };
    if (req.do === 'budget') { Object.assign(this.budget, parseBudget(req)); return { ok: true, ...this.view(now) }; }
    if (req.do === undefined || req.do === 'list') return { ok: true, ...this.view(now) };
    throw new Refused('wake-unknown-do', 'add, remove, budget or list');
  }
}
