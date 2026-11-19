// The reflex table (Engine v2 R9, #2728): rules the agent wrote in advance, each turning a matching event into an
// intent inside the Soul's own daemon, with no model turn. Minds live at the edge: this runs on the owner's machine,
// in the client the agent runs, and only while it runs. Nothing here is held or fired by the engine.
//
//   reflex add '{"when": <pattern>, "send": <intent>, "expires": <seconds>, "max": <n>, "cooldown": <ms>}'
//   reflex                      the rules, with their counts and when each last fired
//   reflex remove <id>
//
// - `when` is the matcher's pattern (../match/match.mjs). An event the Soul itself caused never matches.
// - `send` is `{ "verb": "<namespace:name>", "target": <value>, "parameters": { "<name>": <value> } }`. A value is a
//   text or an integer, or a named value from the matched event: "$from" (the Soul who caused it) or "$field:<n>"
//   (its field n, such as an offer's id). So a rule can answer the very thing it matched.
// - Every rule expires (`expires`, seconds from now, required: a rule with none would answer for ever), stops after
//   `max` firings (default 100) and waits `cooldown` ms between firings (default 1000).
// - A standing consent ("I accept high fives from Ada") is such a rule: an offer of that kind, from those Souls,
//   answered by joining that offer. It is listed, narrow, expiring and removable like any other.
// - Each firing is recorded, and the daemon shows it in its next answer's `changed`.

import { Refused, matches, parseWhen } from '../match/match.mjs';

export const MAX_DEFAULT = 100;
export const COOLDOWN_DEFAULT_MS = 1000;
const NAME = /^[a-z0-9_-]+:[a-z0-9_./@-]+$/;
const REF = /^\$(from|field:\d{1,4})$/;
const PARAM = /^[a-z][a-z0-9_]{0,40}$/;
const KEYS = new Set(['when', 'send', 'expires', 'max', 'cooldown']);
const FIRED_KEPT = 1000;

const value = (v, what) => {
  if (typeof v === 'string' && v.startsWith('$') && !REF.test(v)) throw new Refused('send-unknown-value', `${what}: "$from" or "$field:<n>"`);
  if (!(typeof v === 'string' || Number.isSafeInteger(v))) throw new Refused('send-value-not-a-value', `${what} is a text or an integer`);
  return v;
};
const count = (v, what, least) => {
  if (!Number.isSafeInteger(v) || v < least) throw new Refused(`${what}-not-a-count`, `${what} is a whole number, at least ${least}`);
  return v;
};

/** Checks a rule as `reflex add` takes it; gives it in one form, with no id. Refuses by name. */
export function parseReflex(rule, now) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Refused('reflex-not-a-rule', 'a rule is an object');
  for (const k of Object.keys(rule)) if (!KEYS.has(k)) throw new Refused('reflex-unknown-key', k);
  if (!('expires' in rule)) throw new Refused('reflex-without-expiry', 'every rule expires: give expires, in seconds');
  const when = parseWhen(rule.when);
  const s = rule.send;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Refused('send-not-an-intent', 'send is an object');
  for (const k of Object.keys(s)) if (!['verb', 'target', 'parameters'].includes(k)) throw new Refused('send-unknown-key', k);
  if (typeof s.verb !== 'string' || !NAME.test(s.verb)) throw new Refused('send-verb-not-a-name', 'verb is a namespace:name');
  const send = { verb: s.verb };
  if ('target' in s) send.target = value(s.target, 'target');
  if ('parameters' in s) {
    const p = s.parameters;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Refused('send-parameters-not-a-map', 'parameters is an object');
    send.parameters = {};
    for (const [k, v] of Object.entries(p)) {
      if (!PARAM.test(k)) throw new Refused('send-parameter-not-a-name', k.slice(0, 40));
      send.parameters[k] = value(v, `parameter ${k}`);
    }
  }
  return {
    when, send,
    expiresAt: now + count(rule.expires, 'expires', 1) * 1000,
    max: 'max' in rule ? count(rule.max, 'max', 1) : MAX_DEFAULT,
    cooldown: 'cooldown' in rule ? count(rule.cooldown, 'cooldown', 0) : COOLDOWN_DEFAULT_MS,
  };
}

const fill = (v, event) => {
  if (v === '$from') return event.actor;
  if (typeof v === 'string' && v.startsWith('$field:')) return event.fields?.[v.slice(7)] ?? null;
  return v;
};

/** The intent a rule sends for an event, its named values filled from that event. */
export function intentFor(send, event) {
  const out = { verb: send.verb };
  if ('target' in send) out.target = fill(send.target, event);
  if (send.parameters) out.parameters = Object.fromEntries(Object.entries(send.parameters).map(([k, v]) => [k, fill(v, event)]));
  return out;
}

/** One Soul's reflexes. `now` is the caller's clock in ms, so the table itself reads none. */
export class Table {
  constructor(self) {
    this.self = self;
    this.rules = [];
    this.next = 1;
    this.fired = []; // firings not yet shown in an answer's `changed`
  }

  add(rule, now) {
    const r = { id: `r${this.next++}`, ...parseReflex(rule, now), fired: 0, lastFired: null };
    this.rules.push(r);
    return r;
  }

  remove(id) {
    const k = this.rules.findIndex((r) => r.id === id);
    if (k < 0) throw new Refused('reflex-not-found', `no reflex ${String(id).slice(0, 40)}: reflex lists them`);
    return this.rules.splice(k, 1)[0];
  }

  /** The rules still live, dropping those expired or spent. */
  list(now) {
    this.rules = this.rules.filter((r) => r.expiresAt > now && r.fired < r.max);
    return this.rules.map((r) => ({ id: r.id, when: r.when, send: r.send, expiresAt: new Date(r.expiresAt).toISOString(),
      max: r.max, fired: r.fired, cooldown: r.cooldown, lastFired: r.lastFired === null ? null : new Date(r.lastFired).toISOString() }));
  }

  /** One event, as a frame is applied: the intents its matching rules send now. Each firing is recorded. */
  onEvent(event, now) {
    const out = [];
    for (const r of this.rules) {
      if (r.expiresAt <= now || r.fired >= r.max) continue;
      if (r.lastFired !== null && now - r.lastFired < r.cooldown) continue;
      if (!matches(r.when, event, this.self)) continue;
      r.fired++;
      r.lastFired = now;
      const intent = intentFor(r.send, event);
      out.push({ rule: r.id, intent });
      this.fired.push({ kind: 'reflex', rule: r.id, event: event.name, sequence: event.sequence ?? null, intent });
      if (this.fired.length > FIRED_KEPT) this.fired.shift();
    }
    return out;
  }

  /** The firings since the last answer, for its `changed`; cleared once given. */
  changed() {
    return this.fired.splice(0);
  }

  /** The daemon's `{"op":"reflex"}`: `{do: "add", rule}`, `{do: "remove", id}` or `{do: "list"}` (the default). */
  op(req, now) {
    if (req.do === 'add') return { ok: true, added: this.add(req.rule, now).id, reflexes: this.list(now) };
    if (req.do === 'remove') return { ok: true, removed: this.remove(req.id).id, reflexes: this.list(now) };
    if (req.do === undefined || req.do === 'list') return { ok: true, reflexes: this.list(now) };
    throw new Refused('reflex-unknown-do', 'add, remove or list');
  }
}
